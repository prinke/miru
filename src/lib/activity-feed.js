// Server watch feeds: members' AniList list activity, posted into a channel.
//
// AniList already records every list change as an activity, including changes
// made on its own site and apps, so the feed reads those rather than tracking
// edits made through Miru. One query covers every member of every server.

const { EmbedBuilder } = require("discord.js");
const anilist = require("./anilist");
const { ACCENT, clamp } = require("./embeds");

const PAGE_SIZE = 50;
// How far back a single run will page. A run that finds more than this much
// new activity is far enough behind that the oldest of it is stale anyway.
const MAX_PAGES = 4;
const USERS_PER_QUERY = 500;
// Discord's limit on embeds in one message.
const EMBEDS_PER_MESSAGE = 10;

const ACTIVITIES_QUERY = `
  query ($userIds: [Int], $page: Int) {
    Page(page: $page, perPage: ${PAGE_SIZE}) {
      activities(userId_in: $userIds, type_in: [ANIME_LIST, MANGA_LIST], sort: ID_DESC) {
        ... on ListActivity {
          id
          status
          progress
          createdAt
          user { id name avatar { medium } }
          media { id type isAdult siteUrl title { romaji english } coverImage { medium } }
        }
      }
    }
  }
`;

const SCORES_QUERY = `
  query ($userIds: [Int], $mediaIds: [Int]) {
    Page(perPage: ${PAGE_SIZE}) {
      mediaList(userId_in: $userIds, mediaId_in: $mediaIds) {
        userId
        mediaId
        score(format: POINT_10_DECIMAL)
      }
    }
  }
`;

const STATUS_COLOUR = {
  completed: 0x43b581,
  dropped: 0xed4245
};

/**
 * Activities newer than `afterId`, oldest first. With no `afterId` (the first
 * run) nothing is returned, only the id to start from next time.
 */
async function fetchNewActivities(anilistIds, afterId) {
  const fresh = [];
  let newestId = afterId ?? 0;

  for (let start = 0; start < anilistIds.length; start += USERS_PER_QUERY) {
    const userIds = anilistIds.slice(start, start + USERS_PER_QUERY);

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await anilist.query(ACTIVITIES_QUERY, { userIds, page }, { cache: false });
      const activities = (data?.Page?.activities || []).filter((activity) => activity?.id);

      for (const activity of activities) newestId = Math.max(newestId, activity.id);
      if (afterId === null) break;

      const unseen = activities.filter((activity) => activity.id > afterId);
      fresh.push(...unseen);
      // Sorted newest first, so once anything already seen shows up the rest is old.
      if (unseen.length < activities.length || activities.length < PAGE_SIZE) break;
    }
  }

  return {
    activities: fresh.filter((activity) => !activity.media?.isAdult).sort((a, b) => a.id - b.id),
    newestId
  };
}

/** Scores for the completed titles, as `Map<"userId:mediaId", score>`. */
async function fetchCompletionScores(activities) {
  const completed = activities.filter((activity) => /^(completed|rewatched|reread)$/.test(activity.status));
  if (completed.length === 0) return new Map();

  const data = await anilist.query(SCORES_QUERY, {
    userIds: [...new Set(completed.map((activity) => activity.user.id))],
    mediaIds: [...new Set(completed.map((activity) => activity.media.id))]
  }, { cache: false }).catch(() => null);

  const scores = new Map();
  for (const entry of data?.Page?.mediaList || []) {
    if (entry.score) scores.set(`${entry.userId}:${entry.mediaId}`, entry.score);
  }
  return scores;
}

/**
 * Highlights are the moments worth announcing: finishing, dropping, finishing
 * a rewatch, and starting something new. Everything else is "everything".
 */
function isHighlight(activity) {
  if (/^(completed|dropped|rewatched|reread)$/.test(activity.status)) return true;
  return /^(watched episode|read chapter)$/.test(activity.status) && /^1(\s|$)/.test(activity.progress || "");
}

/** "watched episodes 4 - 6 of", "completed", "started watching" ... */
function describe(activity) {
  const { status, progress } = activity;
  const range = progress && progress.includes("-");

  if (status === "watched episode" && /^1(\s|$)/.test(progress || "") && !range) return "started watching";
  if (status === "read chapter" && /^1(\s|$)/.test(progress || "") && !range) return "started reading";
  if (/(episode|chapter)$/.test(status) && progress) {
    return `${range ? `${status}s` : status} ${progress} of`;
  }
  if (status === "rewatched" || status === "reread") return `finished ${status === "rewatched" ? "rewatching" : "rereading"}`;
  return status;
}

function activityEmbed(activity, { discordId, score }) {
  const media = activity.media;
  const title = clamp(media.title?.english || media.title?.romaji || "Unknown", 120);

  return new EmbedBuilder()
    .setColor(STATUS_COLOUR[activity.status] ?? (media.type === "MANGA" ? ACCENT.manga : ACCENT.anime))
    .setAuthor({ name: activity.user.name, iconURL: activity.user.avatar?.medium || undefined })
    // A mention inside an embed shows the member's name but never pings them.
    .setDescription(
      `<@${discordId}> ${describe(activity)} **[${title}](${media.siteUrl})**${score ? ` · ★ ${score}` : ""}`
    )
    .setThumbnail(media.coverImage?.medium || null)
    .setTimestamp(new Date(activity.createdAt * 1000));
}

/**
 * Posts one run's activity into every feed it belongs to.
 *
 * @param feeds    `Map<guildId, feed>`
 * @param members  `Map<anilistId, [{ discordId, servers }]>`
 */
async function postActivities(client, { activities, feeds, members }) {
  const scores = await fetchCompletionScores(activities);
  const byGuild = new Map();

  for (const activity of activities) {
    for (const { discordId, servers } of members.get(activity.user.id) || []) {
      for (const guildId of servers) {
        const feed = feeds.get(guildId);
        if (!feed || (feed.mode !== "everything" && !isHighlight(activity))) continue;

        const embeds = byGuild.get(guildId) || [];
        embeds.push(activityEmbed(activity, {
          discordId,
          score: scores.get(`${activity.user.id}:${activity.media.id}`)
        }));
        byGuild.set(guildId, embeds);
      }
    }
  }

  let posted = 0;
  for (const [guildId, embeds] of byGuild) {
    const channel = await client.channels.fetch(feeds.get(guildId).channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    for (let start = 0; start < embeds.length; start += EMBEDS_PER_MESSAGE) {
      try {
        await channel.send({
          embeds: embeds.slice(start, start + EMBEDS_PER_MESSAGE),
          allowedMentions: { parse: [] }
        });
        posted += Math.min(EMBEDS_PER_MESSAGE, embeds.length - start);
      } catch (error) {
        // Usually a permission removed after setup; the next run tries again.
        console.error(`Feed post to guild ${guildId} failed:`, error.message);
        break;
      }
    }
  }
  return posted;
}

module.exports = { fetchNewActivities, postActivities, isHighlight, describe };
