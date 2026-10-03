const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const anilistAuth = require("../lib/anilist-auth");
const tokenVault = require("../lib/token-vault");
const users = require("../lib/users");
const { ACCENT, joinDot, formatNumber, timestamp, fields } = require("../lib/embeds");

// The whole exchange happens inside one ephemeral message, so the windows are
// generous: the user has to leave Discord, authorize, and copy a code back.
const WAIT_FOR_BUTTON_MS = 5 * 60 * 1000;
const WAIT_FOR_MODAL_MS = 10 * 60 * 1000;

const CODE_INPUT_ID = "code";

function accountEmbed(account, { expiresAt, existing = false } = {}) {
  return new EmbedBuilder()
    .setColor(ACCENT.anilist)
    .setAuthor({ name: existing ? "Already linked" : "AniList account linked" })
    .setTitle(account.name)
    .setURL(account.siteUrl || null)
    .setThumbnail(account.avatar || null)
    .setDescription(joinDot([
      Number.isFinite(account.animeCount) ? `${formatNumber(account.animeCount)} anime` : null,
      Number.isFinite(account.mangaCount) ? `${formatNumber(account.mangaCount)} manga` : null
    ]) || null)
    // A year out is easy to forget about, and AniList issues no refresh tokens,
    // so the expiry is stated up front.
    .addFields(fields([
      { name: "Access expires", value: timestamp(expiresAt, "D"), inline: true }
    ]))
    .setFooter({
      text: existing
        ? "Use /unlink to disconnect this account."
        : "Nothing on your lists is read or changed yet · /unlink to disconnect"
    });
}

function instructionsEmbed() {
  return new EmbedBuilder()
    .setColor(ACCENT.anilist)
    .setTitle("Link your AniList account")
    .setDescription([
      "**1.** Open the authorization page below and approve Miru.",
      "**2.** AniList shows you a code — copy it.",
      "**3.** Come back here, press **Enter code**, and paste it in."
    ].join("\n"))
    .setFooter({ text: "The code is private. Never paste it into a channel." });
}

function buildRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Authorize on AniList")
      .setStyle(ButtonStyle.Link)
      .setURL(anilistAuth.authorizeUrl()),
    new ButtonBuilder()
      .setCustomId("anilist_link_code")
      .setLabel("Enter code")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildModal(customId) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("Link AniList")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(CODE_INPUT_ID)
          .setLabel("Authorization code")
          // The code is a long string, so a single-line input would hide most
          // of it while pasting.
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Paste the code AniList gave you")
          .setRequired(true)
      )
    );
}

/** Maps a failure to something the user can act on. */
function describeAuthError(error) {
  if (error?.name !== "AniListAuthError") {
    return "Something went wrong while linking. Please try again.";
  }

  switch (error.reason) {
    case "invalid_code":
      return "AniList rejected that code. Codes are single-use and expire quickly — run `/link` again for a fresh one.";
    case "invalid_token":
      return "AniList accepted the code but would not return the account. Please try again.";
    case "unreachable":
      return "Could not reach AniList right now. Please try again in a few minutes.";
    default:
      return "AniList could not complete the link. Please try again.";
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your AniList account to Miru")
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
  async execute(interaction) {
    if (!anilistAuth.isConfigured() || !tokenVault.isConfigured()) {
      await interaction.reply({
        content: "Account linking is not configured on this bot yet.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const existing = await users.getAniListLink(interaction.user.id);
    if (existing && !existing.expired) {
      await interaction.reply({
        embeds: [accountEmbed(existing, { expiresAt: existing.expiresAt, existing: true })],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const response = await interaction.reply({
      embeds: [instructionsEmbed()],
      components: [buildRow()],
      flags: MessageFlags.Ephemeral
    });

    // Only the invoker can see an ephemeral message, so no author filter is needed.
    let button = null;
    try {
      button = await response.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: WAIT_FOR_BUTTON_MS
      });
    } catch {
      await interaction.editReply({ components: [] }).catch(() => {});
      return;
    }

    const modalId = `anilist_link_modal:${interaction.id}`;
    await button.showModal(buildModal(modalId));

    const submission = await button
      .awaitModalSubmit({ time: WAIT_FOR_MODAL_MS, filter: (i) => i.customId === modalId })
      .catch(() => null);

    if (!submission) {
      await interaction.editReply({ components: [] }).catch(() => {});
      return;
    }

    await submission.deferReply({ flags: MessageFlags.Ephemeral });
    // The instructions have been acted on; drop the buttons so the code cannot
    // be submitted twice.
    await interaction.editReply({ components: [] }).catch(() => {});

    const code = submission.fields.getTextInputValue(CODE_INPUT_ID).trim();

    try {
      const { accessToken, expiresAt } = await anilistAuth.exchangeCode(code);
      const account = await anilistAuth.fetchViewer(accessToken);

      await users.linkAniList(interaction.user.id, { account, accessToken, expiresAt });

      await submission.editReply({ embeds: [accountEmbed(account, { expiresAt })] });
    } catch (error) {
      // Never log the error object raw here: an exchange failure can echo the
      // submitted code back in its message.
      console.error(`AniList link failed for ${interaction.user.id}:`, error.name, error.reason ?? "", error.status ?? "");
      await submission.editReply({ content: describeAuthError(error) });
    }
  }
};
