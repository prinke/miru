require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { REST, Routes } = require("discord.js");
const { loadPremium } = require("./lib/premium");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment.");
}

if (!clientId) {
  throw new Error("Missing DISCORD_CLIENT_ID in environment.");
}

const commands = [];
const commandsPath = path.join(__dirname, "commands");
const commandModules = fs.readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"))
  .map((file) => require(path.join(commandsPath, file)));

for (const command of [...commandModules, ...loadPremium().commands]) {
  if (command?.data) {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    if (guildId) {
      console.log(`Registering ${commands.length} guild commands...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands
      });
      console.log("Guild commands registered.");
      return;
    }

    console.log(`Registering ${commands.length} global commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Global commands registered.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
