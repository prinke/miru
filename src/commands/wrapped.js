const { AttachmentBuilder, MessageFlags, SlashCommandBuilder } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { describeAniListError } = require("../lib/anilist-errors");
const { fetchLibrary } = require("../lib/library");
const { requireLinkedAccount } = require("../lib/linked-account");
const users = require("../lib/users");
const { computeWrapped, recordAndRank, ensureIndexes } = require("../lib/wrapped");
const { renderWrappedCard } = require("../lib/wrapped-card");

const FIRST_YEAR = 2010;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("wrapped")
    .setDescription("Your year in anime and manga, as a shareable card")
    .addIntegerOption((option) =>
      option
        .setName("year")
        .setDescription("Which year (defaults to this one)")
        // No maximum: it would be frozen at whatever year the commands were
        // last deployed in, so the future is refused at run time instead.
        .setMinValue(FIRST_YEAR))
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

  ensureIndexes,

  async execute(interaction) {
    const currentYear = new Date().getUTCFullYear();
    const year = interaction.options.getInteger("year") ?? currentYear;
    if (year > currentYear) {
      await interaction.reply({ content: `${year} has not happened yet!`, flags: MessageFlags.Ephemeral });
      return;
    }

    const account = await requireLinkedAccount(interaction);
    if (!account) return;
    const { link, accessToken } = account;

    await interaction.deferReply();

    let anime = null;
    let manga = null;
    try {
      // Read as the user so private entries still count towards the totals;
      // the card never names one (see computeWrapped).
      anime = await fetchLibrary({ userId: link.id, type: "ANIME", accessToken });
      manga = await fetchLibrary({ userId: link.id, type: "MANGA", accessToken });
    } catch (error) {
      console.error("Wrapped library load failed:", error.name, error.reason ?? "", error.status ?? "");
      await interaction.editReply(describeAniListError(error, "loading your lists"));
      return;
    }

    const stats = computeWrapped({ anime: anime.entries, manga: manga.entries }, year);
    if (stats.animeCount + stats.mangaCount === 0) {
      await interaction.editReply(
        `Nothing on your AniList lists was started or finished in ${year}. ` +
        "Wrapped is built from the start and finish dates on your entries."
      );
      return;
    }

    // Ranking is a nice-to-have; the card still goes out without it.
    const standing = await recordAndRank({
      discordId: interaction.user.id,
      year,
      minutes: stats.minutes,
      chapters: stats.chapters,
      servers: await users.getServers(interaction.user.id),
      guildId: interaction.guildId
    }).catch((error) => {
      console.error("Wrapped ranking failed:", error.message);
      return null;
    });

    const card = await renderWrappedCard({
      user: { ...anime.user, name: anime.user?.name || link.name, avatar: anime.user?.avatar || link.avatar },
      stats,
      standing,
      // Only a server-installed bot can see the server; a user install in
      // someone else's server just goes without the server ranking.
      serverName: interaction.guild?.name ?? null
    });

    await interaction.editReply({
      content: `**${link.name}**'s ${year} on AniList`,
      files: [new AttachmentBuilder(card, { name: `miru-wrapped-${year}.png` })]
    });
  }
};
