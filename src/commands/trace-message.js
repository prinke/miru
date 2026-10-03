// Right-click a message → Apps → "What anime is this?"

const { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { findMedia, replyWithScene } = require("../lib/scene-search");

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName("What anime is this?")
    .setType(ApplicationCommandType.Message)
    .setIntegrationTypes([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    ])
    .setContexts([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ]),

  async execute(interaction) {
    const { url, error } = findMedia(interaction.targetMessage);
    if (!url) {
      await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    await replyWithScene(interaction, url);
  }
};
