// Episode alerts: a DM when an episode of something on your Watching list airs.
//
// The work is arranged so that its cost does not grow with the number of users:
//   1. one request lists every episode that aired since the last check;
//   2. one request (per 50 matches) asks AniList which opted-in users have any
//      of those shows on Watching/Rewatching, and how far along they are.
// Both are public queries, so entries a user has marked private on AniList are
// not seen — the trade for not spending a request per user per tick.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");
const anilist = require("./anilist");
const { describeAniListError } = require("./anilist-errors");
const { getCollection } = require("./db");
const listEntries = require("./list-entries");
const users = require("./users");
const { ACCENT, clamp, joinDot, joinLines, timestamp } = require("./embeds");

const NOTIFICATIONS = "notifications";
const NOTIFICATION_TTL_SECONDS = 30 * 24 * 60 * 60;

const WATCHED_PREFIX = "alert_watched";
const MUTE_PREFIX = "alert_mute";

const PAGE_SIZE = 50;
// AniList limits how long an `_in` list may be; recipients are asked about in
// slices of this size.
const USERS_PER_QUERY = 500;

// Discord's error for "this user does not accept DMs from you".
const CANNOT_DM = 50007;

const AIRING_QUERY = `
  query ($from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: ${PAGE_SIZE}) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        episode
        airingAt
        media {
          id
          isAdult
          episodes
          siteUrl
          title { romaji english }
          coverImage { large color }
          externalLinks { site url type }
        }
      }
    }
  }
`;

const WATCHERS_QUERY = `
  query ($userIds: [Int], $mediaIds: [Int], $page: Int) {
    Page(page: $page, perPage: ${PAGE_SIZE}) {
      mediaList(userId_in: $userIds, mediaId_in: $mediaIds, status_in: [CURRENT, REPEATING]) {
        userId
        mediaId
        progress
      }
    }
  }
`;

function notifications() {
  return getCollection(NOTIFICATIONS);
}

async function ensureIndexes() {
  // Each (user, show, episode) is notified once; the record only has to outlive
  // any window the job might re-read, so it expires after a month.
  await notifications().createIndex(
    { createdAt: 1 },
    { name: "expire", expireAfterSeconds: NOTIFICATION_TTL_SECONDS }
  );
}

/** Episodes that aired strictly between `from` and `to` (unix seconds). */
async function fetchAired(from, to) {
  const aired = [];
  for (let page = 1; ; page += 1) {
    const data = await anilist.query(AIRING_QUERY, { from, to, page }, { cache: false });
    const schedules = data?.Page?.airingSchedules || [];
    aired.push(...schedules.filter((schedule) => schedule.media && !schedule.media.isAdult));
    if (!data?.Page?.pageInfo?.hasNextPage || schedules.length === 0) break;
  }
  return aired;
}

/** `[{ userId, mediaId, progress }]` for every watcher of any of `mediaIds`. */
async function fetchWatchers(userIds, mediaIds) {
  const watchers = [];
  for (let start = 0; start < userIds.length; start += USERS_PER_QUERY) {
    const slice = userIds.slice(start, start + USERS_PER_QUERY);
    // `Page.pageInfo` is not trustworthy for `mediaList` (see media-list.js),
    // so a short page is what marks the end.
    for (let page = 1; ; page += 1) {
      const data = await anilist.query(WATCHERS_QUERY, { userIds: slice, mediaIds, page }, { cache: false });
      const entries = data?.Page?.mediaList || [];
      watchers.push(...entries);
      if (entries.length < PAGE_SIZE) break;
    }
  }
  return watchers;
}

function titleOf(media) {
  return media?.title?.english || media?.title?.romaji || "Unknown";
}

/** The first legal streaming link AniList knows of, for a "Watch" button. */
function streamingLink(media) {
  return (media?.externalLinks || []).find((link) => link.type === "STREAMING" && link.url) || null;
}

function alertEmbed(schedule, progress) {
  const { media, episode } = schedule;
  const isFinale = Number.isFinite(media.episodes) && episode === media.episodes;
  const behind = episode - progress - 1;

  return new EmbedBuilder()
    .setColor(media.coverImage?.color ? parseInt(media.coverImage.color.slice(1), 16) : ACCENT.anime)
    .setAuthor({ name: isFinale ? "Final episode out now" : "New episode out now" })
    .setTitle(clamp(`${titleOf(media)} — Episode ${episode}`, 256))
    .setURL(media.siteUrl || null)
    .setThumbnail(media.coverImage?.large || null)
    .setDescription(joinLines([
      joinDot([`Aired ${timestamp(new Date(schedule.airingAt * 1000).toISOString(), "R")}`,
        media.episodes ? `${episode} of ${media.episodes}` : null]),
      // Worth saying when the user is not caught up: this is not the next
      // episode for them.
      behind > 0 ? `-# You have ${behind} earlier episode${behind === 1 ? "" : "s"} to catch up on first.` : null
    ]))
    .setFooter({ text: "Miru episode alerts · /alerts off to stop" });
}

