// Posts new AniList activity from server members into their servers' feeds.

const { fetchNewActivities, postActivities } = require("../lib/activity-feed");
const guilds = require("../lib/guilds");
const users = require("../lib/users");
const { getState, setState } = require("../lib/state");

const CURSOR_KEY = "activity-feed.lastActivityId";
const INTERVAL_MS = 3 * 60 * 1000;

module.exports = {
  name: "activity-feed",
  intervalMs: INTERVAL_MS,

  async run(client) {
    const feeds = await guilds.activeFeeds();
    if (feeds.size === 0) return;

    const members = await users.membersOfServers([...feeds.keys()]);
    if (members.size === 0) return;

    const cursor = await getState(CURSOR_KEY);
    const { activities, newestId } = await fetchNewActivities([...members.keys()], cursor);

    if (activities.length > 0) {
      const posted = await postActivities(client, { activities, feeds, members });
      if (posted > 0) console.log(`Posted ${posted} feed update${posted === 1 ? "" : "s"}.`);
    }
    if (newestId > (cursor ?? 0)) await setState(CURSOR_KEY, newestId);
  }
};
