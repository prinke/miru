// Scene search through trace.moe: "which anime, episode and moment is this
// screenshot from?"
//
// trace.moe is generous but small. Without a key it allows one search at a time
// and 100 searches a month per IP, so searches are queued, identical images are
// answered from cache, and the remaining quota is reported back so the embed
// can say when it is running low. A key (TRACE_MOE_API_KEY) raises both limits.

const SEARCH_URL = "https://api.trace.moe/search";
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

class TraceMoeError extends Error {
  constructor(message, { reason = "failed", status = null } = {}) {
    super(message);
    this.name = "TraceMoeError";
    this.reason = reason;
    this.status = status;
  }
}

// One search in flight at a time, matching the free tier's concurrency of 1.
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const cache = new Map();

function readCache(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Discord's CDN signs attachment URLs with expiry parameters that change every
 * time the message is fetched, so the cache keys on the URL without them.
 */
function cacheKey(url) {
  try {
    const parsed = new URL(url);
    if (/(^|\.)discordapp\.(com|net)$/.test(parsed.hostname)) return `${parsed.origin}${parsed.pathname}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

function titleOf(anilist) {
  return anilist?.title?.english || anilist?.title?.romaji || anilist?.title?.native || "Unknown";
}

/**
 * The same scene is usually matched several times, once per release of the
 * episode (BD, TV broadcast, ...). Only the best match per anime is kept.
 */
function bestPerAnime(results) {
  const best = new Map();
  for (const result of results) {
    const id = result.anilist?.id;
    if (!id) continue;
    if (!best.has(id) || best.get(id).similarity < result.similarity) best.set(id, result);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

function mapMatch(result) {
  const anilist = result.anilist;
  return {
    anilistId: anilist.id,
    malId: anilist.idMal ?? null,
    title: titleOf(anilist),
    nativeTitle: anilist.title?.native || null,
    url: anilist.siteUrl || `https://anilist.co/anime/${anilist.id}`,
    isAdult: Boolean(anilist.isAdult),
    format: anilist.format || null,
    year: anilist.seasonYear ?? anilist.startDate?.year ?? null,
    episodes: anilist.episodes ?? null,
    cover: anilist.coverImage?.large || anilist.coverImage?.medium || null,
    color: anilist.coverImage?.color || null,
    // Movies have no episode number; trace.moe sends null or a string then.
    episode: Number.isFinite(result.episode) ? result.episode : null,
    at: result.at ?? result.from ?? null,
    similarity: result.similarity,
    image: result.image || null,
    video: result.video || null
  };
}

/**
 * Searches for the scene in the image at `url`.
 * Resolves to `{ matches, quotaLeft }`, best match first.
 */
async function searchScene(url) {
  const key = cacheKey(url);
  const cached = readCache(key);
  if (cached) return cached;

  return enqueue(async () => {
    // Another search for the same image may have finished while this one waited.
    const raced = readCache(key);
    if (raced) return raced;

    const params = new URLSearchParams({ url });
    // Flags: include AniList details in the result, and ignore black bars
    // around the frame (common in screenshots of letterboxed video).
    const requestUrl = `${SEARCH_URL}?anilistInfo&cutBorders&${params}`;
    const headers = { Accept: "application/json" };
    if (process.env.TRACE_MOE_API_KEY) headers["x-trace-key"] = process.env.TRACE_MOE_API_KEY;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response = null;
    try {
      response = await fetch(requestUrl, { headers, signal: controller.signal });
    } catch (error) {
      throw new TraceMoeError(
        error.name === "AbortError" ? "trace.moe did not respond in time." : "Could not reach trace.moe.",
        { reason: "unreachable" }
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.error) {
      // 402: out of quota (or over the concurrency limit); 429: rate limited;
      // 400: the URL was not an image it could read.
      const reason = { 400: "bad_image", 402: "quota", 429: "rate_limited" }[response.status] || "failed";
      throw new TraceMoeError(payload?.error || `trace.moe failed with status ${response.status}.`, {
        reason,
        status: response.status
      });
    }

    const value = {
      matches: bestPerAnime(payload?.result || []).map(mapMatch),
      quotaLeft: Number.isFinite(payload?.quota) && Number.isFinite(payload?.quotaUsed)
        ? payload.quota - payload.quotaUsed
        : null
    };
    writeCache(key, value);
    return value;
  });
}

function describeTraceError(error) {
  switch (error?.reason) {
    case "bad_image":
      return "trace.moe could not read that image. Try a screenshot (PNG/JPG), GIF or short video clip.";
    case "quota":
      return "The scene search quota is used up for now. Please try again later.";
    case "rate_limited":
      return "Too many scene searches at once. Please try again in a minute.";
    case "unreachable":
      return "Could not reach trace.moe right now. Please try again in a few minutes.";
    default:
      return "Something went wrong while searching for that scene. Please try again.";
  }
}

module.exports = { TraceMoeError, searchScene, describeTraceError };
