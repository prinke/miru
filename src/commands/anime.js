const { EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { searchAnime, truncate, describeSearchError, sourceLabel } = require("../lib/media-search");
const { createListControls } = require("../lib/list-controls");
const {
  ACCENT,
  accentFor,
  joinDot,
  joinLines,
  joinParagraphs,
  clamp,
  summarize,
  credit,
  chips,
  countLabel,
  timestamp,
  dateRange,
  startYear,
  seasonLabel,
  shortDuration,
  scoreLabel,
  rankLabel,
  fields,
  paginationFooter
} = require("../lib/embeds");

function createAnimeEmbed(result, currentIndex, totalResults) {
  const englishTitle = result.title_english && result.title_english !== result.title
    ? result.title_english
    : null;

  // The headline gets one title; the other is set as subtext above the synopsis
  // so the two never fight for the same line.
  const heading = englishTitle || result.title || "Unknown";
  const alternateTitle = englishTitle ? result.title : null;

  // Everything numeric lives on a single scannable line instead of taking up
  // four labelled cells that each hold one word.
  const stats = joinDot([
    scoreLabel(result.score, { bold: true }),
    rankLabel(result.rank),
    result.type,
    countLabel(result.episodes, "ep"),
    shortDuration(result.duration)
  ]);

  const next = result._nextEpisode;

  const embed = new EmbedBuilder()
    .setColor(accentFor(result.status, ACCENT.anime))
    .setAuthor(credit(result.studios))
    .setTitle(clamp(heading, 256))
    .setURL(result.url || null)
    .setDescription(joinParagraphs([
      joinLines([alternateTitle ? `-# ${clamp(alternateTitle, 200)}` : null, stats || null]),
      summarize(result.synopsis) || "*No synopsis available.*"
    ]))
    .setThumbnail(result.images?.jpg?.image_url || null)
    .addFields(fields([
      { name: "Status", value: result.status, inline: true },
      {
        name: "Aired",
        value: joinLines([
          seasonLabel(result.season, result.year),
          dateRange(result.aired?.from, result.aired?.to, { ongoingLabel: "airing" })
        ]),
        inline: true
      },
      // A countdown only matters while the show is running; once it has
      // finished, where it was adapted from is the more interesting line.
      next
        ? { name: "Next Episode", value: joinLines([`Episode ${next.episode}`, timestamp(next.airingAt, "R")]), inline: true }
        : { name: "Source", value: result.source, inline: true },
      { name: "Genres", value: chips(result.genres?.map((genre) => genre.name)), inline: false }
    ]))
    .setFooter(paginationFooter([
      sourceLabel(result),
      `${currentIndex + 1} of ${totalResults}`
    ]));

  // AniList banners are wide crops made for exactly this kind of header strip;
  // entries without one simply keep the cover thumbnail.
  if (result._banner) embed.setImage(result._banner);

  return embed;
}

module.exports = {
  // Shared with /season, whose detail view is the same card.
  createAnimeEmbed,
  data: new SlashCommandBuilder()
    .setName("anime")
    .setDescription("Search for an anime title")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Anime title to search for")
        .setRequired(true)
    )
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
    const query = interaction.options.getString("query", true);

    await interaction.deferReply();

    let results = null;
    try {
      results = await searchAnime(query);
    } catch (error) {
      console.error("Anime search failed:", error);
      await interaction.editReply(describeSearchError(error));
      return;
    }

    if (!results || results.length === 0) {
      await interaction.editReply("No anime results found.");
      return;
    }

    // Create dropdown menu with results
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("anime_select")
      .setPlaceholder("Select an anime to view details")
      .addOptions(
        results.slice(0, 25).map((result, index) => ({
          label: truncate(result.title_english || result.title || "Unknown", 100),
          // The picker is where results get compared, so each row carries the
          // few numbers that decide which one to open.
          description: truncate(joinDot([
            result.type,
            startYear(result.year, result.aired?.from),
            scoreLabel(result.score),
            result.episodes ? `${result.episodes} ep` : null
          ]), 100) || undefined,
          value: String(index)
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // List buttons are offered only to a viewer with a linked account, and the
    // button shown depends on whether the displayed result is already on their
    // list. Searching is a public feature that must not fail because of it.
    const controls = await createListControls({
      discordId: interaction.user.id,
      results,
      type: "ANIME"
    }).catch(() => null);

    const componentsFor = (index) => {
      const listRow = controls?.rowFor(index);
      return listRow ? [row, listRow] : [row];
    };

    let currentIndex = 0;
    const embed = createAnimeEmbed(results[0], 0, results.length);
    const response = await interaction.editReply({
      embeds: [embed],
      components: componentsFor(currentIndex)
    });

    // Collects both the result dropdown and the list buttons.
    const collector = response.createMessageComponentCollector({
      time: 300_000 // 5 minutes
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({
          content: "These controls are not for you!",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (controls?.owns(i.customId)) {
        // The buttons reflect list state (Add vs Remove, progress, score), so
        // the message they sit on has to be refreshed once the list changed.
        const changed = await controls.handle(i, currentIndex);
        if (changed) {
          await interaction.editReply({ components: componentsFor(currentIndex) }).catch(() => {});
        }
        return;
      }

      currentIndex = parseInt(i.values[0]);
      const selectedEmbed = createAnimeEmbed(results[currentIndex], currentIndex, results.length);

      await i.update({
        embeds: [selectedEmbed],
        components: componentsFor(currentIndex)
      });
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch (error) {
        // Message might have been deleted
      }
    });
  }
};

