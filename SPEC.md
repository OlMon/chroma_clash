# Chroma Clash: project spec

"Chroma Clash" is a working title; rename it freely.

This document is the starting brief for building the project in a Claude Code session. It describes what the game is, which decisions are fixed, which are only defaults, and the order to build things in. Read it fully before writing code, then start with milestone 1.

Version 2 of the spec. The first version (six guilds, square map, war chest) is kept in `SPEC.v1.md` for reference only.

## 1. What we are building

A stream overlay game for Twitch in which the chatters of one channel are the players. It is inspired by Intro Fighters (an overlay game where chatters spawn as fighters and battle automatically), with one difference in goal: this game is meant to matter over weeks, not one break.

Three guilds, derived from each chatter's Twitch name color, each own a city on a corner of a hex map. The streamer takes part as a god (section 9). The game has four parts:

1. **Background layer.** Runs quietly whenever the streamer has the game on. Chatters who are active in chat earn XP, build up their guild's city, and slowly claim neutral land. Nothing dramatic appears on screen.
2. **War.** An event the streamer starts on purpose, typically during breaks, intros, and outros. Each guild attacks a border tile of a neighbor in a short automatic battle.
3. **Hero Clash.** A second, shorter event the streamer can start. The most active chatters of each guild fight a small tournament for a temporary guild XP boost.
4. **God events.** The streamer descends as a god: either against the leading guild to knock a tile back to neutral, or against all of chat as a boss fight.

The loop: chat, build the city, expand, go to war, hold territory.

**Chat stays passive.** Chatters never have to type a command. Everything they contribute comes from chatting normally.

## 2. Decisions and their status

**Fixed (decided by the project owner):**

- Chat is read over Twitch IRC.
- State is per channel. There is no central server and no cross-channel leaderboard.
- The streamer controls when the game runs and when a War, Hero Clash, or god event starts.
- The streamer appears in the game as a god, with two events: God's Wrath against the strongest guild, and Streamer vs Chat against everyone.
- Fights are fully automated; chatters do not control their fighter.
- Guilds come from name colors. There are three guilds.
- Progress persists between streams.
- No chat commands for chatters. The game must not change how people chat.
- The map is a hex map with one city per guild.
- Hero Clash uses three-way heats, not 1-on-1 duels.
- The broadcaster and moderators may start a War with `!war`. This is the only chat command.

**Defaults (chosen for this spec, open to change):**

- Tech stack (section 11).
- The details of the god events: target choice, god strength, rewards (section 9).
- All numbers: window length, XP amounts, building costs and effects, claim speed, battle duration.
- Professions as the way ticks are distributed over buildings (section 5).
- The game only reads chat and never sends messages, so feedback appears on the overlay, not in chat.

When a default turns out to be awkward during implementation, say so and propose an alternative before changing it.

## 3. Background layer

Time is cut into windows of 5 minutes. A chatter who writes at least one message in a window earns one **tick** for that window. More messages in the same window earn nothing extra, which keeps the game from rewarding spam.

Each tick gives:

- 10 XP to the chatter, plus 1 XP per tile the guild owns besides its city, capped at +6.
- 1 development point to the guild's land (section 5).

Levels come from XP on a curve that slows down (suggestion: level n needs `50 * n^2` total XP). Levels give a small bonus in battles, capped so that veterans do not flatten newcomers: +2% fighter health per level, capped at +30%.

Messages from the broadcaster and from known bots (a configurable list of names) earn nothing.

### Channel size

The game must feel the same for a channel with 5 chatters and one with 5,000. Without scaling, a large chat would max its cities in minutes and a small one would never see a level.

- **What is measured:** the average number of chatters who earn a tick per window ("active chatters"). This is measured by the game itself. Viewer counts are not used: they need an authenticated API, and viewers who never chat do not play.
- **Scale:** `activeChatters / 25`, where 25 is the size the numbers in this spec are tuned for (about 60 people chatting at some point in a stream). Development costs (section 5) are multiplied by the scale and never fall below 1 point.
- **When it changes:** the scale is re-measured when a session starts, over the last 5 sessions. It stays fixed during a stream, so chatting more always builds faster within a stream. In the very first 30 minutes of a new channel it is re-measured every window.
- **Override:** the streamer can set the number of active chatters by hand in the control panel, or leave it on automatic.

What does not need scaling: XP and levels (per person), claim speed (per window, not per tick), and the god's health (per opposing fighter).

A **session** runs from the moment the streamer turns the background layer on until it is turned off. "Most active this session" means most ticks within the session.

## 4. Guilds

There are 3 guilds, assigned by the hue of the chatter's name color (the `color` tag, a hex string like `#1E90FF`). Ranges are half-open: the lower bound belongs to the range.

| Guild | Hue range (degrees) |
|-------|---------------------|
| Red   | 300 to 60           |
| Green | 60 to 180           |
| Blue  | 180 to 300          |

Rules:

- Convert the hex color to HSL. If saturation is below 0.15, or lightness is below 0.1 or above 0.9, the color has no usable hue.
- If the `color` tag is empty or has no usable hue, assign a guild by hashing the `user-id`, so the result is stable.
- **Very small channels:** while fewer than 15 chatters are known in the season, a new chatter whose color guild is not among the smallest guilds is put into one of the smallest instead (chosen by the `user-id` hash). This keeps every guild populated. From 15 known chatters on, the color alone decides.
- A chatter's guild is **locked for the season** the first time they are seen. Changing their Twitch color later does not move them. This prevents everyone from jumping to the winning guild.
- The fighter is drawn in the chatter's real current color, with a guild-colored ring so the side is always readable.
- The hue bounds are tuning values. Equal thirds will not give equal guilds on a real channel; check the split with the simulator and with real data, and shift the bounds if one guild is clearly too large.

## 5. Land and the Monument

This section replaces the earlier design of city buildings, professions and passive claiming of land, which lost its purpose once fights had classes and skills.

**Land from the start.** When a season begins, every tile but the three cities and the center belongs to a guild: five tiles each. All three guilds border each other at once, so a War can be fought in the first minute.

- **Equal start (default):** each guild gets the same five-tile sector next to its city, the same shape turned by a third of a circle.
- **Random start (option per season):** the same fifteen tiles are dealt by lot, five to each guild.
- The center tile starts neutral.

**Development.** Each tick a chatter earns builds their **home tile**: one of their guild's tiles, picked by a hash of their user id that stays the same while the guild keeps the tile (only the chatters of a lost tile move house; a finished tile sends its chatters to the next). A tile with many active regulars therefore rises fast while a quiet one lags: a guild can hold a level 8 next to a level 2. Every season each tile also gets a **fertility** between 0.6 and 1.6: the development points one tick gives it on average. A tile has a level from 0 to 10; reaching level n costs `12 * n` points, times the channel scale (section 3). The map shows each tile's level, and its fertility as texture in the tile's outer ring (the middle keeps the level clear): the most fertile land (the top 38% of the range) grows 3 to 6 tufts of grass, the very most also a flower or two; the most barren (the bottom 38%) is cracked and stony; middling land shows nothing. The state tells the overlay each tile's fertility as a share of the range, 0 to 1.

**Mishaps.** Once per 5-minute window of stream time, while the layer is on, the land may suffer or gain:
- **Lightning** (14% per window at full strength) seeks tall structures: it strikes a tile picked by its level squared, which loses 1 level, or 2 with 35%. It reins in runaway tiles.
- **Fire** (10% per window at full strength) starts on a developed tile, picked by level, and burns 1 level at once. Each later window it burns another level, unless at least 2 members of the owning guild were active in the window before: they put it out. A fire can spread to a neighbouring tile of any guild (30%), and burns out by itself after 3 windows. An active guild stamps out fires; a sleeping one loses land.
- **Harvest** (7% per window) raises a random owned tile by 1 level.
Lightning and fire start weak, so a young season's land is not taken back as fast as it grows: their chances are 30% of full strength at the start of a season and rise evenly to full strength after 2 hours of its stream time (by stream time, not by Monument progress, so the land settles at the same time in a short season as in a long one). Harvests keep their chance all season.
Cities and the center are never touched. The overlay's map shows burning tiles in flames and plays each mishap (a bolt and a flash, a burst of fire, steam when a fire is put out, a golden glow for a harvest) with its effect in levels; the control panel lists the latest ones. A strike leaves a scorch mark with cracks on its tile, a fire that burnt out or was put out leaves ash with charred spots and a few embers; the marks fade over three windows (the one it happened in included). Mishaps are kept with the window they happened in for this. While a guild's land burns, its row on the overlay's map panel says so in place of its Monument line, so chat knows what to do without a command: "Fire! 1 more chatter puts it out", pulsing, counting the guild's members who wrote in the current window against the 2 it takes; once enough wrote, "Fire: chat is putting it out".

