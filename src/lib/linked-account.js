// The "is this person linked, and is the link still usable" check that every
// AniList-backed command opens with, answered the same way everywhere.

const { MessageFlags } = require("discord.js");
const users = require("./users");

const NOT_LINKED = "You have not linked an AniList account yet. Use `/link` to connect one.";
const EXPIRED = "Your AniList access has expired. Run `/link` to reconnect your account.";

/**
 * Resolves to `{ link, accessToken }`, or replies ephemerally with the reason
 * and resolves to null. Must run before the interaction is deferred, since the
 * refusal is sent as the interaction's reply.
 */
async function requireLinkedAccount(interaction) {
  const link = await users.getAniListLink(interaction.user.id);
  if (!link) {
    await interaction.reply({ content: NOT_LINKED, flags: MessageFlags.Ephemeral });
    return null;
  }

  // Null for an expired link as well as a missing one; missing is handled above.
  const accessToken = await users.getAniListToken(interaction.user.id);
  if (!accessToken) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return null;
  }

  return { link, accessToken };
}

module.exports = { NOT_LINKED, EXPIRED, requireLinkedAccount };
