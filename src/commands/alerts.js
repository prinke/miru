const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { queryAs } = require("../lib/anilist-auth");
const { describeAniListError } = require("../lib/anilist-errors");
const episodeAlerts = require("../lib/episode-alerts");
const { requireLinkedAccount } = require("../lib/linked-account");
const users = require("../lib/users");
const { ACCENT, clamp, joinDot, timestamp } = require("../lib/embeds");

const UPCOMING_LIMIT = 10;
const CLEAR_MUTED_ID = "alerts_clear_muted";
const COLLECTOR_MS = 2 * 60 * 1000;

const UPCOMING_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: [CURRENT, REPEATING]) {
      lists {
        isCustomList
        entries {
          private
          progress
          media { id siteUrl title { romaji english } nextAiringEpisode { episode airingAt } }
        }
      }
    }
  }
`;

const CANNOT_DM_HELP =
  "I could not send you a DM, so alerts will not reach you yet. Make sure you share a server with Miru " +
  "and have **Allow direct messages from server members** turned on for it (Server → Privacy Settings).";

/** Shows on the user's Watching list that have a next episode scheduled, soonest first. */
async function fetchUpcoming(accessToken, userId) {
  const data = await queryAs(accessToken, UPCOMING_QUERY, { userId });
  const seen = new Set();
  const upcoming = [];

  for (const list of data?.MediaListCollection?.lists || []) {
    if (list.isCustomList) continue;
    for (const entry of list.entries || []) {
      const media = entry.media;
      if (!media?.nextAiringEpisode || seen.has(media.id)) continue;
      seen.add(media.id);
      upcoming.push({ ...entry, media });
    }
  }

  return upcoming.sort((a, b) => a.media.nextAiringEpisode.airingAt - b.media.nextAiringEpisode.airingAt);
}

function upcomingLines(upcoming, muted) {
  return upcoming.slice(0, UPCOMING_LIMIT).map(({ media, private: isPrivate }) => {
    const title = clamp(media.title?.english || media.title?.romaji || "Unknown", 60);
    const { episode, airingAt } = media.nextAiringEpisode;
    const note = muted.has(media.id) ? "muted" : isPrivate ? "private entry, no alert" : null;
    return `${timestamp(new Date(airingAt * 1000).toISOString(), "R")} · [${title}](${media.siteUrl}) · Ep ${episode}${note ? ` · *${note}*` : ""}`;
  });
}

function statusEmbed({ alerts, upcoming }) {
  const muted = new Set(alerts.muted);
  const lines = upcomingLines(upcoming, muted);
  const hidden = upcoming.length - lines.length;

  return new EmbedBuilder()
    .setColor(alerts.enabled ? ACCENT.anilist : 0x95a5a6)
    .setAuthor({ name: alerts.enabled ? "Episode alerts are on" : "Episode alerts are off" })
    .setTitle("Coming up on your Watching list")
    .setDescription(
      lines.length
        ? `${lines.join("\n")}${hidden > 0 ? `\n-# …and ${hidden} more` : ""}`
        : "*Nothing on your Watching list has an episode scheduled.*"
    )
    .setFooter({
      text: joinDot([
        alerts.muted.length ? `${alerts.muted.length} muted` : null,
        alerts.undeliverableAt ? "Last alert could not be delivered — check your DM settings" : null,
        alerts.enabled ? "/alerts off to stop" : "/alerts on to start"
      ])
    });
}

async function enable(interaction, { link, accessToken }) {
  await users.setAlerts(interaction.user.id, true);

  // Discord gives no way to ask whether a DM would arrive, so the only honest
  // check is to send one.
  let canDm = true;
  try {
    await interaction.user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(ACCENT.anilist)
          .setTitle("Episode alerts are on")
          .setDescription(
            "When a new episode of something on your AniList **Watching** list airs, it shows up here — " +
            "with a button to mark it watched."
          )
          .setFooter({ text: "Use /alerts off at any time to stop." })
      ]
    });
  } catch {
    canDm = false;
    await users.markAlertsUndeliverable(interaction.user.id);
  }

  const upcoming = await fetchUpcoming(accessToken, link.id).catch(() => []);
  const alerts = await users.getAlerts(interaction.user.id);

  await interaction.editReply({
    content: canDm ? null : CANNOT_DM_HELP,
    embeds: [statusEmbed({ alerts, upcoming })]
  });
}

async function showStatus(interaction, { link, accessToken }) {
  const [alerts, upcoming] = await Promise.all([
    users.getAlerts(interaction.user.id),
    fetchUpcoming(accessToken, link.id)
  ]);

  const components = alerts.muted.length
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CLEAR_MUTED_ID)
        .setLabel(`Unmute ${alerts.muted.length} show${alerts.muted.length === 1 ? "" : "s"}`)
        .setStyle(ButtonStyle.Secondary)
    )]
    : [];

  const response = await interaction.editReply({ embeds: [statusEmbed({ alerts, upcoming })], components });
  if (components.length === 0) return;

  const button = await response.awaitMessageComponent({ time: COLLECTOR_MS }).catch(() => null);
  if (!button) {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }

  await users.clearMutedAlerts(interaction.user.id);
  await button.update({
    embeds: [statusEmbed({ alerts: { ...alerts, muted: [] }, upcoming })],
    components: []
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("alerts")
    .setDescription("Get a DM when new episodes of shows you are watching air")
    .addSubcommand((sub) => sub.setName("on").setDescription("Turn episode alerts on"))
    .addSubcommand((sub) => sub.setName("off").setDescription("Turn episode alerts off"))
    .addSubcommand((sub) => sub.setName("status").setDescription("See your alert settings and what airs next"))
    .setIntegrationTypes([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    ])
    .setContexts([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ])
    .setDMPermission(true),

  // The buttons on alert DMs, which have to keep working long after the bot
  // that sent them has restarted.
  components: episodeAlerts.components,

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "off") {
      await users.setAlerts(interaction.user.id, false);
      await interaction.reply({
        content: "Episode alerts are off. Shows you muted stay muted if you turn them back on.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const account = await requireLinkedAccount(interaction);
    if (!account) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (subcommand === "on") await enable(interaction, account);
      else await showStatus(interaction, account);
    } catch (error) {
      console.error("Alerts command failed:", error.name, error.reason ?? "", error.status ?? "");
      await interaction.editReply(describeAniListError(error, "loading your schedule"));
    }
  }
};
