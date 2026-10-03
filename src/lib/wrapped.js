// A year in review, computed from a user's anime and manga libraries.
//
// AniList keeps no per-day watch history that is cheap to read, so the year is
// reconstructed from list dates: a title counts towards a year when it was
// started or finished in it. Time spent is then progress × episode length,
// which overcounts a show started the year before and finished in this one —
// the card says "≈" for that reason.

const { getCollection } = require("./db");

const MIN_HOT_TAKE_GAP = 15; // points out of 100
const MIN_GLOBAL_SAMPLE = 5;
const MIN_SERVER_SAMPLE = 3;

function yearOf(fuzzyDate) {
  return fuzzyDate?.year ?? null;
}

/**
 * When the entry was finished, falling back to its last update for a
 * completed entry with no date (AniList only fills the date in automatically
 * for changes made on its own site).
 */
function completionYear(entry) {
  if (yearOf(entry.completedAt)) return yearOf(entry.completedAt);
  if (entry.status === "COMPLETED" && entry.updatedAt) return entry.updatedAt.getUTCFullYear();
  return null;
}

function belongsToYear(entry, year) {
  if (entry.status === "PLANNING") return false;
  if (yearOf(entry.startedAt) === year || completionYear(entry) === year) return true;
  // Still watching with no dates at all: an update this year is the best sign.
  return !entry.startedAt && !entry.completedAt &&
    ["CURRENT", "REPEATING", "PAUSED"].includes(entry.status) &&
    entry.updatedAt?.getUTCFullYear() === year;
}

function countBy(items, keysOf, weightOf = () => 1) {
  const counts = new Map();
  for (const item of items) {
    for (const key of keysOf(item)) counts.set(key, (counts.get(key) ?? 0) + weightOf(item));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * @param {{ anime: object[], manga: object[] }} libraries  from `fetchLibrary`
 * @param {number} year
 */
function computeWrapped({ anime, manga }, year) {
  const animeInYear = anime.filter((entry) => belongsToYear(entry, year));
  const mangaInYear = manga.filter((entry) => belongsToYear(entry, year));
  const all = [...animeInYear, ...mangaInYear];
  // Anything shown by name on a card that gets posted publicly has to be
  // something the user has not hidden on AniList.
  const visible = all.filter((entry) => !entry.private);
  const scored = visible.filter((entry) => entry.score !== null);

  const episodes = animeInYear.reduce((sum, entry) => sum + entry.progress, 0);
  const minutes = animeInYear.reduce((sum, entry) => sum + entry.progress * (entry.media.duration ?? 24), 0);
  const chapters = mangaInYear.reduce((sum, entry) => sum + entry.progress, 0);
  const completed = all.filter((entry) => completionYear(entry) === year).length;

  const favourites = [...scored].sort((a, b) =>
    b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const hotTake = scored
    .filter((entry) => Number.isFinite(entry.media.averageScore))
    .map((entry) => ({ entry, gap: entry.score - entry.media.averageScore }))
    .filter(({ gap }) => Math.abs(gap) >= MIN_HOT_TAKE_GAP)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0] || null;

  const finishedMonths = countBy(
    all.filter((entry) => yearOf(entry.completedAt) === year && entry.completedAt.month),
    (entry) => [entry.completedAt.month]
  );

  return {
    year,
    animeCount: animeInYear.length,
    mangaCount: mangaInYear.length,
    episodes,
    minutes,
    hours: Math.round(minutes / 60),
    chapters,
    completed,
    meanScore: scored.length
      ? Math.round(scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length) / 10
      : null,
    topGenres: countBy(all, (entry) => entry.media.genres, (entry) => (entry.score ?? 70) / 100)
      .slice(0, 3)
      .map(([genre]) => genre),
    topStudio: countBy(animeInYear, (entry) => entry.media.studios.slice(0, 1))[0]?.[0] ?? null,
    busiestMonth: finishedMonths[0] && finishedMonths[0][1] >= 2 ? MONTHS[finishedMonths[0][0] - 1] : null,
    favourite: favourites[0] || null,
    // The cover strip prefers favourites, then fills up with whatever else
    // the year held, so an unscored list still gets a strip.
    covers: [...favourites, ...visible.filter((entry) => entry.score === null)]
      .map((entry) => entry.media.cover)
      .filter(Boolean)
      .slice(0, 5),
    hotTake: hotTake && {
      title: hotTake.entry.media.title,
      score: hotTake.entry.score / 10,
      average: hotTake.entry.media.averageScore / 10
    }
  };
}

function wrappedCollection() {
  return getCollection("wrapped");
}

async function ensureIndexes() {
  // Ranking counts everyone ahead of a user in a year, overall and per server.
  await wrappedCollection().createIndex({ year: 1, effort: -1 }, { name: "year_effort" });
  await wrappedCollection().createIndex({ servers: 1, year: 1, effort: -1 }, { name: "server_year_effort" });
}

/**
 * Stores this year's total so others can be ranked against it, and returns the
 * user's standing: `{ global, server }`, each `{ topPercent, rank, of }` or
 * null when too few people have run it to make the comparison mean anything.
 */
async function recordAndRank({ discordId, year, minutes, chapters, servers, guildId }) {
  const now = new Date();
  // Time spent on manga is not tracked, so a chapter is counted as five
  // minutes to let manga readers rank too.
  const effort = minutes + chapters * 5;

  await wrappedCollection().updateOne(
    { _id: `${discordId}:${year}` },
    { $set: { discordId, year, effort, servers, updatedAt: now } },
    { upsert: true }
  );

  async function standing(filter, minimum) {
    const [of, ahead] = await Promise.all([
      wrappedCollection().countDocuments({ year, ...filter }),
      wrappedCollection().countDocuments({ year, ...filter, effort: { $gt: effort } })
    ]);
    if (of < minimum) return null;
    return { rank: ahead + 1, of, topPercent: Math.max(1, Math.ceil(((ahead + 1) / of) * 100)) };
  }

  return {
    global: await standing({}, MIN_GLOBAL_SAMPLE),
    server: guildId && servers.includes(guildId) ? await standing({ servers: guildId }, MIN_SERVER_SAMPLE) : null
  };
}

module.exports = { ensureIndexes, computeWrapped, recordAndRank };
