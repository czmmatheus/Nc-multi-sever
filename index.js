const fs = require("fs-extra");
const path = require("path");
const fetch = require("node-fetch");
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require("discord.js");
require("dotenv").config();

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const stockPath = path.join(__dirname, "stock.json");
let stockData = fs.readJsonSync(stockPath);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// Evita "app não respondeu"
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// Função para salvar JSON
function saveStock() {
  fs.writeJsonSync(stockPath, stockData, { spaces: 2 });
}

// Atualiza painel principal
async function updatePanel() {
  if (!stockData.panelChannelId || !stockData.panelMessageId) return;
  const channel = await client.channels.fetch(stockData.panelChannelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(stockData.panelMessageId).catch(() => null);
  if (!msg) return;

  const embed = new EmbedBuilder()
    .setTitle("💸 Robux & Gamepass")
    .setDescription(
      `📦 **STOCK ATUAL:** ${stockData.stock} Robux disponíveis\n💰 **Preço Base:** R$${stockData.pricePer1000} / 1000 Robux\n\n**Gamepass:** +5% adicional e taxa de 30% incluída automaticamente.\n\nSelecione uma opção abaixo.`
    )
    .setColor("Purple")
    .setFooter({ text: "Painel atualizado automaticamente" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Comprar Robux").setStyle(ButtonStyle.Primary).setCustomId("buy_robux"),
    new ButtonBuilder().setLabel("Enviar Gamepass (in-game)").setStyle(ButtonStyle.Secondary).setCustomId("buy_gp")
  );

  await msg.edit({ embeds: [embed], components: [row] });
}

client.once("ready", async () => {
  console.log(`✅ Logado como ${client.user.tag}`);
  await updatePanel();
});

// Registro de comandos
client.on("ready", async () => {
  const commands = [
    new SlashCommandBuilder().setName("cmd").setDescription("Cria painel principal de compra."),
    new SlashCommandBuilder().setName("stock").setDescription("Atualiza o estoque.").addIntegerOption(o => o.setName("valor").setDescription("Novo valor").setRequired(true)),
    new SlashCommandBuilder().setName("logs").setDescription("Registra uma venda."),
    new SlashCommandBuilder().setName("paineladm").setDescription("Altera o preço base de 1000 Robux.").addNumberOption(o => o.setName("valor").setDescription("Novo preço").setRequired(true)),
    new SlashCommandBuilder().setName("setpainel").setDescription("Define este canal como painel.")
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Comandos registrados globalmente");
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand() && !i.isButton()) return;

  // Evita timeouts
  if (!i.deferred && !i.replied) await i.deferReply({ ephemeral: true }).catch(() => {});

  try {
    if (i.commandName === "cmd") {
      const embed = new EmbedBuilder()
        .setTitle("💸 Robux & Gamepass")
        .setDescription(`📦 **STOCK ATUAL:** ${stockData.stock} Robux disponíveis\n💰 **Preço Base:** R$${stockData.pricePer1000} / 1000 Robux\n\nSelecione uma opção abaixo.`)
        .setColor("Purple");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Comprar Robux").setStyle(ButtonStyle.Primary).setCustomId("buy_robux"),
        new ButtonBuilder().setLabel("Enviar Gamepass (in-game)").setStyle(ButtonStyle.Secondary).setCustomId("buy_gp")
      );

      const msg = await i.channel.send({ embeds: [embed], components: [row] });
      stockData.panelChannelId = msg.channel.id;
      stockData.panelMessageId = msg.id;
      saveStock();

      await i.editReply("✅ Painel criado e salvo!");
    }

    if (i.commandName === "stock") {
      const novo = i.options.getInteger("valor");
      stockData.stock = novo;
      saveStock();
      await updatePanel();
      await i.editReply(`📦 Estoque atualizado para ${novo} Robux.`);
    }

    if (i.commandName === "paineladm") {
      const novo = i.options.getNumber("valor");
      stockData.pricePer1000 = novo;
      saveStock();
      await updatePanel();
      await i.editReply(`💰 Novo preço base definido: R$${novo} / 1000 Robux.`);
    }

    if (i.commandName === "setpainel") {
      stockData.panelChannelId = i.channel.id;
      stockData.panelMessageId = null;
      saveStock();
      await i.editReply("📌 Este canal foi definido como o canal do painel.");
    }

    if (i.commandName === "logs") {
      await i.editReply("🧾 Venda registrada nas logs (simulação).");
    }

    // Botões
    if (i.isButton()) {
      if (i.customId === "buy_robux") {
        await i.editReply("🛒 Use /logs para registrar a compra de Robux.");
      }

      if (i.customId === "buy_gp") {
        await i.editReply("🎮 Envie o link da Gamepass (com 5% adicional).");
      }
    }
  } catch (err) {
    console.error(err);
    await i.editReply("❌ Erro ao processar comando.");
  }
});

client.login(TOKEN);