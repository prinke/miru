const { createListCommand } = require("../lib/list-command");
const { ACCENT } = require("../lib/embeds");

module.exports = createListCommand({
  type: "ANIME",
  name: "animelist",
  label: "anime list",
  profilePath: "animelist",
  accent: ACCENT.anime
});
