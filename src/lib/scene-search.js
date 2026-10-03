// The reply to a scene search, shared by `/trace` and the "What anime is this?"
// message menu command.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");
const { searchScene, describeTraceError } = require("./trace-moe");
const { createListControls } = require("./list-controls");
const { ACCENT, clamp, joinDot, joinLines } = require("./embeds");

// trace.moe's own guidance: below ~90% a match is usually wrong, and below
// ~80% it is noise (a cropped, filtered or non-anime image).
const CONFIDENT = 0.9;
const PLAUSIBLE = 0.8;
const MAX_ALTERNATIVES = 3;
const LOW_QUOTA = 20;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const COLLECTOR_MS = 5 * 60 * 1000;

const SEARCHABLE_TYPE = /^(image|video)\//;

/** "1:02:05" or "12:34" from seconds. */
function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function percent(similarity) {
  return `${(similarity * 100).toFixed(1)}%`;
}

function whereLabel(match) {
  const time = Number.isFinite(match.at) ? `at ${formatTime(match.at)}` : null;
  return joinDot([match.episode !== null ? `Episode ${match.episode}` : null, time]);
}

/**
 * The image (or clip) a message carries, if any: an attachment first, then an
 * embed's picture (links to images, Tenor GIFs and the like).
 * Resolves to `{ url }` or `{ error }`.
 */
function findMedia(message) {
  for (const attachment of message.attachments.values()) {
    if (!SEARCHABLE_TYPE.test(attachment.contentType || "")) continue;
    if (attachment.size > MAX_UPLOAD_BYTES) {
      return { error: "That file is too large for scene search (25 MB at most)." };
    }
    return { url: attachment.url };
  }

  for (const embed of message.embeds) {
    const url = embed.image?.url || embed.thumbnail?.url || embed.video?.url;
    if (url) return { url };
  }

  return { error: "That message has no image, GIF or video to search." };
}

function sceneEmbed({ matches, quotaLeft }) {
  const [best, ...rest] = matches;
  const confident = best.similarity >= CONFIDENT;
  const alternatives = rest.filter((match) => match.similarity >= PLAUSIBLE).slice(0, MAX_ALTERNATIVES);

  const embed = new EmbedBuilder()
    .setColor(best.color ? parseInt(best.color.slice(1), 16) : ACCENT.anime)
    .setAuthor({ name: confident ? "Scene found" : "Possible match — low confidence" })
    .setTitle(clamp(best.title, 256))
    .setURL(best.url)
    .setThumbnail(best.cover)
    .setDescription(joinLines([
      best.nativeTitle && best.nativeTitle !== best.title ? `-# ${clamp(best.nativeTitle, 200)}` : null,
      joinDot([`**${whereLabel(best) || "Scene matched"}**`, best.format, best.year ? String(best.year) : null]),
      `${percent(best.similarity)} match`,
      confident ? null : "-# Cropped, filtered or edited images often match poorly — try an uncropped screenshot."
    ]))
    .setFooter({
      text: joinDot([
        "trace.moe",
        quotaLeft !== null && quotaLeft < LOW_QUOTA ? `${quotaLeft} searches left this month` : null
      ])
    });

  // The preview frame comes straight from the matched video, so an adult
  // title's frame is left out rather than posted into the channel.
  if (best.image && !best.isAdult) embed.setImage(best.image);

  if (alternatives.length) {
    embed.addFields({
      name: "Other possibilities",
      value: alternatives
        .map((match) => `[${clamp(match.title, 60)}](${match.url}) · ${joinDot([whereLabel(match), percent(match.similarity)])}`)
        .join("\n")
    });
  }
  return embed;
}

function linkRow(best) {
  const row = new ActionRowBuilder();
  if (best.video && !best.isAdult) {
    row.addComponents(new ButtonBuilder().setLabel("Preview clip").setStyle(ButtonStyle.Link).setURL(best.video));
  }
  row.addComponents(new ButtonBuilder().setLabel("Open on AniList").setStyle(ButtonStyle.Link).setURL(best.url));
  return row;
}

/**
 * Searches the scene at `url` and answers the (already deferred) interaction.
 */
async function replyWithScene(interaction, url) {
  let found = null;
  try {
    found = await searchScene(url);
  } catch (error) {
    console.error("trace.moe search failed:", error.reason ?? error.name, error.status ?? "", error.message);
    await interaction.editReply(describeTraceError(error));
    return;
  }

  const best = found.matches[0];
  if (!best || best.similarity < PLAUSIBLE) {
    await interaction.editReply(
      best
        ? `No convincing match (the closest was **${clamp(best.title, 80)}** at ${percent(best.similarity)}). ` +
          "Scene search works best on uncropped screenshots straight from an episode."
        : "No match found. Scene search works best on uncropped screenshots straight from an episode."
    );
    return;
  }

  // The list buttons speak the search results' shape; a scene match only
  // needs to say which AniList entry it is.
  const asResult = { _anilistId: best.anilistId, mal_id: best.malId, title: best.title, title_english: best.title };
  const controls = await createListControls({
    discordId: interaction.user.id,
    results: [asResult],
    type: "ANIME"
  }).catch(() => null);

  const components = () => [linkRow(best), controls?.rowFor(0)].filter(Boolean);
  const response = await interaction.editReply({ embeds: [sceneEmbed(found)], components: components() });
  if (!controls) return;

  const collector = response.createMessageComponentCollector({ time: COLLECTOR_MS });
  collector.on("collect", async (i) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: "These controls are not for you!", flags: MessageFlags.Ephemeral });
      return;
    }
    if (controls.owns(i.customId) && (await controls.handle(i, 0))) {
      await interaction.editReply({ components: components() }).catch(() => {});
    }
  });
  collector.on("end", async () => {
    // Link buttons need no collector, so they stay.
    await interaction.editReply({ components: [linkRow(best)] }).catch(() => {});
  });
}

module.exports = { findMedia, replyWithScene, formatTime, SEARCHABLE_TYPE, MAX_UPLOAD_BYTES };
