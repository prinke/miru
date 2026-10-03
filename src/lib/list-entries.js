// Reading and writing single entries on a linked user's AniList list.
//
// The search buttons, `/progress` and the episode alert buttons all change the
// same few things (status, progress, score), and the rules for doing that —
// never move progress backwards, finish a show when its last episode is logged,
// put a planned show into Watching when an episode is — live here so the three
// paths cannot disagree about them.

const { queryAs } = require("./anilist-auth");

const ENTRY_FIELDS = `
  id
  mediaId
  status
  progress
  repeat
  score(format: POINT_10_DECIMAL)
  media {
    id
    type
    status
    episodes
    chapters
    siteUrl
    title { romaji english }
    coverImage { large }
  }
`;

const ENTRIES_QUERY = `
  query ($userId: Int, $mediaIds: [Int]) {
    Page(perPage: 50) {
      mediaList(userId: $userId, mediaId_in: $mediaIds) { ${ENTRY_FIELDS} }
    }
  }
`;

const DELETE_MUTATION = `
  mutation ($id: Int) {
    DeleteMediaListEntry(id: $id) { deleted }
  }
`;

// SaveMediaListEntry treats an omitted argument as "leave it alone", so the
// mutation is assembled from only the fields being changed rather than sending
// nulls that AniList might read as "clear this".
const SAVE_ARGUMENTS = {
  status: "MediaListStatus",
  progress: "Int",
  repeat: "Int",
  scoreRaw: "Int"
};

function saveMutation(keys) {
  const declarations = keys.map((key) => `$${key}: ${SAVE_ARGUMENTS[key]}`).join(", ");
  const assignments = keys.map((key) => `${key}: $${key}`).join(", ");
  return `
    mutation ($mediaId: Int, ${declarations}) {
      SaveMediaListEntry(mediaId: $mediaId, ${assignments}) { ${ENTRY_FIELDS} }
    }
  `;
}

/** Episodes for anime, chapters for manga; null while the run is open-ended. */
function totalOf(media) {
  const total = media?.type === "MANGA" ? media?.chapters : media?.episodes;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function mapEntry(entry) {
  if (!entry) return null;
  const media = entry.media || {};

  return {
    entryId: entry.id,
    mediaId: entry.mediaId ?? media.id,
    type: media.type || null,
    status: entry.status,
    progress: entry.progress ?? 0,
    repeat: entry.repeat ?? 0,
    score: entry.score || null,
    total: totalOf(media),
    title: media.title?.english || media.title?.romaji || "Unknown",
    url: media.siteUrl || null,
    cover: media.coverImage?.large || null
  };
}

/** `Map<mediaId, entry>` for whichever of `mediaIds` are on the user's list. */
async function fetchEntries(accessToken, { userId, mediaIds }) {
  const ids = [...new Set((mediaIds || []).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();

  const data = await queryAs(accessToken, ENTRIES_QUERY, { userId, mediaIds: ids });

  const entries = new Map();
  for (const raw of data?.Page?.mediaList || []) {
    const entry = mapEntry(raw);
    if (Number.isFinite(entry?.mediaId)) entries.set(entry.mediaId, entry);
  }
  return entries;
}

async function fetchEntry(accessToken, { userId, mediaId }) {
  const entries = await fetchEntries(accessToken, { userId, mediaIds: [mediaId] });
  return entries.get(mediaId) ?? null;
}

async function saveEntry(accessToken, mediaId, changes) {
  const keys = Object.keys(SAVE_ARGUMENTS).filter((key) => changes[key] !== undefined);
  const data = await queryAs(accessToken, saveMutation(keys), { mediaId, ...changes });
  return mapEntry(data?.SaveMediaListEntry);
}

function saveStatus(accessToken, { mediaId, status }) {
  return saveEntry(accessToken, mediaId, { status });
}

/**
 * Scores are written through `scoreRaw` (always out of 100) so the caller can
 * think in tens regardless of which scoring system the user picked on AniList.
 */
function saveScore(accessToken, { mediaId, score }) {
  return saveEntry(accessToken, mediaId, { scoreRaw: Math.round(score * 10) });
}

async function deleteEntry(accessToken, entryId) {
  await queryAs(accessToken, DELETE_MUTATION, { id: entryId });
}

// Statuses that logging an episode moves into Watching.
const RESUMABLE = new Set(["PLANNING", "PAUSED", "DROPPED"]);

/**
 * Works out what logging progress `to` does to an entry, without saving it.
 * Returns null when nothing would change.
 *
 * Progress only moves forward unless `rewind` is set: an alert button pressed
 * late must not undo episodes watched since, but a user typing an episode
 * number is correcting it on purpose.
 */
function planProgress(entry, { to, total, rewind = false }) {
  const knownTotal = total ?? entry?.total ?? null;
  const target = knownTotal ? Math.min(to, knownTotal) : to;
  const current = entry?.progress ?? 0;

  if (target < 0) return null;
  if (entry && !RESUMABLE.has(entry.status)) {
    if (target === current) return null;
    if (target < current && !rewind) return null;
  }

  const changes = { progress: target };
  const finished = knownTotal !== null && target >= knownTotal;

  if (finished) {
    changes.status = "COMPLETED";
    // Finishing a rewatch is one more completed run, not a first completion.
    if (entry?.status === "REPEATING") changes.repeat = (entry.repeat ?? 0) + 1;
  } else if (entry?.status !== "REPEATING") {
    // Logging an episode of something planned, paused or dropped means the
    // user is watching it again.
    changes.status = "CURRENT";
  }

  return { changes, finished };
}

/**
 * Logs progress up to `to` (or one past the current progress when omitted).
 * Resolves to `{ entry, finished, unchanged }`.
 */
async function logProgress(accessToken, { mediaId, entry, to, total, rewind = false }) {
  const target = to ?? (entry?.progress ?? 0) + 1;
  const plan = planProgress(entry, { to: target, total, rewind });
  if (!plan) return { entry, finished: false, unchanged: true };

  const saved = await saveEntry(accessToken, mediaId, plan.changes);
  return { entry: saved, finished: plan.finished, unchanged: false };
}

module.exports = {
  totalOf,
  fetchEntries,
  fetchEntry,
  saveStatus,
  saveScore,
  deleteEntry,
  planProgress,
  logProgress
};
