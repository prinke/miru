const { EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { searchManga, truncate, describeSearchError, sourceLabel } = require("../lib/media-search");
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
  dateRange,
  startYear,
  scoreLabel,
  rankLabel,
  fields,
  paginationFooter
} = require("../lib/embeds");

function createMangaEmbed(result, currentIndex, totalResults) {
  const englishTitle = result.title_english && result.title_english !== result.title
    ? result.title_english
    : null;

  // As in the anime embed: one title in the headline, the other as subtext.
  const heading = englishTitle || result.title || "Unknown";
  const alternateTitle = englishTitle ? result.title : null;

  const stats = joinDot([
    scoreLabel(result.score, { bold: true }),
    rankLabel(result.rank),
    result.type,
    countLabel(result.chapters, "chapter"),
    countLabel(result.volumes, "volume")
  ]);

  const embed = new EmbedBuilder()
    .setColor(accentFor(result.status, ACCENT.manga))
    .setAuthor(credit(result.authors))
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
        name: "Published",
        value: dateRange(result.published?.from, result.published?.to, { ongoingLabel: "ongoing" }),
        inline: true
      },
      { name: "Genres", value: chips(result.genres?.map((genre) => genre.name)), inline: false }
    ]))
    .setFooter(paginationFooter([
      sourceLabel(result),
      `${currentIndex + 1} of ${totalResults}`
    ]));

  if (result._banner) embed.setImage(result._banner);

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("manga")
    .setDescription("Search for a manga title")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Manga title to search for")
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
      results = await searchManga(query);
    } catch (error) {
      console.error("Manga search failed:", error);
      await interaction.editReply(describeSearchError(error));
      return;
    }

    if (!results || results.length === 0) {
      await interaction.editReply("No manga results found.");
      return;
    }

    // Create dropdown menu with results
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("manga_select")
      .setPlaceholder("Select a manga to view details")
      .addOptions(
        results.slice(0, 25).map((result, index) => ({
          label: truncate(result.title_english || result.title || "Unknown", 100),
          description: truncate(joinDot([
            result.type,
            startYear(result.year, result.published?.from),
            scoreLabel(result.score),
            result.chapters ? `${result.chapters} ch` : null
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
      type: "MANGA"
    }).catch(() => null);

    const componentsFor = (index) => {
      const listRow = controls?.rowFor(index);
      return listRow ? [row, listRow] : [row];
    };

    let currentIndex = 0;
    const embed = createMangaEmbed(results[0], 0, results.length);
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
      const selectedEmbed = createMangaEmbed(results[currentIndex], currentIndex, results.length);

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

