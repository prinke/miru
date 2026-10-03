// The list buttons under a search result, and the flows behind them.
//
// Which buttons a result gets depends on whether it is already on the viewer's
// list: "Add to list" if not; "Remove from <status>", "+1 ep" and "Rate" if so.
// Membership for the whole result set is fetched once per search rather than
// per result, so flipping through the dropdown costs no further requests.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const anilist = require("./anilist");
const { describeAniListError } = require("./anilist-errors");
const { statusChoices, statusLabel } = require("./media-list");
const listEntries = require("./list-entries");
const users = require("./users");
const { clamp } = require("./embeds");

const ADD_ID = "list_add";
const REMOVE_ID = "list_remove";
const STATUS_PICKER_ID = "list_add_status";
const CONFIRM_REMOVE_ID = "list_remove_confirm";
const CANCEL_REMOVE_ID = "list_remove_cancel";
const PROGRESS_ID = "list_progress";
const RATE_ID = "list_rate";
const SCORE_INPUT_ID = "score";

const PROMPT_MS = 60 * 1000;
const MODAL_MS = 2 * 60 * 1000;

/** A 0–10 score from free text, or null when it is not one. */
function parseScore(text) {
  const value = Number(String(text).trim().replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > 10) return null;
  return Math.round(value * 10) / 10;
}

function titleOf(result) {
  return result?.title_english || result?.title || "this title";
}

/**
 * The AniList id for every result, aligned with `results`, or null where none
 * could be determined.
 *
 * Results are normalised to the Jikan shape, whose `mal_id` is a MyAnimeList id
 * and cannot be written to. AniList-sourced results carry their native id;
 * Jikan-sourced ones are translated in a single batch.
 */
async function resolveMediaIds(results, type) {
  const ids = results.map((result) =>
    (Number.isFinite(result?._anilistId) ? result._anilistId : null));

  const untranslated = results
    .map((result, index) => (ids[index] === null ? result?.mal_id : null))
    .filter(Number.isFinite);

  if (untranslated.length > 0) {
    const translated = await anilist.findIdsByMalIds(untranslated, type);
    for (const [index, result] of results.entries()) {
      if (ids[index] === null) ids[index] = translated.get(result?.mal_id) ?? null;
    }
  }

  return ids;
}

/**
 * Builds the per-result buttons and the interactions behind them, or null when the
 * viewer has no linked account to act on.
 */
