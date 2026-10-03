// Small named values the background jobs need to survive a restart, such as how
// far through the airing schedule the alert job has got.

const { getCollection } = require("./db");

function state() {
  return getCollection("state");
}

async function getState(key) {
  const document = await state().findOne({ _id: key });
  return document?.value ?? null;
}

async function setState(key, value) {
  await state().updateOne(
    { _id: key },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = { getState, setState };
