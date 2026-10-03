// Reads a linked user's AniList library.
//
// AniList also offers `MediaListCollection`, which returns every entry in one
// response. This uses the paginated `Page.mediaList` instead so that browsing a
// 2,000-entry list costs one small request per page rather than one enormous
// one up front.

const { queryAs } = require("./anilist-auth");

const PER_PAGE = 10;

// The wording AniList itself uses, which differs between anime and manga for
// the two statuses that describe an activity rather than a state.
const STATUS_LABELS = {
  ANIME: { CURRENT: "Watching", REPEATING: "Rewatching" },
  MANGA: { CURRENT: "Reading", REPEATING: "Rereading" },
  SHARED: {
    PLANNING: "Planning",
    COMPLETED: "Completed",
    PAUSED: "Paused",
    DROPPED: "Dropped"
  }
};

// Ordered the way the lists are presented on AniList profiles.
const STATUS_ORDER = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"];

function statusLabel(status, type = "ANIME") {
  return STATUS_LABELS[type]?.[status] || STATUS_LABELS.SHARED[status] || status;
}

function statusChoices(type = "ANIME") {
  return STATUS_ORDER.map((status) => ({ value: status, label: statusLabel(status, type) }));
}

// `Page.pageInfo` is deliberately not requested here. For `mediaList` AniList
// reports a capped placeholder rather than the real figure — a 242-entry list
// comes back as "total: 5000, lastPage: 500" for every status — so the counts
// come from the user's statistics instead (see `fetchListCounts`).
const LIST_QUERY = `
  query ($userId: Int, $type: MediaType, $status: MediaListStatus, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      mediaList(userId: $userId, type: $type, status: $status, sort: UPDATED_TIME_DESC) {
        score(format: POINT_10_DECIMAL)
        progress
        updatedAt
        media {
          id
          siteUrl
          format
          episodes
          chapters
          title { romaji english }
        }
      }
    }
  }
`;

function mapEntry(entry, type) {
  const media = entry.media || {};
  const total = type === "MANGA" ? media.chapters : media.episodes;

  return {
    id: media.id,
    title: media.title?.english || media.title?.romaji || "Unknown",
    url: media.siteUrl || null,
    format: media.format || null,
    progress: entry.progress ?? 0,
    // Null means the run is open-ended (still airing/publishing), which the
    // caller renders as "?" rather than pretending the total is known.
    total: total ?? null,
    score: entry.score || null,
    updatedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000) : null
  };
}

/**
 * One page of a user's list. `status` is required: AniList sorts a mixed list
 * by update time, which reads as noise next to a status-grouped view.
 */
async function fetchMediaList(accessToken, { userId, type = "ANIME", status, page = 1 }) {
  const data = await queryAs(accessToken, LIST_QUERY, {
    userId,
    type,
    status,
    page,
    perPage: PER_PAGE
  });

  return {
    entries: (data?.Page?.mediaList || []).map((entry) => mapEntry(entry, type)),
    page
  };
}

// Counting ids is the only reliable way to size these lists.
// `User.statistics.<type>.statuses` looks like the obvious source, but AniList
// leaves it empty for a large share of accounts (and its `count` disagrees with
// the actual number of entries), while `Page.pageInfo` reports the cap. Asking
// for nothing but ids keeps this small — a 363-entry list is about 6 KB.
const COUNTS_QUERY = `
  query ($userId: Int, $type: MediaType) {
    MediaListCollection(userId: $userId, type: $type) {
      lists {
        status
        isCustomList
        entries { id }
      }
    }
  }
`;

/**
 * How many entries sit under each status, as `{ CURRENT: 10, COMPLETED: 191 }`.
 * Statuses the user has never used are absent rather than zero.
 */
async function fetchListCounts(accessToken, { userId, type = "ANIME" }) {
  const data = await queryAs(accessToken, COUNTS_QUERY, { userId, type });

  const counts = {};
  for (const list of data?.MediaListCollection?.lists || []) {
    // Custom lists repeat entries that are already counted under their status.
    if (list.isCustomList || !list.status) continue;
    counts[list.status] = (counts[list.status] ?? 0) + (list.entries?.length ?? 0);
  }
  return counts;
}

module.exports = {
  PER_PAGE,
  statusLabel,
  statusChoices,
  fetchMediaList,
  fetchListCounts
};
