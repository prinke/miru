// Loads the optional premium module: paid features kept in a private
// repository and checked out into `premium/` at the project root.
//
// The public bot is complete without it. When the directory is absent (any
// self-hosted copy), this resolves to an empty module and nothing changes.
//
// The module exports the same shapes the core already uses:
//   {
//     commands: [{ data, execute, autocomplete?, components?, ensureIndexes? }],
//     jobs:     [{ name, intervalMs, run(client), ensureIndexes? }],
//     setup?(client)   called once before login, e.g. to listen for events
//   }

const fs = require("node:fs");
const path = require("node:path");

const PREMIUM_DIR = path.join(__dirname, "..", "..", "premium");

const EMPTY = Object.freeze({ commands: [], jobs: [], setup: null });

let loaded = null;

function loadPremium() {
  if (loaded) return loaded;

  if (!fs.existsSync(path.join(PREMIUM_DIR, "index.js"))) {
    loaded = EMPTY;
    return loaded;
  }

  // A premium module that is present but broken is a deploy mistake, so it
  // fails startup loudly rather than quietly shipping the free bot.
  const premium = require(PREMIUM_DIR);
  loaded = {
    commands: premium.commands || [],
    jobs: premium.jobs || [],
    setup: premium.setup || null
  };
  console.log(`Premium module loaded: ${loaded.commands.length} commands, ${loaded.jobs.length} jobs.`);
  return loaded;
}

module.exports = { loadPremium };
