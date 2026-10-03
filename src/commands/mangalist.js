const { createListCommand } = require("../lib/list-command");
const { ACCENT } = require("../lib/embeds");

module.exports = createListCommand({
  type: "MANGA",
  name: "mangalist",
  label: "manga list",
  profilePath: "mangalist",
  accent: ACCENT.manga
});
