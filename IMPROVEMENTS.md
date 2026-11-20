# Chroma Clash: improvement plan

A plan of what to improve next, in three parts: gameplay, visuals, and handling
(how the streamer sets it up and runs it). Each item has a size (S: an evening,
M: a few evenings, L: a week or more) and a suggested order within its part.
Balancing stays one pass at the end, as agreed; the gameplay part says what
that pass should measure.

## Gameplay

1. **The balancing pass (M).** Run it with the simulator (`src/cli/simulate.ts`) for 12, 60 and 200 chatters, and set targets first, then numbers:
   - **Done (November 2026): season length.** The streamer sets one thing, the season length in stream hours (default 10). The Monument goal is derived from it, adapts to the chat's pace for the first 30% of the season, then locks; the control panel forecasts the end. Lightning and fire ramp up over the first 2 stream hours. Seasons set to 10 hours end after 9 to 11 hours at 12 to 200 chatters (`node src/cli/season-pace.ts`). The overlay's season panel shows viewers when the season ends ("in about 6 stream hours"). Further balance settings were decided against: the game should be click and forget.
   - **Done (November 2026): fight length and god strength.** Every kind of fight lasts 60 to 90 seconds (medians 62 to 82), Pachinko 75, and the god wins about half its fights at every chat size (`node src/cli/fight-durations.ts`).
   - **Done (November 2026): the rest of the pass,** with `node src/cli/balance.ts god|classes|obstacles|pachinko`:
     - *Classes:* every class survives 89 to 108% as often as the average fighter and kills 90 to 127% as much (before: archers twice the kills, healers half the survival). Archers and mages weaker, thieves, tanks and healers stronger. The sturdier classes made fights longer, so every kind's toughness came down by about a quarter; medians are 57 to 90 seconds again.
     - *God:* each skill's health factor found again so a god with only that skill wins half its fights; a new mix factor (0.58) for skills together, so the default god with every skill wins 53% (57, 40 and 63% at 3, 8 and 20 per guild).
     - *Obstacles:* barrels 8 → 5, traps 16 → 12, fewer barrel waves in the Brewery and the Gauntlet, fewer bumpers and walls in the Pinball Hall, Funhouse and Ruins: 3 to 11% of deaths by obstacles (before up to 44%), arena fights 69 to 85 seconds against 76 without.
     - *Arena chance:* half of all team battles (was two in five).
     - *Pachinko:* kept as it is: a jackpot in 22% of games, deciding 17%; the half-time leader wins 65%.
   - **Still open:** a single-skill god swings with chat size (it loses to small chats and beats large ones); it would need a factor per skill that changes with chat size. Only matters when the streamer switches skills off.
2. **Make uneven land matter in Wars (S). Done (November 2026).** An attacker goes for the defender's highest-level border tile, and the announcement names the stake ("Red attacks Blue's level 8"), what a taken tile keeps and the defender's health bonus.
3. **Decide what Pachinko is worth (S). Decided (November 2026): for fun.** It changes nothing in the game. The season counts each guild's Pachinko wins, and History shows them.
4. **Named arenas (S). Done (November 2026).** Seven arenas with a plan of their own (Pinball Hall, Fortress, Brewery, Spike Pit, Ruins, Funhouse, Gauntlet), named on the scoreboard and introduced as a battle starts; after 20 seconds obstacles that fit the place come and go; the highlights have lines for each place. Possible later: arenas that belong to a tile, so a War over it is fought in its arena.
5. **Chat sees fires (S). Done (November 2026).** While a guild's land burns, its row on the map panel reads "Fire! 1 more chatter puts it out" (pulsing) in place of its Monument line, then "Fire: chat is putting it out" once enough of the guild wrote in the window.
6. **Obstacles with god skills (S). Done (November 2026).** Rampage breaks walls; a fighter thrown into a bumper bounces off it at full speed again, and off walls.
7. **A season recap (M). Done (November 2026).** When a season ends, the overlay shows the winner, most kills, highest level, most Clash wins, best Pachinko run, the god's score and the number of players, one after another, beside the winning Monument. History keeps the best Pachinko run too.
8. **Small-chat modes (M). Done (November 2026).** Imps fill every guild to 6 fighters in Wars and god fights and stand in for missing heroes in Hero Clash heats; imps are weaker (70%), the chatters leading them a little stronger (115%) and under a banner; a small chat (under 10 active) draws from everyone who wrote this session.
9. **Guild changes by name colour (S). After 1.0.** Today a colour change moves a chatter only at the next season. Talked about (November 2026) and kept as is for now. Options for a future update: a hint before a new season ("change your name colour now to pick your guild for next season"); switching at the next stream, but only into a smaller guild (cannot snowball, evens out the guilds); or switching at the next stream only early in the season (while the goal still adapts). Switching every stream without a limit would let chatters jump to the leading guild and decide the Monument race early. Note: Red is the largest guild in real chats, because 7 of Twitch's 15 default colours fall in its hue range.
10. **Bots out by default (S). Done.** Nightbot, StreamElements, Streamlabs, Moobot, Fossabot and WizeBot never take part (`config.botNames`); the streamer can exclude anyone else in Settings.