- A developed tile is harder to take: in a War the defender's fighters have 3% more health per level of the attacked tile.
- A tile taken by force, or scorched by the god, keeps half its level.
- A guild with no tile left to develop puts its ticks straight into its Monument.

**The Monument.** Each guild builds one; it is the season's finish line. There are three Monument designs; when a season begins they are dealt to the three guilds at random, a different one each, so a guild does not always build the same one. The ended season's record keeps which design each guild built. Monument points are counted in tens. In every window in which a guild is active, its Monument grows by 10, plus 10 for every tile the guild holds (its city aside), plus 10 for every level of those tiles: land always yields, even at level 0, so five empty tiles are worth more than one at level 1. The overlay shows what each guild's Monument grows by ("Monument · grows +230") and pops numbers at the Monument, in the corner panel and in the map banner, of two kinds:
- **What the Monument gained**, in the guild's color, above it. Since a Monument grows only once per window, the overlay shows each gain in up to 20 parts ("+3", "+2", "+4", ...) at random moments over the next 4 minutes, the first within a few seconds: with three active guilds about one every 4 seconds. The overlay's bar and percentage move with the parts; the totals are exact, only spread out.
- **Chat ticks:** a small "+1" with a speech bubble beside the Monument each time a chatter of that guild earns a tick (at most 8 at once). The server counts the ticks per guild since it started and sends the counts with the state.

The first guild to reach the season's **goal** wins the season on the spot (section 10). The guild whose Monument is furthest leads.

