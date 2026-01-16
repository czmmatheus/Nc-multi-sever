process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

const fs = require("fs");
const path = require("path");

const {
  Client, GatewayIntentBits,
  REST, Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
  ModalBuilder,
  TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

// ================== ENV ==================
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Faltam variáveis: BOT_TOKEN e/ou CLIENT_ID");
  process.exit(1);
}

// ================== CONSTANTES ==================
const PURPLE = 0x7c3aed;
const BRAND_TITLE = "𝗡𝗖 𝗕𝗟𝗢𝗫";
const AUTO_CLOSE_MS = 24 * 60 * 60 * 1000; // 24h

// Roblox fee: recebe 70% (Roblox pega 30%)
const ROBLOX_FEE = 0.30;

// Gamepass: +5%
const GAMEPASS_MULT = 1.05;

const BANNER_URL = "https://cdn.discordapp.com/attachments/1428217284660564125/1461373724535029893/file_000000007a1471f6bb88daa791749f60.png?ex=696a51d6&is=69690056&hm=d85d13d5a32d0c1df315724e18a5d0d6817ae91ccf4a9e27a35c27a41c966400&";

// ================== STORAGE (guilds.json) ==================
const GUILDS_PATH = path.join(__dirname, "guilds.json");

function ensureGuildsFile() {
  if (!fs.existsSync(GUILDS_PATH)) {
    fs.writeFileSync(GUILDS_PATH, JSON.stringify({ guilds: {} }, null, 2));
  }
}

function readGuilds() {
  ensureGuildsFile();
  try {
    return JSON.parse(fs.readFileSync(GUILDS_PATH, "utf8"));
  } catch {
    const reset = { guilds: {} };
    fs.writeFileSync(GUILDS_PATH, JSON.stringify(reset, null, 2));
    return reset;
  }
}

function writeGuilds(data) {
  fs.writeFileSync(GUILDS_PATH, JSON.stringify(data, null, 2));
}

function getGuildConfig(guildId) {
  const db = readGuilds();
  const cfg = db.guilds[guildId];
  if (!cfg) {
    // default config por servidor
    db.guilds[guildId] = {
      staffRoleId: null,
      ticketCategoryId: null,
      logChannelId: null,
      buyerRoleId: null,
      pendingChannelId: null,

      panelChannelId: null,
      panelMessageId: null,

      stock: 0,
      ratePer1000: 28,
      panelText: "📦 Stock atualizado • tickets automáticos • logs e cargo comprador",
    };
    writeGuilds(db);
    return db.guilds[guildId];
  }
  return cfg;
}

function patchGuildConfig(guildId, patch) {
  const db = readGuilds();
  if (!db.guilds[guildId]) getGuildConfig(guildId); // cria default
  db.guilds[guildId] = { ...db.guilds[guildId], ...patch };
  writeGuilds(db);
  return db.guilds[guildId];
}

