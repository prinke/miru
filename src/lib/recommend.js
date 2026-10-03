// Recommendations from AniList's own "if you liked this, try…" graph, weighted
// by how much each person liked the title the suggestion hangs off.
//
// For one person, or for a group: a group's seeds are pooled, and anything any
// of them has already seen is ruled out, so the result is "things none of you
// has seen that all of you are likely to enjoy".

const anilist = require("./anilist");
const { isSeen, franchiseKey, onePerFranchise } = require("./library");

const SEEDS_PER_QUERY = 25;
const RECOMMENDATIONS_PER_SEED = 10;
const MAX_SEEDS_PER_PERSON = 15;

const RECOMMENDATIONS_QUERY = `
  query ($ids: [Int]) {
    Page(perPage: ${SEEDS_PER_QUERY}) {
      media(id_in: $ids) {
        id
        recommendations(perPage: ${RECOMMENDATIONS_PER_SEED}, sort: RATING_DESC) {
          nodes {
            rating
            mediaRecommendation {
              id
              type
              format
              status
              episodes
              chapters
              genres
              averageScore
              popularity
              isAdult
              siteUrl
              seasonYear
              startDate { year }
              title { romaji english }
              coverImage { large }
            }
          }
        }
      }
    }
  }
`;

/**
 * The titles a person's recommendations grow from, with how much each counts.
 * Scored favourites lead; someone who never scores is read through what they
 * completed instead. Private entries are never seeds, since a seed is named in
 * the "because you liked" line.
 */
function seedsFor(entries) {
  const candidates = entries.filter((entry) => isSeen(entry) && !entry.private && entry.status !== "DROPPED");
  const scored = candidates.filter((entry) => entry.score !== null && entry.score >= 70);

  const seeds = scored.length >= 3
    ? scored
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .map((entry) => ({ entry, weight: Math.max(0.1, (entry.score - 50) / 50) }))
    : candidates
      .filter((entry) => entry.status === "COMPLETED")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ entry, weight: 0.5 }));

  return onePerFranchise(seeds, (seed) => seed.entry.media.title).slice(0, MAX_SEEDS_PER_PERSON);
}

/** Each genre's share of what a group has enjoyed, 0–1. */
function genreTaste(libraries) {
  const totals = new Map();
  let sum = 0;
  for (const entries of libraries) {
    for (const entry of entries) {
      if (!isSeen(entry) || entry.status === "DROPPED") continue;
      const weight = entry.score !== null ? entry.score / 100 : 0.6;
      for (const genre of entry.media.genres) {
        totals.set(genre, (totals.get(genre) ?? 0) + weight);
        sum += weight;
      }
    }
  }
  const peak = Math.max(0, ...totals.values());
  return { share: (genre) => (peak > 0 ? (totals.get(genre) ?? 0) / peak : 0), known: sum > 0 };
}

async function fetchRecommendationGraph(seedIds) {
  const graph = new Map();
  for (let start = 0; start < seedIds.length; start += SEEDS_PER_QUERY) {
    const data = await anilist.query(RECOMMENDATIONS_QUERY, { ids: seedIds.slice(start, start + SEEDS_PER_QUERY) });
    for (const media of data?.Page?.media || []) {
      graph.set(media.id, (media.recommendations?.nodes || []).filter((node) => node?.mediaRecommendation));
    }
  }
  return graph;
}

/**
 * @param {Array<{ name: string, entries: object[] }>} people  one for personal
 *   recommendations, several for a group
 * @param {object} options
 * @param {string} [options.genre]  only recommend titles in this genre
 * @param {number} [options.limit]
 * @returns {Promise<Array<{ media, because: Array<{ title, by: string[] }> }>>}
 */
async function recommend(people, { genre = null, limit = 10 } = {}) {
  // Anything anyone has started is out, and so is the rest of its franchise:
  // "watch season 2 of the thing you watched" is not a discovery.
  const excludedIds = new Set();
  const excludedFranchises = new Set();
  for (const { entries } of people) {
    for (const entry of entries) {
      excludedIds.add(entry.media.id);
      if (isSeen(entry)) excludedFranchises.add(franchiseKey(entry.media.title));
    }
  }

  const seeds = people.flatMap(({ name, entries }) => seedsFor(entries).map((seed) => ({ ...seed, name })));
  if (seeds.length === 0) return [];

  const graph = await fetchRecommendationGraph([...new Set(seeds.map((seed) => seed.entry.media.id))]);
  const taste = genreTaste(people.map((person) => person.entries));

  const candidates = new Map();
  for (const seed of seeds) {
    for (const node of graph.get(seed.entry.media.id) || []) {
      const media = node.mediaRecommendation;
      if (media.isAdult || media.status === "NOT_YET_RELEASED" || node.rating <= 0) continue;
      if (excludedIds.has(media.id) || excludedFranchises.has(franchiseKey(media.title?.english || media.title?.romaji))) continue;
      if (genre && !(media.genres || []).includes(genre)) continue;

      const candidate = candidates.get(media.id) || { media, support: 0, because: new Map() };
      // Community votes on a recommendation run from a handful to thousands;
      // the log keeps one hugely popular link from drowning out several good ones.
      const contribution = seed.weight * Math.log1p(node.rating);
      candidate.support += contribution;

      const seedTitle = seed.entry.media.title;
      const reason = candidate.because.get(seedTitle) || { title: seedTitle, by: new Set(), weight: 0 };
      reason.by.add(seed.name);
      reason.weight += contribution;
      candidate.because.set(seedTitle, reason);
      candidates.set(media.id, candidate);
    }
  }

  const ranked = [...candidates.values()].map((candidate) => {
    const { media } = candidate;
    const quality = Number.isFinite(media.averageScore) ? media.averageScore / 100 : 0.6;
    const genres = media.genres || [];
    const fit = taste.known && genres.length
      ? genres.reduce((sum, name) => sum + taste.share(name), 0) / genres.length
      : 0.5;
    return { ...candidate, rank: candidate.support * (0.5 + quality) * (0.7 + 0.6 * fit) };
  }).sort((a, b) => b.rank - a.rank);

  return onePerFranchise(ranked, (candidate) => candidate.media.title?.english || candidate.media.title?.romaji)
    .slice(0, limit)
    .map((candidate) => ({
      media: {
        id: candidate.media.id,
        type: candidate.media.type,
        format: candidate.media.format,
        episodes: candidate.media.episodes ?? null,
        chapters: candidate.media.chapters ?? null,
        year: candidate.media.seasonYear ?? candidate.media.startDate?.year ?? null,
        genres: candidate.media.genres || [],
        score: Number.isFinite(candidate.media.averageScore) ? candidate.media.averageScore / 10 : null,
        url: candidate.media.siteUrl || null,
        title: candidate.media.title?.english || candidate.media.title?.romaji || "Unknown",
        cover: candidate.media.coverImage?.large || null
      },
      because: [...candidate.because.values()]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 2)
        .map((reason) => ({ title: reason.title, by: [...reason.by] }))
    }));
}

module.exports = { recommend, seedsFor };
