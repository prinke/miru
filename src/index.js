require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { Client, Collection, Events, GatewayIntentBits } = require("discord.js");

const db = require("./lib/db");
const users = require("./lib/users");
const scheduler = require("./lib/scheduler");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.commands = new Collection();
// Buttons and modals that must keep working after a restart (such as the ones
// on an alert DM) cannot rely on an in-memory collector. Their custom ids are
// "<prefix>:<args>", and the prefix picks the module that handles them.
client.componentHandlers = new Collection();

const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if (command?.data && command?.execute) {
    client.commands.set(command.data.name, command);
  }
  for (const [prefix, handler] of Object.entries(command?.components || {})) {
    client.componentHandlers.set(prefix, handler);
  }
}

const jobsPath = path.join(__dirname, "jobs");
const jobs = fs.readdirSync(jobsPath)
  .filter((file) => file.endsWith(".js"))
  .map((file) => require(path.join(jobsPath, file)));

for (const job of jobs) {
  scheduler.register(job.name, job.intervalMs, () => job.run(client));
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  scheduler.start();
});

async function reportError(interaction, error) {
  console.error(error);
  const message = "There was an error while executing this command.";

  try {
    if (interaction.deferred && !interaction.replied) {
      // Replace the "thinking" placeholder instead of leaving it hanging.
      await interaction.editReply({ content: message });
    } else if (interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  } catch (replyError) {
    console.error("Failed to report command error to the user:", replyError);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    try {
      await command?.autocomplete?.(interaction);
    } catch (error) {
      // An autocomplete that fails just shows no suggestions; there is nothing
      // to reply with.
      console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
    }
    return;
  }

  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    // Ids without a registered prefix belong to a collector somewhere, which
    // receives the interaction on its own.
    const handler = client.componentHandlers.get(interaction.customId.split(":")[0]);
    if (!handler) return;

    try {
      await handler(interaction);
    } catch (error) {
      await reportError(interaction, error);
    }
    return;
  }

  // Slash commands and right-click (context menu) commands share one registry.
  if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    await reportError(interaction, error);
  }
});

// Discord will not reconnect a client that has been destroyed, so shutdown is
// one-way: close both sides and exit.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);
  scheduler.stop();

  try {
    await client.destroy();
  } catch (error) {
    console.error("Failed to close the Discord client cleanly:", error);
  }

  try {
    await db.close();
  } catch (error) {
    console.error("Failed to close the MongoDB connection cleanly:", error);
  }

  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

async function main() {
  if (!process.env.DISCORD_TOKEN) {
    throw new Error("Missing DISCORD_TOKEN in environment.");
  }

  // Connect first: commands assume the database is available once the bot is
  // logged in and answering interactions.
  await db.connect();
  await users.ensureIndexes();
  for (const owner of [...client.commands.values(), ...jobs]) await owner.ensureIndexes?.();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(async (error) => {
  console.error("Startup failed:", error);
  await db.close().catch(() => {});
  process.exit(1);
});
