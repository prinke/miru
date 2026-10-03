// Single entry point for the search commands.
//
// AniList is the primary source: it serves its own database directly, whereas
// Jikan scrapes MyAnimeList and returns a 5xx for every uncached lookup whenever
// MAL is unreachable. Jikan is kept as the fallback so an AniList outage does not
// take the commands down either.
//
// Both clients return results in the same (Jikan-shaped) structure, so the embed
// builders do not care which one answered.

const jikan = require("./jikan");
const anilist = require("./anilist");

// Matched by name rather than instanceof so the check keeps working when either
// client module is swapped out (tests) or loaded through a second module copy.
const CLIENT_ERRORS = new Set(["AniListError", "JikanError"]);

function truncate(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * True when the failure is about reaching the API rather than about the query
 * itself. A 400 or a 404 means the API answered, and the other source would not
 * do better. Anything that is not a client error is a bug worth surfacing.
 */
function isUpstreamFailure(error) {
  if (!CLIENT_ERRORS.has(error?.name)) return false;
  const { status } = error;
  if (status === null || status === undefined) return true; // network / timeout
  return status >= 500 || status === 429;
}

function tagSource(results, source) {
  if (!results) return results;
  for (const result of results) {
    result._source = source;
  }
  return results;
}

async function withFallback(label, primary, fallback) {
  let primaryError = null;

  try {
    const results = await primary();
    // An empty result set is a real answer, not an outage; don't second-guess it.
    return tagSource(results, "anilist");
  } catch (error) {
    if (!isUpstreamFailure(error)) throw error;
    primaryError = error;
  }

  console.warn(
    `AniList ${label} search unavailable (${primaryError.status ?? "network error"}); falling back to Jikan.`
  );

  try {
    return tagSource(await fallback(), "jikan");
  } catch (fallbackError) {
    console.error(`Jikan ${label} fallback also failed:`, fallbackError.message);
    primaryError.fallbackFailed = true;
    throw primaryError;
  }
}

/**
 * Turns a failure into something worth showing a Discord user.
 */
function describeSearchError(error) {
  if (!CLIENT_ERRORS.has(error?.name)) {
    return "Something went wrong while searching. Please try again.";
  }

  if (error.status === 404) {
    return "No results found.";
  }

  if (error.fallbackFailed) {
    return "Both AniList and MyAnimeList (via Jikan) are unreachable right now. Please try again in a few minutes.";
  }

  if (error.status === 429) {
    return "We are being rate limited right now. Please try again in a minute.";
  }

  if (error.status && error.status >= 500) {
    return "The search API is having an outage right now. Please try again in a few minutes.";
  }

  return "Could not reach the search API right now. Please try again shortly.";
}

/**
 * Label for the embed footer, so a result never claims a source it didn't
 * come from.
 */
function sourceLabel(result) {
  return result?._source === "jikan" ? "Jikan API" : "AniList";
}

module.exports = {
  JikanError: jikan.JikanError,
  AniListError: anilist.AniListError,
  truncate,
  describeSearchError,
  sourceLabel,
  searchAnime(query, limit = 10) {
    return withFallback(
      "anime",
      () => anilist.searchAnime(query, limit),
      () => jikan.searchAnime(query, limit)
    );
  },
  searchManga(query, limit = 10) {
    return withFallback(
      "manga",
      () => anilist.searchManga(query, limit),
      () => jikan.searchManga(query, limit)
    );
  },
  searchCharacter(query, limit = 10) {
    return withFallback(
      "character",
      () => anilist.searchCharacter(query, limit),
      () => jikan.searchCharacter(query, limit)
    );
  },
  getCharacterAnime: jikan.getCharacterAnime,
  getCharacterManga: jikan.getCharacterManga,
  getCharacterVoiceActors: jikan.getCharacterVoiceActors
};
