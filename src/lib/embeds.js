// Presentation helpers shared by the search commands.
//
// The guiding rule for every embed built on top of these: a value that is
// unknown is left out entirely. A grid of "Unknown" and "N/A" cells carries no
// information and costs the same vertical space as a real one, so fields are
// assembled from whatever the source actually returned.

const SEPARATOR = " · "; // middle dot, reads lighter than a bullet

/** Base accents, used when the entry's status doesn't imply a colour. */
const ACCENT = {
  anime: 0x3498db,
  manga: 0xe67e22,
  character: 0x9b59b6,
  anilist: 0x02a9ff // AniList's own brand blue, for account-linking replies
};

// Airing/publishing state is the one attribute worth reading before any text,
// so it drives the accent stripe. Both sources' wordings are matched loosely
// because Jikan and AniList label the same states differently.
const STATUS_ACCENT = [
  [/airing|releasing|publishing/i, 0x43b581], // green: running now
  [/not yet/i, 0x95a5a6], // grey: unreleased
  [/hiatus/i, 0xf1c40f], // amber: paused
  [/cancel/i, 0xed4245] // red: dead
];

function accentFor(status, base) {
  if (status) {
    // "Finished Airing" also matches /airing/, so it is excluded up front.
    const finished = /finished|complete/i.test(status);
    if (!finished) {
      for (const [pattern, colour] of STATUS_ACCENT) {
        if (pattern.test(status)) return colour;
      }
    }
  }
  return base;
}

function joinDot(parts) {
  return parts.filter(Boolean).join(SEPARATOR);
}

function joinLines(parts) {
  return parts.filter(Boolean).join("\n");
}

/** Blank line between blocks, so the header lines don't run into the prose. */
function joinParagraphs(parts) {
  return parts.filter(Boolean).join("\n\n");
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : null;
}

/** "1 episode" / "24 episodes", with the unit only written once. */
function countLabel(value, singular, plural = `${singular}s`) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const count = Number(value);
  return `${count} ${count === 1 ? singular : plural}`;
}

function clamp(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

// A synopsis is followed by bookkeeping the embed has no use for: an
// attribution the title link already covers, and AniList's trailing "Notes:"
// list of awards and airing trivia. The blurb ends where that block starts.
const METADATA_MARKERS = [
  /\(Source:[^)]*\)/i,
  /\(Adapted from:?[^)]*\)/i,
  /\[Written by[^\]]*\]/i,
  /^\s*Note(s)?:/im
];

function stripMetadata(text) {
  let cut = text.length;

  for (const marker of METADATA_MARKERS) {
    const match = text.match(marker);
    // An index of 0 would leave nothing behind, so a description that opens
    // with one of these is kept as-is rather than emptied.
    if (match && match.index > 0) cut = Math.min(cut, match.index);
  }

  return text.slice(0, cut).trim();
}

/**
 * Trims a synopsis to a readable blurb, preferring to end on a sentence so the
 * text does not stop mid-thought.
 */
function summarize(text, maxLength = 480) {
  const cleaned = stripMetadata(String(text || ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= maxLength) return cleaned;

  const slice = cleaned.slice(0, maxLength);
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  );

  // Only honour a sentence break that keeps most of the budget; otherwise the
  // blurb would end up much shorter than it needs to be.
  if (sentenceEnd > maxLength * 0.55) return slice.slice(0, sentenceEnd + 1);

  const wordEnd = slice.lastIndexOf(" ");
  return `${slice.slice(0, wordEnd > 0 ? wordEnd : maxLength).trimEnd()}…`;
}

/**
 * The embed author line for a credit list (studios, authors). Every name is
 * shown, but only the first can carry the link — an embed author has room for
 * exactly one URL.
 *
 * Returns null when there is nothing to credit, which `setAuthor` accepts as
 * "leave it off".
 */
function credit(entries) {
  const named = (entries || []).filter((entry) => entry?.name);
  if (named.length === 0) return null;

  return {
    name: clamp(named.map((entry) => entry.name).join(", "), 256),
    url: named[0].url || undefined
  };
}

/** Inline code renders as a tinted pill, which keeps tag lists from reading as prose. */
function chips(values, max = 6) {
  const items = (values || []).filter(Boolean);
  if (items.length === 0) return null;

  const shown = items.slice(0, max).map((value) => `\`${value}\``).join(" ");
  const hidden = items.length - max;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

/**
 * A vertical list for the narrow inline columns: entries are kept short so a
 * single title cannot wrap into three lines and knock the row out of alignment.
 */
function stackedList(values, { max = 5, width = 30 } = {}) {
  const items = (values || []).filter(Boolean);
  if (items.length === 0) return null;

  const lines = items.slice(0, max).map((value) => clamp(value, width));
  const hidden = items.length - max;
  if (hidden > 0) lines.push(`*+${hidden} more*`);
  return lines.join("\n");
}

function timestamp(iso, style = "d") {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return `<t:${Math.floor(time / 1000)}:${style}>`;
}

/**
 * Discord timestamps render in each viewer's own locale and timezone, so dates
 * are handed over as timestamps rather than pre-formatted strings.
 */
function dateRange(from, to, { ongoingLabel = "ongoing" } = {}) {
  const start = timestamp(from);
  if (!start) return null;

  const end = timestamp(to);
  if (end) return start === end ? start : `${start} → ${end}`;
  return `${start} → *${ongoingLabel}*`;
}

/** Jikan carries a `year` for anime but not for manga, which only has a start date. */
function startYear(year, iso) {
  if (Number.isFinite(Number(year)) && Number(year) > 0) return String(year);
  const time = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(time) ? String(new Date(time).getUTCFullYear()) : null;
}

const SEASONS = { winter: "Winter", spring: "Spring", summer: "Summer", fall: "Fall" };

function seasonLabel(season, year) {
  const name = season ? SEASONS[String(season).toLowerCase()] : null;
  if (name && year) return `${name} ${year}`;
  return name || (year ? String(year) : null);
}

/** Jikan writes "24 min per ep"; the shorter form fits an inline column. */
function shortDuration(duration) {
  if (!duration) return null;
  return String(duration)
    .replace(/\s*per\s*ep(isode)?/i, "/ep")
    .replace(/minutes?/i, "min")
    .trim();
}

/**
 * `bold` is opt-in because select menu descriptions render markdown literally,
 * and the same label is reused there.
 */
function scoreLabel(score, { bold = false } = {}) {
  if (!Number.isFinite(Number(score)) || Number(score) <= 0) return null;
  return bold ? `★ **${score}**` : `★ ${score}`;
}

function rankLabel(rank) {
  return Number.isFinite(Number(rank)) && Number(rank) > 0 ? `#${rank}` : null;
}

/** Drops fields whose value came back empty, so callers can build them unconditionally. */
function fields(candidates) {
  return candidates
    .filter((field) => field && field.value)
    .map((field) => ({ ...field, value: clamp(field.value, 1024) }));
}

function paginationFooter(parts) {
  return { text: joinDot(parts) };
}

module.exports = {
  ACCENT,
  accentFor,
  joinDot,
  joinLines,
  joinParagraphs,
  formatNumber,
  countLabel,
  clamp,
  summarize,
  credit,
  chips,
  stackedList,
  timestamp,
  dateRange,
  startYear,
  seasonLabel,
  shortDuration,
  scoreLabel,
  rankLabel,
  fields,
  paginationFooter
};