**Season length.** The streamer does not set the goal; they set how long a season should last, in stream hours (default 10; Settings, "Season length"). That is the game's one balance setting: everything else is tuned so the game can be started and forgotten. Stream time is time with the layer on and chat writing; time between streams does not count. The goal is worked out from it:
- At the start of a season the goal is 2,000 per hour of the season length (20,000 for 10 hours): what the leading Monument grows in a stream hour, measured with `node src/cli/season-pace.ts`. Thanks to the channel scale (section 3) this is about the same for 12 chatters as for 200.
- For the first 30% of the season (at most 6 stream hours; 3 hours of a 10-hour season), the goal adapts to the chat's own pace: at the start of every window it moves from the expected goal toward a projection (each guild's Monument now, plus its growth over the last hour times the stream time left), the more so the further the adapting period has gone. Then it stays put, so a Monument's share never jumps back later.
- The goal always stays ahead of every Monument, so a new goal never ends a season by itself; it does not move away from a Monument that already reached it (a fight's reward can do that between ticks), which then wins on the next tick.
- Changing the season length works the goal out again at once, from the measured pace; a season already past the new length gets a short finale (the goal 10% above the leading Monument).
- Measured without fights, seasons set to 10 hours end after 9 to 11 hours of stream for 12, 60 and 200 chatters (10 to 13 with only 6 chatters); set to 5 hours, after 4 to 5; set to 20, after 18 to 22. Wars, rewards and the god's setback shift this a little.

The control panel shows the stream time played, whether the goal still adapts, and when the season should end at the measured pace: "At this pace Red finishes its Monument in about 6 more stream hours".

Databases from before the tens were converted once (Monument progress multiplied by 10). A season running when the season length came in keeps its progress and starts adapting its goal from then on.

The loop: chatting develops the land, the land feeds the Monument, Wars are fought over the land, and the first finished Monument wins.

## 6. The map

The map is a hexagon of hex tiles with radius 2: 19 tiles, addressed with axial coordinates `(q, r)`. The three cities sit on alternating corners: `(2,-2)`, `(0,2)`, and `(-2,0)`. Cities can never be captured, so no guild is ever out of the game.

Tiles change hands in three ways:

- **War** (section 7): an attacker that wins takes the tile.
- **The god** (section 9): a tile the god takes becomes neutral and is drawn scorched until someone owns it again.
- **Neutral tiles** (the center, and tiles the god took) go to the winner of the next Hero Clash or Guild Clash, which takes the neutral tile nearest its city. In a War, a guild that borders no enemy tile raids a neutral tile instead, and all three guilds fight for it.

Territory does not need to stay connected to the city.

**The center tile is the god's.** A guild can win it like any neutral tile, but only holds it for 30 minutes of stream time (six windows in which anyone earns a tick; time does not run while nobody chats or the background layer is off). Then the god takes it back and it is neutral again. Without this, a single early Clash would give one guild an extra tile for the whole season. The center cannot be developed: it has a fixed level of 5, which is what it adds to its holder's Monument each window and what it gives its holder as a defender. The map marks it with a ring in the god's color: a crown while it is free, the minutes left while a guild holds it.

## 7. War

### Start

The streamer starts a War from the control panel. Optionally (off by default) the broadcaster or a moderator can type `!war` in chat; role is read from the `badges` tag. This is the only chat command in the game and it is not for chatters.

Everyone who earned a tick in the last 30 minutes takes part automatically. Chatters who write during the War join from the next battle on. Lurkers who were active earlier therefore still take part, and a break does not need chat to wake up first.

**Fighter cap.** A screen cannot show thousands of fighters. Each side fields at most 40 fighters per battle (a tuning value). If more are eligible, the fighters are drawn at random from the eligible members using the seed; the session's heroes are always included. Everyone eligible gets the participation XP, whether drawn or not.

### Structure

A War is three battles, one per guild as attacker, in order from the guild with the fewest tiles to the guild with the most (ties broken by the seed). Each battle lasts at most 90 seconds.

The attacker's target is chosen automatically:

1. **Enemy border.** If the attacker's territory touches enemy tiles (cities excluded), it attacks the neighbor that owns the most tiles, on the most developed of that neighbor's tiles it touches (equal levels are drawn by lot): developed land is the prize, since a taken tile keeps half its level. The announcement names the stake ("Red attacks Blue's level 8") and explains it ("Red attacks Blue's level 8: taken, it keeps level 4 · Blue defends with +24% health"); on undeveloped land it is the plain "Red attacks Blue". The battle is attacker against defender. The third guild sits this battle out.
2. **Skirmish.** If the attacker touches no enemy tile, which is normal early in a season, it attacks a neutral tile next to its territory and all three guilds fight for it as a free-for-all. If the attacker wins it takes the tile at once; otherwise nothing changes.
3. If neither is possible, the guild's battle is skipped.

Because the largest territory is the preferred target, the leading guild is usually attacked twice per War.

### Combat

Combat is a simple automatic simulation:

- A fighter is drawn as the emote the chatter used most recently, on a dark disc with a ring in the guild's color, with the chatter's name above. It affects looks only and is remembered between streams.
  - **Sources:** Twitch emotes come from the `emotes` tag. BetterTTV, FrankerFaceZ and 7TV emotes (their global sets and the channel's own, loaded from their public APIs without a login and refreshed every 30 minutes) are recognised as whole words in the message. The emote nearest the end of the message wins, whatever its source; when a word is an emote in several sources, 7TV wins, then BetterTTV, then FrankerFaceZ, and a channel's own emote beats a global one. Each third-party source can be switched off in Settings; a switched-off source is neither recognised nor shown. A service that cannot be reached simply contributes nothing.
  - **Storage:** emotes are stored with their source, such as `twitch:25` or `7tv:<id>`. A plain id from an older database is a Twitch emote.
  - **Images:** the game server fetches each emote image once from its source's CDN, keeps it in `data/emote-cache/`, and serves it to the overlay itself (`/emotes/<source>/<id>`), still or moving.
  - **Animated emotes:** shown moving unless switched off in Settings. Twitch does not say which emotes move; only its newer `emotesv2_` emotes can, so those are offered moving and fall back to the still image. The overlay decodes moving emotes in a worker (`overlay/emote-worker.js`), three at a time, away from the drawing, and shrinks every frame to 64 pixels, the largest an emote is drawn at. It keeps at most 160 animations, dropping the ones seen longest ago but never one seen in the last 10 seconds, so a long stream full of new emotes does not grow the overlay's memory. Still images are decoded before they count as loaded, so a battle start with dozens of new emotes does not hold up a frame. A battle with 120 different moving emotes runs at a steady 60 frames a second in Chromium.

**Drawing without the graphics card.** OBS's "Browser Source Hardware Acceleration" switched off (or a browser without it) makes the overlay draw on the processor, and battles stutter. The overlay reads its WebGL renderer at load (SwiftShader, llvmpipe, softpipe and the like mean software) and sends `gpu` with its frame times. While any open overlay draws without the graphics card, the control panel shows a notice on every tab with the setting to switch on, and the Status tab lists it per overlay.
  - **Chatters without an emote:** by default they fight as a random global emote, picked from their user id so it stays the same from fight to fight; it is never stored as their own. Switched off in Settings, they are a circle in their name color. The god and its minions never get a random emote.
- **Names** above fighters are on unless switched off in Settings ("Names above fighters"): off, a fight shows emotes only, which keeps a crowded fight clean. A simple switch on purpose; the streamer decides.
- **Damage numbers.** A big hit (20 damage or more: every hit of the god and its skills; ordinary chatter hits stay below) reports its damage (`k: 'hit'`: the fighter, the damage, the cause, whether it killed). The overlay floats the number up from the fighter for about a second, popping in and fading out: white, orange for the god's skills, red and larger for a killing blow. At most 4 numbers come from one frame (killing blows and the biggest first) and 12 show at once, so a Leap into a crowd stays readable. Damage is not scaled by a fight's toughness (health is), so the numbers mean the same in every kind of fight. Measured: 2 to 9 big hits a second in god fights, none in Wars and Clashes. A theme can draw them its own way (`damageNumber`) and mark where fighters fall (`knockout`).
- **Highlights.** Noteworthy deaths get a line beside the scoreboard, with who did it, in the names' side colors: "TinyOtter8 humbles TinyPanda5, who was getting a bit too confident". On unless switched off in Settings. The battle reports a death (`k: 'death'`: victim, killer or -1, cause, reason) when it is, in this order of weight: the god falling, the last fighter of a side (not in a free-for-all or the endless mode), the crown holder, a fighter with 3 or more kills (a streak ends), a killer reaching 5, 10 or 15 kills (a spree), a death by the god's Rampage, Shockwave, Leap, Smite or fire, or by a barrel or a spike trap, the battle's first death, and, after 6 seconds without a line, the next ordinary kill (so a large fight where kills spread thin still gets a line now and then). Minions and the streamer's imps get none. Measured: 9 to 13 lines in a 75-second War of 40 against 40, 5 to 13 in a god fight against 60. The overlay shows a new line at most every 0.8 seconds, the weightiest waiting death first, drops one that waited over 3 seconds, and keeps at most 3 lines (newest on top, each for 6.5 seconds), which fit in the strip kept free for the scoreboard, left of it (in the corner in endless mode). Each kind has 3 or 4 lines, snarky on purpose, written for each language rather than translated; obstacles have no killer, so a death by one takes the obstacle's lines. A minion's kill is credited to "TheStreamer's minion".
- Each fighter moves toward the nearest enemy and attacks on contact.
- **Breaking out of crowds.** Every 2 seconds a fighter that has barely moved (less than 0.6 radii) while at least 4 others stand within 3 radii of it may break out: with a 35% chance it goes for a straggler instead, one of the 3 least crowded enemies among the farther half of them, for 3 to 5 seconds or until it gets there. Random on purpose, so crowds loosen now and then without everyone leaving at once; it uses its own random numbers, so the other rolls of a battle stay the same. Not the god and not healers. Measured over 12 battles of three guilds: the share of fighters in a tight crowd (6 or more within 3 radii) falls from 6% to 3–4% with 10 or 20 per guild and from 13% to 11% with 40, with fight lengths unchanged.
- Base values: 100 health, 10 damage per hit, one hit per second. Treat these as tuning values in a config file.
- **Fight length.** Every kind of fight lasts 60 to 90 seconds; the time limit of a battle is 90 seconds. Each kind multiplies every fighter's health (the god's and its minions' included, healing and obstacle damage with it) by its own toughness, scaled by `(30 / fighters) ^ exponent` so small and large fights last about as long: War and test battles 4.3 (exponent 0.1), Hero Clash heats and final 6 (0), Guild Clash 1.25 and free-for-all 1.5 (exponent 1: with a bench, a fight lasts as long as it takes to get through everyone drawn), god fights 5 (0.2). Endless mode keeps 1. Measured with `node src/cli/fight-durations.ts`, which plays every kind of event through its real engine with chats of 4, 10, 20 and 40 per guild: the median fight of every kind lasts 62 to 82 seconds.
- Fighters keep their distance from each other and are larger when there are few of them, so a small battle fills the screen and a large one stays readable.
- All fighters decide from the positions at the start of a step and all hits of a step land together, so no side gains from the order of processing.

Modifiers:

- **Level:** +2% health per level, capped at +30% (section 3).
- **Developed land:** the defender has 3% more health per level of the attacked tile (section 5). It does not apply in a raid on neutral land.
- **Size balance:** guilds will be uneven. Multiply each fighter's health and damage by `(averageSideSize / ownSideSize) ^ 0.6`, clamped to the range 0.6 to 1.8, computed over the sides in this battle. With three sides the exponent is 0.3, because the two larger sides wear each other down. Both exponents were tuned with `src/cli/battle-stats.ts`: a side half the size of its opponent wins about half the time, a side a third the size about 4 times in 10.
- **Fortune of battle:** each side's damage is multiplied once per battle by a random factor between 0.75 and 1.25, from the seed. Without it a large battle is so predictable that a 10% bonus wins nine times in ten. With it, +10% damage wins about 2 fights in 3, +20% about 3 in 4, and +30% health about 6 in 7, so bonuses matter and upsets still happen.
- **Hit variation:** each hit deals the fighter's damage varied by up to 25% up or down.

### End of a battle

A battle ends when one side remains, or after 90 seconds. At the time limit, the side with the most total remaining health wins; an exact tie goes to the defender (in a skirmish, nobody wins).

- Attacker wins: the tile changes owner and keeps half its development.
- Defender wins: nothing changes.
- A side with no fighters loses by walkover; an attacker with no fighters skips its battle.

Results are written to the database: tile owner, and per chatter kills, deaths, and battles played.

Every participant gets 20 bonus XP per War, plus 10 for each battle their guild won.

## 8. Hero Clash

A separate event, started by the streamer, about two minutes long.

- **Heroes:** in each guild, the three chatters with the most ticks in the current session (ties broken by the seed). Selection is by activity today, not by level, so the same veterans do not fight every time.
- **Heats:** three three-way matches. Heat 1 is the first-ranked hero of each guild, heat 2 the second-ranked, heat 3 the third-ranked.
- **Final:** the three heat winners, which may come from the same guild.
- **Equal stats:** heroes fight with base health and damage. Levels, buildings, and size balance do not apply.
- Each match lasts at most 90 seconds (most end after about a minute); at the limit, the hero with the most remaining health wins.
- If a guild has fewer than three heroes, its place in that heat is empty. A heat with one hero is a walkover.

Reward: the winner's guild gets +50% tick XP for 30 minutes. A second win refreshes the timer and does not stack. The winner wears a crown on the overlay until the session ends, and the win is counted in their lifetime statistics.

## 9. God events

The streamer is the god of the map. The god is one large fighter with the streamer's name and color, and fights automatically like everyone else. The streamer only decides when the god descends. (The broadcaster earns no ticks and belongs to no guild; this is their part in the game.)

There are two events, both started from the control panel, both a single battle of at most 90 seconds. They use the same participants rule as a War (section 7).

**God strength.** The god's health is `17.5 * fighters ^ 1.3` (above 70 fighters growing with the power 0.4), varied by up to 30% up or down per fight, where `fighters` is the number of chatters it faces, then multiplied by a factor for its enabled skills (below) and by the god fights' toughness (section 7, Combat). It deals 30 damage per hit to its target and to everyone close to the target. Measured with every skill on, 30 fights per chat size from 3 to 120 fighters: the god wins 33 to 67% per size, about half overall, so every level tips the balance toward chat. Levels apply to the chatters; size balance does not.

**Skills.** The god casts one skill every 2.5 to 4.5 seconds after the previous one ends, chosen at random from the enabled ones, the first after 2 to 3.5 seconds. With the one-second warning, something is announced or happening almost all the time. Each cast is announced one second ahead on the overlay, with the skill's name in large letters across the bottom of the screen. The streamer switches each skill on or off in the control panel; all are on by default.

| Skill         | What it does                                                                                         |
|---------------|------------------------------------------------------------------------------------------------------|
| Rampage       | Bounces very fast from edge to edge three times, damaging and knocking aside everyone in its path, then dashes back to the middle, where the skill ends. |
| Shockwave     | A blast that hurls the five nearest fighters across the arena, bouncing off its walls, and pushes back, damages and slows the rest. |
| Leap          | A shadow marks where the god will land: on the thickest group of fighters, or as near to it as the middle part of the arena allows (the middle 56% of its width and 50% of its height). It lands exactly on the shadow and damages and scatters those there. |
| Vortex        | Several whirlwinds (one per six fighters, at most four) each catch 4 to 6 fighters standing together, spin them in a ring and carry them slowly across the arena. Each whirlwind lasts its own time, between 1.8 and 4.5 seconds, so some fighters are let go sooner than others. Caught fighters cannot fight. |
| Smite         | Lightning strikes the three chatters who dealt the most damage so far. The screen shakes and the struck fighters stay blackened for a few seconds. Where each bolt struck, the ground burns for 5 seconds: a patch about two fighters wide that deals 6 damage every half second to every chatter standing in it. |
| Divine Shield | The god cannot be hurt for 3 seconds, while rays of light turn around it.                            |
| Minions       | Summons four small, weak copies of the god, at most twice per fight. They fall when the god falls.   |
| Enrage        | Not cast: below 30% health the god grows by 30%, turns red and pulses, and moves and hits 50% harder for the rest of the fight. |

Skills change how strong the god is, so its health is adjusted to keep the fight even. Each skill has a measured health factor (the health at which a god with only that skill wins half its fights). Only one skill is cast at a time, so the factors of the enabled cast skills are averaged, and Enrage multiplies on top.

**Holding the middle.** The god does not chase anyone. It starts in the middle of the arena with all chatters in a ring around it, drifts around the middle by at most 70 units so it is never still, and strikes whoever is within reach. It can therefore be attacked from all sides and is never left against an edge. Rampage and Leap take it away from the middle for a moment; Rampage ends back in the middle and Leap lands in the middle part of the arena, from where it drifts back.

**Moves between skills.** Always on, not skills, and not switchable: every 1.3 to 2.4 seconds, but never within 0.6 seconds of the next skill, the god makes one of three moves, which keep a long fight lively. A move under way finishes before the next skill.
- **Dash (45%):** 180 to 320 units sideways at 1,000 units a second, toward the side with more chatters, knocking aside everyone in its path (no damage). It stops at the arena's edge.
- **Blink (30%):** gone in a puff of smoke and, in the same moment, 180 to 340 units away (less far up and down), with a ring closing in where it lands.
- **Across the edge (25%):** it runs for the nearer side, off the screen, and comes back in at the other side, 140 to 260 units beyond its own size. While it crosses, the overlay shows it on both edges. Chatters can never do this; it is the one exception to the rule below.

The moves have random numbers of their own, so a fight's other rolls are the same with or without them. A blink and the crossing are marked in the frame (`jumped`), so the overlay shows the god at its new spot at once instead of sliding across the screen.

**Nothing leaves the screen.** No fighter's circle may come nearer than 16 arena units (30 screen pixels) to the left, right or bottom edge, or enter the scoreboard's strip at the top, or the map banner's strip (below). The god crossing the screen's edge is the one exception. This holds for every way a fighter can move: walking, being pushed, being hurled by Shockwave, riding a whirlwind, starting, and stepping in from the bench. It applies to all battles, not only god fights.

**Weight.** The god weighs 40 times as much as a normal fighter, so a crowd cannot shove it around. Before this it spent most of a fight pressed against the arena's edge; now it holds its ground in the open, where chat can surround it completely.

**Balance.** Fight length and the god's strength were balanced together (November 2026, see Combat in section 7): fights last 60 to 90 seconds and the god wins about half. Still open: the skill health factors one by one, the class numbers, the cost of developing land and the Monument's size (which set how long a season lasts), and the god's wins needed to win a season.

**Thrown fighters.** Every throw (Shockwave's hurl, a bumper's or a barrel's fling, and the god's pushes from its dash, Rampage, Leap and Shockwave) is a flight that starts at 1.8 times its average speed and slows down evenly to 0.2 times it, covering the same distance as at an even speed; the god's pushes take 280 ms. So that a crowd hurled by one blast does not fly in lockstep, each of the god's throws (the hurl and the pushes; not a bumper's or a barrel's fling) varies its starting speed by up to 25% and its time in the air by up to 30%, up or down, from random numbers of their own, so the battle's other rolls stay as they were. While in the air a fighter cannot act. The overlay squashes a thrown fighter into an oval along its flight, stretched by its speed (1 + speed / 3500 pixels a second, at most 1.5) and narrowed across by as much, so it keeps its size; its name, badge and health bar stay upright.

**Map banner.** During every battle, during a countdown, during Pachinko and under an event's closing words (a setting: at the bottom, the default; at the top; or off) a strip of 60 arena units (112 screen pixels) across the screen shows the map and each guild's tiles, what its Monument grows by, and the Monument. The battle's arena is shorter by that strip, so no fighter, skill effect or caption ever reaches it; the overlay also draws the battle clipped to its own part of the screen and the banner last, over everything. With the banner at the top the scoreboard sits below it; at the bottom the skill names are shown above it. Pachinko's boards shrink a little to fit the rest of the screen. During a countdown, and while an event's closing words show ("The War is over", "Blue wins Pachinko"), the banner stands in for the corner panels (statistics and map), which are hidden as in a battle, so these screens never cover them wherever the streamer moved them.

**Transitions.** When a battle, a countdown, Pachinko or an announcement takes the screen, the corner panels slide out toward the nearer side of the screen (0.42 seconds, speeding up); when the screen is theirs again they slide back in (0.6 seconds, overshooting a little before they settle). A battle comes in on its own: its obstacles fade in, the fighters pop up one after another within half a second (each growing in a quarter of a second with a little overshoot), and the scoreboard drops in from above. In the last 0.45 seconds of the result, the battlefield and the result fade and the scoreboard rises away, so the panels slide back into an empty screen. A page that connects late does not slide its panels in on its first draw.

**Time limit.** The god wins if it is still standing when the time runs out. Chat has to bring it down.

**Looks.** The god takes the broadcaster's name, color, and latest emote from their own chat messages; until they have written, it carries the channel name.

### God's Wrath

A brake on the leader, and the way land becomes neutral again once the map is full.

- **Target:** the guild whose Monument is furthest along, on its tile farthest from its city (ties broken by the seed). Cities are never targeted. If no guild owns a tile besides its city, the event is not available.
- **Sides:** the god against the targeted guild only. The defender's land bonus applies as in a War.
- **God wins:** the tile becomes neutral, scorched, and keeps half its level. A guild wins it back as the prize of a Hero Clash or Guild Clash, or by a raid in a War.
- **Guild wins:** the tile stays, and every participant of that guild gets 30 bonus XP.

### Streamer vs Chat

A boss fight with stakes on both sides.

- **Sides:** the god against all three guilds together. The land bonus does not apply.
- **Chat wins:** every participant gets 30 bonus XP. The guild that dealt the most damage per fighter gets one free level on its least developed tile.
- **God wins (the first Streamer vs Chat of a session):** the god lays waste to the map.
  - Every guild loses one tile: the one farthest from its city (ties broken by the seed) becomes neutral and scorched, keeping half its level. A guild that owns only its city loses no tile.
  - Every Monument loses 15% of its progress.
- **Limit:** once per session, so the streamer cannot wipe the map by repeating it. The limit is a tuning value.

Because fights are automated, no guild can hold back on purpose, so rivals fighting side by side is not a problem.

### The god's record

The streamer's reward is visible standing, not power; the god never gets stronger from winning.

- The overlay keeps a season score of god against chat, counting both events (for example "God 3 : 2 Chat").
- A tile the god turned neutral is drawn scorched in the streamer's color until a guild claims it again.
- Lifetime god wins and losses are kept across seasons and shown in the control panel.
- Both counts are derived from the `god_fights` table, which is never cleared at season end.

## 10. Seasons

A season is a period with its own map, land development, Monuments and guild locks. It ends in one of three ways:

- **A guild finishes its Monument.** That guild wins and the season ends on the spot; the overlay announces it.
- **The god wins enough.** With 5 wins against chat in a season (friendly fights aside), the god wins the season.
- **The streamer ends it** from the control panel. The guild whose Monument is furthest wins, then the one with the most tiles, then the seed decides.

When a season ends:

- The land is dealt again (equal sectors, or at random if the streamer chose that for the next season), with all development at zero.
- Monuments, XP and levels are reset.
- Guild locks are cleared, so chatters are assigned again from their current color.
- Lifetime statistics are kept (kills, battles, Hero Clash wins, seasons won), and the winner is recorded. A season the god won counts for no guild.

**The recap.** Every season that ends while the game runs gets a recap on the overlay, once the screen is free: after the Monument's celebration, after the god's last fight and its closing banner, or at once when the streamer ended it (it also waits for a running event or countdown; endless mode hides it, as it hides every announcement). Its rows appear one after another, 1.4 seconds apart, and then all stay for 9 seconds: the winner ("Blue · Monument finished"; ended by hand, the furthest Monument and its share; "TheStreamer, with 5 wins against chat"), the most kills, the highest level, the most Clash wins, the best Pachinko run, the god's score against chat, and how many chatters played. A row nobody earned is left out. Beside them the winning guild's Monument rises, or a crown for the god. The map banner shows, as for an event's closing words. The best Pachinko run is the most points one chatter scored in a single game (imps aside), kept from games shown to their end; History shows it too, for seasons from now on, along with how many games of Pachinko each guild won that season.

## 11. Tech stack and architecture

Default stack:

- Node.js with TypeScript.
- SQLite through Node's built-in `node:sqlite` module, one database file per channel. (The first choice was `better-sqlite3`; the built-in module needs no native build, and its API is close enough to switch back cheaply.)
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

Battle, Hero Clash, and god event simulations run on the server at a fixed step (20 steps per second) and send snapshots to the overlay. The steps follow the clock, not the timer: when the server was busy and a timer fires late, the battle catches up with a few steps at once (at most 6) instead of stalling, which looked like a freeze on the overlay. The state pushed to the pages every second must stay cheap to build (about 1 ms): it once counted a long session's ticks on every push, took 300 ms, and made battles stutter once a second.

Tools around the game:

- `tools/release/`: `npm run release` builds the packaged game for the system it runs on: one executable (a Node.js single executable application: the official Node binary with the game bundled in by esbuild), the `overlay/` and `control/` folders and a `START.txt`, as a folder and an archive in `dist/`. The packaged game opens the control panel in the browser when it starts. It also writes `website/version.json`, which the update check reads (`config.updates.url`; empty means no check).
- `tools/preview/`: `npm run preview` renders every overlay scene in every theme to pictures, with the real game code, for a look before a release; `bench.ts` there times frames.
- `tools/obs/chroma-clash-hotkeys.py`: an OBS script that turns the action links (section 13) into OBS hotkeys.

### Data model

Columns and tables of the old buildings design (`users.profession`, `guilds.repair_cost`, `buildings`, `claims`) still exist so old databases load, but nothing uses them.

- `users`: `user_id` (primary key), `display_name`, `color`, `emote_id`, `guild_id`, `xp`, `level`, lifetime `kills`, `season_kills`, `deaths`, `battles`, `clash_wins`, `seasons_won`, `first_seen`, `last_seen`.
- `guilds`: `guild_id`, `name`, `city_tile_id`, `xp_boost_until` (nullable), `monument` (progress).
- `tiles`: `tile_id`, `q`, `r`, `owner_guild_id` (nullable), `is_city`, `scorched`, `level`, `points`, `burning` (windows a fire has burned; 0 for none).
- `ticks`: `user_id`, `window_start`, `session_id`; unique on user and window. Used for tick awards, recent activity, and hero selection.
- `session_ticks`: `session_id`, `user_id`, `ticks`. Each chatter's ticks per session, counted up as ticks come in, for the most active chatters and the heroes; counting them in `ticks` was too slow on long sessions.
- `sessions`: `session_id`, `started_at`, `ended_at`.
- `wars`: `war_id`, `season_id`, `started_at`, `ended_at`, `seed`.
- `battles`: `battle_id`, `war_id`, `position`, `kind` (`attack`, `skirmish`, or `skipped`), `tile_id`, `attacker_guild_id`, `defender_guild_id` (null for a skirmish), `winner_guild_id` (nullable), `captured`, `ended_by`, `duration_ms`, `seed`.
- `clashes`: `clash_id`, `session_id`, `started_at`, `winner_user_id`, `winner_guild_id`, `seed`.
- `excluded`: `login`. Users the streamer shut out of the game.
- `guild_windows` records each guild's first tick per window, for the Monument; `sessions` also holds the session's champion and whether Streamer vs Chat was used.
- `settings`: key and value, for the streamer's switches and tuning, the center's holder, and the latest mishaps.
- `god_fights`: `god_fight_id`, `season_id`, `kind` (`wrath` or `versus`), `tile_id` (nullable), `target_guild_id` (nullable), `god_won`, `top_damage_guild_id` (nullable), `started_at`, `seed`.
- `seasons`: `season_id`, `started_at`, `ended_at`, `winner_guild_id`, `summary` (JSON).
- `settings`: `key`, `value`. Holds the measured and the manual channel size, and later the edited tuning values.

## 12. Twitch IRC notes

Verify these against the current Twitch IRC documentation (dev.twitch.tv/docs/irc) before relying on them; details change.

- Connect to `wss://irc-ws.chat.twitch.tv:443` (WebSocket) or `irc.chat.twitch.tv:6697` (TLS). The non-TLS WebSocket endpoint has been shut down.
- After connecting, request capabilities: `CAP REQ :twitch.tv/tags twitch.tv/commands`.
- Read-only access works without a token by logging in with the nickname `justinfan` followed by random digits (checked live on 2026-11-18). This is not in the Twitch documentation and could stop working without notice. If it does, the streamer must supply an OAuth token with the `chat:read` scope, sent as `PASS oauth:<token>`.
- Answer `PING` with `PONG`, and reconnect when the server sends `RECONNECT`. Reconnect with backoff on connection loss.
- Slash commands cannot be sent over IRC. This does not affect a read-only game.
- Writing in chat (the optional result announcements, section 13) needs `TWITCH_LOGIN` and `TWITCH_TOKEN` with the `chat:edit` scope; the line is sent as `PRIVMSG #channel :text` while joined. Anonymous logins cannot write.

Tags the game uses on `PRIVMSG`:

| Tag            | Use                                              |
|----------------|--------------------------------------------------|
| `user-id`      | Primary key for a chatter. Names change, IDs do not. |
| `display-name` | Name shown on the fighter.                       |
| `color`        | Guild assignment and fighter color. May be empty. |
| `badges`       | Detect broadcaster and moderators for `!war`.    |
| `emotes`       | The emote the chatter's fighter is drawn as.     |
| `room-id`      | The channel's Twitch id, to load its BetterTTV, FrankerFaceZ and 7TV emotes. |
| `tmi-sent-ts`  | Message timestamp, used for tick windows.        |

`USERNOTICE` (raids, subs) is not used in version 1. See section 15 for ideas.

## 13. Streamer controls

The control panel is one page with seven tabs. Above the tabs, on every tab, a line says what is running on the overlay, with one Stop button that ends whatever it is: a War, a god event, a countdown, a test battle or endless mode. The chosen tab is kept in the page's address, so it survives a reload. When the update check finds a newer version, a notice with a download link sits under the title.

- **Overview:** the setup guide (below), the Twitch channel, the background layer switch (it starts and ends a session), the map with each tile's level, the guilds with their members, tiles, land level and Monument, and the most active chatters of the session.
- **Conquest:** the fights between the guilds that count. Start a War, and switch the `!war` chat command on or off; start a Hero Clash of the most active heroes; start the countdown for a Guild Clash.
- **God:** the streamer against the guilds, over the map. Start God's Wrath; start Streamer vs Chat, which can be fought over the map once per session (afterwards the button is off and a note points to the friendly fight); the god's record; the skill switches; the picture upload.
- **Arena:** fights for fun that change nothing in the game. Start the countdown for a free-for-all; start a friendly Streamer vs Chat, available whenever the background layer is on and as often as wanted; endless mode with its number of fighters; test battles between chosen guilds.
- **History:** the running season (number, start, day), and a table of every finished season, newest first: its number, when it started and ended, how many days it ran, who won it (a guild, or the god), the Wars fought in it, and the god's score against chat in it, friendly fights aside. A season can end by itself while nobody is watching, so this is where to look it up.
- **Settings:** the overlay's address for OBS, and the panel's address for an OBS dock, each with a Copy button; the action links; result announcements in chat; the Look card (the overlay's theme, from the folders in `overlay/themes`; switches for pixelating emotes in themes that pixelate, animated emotes, random emotes for chatters who never used one, and each of BetterTTV, FrankerFaceZ and 7TV; names above fighters; the highlights); the overlay layout (dragging the two panels, showing or hiding them, the lines of the statistics panel); the tuning values (openly only the season length and the countdown fights' two times; the rest folded under "Advanced", since the game is meant to run as it is); the measured channel size and its manual override; excluded users; ending the season and choosing how the next one starts; the saved game (export, import, reset).
- **Status:** for when something does not show up, reloaded every 3 seconds while open. Chat: source, connection, messages seen and when the last came, whether the game can write in chat. Overlays: every open overlay page with how long it has been open, its size (marked when it is not 1920 × 1080), theme, average and slowest frame time and frames per second, as each overlay reports every 5 seconds. Emote sources: whether BetterTTV, FrankerFaceZ and 7TV answered, and how many global and channel emotes each gave. Program: version, Node.js, running time, control panels open, what is on the overlay, and the database's size and file.

Each event's card says how long it takes from the click until the overlay is free again, like "about 4–5.5 min" (and the dock's buttons as a tooltip). The range is worked out from the config, so tuned values change it: the countdown, the line-up or the map's announcement, each fight from `pace.shortestFightMs` (60 s) up to its time limit, the result and outcome holds, and the closing summary. A War counts one battle per guild; a Hero Clash a heat per hero rank and the final.

The **setup guide** is the first card of the Overview tab. It has five steps, each ticked off when the game sees it done, not when a button was pressed: the channel is entered; an overlay page is connected (the server counts the overlays); the background layer is on; the streamer's picture for the god is uploaded (the same upload as on the God tab, with the picture shown beside the button); a test battle ran (kept in the channel's settings). A test battle with too few active chatters fills each empty guild with 8 stand-ins, so the guide can be finished before going live. The guide can be hidden (remembered in that browser) and brought back from Settings.

