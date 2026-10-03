// A user's whole list for one media type, with enough about each title to
// compare, recommend from and summarise.
//
// `media-list.js` pages through one status at a time for display; the features
// built on this one need everything at once. AniList serves a collection in
// chunks of at most 500 entries, so large lists take a few requests.

const anilist = require("./anilist");
const { queryAs } = require("./anilist-auth");

const PER_CHUNK = 500;
// A safety stop, not a real limit: 10 chunks is a 5,000-entry list.
const MAX_CHUNKS = 10;

// Statuses that mean the user has actually watched/read some of it.
const SEEN_STATUSES = new Set(["CURRENT", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"]);

const LIBRARY_QUERY = `
  query ($userId: Int, $userName: String, $type: MediaType, $chunk: Int) {
    MediaListCollection(userId: $userId, userName: $userName, type: $type, chunk: $chunk, perChunk: ${PER_CHUNK}) {
      hasNextChunk
      user { id name siteUrl avatar { large } options { profileColor } }
      lists {
        isCustomList
        entries {
          status
          private
          score(format: POINT_100)
          progress
          repeat
          updatedAt
          startedAt { year month day }
          completedAt { year month day }
          media {
            id
            type
            format
            status
            episodes
            duration
            chapters
            genres
            averageScore
            popularity
            isAdult
            siteUrl
            title { romaji english }
            coverImage { large color }
            studios(isMain: true) { nodes { name isAnimationStudio } }
          }
        }
      }
    }
  }
`;

function mapEntry(entry) {
  const media = entry.media;
  return {
    status: entry.status,
    private: Boolean(entry.private),
    // 0 means "not scored", not "scored zero"; kept as null so averages and
    // correlations cannot mistake one for the other.
    score: entry.score > 0 ? entry.score : null,
    progress: entry.progress ?? 0,
    repeat: entry.repeat ?? 0,
    updatedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000) : null,
    startedAt: entry.startedAt?.year ? entry.startedAt : null,
    completedAt: entry.completedAt?.year ? entry.completedAt : null,
    media: {
      id: media.id,
      type: media.type,
      format: media.format,
      status: media.status,
      episodes: media.episodes ?? null,
      duration: media.duration ?? null,
      chapters: media.chapters ?? null,
      genres: media.genres || [],
      averageScore: media.averageScore ?? null,
      popularity: media.popularity ?? 0,
      isAdult: Boolean(media.isAdult),
      url: media.siteUrl || null,
      title: media.title?.english || media.title?.romaji || "Unknown",
      cover: media.coverImage?.large || null,
      color: media.coverImage?.color || null,
      // "Main" studios include producers and licensors; only the animators count.
      studios: (media.studios?.nodes || []).filter((studio) => studio.isAnimationStudio).map((studio) => studio.name).filter(Boolean)
    }
  };
}

/**
 * Loads a library by AniList user id or name.
 *
 * With `accessToken` the request is made as that user, which includes their
 * private entries — only appropriate when the result is shown to that same
 * user. Without it the request is public and sees what anyone on AniList could.
 *
 * Resolves to `{ user, entries }`, one entry per title.
 */
async function fetchLibrary({ userId, userName, type = "ANIME", accessToken = null }) {
  const run = (variables) => (accessToken
    ? queryAs(accessToken, LIBRARY_QUERY, variables)
    : anilist.query(LIBRARY_QUERY, variables));

  const byMedia = new Map();
  let user = null;

  for (let chunk = 1; chunk <= MAX_CHUNKS; chunk += 1) {
    const data = await run({ userId, userName, type, chunk });
    const collection = data?.MediaListCollection;
    user = user || collection?.user || null;

    for (const list of collection?.lists || []) {
      // Custom lists repeat entries already present under their status.
      if (list.isCustomList) continue;
      for (const entry of list.entries || []) {
        if (entry?.media && !byMedia.has(entry.media.id)) byMedia.set(entry.media.id, mapEntry(entry));
      }
    }

    if (!collection?.hasNextChunk) break;
  }

  return {
    user: user && {
      id: user.id,
      name: user.name,
      url: user.siteUrl || null,
      avatar: user.avatar?.large || null,
      color: user.options?.profileColor || null
    },
    entries: [...byMedia.values()]
  };
}

function isSeen(entry) {
  return SEEN_STATUSES.has(entry?.status);
}

// Where a title stops naming the franchise and starts naming the instalment:
// "Re:ZERO -Starting Life…", "Mushoku Tensei: Jobless…", "… Season 2", "… 2nd Season".
const INSTALMENT_MARKER = /\s[-:–]|:\s|\s(season|part|cour)\b|\s\d+(st|nd|rd|th)\s+season|\s(ii|iii|iv|2|3|4)$/i;

/**
 * A rough franchise key from a title, so that lists of picks are not five
 * seasons of the same show. AniList's relations would be exact but cost a
 * request per title; this is free and right often enough for a top-five list.
 */
function franchiseKey(title) {
  const lower = String(title || "").toLowerCase().trim();
  const match = lower.match(INSTALMENT_MARKER);
  return (match ? lower.slice(0, match.index) : lower).trim();
}

/** Keeps the first item of each franchise, in order. */
function onePerFranchise(items, titleOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = franchiseKey(titleOf(item));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { SEEN_STATUSES, fetchLibrary, isSeen, franchiseKey, onePerFranchise };
