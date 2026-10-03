const JIKAN_BASE_URL = "https://api.jikan.moe/v4";

// Jikan allows 3 requests/second and 60 requests/minute. Bursting all 3 in the
// same instant still trips its 429, so requests are spaced out evenly instead.
const RATE_LIMIT_PER_MINUTE = 60;
const MIN_REQUEST_INTERVAL_MS = 400;

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 5_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// 504/502/503 mean Jikan itself could not reach MyAnimeList; those clear up on
// their own, so they are worth retrying rather than failing the command outright.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class JikanError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = "JikanError";
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const requestTimes = [];
let lastRequestTime = 0;
let admissionQueue = Promise.resolve();

// Pushed forward whenever Jikan hands back a 429, so every caller backs off
// together instead of each one discovering the limit on its own.
let cooldownUntil = 0;

function applyCooldown(ms) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

async function waitForSlot() {
  for (;;) {
    const now = Date.now();
    while (requestTimes.length > 0 && now - requestTimes[0] >= 60_000) {
      requestTimes.shift();
    }

    const waits = [];
    if (now < cooldownUntil) {
      waits.push(cooldownUntil - now);
    }
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL_MS) {
      waits.push(MIN_REQUEST_INTERVAL_MS - (now - lastRequestTime));
    }
    if (requestTimes.length >= RATE_LIMIT_PER_MINUTE) {
      waits.push(60_000 - (now - requestTimes[0]));
    }

    if (waits.length === 0) {
      lastRequestTime = now;
      requestTimes.push(now);
      return;
    }

    await sleep(Math.max(...waits));
  }
}

// Slot acquisition is serialised so parallel callers cannot claim the same slot,
// but the requests themselves are still allowed to overlap once admitted.
function schedule(task) {
  const admitted = admissionQueue.then(waitForSlot);
  admissionQueue = admitted.catch(() => {});
  return admitted.then(task);
}

const cache = new Map();

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeCache(key, payload) {
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

function backoffDelay(attempt, response) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exponential + Math.floor(Math.random() * 250);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJikan(endpoint, searchParams = {}) {
  const url = new URL(`${JIKAN_BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  const cached = readCache(cacheKey);
  if (cached) return cached;

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response = null;

    try {
      response = await schedule(() => fetchWithTimeout(url));
    } catch (error) {
      lastError = new JikanError(
        error.name === "AbortError"
          ? "Jikan did not respond in time."
          : "Could not reach the Jikan API.",
        { cause: error }
      );
    }

    if (response) {
      if (response.ok) {
        const payload = await response.json();
        writeCache(cacheKey, payload);
        return payload;
      }

      lastError = new JikanError(
        `Jikan request failed with status ${response.status}.`,
        { status: response.status }
      );

      if (!RETRYABLE_STATUS.has(response.status)) throw lastError;

      if (response.status === 429) {
        applyCooldown(backoffDelay(attempt, response));
      }
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(backoffDelay(attempt, response));
    }
  }

  throw lastError;
}

async function searchJikan(endpoint, query, limit = 10) {
  const payload = await requestJikan(endpoint, { q: query, limit });
  if (!payload?.data?.length) return null;
  return payload.data;
}

// Supplementary character details: an outage here should degrade the embed
// rather than fail the whole command.
async function fetchCharacterDetail(characterId, resource) {
  try {
    const payload = await requestJikan(`characters/${characterId}/${resource}`);
    return payload?.data || [];
  } catch (error) {
    console.warn(`Jikan: could not load ${resource} for character ${characterId}:`, error.message);
    return [];
  }
}

module.exports = {
  JikanError,
  searchAnime(query, limit = 10) {
    return searchJikan("anime", query, limit);
  },
  searchManga(query, limit = 10) {
    return searchJikan("manga", query, limit);
  },
  searchCharacter(query, limit = 10) {
    return searchJikan("characters", query, limit);
  },
  getCharacterAnime(characterId) {
    return fetchCharacterDetail(characterId, "anime");
  },
  getCharacterManga(characterId) {
    return fetchCharacterDetail(characterId, "manga");
  },
  getCharacterVoiceActors(characterId) {
    return fetchCharacterDetail(characterId, "voices");
  }
};
