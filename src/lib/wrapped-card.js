// Draws the /wrapped card: a portrait PNG sized for phones, since that is where
// these get screenshotted and shared from.

const path = require("node:path");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

const WIDTH = 1080;
const HEIGHT = 1350;
const PAD = 72;
const IMAGE_TIMEOUT_MS = 5_000;

// Bundled rather than left to the system so the card looks the same on a bare
// server image with no fonts installed.
const FONT_DIR = path.dirname(require.resolve("@fontsource/inter/package.json"));
const FONT_SUBSETS = ["latin", "latin-ext", "greek", "cyrillic", "vietnamese"];
for (const subset of FONT_SUBSETS) {
  for (const weight of [400, 700, 800]) {
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "files", `inter-${subset}-${weight}-normal.woff2`), "Inter");
  }
}
const FONT = "Inter, sans-serif";

// What the bundled subsets above can draw. Anything else (kana, kanji, ★ in a
// title) would come out as a "missing glyph" box, so it is dropped instead.
const DRAWABLE = /[\u0000-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF\u2000-\u206F\u20AC\u2122\u2212]/u;

function drawable(text) {
  return [...String(text)].filter((char) => DRAWABLE.test(char)).join("").replace(/\s{2,}/g, " ").trim();
}

// AniList's named profile colours, as its own site renders them.
const PROFILE_COLOURS = {
  blue: "#3db4f2",
  purple: "#c063ff",
  pink: "#fc9dd6",
  orange: "#ef881a",
  red: "#e13333",
  green: "#4cca51",
  gray: "#677b94"
};

