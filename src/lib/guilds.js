// Per-server settings. The guild id is the document `_id`.

const { getCollection } = require("./db");

function guilds() {
  return getCollection("guilds");
}

async function setFeed(guildId, { channelId, mode, enabledBy }) {
  const now = new Date();
  await guilds().updateOne(
    { _id: guildId },
    {
      $set: { feed: { channelId, mode, enabledBy, enabledAt: now }, updatedAt: now },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
}

async function disableFeed(guildId) {
  await guilds().updateOne({ _id: guildId }, { $unset: { feed: "" }, $set: { updatedAt: new Date() } });
}

async function getFeed(guildId) {
  const guild = await guilds().findOne({ _id: guildId }, { projection: { feed: 1 } });
  return guild?.feed ?? null;
}

/** `Map<guildId, feed>` for every server with a feed channel. */
async function activeFeeds() {
  const feeds = new Map();
  for await (const guild of guilds().find({ "feed.channelId": { $exists: true } }, { projection: { feed: 1 } })) {
    feeds.set(guild._id, guild.feed);
  }
  return feeds;
}

module.exports = { setFeed, disableFeed, getFeed, activeFeeds };
