const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { queryAs } = require("../lib/anilist-auth");
const { describeAniListError } = require("../lib/anilist-errors");
const listEntries = require("../lib/list-entries");
const { statusLabel } = require("../lib/media-list");
const { requireLinkedAccount } = require("../lib/linked-account");
const users = require("../lib/users");
const { ACCENT, clamp, joinDot, joinLines } = require("../lib/embeds");

const COLLECTOR_MS = 5 * 60 * 1000;
const SUGGESTION_CACHE_MS = 3 * 60 * 1000;
// Discord drops an autocomplete answered after 3s, so a slow AniList gets cut
// off a little before that; the request still finishes and fills the cache for
// the next keystroke.
const SUGGESTION_DEADLINE_MS = 2_500;
const MAX_SUGGESTIONS = 25;
const PLUS_ONE_ID = "progress_plus_one";

// Watching comes first because it is what people log almost every time; the
// rest are offered so a paused or planned show can be picked up directly.
const SUGGESTED_STATUSES = ["CURRENT", "REPEATING", "PAUSED", "PLANNING"];

const SUGGESTIONS_QUERY = `
  query ($userId: Int, $statuses: [MediaListStatus]) {
    anime: MediaListCollection(userId: $userId, type: ANIME, status_in: $statuses) {
      lists { isCustomList entries { status progress updatedAt media { id type episodes title { romaji english } } } }
    }
    manga: MediaListCollection(userId: $userId, type: MANGA, status_in: $statuses) {
      lists { isCustomList entries { status progress updatedAt media { id type chapters title { romaji english } } } }
    }
  }
`;

// Discord user id -> { expiresAt, entries, pending }
const suggestionCache = new Map();

function flattenCollection(collection) {
  const seen = new Set();
  const entries = [];

  for (const list of collection?.lists || []) {
    // Custom lists repeat entries already present under their status.
    if (list.isCustomList) continue;
    for (const entry of list.entries || []) {
      const media = entry.media || {};
      if (!Number.isFinite(media.id) || seen.has(media.id)) continue;
      seen.add(media.id);
      entries.push({
        mediaId: media.id,
        type: media.type,
        status: entry.status,
        progress: entry.progress ?? 0,
        total: listEntries.totalOf(media),
        updatedAt: entry.updatedAt ?? 0,
        title: media.title?.english || media.title?.romaji || "Unknown",
        altTitle: media.title?.romaji || ""
      });
    }
  }
  return entries;
}

async function loadSuggestions(discordId) {
  const cached = suggestionCache.get(discordId);
  if (cached?.entries && cached.expiresAt > Date.now()) return cached.entries;
  if (cached?.pending) return cached.pending;

  const pending = (async () => {
    const link = await users.getAniListLink(discordId);
    const accessToken = link && !link.expired ? await users.getAniListToken(discordId) : null;
    if (!accessToken) return [];

    const data = await queryAs(accessToken, SUGGESTIONS_QUERY, {
      userId: link.id,
      statuses: SUGGESTED_STATUSES
    });

    const entries = [...flattenCollection(data?.anime), ...flattenCollection(data?.manga)]
      .sort((a, b) =>
        SUGGESTED_STATUSES.indexOf(a.status) - SUGGESTED_STATUSES.indexOf(b.status) ||
        b.updatedAt - a.updatedAt);

    suggestionCache.set(discordId, { entries, expiresAt: Date.now() + SUGGESTION_CACHE_MS });
    return entries;
  })();

  suggestionCache.set(discordId, { pending });
  try {
    return await pending;
  } catch (error) {
    suggestionCache.delete(discordId);
    throw error;
  }
}

/** Keeps the cached suggestions in step with a change made through the bot. */
function rememberEntry(discordId, entry) {
  const cached = suggestionCache.get(discordId);
  const known = cached?.entries?.find((candidate) => candidate.mediaId === entry.mediaId);
  if (known) Object.assign(known, { status: entry.status, progress: entry.progress, updatedAt: Date.now() / 1000 });
}

function unitOf(type) {
  return type === "MANGA" ? "Chapter" : "Episode";
}

function suggestionName(entry) {
  const short = entry.type === "MANGA" ? "Ch" : "Ep";
  const detail = joinDot([
    `${short} ${entry.progress}/${entry.total ?? "?"}`,
    entry.status === "CURRENT" ? null : statusLabel(entry.status, entry.type)
  ]);
  return `${clamp(entry.title, 100 - detail.length - 3)} · ${detail}`;
}

