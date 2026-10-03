# Miru - Anime & Manga Discord Bot

> 🚧 **Currently in active development**

Miru is a Discord bot that brings anime, manga, and character information directly to your Discord server or DMs. Powered by the [Jikan API](https://jikan.moe/) (unofficial MyAnimeList API), Miru provides rich, detailed information with an intuitive dropdown interface.

## Features

- 🎬 **Anime Search** - Search and browse anime with detailed information
  - Studios with clickable links
  - Genres, air dates, rankings
  - 600-character synopses
  - English/Japanese titles
  - Interactive dropdown to browse up to 25 results

- 📚 **Manga Search** - Comprehensive manga information
  - Authors with clickable links
  - Genres, publication dates, rankings
  - Chapter and volume counts
  - Interactive result browsing

- 👤 **Character Search** - Detailed character profiles
  - Anime and manga appearances
  - Japanese voice actors
  - Favorites count
  - Browse multiple character results

- 🔍 **Scene search** - Right-click any image → *Apps → What anime is this?* (or `/trace`) finds the anime, episode and timestamp via [trace.moe](https://trace.moe)
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

## Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env and add your Discord bot token and application ID
   ```

3. **Register commands:**
   ```bash
   npm run deploy
   ```

4. **Start the bot:**
   ```bash
   npm start
   ```

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
- MongoDB
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) for Wrapped cards
- Node.js

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- MyAnimeList for the anime/manga data
- [Jikan](https://jikan.moe/) for the awesome API
