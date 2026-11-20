# Chroma Clash: improvement plan

A plan of what to improve next, in three parts: gameplay, visuals, and handling
(how the streamer sets it up and runs it). Each item has a size (S: an evening,
M: a few evenings, L: a week or more) and a suggested order within its part.
Balancing stays one pass at the end, as agreed; the gameplay part says what
that pass should measure.

## Gameplay

1. **The balancing pass (M).** Run it with the simulator (`src/cli/simulate.ts`) for 12, 60 and 200 chatters, and set targets first, then numbers:
   - **Done (November 2026): season length.** The streamer sets one thing, the season length in stream hours (default 10). The Monument goal is derived from it, adapts to the chat's pace for the first 30% of the season, then locks; the control panel forecasts the end. Lightning and fire ramp up over the first 2 stream hours. Seasons set to 10 hours end after 9 to 11 hours at 12 to 200 chatters (`node src/cli/season-pace.ts`). Further balance settings were decided against: the game should be click and forget.
   - **Done (November 2026): fight length and god strength.** Every kind of fight lasts 60 to 90 seconds (medians 62 to 82), Pachinko 75, and the god wins about half its fights at every chat size (`node src/cli/fight-durations.ts`).
   - **Still open:** god strength per skill (the factors date from before Vortex was reworked), **class numbers**, **obstacle damage**, and **Pachinko slot values**.
2. **Make uneven land matter in Wars (S).** A captured tile keeps half its level, so a guild's level-8 tile is now a prize. Let an attacker go for the defender's highest-level border tile instead of the current choice. Show the stake on the War map ("Red attacks Blue's level 8").
3. **Decide what Pachinko is worth (S).** Today it changes nothing. Options: keep it for fun, which suits betting; give the Guild Clash reward; or a small Monument bonus for the winner.
4. **Named arenas (S).** Turn obstacle layouts into themes shown on the scoreboard: "Pinball Hall" (bumpers only), "Fortress" (walls and traps), "Brewery" (barrel waves). It costs little and gives each battle an identity people talk about.
5. **Chat sees fires (S).** A small line on the overlay, such as "Fire on Red's land: chat to put it out!", makes the douse rule something viewers feel without a command. It keeps chat passive.
6. **Obstacles with god skills (S).** Shockwave sends fighters into bumpers, and Rampage breaks walls. Most of this already works through the physics; check it and add the wall break.
7. **A season recap (M).** When a season ends: the winning Monument, top killer, highest level, best Pachinko run and the god's record, shown on the overlay one after another, and kept in History.
8. **Small-chat modes (M).** With 3 to 8 chatters, Wars and Guild Clash are thin. Let the god's minions or "militia" fill empty places, so a small channel gets full battles.
9. **Guild changes by name colour (S). Maybe later.** Today a colour change moves a chatter only at the next season. Talked about (November 2026) and kept as is for now. Options for a future update: a hint before a new season ("change your name colour now to pick your guild for next season"); switching at the next stream, but only into a smaller guild (cannot snowball, evens out the guilds); or switching at the next stream only early in the season (while the goal still adapts). Switching every stream without a limit would let chatters jump to the leading guild and decide the Monument race early. Note: Red is the largest guild in real chats, because 7 of Twitch's 15 default colours fall in its hue range.
10. **Bots out by default (S). Done.** Nightbot, StreamElements, Streamlabs, Moobot, Fossabot and WizeBot never take part (`config.botNames`); the streamer can exclude anyone else in Settings.

## Visuals

1. **Sound (M). Not now.** The streamer decided against sound for the time being (November 2026); maybe later. Ideas kept for then: short effects for skill casts, lightning, a bumper, the Pachinko jackpot and a season win, with a volume setting and a mute switch (OBS browser sources can play audio).
2. **Finish the comic theme's own art (M).**
   - **Effects:** "POW" and "KRAK" bursts on heavy hits and kills. Inked outlines on obstacles, monuments and mage circles. A hard-edged celebration with flat rays instead of soft gradients.
   - **Halftone:** heavier shading on the dark side of shapes.
3. **Pixel sprites for the new elements (S).** Pixel-style obstacles, pixel flames for burning tiles, and a pixel Pachinko board. Today these are drawn the plain way and only pixelated.
4. **Readable crowds (M). Done differently (November 2026).** A switch in Settings turns fighters' names off (emotes only); the highlights (item 8) name the fighters who matter. Smarter name hiding was decided against: the streamer chooses.
5. **Transitions (S).** The panels vanish at the start of a battle and pop back after it. Slide them out and in, and fade the arena in.
6. **Pachinko polish (S).** Done: a jackpot bursts into sparks, the winner is celebrated (marquee lights, crown, confetti), and each board lists its players with their points and emotes. Left: pins light up when hit, balls leave a short trail, and the winning board's total counts up.
7. **Show the land's nature (S).** Let fertile tiles look lush and barren ones dry, with a small grass or stone texture. Then fertility is something viewers can see.
8. **A kill feed and damage numbers (S).** Done: the highlights, noteworthy deaths with who did it, in snarky lines beside the scoreboard (switchable). Left: floating numbers on big hits.

## Handling

All nine items are built (November 2026); see SPEC.md section 13. What each became, and what is left:

1. **First-start guide. Done.** Five steps on the Overview tab (the fifth: upload the stream picture the god wears), each ticked off when the game sees it done: an overlay is really connected, a test battle really ran. A test battle with a quiet chat uses stand-ins, so the guide can be finished before going live.
2. **Control panel as an OBS dock. Done.** Below 560 pixels wide, or with `?dock`, the panel shows the running line, Stop and one button per action.
3. **Stream Deck and hotkeys. Done.** `GET /api/action/<name>?key=…` for every fight, the layer, endless mode and Stop, listed with Copy buttons in Settings; `tools/obs/chroma-clash-hotkeys.py` turns them into OBS hotkeys. Left: a button to make a new key (today: delete `actionKey` from `data/settings.json`).
4. **Season and data controls. Done.** Export, import and reset of the saved game, with a backup in `data/backups/` before an import or a reset. "End season" already started a new season.
5. **Easier install. Done for Linux.** `npm run release` builds a single executable with everything inside; the control panel shows a notice when `website/version.json` names a newer version (set `config.updates.url` to its address once the website is online). Left: building the Windows and macOS packages, which must happen on those systems (a CI job per system; `.gitlab-ci.yml` has the Linux one, untested), and code signing, without which Windows SmartScreen and macOS Gatekeeper warn on the first start.
6. **Status page. Done.** The Status tab: chat, overlays with their frame times and size, emote sources, version and database size.
7. **Overlay text in other languages. Done.** English and German, 513 strings each in `lang/en.json` and `lang/de.json`, for the overlay, the control panel, the server's announcements and the chat lines. Left: theme names and descriptions (they come from each theme's `theme.json`), and API errors the panel never shows.
8. **Optional chat announcements. Done.** Off by default; needs `TWITCH_LOGIN` and a `TWITCH_TOKEN` with `chat:edit`.
9. **Keep the preview harness. Done.** `npm run preview` renders every scene in every theme into `tools/preview/out/`.
