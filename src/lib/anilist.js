// AniList is used as a standby for Jikan. Jikan is a scraper in front of
// MyAnimeList, so whenever MAL is unreachable every uncached Jikan lookup comes
// back as a 5xx; AniList has its own database and stays up independently.
//
// Everything here is mapped into the Jikan response shape so the commands and
// their embed builders keep working against a single structure.

const ANILIST_URL = "https://graphql.anilist.co";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// AniList publishes a 90/minute budget but currently serves a degraded 30.
const MIN_REQUEST_INTERVAL_MS = 2_000;

class AniListError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = "AniListError";
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestTime = 0;
let admissionQueue = Promise.resolve();
let cooldownUntil = 0;

async function waitForSlot() {
  for (;;) {
    const now = Date.now();
    const waits = [];

    if (now < cooldownUntil) waits.push(cooldownUntil - now);
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL_MS) {
      waits.push(MIN_REQUEST_INTERVAL_MS - (now - lastRequestTime));
    }

    if (waits.length === 0) {
      lastRequestTime = now;
      return;
    }

    await sleep(Math.max(...waits));
  }
}

/**
 * Holds every caller back for a while after AniList says we are over budget.
 * Exported so the authenticated client can report its own 429s into the same
 * gate — otherwise one path keeps firing while the other is backing off.
 */
function cooldown(ms) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

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

// Whole libraries pass through this cache now, not just search results, so it
// is bounded: expired entries go first, then the oldest.
const MAX_CACHE_ENTRIES = 300;

function writeCache(key, payload) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [cachedKey, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(cachedKey);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

function backoffDelay(attempt, response) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) +
    Math.floor(Math.random() * 250);
}

async function requestAniList(query, variables, { cache: useCache = true } = {}) {
  const cacheKey = JSON.stringify({ query, variables });
  const cached = useCache ? readCache(cacheKey) : null;
  if (cached) return cached;

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response = null;

    try {
      response = await schedule(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          return await fetch(ANILIST_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: JSON.stringify({ query, variables })
          });
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      lastError = new AniListError(
        error.name === "AbortError"
          ? "AniList did not respond in time."
          : "Could not reach AniList.",
        { cause: error }
      );
    }

    if (response) {
      // AniList answers with 200 + an `errors` array for query-level problems,
      // and with a real status code for transport-level ones.
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        lastError = new AniListError("AniList returned a malformed response.", {
          status: response.status,
          cause: error
        });
        payload = null;
      }

      if (response.ok && payload?.data) {
        if (useCache) writeCache(cacheKey, payload.data);
        return payload.data;
      }

      const detail = payload?.errors?.[0]?.message;
      lastError = new AniListError(
        detail || `AniList request failed with status ${response.status}.`,
        { status: response.status }
      );

      // 404 here means "search matched nothing", which is a final answer.
      if (response.status === 404) throw lastError;
      if (response.status === 429) cooldownUntil = Date.now() + backoffDelay(attempt, response);
      if (response.status < 500 && response.status !== 429) throw lastError;
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(backoffDelay(attempt, response));
    }
  }

  throw lastError;
}

/**
 * AniList descriptions carry a mix of HTML and markdown; embeds want plain text.
 */
function toPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/~!([\s\S]*?)!~/g, "||$1||") // AniList spoiler markers -> Discord spoilers
    .replace(/__(.+?)__/g, "**$1**") // AniList bold -> Discord bold
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Birthdays are usually stored without a year, so they are rendered as text
 * rather than pushed through Date parsing.
 */
function formatFuzzyDate(date) {
  if (!date) return null;
  const { year, month, day } = date;
  const monthName = month ? MONTHS[month - 1] : null;

  if (monthName && day) return year ? `${monthName} ${day}, ${year}` : `${monthName} ${day}`;
  if (monthName) return year ? `${monthName} ${year}` : monthName;
  return year ? String(year) : null;
}

/**
 * AniList dates are "fuzzy": any component may be null. The commands feed these
 * into `new Date(...)`, so an incomplete date becomes the start of its period.
 */
