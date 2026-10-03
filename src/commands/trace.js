const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { replyWithScene, SEARCHABLE_TYPE, MAX_UPLOAD_BYTES } = require("../lib/scene-search");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("trace")
    .setDescription("Find which anime, episode and moment a screenshot is from")
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("A screenshot, GIF or short clip"))
    .addStringOption((option) =>
      option.setName("url").setDescription("…or a link to one").setMaxLength(2000))
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
    const attachment = interaction.options.getAttachment("image");
    const link = interaction.options.getString("url")?.trim();

    const refuse = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    let url = null;
    if (attachment) {
      if (!SEARCHABLE_TYPE.test(attachment.contentType || "")) {
        await refuse("That file is not an image, GIF or video.");
        return;
      }
      if (attachment.size > MAX_UPLOAD_BYTES) {
        await refuse("That file is too large for scene search (25 MB at most).");
        return;
      }
      url = attachment.url;
    } else if (link) {
      if (!/^https?:\/\/\S+$/i.test(link)) {
        await refuse("That does not look like a link. It should start with `https://`.");
        return;
      }
      url = link;
    } else {
      await refuse("Attach an `image`, or give a `url` to one. You can also right-click any message with an image → **Apps → What anime is this?**");
      return;
    }

    await interaction.deferReply();
    await replyWithScene(interaction, url);
  }
};