**Compact layout for an OBS dock.** In a page narrower than 560 pixels, or with `?dock` in the address, the panel shows only the running line with Stop and one button per action: the background layer, War, Guild Clash, Hero Clash, free-for-all, Pachinko, God's Wrath, Streamer vs Chat, the friendly fight and endless mode. The buttons press the full panel's buttons and are on or off with them. Links open the full panel or show everything in place; `?full` forces the full panel.

**Action links** for a Stream Deck (a Website action, as a GET request in the background) or an OBS hotkey: `GET /api/action/<name>?key=<key>`, where name is one of `war`, `hero-clash`, `guild-clash`, `free-for-all`, `pachinko`, `gods-wrath`, `streamer-vs-chat`, `friendly-fight`, `endless`, `endless-on`, `endless-off`, `layer`, `layer-on`, `layer-off`, `test-battle`, `stop`. The answer is one line of plain text saying what happened, or an error (403 for a wrong key, 409 when something else is running). The key is made on the first start and kept in `data/settings.json`, so the links survive a channel switch. Because the links change the game with a plain GET, they need the key; the panel gets it from `GET /api/actions`, which other websites cannot read. The live WebSocket refuses pages of other websites for the same reason.

**Result announcements in chat.** Off by default, and only possible with a Twitch login (section 12). When on, the game writes one line when a War, a Hero Clash, a Guild Clash, a free-for-all, Pachinko or a god fight runs to its end (its closing title and summary, not when stopped), and when a season is won. The simulator prints the lines to the console instead.