function fuzzyDateToIso(date) {
  if (!date?.year) return null;
  const month = date.month || 1;
  const day = date.day || 1;
  return new Date(Date.UTC(date.year, month - 1, day)).toISOString();
}

const ANIME_FORMAT = {
  TV: "TV",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music"
};

const MANGA_FORMAT = {
  MANGA: "Manga",
  NOVEL: "Light Novel",
  ONE_SHOT: "One-shot"
};

const ANIME_STATUS = {
  FINISHED: "Finished Airing",
  RELEASING: "Currently Airing",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "Cancelled",
  HIATUS: "On Hiatus"
};

// Jikan returns this already title-cased ("Light novel"), so the enum is mapped
// to the same wording.
const SOURCE_LABEL = {
  ORIGINAL: "Original",
  MANGA: "Manga",
  LIGHT_NOVEL: "Light novel",
  VISUAL_NOVEL: "Visual novel",
  VIDEO_GAME: "Video game",
  NOVEL: "Novel",
  DOUJINSHI: "Doujinshi",
  ANIME: "Anime",
  WEB_NOVEL: "Web novel",
  LIVE_ACTION: "Live action",
  GAME: "Game",
  COMIC: "Comic",
  MULTIMEDIA_PROJECT: "Multimedia project",
  PICTURE_BOOK: "Picture book",
  OTHER: "Other"
};

const MANGA_STATUS = {
  FINISHED: "Finished",
  RELEASING: "Publishing",
  NOT_YET_RELEASED: "Not yet published",
  CANCELLED: "Cancelled",
  HIATUS: "On Hiatus"
};

function titleOf(title) {
  return title?.romaji || title?.english || title?.native || "Unknown";
}

function imageBlock(url) {
  return url ? { jpg: { image_url: url }, webp: { image_url: url } } : {};
}

/** AniList scores are percentages; Jikan (and the embeds) use a 0-10 scale. */
function toTenPointScore(averageScore) {
  if (!Number.isFinite(averageScore)) return null;
  return Math.round(averageScore) / 10;
}

function allTimeRatedRank(rankings) {
  const ranking = (rankings || []).find((r) => r.type === "RATED" && r.allTime);
  return ranking?.rank ?? null;
}

const MEDIA_FIELDS = `
  id
  idMal
  siteUrl
  format
  status
  episodes
  duration
  chapters
  volumes
  season
  seasonYear
  source(version: 3)
  averageScore
  description(asHtml: false)
  genres
  coverImage { extraLarge large }
  bannerImage
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { episode airingAt }
  rankings { rank type allTime }
  studios(isMain: true) { nodes { name siteUrl } }
  staff(perPage: 4) { edges { role node { name { full } siteUrl } } }
`;

const SEARCH_MEDIA_QUERY = `
  query ($search: String, $type: MediaType, $perPage: Int) {
    Page(perPage: $perPage) {
      media(search: $search, type: $type, sort: SEARCH_MATCH, isAdult: false) {
        title { romaji english native }
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const SEARCH_CHARACTER_QUERY = `
  query ($search: String, $perPage: Int) {
    Page(perPage: $perPage) {
      characters(search: $search, sort: SEARCH_MATCH) {
        id
        siteUrl
        favourites
        name { full native alternative }
        image { large }
        description(asHtml: false)
        age
        gender
        bloodType
        dateOfBirth { year month day }
        media(perPage: 12, sort: POPULARITY_DESC) {
          edges {
            voiceActors(language: JAPANESE) { name { full } siteUrl }
            node { type title { romaji english native } }
          }
        }
      }
    }
  }
