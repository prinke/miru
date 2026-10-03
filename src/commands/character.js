const { EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ComponentType } = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const {
  searchCharacter,
  getCharacterAnime,
  getCharacterManga,
  getCharacterVoiceActors,
  truncate,
  describeSearchError,
  sourceLabel
} = require("../lib/media-search");
const {
  ACCENT,
  joinDot,
  joinLines,
  joinParagraphs,
  clamp,
  summarize,
  chips,
  stackedList,
  formatNumber,
  fields,
  paginationFooter
} = require("../lib/embeds");

/**
 * AniList sends appearances and voice actors along with the search result, so
 * only the Jikan fallback needs the three follow-up calls. The lookups are keyed
 * by MAL id, so they must never run against an AniList result.
 */
async function ensureCharacterDetails(character) {
  if (character._source !== "jikan") return;
  if (character.animeInfo && character.mangaInfo && character.voiceActors) return;

  const [animeData, mangaData, voiceActorData] = await Promise.all([
    getCharacterAnime(character.mal_id),
    getCharacterManga(character.mal_id),
    getCharacterVoiceActors(character.mal_id)
  ]);

  character.animeInfo = animeData;
  character.mangaInfo = mangaData;
  character.voiceActors = voiceActorData;
}

function titlesOf(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => item?.anime?.title || item?.manga?.title).filter(Boolean);
}

function voiceActorNames(voiceActors) {
  if (!Array.isArray(voiceActors)) return [];
  return voiceActors
    .filter((va) => va.language === "Japanese")
    .map((va) => va.person?.name)
    .filter(Boolean);
}

// Both sources label these lines differently ("Blood type", "Date of Birth"),
// so the wording is normalised onto one key per detail.
const DETAIL_ALIASES = {
  age: "age",
  gender: "gender",
  sex: "gender",
  height: "height",
  birthday: "birthday",
  birthdate: "birthday",
  birth: "birthday",
  "date of birth": "birthday",
  "blood type": "bloodType",
  bloodtype: "bloodType"
};

const DETAIL_FIELDS = [
  ["age", "Age"],
  ["gender", "Gender"],
  ["birthday", "Birthday"],
  ["height", "Height"],
  ["bloodType", "Blood Type"]
];

/**
 * AniList and MyAnimeList both open a character description with a block of
 * "Height: 185 cm" style lines (AniList bolds the key, MAL does not). Left in
 * place they read as a wall of text and get cut off by the description limit, so
 * they are lifted into their own embed fields and removed from the prose.
 */
function extractInlineDetails(about) {
  const details = {};
  const remaining = [];

  for (const line of String(about || "").split("\n")) {
    // Match against a de-emphasised copy so "**Height:**" and "**Height**:"
    // both resolve to the same key, then keep the original line if unused.
    const plain = line.replace(/\*\*|__/g, "").trim();
    const match = plain.match(/^([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*(\S.*)$/);
    const key = match && DETAIL_ALIASES[match[1].toLowerCase()];

    // The length cap keeps a prose sentence that happens to start with a known
    // word from being swallowed into a field.
    if (key && !details[key] && match[2].length <= 120) {
      details[key] = match[2].trim();
    } else {
      remaining.push(line);
    }
  }

  return {
    details,
    about: remaining.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  };
}

// Both sources write out placeholders like "Blood type: Unknown" rather than
// omitting the line, and a field that says "Unknown" is worse than no field.
const PLACEHOLDER = /^(unknown|undisclosed|unavailable|n\/?a|none|-+|\?+)$/i;

/** Drops blank values so a source's nulls cannot mask a parsed detail. */
function definedEntries(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && !PLACEHOLDER.test(text)) out[key] = text;
  }
  return out;
}

function createCharacterEmbed(result, currentIndex, totalResults) {
  const parsed = extractInlineDetails(result.about);
  // Structured fields from the API win over anything scraped out of the prose;
  // the outer pass drops placeholders from either side.
  const details = definedEntries({ ...parsed.details, ...definedEntries(result.details) });

  // Five one-word details would otherwise take two rows of near-empty cells, so
  // they are set as a single bold-labelled line above the description.
  const detailLine = joinDot(
    DETAIL_FIELDS
      .filter(([key]) => details[key])
      .map(([key, name]) => `**${name}** ${clamp(details[key], 40)}`)
  );

  const nicknames = chips(result.nicknames, 3);
  const nativeName = result.name_kanji || null;

  return new EmbedBuilder()
    .setColor(ACCENT.character)
    .setTitle(clamp(result.name || "Unknown", 256))
    .setURL(result.url || null)
    .setDescription(joinParagraphs([
      joinLines([
        nativeName || nicknames ? `-# ${joinDot([nativeName, nicknames])}` : null,
        detailLine || null
      ]),
      summarize(parsed.about) || "*No description available.*"
    ]))
    .setThumbnail(result.images?.jpg?.image_url || null)
    // Three narrow columns read as a cast sheet; stacked full-width lists made
    // the embed several screens tall.
    .addFields(fields([
      { name: "Anime", value: stackedList(titlesOf(result.animeInfo)), inline: true },
      { name: "Manga", value: stackedList(titlesOf(result.mangaInfo)), inline: true },
      { name: "Voice (JP)", value: stackedList(voiceActorNames(result.voiceActors), { max: 3 }), inline: true }
    ]))
    .setFooter(paginationFooter([
      result.favorites ? `♥ ${formatNumber(result.favorites)}` : null,
      sourceLabel(result),
      `${currentIndex + 1} of ${totalResults}`
    ]));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("character")
    .setDescription("Search for an anime character")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Character name to search for")
        .setRequired(true)
    )
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
    const query = interaction.options.getString("query", true);

    await interaction.deferReply();

    let results = null;
    try {
      results = await searchCharacter(query);
    } catch (error) {
      console.error("Character search failed:", error);
      await interaction.editReply(describeSearchError(error));
      return;
    }

    if (!results || results.length === 0) {
      await interaction.editReply("No character results found.");
      return;
    }

    await ensureCharacterDetails(results[0]);

    // Create dropdown menu with results
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("character_select")
      .setPlaceholder("Select a character to view details")
      .addOptions(
        results.slice(0, 25).map((result, index) => ({
          label: truncate(result.name || "Unknown", 100),
          // The first appearance identifies a character far better than a
          // nickname does when several share a name.
          description: truncate(joinDot([
            titlesOf(result.animeInfo)[0] || titlesOf(result.mangaInfo)[0] || null,
            result.nicknames?.[0] || null
          ]), 100) || undefined,
          value: String(index)
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = createCharacterEmbed(results[0], 0, results.length);
    const response = await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

    // Create collector for dropdown interactions
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 300_000 // 5 minutes
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({
          content: "This dropdown is not for you!",
          ephemeral: true
        });
        return;
      }

      const selectedIndex = parseInt(i.values[0]);
      const selectedResult = results[selectedIndex];

      await ensureCharacterDetails(selectedResult);

      const selectedEmbed = createCharacterEmbed(selectedResult, selectedIndex, results.length);

      await i.update({
        embeds: [selectedEmbed],
        components: [row]
      });
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch (error) {
        // Message might have been deleted
      }
    });
  }
};