**Language.** The overlay, the control panel, the server's announcements and the chat lines are in English or German, chosen in Settings (a per-channel setting, `en` by default) and applied live to every open page. `?lang=de` in a page's address pins a language, like `?theme=`. All text lives in one file per language, `lang/<code>.json`, with English as the fallback for a missing key; a new file adds a language. Theme names and descriptions come from each theme's `theme.json` and stay as written there. API errors the panel never shows stay English.

**Saved game.** Export downloads a consistent copy of the channel's database (`VACUUM INTO`) while the game runs. Import takes such a file, checks that it is an SQLite file with the game's tables from this version or an older one, and replaces the channel's game with it. Reset starts the channel's game from nothing and must be confirmed by typing the channel name. Before an import or a reset the current database is copied to `data/backups/`, then the server closes, the file is replaced, and everything starts again; the pages reconnect by themselves.

## 14. Milestones

Build in this order. Each milestone should run and be demonstrable before the next begins.

1. **IRC reader.** Connect to a channel, parse messages with tags, print typed events. Include unit tests for the parser using sample raw lines.
2. **Chat simulator.** A fake event source that generates chatters with random colors and message timing, so everything after this can be developed without a live stream. This matters; do not skip it.
3. **Database, guilds, professions.** Schema, user upsert on each message, guild assignment with season lock, profession assignment. Tests for hue bucketing and the fallback hash.
4. **Ticks and cities.** Windows, tick awards, XP, levels, building points and levels, sessions. Tests with a controlled clock.
5. **Server, overlay shell, control panel shell.** The overlay shows the hex map and the cities; the panel can toggle the background layer.
6. **Expansion.** Claim progress on neutral tiles, target selection, tile XP bonus. Tests for the hex math (neighbors, distance).
7. **Battle simulation.** Pure logic first, with a seed and tests, then rendering in the overlay.
8. **War.** Battle order, target selection, skirmishes, tile capture, statistics, bonus XP.
9. **Seasons and remaining controls.** Season end, exclusions, tuning values, optional `!war`.
10. **Hero Clash.** Hero selection, heats and final, XP boost, crown.
11. **God events.** The god fighter, God's Wrath, Streamer vs Chat, ruins and repair, the god's record, and tuning the god's strength with the simulator.

