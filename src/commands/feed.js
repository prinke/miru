const {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const guilds = require("../lib/guilds");
const users = require("../lib/users");
const { requireLinkedAccount } = require("../lib/linked-account");
const { ACCENT, joinLines } = require("../lib/embeds");

const MODE_LABEL = {
  highlights: "Highlights — finishes, drops and new starts",
  everything: "Everything — every episode and chapter"
};

const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
];

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function setup(interaction) {
  if (!canManage(interaction)) {
    await interaction.reply(ephemeral("Only members with **Manage Server** can set up the feed."));
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const mode = interaction.options.getString("mode") || "highlights";

  const me = interaction.guild?.members?.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  if (!permissions?.has(REQUIRED_PERMISSIONS)) {
    await interaction.reply(ephemeral(
      `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel} to post the feed there.`
    ));
    return;
  }

  await guilds.setFeed(interaction.guildId, { channelId: channel.id, mode, enabledBy: interaction.user.id });

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(ACCENT.anilist)
        .setTitle("AniList feed is set up")
        .setDescription(joinLines([
          `Activity will be posted in ${channel}.`,
          `**Mode:** ${MODE_LABEL[mode]}`,
          "",
          "Nobody is included automatically — each member opts in with `/feed join`."
        ]))
    ]
  });
}

async function disable(interaction) {
  if (!canManage(interaction)) {
    await interaction.reply(ephemeral("Only members with **Manage Server** can turn the feed off."));
    return;
  }
  await guilds.disableFeed(interaction.guildId);
  await interaction.reply(ephemeral("The AniList feed is off for this server. Members' opt-ins are kept."));
}

async function join(interaction) {
  const account = await requireLinkedAccount(interaction);
  if (!account) return;

  const joined = await users.joinServer(interaction.user.id, interaction.guildId);
  const feed = await guilds.getFeed(interaction.guildId);

  await interaction.reply(ephemeral(joinLines([
    joined
      ? `You joined this server's AniList feed as **${account.link.name}**.`
      : "You were already in this server's AniList feed.",
    feed
      ? `Your list activity will show up in <#${feed.channelId}>.`
      : "No feed channel is set up yet; your activity will appear once an admin runs `/feed setup`.",
    "-# Your public list is also used for `/recommend for:server` and `/wrapped` rankings here. `/feed leave` to stop."
  ])));
}

async function leave(interaction) {
  const left = await users.leaveServer(interaction.user.id, interaction.guildId);
  await interaction.reply(ephemeral(
    left ? "You left this server's AniList feed." : "You were not in this server's AniList feed."
  ));
}

async function status(interaction) {
  const [feed, members] = await Promise.all([
    guilds.getFeed(interaction.guildId),
    users.serverMembers(interaction.guildId)
  ]);
  const joined = members.some((member) => member.discordId === interaction.user.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(feed ? ACCENT.anilist : 0x95a5a6)
        .setTitle(feed ? "AniList feed is on" : "AniList feed is off")
        .setDescription(joinLines([
          feed ? `**Channel:** <#${feed.channelId}>` : "An admin can turn it on with `/feed setup`.",
          feed ? `**Mode:** ${MODE_LABEL[feed.mode] || feed.mode}` : null,
          `**Members:** ${members.length}`,
          joined ? "-# You are in this feed · `/feed leave` to stop" : "-# You are not in this feed · `/feed join` to opt in"
        ]))
    ],
    flags: MessageFlags.Ephemeral
  });
}

const HANDLERS = { setup, disable, join, leave, status };

module.exports = {
  data: new SlashCommandBuilder()
    .setName("feed")
    .setDescription("A channel that shares what members are watching and reading on AniList")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Choose the channel for the feed (Manage Server)")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Where to post updates")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true))
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("How much to post (defaults to highlights)")
            .addChoices(
              { name: "Highlights — finishes, drops and new starts", value: "highlights" },
              { name: "Everything — every episode and chapter", value: "everything" }
            )))
    .addSubcommand((sub) => sub.setName("disable").setDescription("Turn the feed off (Manage Server)"))
    .addSubcommand((sub) => sub.setName("join").setDescription("Share your AniList activity in this server"))
    .addSubcommand((sub) => sub.setName("leave").setDescription("Stop sharing your AniList activity here"))
    .addSubcommand((sub) => sub.setName("status").setDescription("See this server's feed settings"))
    // Posting into a channel needs the bot in the server, so this only exists
    // where Miru is installed to the server rather than to a user.
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild]),

  async execute(interaction) {
    await HANDLERS[interaction.options.getSubcommand()](interaction);
  }
};
