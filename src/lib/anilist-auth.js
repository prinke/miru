// OAuth2 against AniList, using the "auth pin" redirect.
//
// AniList's pin redirect (https://anilist.co/api/v2/oauth/pin) shows the user
// their authorization code on screen instead of posting it to a callback, so
// the bot needs no public web server: the user pastes the code back in a modal.
// The redirect URI must match the one registered at
// https://anilist.co/settings/developer exactly.
//
// Notes from the AniList docs that shape this file:
//   - scopes do not exist; a token is all-or-nothing
//   - tokens are valid for one year and there are no refresh tokens, so an
//     expired link can only be fixed by linking again

const { schedule, cooldown } = require("./anilist");

const AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";
const TOKEN_URL = "https://anilist.co/api/v2/oauth/token";
const GRAPHQL_URL = "https://graphql.anilist.co";
const PIN_REDIRECT_URI = "https://anilist.co/api/v2/oauth/pin";

const REQUEST_TIMEOUT_MS = 10_000;
// Used only when AniList omits expires_in; the documented lifetime is one year.
const DEFAULT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

class AniListAuthError extends Error {
  constructor(message, { reason = "failed", status = null, cause = null } = {}) {
    super(message);
    this.name = "AniListAuthError";
    this.reason = reason;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function config() {
  const clientId = process.env.ANILIST_CLIENT_ID;
  const clientSecret = process.env.ANILIST_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.ANILIST_REDIRECT_URI || PIN_REDIRECT_URI
  };
}

function isConfigured() {
  return config() !== null;
}

function authorizeUrl() {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code"
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new AniListAuthError(
      error.name === "AbortError" ? "AniList did not respond in time." : "Could not reach AniList.",
      { reason: "unreachable", cause: error }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trades the code the user copied off the pin page for an access token.
 */
async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = config();

  const response = await postJson(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.access_token) {
    // A 400 here is almost always a mistyped, reused, or expired code, which is
    // the user's problem to fix; anything else is ours.
    const reason = response.status === 400 || response.status === 401 ? "invalid_code" : "failed";
    throw new AniListAuthError(
      payload?.hint || payload?.message || `Token exchange failed with status ${response.status}.`,
      { reason, status: response.status }
    );
  }

  const lifetimeMs = Number.isFinite(payload.expires_in)
    ? payload.expires_in * 1000
    : DEFAULT_TOKEN_LIFETIME_MS;

  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + lifetimeMs)
  };
}

/**
 * Runs a GraphQL query as a linked user.
 *
 * This deliberately does not go through `anilist.js`: that client caches by
 * query text alone, which would let one user's private data be served to
 * another from cache.
 */
async function queryAs(accessToken, query, variables = {}) {
  // Shares the search client's rate limiter: AniList counts requests per IP,
  // and paging through a list can otherwise fire faster than the budget allows.
  const response = await schedule(() => postJson(
    GRAPHQL_URL,
    { query, variables },
    { Authorization: `Bearer ${accessToken}` }
  ));

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.data) {
    let reason = "failed";
    if (response.status === 400 || response.status === 401) reason = "invalid_token";

    if (response.status === 429) {
      reason = "rate_limited";
      // Report the overage into the shared gate so searches back off too.
      const retryAfter = Number(response.headers.get("retry-after"));
      cooldown(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000, 60_000));
    }
    throw new AniListAuthError(
      payload?.errors?.[0]?.message || `AniList request failed with status ${response.status}.`,
      { reason, status: response.status }
    );
  }

  return payload.data;
}

const VIEWER_QUERY = `
  query {
    Viewer {
      id
      name
      siteUrl
      avatar { large }
      bannerImage
      options { profileColor }
      statistics {
        anime { count }
        manga { count }
      }
    }
  }
`;

/**
 * Confirms the token works and identifies whose account it is. This runs
 * against the same GraphQL endpoint as the search clients but deliberately
 * bypasses their shared cache and rate limiter: the response is per-token and
 * must never be served to another user from cache.
 */
async function fetchViewer(accessToken) {
  const data = await queryAs(accessToken, VIEWER_QUERY);
  const viewer = data?.Viewer;

  if (!viewer) {
    throw new AniListAuthError("AniList did not return an account for that token.", {
      reason: "invalid_token"
    });
  }

  return {
    id: viewer.id,
    name: viewer.name,
    siteUrl: viewer.siteUrl || `https://anilist.co/user/${viewer.name}/`,
    avatar: viewer.avatar?.large || null,
    banner: viewer.bannerImage || null,
    profileColor: viewer.options?.profileColor || null,
    animeCount: viewer.statistics?.anime?.count ?? null,
    mangaCount: viewer.statistics?.manga?.count ?? null
  };
}

module.exports = {
  AniListAuthError,
  PIN_REDIRECT_URI,
  isConfigured,
  authorizeUrl,
  exchangeCode,
  fetchViewer,
  queryAs
};