## 15. Ideas for later (not in version 1)

- Territory cut off from its city weakens or falls.
- A special center tile with its own bonus.
- Raids arrive as an invading army that the home guilds must repel.
- Nemesis tracking: remember who killed whom most often and announce rematches.
- Bounties on chatters with long win streaks.
- Professions that also change how a fighter behaves in battle.

## 16. Open questions for the project owner

Ask about these when they become relevant; do not guess silently.

- Should chatters with no color set be spread over the three guilds by hash (the current default)?
- Should subscribers, VIPs, or bits give anything? The default is no, to avoid pay-to-win.
- Should the game ever post in chat, for example War results? Answered: only if the streamer switches on result announcements, one line per result; off by default (section 13).
### To revisit after the first play tests

All eleven milestones are built. These points were noticed along the way and deliberately left for tuning:

Requested by the project owner:

- **Themes and eye candy.** The overlay's look comes from themes (overlay/themes/, see its README): a theme can change the pixel scale, font, colors, single elements by image, or drawing functions. Built in: "Pixel RPG" (the default: drawn at a third of the size and scaled up with clean pixel outlines and glows in flat, stepped layers, a pixel font kept sharp on its own layer, blue role-playing-game window frames, pixel-sprite class badges), "Dark Fantasy Comic" (heavy ink rims and hard shadows on fighters, map tiles and panels, halftone dots printed over everything, Pirata One blackletter lettering, worn hand-inked panels with a parchment rule, cel-shaded class badges, flat inked flames, and the god's skills shouted in a jagged sound-effect burst) and "Plain" (the original flat look). The streamer picks one in Settings; an OBS scene can pin one with `?theme=` in the overlay address. New for every theme: arrows that fly on an arc, class badges in light class colors, a mage's rune circle with a flying orb and an explosion, layered flames with embers and smoke for the god's fire, and the Monuments: three designs (Obelisk, Ziggurat, Temple) dealt to the guilds at random each season, built up in five stages in the guild rows and beside each city on the large map, with a celebration when one is finished. The battle arena is 1024 by 576 units stretched over the 1920 by 1080 screen, so fighters, skills and effects are drawn large and a god fight fills most of the screen.

