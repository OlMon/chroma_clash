# Overlay preview

Still pictures of the real overlay in every theme, for a visual check before a
release. Each scene is a page that loads `overlay/overlay.js` and replays
messages the real game code produced (seeded, so the same every run): the map
panels, announcements, battles, pachinko. Headless Chromium takes a 1920×1080
picture of each scene at fixed moments, with a transparent background as OBS
sees it.

## Run

```sh
npm run preview                              # every scene in every theme
npm run preview -- --scene fire,pachinko     # some scenes (or repeat --scene)
npm run preview -- --theme pixel             # one theme
npm run preview -- --lang de                 # in German (any lang/<id>.json)
CHROMIUM=/path/to/chrome npm run preview     # another browser binary
```

It needs Chromium or Chrome (found on the PATH, or through `CHROMIUM`), and
the internet for Twitch emotes the first time (they are cached in
`out/emotes/`). A full run takes about half a minute.

Output, all in `tools/preview/out/` (gitignored):

- `<theme>/<scene>-<at>ms.png`: the pictures
- `index.html`: every scene in every theme side by side; `<theme>.html`: one theme's contact sheet
- `pages/`: the generated scene pages
- `<lang>/…`: the same layout for a run with `--lang` other than English, so
  the English pictures stay where they are. The scene pages get `?lang=<id>`
  for the overlay's own texts, and the texts the server would have written
  (announcements, statistics lines) are produced in that language too.

Themes are every folder in `overlay/themes/` with a `theme.json`, so a new
theme shows up on its own. A picture fails, and the command exits with 1, when
the page throws an error or never finishes; errors are also printed in red
across the picture itself. Other console messages are listed under the
picture's line.

## Look at a scene in a browser

```sh
node tools/preview/scenes.ts     # write the pages
node tools/preview/serve.ts      # serve them on port 4790
```

Then open `http://127.0.0.1:4790/overlay/_preview/fire.html?theme=comic&at=1500`.
`?theme=` pins a theme; `?lang=` pins a language for the overlay's own texts;
`?at=` is the moment, in ms after the scene's effects began. The page draws once and then sets its title to `ready`.

## Frame-time benchmark

```sh
node tools/preview/bench.ts                                  # fire scene, every theme
node tools/preview/bench.ts --scene classes --at 250 --theme comic --frames 120
```

Draws a scene's frame many times in headless Chromium and prints the average
milliseconds per frame per theme. Good for comparing themes, or a change
before and after, on one machine; headless Chromium draws on the CPU, so the
numbers run higher than in OBS.

## Add a scene

In `scenes.ts`, inside `generateScenes`, call `page(name, { messages, moments })`:

- `messages`: what the server would send, in order. Start with `stateMessage`
  (the map and stats panels showing) or `battleState` (panels hidden, for a
  battle). For a battle, `recordBattle(title, setup, sides, emotes, pick)` runs
  a real `Battle` and returns its start message plus 12 frames around the step
  `pick` scores highest.
- `moments`: the `at` values to take pictures at. Battles add `at` to the draw
  time; announcements and pachinko are moved back by `at` on their own clock.
- `tweak` (optional): JavaScript run before every draw, for what no message
  can set up, such as a skill caption or mishap effects. It sees the overlay's
  globals (`state`, `battle`, …), so it may need updating when overlay.js changes.

The new scene is picked up by `npm run preview` with no other change.