## Additional modes

Modes on top of the game, for later. Each is a feature of its own.

1. **Duel mode (M).** Two chatters, one on one, large on screen with their emotes, health bars and the highlight lines; works from two chatters up, so it suits small communities ("Name challenges Name"). Needs a way to challenge: a chat command or a countdown.
2. **Intro fighter remake (?).** Named by the streamer (November 2026); to be talked through before it is planned.

## Visuals

1. **Sound (M). Not now.** The streamer decided against sound for the time being (November 2026); maybe later. Ideas kept for then: short effects for skill casts, lightning, a bumper, the Pachinko jackpot and a season win, with a volume setting and a mute switch (OBS browser sources can play audio).
2. **Finish the comic theme's own art (M). Done (November 2026).** "POW!"/"KRAK!" bursts on the biggest hit of a blow and "KO!" bursts where fighters fall; inked Monuments and mage circles (obstacles already had ink); flat inked sunbursts behind winners; dense halftone shading on the dark side of fighters, bumpers, barrels and Monuments.
3. **Pixel sprites for the new elements (S). Done (November 2026).** Bumpers, barrels, spike traps, walls and rubble, the flames on burning tiles, Pachinko's pins and the jackpot's firework are pixel sprites in the pixel theme.
4. **Readable crowds (M). Done differently (November 2026).** A switch in Settings turns fighters' names off (emotes only); the highlights (item 8) name the fighters who matter. Smarter name hiding was decided against: the streamer chooses.
5. **Transitions (S). Done (November 2026).** The corner panels slide out toward their side when a battle, countdown or announcement takes the screen and slide back in after it; a battle's obstacles fade in, its fighters pop up one after another, the scoreboard drops in, and at the end the battlefield fades and the scoreboard rises away.
6. **Pachinko polish (S). Done (November 2026).** A jackpot bursts into sparks and sends up a firework, the winner is celebrated (marquee lights, crown, confetti), each board lists its players with their points and emotes, pins light up when hit, balls leave a short trail, and the totals count up.
7. **Show the land's nature (S). Done (November 2026), to be tried on stream.** Fertile tiles grow tufts of grass (the richest a flower or two), barren ones are cracked and stony, on the corner map and the War map. The map banner keeps plain colours during battles, by decision (November 2026).
8. **A kill feed and damage numbers (S). Done (November 2026).** The highlights: noteworthy deaths with who did it, in snarky lines beside the scoreboard (switchable). Damage numbers float up from big hits (the god's hits and skills), orange for skills and red for killing blows.

## Handling

All items are built (November 2026); see SPEC.md section 13. What each became, and what is left:

1. **First-start guide. Done.** Five steps on the Overview tab (the fifth: upload the stream picture the god wears), each ticked off when the game sees it done: an overlay is really connected, a test battle really ran. A test battle with a quiet chat uses stand-ins, so the guide can be finished before going live.
2. **Control panel as an OBS dock. Done.** Below 560 pixels wide, or with `?dock`, the panel shows the running line, Stop and one button per action.
3. **Stream Deck and hotkeys. Done.** `GET /api/action/<name>?key=…` for every fight, the layer, endless mode and Stop, listed with Copy buttons in Settings; `tools/obs/chroma-clash-hotkeys.py` turns them into OBS hotkeys. Left: a button to make a new key (today: delete `actionKey` from `data/settings.json`).
4. **Season and data controls. Done.** Export, import and reset of the saved game, with a backup in `data/backups/` before an import or a reset. "End season" already started a new season.
5. **Easier install. Done for Linux.** `npm run release` builds a single executable with everything inside; the control panel shows a notice when `website/version.json` names a newer version (set `config.updates.url` to its address once the website is online). Left: building the Windows and macOS packages, which must happen on those systems (a CI job per system; `.gitlab-ci.yml` has the Linux one, untested), and code signing, without which Windows SmartScreen and macOS Gatekeeper warn on the first start.
6. **Status page. Done.** The Status tab: chat, overlays with their frame times and size, emote sources, version and database size.
7. **Overlay text in other languages. Done.** English and German, 513 strings each in `lang/en.json` and `lang/de.json`, for the overlay, the control panel, the server's announcements and the chat lines. Left: theme names and descriptions (they come from each theme's `theme.json`), and API errors the panel never shows.
8. **Optional chat announcements. Done.** Off by default; needs `TWITCH_LOGIN` and a `TWITCH_TOKEN` with `chat:edit`.
9. **Keep the preview harness. Done.** `npm run preview` renders every scene in every theme into `tools/preview/out/`.
10. **A shorter tuning card. Done (November 2026).** Only the season length and the countdown fights' two times are shown; the other values are folded under "Advanced". The game should run without touching them.