- **Season history with details.** Done. The control panel's History tab lists every finished season: when it ran, the winner, Wars fought and the god's score. Under each season it shows why it ended (a finished Monument, the god's wins, or the streamer's button) and what it looked like then: the chatter with the highest level, the one with the most kills, the one with the most Clash wins in the season (Hero Clash and Guild Clash; called "Most Clash wins" to keep it apart from the overlay's "Session champion", the winner of the latest Clash of the running stream), how many chatters played, and each guild's final Monument progress, tiles, land level and members. These are recorded at the moment a season ends, because levels and kills are reset then; seasons that ended before this existed have no details.

- **Rework of the background layer.** Done (sections 5, 6 and 10). City buildings, professions, passive claiming of land and city ruins are gone. Land is owned from the start of a season and developed by chatting; developed land feeds each guild's Monument, and the first finished Monument wins the season. The god can win the season with enough wins against chat. Earlier notes in this list about buildings, the Workshop, ruins or a missing finish line describe the old design.

- **Streamer vs Chat more than once per session.** Done. Only the first fight of a session is over the map: if the god wins it, every guild loses a tile and every Monument loses 15% of its progress. Later fights in the same session are friendly: the same fight, but nothing is at stake and nothing in the game changes, whoever wins. Friendly fights are counted apart from the god's score.
- **Season statistics on the overlay, and movable panels.** Done. A second overlay panel shows the season. Its header carries the season's number and day; below it is one row per line: the leading guild, when the season ends ("in about 6 stream hours", in the color of the guild set to finish first, from the control panel's forecast in section 5; "measuring chat's pace…" until a few windows have passed), the session's champion, the god's score against chat this season (with the friendly tally once there is one), the god's score over all seasons, Wars fought, the chatter with the most kills this season, the chatter with the highest level, the number of chatters playing, and the date the season started. Every line has its own switch in the control panel, and the panel is as tall as the lines that are on. The switches are kept as the lines that are off, so a line added in a later version starts on (a database from before kept the lines that were on and is converted once). The streamer places both panels, the map and the statistics, by dragging them in a preview of the screen in the control panel (arrow keys move the selected panel in steps of 10 pixels, 50 with Shift), can hide either, and can reset both. During every battle, endless mode included, both panels are hidden, and the fighters may use the whole screen.

- **Constant motion is the design principle for everything on screen.** The project owner's view, from watching Intro Fighters: constant motion and effects are the key to a streaming game like this. A battle must never settle into fighters standing in a line trading hits. Judge every battle mechanic by whether it keeps things moving, in normal battles as much as in god fights.
- **Countdown fights.** Done. The streamer starts a 30-second countdown that the overlay shows; every chatter who writes during it is in the draw (one message is enough, no command; every message counts, not only the one tick per 5-minute window). In most chats people write every few minutes, so 30 seconds catch only a few of them: chatters whose latest message came in the 3 minutes before the countdown started are in the draw too, but only for places the countdown's writers leave free (writers are always drawn first), and the countdown's count includes them. **The streamer's imps** fill what is still empty: in a Guild Clash every guild that drew at least one chatter gets as many places as the largest guild (at least the 3 that are on the field at once), and in Pachinko as many balls (at least 8); the empty places go to imps in the guild's color ("Imp 1", "Imp 2", … "the streamer's imp"), drawn like the god's minions but in the guild's color. In a Guild Clash they are plain fighters without a class, step in after the guild's chatters, and never take the crown; in Pachinko each drops one ball for its guild. A guild nobody drew for sits the game out, and a draw still needs two guilds. The fighters are drawn by lot, then the line-up is shown for 15 seconds: the fighters are revealed one by one, a fighter of each team in turn, each announced large as it is drawn and then kept in its team's list, so a chatter can spot their own name; the complete list stands for the last fifth of the time. Both times, the countdown and the line-up, are settings in the control panel. Then they fight with equal stats: levels, buildings, size balance and fortune do not apply, so nothing is decided before the fight. Two kinds:
  - **Guild Clash**, the second mode of Hero Clash: up to 10 per guild are drawn, 3 per guild are on the field, and when one falls the next steps in from the bench. The last guild standing wins the Hero Clash reward (the XP boost, and the crown for its fighter with the most kills).
  - **Free-for-all:** 30 are drawn, 10 fight at a time, everyone for themselves. The last one standing wins. It changes nothing in the game.
