const { EmbedBuilder, MessageFlags, SlashCommandBuilder } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const users = require("../lib/users");
const { ACCENT } = require("../lib/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Disconnect your AniList account from Miru")
    .setIntegrationTypes([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    ])
    .setContexts([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ])
    .setDMPermission(true),
  async execute(interaction) {
    const removed = await users.unlinkAniList(interaction.user.id);

    if (!removed) {
      await interaction.reply({
        content: "You do not have an AniList account linked. Use `/link` to connect one.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(ACCENT.anilist)
          .setAuthor({ name: "AniList account unlinked" })
          .setDescription(`Miru no longer holds an access token for **${removed.name}**.`)
          // AniList has no token revocation endpoint, so the only way to be
          // certain is to remove the app on their side.
          .setFooter({ text: "You can also revoke Miru at anilist.co → Settings → Apps." })
      ],
      flags: MessageFlags.Ephemeral
    });
  }
};
