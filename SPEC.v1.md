# Chroma Clash: project spec

"Chroma Clash" is a working title; rename it freely.

This document is the starting brief for building the project in a Claude Code session. It describes what the game is, which decisions are fixed, which are only defaults, and the order to build things in. Read it fully before writing code, then start with milestone 1.

## 1. What we are building

A stream overlay game for Twitch in which the chatters of one channel are the players. It is inspired by Intro Fighters (an overlay game where chatters spawn as fighters and battle automatically), with one difference in goal: this game is meant to matter over weeks, not one break.

It has two layers:

1. **Background layer.** Runs quietly whenever the streamer has the game on. Chatters earn rewards for being active in chat. Nothing dramatic appears on screen.
2. **Guild Fight.** An event the streamer starts on purpose, typically during breaks, intros, and outros. Guilds fight automatically over a territory on a persistent map. Rewards earned in the background layer make a guild stronger in the fight.

Guilds are derived from each chatter's Twitch name color.

The loop: chat, earn, fight, hold territory, earn slightly more.

## 2. Decisions and their status

**Fixed (decided by the project owner):**

- Chat is read over Twitch IRC.
- State is per channel. There is no central server and no cross-channel leaderboard.
- The streamer controls when the game runs and when a Guild Fight starts.
- Fights are fully automated; chatters do not control their fighter.
- Guilds come from name colors.
- Progress persists between streams.

**Defaults (chosen for this spec, open to change):**

- Tech stack (section 8).
- All numbers: tick length, XP amounts, map size, fight duration, guild count.
- The game only reads chat and never sends messages, so feedback appears on the overlay, not in chat.
- Fights are a free-for-all between all guilds for one tile.

When a default turns out to be awkward during implementation, say so and propose an alternative before changing it.

## 3. Background layer

Time is cut into windows of 5 minutes. A chatter who writes at least one message in a window earns one **tick** for that window. More messages in the same window earn nothing extra, which keeps the game from rewarding spam.

Each tick gives:

- 10 XP to the chatter.
- 1 point to the war chest of the chatter's guild.

Each tile a guild owns adds 1 point to its war chest per window in which at least one of its members earned a tick.

Levels come from XP on a curve that slows down (suggestion: level n needs `50 * n^2` total XP). Levels give a small bonus in fights, capped so that veterans do not flatten newcomers: +2% fighter health per level, capped at +30%.

Messages from the broadcaster and from known bots (a configurable list of names) earn nothing.

## 4. Guilds

There are 6 guilds, assigned by the hue of the chatter's name color (the `color` tag, a hex string like `#1E90FF`).

| Guild  | Hue range (degrees) |
|--------|---------------------|
| Red    | 345 to 15           |
| Gold   | 15 to 70            |
| Green  | 70 to 165           |
| Teal   | 165 to 200          |
| Blue   | 200 to 260          |
| Purple | 260 to 345          |

Rules:

- Convert the hex color to HSL. If saturation is below 0.15, or lightness is below 0.1 or above 0.9, the color has no usable hue.
- If the `color` tag is empty or has no usable hue, assign a guild by hashing the `user-id`, so the result is stable.
- A chatter's guild is **locked for the season** the first time they are seen. Changing their Twitch color later does not move them. This prevents everyone from jumping to the winning guild.
- The fighter is drawn in the chatter's real current color, so the lock does not look wrong on screen in most cases.

## 5. Guild Fight

### Start

The streamer starts a fight from the control panel, or the broadcaster or a moderator types `!guildfight` in chat (role is read from the `badges` tag).

Everyone who earned a tick in the last 30 minutes spawns automatically. Chatters who write during the first 30 seconds of the fight also join. Lurkers who were active earlier therefore still take part, and a break does not need chat to wake up first.

### The contested tile

The map is a 3x3 grid of tiles, all neutral at the start of a season. Each fight is over one tile, picked by the streamer or at random. All guilds with at least one fighter take part.

### Combat

Combat is a simple automatic simulation:

- Fighters are circles with the chatter's name, in the chatter's color.
- Each fighter moves toward the nearest enemy and attacks on contact.
- Base values: 100 health, 10 damage per hit, one hit per second. Treat these as tuning values in a config file.

Modifiers:

- **Level:** +2% health per level, capped at +30% (section 3).
- **War chest:** at fight start the guild's chest is spent. Every 10 points gives the whole guild +1% damage, capped at +25%. The chest is then set to 0.
- **Champion:** in each guild, the member with the most ticks in the current session spawns larger, with triple health.
- **Size balance:** guilds will be uneven. Multiply each fighter's health and damage by `sqrt(averageGuildSize / ownGuildSize)`, clamped to the range 0.6 to 1.8.

### End

The fight ends when one guild remains, or after 3 minutes. At the time limit, the guild with the most total remaining health wins. The winner takes the tile. Results are written to the database: tile owner, and per chatter kills, deaths, and fights played.

Survivors and the winning guild's members get bonus XP (suggestion: 20 for taking part, 30 more for being in the winning guild).

## 6. Seasons

A season is a period with its own map and guild locks. The streamer ends a season from the control panel. Ending a season:

- Resets all tiles to neutral.
- Clears guild locks, so chatters are reassigned from their current color.
- Resets levels and war chests.
- Keeps lifetime statistics (total kills, fights, seasons won) and records the winning guild, which is the guild holding the most tiles.

## 7. Twitch IRC notes

Verify these against the current Twitch IRC documentation (dev.twitch.tv/docs/irc) before relying on them; details change.

