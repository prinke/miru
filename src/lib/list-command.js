// Builds a paginated "show my list" command.
//
// The anime and manga lists differ only in which AniList media type they read,
// what the statuses are called ("Watching" vs "Reading"), and which colour and
// profile URL they use — so they are one implementation with those pieces
// passed in, rather than two files that drift apart.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const {
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord-api-types/v10");
const { requireLinkedAccount } = require("./linked-account");
const { fetchMediaList, fetchListCounts, statusChoices, statusLabel, PER_PAGE } = require("./media-list");
const { clamp, formatNumber, paginationFooter } = require("./embeds");
const { describeAniListError } = require("./anilist-errors");

const COLLECTOR_MS = 5 * 60 * 1000;
const DEFAULT_STATUS = "CURRENT";
const TITLE_WIDTH = 70;

function progressText(entry) {
  // A null total means the run is still going, so the denominator is unknown
  // rather than zero.
  return `${entry.progress}/${entry.total ?? "?"}`;
}

/**
 * Inline code renders monospaced, so padding the progress column to a common
 * width lines the titles up into a single left edge.
 */
function entryLines(entries) {
  const width = Math.max(...entries.map((entry) => progressText(entry).length));

  return entries.map((entry) => {
    const title = clamp(entry.title, TITLE_WIDTH);
    const link = entry.url ? `[${title}](${entry.url})` : title;
    return `\`${progressText(entry).padStart(width)}\` ${link}${entry.score ? ` · ★ ${entry.score}` : ""}`;
  });
}

/**
 * The last page is derived from the user's status counts when they are known.
 * Without them, a full page is taken to mean "there may be another" — enough to
 * keep the pager working, but not enough to claim a page count.
 */
function pageBounds({ total, page, entryCount }) {
  if (Number.isFinite(total)) {
    return { lastPage: Math.max(1, Math.ceil(total / PER_PAGE)), exact: true };
  }
  return { lastPage: entryCount === PER_PAGE ? page + 1 : page, exact: false };
}

const describeListError = (error) => describeAniListError(error, "reading your list");

/**
 * @param {object} options
 * @param {"ANIME"|"MANGA"} options.type   which AniList library to read
 * @param {string} options.name            slash command name, also the component id prefix
 * @param {string} options.label           how the list is named in the embed ("anime list")
 * @param {string} options.profilePath     the list's path on an AniList profile
 * @param {number} options.accent          embed colour
 */
function createListCommand({ type, name, label, profilePath, accent }) {
  const listUrl = (siteUrl) => {
    if (!siteUrl) return null;
    return `${siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`}${profilePath}`;
  };

  const listEmbed = (account, { status, entries, total, page, lastPage, exact }) =>
    new EmbedBuilder()
      .setColor(accent)
      .setAuthor({
        name: `${account.name} · ${label}`,
        iconURL: account.avatar || undefined,
        url: listUrl(account.siteUrl) || undefined
      })
      .setTitle(statusLabel(status, type))
      .setDescription(
        entries.length
          ? entryLines(entries).join("\n")
          : `*Nothing in ${statusLabel(status, type).toLowerCase()}.*`
      )
      .setFooter(paginationFooter([
        Number.isFinite(total) ? `${formatNumber(total)} ${total === 1 ? "entry" : "entries"}` : null,
        lastPage > 1 ? (exact ? `Page ${page} of ${lastPage}` : `Page ${page}`) : null,
        "AniList"
      ]));

  const buildComponents = ({ status, page, lastPage }) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${name}_status`)
      .setPlaceholder("Change list")
      .addOptions(
        statusChoices(type).map((choice) => ({
          label: choice.label,
          value: choice.value,
          default: choice.value === status
        }))
      );

    const rows = [new ActionRowBuilder().addComponents(menu)];

    // A pager with both buttons dead is just visual noise on a one-page list.
    if (lastPage > 1) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${name}_prev`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`${name}_next`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= lastPage)
      ));
    }

    return rows;
  };

  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(`Show the ${label} from your linked AniList account`)
      .addStringOption((option) =>
        option
          .setName("status")
          .setDescription(`Which list to open (defaults to ${statusLabel(DEFAULT_STATUS, type)})`)
          .addChoices(
            ...statusChoices(type).map((choice) => ({ name: choice.label, value: choice.value }))
          )
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
      const account = await requireLinkedAccount(interaction);
      if (!account) return;
      const { link, accessToken } = account;

      await interaction.deferReply();

      let status = interaction.options.getString("status") || DEFAULT_STATUS;
      let page = 1;
      let counts = null;

      /**
       * Loads the current page, having first clamped it to what the counts say
       * exists, and steps back if the page still comes up empty (counts lag a
       * little behind edits made on AniList).
       */
      async function load() {
        const total = counts?.[status];
        if (Number.isFinite(total)) {
          page = Math.min(Math.max(1, page), pageBounds({ total, page, entryCount: 0 }).lastPage);
        }

        let result = await fetchMediaList(accessToken, { userId: link.id, type, status, page });
        if (result.entries.length === 0 && page > 1) {
          page = 1;
          result = await fetchMediaList(accessToken, { userId: link.id, type, status, page });
        }

        return {
          ...result,
          total: Number.isFinite(total) ? total : null,
          ...pageBounds({ total, page, entryCount: result.entries.length })
        };
      }

      let result = null;
      try {
        // One counts request per command: it covers every status, so switching
        // lists and paging never refetches it. A user whose statistics are
        // unavailable still gets a working pager, just without a page count.
        counts = await fetchListCounts(accessToken, { userId: link.id, type }).catch(() => null);
        result = await load();
      } catch (error) {
        console.error(`AniList ${name} fetch failed:`, error.name, error.reason ?? "", error.status ?? "");
        await interaction.editReply(describeListError(error));
        return;
      }

      const render = (data) => ({
        embeds: [listEmbed(link, { status, ...data })],
        components: buildComponents({ status, page, lastPage: data.lastPage })
      });

      const response = await interaction.editReply(render(result));
      const collector = response.createMessageComponentCollector({ time: COLLECTOR_MS });

      collector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({
            content: "These controls are not for you!",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (i.isStringSelectMenu()) {
          status = i.values[0];
          page = 1; // a different list has different pages
        } else if (i.customId === `${name}_next`) {
          page += 1;
        } else if (i.customId === `${name}_prev`) {
          page = Math.max(1, page - 1);
        }

        // AniList can take longer than the 3s an update is allowed, so the
        // interaction is acknowledged before the request goes out.
        await i.deferUpdate();

        try {
          await i.editReply(render(await load()));
        } catch (error) {
          console.error(`AniList ${name} page failed:`, error.name, error.reason ?? "", error.status ?? "");
          await i.followUp({
            content: describeListError(error),
            flags: MessageFlags.Ephemeral
          }).catch(() => {});
        }
      });

      collector.on("end", async () => {
        try {
          await interaction.editReply({ components: [] });
        } catch {
          // The message may have been deleted.
        }
      });
    }
  };
}

module.exports = { createListCommand };