function alertComponents(schedule, { watched = null, muted = false } = {}) {
  const { media, episode } = schedule;
  const watchedLabel = {
    done: `Episode ${episode} marked watched`,
    already: "Already watched"
  }[watched] || `Mark episode ${episode} watched`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${WATCHED_PREFIX}:${media.id}:${episode}`)
      .setLabel(watchedLabel)
      .setStyle(ButtonStyle.Success)
      .setDisabled(watched !== null),
    new ButtonBuilder()
      .setCustomId(`${MUTE_PREFIX}:${media.id}`)
      .setLabel(muted ? "Muted" : "Mute this show")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(muted)
  );

  const stream = streamingLink(media);
  if (stream) {
    row.addComponents(
      new ButtonBuilder().setLabel(clamp(`Watch on ${stream.site}`, 80)).setStyle(ButtonStyle.Link).setURL(stream.url)
    );
  }
  return [row];
}

/**
 * Records that this alert is going out. Resolves false when it already has —
 * the unique `_id` is what stops an overlapping window from sending it twice.
 */
async function claim(discordId, mediaId, episode) {
  try {
    await notifications().insertOne({
      _id: `${discordId}:${mediaId}:${episode}`,
      createdAt: new Date()
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Checks the airing schedule between two instants and DMs everyone affected.
 * Returns how many alerts were sent.
 */
async function deliverAlerts(client, { from, to }) {
  // Strict bounds on AniList's side; widened by a second so an episode airing
  // exactly on a boundary is seen (and then deduplicated by `claim`).
  const aired = await fetchAired(from - 1, to + 1);
  if (aired.length === 0) return 0;

  const recipients = await users.alertRecipients();
  if (recipients.size === 0) return 0;

  const schedulesByMedia = new Map();
  for (const schedule of aired) {
    const list = schedulesByMedia.get(schedule.media.id) || [];
    list.push(schedule);
    schedulesByMedia.set(schedule.media.id, list);
  }

  const watchers = await fetchWatchers([...recipients.keys()], [...schedulesByMedia.keys()]);

  let sent = 0;
  for (const watcher of watchers) {
    for (const schedule of schedulesByMedia.get(watcher.mediaId) || []) {
      // Already seen it (simulcasts sometimes appear on AniList late).
      if ((watcher.progress ?? 0) >= schedule.episode) continue;

      for (const { discordId, muted } of recipients.get(watcher.userId) || []) {
        if (muted.has(watcher.mediaId)) continue;
        if (!(await claim(discordId, watcher.mediaId, schedule.episode))) continue;

        try {
          const user = await client.users.fetch(discordId);
          await user.send({
            embeds: [alertEmbed(schedule, watcher.progress ?? 0)],
            components: alertComponents(schedule)
          });
          sent += 1;
        } catch (error) {
          if (error?.code === CANNOT_DM) {
            await users.markAlertsUndeliverable(discordId).catch(() => {});
          } else {
            console.error(`Episode alert to ${discordId} failed:`, error.message);
          }
        }
      }
    }
  }
  return sent;
}

/** Rebuilds an alert's schedule from the custom id and the message it sits on. */
function scheduleFromMessage(message, mediaId, episode) {
  const embed = message?.embeds?.[0];
  const linkButton = message?.components?.[0]?.components?.find((component) => component.url);
  return {
    episode,
    media: {
      id: mediaId,
      siteUrl: embed?.url || null,
      externalLinks: linkButton
        ? [{ type: "STREAMING", url: linkButton.url, site: linkButton.label.replace(/^Watch on /, "") }]
        : []
    }
  };
}

function currentState(message) {
  const buttons = message?.components?.[0]?.components || [];
  let watched = null;
  if (buttons[0]?.disabled) watched = buttons[0].label === "Already watched" ? "already" : "done";
  return { watched, muted: Boolean(buttons[1]?.disabled) };
}

async function handleWatched(interaction) {
  const [, mediaId, episode] = interaction.customId.split(":").map(Number);

  const link = await users.getAniListLink(interaction.user.id);
  const accessToken = link && !link.expired ? await users.getAniListToken(interaction.user.id) : null;
  if (!accessToken) {
    await interaction.reply({
      content: "Your AniList account is no longer linked. Run `/link` to reconnect it.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferUpdate();

  let outcome = null;
  try {
    const entry = await listEntries.fetchEntry(accessToken, { userId: link.id, mediaId });
    const logged = await listEntries.logProgress(accessToken, { mediaId, entry, to: episode });
    outcome = logged.unchanged ? "already" : "done";
  } catch (error) {
    console.error("Marking an alerted episode failed:", error.name, error.reason ?? "", error.status ?? "");
    await interaction.followUp({
      content: describeAniListError(error, "updating your progress"),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const schedule = scheduleFromMessage(interaction.message, mediaId, episode);
  await interaction.editReply({
    components: alertComponents(schedule, { watched: outcome, muted: currentState(interaction.message).muted })
  });
}

async function handleMute(interaction) {
  const [, mediaId] = interaction.customId.split(":").map(Number);
  await users.muteAlert(interaction.user.id, mediaId);

  const watchedButton = interaction.message?.components?.[0]?.components?.[0];
  const episode = Number(watchedButton?.customId?.split(":")[2]);
  const schedule = scheduleFromMessage(interaction.message, mediaId, episode);

  await interaction.update({
    components: alertComponents(schedule, { watched: currentState(interaction.message).watched, muted: true })
  });
}

module.exports = {
  ensureIndexes,
  deliverAlerts,
  components: {
    [WATCHED_PREFIX]: handleWatched,
    [MUTE_PREFIX]: handleMute
  }
};
