// Storage for linked accounts.
//
// The Discord user id is the document `_id`: it is already unique and stable,
// so it needs no separate index and every lookup is a primary-key hit.

const { getCollection } = require("./db");
const { seal, open } = require("./token-vault");

const COLLECTION = "users";

function users() {
  return getCollection(COLLECTION);
}

async function ensureIndexes() {
  // Supports the reverse lookup (which Discord user owns this AniList account);
  // sparse because most documents will not have a link until one is made.
  await users().createIndex({ "anilist.id": 1 }, { name: "anilist_id", sparse: true });
  // The alert job reads every opted-in user on each tick that has episodes.
  await users().createIndex({ "alerts.enabled": 1 }, { name: "alerts_enabled", sparse: true });
  // Server feeds and server-wide features look members up by server.
  await users().createIndex({ servers: 1 }, { name: "servers", sparse: true });
}

/**
 * Stores (or replaces) a user's AniList link. The token is sealed here rather
 * than by the caller so no code path can write a plaintext token by accident.
 */
async function linkAniList(discordId, { account, accessToken, expiresAt }) {
  const now = new Date();

  await users().updateOne(
    { _id: discordId },
    {
      $set: {
        anilist: {
          id: account.id,
          name: account.name,
          siteUrl: account.siteUrl,
          avatar: account.avatar,
          token: seal(accessToken),
          expiresAt,
          linkedAt: now
        },
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
}

/** The public half of a link: everything except the token. */
async function getAniListLink(discordId) {
  const user = await users().findOne(
    { _id: discordId },
    { projection: { "anilist.token": 0 } }
  );

  const link = user?.anilist;
  if (!link) return null;

  return { ...link, expired: link.expiresAt instanceof Date && link.expiresAt <= new Date() };
}

/**
 * Decrypts the stored access token. Kept separate from `getAniListLink` so that
 * displaying a link never pulls the credential into memory.
 */
async function getAniListToken(discordId) {
  const user = await users().findOne(
    { _id: discordId },
    { projection: { "anilist.token": 1, "anilist.expiresAt": 1 } }
  );

  const link = user?.anilist;
  if (!link?.token) return null;
  if (link.expiresAt instanceof Date && link.expiresAt <= new Date()) return null;

  return open(link.token);
}

/**
 * Removes the link and reports what was removed, so the caller can name the
 * account it just detached. The rest of the document is left alone.
 */
async function unlinkAniList(discordId) {
  const previous = await users().findOneAndUpdate(
    { _id: discordId, anilist: { $exists: true } },
    { $unset: { anilist: "" }, $set: { updatedAt: new Date() } },
    { returnDocument: "before", projection: { "anilist.name": 1, "anilist.id": 1 } }
  );

  // The driver returns the document directly, but older/`includeResultMetadata`
  // shapes wrap it in `value`.
  const document = previous?.value ?? previous;
  return document?.anilist ?? null;
}

/**
 * Turns episode alerts on or off. Muted shows are kept across a toggle so
 * turning alerts back on does not bring back shows the user silenced.
 */
async function setAlerts(discordId, enabled) {
  const now = new Date();
  await users().updateOne(
    { _id: discordId },
    {
      $set: { "alerts.enabled": enabled, "alerts.changedAt": now, updatedAt: now },
      // A fresh opt-in is a fresh chance to deliver, so an old failure is dropped.
      $unset: { "alerts.undeliverableAt": "" },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
}

async function getAlerts(discordId) {
  const user = await users().findOne({ _id: discordId }, { projection: { alerts: 1 } });
  return {
    enabled: user?.alerts?.enabled === true,
    muted: user?.alerts?.muted || [],
    undeliverableAt: user?.alerts?.undeliverableAt || null
  };
}

async function muteAlert(discordId, mediaId) {
  await users().updateOne({ _id: discordId }, { $addToSet: { "alerts.muted": mediaId } });
}

async function clearMutedAlerts(discordId) {
  await users().updateOne({ _id: discordId }, { $set: { "alerts.muted": [] } });
}

async function markAlertsUndeliverable(discordId) {
  await users().updateOne({ _id: discordId }, { $set: { "alerts.undeliverableAt": new Date() } });
}

/**
 * Everyone who should be considered for an alert, as
 * `Map<anilistId, [{ discordId, muted }]>`. One AniList account can be linked
 * from more than one Discord account, hence the array.
 */
async function alertRecipients() {
  const cursor = users().find(
    { "alerts.enabled": true, "anilist.id": { $exists: true }, "anilist.expiresAt": { $gt: new Date() } },
    { projection: { "anilist.id": 1, "alerts.muted": 1 } }
  );

  const recipients = new Map();
  for await (const user of cursor) {
    const list = recipients.get(user.anilist.id) || [];
    list.push({ discordId: user._id, muted: new Set(user.alerts?.muted || []) });
    recipients.set(user.anilist.id, list);
  }
  return recipients;
}

/**
 * Opting in to a server: the user's AniList activity may be posted in its feed
 * and their public list used for its server-wide features. Membership is per
 * server and explicit, because a Discord bot cannot otherwise tell which of its
 * servers someone would be happy to be shown in.
 */
async function joinServer(discordId, guildId) {
  // Matching only when the server is absent makes the result say whether this
  // call changed anything; `updatedAt` alone would always count as a change.
  const result = await users().updateOne(
    { _id: discordId, servers: { $ne: guildId } },
    { $addToSet: { servers: guildId }, $set: { updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

async function leaveServer(discordId, guildId) {
  const result = await users().updateOne(
    { _id: discordId, servers: guildId },
    { $pull: { servers: guildId }, $set: { updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

async function getServers(discordId) {
  const user = await users().findOne({ _id: discordId }, { projection: { servers: 1 } });
  return user?.servers || [];
}

/** Linked users who joined `guildId`, as `[{ discordId, anilist: { id, name, avatar } }]`. */
async function serverMembers(guildId) {
  const cursor = users().find(
    { servers: guildId, "anilist.id": { $exists: true } },
    { projection: { "anilist.id": 1, "anilist.name": 1, "anilist.avatar": 1 } }
  );
  const members = [];
  for await (const user of cursor) members.push({ discordId: user._id, anilist: user.anilist });
  return members;
}

/**
 * Members of any of `guildIds`, as `Map<anilistId, [{ discordId, servers }]>`
 * where `servers` is limited to the ones asked about.
 */
async function membersOfServers(guildIds) {
  const wanted = new Set(guildIds);
  const cursor = users().find(
    { servers: { $in: guildIds }, "anilist.id": { $exists: true } },
    { projection: { "anilist.id": 1, servers: 1 } }
  );

  const members = new Map();
  for await (const user of cursor) {
    const list = members.get(user.anilist.id) || [];
    list.push({ discordId: user._id, servers: user.servers.filter((id) => wanted.has(id)) });
    members.set(user.anilist.id, list);
  }
  return members;
}

module.exports = {
  COLLECTION,
  joinServer,
  leaveServer,
  getServers,
  serverMembers,
  membersOfServers,
  setAlerts,
  getAlerts,
  muteAlert,
  clearMutedAlerts,
  markAlertsUndeliverable,
  alertRecipients,
  ensureIndexes,
  linkAniList,
  getAniListLink,
  getAniListToken,
  unlinkAniList
};