// ================== HELPERS ==================
function brl(n) {
  return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function safeInt(s) {
  const n = Number(String(s || "").replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
function shortLabel(s) {
  return String(s).slice(0, 45);
}
function formatDateDDMMYY(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function calcGrossToCoverFee(netRobux) {
  return Math.max(1, Math.ceil(netRobux / (1 - ROBLOX_FEE)));
}
function stockLine(stock) {
  if (stock <= 0) return "➡️ **0 ROBUX DISPONÍVEIS** 🔴";
  if (stock < 1000) return `➡️ **${stock.toLocaleString("pt-BR")} ROBUX** 🟠`;
  return `➡️ **${stock.toLocaleString("pt-BR")} ROBUX DISPONÍVEIS** 🟢 OK`;
}
function parseTicketOwnerIdFromTopic(topic = "") {
  const m = topic.match(/ticketOwner:(\d+)/);
  return m?.[1] || null;
}
function hasStaffRole(member, cfg) {
  return cfg?.staffRoleId && member?.roles?.cache?.has(cfg.staffRoleId);
}

// ================== TICKETS TIMER ==================
const ticketTimers = new Map();
function cancelTicketTimer(channelId) {
  if (ticketTimers.has(channelId)) {
    clearTimeout(ticketTimers.get(channelId));
    ticketTimers.delete(channelId);
  }
}

// ================== BOT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => console.log(`✅ Logado como ${client.user.tag}`));

// ================== COMMANDS REGISTER (GLOBAL) ==================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Configura o bot neste servidor (IDs)"),

    new SlashCommandBuilder()
      .setName("cmd")
      .setDescription("Envia/atualiza painel (usa config do servidor)"),

    new SlashCommandBuilder()
      .setName("2cmd")
      .setDescription("Painel da calculadora (sem ticket)"),

    new SlashCommandBuilder()
      .setName("paineladm")
      .setDescription("Painel ADM do servidor"),

    new SlashCommandBuilder()
      .setName("stock")
      .setDescription("Ajusta stock (+/-) deste servidor")
      .addIntegerOption(o => o.setName("valor").setDescription("Ex: 10000 ou -100").setRequired(true)),

    new SlashCommandBuilder()
      .setName("logs")
      .setDescription("Registra venda do ticket, dá cargo e fecha"),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // global commands (multi-server)
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ comandos globais registrados: /setup /cmd /2cmd /paineladm /stock /logs");
}

// ================== PANELS ==================
function buildMainPanelEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`${BRAND_TITLE} • Store`)
    .setDescription(
      [
        "**Robux & Gamepass**",
        "",
        "📦 **STOCK ATUAL**",
        stockLine(Number(cfg.stock || 0)),
        "",
        "💰 **Preço base**",
        `• 1000 Robux = ${brl(Number(cfg.ratePer1000 || 28))}`,
        "",
        `🔐 ${cfg.panelText || ""}`.trim(),
        "",
        "👇 Selecione uma opção abaixo:",
      ].filter(Boolean).join("\n")
    )
    .setImage(BANNER_URL);
}

function buildMainPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("buy_robux").setLabel("Comprar Robux").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("buy_gamepass").setLabel("Comprar GamePass").setStyle(ButtonStyle.Secondary),
  );
}

async function sendOrUpdateSavedPanel(guild, channel) {
  const cfg = getGuildConfig(guild.id);
  const embed = buildMainPanelEmbed(cfg);
  const row = buildMainPanelButtons();

  if (cfg.panelChannelId && cfg.panelMessageId) {
    try {
      const ch = await guild.channels.fetch(cfg.panelChannelId);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(cfg.panelMessageId);
        await msg.edit({ embeds: [embed], components: [row] });
        return { reused: true };
      }
    } catch {}
  }

  const msg = await channel.send({ embeds: [embed], components: [row] });
  patchGuildConfig(guild.id, { panelChannelId: channel.id, panelMessageId: msg.id });
  return { reused: false };
}

async function updateSavedPanelIfExists(guild) {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.panelChannelId || !cfg.panelMessageId) return;

  try {
    const ch = await guild.channels.fetch(cfg.panelChannelId);
    if (!ch || !ch.isTextBased()) return;
    const msg = await ch.messages.fetch(cfg.panelMessageId);
    await msg.edit({ embeds: [buildMainPanelEmbed(cfg)], components: [buildMainPanelButtons()] });
  } catch {}
}

async function sendCalcPanel(channel, guildId) {
  const cfg = getGuildConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`${BRAND_TITLE} • Calculadora`)
    .setDescription(
      [
        `• Base: **1000 = ${brl(Number(cfg.ratePer1000 || 28))}**`,
        "• Modos: sem taxa / cobrir taxa 30% (Roblox)",
        "",
        "Clique para calcular:",
      ].join("\n")
    )
    .setImage(BANNER_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("calc_no_fee").setLabel("Calcular (Sem taxa)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("calc_cover_fee").setLabel("Calcular (Cobrir 30%)").setStyle(ButtonStyle.Primary),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ================== ADM PANEL ==================
function buildAdmEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`${BRAND_TITLE} • Painel ADM`)
    .setDescription(
      [
        `**Preço base:** 1000 = ${brl(Number(cfg.ratePer1000 || 28))}`,
        `**Stock:** ${Number(cfg.stock || 0).toLocaleString("pt-BR")} Robux`,
        `**Painel salvo:** ${cfg.panelChannelId && cfg.panelMessageId ? "✅ sim" : "❌ não"}`,
        `**Pendentes:** ${cfg.pendingChannelId ? "✅ setado" : "—"}`,
        "",
        "Use os botões abaixo:",
      ].join("\n")
    );
}

function buildAdmButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_rate").setLabel("Preço 1000").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("adm_stock").setLabel("Stock +/-").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_text").setLabel("Texto painel").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sendpanel").setLabel("Enviar/Atualizar /cmd").setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ================== TICKET CREATION ==================
async function createTicketChannel(guild, user, cfg) {
  const safeName = (user.username || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "user";
  const channelName = `ticket-${safeName}-${user.id.toString().slice(-4)}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
    },
    ...(cfg.staffRoleId ? [{
      id: cfg.staffRoleId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
    }] : []),
    {
      id: client.user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory],
    },
  ];

  const openedAt = Date.now();
  const topic = `ticketOwner:${user.id} openedAt:${openedAt}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: cfg.ticketCategoryId || undefined,
    permissionOverwrites: overwrites,
    topic,
  });

  return { channel, openedAt };
}

async function scheduleAutoClose(channel, openedAt) {
  cancelTicketTimer(channel.id);

  const msLeft = Math.max(0, (openedAt + AUTO_CLOSE_MS) - Date.now());
  const t = setTimeout(async () => {
    try {
      await channel.send("⏳ Ticket encerrado automaticamente após **24 horas**.");
      setTimeout(async () => {
        try { await channel.delete("Auto-close 24h"); } catch {}
      }, 5000);
    } catch {}
    ticketTimers.delete(channel.id);
  }, msLeft);

  ticketTimers.set(channel.id, t);
}

function buildTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("close_ticket").setLabel("Fechar ticket").setStyle(ButtonStyle.Danger)
  );
}

async function finalizeTicket(channel, reason = "Finalizado") {
  cancelTicketTimer(channel.id);
  setTimeout(async () => {
    try { await channel.delete(reason); } catch {}
  }, 5000);
}

// ================== ORDER EXTRACTION FOR /logs ==================
async function extractOrderFromTicket(channel) {
  if (!channel?.isTextBased?.()) return null;
  const msgs = await channel.messages.fetch({ limit: 50 });

  for (const [, msg] of msgs) {
    if (!msg.author || msg.author.id !== client.user.id) continue;
    if (!msg.embeds || msg.embeds.length === 0) continue;

    const e = msg.embeds[0];
    const title = (e.title || "").toLowerCase();
    const desc = e.description || "";

    if (title.includes("pedido de robux")) {
      const netMatch = desc.match(/\*\*Robux \(receber\):\*\*\s*([0-9]+)/i);
      const grossMatch = desc.match(/\*\*Robux \(gamepass\):\*\*\s*([0-9]+)/i);
      const totalMatch = desc.match(/\*\*Total:\*\*\s*R\$\s*([0-9.,]+)/i);

      const netRobux = netMatch ? Number(netMatch[1]) : null;
      const grossRobux = grossMatch ? Number(grossMatch[1]) : null;

      let total = null;
      if (totalMatch?.[1]) {
        total = Number(totalMatch[1].replace(/\./g, "").replace(",", "."));
        if (!Number.isFinite(total)) total = null;
      }

      if (Number.isFinite(netRobux) && netRobux > 0 && Number.isFinite(total) && total > 0) {
        return { type: "robux", netRobux, grossRobux, total: round2(total), modo: "Robux" };
      }
    }

    if (title.includes("pedido de gamepass")) {
      const gpNameMatch = desc.match(/\*\*Gamepass:\*\*\s*(.+)/i);
      const robuxMatch = desc.match(/\*\*Preço da Gamepass:\*\*\s*([0-9]+)/i);
      const totalMatch = desc.match(/\*\*Total:\*\*\s*R\$\s*([0-9.,]+)/i);

      const gpName = gpNameMatch ? gpNameMatch[1].split("\n")[0].trim() : "—";
      const gpRobux = robuxMatch ? Number(robuxMatch[1]) : null;

      let total = null;
      if (totalMatch?.[1]) {
        total = Number(totalMatch[1].replace(/\./g, "").replace(",", "."));
        if (!Number.isFinite(total)) total = null;
      }

      if (Number.isFinite(gpRobux) && gpRobux > 0 && Number.isFinite(total) && total > 0) {
        return { type: "gamepass", gpName, gpRobux, total: round2(total), modo: "Gamepass" };
      }
    }
  }

  return null;
}

// ================== SETUP FLOW ==================
function buildSetupEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle(`${BRAND_TITLE} • Setup`)
    .setDescription(
      [
        "Configure os IDs do seu servidor:",
        "",
        `**Staff Role:** ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : "❌ não configurado"}`,
        `**Logs Channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : "❌ não configurado"}`,
        `**Buyer Role:** ${cfg.buyerRoleId ? `<@&${cfg.buyerRoleId}>` : "—"}`,
        `**Categoria Tickets:** ${cfg.ticketCategoryId ? `ID: ${cfg.ticketCategoryId}` : "—"}`,
        `**Pendentes:** ${cfg.pendingChannelId ? `<#${cfg.pendingChannelId}>` : "—"}`,
        "",
        "Use os botões para editar.",
      ].join("\n")
    );
}

function buildSetupButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_staff").setLabel("Staff Role").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup_logs").setLabel("Logs Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup_buyer").setLabel("Buyer Role").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_cat").setLabel("Categoria Tickets").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup_pending").setLabel("Canal Pendentes").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup_panel").setLabel("Canal do Painel").setStyle(ButtonStyle.Success),
    ),
  ];
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (i) => {
  try {
    const guild = i.guild;
    if (!guild) return;

    const cfg = getGuildConfig(guild.id);

    // ---------- Slash commands ----------
    if (i.isChatInputCommand() && i.commandName === "setup") {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Precisa de **Gerenciar Servidor**.", ephemeral: true });
      }
      return i.reply({ embeds: [buildSetupEmbed(cfg)], components: buildSetupButtons(), ephemeral: true });
    }

    if (i.isChatInputCommand() && i.commandName === "cmd") {
      // precisa canal do painel configurado? (se não, usa o canal atual e salva)
      await i.deferReply({ ephemeral: true });

      // se tiver panelChannelId, manda/atualiza lá, senão aqui
      const targetChannel = cfg.panelChannelId ? await guild.channels.fetch(cfg.panelChannelId).catch(() => null) : i.channel;

      if (!targetChannel || !targetChannel.isTextBased()) {
        return i.editReply("❌ Canal do painel inválido. Use /setup e defina o Canal do Painel.");
      }

      const res = await sendOrUpdateSavedPanel(guild, targetChannel);
      return i.editReply(res.reused ? "✅ Painel atualizado." : "✅ Painel enviado e salvo.");
    }

    if (i.isChatInputCommand() && i.commandName === "2cmd") {
      await sendCalcPanel(i.channel, guild.id);
      return i.reply({ content: "✅ Painel da calculadora enviado.", ephemeral: true });
    }

    if (i.isChatInputCommand() && i.commandName === "paineladm") {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Precisa de **Gerenciar Servidor**.", ephemeral: true });
      }
      return i.reply({ embeds: [buildAdmEmbed(cfg)], components: buildAdmButtons(), ephemeral: true });
    }

    if (i.isChatInputCommand() && i.commandName === "stock") {
      if (!hasStaffRole(i.member, cfg)) return i.reply({ content: "❌ Apenas staff.", ephemeral: true });

      const delta = i.options.getInteger("valor", true);
      const newStock = Math.max(0, Number(cfg.stock || 0) + Number(delta));
      patchGuildConfig(guild.id, { stock: newStock });

      await updateSavedPanelIfExists(guild);
      return i.reply({ content: `📦 Stock agora: **${newStock.toLocaleString("pt-BR")} Robux**`, ephemeral: true });
    }

    if (i.isChatInputCommand() && i.commandName === "logs") {
      if (!hasStaffRole(i.member, cfg)) {
        return i.reply({ content: "❌ Você não tem permissão para usar /logs.", ephemeral: true });
      }
      if (!cfg.logChannelId) {
        return i.reply({ content: "❌ Configure o canal de logs em /setup.", ephemeral: true });
      }

      const channel = i.channel;
      const ownerId = parseTicketOwnerIdFromTopic(channel?.topic || "");
      if (!ownerId) {
        return i.reply({ content: "❌ Use /logs dentro de um ticket criado pelo bot.", ephemeral: true });
      }

      await i.deferReply({ ephemeral: true });

      const order = await extractOrderFromTicket(channel);
      if (!order) return i.editReply("❌ Não achei o pedido nesse ticket (embed do bot).");

      const dateStr = formatDateDDMMYY(new Date());
      const logChannel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle("📌 Venda registrada")
        .addFields(
          { name: "Usuário", value: `<@${ownerId}>`, inline: true },
          { name: "Total", value: brl(order.total), inline: true },
          { name: "Data", value: dateStr, inline: true },
          { name: "Modo", value: order.modo, inline: false },
          { name: "Ticket", value: `${channel}`, inline: false },
          { name: "Staff", value: `<@${i.user.id}>`, inline: false },
        );

      if (order.type === "robux") {
        embed.addFields(
          { name: "Robux (receber)", value: `${order.netRobux}`, inline: true },
          { name: "Robux (gamepass)", value: `${order.grossRobux || "—"}`, inline: true },
        );
      } else {
        embed.addFields({ name: "Gamepass", value: `${order.gpName}`, inline: false });
        embed.addFields({ name: "Preço da Gamepass", value: `${order.gpRobux} Robux`, inline: true });
      }

      if (logChannel && logChannel.isTextBased()) await logChannel.send({ embeds: [embed] });

      // cargo comprador (opcional)
      if (cfg.buyerRoleId) {
        try {
          const member = await guild.members.fetch(ownerId);
          if (member && !member.roles.cache.has(cfg.buyerRoleId)) {
            await member.roles.add(cfg.buyerRoleId, "Compra registrada via /logs");
          }
        } catch (e) {
          console.error("Buyer role erro:", e?.message || e);
        }
      }

      // desconta stock apenas se for robux
      if (order.type === "robux") {
        const newStock = Math.max(0, Number(cfg.stock || 0) - Number(order.netRobux || 0));
        patchGuildConfig(guild.id, { stock: newStock });
        await updateSavedPanelIfExists(guild);
      }

      await channel.send("✅ Venda registrada. 🔒 Ticket será fechado em 5 segundos...");
      await i.editReply("✅ Log registrado. Fechando ticket...");
      await finalizeTicket(channel, "Venda finalizada via /logs");
      return;
    }

    // ---------- SETUP BUTTONS ----------
    if (i.isButton() && i.customId.startsWith("setup_")) {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Precisa de **Gerenciar Servidor**.", ephemeral: true });
      }

      const mkModal = (id, title, inputId, label) => {
        const modal = new ModalBuilder().setCustomId(id).setTitle(title);
        const input = new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(shortLabel(label))
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return modal;
      };

      if (i.customId === "setup_staff") return i.showModal(mkModal("setup_modal_staff", "Staff Role ID", "id", "ID do cargo staff"));
      if (i.customId === "setup_logs") return i.showModal(mkModal("setup_modal_logs", "Logs Channel ID", "id", "ID do canal de logs"));
      if (i.customId === "setup_buyer") return i.showModal(mkModal("setup_modal_buyer", "Buyer Role ID", "id", "ID do cargo comprador"));
      if (i.customId === "setup_cat") return i.showModal(mkModal("setup_modal_cat", "Ticket Category ID", "id", "ID da categoria de tickets"));
      if (i.customId === "setup_pending") return i.showModal(mkModal("setup_modal_pending", "Pendentes Channel ID", "id", "ID do canal de pendentes"));
      if (i.customId === "setup_panel") return i.showModal(mkModal("setup_modal_panel", "Canal do Painel ID", "id", "ID do canal do painel"));
    }

    // ---------- SETUP MODALS ----------
    if (i.isModalSubmit() && i.customId.startsWith("setup_modal_")) {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Sem permissão.", ephemeral: true });
      }
      const val = String(i.fields.getTextInputValue("id") || "").trim();
      if (!/^\d{10,30}$/.test(val)) return i.reply({ content: "❌ ID inválido.", ephemeral: true });

      if (i.customId === "setup_modal_staff") patchGuildConfig(guild.id, { staffRoleId: val });
      if (i.customId === "setup_modal_logs") patchGuildConfig(guild.id, { logChannelId: val });
      if (i.customId === "setup_modal_buyer") patchGuildConfig(guild.id, { buyerRoleId: val });
      if (i.customId === "setup_modal_cat") patchGuildConfig(guild.id, { ticketCategoryId: val });
      if (i.customId === "setup_modal_pending") patchGuildConfig(guild.id, { pendingChannelId: val });
      if (i.customId === "setup_modal_panel") patchGuildConfig(guild.id, { panelChannelId: val });

      const updated = getGuildConfig(guild.id);
      return i.reply({ embeds: [buildSetupEmbed(updated)], components: buildSetupButtons(), ephemeral: true });
    }

    // ---------- ADM BUTTONS ----------
    if (i.isButton() && i.customId.startsWith("adm_")) {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Sem permissão.", ephemeral: true });
      }

      const mkModal = (id, title, inputId, label, style = TextInputStyle.Short) => {
        const modal = new ModalBuilder().setCustomId(id).setTitle(title);
        const input = new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(shortLabel(label))
          .setStyle(style)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return modal;
      };

      if (i.customId === "adm_rate") return i.showModal(mkModal("adm_modal_rate", "Preço base (1000)", "rate", "Valor do 1000 (ex: 28)"));
      if (i.customId === "adm_stock") return i.showModal(mkModal("adm_modal_stock", "Ajustar stock", "delta", "Ex: 10000 ou -100"));
      if (i.customId === "adm_text") return i.showModal(mkModal("adm_modal_text", "Texto do painel", "text", "Texto curto do painel", TextInputStyle.Paragraph));

      if (i.customId === "adm_sendpanel") {
        await i.deferReply({ ephemeral: true });
        const targetChannel = cfg.panelChannelId ? await guild.channels.fetch(cfg.panelChannelId).catch(() => null) : i.channel;
        if (!targetChannel || !targetChannel.isTextBased()) return i.editReply("❌ Canal do painel inválido. Configure em /setup.");
        const res = await sendOrUpdateSavedPanel(guild, targetChannel);
        return i.editReply(res.reused ? "✅ Painel /cmd atualizado." : "✅ Painel /cmd enviado e salvo.");
      }
    }

    // ---------- ADM MODALS ----------
    if (i.isModalSubmit() && i.customId.startsWith("adm_modal_")) {
      if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.reply({ content: "❌ Sem permissão.", ephemeral: true });
      }

      if (i.customId === "adm_modal_rate") {
        const rate = safeInt(i.fields.getTextInputValue("rate"));
        if (!Number.isFinite(rate) || rate <= 0) return i.reply({ content: "❌ Valor inválido.", ephemeral: true });

        patchGuildConfig(guild.id, { ratePer1000: rate });
        await updateSavedPanelIfExists(guild);
        return i.reply({ content: `✅ Preço base: 1000 = ${brl(rate)}`, ephemeral: true });
      }

      if (i.customId === "adm_modal_stock") {
        const delta = safeInt(i.fields.getTextInputValue("delta"));
        if (!Number.isFinite(delta)) return i.reply({ content: "❌ Número inválido.", ephemeral: true });

        const newStock = Math.max(0, Number(cfg.stock || 0) + delta);
        patchGuildConfig(guild.id, { stock: newStock });
        await updateSavedPanelIfExists(guild);
        return i.reply({ content: `📦 Stock: **${newStock.toLocaleString("pt-BR")} Robux**`, ephemeral: true });
      }

      if (i.customId === "adm_modal_text") {
        const text = String(i.fields.getTextInputValue("text") || "").trim();
        if (!text) return i.reply({ content: "❌ Texto vazio.", ephemeral: true });

        patchGuildConfig(guild.id, { panelText: text.slice(0, 200) });
        await updateSavedPanelIfExists(guild);
        return i.reply({ content: "✅ Texto do painel atualizado.", ephemeral: true });
      }
    }

    // ---------- Painel: Comprar Robux ----------
    if (i.isButton() && i.customId === "buy_robux") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("robux_mode")
        .setPlaceholder("Escolha o modo")
        .addOptions([
          { label: "Sem taxa", value: "no_fee" },
          { label: "Cobrir taxa Roblox (30%)", value: "cover_fee" },
        ]);

      return i.reply({
        content: "Escolha o modo:",
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true,
      });
    }

    // ---------- Painel: Comprar GamePass ----------
    if (i.isButton() && i.customId === "buy_gamepass") {
      const modal = new ModalBuilder().setCustomId("gamepass_modal").setTitle("Pedido GamePass");

      const nick = new TextInputBuilder()
        .setCustomId("nick")
        .setLabel(shortLabel("Nick do Roblox"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const gpname = new TextInputBuilder()
        .setCustomId("gpname")
        .setLabel(shortLabel("Nome da GamePass"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const robux = new TextInputBuilder()
        .setCustomId("robux")
        .setLabel(shortLabel("Preço da GamePass (Robux)"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nick),
        new ActionRowBuilder().addComponents(gpname),
        new ActionRowBuilder().addComponents(robux),
      );

      return i.showModal(modal);
    }

    // ---------- Robux mode select -> modal ----------
    if (i.isStringSelectMenu() && i.customId === "robux_mode") {
      const mode = i.values[0]; // no_fee | cover_fee

      const modal = new ModalBuilder()
        .setCustomId(`robux_order:${mode}`)
        .setTitle(mode === "cover_fee" ? "Robux (cobrir taxa)" : "Robux (sem taxa)");

      const nick = new TextInputBuilder()
        .setCustomId("nick")
        .setLabel(shortLabel("Nick do Roblox"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const robux = new TextInputBuilder()
        .setCustomId("robux")
        .setLabel(shortLabel("Robux a receber (ex: 1000)"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nick),
        new ActionRowBuilder().addComponents(robux)
      );

      return i.showModal(modal);
    }

    // ---------- Submit: Robux order -> ticket ----------
    if (i.isModalSubmit() && i.customId.startsWith("robux_order:")) {
      await i.deferReply({ ephemeral: true });

      const mode = i.customId.split(":")[1];
      const coverFee = mode === "cover_fee";

      const nick = String(i.fields.getTextInputValue("nick") || "").trim();
      const netRobux = safeInt(i.fields.getTextInputValue("robux"));

      if (!nick) return i.editReply("❌ Nick inválido.");
      if (!Number.isFinite(netRobux) || netRobux <= 0) return i.editReply("❌ Robux inválido.");

      const grossRobux = coverFee ? calcGrossToCoverFee(netRobux) : netRobux;
      const total = round2((grossRobux / 1000) * Number(cfg.ratePer1000 || 28));

      if (!cfg.staffRoleId) return i.editReply("❌ Configure o cargo staff em /setup.");

      let ticket, openedAt;
      try {
        const res = await createTicketChannel(guild, i.user, cfg);
        ticket = res.channel;
        openedAt = res.openedAt;
      } catch (err) {
        console.error("ERRO criando ticket:", err);
        return i.editReply("❌ Não consegui criar o ticket. Verifique permissões do bot.");
      }

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle("🧾 Pedido de Robux")
        .setDescription(
          [
            `**Cliente:** <@${i.user.id}>`,
            `**Nick:** ${nick}`,
            `**Robux (receber):** ${netRobux}`,
            `**Robux (gamepass):** ${grossRobux}`,
            `**Modo:** ${coverFee ? "Cobrir taxa Roblox (30%)" : "Sem taxa"}`,
            `**Total:** ${brl(total)}`,
            "",
            "📌 **Como finalizar:**",
            `1) Crie uma **Gamepass de ${grossRobux} Robux**`,
            "2) Envie o link aqui no ticket",
            "",
            "⏳ Aguarde até **24h**. Depois disso o ticket fecha automático.",
            "✅ Staff finaliza com **/logs**.",
          ].join("\n")
        );

      await ticket.send({
        content: `<@&${cfg.staffRoleId}> Novo pedido!`,
        embeds: [embed],
        components: [buildTicketButtons()],
      });

      await scheduleAutoClose(ticket, openedAt);

      // Pendentes (se configurado)
      if (cfg.pendingChannelId) {
        try {
          const pend = await guild.channels.fetch(cfg.pendingChannelId);
          if (pend && pend.isTextBased()) {
            await pend.send({
              embeds: [new EmbedBuilder()
                .setColor(PURPLE)
                .setTitle("⏳ PENDENTE (Robux)")
                .setDescription(
                  [
                    `**Cliente:** <@${i.user.id}>`,
                    `**Nick:** ${nick}`,
                    `**Receber:** ${netRobux}`,
                    `**Gamepass:** ${grossRobux}`,
                    `**Total:** ${brl(total)}`,
                    `**Ticket:** ${ticket}`,
                  ].join("\n")
                )],
            });
          }
        } catch {}
      }

      return i.editReply(`✅ Ticket criado: ${ticket}`);
    }

    // ---------- Submit: Gamepass -> ticket ----------
    if (i.isModalSubmit() && i.customId === "gamepass_modal") {
      await i.deferReply({ ephemeral: true });

      const nick = String(i.fields.getTextInputValue("nick") || "").trim();
      const gpname = String(i.fields.getTextInputValue("gpname") || "").trim();
      const gpRobux = safeInt(i.fields.getTextInputValue("robux"));

      if (!nick) return i.editReply("❌ Nick inválido.");
      if (!gpname) return i.editReply("❌ Nome inválido.");
      if (!Number.isFinite(gpRobux) || gpRobux <= 0) return i.editReply("❌ Robux inválido.");

      if (!cfg.staffRoleId) return i.editReply("❌ Configure o cargo staff em /setup.");

      const base = (gpRobux / 1000) * Number(cfg.ratePer1000 || 28);
      const total = round2(base * GAMEPASS_MULT);

      let ticket, openedAt;
      try {
        const res = await createTicketChannel(guild, i.user, cfg);
        ticket = res.channel;
        openedAt = res.openedAt;
      } catch (err) {
        console.error("ERRO criando ticket:", err);
        return i.editReply("❌ Não consegui criar o ticket. Verifique permissões do bot.");
      }

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle("🎮 Pedido de Gamepass (in-game)")
        .setDescription(
          [
            `**Cliente:** <@${i.user.id}>`,
            `**Nick:** ${nick}`,
            `**Gamepass:** ${gpname}`,
            `**Preço da Gamepass:** ${gpRobux} Robux`,
            `**Total:** ${brl(total)} *(+5%)*`,
            "",
            "⏳ Aguarde até **24h**. Depois disso o ticket fecha automático.",
            "✅ Staff finaliza com **/logs**.",
          ].join("\n")
        );

      await ticket.send({
        content: `<@&${cfg.staffRoleId}> Novo pedido (Gamepass)!`,
        embeds: [embed],
        components: [buildTicketButtons()],
      });

      await scheduleAutoClose(ticket, openedAt);

      if (cfg.pendingChannelId) {
        try {
          const pend = await guild.channels.fetch(cfg.pendingChannelId);
          if (pend && pend.isTextBased()) {
            await pend.send({
              embeds: [new EmbedBuilder()
                .setColor(PURPLE)
                .setTitle("⏳ PENDENTE (Gamepass)")
                .setDescription(
                  [
                    `**Cliente:** <@${i.user.id}>`,
                    `**Nick:** ${nick}`,
                    `**Gamepass:** ${gpname}`,
                    `**Preço:** ${gpRobux} Robux`,
                    `**Total:** ${brl(total)}`,
                    `**Ticket:** ${ticket}`,
                  ].join("\n")
                )],
            });
          }
        } catch {}
      }

      return i.editReply(`✅ Ticket criado: ${ticket}`);
    }

    // ---------- Calculator ----------
    if (i.isButton() && (i.customId === "calc_no_fee" || i.customId === "calc_cover_fee")) {
      const coverFee = i.customId === "calc_cover_fee";

      const modal = new ModalBuilder()
        .setCustomId(`calc_modal:${coverFee ? "cover" : "no"}`)
        .setTitle(coverFee ? "Calculadora (Cobrir 30%)" : "Calculadora (Sem taxa)");

      const robux = new TextInputBuilder()
        .setCustomId("robux")
        .setLabel(shortLabel("Robux a receber"))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(robux));
      return i.showModal(modal);
    }

    if (i.isModalSubmit() && i.customId.startsWith("calc_modal:")) {
      const mode = i.customId.split(":")[1];
      const coverFee = mode === "cover";

      const netRobux = safeInt(i.fields.getTextInputValue("robux"));
      if (!Number.isFinite(netRobux) || netRobux <= 0) return i.reply({ content: "❌ Robux inválido.", ephemeral: true });

      const grossRobux = coverFee ? calcGrossToCoverFee(netRobux) : netRobux;
      const total = round2((grossRobux / 1000) * Number(cfg.ratePer1000 || 28));

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle("🧮 Resultado")
        .setDescription(
          [
            `**Robux (receber):** ${netRobux}`,
            `**Robux (gamepass):** ${grossRobux}`,
            `**Preço base:** 1000 = ${brl(Number(cfg.ratePer1000 || 28))}`,
            "",
            `**Total:** ${brl(total)}`,
          ].join("\n")
        );

      return i.reply({ embeds: [embed], ephemeral: true });
    }

    // ---------- Close ticket ----------
    if (i.isButton() && i.customId === "close_ticket") {
      const channel = i.channel;
      const ownerId = parseTicketOwnerIdFromTopic(channel?.topic || "");

      const isOwner = ownerId && i.user.id === ownerId;
      const isStaff = hasStaffRole(i.member, cfg);

      if (!isOwner && !isStaff) return i.reply({ content: "❌ Você não pode fechar este ticket.", ephemeral: true });

      await i.reply({ content: "🔒 Fechando ticket em 5 segundos...", ephemeral: true });
      await finalizeTicket(channel, "Ticket fechado manualmente");
      return;
    }

  } catch (e) {
    console.error(e);
    if (i.isRepliable()) {
      try { await i.reply({ content: "❌ Erro. Veja os logs.", ephemeral: true }); } catch {}
    }
  }
});

// ================== START ==================
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