function accentOf(profileColor) {
  if (!profileColor) return PROFILE_COLOURS.blue;
  if (/^#[0-9a-f]{6}$/i.test(profileColor)) return profileColor;
  return PROFILE_COLOURS[profileColor] || PROFILE_COLOURS.blue;
}

function mix(hex, amount, toward = 0) {
  const channel = (offset) => parseInt(hex.slice(offset, offset + 2), 16);
  const blend = (value) => Math.round(value + (toward - value) * amount);
  return `rgb(${blend(channel(1))}, ${blend(channel(3))}, ${blend(channel(5))})`;
}

async function fetchImage(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    // A missing picture leaves a gap on the card rather than failing it.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/**
 * Makes `text` safe to draw and shortens it with an ellipsis until it fits
 * `maxWidth` in the current font.
 */
function fit(ctx, rawText, maxWidth) {
  const text = drawable(rawText);
  if (ctx.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened.trimEnd()}…`;
}

/** Draws an image scaled to cover the box, cropping the overflow (CSS `object-fit: cover`). */
function drawCover(ctx, image, x, y, width, height, radius) {
  ctx.save();
  roundedRect(ctx, x, y, width, height, radius);
  ctx.clip();
  if (image) {
    const scale = Math.max(width / image.width, height / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(x, y, width, height);
  }
  ctx.restore();
}

/** A five-pointed star, drawn as a shape because the bundled font has no ★. */
function star(ctx, cx, cy, radius, colour) {
  ctx.beginPath();
  for (let point = 0; point < 10; point += 1) {
    const r = point % 2 === 0 ? radius : radius * 0.45;
    const angle = (Math.PI / 5) * point - Math.PI / 2;
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

function label(ctx, text, x, y, colour = "rgba(255,255,255,0.6)") {
  ctx.font = `700 22px ${FONT}`;
  ctx.fillStyle = colour;
  ctx.fillText(text.toUpperCase(), x, y);
}

function tile(ctx, { x, y, width, height, title, value, accent, starred = false }) {
  roundedRect(ctx, x, y, width, height, 24);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fill();

  label(ctx, title, x + 28, y + 46);
  let textX = x + 28;
  if (starred) {
    star(ctx, textX + 20, y + 94, 22, accent);
    textX += 54;
  }
  ctx.font = `800 52px ${FONT}`;
  ctx.fillStyle = accent;
  ctx.fillText(fit(ctx, value, width - (textX - x) - 28), textX, y + 112);
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

/**
 * @param {object} options
 * @param {{ name: string, avatar: string|null, color: string|null }} options.user
 * @param {object} options.stats     from `computeWrapped`
 * @param {object} options.standing  from `recordAndRank`
 * @param {string|null} options.serverName
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderWrappedCard({ user, stats, standing, serverName }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const accent = accentOf(user.color);

  const [avatar, favouriteCover, ...covers] = await Promise.all([
    fetchImage(user.avatar),
    fetchImage(stats.favourite?.media.cover),
    ...stats.covers.map(fetchImage)
  ]);

  // Background: near-black tinted with the user's AniList colour, with a glow
  // of the colour itself behind the headline number.
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, mix(accent, 0.82));
  background.addColorStop(1, mix(accent, 0.94));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(WIDTH * 0.85, 260, 20, WIDTH * 0.85, 260, 560);
  glow.addColorStop(0, mix(accent, 0.35));
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.globalAlpha = 1;

  // Header: avatar, name, year.
  const avatarSize = 96;
  ctx.save();
  ctx.beginPath();
  ctx.arc(PAD + avatarSize / 2, PAD + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, PAD, PAD, avatarSize, avatarSize);
  else {
    ctx.fillStyle = accent;
    ctx.fillRect(PAD, PAD, avatarSize, avatarSize);
  }
  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText(fit(ctx, user.name, WIDTH - PAD * 2 - avatarSize - 32), PAD + avatarSize + 28, PAD + 48);
  ctx.font = `400 28px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillText(`${stats.year} Wrapped · Miru × AniList`, PAD + avatarSize + 28, PAD + 88);

  // Headline: time spent.
  let y = 300;
  // "About": the hours are an estimate (see wrapped.js).
  label(ctx, "You spent about", PAD, y, accent);
  ctx.font = `800 156px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  const hoursText = formatNumber(stats.hours);
  ctx.fillText(hoursText, PAD - 6, y + 150);
  const hoursWidth = ctx.measureText(hoursText).width;
  ctx.font = `700 52px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillText(stats.hours === 1 ? "hour" : "hours", PAD + hoursWidth + 18, y + 150);

  ctx.font = `400 32px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText(
    `watching ${formatNumber(stats.episodes)} episodes across ${formatNumber(stats.animeCount)} anime`,
    PAD, y + 208
  );

  // Stat tiles, two rows of two.
  y = 560;
  const gap = 24;
  const tileWidth = (WIDTH - PAD * 2 - gap) / 2;
  const tileHeight = 140;
  const tiles = [
    { title: "Chapters read", value: formatNumber(stats.chapters) },
    { title: "Completed", value: formatNumber(stats.completed) },
    { title: "Mean score", value: stats.meanScore !== null ? String(stats.meanScore) : "—", starred: stats.meanScore !== null },
    { title: stats.busiestMonth ? "Busiest month" : "Top studio", value: stats.busiestMonth || stats.topStudio || "—" }
  ];
  tiles.forEach((entry, index) => tile(ctx, {
    ...entry,
    x: PAD + (index % 2) * (tileWidth + gap),
    y: y + Math.floor(index / 2) * (tileHeight + gap),
    width: tileWidth,
    height: tileHeight,
    accent: index === 0 ? "#ffffff" : accent
  }));

  // Favourite and hot take, side by side.
  y = 900;
  if (stats.favourite) {
    drawCover(ctx, favouriteCover, PAD, y, 140, 200, 18);
    label(ctx, "Favourite of the year", PAD + 168, y + 30);
    ctx.font = `800 38px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(fit(ctx, stats.favourite.media.title, WIDTH - PAD * 2 - 168), PAD + 168, y + 80);
    star(ctx, PAD + 182, y + 112, 15, accent);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = accent;
    ctx.fillText(String(stats.favourite.score / 10), PAD + 206, y + 122);

    if (stats.hotTake) {
      label(ctx, "Hottest take", PAD + 168, y + 168);
      ctx.font = `400 26px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      const { title, score, average } = stats.hotTake;
      // The numbers lead so that a long title is what gets cut, not the take.
      ctx.fillText(
        fit(ctx, `You ${score} vs everyone ${average} · ${title}`, WIDTH - PAD * 2 - 168),
        PAD + 168, y + 202
      );
    }
  }

  // Genres as pills.
  y = 1150;
  ctx.font = `700 28px ${FONT}`;
  let x = PAD;
  for (const genre of stats.topGenres) {
    const width = ctx.measureText(genre).width + 48;
    roundedRect(ctx, x, y, width, 56, 28);
    ctx.fillStyle = mix(accent, 0.55);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(drawable(genre), x + 24, y + 38);
    x += width + 14;
  }

  // Cover strip down the right of the genre row.
  const stripCovers = covers.filter(Boolean).slice(0, Math.max(0, Math.floor((WIDTH - PAD - x) / 74)));
  stripCovers.forEach((cover, index) => {
    const coverX = WIDTH - PAD - (stripCovers.length - index) * 74 + 14;
    drawCover(ctx, cover, coverX, y - 18, 60, 86, 10);
  });

  // Footer: how they rank.
  const ranks = [
    standing?.global ? `Top ${standing.global.topPercent}% of Miru users` : null,
    standing?.server && serverName ? `#${standing.server.rank} of ${standing.server.of} in ${serverName}` : null
  ].filter(Boolean);
  ctx.font = `700 28px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(fit(ctx, ranks.join("  ·  ") || "miru · anime & manga for Discord", WIDTH - PAD * 2), PAD, HEIGHT - PAD + 8);

  return canvas.toBuffer("image/png");
}

module.exports = { renderWrappedCard };