`;

function mapAnime(media) {
  return {
    _source: "anilist",
    // `mal_id` below follows the Jikan shape, which means it holds a MAL id and
    // cannot be used to write to AniList. The native id is kept alongside it so
    // list edits do not need a second lookup.
    _anilistId: media.id,
    _banner: media.bannerImage || null,
    // Jikan has no equivalent, so the embed treats a countdown as optional.
    _nextEpisode: media.nextAiringEpisode
      ? {
        episode: media.nextAiringEpisode.episode,
        airingAt: new Date(media.nextAiringEpisode.airingAt * 1000).toISOString()
      }
      : null,
    mal_id: media.idMal ?? media.id,
    url: media.siteUrl || null,
    title: titleOf(media.title),
    title_english: media.title?.english || null,
    synopsis: toPlainText(media.description),
    images: imageBlock(media.coverImage?.extraLarge || media.coverImage?.large),
    type: ANIME_FORMAT[media.format] || media.format || null,
    episodes: media.episodes ?? null,
    // Jikan spells this out as "24 min per ep"; matching it keeps one code path.
    duration: media.duration ? `${media.duration} min per ep` : null,
    season: media.season ? media.season.toLowerCase() : null,
    year: media.seasonYear ?? media.startDate?.year ?? null,
    source: SOURCE_LABEL[media.source] || null,
    score: toTenPointScore(media.averageScore),
    status: ANIME_STATUS[media.status] || media.status || null,
    rank: allTimeRatedRank(media.rankings),
    aired: {
      from: fuzzyDateToIso(media.startDate),
      to: fuzzyDateToIso(media.endDate)
    },
    studios: (media.studios?.nodes || []).map((studio) => ({
      name: studio.name,
      url: studio.siteUrl || null
    })),
    genres: (media.genres || []).map((name) => ({ name }))
  };
}

function mapManga(media) {
  const authors = (media.staff?.edges || [])
    .filter((edge) => /story|art/i.test(edge.role || ""))
    .map((edge) => ({ name: edge.node?.name?.full, url: edge.node?.siteUrl || null }))
    .filter((author) => author.name);

  return {
    _source: "anilist",
    _anilistId: media.id,
    _banner: media.bannerImage || null,
    mal_id: media.idMal ?? media.id,
    url: media.siteUrl || null,
    title: titleOf(media.title),
    title_english: media.title?.english || null,
    synopsis: toPlainText(media.description),
    images: imageBlock(media.coverImage?.extraLarge || media.coverImage?.large),
    type: MANGA_FORMAT[media.format] || media.format || null,
    chapters: media.chapters ?? null,
    volumes: media.volumes ?? null,
    year: media.startDate?.year ?? null,
    score: toTenPointScore(media.averageScore),
    status: MANGA_STATUS[media.status] || media.status || null,
    rank: allTimeRatedRank(media.rankings),
    published: {
      from: fuzzyDateToIso(media.startDate),
      to: fuzzyDateToIso(media.endDate)
    },
    authors,
    genres: (media.genres || []).map((name) => ({ name }))
  };
}

function mapCharacter(character) {
  const edges = character.media?.edges || [];

  // A character's appearances and voice actors arrive with the search result, so
  // unlike the Jikan path these need no follow-up requests.
  const animeInfo = [];
  const mangaInfo = [];
  const seenVoiceActors = new Set();
  const voiceActors = [];

  for (const edge of edges) {
    const title = titleOf(edge.node?.title);
    if (edge.node?.type === "ANIME") {
      animeInfo.push({ anime: { title } });
    } else if (edge.node?.type === "MANGA") {
      mangaInfo.push({ manga: { title } });
    }

    for (const actor of edge.voiceActors || []) {
      const name = actor?.name?.full;
      if (!name || seenVoiceActors.has(name)) continue;
      seenVoiceActors.add(name);
      voiceActors.push({ language: "Japanese", person: { name, url: actor.siteUrl || null } });
    }
  }

  return {
    _source: "anilist",
    mal_id: character.id,
    url: character.siteUrl || null,
    name: character.name?.full || character.name?.native || "Unknown",
    // Jikan calls the same thing `name_kanji`.
    name_kanji: character.name?.native || null,
    nicknames: character.name?.alternative?.filter(Boolean) || [],
    about: toPlainText(character.description),
    images: imageBlock(character.image?.large),
    favorites: character.favourites ?? 0,
    // Age, gender and birthday are structured fields on AniList rather than part
    // of the description, so they have to be carried across separately. Height
    // has no field of its own and is only ever found in the description text.
    details: {
      age: character.age || null,
      gender: character.gender || null,
      bloodType: character.bloodType || null,
      birthday: formatFuzzyDate(character.dateOfBirth)
    },
    animeInfo,
    mangaInfo,
    voiceActors
  };
}

async function searchMedia(type, query, limit, map) {
  const data = await requestAniList(SEARCH_MEDIA_QUERY, {
    search: query,
    type,
    perPage: Math.min(limit, 25)
  });
  const media = data?.Page?.media || [];
  return media.length ? media.map(map) : null;
}

const SEASON_QUERY = `
  query ($season: MediaSeason, $year: Int, $page: Int, $perPage: Int, $sort: [MediaSort], $formats: [MediaFormat]) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total hasNextPage }
      media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, sort: $sort, format_in: $formats) {
        title { romaji english native }
        ${MEDIA_FIELDS}
      }
    }
  }
