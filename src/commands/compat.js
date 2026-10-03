const { EmbedBuilder, MessageFlags, SlashCommandBuilder } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { compareLibraries } = require("../lib/compat");
const { describeAniListError } = require("../lib/anilist-errors");
const { fetchLibrary } = require("../lib/library");
const users = require("../lib/users");
const { NOT_LINKED } = require("../lib/linked-account");
const { ACCENT, clamp, fields, joinLines } = require("../lib/embeds");

const BAR_WIDTH = 20;

function meter(percent) {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  return `\`${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}\``;
}

/** Scores are compared out of 100 but read out of 10, like everywhere else in Miru. */
function tenPoint(score) {
  return Number.isInteger(score / 10) ? String(score / 10) : (score / 10).toFixed(1);
}

function titleLink(media, width = 45) {
  const title = clamp(media.title, width);
  return media.url ? `[${title}](${media.url})` : title;
}

function pickLines(picks) {
  return joinLines(picks.map((pick) =>
    `${titleLink(pick.media)} · ★ ${tenPoint(pick.score)}${pick.planned ? " · *on your Planning*" : ""}`));
}

function compatEmbed(a, b, result, type) {
  const noun = type === "MANGA" ? "manga" : "anime";

  return new EmbedBuilder()
    .setColor(ACCENT.anilist)
    .setAuthor({ name: `${a.name} × ${b.name}`, iconURL: a.avatar || undefined })
    .setThumbnail(b.avatar || null)
    .setTitle(`${result.percent}% · ${result.verdict}`)
    .setDescription(joinLines([
      meter(result.percent),
      result.commonGenres.length ? `-# Both into ${result.commonGenres.join(", ")}` : null
    ]))
    .addFields(fields([
      {
        name: "You both loved",
        value: joinLines(result.lovedBoth.map((pair) =>
          `${titleLink(pair.media)} · ${tenPoint(pair.scoreA)} / ${tenPoint(pair.scoreB)}`))
      },
      {
        name: "Where you disagree",
        value: joinLines(result.disagreements.map((pair) =>
          `${titleLink(pair.media)} · ${a.name} ${tenPoint(pair.scoreA)} vs ${b.name} ${tenPoint(pair.scoreB)}`))
      },
      { name: `${clamp(a.name, 40)} should try`, value: pickLines(result.picksForA), inline: true },
      { name: `${clamp(b.name, 40)} should try`, value: pickLines(result.picksForB), inline: true }
    ]))
    .setFooter({
      text: `Based on ${result.sharedCount} shared ${noun} (${result.scoredCount} rated by both) · public AniList data`
    });
}

function describeLoadError(error, name) {
  // AniList answers 404 both for a name that does not exist and for a profile
  // that is private, and does not say which.
  if (error?.status === 404) return `Could not read **${name}**'s list — the account may not exist or may be private.`;
  return describeAniListError(error, "loading the lists");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("compat")
    .setDescription("See how compatible your anime taste is with someone else's")
    .addUserOption((option) =>
      option.setName("user").setDescription("A Discord user who has linked AniList"))
    .addStringOption((option) =>
      option.setName("username").setDescription("…or any AniList username").setMaxLength(50))
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Compare anime or manga (defaults to anime)")
        .addChoices({ name: "Anime", value: "ANIME" }, { name: "Manga", value: "MANGA" }))
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
    const otherUser = interaction.options.getUser("user");
    const otherName = interaction.options.getString("username")?.trim();
    const type = interaction.options.getString("type") || "ANIME";

    const refuse = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (!otherUser && !otherName) {
      await refuse("Pick someone to compare with: a Discord `user` who has linked AniList, or an AniList `username`.");
      return;
    }

    const me = await users.getAniListLink(interaction.user.id);
    if (!me) {
      await refuse(NOT_LINKED);
      return;
    }

    let other = { userName: otherName };
    if (otherUser) {
      const link = await users.getAniListLink(otherUser.id);
      if (!link) {
        await refuse(`${otherUser} has not linked an AniList account. Try their AniList \`username\` instead.`);
        return;
      }
      other = { userId: link.id };
    }

    if (other.userId === me.id || other.userName?.toLowerCase() === me.name?.toLowerCase()) {
      await refuse("Comparing with yourself is a guaranteed 100%. Pick someone else!");
      return;
    }

    await interaction.deferReply();

    // Both lists are read publicly even though the caller is linked: the reply
    // is posted in the channel, and must not surface anything either person has
    // hidden on AniList.
    let mine = null;
    let theirs = null;
    try {
      mine = await fetchLibrary({ userId: me.id, type });
    } catch (error) {
      await interaction.editReply(describeLoadError(error, me.name));
      return;
    }
    try {
      theirs = await fetchLibrary({ ...other, type });
    } catch (error) {
      await interaction.editReply(describeLoadError(error, otherName || otherUser.username));
      return;
    }

    const result = compareLibraries(mine.entries, theirs.entries);
    if (result.percent === null) {
      await interaction.editReply(
        `There is not enough on ${mine.entries.length ? `**${theirs.user.name}**'s` : "your"} ${type.toLowerCase()} list to compare yet.`
      );
      return;
    }

    await interaction.editReply({ embeds: [compatEmbed(mine.user, theirs.user, result, type)] });
  }
};
