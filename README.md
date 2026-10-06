# Miru - Anime & Manga Discord Bot

> 🚧 **Currently in active development**

Miru is a Discord bot for anime and manga that works in servers and DMs (it can be installed to a server or to your account). It pulls data from [AniList](https://anilist.co/), falls back to [Jikan](https://jikan.moe/) (MyAnimeList) when AniList is down, and identifies screenshots with [trace.moe](https://trace.moe). Link an AniList account and it can also manage your lists, DM you when new episodes air, compare taste between friends, and post a server activity feed.

## Features

- 🎬 **Anime Search** - Search and browse anime with detailed information
  - Studio, score, rank, format, episode count and runtime
  - Season, air dates, genres and source material
  - Next-episode countdown for airing shows
  - English and romaji titles, AniList banner art
  - Interactive dropdown to browse up to 25 results

- 📚 **Manga Search** - Comprehensive manga information
  - Authors, score, rank and genres
  - Publication dates
  - Chapter and volume counts
  - Interactive result browsing

- 👤 **Character Search** - Detailed character profiles
  - Anime and manga appearances
  - Japanese voice actors
  - Favorites count
  - Browse multiple character results

- 🔍 **Scene search** - Right-click any image → *Apps → What anime is this?* (or `/trace`) finds the anime, episode and timestamp via [trace.moe](https://trace.moe)
- 🔁 **Fallback** - If AniList is unavailable, searches transparently fall back to Jikan; each result's footer shows where it came from
- 📅 **Seasonal chart** - `/season` browses any season by popularity, score or trend, with your list status tagged on each show

### With a linked AniList account

- 🔗 **Account linking** - `/link` connects AniList (tokens are encrypted at rest)
- 📋 **Lists** - Browse your anime and manga lists by status
- ➕ **Quick progress** - Search results get Add/Remove, **+1 ep** and **Rate** buttons; `/progress` logs episodes, chapters and scores with autocomplete from your list
- 🔔 **Episode alerts** - A DM when a new episode of something you're watching airs, with **Mark watched**, **Mute** and **Watch on…** buttons
- 💞 **Compatibility** - `/compat` scores how alike two people's taste is, with shared favourites, disagreements and picks for each side
- 📣 **Server feed** - Members who opt in have their AniList activity posted to a channel
- ✨ **Recommendations** - Personal picks from your favourites, or "nobody here has seen these" for a whole server
- 🎁 **Wrapped** - A shareable year-in-review card with server and global rankings

## Self-hosting

> Most people should just [invite the hosted bot](#installation-links). Self-hosting is for developers and is not officially supported. Self-hosted copies include every feature in this repository. Paid features planned for the hosted bot won't be included.

### Prerequisites

- Node.js 18 or newer
- A Discord application and bot token ([Developer Portal](https://discord.com/developers/applications))
- A MongoDB database (e.g. a free Atlas cluster)
- An AniList API client ([anilist.co/settings/developer](https://anilist.co/settings/developer)) with its Redirect URL set to exactly `https://anilist.co/api/v2/oauth/pin`
- Optional: a [trace.moe](https://trace.moe) API key (without one, scene search shares a quota of 100 searches/month per server IP)

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | ✅ | Bot token |
   | `DISCORD_CLIENT_ID` | ✅ | Application ID |
   | `MONGODB_URI` | ✅ | MongoDB connection string |
   | `MONGODB_DB` | | Database name (defaults to `miru`) |
   | `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` | ✅ | AniList OAuth client for `/link` |
   | `ANILIST_REDIRECT_URI` | | Only if your AniList client doesn't use the pin page |
   | `TOKEN_ENCRYPTION_KEY` | ✅ | Encrypts stored AniList tokens. Generate with `openssl rand -hex 32`. Changing it invalidates every existing link |
   | `TRACE_MOE_API_KEY` | | Higher trace.moe quota |
   | `GUILD_ID` | | Register commands to one server only (instant updates while developing) |

3. **Register commands:**
   ```bash
   npm run deploy
   ```
   With `GUILD_ID` set, commands are registered to that server only; otherwise they're registered globally.

4. **Start the bot:**
   ```bash
   npm start
   ```

### Deploying with Dokku

The `Procfile` defines a `worker` process (the bot; it serves no HTTP) and a `release` step that re-registers slash commands on every deploy.

On the server:
```bash
dokku apps:create miru
dokku config:set --no-restart miru DISCORD_TOKEN=... DISCORD_CLIENT_ID=... MONGODB_URI=... \
  ANILIST_CLIENT_ID=... ANILIST_CLIENT_SECRET=... TOKEN_ENCRYPTION_KEY=...
dokku checks:disable miru          # stop the old bot before starting the new one
dokku ps:scale --skip-deploy miru web=0 worker=1
```

Locally:
```bash
git remote add dokku dokku@YOUR_SERVER:miru
git push dokku master
```

(The official deployment uses `scripts/deploy.sh` instead, which also ships the private premium module. You don't need it for a self-hosted copy.)

Logs: `dokku logs miru -t`. Leave `GUILD_ID` unset in production so commands register globally.

## Commands

### Search
- `/anime <query>` - Search for anime by title
- `/manga <query>` - Search for manga by title
- `/character <query>` - Search for characters by name
- `/season [season] [year] [sort] [format]` - Seasonal chart; open any show for details and list buttons
- `/trace [image] [url]` - Find the anime, episode and moment a screenshot is from
- *What anime is this?* (message menu) - The same, on an image someone posted
- `/ping` - Check bot latency

### AniList
- `/link` / `/unlink` - Connect or disconnect your AniList account
- `/animelist [status]` / `/mangalist [status]` - Browse your lists
- `/progress <title> [episode] [score]` - Log progress (defaults to +1) or set a score
- `/alerts on|off|status` - Episode alerts by DM, and what airs next on your Watching list
- `/compat [user] [username] [type]` - Compare taste with a linked member or any AniList user
- `/recommend [for] [type] [genre]` - Recommendations for you or the whole server
- `/wrapped [year]` - Your year in review as an image card

### Server feed (server install only)
- `/feed setup <channel> [mode]` - Choose the feed channel; `highlights` or `everything` (Manage Server)
- `/feed disable` - Turn the feed off (Manage Server)
- `/feed join` / `/feed leave` - Opt in or out of sharing your activity in this server
- `/feed status` - Current settings

Joining a server's feed also includes you in that server's `/recommend for:server` and `/wrapped` ranking. Nobody is included without running `/feed join`.

## Background jobs

The bot runs two jobs on timers, both cursor-based so a restart neither repeats nor skips anything:

- **Episode alerts** (every 5 min): one request lists episodes that just aired, one more finds which opted-in users are watching them. Entries marked *private* on AniList are not seen by this check.
- **Server feed** (every 3 min): one request reads new list activity for every feed member across all servers.

## Installation Links

Replace `YOUR_CLIENT_ID` with your application ID.

- **Guild install (server installation)** — includes View Channel, Send Messages and Embed Links for the server feed
  ```
  https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=19456&integration_type=0
  ```

- **User install (personal installation)**
  ```
  https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=applications.commands&integration_type=1
  ```

## Tech Stack

- [Discord.js](https://discord.js.org/) v14
- [AniList GraphQL API](https://docs.anilist.co/) (primary) and [Jikan API](https://docs.api.jikan.moe/) v4 (fallback)
- [trace.moe API](https://soruly.github.io/trace.moe-api/) for scene search
- MongoDB
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) for Wrapped cards
- Node.js

## License

Miru is licensed under the GNU Affero General Public License v3.0 (AGPLv3). See the [LICENSE](LICENSE) file for details.

In short: you can use, modify and run your own copy. If you run a modified version that other people use, including as a public Discord bot, you must make your modified source code available to those users under the same license.

Paid features planned for the hosted Miru bot will not be part of this repository.

**Name and branding:** the license covers the code, not the name. If you run a public fork, give it a different name and avatar so it isn't mistaken for the official Miru.

## Acknowledgments

- [AniList](https://anilist.co/) for its GraphQL API
- [Jikan](https://jikan.moe/) and MyAnimeList for the fallback data
- [trace.moe](https://trace.moe) for scene search