- **Endless mode.** Done. A switch in the control panel: a never-ending free-for-all of the active chatters, for an intro, an outro or a break. The streamer sets how many fight on screen at once (2 to 60, 12 by default). Fallen fighters rejoin the queue after 3 seconds. It gives no XP and no statistics. Like every battle it hides the panels. Starting any real event ends it. Every 5 minutes it restarts with the chatters active at that moment.
- **Betting.** Nothing to build: betting is a separate system in Twitch chat. The 15 seconds of line-up are there so bets can be placed before the fight.
- **Classes instead of levels in the line-up.** Done. Classes are dealt at the draw, and the line-up shows each fighter's class under its name.
- **Emotes wherever players are presented.** Done. Every line-up (Guild Clash, free-for-all, Pachinko, and now each Hero Clash heat and final, which used to be a line of names) shows each chatter's emote beside the name, the one their fighter wears (the same rules as in battle: the emote they used last, or a random one when that is switched on), on a disc with their guild's ring; a chatter without one gets a disc in their name color. The engines name each member's chatter; the server adds the emote and name color before sending. A line-up box is only as tall as its longest team, and shows place numbers only where a team has more than one fighter. Pachinko's lists on the boards show each player's emote where the place number was; a pulsing ring around it marks the player whose ball is falling.
- **Enter the channel name in the control panel.** Done. `npm start` without arguments reads the channel saved in `data/settings.json`; with none saved, the server starts and the control panel's first card asks for the channel (a name, `#name` or a twitch.tv address is accepted) before the layer can be turned on. Switching to another channel later opens that channel's own database and chat; the overlay and the panel reconnect by themselves. `--channel` still works and is remembered; `--sim` keeps its made-up channel, `simchannel`, unless `--channel` names one (for recordings and demos). `--data <folder>` moves the settings, databases and emote cache.
- **Obstacles.** Done, switchable in Settings (on by default). Walls stand in the way and fighters slide around them; pinball bumpers fling whoever touches them away; barrels roll in from an edge, knock fighters aside and hurt them (8), break on walls and bounce off bumpers; spike traps glow red and then strike everyone on them (16) every 3.2 seconds. About two in five team battles are fought in an **arena**: a named place with a plan of its own, varied a little each time (mirrored, shifted, now and then one obstacle left out, never a wall that makes the place), so each battle of a War can look different:
  - **Pinball Hall:** bumpers in a diamond.
  - **Fortress:** four walls around the middle with gaps at the corners, spike traps before them.
  - **Brewery:** crates (short walls) to hide behind; barrels roll in from the left and right in waves of 1 to 3.
  - **Spike Pit:** a grid of spike traps with lanes between.
  - **Ruins:** broken walls all over.
  - **Funhouse:** a ring of bumpers with traps outside it.
  - **Gauntlet:** a corridor through the middle, barrels rolling down it in waves.

  The scoreboard names the arena (in gold, left of the clock), and the battle opens with its name and a line about it in the middle for 2.6 seconds ("Brewery: barrels roll in from the sides"). After 20 seconds an arena changes every 8 to 14 seconds: an obstacle that fits it fades away or rises where nobody stands (bumpers in the Pinball Hall, traps and walls in the Fortress, crates in the Brewery, traps in the Spike Pit and the Gauntlet), keeping about as many as it started with. A plan is laid out also where the teams gather (fighters on a wall are moved off it); bumpers and traps keep quiet for the first 2.5 seconds. The highlights take the arena's own lines now and then: a barrel in the Brewery ("TinyPanda5 got barrelled. Last round's on the house."), a trap in the Spike Pit, a plain kill in the Ruins ("TinyPanda5 is part of the Ruins now, thanks to SaltyOtter23").

  With god skills: the god's **Rampage breaks walls** in its way (they burst into bricks and dust, and the battlefield shakes); a fighter **thrown into a bumper** (by a Shockwave, a barrel or another bumper) bounces off it and is sent off again at full speed, pinball-style, and a fighter thrown into a wall bounces off it. A free-for-all and the endless mode have obstacles appear (fading in) and disappear again every 9 to 18 seconds, at most four at once, and now and then a wave of barrels. Obstacles keep clear of where the teams gather and of the god's middle; the god only leans on bumpers and breaks barrels. They have their own random numbers, so a battle without them plays exactly as before. Obstacle damage counts as nobody's kill.
- **Pachinko.** Done, in the Arena. A countdown and draw like a Guild Clash (up to 10 per guild) and the same line-up, then one board per guild: every drawn chatter drops as a ball with their emote, bounces left or right off 8 rows of pins, and lands in one of 9 slots worth 100, 25, 10, 5, 2, 5, 10, 25, 100 points (the edges are rare). A guild with fewer chatters is filled up with the streamer's imps (see Countdown fights), so every guild drops as many balls, and at least 8; each chatter drops once. One ball drops at a time, the boards taking turns, spaced (1.5 to 3.5 seconds apart) so a game lasts about 75 seconds, like a fight. The highest sum wins; a tie goes to more balls in the 100 slots, then by lot. The server plays the whole game at the start; the overlay shows it ball by ball. A ball in a 100 slot bursts into sparks. Each board lists its players with their points so far, in its two upper corners beside the top of the pins (places 1 to 5 left, 6 to 10 right): best first, sliding into place when the order changes, a new score flashing, the leader in gold, and a pulsing ring around the emote of the player whose ball is falling. The list keeps clear of every ball on any path; a ball's name shows only once it is below the list. After the last ball the winner is celebrated for 7 seconds: its board pops forward with a glow and chasing marquee lights, a crown drops onto it, a WINNER ribbon with a passing shine and slow rays behind the score, its balls hop in a wave, and confetti bursts from the board's corners and then rains over the screen, while the other boards dim. While the balls fall, each pin glows gold for a moment when a ball hits it, a falling ball draws a short trail in its guild's color, and a board's total counts up to a landed ball's points over 0.45 seconds instead of jumping. A jackpot (a ball in a 100 slot) also sends up a firework: a rocket climbs from the slot toward the middle of the board for half a second and bursts over the pins into sparks of gold and the guild's color that drift down and fade. All of it is worked out from the time since the last ball, so a page that opens late shows the same moment. It changes nothing in the game, by decision (November 2026): it is played for fun. The season counts each guild's wins (games shown to their end), and History shows them per guild.
- **The god's minions look like minions.** Done. They are drawn as shadow imps: a dark, spiky, slowly turning body with horns and glowing eyes in the god's color, no name and no class, never with the god's picture.
- **Names over the result banner.** Fixed. On a theme with its own text layer (pixel, comic) the scoreboard, the result banner and the skill caption are drawn in a pass over the fighters' names.
- **Stutter once a second.** Fixed (section 11). The state pushed every second counted the session's ticks from scratch; on a long session that took 300 ms and stalled the battle each time. Counts are now kept as ticks come in, and battles follow the clock.
- **Handling.** Done (section 13 and 11): the setup guide, the compact OBS-dock layout, action links for a Stream Deck and OBS hotkeys, the Status tab, export, import and reset of the saved game with backups, optional result announcements in chat, the packaged build with an update notice, and the preview tool in the repository.
- **A website.** `website/` is a static page that explains the game with small animations; `.gitlab-ci.yml` publishes it with GitLab Pages.
- **Skills for the god.** Done: eight skills, each switchable in the control panel (section 9). Vortex was reworked from a pull toward the god, which made the god weaker, into whirlwinds that carry fighters off; its health factor still dates from the old version and is part of the balancing pass. Still open: Minions and Divine Shield are worth more against a small chat than a large one, which a single health factor per skill cannot capture.
- **Classes for chatters.** Done. Every chatter is dealt a class at random for each fight, from the fight's seed, in every kind of fight (Wars, god fights, Hero Clash, countdown fights, test battles, endless mode). The god and its minions have none. A small badge on each fighter shows its class. Shares: fighter 30%, archer 20%, tank 15%, thief 15%, mage 10%, healer 10%.

  | Class   | Stats                    | Behavior |
  |---------|--------------------------|----------|
  | Fighter | Normal                   | Walks to the nearest enemy. With two or more enemies around it, every 4 seconds a spin hits them all for 60% damage. |
  | Tank    | Slow, +50% health        | Enemies within reach of its presence prefer to attack it. Every 7 seconds, with an enemy upon it, a shield makes it unhurtable for 1.8 seconds. |
  | Thief   | Fast, less damage        | Goes for archers, mages and healers first. After each strike it darts back for a moment, then comes in again. Every 6 seconds it slips into the shadows for up to 2.5 seconds: nobody can target or hurt it, and it moves 60% faster. Its own strike brings it back out. |
  | Archer  | Low health, ranged       | Shoots from a distance and backs away from enemies that come close. |
  | Mage    | Low health, slow, ranged | Every 4 seconds it marks a circle on the ground at its target; a moment later the circle blasts everyone in it. |
  | Healer  | Low health               | Follows the ally with the least health and heals it. It heals neither itself nor other healers. Left without anyone to heal, it fights for itself, weakly, so a fight can always end. |

  All class numbers are first guesses and belong to the final balancing pass.
- **Battles feel static.** Fighters walk to the nearest enemy and trade hits in a line. Ideas: knockback on hits, charges, a few fighter behaviors, projectiles, or terrain. The two skill items above are the main answer to this.

Noticed while building:

- Earlier notes here about a season without a finish line, maxed cities and the Workshop described the old design of buildings; the Monument (section 5) replaced it.
- **Names overlap in a dense melee** of 40 or more fighters.
- **A very small side still loses.** The size balance is capped, so 3 fighters against 40 lose every time.
- **Very small channels** produce uneven cities and one-fighter battles.
- **The editable tuning values are a short list.** Shown openly: the season length and the countdown fights' two times. Under "Advanced": XP per tick, War XP, development cost, the god's wins for a season, battle length, fighters per side, fortune. Everything else is in `src/config.ts`.

## 17. Working agreements

- Keep game rules in `src/game/` free of side effects, and cover them with tests.
- Put every tuning number in one config module; no magic numbers in logic.
- Key all user data on `user-id`.
- Prefer small, working steps over large unfinished ones, and say clearly at the end of each milestone what works, what was left out, and what was not tested.