`;

/**
 * One page of a season's anime, in the same shape as a search result so the
 * `/anime` embed can show any of them.
 */
// Every anime format. AniList answers a null `format_in` with a 500 rather than
// treating it as "no filter", so "all" has to be spelled out.
const ALL_ANIME_FORMATS = Object.keys(ANIME_FORMAT);

async function seasonalAnime({ season, year, sort = "POPULARITY_DESC", formats = ALL_ANIME_FORMATS, page = 1, perPage = 50 }) {
  const data = await requestAniList(SEASON_QUERY, {
    season,
    year,
    page,
    perPage,
    sort: [sort],
    formats
  });

  const hasNextPage = Boolean(data?.Page?.pageInfo?.hasNextPage);
  return {
    results: (data?.Page?.media || []).map(mapAnime),
    // `pageInfo.total` is a capped placeholder (5000) on every page but the
    // last, so it is only passed on once it can be believed.
    total: hasNextPage ? null : data?.Page?.pageInfo?.total ?? null,
    hasNextPage
  };
}

const ID_BY_MAL_QUERY = `
  query ($idMal: Int, $type: MediaType) {
    Media(idMal: $idMal, type: $type) { id }
  }
`;

/**
 * Finds the AniList id for a MyAnimeList id. Needed only for results that came
 * from the Jikan fallback, which knows nothing about AniList's own ids.
 */
async function findIdByMalId(malId, type) {
  const data = await requestAniList(ID_BY_MAL_QUERY, { idMal: malId, type });
  return data?.Media?.id ?? null;
}

const IDS_BY_MAL_QUERY = `
  query ($idMal: [Int], $type: MediaType) {
    Page(perPage: 50) {
      media(idMal_in: $idMal, type: $type) { id idMal }
    }
  }
`;

/**
 * The same translation for a whole page of results at once, as `Map<malId, id>`.
 * Ids with no AniList counterpart are simply absent from the map.
 */
async function findIdsByMalIds(malIds, type) {
  const ids = [...new Set((malIds || []).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();

  const data = await requestAniList(IDS_BY_MAL_QUERY, { idMal: ids, type });
  const found = new Map();
  for (const media of data?.Page?.media || []) {
    if (Number.isFinite(media?.idMal)) found.set(media.idMal, media.id);
  }
  return found;
}

module.exports = {
  AniListError,
  // Unauthenticated queries see only what AniList shows the public, which is
  // exactly what features that post into a shared channel should be built on.
  query: requestAniList,
  findIdByMalId,
  findIdsByMalIds,
  seasonalAnime,
  // AniList's budget is per IP, so every caller in this process — including the
  // authenticated ones in anilist-auth.js — has to queue behind the same gate.
  schedule,
  cooldown,
  searchAnime(query, limit = 10) {
    return searchMedia("ANIME", query, limit, mapAnime);
  },
  searchManga(query, limit = 10) {
    return searchMedia("MANGA", query, limit, mapManga);
  },
  async searchCharacter(query, limit = 10) {
    const data = await requestAniList(SEARCH_CHARACTER_QUERY, {
      search: query,
      perPage: Math.min(limit, 25)
    });
    const characters = data?.Page?.characters || [];
    return characters.length ? characters.map(mapCharacter) : null;
  }
};
