// A single MongoClient is shared by the whole process: the driver keeps its own
// connection pool, so opening a client per command would waste connections and
// pay the handshake cost every time.

const { MongoClient, ServerApiVersion } = require("mongodb");

// The connection string points at a cluster, not a database, so the database
// name is configured separately.
const DEFAULT_DB_NAME = "miru";

let client = null;
let db = null;
let connecting = null;

/**
 * Opens the shared connection. Safe to call more than once: concurrent callers
 * await the same in-flight attempt, and later calls reuse the open client.
 */
function connect() {
  if (db) return Promise.resolve(db);
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return Promise.reject(new Error("Missing MONGODB_URI in environment."));
  }

  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true
    }
  });

  connecting = client
    .connect()
    .then(async (connected) => {
      const database = connected.db(process.env.MONGODB_DB || DEFAULT_DB_NAME);
      // `connect()` resolves once the pool is set up; a ping confirms the
      // credentials and network path actually work before the bot goes live.
      await database.command({ ping: 1 });

      db = database;
      console.log(`Connected to MongoDB database "${database.databaseName}".`);
      return db;
    })
    .catch(async (error) => {
      // Leave no half-open client behind, so a later retry starts clean.
      await client.close().catch(() => {});
      client = null;
      throw error;
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

/**
 * Returns the connected database. Throws if `connect()` has not finished, which
 * keeps the failure at the call site instead of surfacing as a null deref.
 */
function getDb() {
  if (!db) {
    throw new Error("MongoDB is not connected. Call connect() during startup.");
  }
  return db;
}

function getCollection(name) {
  return getDb().collection(name);
}

async function close() {
  if (!client) return;
  const closing = client.close();
  client = null;
  db = null;
  await closing;
}

module.exports = { connect, getDb, getCollection, close };
