// Walks the airing schedule forward from wherever the last run stopped.

const { deliverAlerts, ensureIndexes } = require("../lib/episode-alerts");
const { getState, setState } = require("../lib/state");

const CURSOR_KEY = "airing-alerts.cursor";
const INTERVAL_MS = 5 * 60 * 1000;
// After a long outage, an alert for an episode that aired a day ago is noise
// rather than news, so catching up stops this far back.
const MAX_CATCH_UP_SECONDS = 3 * 60 * 60;

module.exports = {
  name: "airing-alerts",
  intervalMs: INTERVAL_MS,
  ensureIndexes,

  async run(client) {
    const now = Math.floor(Date.now() / 1000);
    const cursor = await getState(CURSOR_KEY);
    // A first run starts from now: alerting on everything that aired before
    // the bot existed would be a flood.
    const from = Math.max(cursor ?? now, now - MAX_CATCH_UP_SECONDS);
    if (from >= now) {
      if (cursor === null) await setState(CURSOR_KEY, now);
      return;
    }

    const sent = await deliverAlerts(client, { from, to: now });
    // Only advanced once the window is done, so a failed run is retried; the
    // notification records keep a retry from sending anything twice.
    await setState(CURSOR_KEY, now);
    if (sent > 0) console.log(`Sent ${sent} episode alert${sent === 1 ? "" : "s"}.`);
  }
};
