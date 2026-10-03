const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const anilist = require("../lib/anilist");
const { describeAniListError } = require("../lib/anilist-errors");
const { createListControls } = require("../lib/list-controls");
const listEntries = require("../lib/list-entries");
const { statusLabel } = require("../lib/media-list");
const users = require("../lib/users");
const { ACCENT, clamp, joinDot, scoreLabel, timestamp } = require("../lib/embeds");
const { createAnimeEmbed } = require("./anime");

const PER_PAGE = 10;
const COLLECTOR_MS = 10 * 60 * 1000;
const FIRST_YEAR = 1940;

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const SEASON_NAME = { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" };

const SORTS = {
  POPULARITY_DESC: "Popularity",
  SCORE_DESC: "Score",
  TRENDING_DESC: "Trending",
  START_DATE: "Start date"
};

const FORMAT_FILTERS = {
  tv: { label: "TV", formats: ["TV", "TV_SHORT"] },
  movie: { label: "Movies", formats: ["MOVIE"] },
  ona: { label: "ONA", formats: ["ONA"] },
  ova: { label: "OVA & specials", formats: ["OVA", "SPECIAL"] }
};

const IDS = {
  pick: "season_pick",
  prev: "season_prev",
  next: "season_next",
  back: "season_back"
};

/**
 * AniList's seasons: winter is December–February, spring March–May, summer
 * June–August, fall September–November. December therefore belongs to the
 * *next* year's winter.
 */
function currentSeason(now = new Date()) {
  const month = now.getUTCMonth();
  if (month === 11) return { season: "WINTER", year: now.getUTCFullYear() + 1 };
  return { season: SEASONS[Math.floor((month + 1) / 3)], year: now.getUTCFullYear() };
}

function statusChip(status) {
  return status ? ` · \`${statusLabel(status, "ANIME")}\`` : "";
}

function chartLine(result, index, status) {
  const title = clamp(result.title_english || result.title || "Unknown", 55);
  const next = result._nextEpisode;
  return [
    `**${index + 1}.** [${title}](${result.url})${statusChip(status)}`,
    `-# ${joinDot([
      result.type,
      scoreLabel(result.score),
      result.episodes ? `${result.episodes} ep` : null,
      next ? `Ep ${next.episode} ${timestamp(next.airingAt, "R")}` : null
    ]) || "No details yet"}`
  ].join("\n");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("season")
    .setDescription("Browse a season's anime, with your list status on each")
    .addStringOption((option) =>
      option
        .setName("season")
        .setDescription("Which season (defaults to the current one)")
        .addChoices(...SEASONS.map((season) => ({ name: SEASON_NAME[season], value: season }))))
    .addIntegerOption((option) =>
      option.setName("year").setDescription("Which year (defaults to this one)").setMinValue(FIRST_YEAR))
    .addStringOption((option) =>
      option
        .setName("sort")
        .setDescription("Order (defaults to popularity)")
        .addChoices(...Object.entries(SORTS).map(([value, name]) => ({ name, value }))))
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription("Only show one kind (defaults to everything)")
        .addChoices(...Object.entries(FORMAT_FILTERS).map(([value, { label }]) => ({ name: label, value }))))
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
    const fallback = currentSeason();
    const season = interaction.options.getString("season") || fallback.season;
    const year = interaction.options.getInteger("year") ?? fallback.year;
    const sort = interaction.options.getString("sort") || "POPULARITY_DESC";
    const filter = FORMAT_FILTERS[interaction.options.getString("format")] || null;

    await interaction.deferReply();

    // The viewer's list status is a bonus; the chart works the same without it.
    const link = await users.getAniListLink(interaction.user.id).catch(() => null);
    const accessToken = link && !link.expired
      ? await users.getAniListToken(interaction.user.id).catch(() => null)
      : null;

    const loaded = [];
    const statuses = new Map();
    let apiPage = 0;
    let hasMore = true;
    let total = null;

    async function loadStatuses(results) {
      if (!accessToken) return;
      try {
        const entries = await listEntries.fetchEntries(accessToken, {
          userId: link.id,
          mediaIds: results.map((result) => result._anilistId)
        });
        for (const result of results) {
          statuses.set(result._anilistId, entries.get(result._anilistId)?.status ?? null);
        }
      } catch (error) {
        console.error("Season list status lookup failed:", error.name, error.reason ?? "", error.status ?? "");
      }
    }

    /** Fetches more of the season until `count` titles are loaded or none are left. */
    async function ensureLoaded(count) {
      while (loaded.length < count && hasMore) {
        apiPage += 1;
        const batch = await anilist.seasonalAnime({
          season,
          year,
          sort,
          ...(filter ? { formats: filter.formats } : {}),
          page: apiPage
        });
        loaded.push(...batch.results);
        hasMore = batch.hasNextPage;
        if (batch.total !== null) total = batch.total;
        await loadStatuses(batch.results);
      }
    }

    let page = 0;
    let detail = null; // { index, controls } while a single show is open

    const lastPage = () => Math.max(0, Math.ceil(loaded.length / PER_PAGE) - 1);
    const heading = joinDot([`${SEASON_NAME[season]} ${year}`, filter?.label, SORTS[sort]]);

    function chartView() {
      const start = page * PER_PAGE;
      const shown = loaded.slice(start, start + PER_PAGE);
      const pageCount = hasMore ? null : lastPage() + 1;

      const embed = new EmbedBuilder()
        .setColor(ACCENT.anime)
        .setAuthor({ name: "Seasonal chart" })
        .setTitle(heading)
        .setDescription(shown.map((result, offset) =>
          chartLine(result, start + offset, statuses.get(result._anilistId))).join("\n"))
        .setThumbnail(shown[0]?.images?.jpg?.image_url || null)
        .setFooter({
          text: joinDot([
            pageCount ? `Page ${page + 1} of ${pageCount}` : `Page ${page + 1}`,
            total !== null ? `${total} shows` : `${loaded.length}+ shows`,
            accessToken ? "Tags show your list" : "/link to see your list here",
            "AniList"
          ])
        });

      const picker = new StringSelectMenuBuilder()
        .setCustomId(IDS.pick)
        .setPlaceholder("Open a show…")
        .addOptions(shown.map((result, offset) => ({
          label: clamp(`${start + offset + 1}. ${result.title_english || result.title || "Unknown"}`, 100),
          description: clamp(joinDot([
            result.type,
            scoreLabel(result.score),
            statuses.get(result._anilistId) ? statusLabel(statuses.get(result._anilistId), "ANIME") : null
          ]), 100) || undefined,
          value: String(start + offset)
        })));

      const pager = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.prev).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(IDS.next)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= lastPage() && !hasMore)
      );

      return { embeds: [embed], components: [new ActionRowBuilder().addComponents(picker), pager] };
    }

    function detailView() {
      const result = loaded[detail.index];
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.back).setLabel("Back to chart").setStyle(ButtonStyle.Secondary)
      );
      const listRow = detail.controls?.rowFor(0);
      return {
        embeds: [createAnimeEmbed(result, detail.index, total ?? loaded.length)],
        components: listRow ? [back, listRow] : [back]
      };
    }

    const render = () => (detail ? detailView() : chartView());

    try {
      await ensureLoaded(PER_PAGE);
    } catch (error) {
      console.error("Season chart load failed:", error.name, error.status ?? "", error.message);
      await interaction.editReply(describeAniListError(error, "loading the season"));
      return;
    }

    if (loaded.length === 0) {
      await interaction.editReply(`AniList has nothing listed for ${heading} yet.`);
      return;
    }

    const response = await interaction.editReply(render());
    const collector = response.createMessageComponentCollector({ time: COLLECTOR_MS });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: "These controls are not for you!", flags: MessageFlags.Ephemeral });
        return;
      }

      // The list buttons on an open show run their own prompts and replies.
      if (detail?.controls?.owns(i.customId)) {
        if (await detail.controls.handle(i, 0)) {
          await interaction.editReply(render()).catch(() => {});
        }
        return;
      }

      await i.deferUpdate();

      try {
        if (i.customId === IDS.pick) {
          const index = Number(i.values[0]);
          // Built for one show at a time: the season can run to hundreds of
          // titles, and only the one on screen needs buttons.
          const controls = await createListControls({
            discordId: interaction.user.id,
            results: [loaded[index]],
            type: "ANIME"
          }).catch(() => null);
          detail = { index, controls };
        } else if (i.customId === IDS.back) {
          // Whatever was changed through the buttons should show in the chart.
          if (detail.controls) await loadStatuses([loaded[detail.index]]);
          detail = null;
        } else if (i.customId === IDS.next) {
          await ensureLoaded((page + 2) * PER_PAGE);
          page = Math.min(page + 1, lastPage());
        } else if (i.customId === IDS.prev) {
          page = Math.max(0, page - 1);
        }

        await i.editReply(render());
      } catch (error) {
        console.error("Season chart update failed:", error.name, error.status ?? "", error.message);
        await i.followUp({
          content: describeAniListError(error, "loading the season"),
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    });

    collector.on("end", async () => {
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  }
};