/** A filled bar reads at a glance where a fraction needs doing arithmetic. */
function progressBar(progress, total, width = 12) {
  if (!total) return null;
  const filled = Math.round(Math.min(progress / total, 1) * width);
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

function resultEmbed(entry, { finished, scoreChanged }) {
  const unit = unitOf(entry.type);
  const headline = finished
    ? `Completed${entry.repeat > 0 ? ` (run ${entry.repeat + 1})` : ""}! 🎉`
    : `${unit} **${entry.progress}**${entry.total ? ` of ${entry.total}` : ""}`;

  return new EmbedBuilder()
    .setColor(entry.type === "MANGA" ? ACCENT.manga : ACCENT.anime)
    .setAuthor({ name: scoreChanged && !finished ? "Score saved" : "Progress updated" })
    .setTitle(clamp(entry.title, 256))
    .setURL(entry.url || null)
    .setThumbnail(entry.cover || null)
    .setDescription(joinLines([
      headline,
      progressBar(entry.progress, entry.total),
      joinDot([statusLabel(entry.status, entry.type), entry.score ? `★ ${entry.score}` : null]),
      finished && !entry.score ? "-# Rate it with `/progress score:`" : null
    ]))
    .setFooter({ text: "AniList" });
}

function plusOneRow(entry) {
  const atEnd = entry.total !== null && entry.progress >= entry.total;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PLUS_ONE_ID)
      .setLabel(`+1 ${entry.type === "MANGA" ? "chapter" : "episode"}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(atEnd)
  );
}

/**
 * The option's value is a media id when picked from the suggestions. Someone
 * who types a title and sends without picking gets the closest list match.
 */
async function resolveMediaId(discordId, value) {
  if (/^\d+$/.test(value)) return Number(value);

  const needle = value.trim().toLowerCase();
  const entries = await loadSuggestions(discordId).catch(() => []);
  const match = entries.find((entry) =>
    entry.title.toLowerCase() === needle || entry.altTitle.toLowerCase() === needle) ||
    entries.find((entry) =>
      entry.title.toLowerCase().includes(needle) || entry.altTitle.toLowerCase().includes(needle));
  return match?.mediaId ?? null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("progress")
    .setDescription("Log an episode or chapter, or rate something on your AniList list")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Something on your list")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("episode")
        .setDescription("Set progress to this episode/chapter (defaults to one more than now)")
        .setMinValue(0)
        .setMaxValue(100000)
    )
    .addNumberOption((option) =>
      option
        .setName("score")
        .setDescription("Your score out of 10 (0 clears it)")
        .setMinValue(0)
        .setMaxValue(10)
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

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().trim().toLowerCase();

    const entries = await Promise.race([
      loadSuggestions(interaction.user.id).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve(null), SUGGESTION_DEADLINE_MS))
    ]);

    const matches = (entries || [])
      .filter((entry) => !typed ||
        entry.title.toLowerCase().includes(typed) ||
        entry.altTitle.toLowerCase().includes(typed))
      .slice(0, MAX_SUGGESTIONS);

    await interaction.respond(matches.map((entry) => ({
      name: suggestionName(entry),
      value: String(entry.mediaId)
    })));
  },

  async execute(interaction) {
    const account = await requireLinkedAccount(interaction);
    if (!account) return;
    const { link, accessToken } = account;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const to = interaction.options.getInteger("episode");
    const score = interaction.options.getNumber("score");

    let entry = null;
    let finished = false;
    try {
      const mediaId = await resolveMediaId(interaction.user.id, interaction.options.getString("title", true));
      entry = mediaId ? await listEntries.fetchEntry(accessToken, { userId: link.id, mediaId }) : null;

      if (!entry) {
        await interaction.editReply(
          "That is not on your list. Pick a title from the suggestions, or add it from `/anime` or `/manga` first."
        );
        return;
      }

      // A score on its own is just a rating; progress is only logged when asked
      // for or when nothing else was.
      if (to !== null || score === null) {
        const logged = await listEntries.logProgress(accessToken, {
          mediaId: entry.mediaId,
          entry,
          to: to ?? undefined,
          rewind: to !== null
        });

        if (logged.unchanged && score === null) {
          await interaction.editReply({
            content: to === null
              ? `You have already reached the end of **${clamp(entry.title, 100)}**.`
              : `**${clamp(entry.title, 100)}** is already at ${unitOf(entry.type).toLowerCase()} ${entry.progress}.`
          });
          return;
        }
        entry = logged.entry ?? entry;
        finished = logged.finished;
      }

      if (score !== null) {
        entry = (await listEntries.saveScore(accessToken, { mediaId: entry.mediaId, score })) ?? entry;
      }
    } catch (error) {
      console.error("AniList progress update failed:", error.name, error.reason ?? "", error.status ?? "");
      await interaction.editReply(describeAniListError(error, "updating your progress"));
      return;
    }

    rememberEntry(interaction.user.id, entry);

    const render = (shown, state) => ({
      embeds: [resultEmbed(shown, state)],
      components: shown.status === "COMPLETED" ? [] : [plusOneRow(shown)]
    });

    const response = await interaction.editReply(render(entry, { finished, scoreChanged: score !== null }));
    if (entry.status === "COMPLETED") return;

    // Binge sessions log several episodes in a row; the button saves retyping
    // the command each time. The reply is ephemeral, so only its owner can
    // press it.
    const collector = response.createMessageComponentCollector({ time: COLLECTOR_MS });

    collector.on("collect", async (button) => {
      await button.deferUpdate();
      try {
        const logged = await listEntries.logProgress(accessToken, { mediaId: entry.mediaId, entry });
        if (logged.unchanged) return;
        entry = logged.entry ?? entry;
        rememberEntry(interaction.user.id, entry);
        await button.editReply(render(entry, { finished: logged.finished, scoreChanged: false }));
        if (entry.status === "COMPLETED") collector.stop();
      } catch (error) {
        console.error("AniList progress update failed:", error.name, error.reason ?? "", error.status ?? "");
        await button.followUp({
          content: describeAniListError(error, "updating your progress"),
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    });

    collector.on("end", async () => {
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  }
};
