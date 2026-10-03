// How alike two people's taste is, from their AniList libraries.
//
// Three signals are blended:
//   - score agreement: do they rate the titles they share the same way? This
//     is the strongest signal, but needs titles both have scored;
//   - genre similarity: do they spend their time on the same kinds of things?
//     Works even for people who never score;
//   - overlap: how much of the smaller list the other has also seen.

const { isSeen, onePerFranchise } = require("./library");

// Below this many co-rated titles a correlation is mostly noise.
const MIN_CORRELATED = 5;
const LOVED = 75;
const RECOMMEND_FROM = 80;
const DISAGREEMENT = 25;

const VERDICTS = [
  [85, "Taste twins"],
  [70, "Great match"],
  [55, "Good match"],
  [40, "Some common ground"],
  [0, "Opposites attract?"]
];

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function pearson(pairs) {
  const n = pairs.length;
  const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / n;
  const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [a, b] of pairs) {
    covariance += (a - meanA) * (b - meanB);
    varianceA += (a - meanA) ** 2;
    varianceB += (b - meanB) ** 2;
  }

  // Someone who gives everything the same score has no ordering to correlate.
  if (varianceA === 0 || varianceB === 0) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

function scoreAgreement(pairs) {
  if (pairs.length === 0) return null;

  const r = pairs.length >= MIN_CORRELATED ? pearson(pairs) : null;
  if (r !== null) return (r + 1) / 2;

  // Too few (or too uniform) to correlate: fall back to how far apart the
  // scores are. Forty points apart on average counts as no agreement at all.
  const meanGap = pairs.reduce((sum, [a, b]) => sum + Math.abs(a - b), 0) / pairs.length;
  return clamp01(1 - meanGap / 40);
}

/** How much each genre features in a library, weighted by how it was received. */
function genreProfile(entries) {
  const profile = new Map();
  for (const entry of entries) {
    if (!isSeen(entry)) continue;
    let weight = entry.score !== null ? entry.score / 100 : 0.7;
    if (entry.status === "DROPPED") weight = 0.2;
    for (const genre of entry.media.genres) {
      profile.set(genre, (profile.get(genre) ?? 0) + weight);
    }
  }
  return profile;
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [genre, value] of a) {
    dot += value * (b.get(genre) ?? 0);
    normA += value ** 2;
  }
  for (const value of b.values()) normB += value ** 2;
  if (normA === 0 || normB === 0) return null;
  return dot / Math.sqrt(normA * normB);
}

function topGenres(profile, count) {
  return [...profile.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([genre]) => genre);
}

/**
 * Titles `from` rated highly that `to` has not seen. Ones already on `to`'s
 * Planning list are kept and flagged: a nudge to finally get to them.
 */
function picks(from, toByMedia, count) {
  const candidates = from
    .filter((entry) => entry.score !== null && entry.score >= RECOMMEND_FROM && !entry.private)
    .filter((entry) => !isSeen(toByMedia.get(entry.media.id)))
    .sort((a, b) => b.score - a.score || b.media.popularity - a.media.popularity);

  return onePerFranchise(candidates, (entry) => entry.media.title)
    .slice(0, count)
    .map((entry) => ({
      media: entry.media,
      score: entry.score,
      planned: toByMedia.get(entry.media.id)?.status === "PLANNING"
    }));
}

function verdictFor(percent) {
  return VERDICTS.find(([threshold]) => percent >= threshold)[1];
}

/**
 * Compares two libraries (as returned by `fetchLibrary`). `percent` is null
 * when there is not enough on either list to say anything.
 */
function compareLibraries(a, b) {
  const byMediaA = new Map(a.map((entry) => [entry.media.id, entry]));
  const byMediaB = new Map(b.map((entry) => [entry.media.id, entry]));

  const shared = [];
  for (const entryA of a) {
    const entryB = byMediaB.get(entryA.media.id);
    if (isSeen(entryA) && isSeen(entryB)) shared.push([entryA, entryB]);
  }

  const scored = shared.filter(([x, y]) => x.score !== null && y.score !== null);
  const agreement = scoreAgreement(scored.map(([x, y]) => [x.score, y.score]));

  const profileA = genreProfile(a);
  const profileB = genreProfile(b);
  const similarity = cosine(profileA, profileB);
  // Most anime fans' genre mixes look alike (Action, Comedy, Drama...), so raw
  // cosine sits near 0.8 for almost any pair. Stretching 0.6–1.0 over the full
  // range makes the differences that do exist visible.
  const genreAffinity = similarity === null ? null : clamp01((similarity - 0.6) / 0.4);

  const seenA = a.filter(isSeen).length;
  const seenB = b.filter(isSeen).length;
  const overlap = Math.min(seenA, seenB) > 0 ? shared.length / Math.min(seenA, seenB) : 0;

  let percent = null;
  if (genreAffinity !== null) {
    const blended = agreement !== null
      ? 0.55 * agreement + 0.3 * genreAffinity + 0.15 * overlap
      : 0.75 * genreAffinity + 0.25 * overlap;
    percent = Math.round(clamp01(blended) * 100);
  }

  const visible = ([x, y]) => !x.private && !y.private;

  return {
    percent,
    verdict: percent === null ? null : verdictFor(percent),
    sharedCount: shared.length,
    scoredCount: scored.length,
    commonGenres: topGenres(profileA, 6).filter((genre) => topGenres(profileB, 6).includes(genre)).slice(0, 3),
    lovedBoth: onePerFranchise(
      scored
        .filter(visible)
        .filter(([x, y]) => x.score >= LOVED && y.score >= LOVED)
        .sort(([x1, y1], [x2, y2]) => Math.min(x2.score, y2.score) - Math.min(x1.score, y1.score)),
      ([x]) => x.media.title
    )
      .slice(0, 5)
      .map(([x, y]) => ({ media: x.media, scoreA: x.score, scoreB: y.score })),
    disagreements: scored
      .filter(visible)
      .filter(([x, y]) => Math.abs(x.score - y.score) >= DISAGREEMENT)
      .sort(([x1, y1], [x2, y2]) => Math.abs(x2.score - y2.score) - Math.abs(x1.score - y1.score))
      .slice(0, 3)
      .map(([x, y]) => ({ media: x.media, scoreA: x.score, scoreB: y.score })),
    picksForA: picks(b, byMediaA, 3),
    picksForB: picks(a, byMediaB, 3)
  };
}

module.exports = { compareLibraries };