- Connect to `wss://irc-ws.chat.twitch.tv:443` (WebSocket) or `irc.chat.twitch.tv:6697` (TLS). The non-TLS WebSocket endpoint has been shut down.
- After connecting, request capabilities: `CAP REQ :twitch.tv/tags twitch.tv/commands`.
- Read-only access has historically worked without a token by logging in with the nickname `justinfan` followed by random digits. Check that this still works. If it does not, the streamer must supply an OAuth token with the `chat:read` scope, sent as `PASS oauth:<token>`.
- Answer `PING` with `PONG`, and reconnect when the server sends `RECONNECT`. Reconnect with backoff on connection loss.
- Slash commands cannot be sent over IRC. This does not affect a read-only game.

Tags the game uses on `PRIVMSG`:

| Tag            | Use                                              |
|----------------|--------------------------------------------------|
| `user-id`      | Primary key for a chatter. Names change, IDs do not. |
| `display-name` | Name shown on the fighter.                       |
| `color`        | Guild assignment and fighter color. May be empty. |
| `badges`       | Detect broadcaster and moderators for commands.  |
| `tmi-sent-ts`  | Message timestamp, used for tick windows.        |

`USERNOTICE` (raids, subs) is not used in version 1. See section 11 for ideas.

## 8. Tech stack and architecture

Default stack:

- Node.js with TypeScript.
- SQLite through `better-sqlite3`, one database file per channel.
- A local HTTP and WebSocket server.
- The overlay is a web page added to OBS as a browser source (1920x1080, transparent background), drawn on a canvas.
- The control panel is a second web page the streamer opens in a normal browser.

Modules:

- `src/irc/`: connection, IRCv3 message parser, reconnect handling. Emits typed chat events.
- `src/game/`: all game rules. Pure logic with no network, file, or clock access; time and randomness are passed in. This makes the rules testable and fights reproducible from a seed.
- `src/db/`: schema, migrations, queries.
- `src/server/`: HTTP routes for the control panel, WebSocket broadcast of game state to the overlay.
- `overlay/`: rendering only. It draws the state it receives and decides nothing.
- `control/`: the streamer's panel.

The fight simulation runs on the server at a fixed step (suggestion: 20 steps per second) and sends snapshots to the overlay.

### Data model

- `users`: `user_id` (primary key), `display_name`, `color`, `guild_id`, `xp`, `level`, lifetime `kills`, `deaths`, `fights`, `first_seen`, `last_seen`.
- `guilds`: `guild_id`, `name`, `war_chest`.
- `tiles`: `tile_id`, `x`, `y`, `owner_guild_id` (nullable).
- `ticks`: `user_id`, `window_start`, unique on both. Used for tick awards and for finding recently active chatters.
- `fights`: `fight_id`, `season_id`, `tile_id`, `started_at`, `ended_at`, `winner_guild_id`, `seed`.
- `seasons`: `season_id`, `started_at`, `ended_at`, `winner_guild_id`.

## 9. Streamer controls

The control panel offers:

- Connect to a channel; turn the background layer on and off.
- Start a Guild Fight, with a choice of tile or random, and stop a running fight.
- View the map, guild sizes, war chests, and a leaderboard.
- End the season.
- Exclude users (bots, banned users) from the game.
- Edit the tuning values from sections 3 and 5.

## 10. Milestones

Build in this order. Each milestone should run and be demonstrable before the next begins.

1. **IRC reader.** Connect to a channel, parse messages with tags, print typed events. Include unit tests for the parser using sample raw lines.
2. **Chat simulator.** A fake event source that generates chatters with random colors and message timing, so everything after this can be developed without a live stream. This matters; do not skip it.
3. **Database and guilds.** Schema, user upsert on each message, guild assignment with season lock. Tests for hue bucketing and the fallback hash.
4. **Tick system.** Windows, tick awards, XP, levels, war chest. Tests with a controlled clock.
5. **Server, overlay shell, control panel shell.** The overlay shows the map and guild standings; the panel can toggle the background layer.
6. **Fight simulation.** Pure logic first, with a seed and tests, then rendering in the overlay.
7. **Fight results and map.** Tile capture, statistics, bonus XP, tile bonuses in the tick system.
8. **Seasons and remaining controls.** Season end, exclusions, tuning values, `!guildfight` command.

## 11. Ideas for later (not in version 1)

- Only guilds adjacent to a tile may attack it, so the map shape matters.
- Raids arrive as an invading army that the home guilds must repel.
- Nemesis tracking: remember who killed whom most often and announce rematches.
- Bounties on chatters with long win streaks.
- Classes or weapon types as sidegrades, chosen with a chat command.
- One small decision per fight for chatters, such as a stance.
- Sending messages to chat (needs an OAuth token with `chat:edit` or the Send Chat Message API).

## 12. Open questions for the project owner

Ask about these when they become relevant; do not guess silently.

- Should chatters with no color set form their own "colorless" guild, or be spread over the six by hash (the current default)?
- Should subscribers, VIPs, or bits give anything? The default is no, to avoid pay-to-win.
- Should the game ever post in chat, for example fight results?
- How should a fight look visually: plain circles, emotes, or small characters?

## 13. Working agreements

- Keep game rules in `src/game/` free of side effects, and cover them with tests.
- Put every tuning number in one config module; no magic numbers in logic.
- Key all user data on `user-id`.
- Prefer small, working steps over large unfinished ones, and say clearly at the end of each milestone what works, what was left out, and what was not tested.
