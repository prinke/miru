// One place for the user-facing wording of an AniList failure, so every command
// explains the same problem the same way.

/**
 * @param {Error} error   the failure, usually an AniListAuthError
 * @param {string} action what the bot was doing, e.g. "reading your list"
 */
function describeAniListError(error, action = "talking to AniList") {
  const fallback = `Something went wrong while ${action}. Please try again.`;
  if (error?.name !== "AniListAuthError" && error?.name !== "AniListError") return fallback;

  switch (error.reason) {
    case "invalid_token":
      return "Your AniList link is no longer valid. Run `/link` to reconnect your account.";
    case "rate_limited":
      return "AniList is rate limiting us right now. Please try again in a minute.";
    case "unreachable":
      return "Could not reach AniList right now. Please try again in a few minutes.";
    default:
      break;
  }

  // AniListError (the unauthenticated client) reports status codes rather than
  // reasons.
  if (error.status === 429) return "AniList is rate limiting us right now. Please try again in a minute.";
  if (error.status >= 500) return "AniList is having an outage right now. Please try again in a few minutes.";
  return fallback;
}

module.exports = { describeAniListError };
