const {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { describeAniListError } = require("../lib/anilist-errors");
const { fetchLibrary } = require("../lib/library");
const listEntries = require("../lib/list-entries");
const { recommend } = require("../lib/recommend");
const { requireLinkedAccount, NOT_LINKED } = require("../lib/linked-account");
const users = require("../lib/users");
const { ACCENT, clamp, joinDot, joinLines } = require("../lib/embeds");

const COLLECTOR_MS = 10 * 60 * 1000;
// Each member is one or two AniList requests at the shared 30/minute budget,
// so a server-wide run samples rather than reading everyone.
const MAX_SERVER_MEMBERS = 10;
const PLANNING_PICKER_ID = "recommend_plan";

const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha",
  "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"
];

const FORMAT_LABEL = {
  TV: "TV", TV_SHORT: "TV Short", MOVIE: "Movie", SPECIAL: "Special", OVA: "OVA", ONA: "ONA",
  MUSIC: "Music", MANGA: "Manga", NOVEL: "Light Novel", ONE_SHOT: "One-shot"
};

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function becauseLine(because, { group }) {
  if (because.length === 0) return null;
  const titles = because.map((reason) => clamp(reason.title, 40));
  if (!group) return `-# Because you liked ${titles.join(" and ")}`;

  const fans = [...new Set(because.flatMap((reason) => reason.by))];
  return `-# Because ${fans.join(" & ")} loved ${titles.join(" and ")}`;
}

function recommendationEmbed(results, { heading, footer, group }) {
  const lines = results.map(({ media, because }, index) => {
    const title = clamp(media.title, 60);
    const details = joinDot([
      FORMAT_LABEL[media.format] || media.format,
      media.year ? String(media.year) : null,
      media.score ? `★ ${media.score}` : null
    ]);
    return joinLines([`**${index + 1}. [${title}](${media.url})** · ${details}`, becauseLine(because, { group })]);
  });

  return new EmbedBuilder()
    .setColor(ACCENT.anilist)
    .setTitle(heading)
    .setDescription(lines.join("\n"))
    .setThumbnail(results[0]?.media.cover || null)
    .setFooter({ text: footer });
}

function planningPicker(results) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(PLANNING_PICKER_ID)
      .setPlaceholder("Add one to your Planning list…")
      .addOptions(results.map(({ media }, index) => ({
        label: clamp(`${index + 1}. ${media.title}`, 100),
        description: clamp(joinDot([FORMAT_LABEL[media.format], media.genres.slice(0, 3).join(", ")]), 100) || undefined,
        value: String(media.id)
      })))
  );
}

/** Adds the picked title to whoever picked it — anyone viewing can use the menu. */
async function addToPlanning(select, results) {
  const link = await users.getAniListLink(select.user.id);
  const accessToken = link && !link.expired ? await users.getAniListToken(select.user.id) : null;
  if (!accessToken) {
    await select.reply({ content: NOT_LINKED, flags: MessageFlags.Ephemeral });
    return;
  }

  await select.deferReply({ flags: MessageFlags.Ephemeral });
  const mediaId = Number(select.values[0]);
  const picked = results.find((result) => result.media.id === mediaId);

  try {
    const existing = await listEntries.fetchEntry(accessToken, { userId: link.id, mediaId });
    if (existing) {
      await select.editReply(`**${clamp(picked.media.title, 100)}** is already on your list.`);
      return;
    }
    await listEntries.saveStatus(accessToken, { mediaId, status: "PLANNING" });
    await select.editReply(`Added **${clamp(picked.media.title, 100)}** to your Planning list.`);
  } catch (error) {
    console.error("Adding a recommendation failed:", error.name, error.reason ?? "", error.status ?? "");
    await select.editReply(describeAniListError(error, "adding this to your list"));
  }
}

async function personal(interaction, { type, genre }) {
  const account = await requireLinkedAccount(interaction);
  if (!account) return null;
  await interaction.deferReply();

  // Read as the user so their private entries still count as "seen" and are
  // never recommended back to them; `recommend` never names a private entry.
  const library = await fetchLibrary({ userId: account.link.id, type, accessToken: account.accessToken });
  const results = await recommend([{ name: account.link.name, entries: library.entries }], { genre });

  return {
    results,
    heading: `Recommended for ${account.link.name}${genre ? ` · ${genre}` : ""}`,
    footer: "From your favourites · AniList community recommendations",
    group: false
  };
}

async function server(interaction, { type, genre }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Server recommendations only work inside a server.", flags: MessageFlags.Ephemeral });
    return null;
  }

  const members = await users.serverMembers(interaction.guildId);
  if (members.length < 2) {
    await interaction.reply({
      content: "Server recommendations need at least two members who have joined with `/feed join`.",
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  await interaction.deferReply();

  // Public reads: the result is shared with the whole channel.
  const people = [];
  for (const member of shuffle(members).slice(0, MAX_SERVER_MEMBERS)) {
    try {
      const library = await fetchLibrary({ userId: member.anilist.id, type });
      people.push({ name: library.user?.name || member.anilist.name, entries: library.entries });
    } catch (error) {
      // A member whose list has gone private is simply left out.
      console.warn(`Skipping ${member.anilist.name} in server recommendations:`, error.message);
    }
  }

  const results = await recommend(people, { genre });
  return {
    results,
    heading: `Nobody here has seen these yet${genre ? ` · ${genre}` : ""}`,
    footer: `Pooled from ${people.length} members${members.length > people.length ? ` (of ${members.length})` : ""} · /feed join to be included`,
    group: true
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("recommend")
    .setDescription("Get anime or manga recommendations from your AniList favourites")
    .addStringOption((option) =>
      option
        .setName("for")
        .setDescription("Just you, or everyone in this server who joined the feed")
        .addChoices({ name: "Me", value: "me" }, { name: "This server", value: "server" }))
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Anime or manga (defaults to anime)")
        .addChoices({ name: "Anime", value: "ANIME" }, { name: "Manga", value: "MANGA" }))
    .addStringOption((option) =>
      option
        .setName("genre")
        .setDescription("Only recommend this genre")
        .addChoices(...GENRES.map((genre) => ({ name: genre, value: genre }))))
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
    const options = {
      type: interaction.options.getString("type") || "ANIME",
      genre: interaction.options.getString("genre")
    };
    const run = interaction.options.getString("for") === "server" ? server : personal;

    let outcome = null;
    try {
      outcome = await run(interaction, options);
    } catch (error) {
      console.error("Recommendations failed:", error.name, error.reason ?? "", error.status ?? "");
      const content = describeAniListError(error, "building recommendations");
      if (interaction.deferred) await interaction.editReply(content);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!outcome) return;

    if (outcome.results.length === 0) {
      await interaction.editReply(
        "Not enough to go on yet — score or complete a few more titles on AniList and try again."
      );
      return;
    }

    const response = await interaction.editReply({
      embeds: [recommendationEmbed(outcome.results, outcome)],
      components: [planningPicker(outcome.results)]
    });

    const collector = response.createMessageComponentCollector({ time: COLLECTOR_MS });
    collector.on("collect", async (select) => {
      await addToPlanning(select, outcome.results);
      // Re-sending the menu clears the picked option, so the same title can be
      // picked again by the next person.
      await interaction.editReply({ components: [planningPicker(outcome.results)] }).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  }
};