async function createListControls({ discordId, results, type }) {
  const link = await users.getAniListLink(discordId).catch(() => null);
  if (!link || link.expired) return null;

  const accessToken = await users.getAniListToken(discordId).catch(() => null);
  if (!accessToken) return null;

  let mediaIds = results.map(() => null);
  let entries = new Map();

  // A failure here should cost the buttons their accuracy, not the search its
  // results: every result then simply offers "Add to list".
  try {
    mediaIds = await resolveMediaIds(results, type);
    entries = await listEntries.fetchEntries(accessToken, { userId: link.id, mediaIds });
  } catch (error) {
    console.error("AniList membership lookup failed:", error.name, error.reason ?? "", error.status ?? "");
  }

  const entryFor = (index) => entries.get(mediaIds[index]) ?? null;
  const unit = type === "MANGA" ? "chapter" : "episode";

  async function runAdd(button, index) {
    const result = results[index];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(STATUS_PICKER_ID)
      .setPlaceholder("Choose a list")
      .addOptions(statusChoices(type).map((choice) => ({ label: choice.label, value: choice.value })));

    await button.reply({
      content: `Add **${clamp(titleOf(result), 100)}** to which list?`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });

    // The collector has to hang off the prompt message itself. Building it from
    // the reply's InteractionResponse instead makes discord.js inherit
    // `button.message` — the public search result — as the message to collect
    // from, so a selection made here never matches and is never acknowledged.
    const prompt = await button.fetchReply();

    let choice = null;
    try {
      choice = await prompt.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: PROMPT_MS
      });
    } catch {
      await button.editReply({ content: "Timed out — nothing was added.", components: [] }).catch(() => {});
      return false;
    }

    const status = choice.values[0];
    await choice.deferUpdate();

    const saved = await listEntries.saveStatus(accessToken, { mediaId: mediaIds[index], status });
    if (saved) entries.set(mediaIds[index], saved);

    // The prompt has served its purpose: the button on the search result flips
    // to "Remove from <status>", which is the confirmation. Deleted only after
    // the save succeeds, so a failure still has somewhere to be reported.
    await button.deleteReply().catch(() => {});

    return true;
  }

  async function runRemove(button, index) {
    const result = results[index];
    const entry = entryFor(index);
    if (!entry) return false;

    await button.reply({
      // Deleting an entry discards its progress and score and AniList has no
      // undo, so this asks first.
      content: `Remove **${clamp(titleOf(result), 100)}** from your list? ` +
        `It is currently in **${statusLabel(entry.status, type)}** — its progress and score will be lost.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(CONFIRM_REMOVE_ID).setLabel("Remove").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(CANCEL_REMOVE_ID).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    const prompt = await button.fetchReply();

    let choice = null;
    try {
      choice = await prompt.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: PROMPT_MS
      });
    } catch {
      await button.editReply({ content: "Timed out — nothing was removed.", components: [] }).catch(() => {});
      return false;
    }

    await choice.deferUpdate();

    if (choice.customId === CANCEL_REMOVE_ID) {
      // Nothing happened and nothing can fail, so the prompt just goes away.
      await button.deleteReply().catch(() => {});
      return false;
    }

    await listEntries.deleteEntry(accessToken, entry.entryId);
    entries.delete(mediaIds[index]);

    await button.deleteReply().catch(() => {});

    return true;
  }

  async function runProgress(button, index) {
    const entry = entryFor(index);
    if (!entry) return false;

    // Acknowledged as an update: the button's own label is the confirmation.
    await button.deferUpdate();

    const { entry: saved, unchanged } = await listEntries.logProgress(accessToken, {
      mediaId: mediaIds[index],
      entry
    });

    if (unchanged) {
      await button.followUp({
        content: `You are already at the last ${unit} of **${clamp(titleOf(results[index]), 100)}**.`,
        flags: MessageFlags.Ephemeral
      });
      return false;
    }

    entries.set(mediaIds[index], saved);
    return true;
  }

  async function runRate(button, index) {
    const entry = entryFor(index);
    if (!entry) return false;

    const modalId = `${RATE_ID}_modal:${button.id}`;
    await button.showModal(
      new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(clamp(`Rate ${titleOf(results[index])}`, 45))
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(SCORE_INPUT_ID)
              .setLabel("Score out of 10 (0 clears it)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("8.5")
              .setValue(entry.score ? String(entry.score) : "")
              .setRequired(true)
              .setMaxLength(4)
          )
        )
    );

    const submission = await button
      .awaitModalSubmit({ time: MODAL_MS, filter: (i) => i.customId === modalId })
      .catch(() => null);
    if (!submission) return false;

    const score = parseScore(submission.fields.getTextInputValue(SCORE_INPUT_ID));
    if (score === null) {
      await submission.reply({
        content: "Scores are a number from 0 to 10, like `7` or `8.5`.",
        flags: MessageFlags.Ephemeral
      });
      return false;
    }

    await submission.deferUpdate();

    // The button was answered with the modal, which leaves it nothing to send
    // a follow-up from, so a failure past this point goes through the
    // submission instead.
    try {
      const saved = await listEntries.saveScore(accessToken, { mediaId: mediaIds[index], score });
      if (saved) entries.set(mediaIds[index], saved);
      return true;
    } catch (error) {
      console.error("AniList score save failed:", error.name, error.reason ?? "", error.status ?? "");
      await submission.followUp({
        content: describeAniListError(error, "saving your score"),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
      return false;
    }
  }

  return {
    owns: (customId) => [ADD_ID, REMOVE_ID, PROGRESS_ID, RATE_ID].includes(customId),

    /** The buttons for one result, or null when it cannot be matched on AniList. */
    rowFor(index) {
      if (!Number.isFinite(mediaIds[index])) return null;
      const entry = entryFor(index);

      if (!entry) {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ADD_ID)
            .setLabel("Add to list")
            .setStyle(ButtonStyle.Success)
        );
      }

      const atEnd = entry.total !== null && entry.progress >= entry.total;

      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(REMOVE_ID)
          .setLabel(clamp(`Remove from ${statusLabel(entry.status, type)}`, 80))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(PROGRESS_ID)
          // The current count rides along on the label, so the button doubles
          // as a progress readout and confirms each click.
          .setLabel(`+1 ${unit === "episode" ? "ep" : "ch"} · ${entry.progress}/${entry.total ?? "?"}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(atEnd),
        new ButtonBuilder()
          .setCustomId(RATE_ID)
          .setLabel(entry.score ? `★ ${entry.score}` : "Rate")
          .setStyle(ButtonStyle.Secondary)
      );
    },

    /** Runs the click. Resolves true when the result's list state changed. */
    async handle(button, index) {
      if (!Number.isFinite(mediaIds[index])) {
        await button.reply({
          content: "Could not match this result to an AniList entry.",
          flags: MessageFlags.Ephemeral
        });
        return false;
      }

      const flow = {
        [ADD_ID]: { run: runAdd, action: "adding this to your list" },
        [REMOVE_ID]: { run: runRemove, action: "removing this from your list" },
        [PROGRESS_ID]: { run: runProgress, action: "updating your progress" },
        [RATE_ID]: { run: runRate, action: "saving your score" }
      }[button.customId];

      try {
        return await flow.run(button, index);
      } catch (error) {
        console.error("AniList list edit failed:", error.name, error.reason ?? "", error.status ?? "");
        const content = describeAniListError(error, flow.action);

        // Add and Remove report into their own ephemeral prompt. The other two
        // acknowledged the search result itself, and editing that would wipe
        // the result, so they report in a new message instead.
        if (button.customId === ADD_ID || button.customId === REMOVE_ID) {
          await button.editReply({ content, components: [], embeds: [] }).catch(() => {});
        } else {
          await button.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return false;
      }
    }
  };
}

module.exports = { createListControls, parseScore };
