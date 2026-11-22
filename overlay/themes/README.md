# Overlay themes

A theme decides how the overlay looks. Each theme is a folder here with a
`theme.json`. The game lists every folder that has one; the streamer picks a
theme under Settings → Look in the control panel. A single OBS scene can also
pin a theme in its address: `http://localhost:4747/overlay/?theme=pixel`.

Anything a theme does not change is drawn the built-in way, so a theme can be
as small as one replaced image.

## theme.json

```json
{
  "name": "Pixel RPG",
  "description": "One sentence for the control panel.",
  "extends": "pixel",
  "script": "theme.js",
  "pixelScale": 3,
  "hardEdges": true,
  "font": { "family": "Jersey 10", "file": "jersey-10.woff2", "weight": "100 900" },
  "fontScale": 1.3,
  "palette": { "neutralTile": "rgba(40, 52, 110, 0.6)", "neutralTileBig": "#26305C", "stone": "#DCD2B8" },
  "images": { "arrow": "arrow.png" }
}
```

All fields but `name` are optional.

| Field | What it does |
|---|---|
| `extends` | Starts from another theme and changes only what this file says. |
| `script` | A script that replaces drawing functions (see below). |
| `pixelScale` | Above 1, everything is drawn this many times smaller and scaled up without smoothing: chunky pixels. Text stays sharp. |
| `hardEdges` | With a pixel scale: clean pixel outlines; glows and smoke become flat, stepped layers. |
| `ink` | Comic ink on fighters, map tiles and panels: `{ "color": "#0B0807", "width": 3, "shadow": 6, "shadowAlpha": 0.5 }`. `width` is the outline, `shadow` how far the hard shadow falls down and right (0 for none). |
| `halftone` | Comic dots printed over everything: `{ "size": 6, "dot": 0.22, "alpha": 0.18 }`. `size` is the grid in pixels, `dot` the dot's radius as a share of it, `alpha` how dark. |
| `font` | A font file in the folder. `weight` lists the weights the file covers; give `"100 900"` for a one-weight pixel font, so the browser does not fake bold. |
| `fontScale` | Makes all text this much larger, for fonts that run small. |
| `palette` | `panel`, `panelStrong`, `neutralTile`, `neutralTileBig`, `text`, `stone` (the Monuments' stone), and `classColors` (`{ "fighter": "#E98C6C", ... }`, the accent colors of the class weapons: the tank's shield, the mage's orb, the healer's cross). |
| `images` | Pictures that replace single elements, by key (below). |

## Images (no code needed)

An image replaces an element completely. PNG with transparency works best.

| Key | Element | Drawn into |
|---|---|---|
| `arrow` | An archer's arrow in flight | pointing right, tip at the right edge, 1 by 0.3 |
| `monument.<design>.<stage>` | A guild's Monument; design 0 (Obelisk), 1 (Ziggurat), 2 (Temple); stage 0 (nothing built) to 5 (finished) | a square standing on the ground point |

## Drawing functions (script)

A theme script calls `Theme.register({ art: { ... } })`. Each function gets the
canvas context first, then the element's values, and last an object with the
theme's `px` (its pixel scale) and, where it applies, `palette` or `color`.
Draw in screen coordinates (1920 × 1080); the pixel scale is applied for you.

| Function | Arguments |
|---|---|
| `box(ctx, x, y, width, height, { radius, strong, accent, px, palette })` | A panel's background. `accent` is a color stripe on the left. |
| `arrow(ctx, length, { px })` | An arrow; the context is already turned, the tip at 0, 0, pointing right. |
| `monument(ctx, design, progress, x, y, height, color, { px, palette })` | A Monument standing on x, y; `progress` from 0 to 1. |
| `mageRune(ctx, x, y, radius, progress, now, color, { px })` | A mage's circle before the blast. |
| `mageBlast(ctx, x, y, radius, progress, color, { px })` | The blast. |
| `fireGround(ctx, mark, now, { px })` / `fireFlames(ctx, mark, now, { px })` | Burning ground: `mark` has `x`, `y`, `r`, `start`, `ms`. Ground is drawn under the fighters, flames over them. |
| `wall(ctx, x, y, w, h, id, { px })`, `bumper(ctx, x, y, r, lit, now, { px })`, `barrel(ctx, x, y, r, rolled, broken, id, { px })`, `trap(ctx, x, y, r, state, now, { px })` | Obstacles, centered on x, y. `rolled` is how far a barrel turned (radians), `state` a trap's 0 resting, 1 warning, 2 striking. |
| `rubble(ctx, x, y, w, h, id, ms, { px })` | A wall the god broke, `ms` after it broke (gone after 450). |
| `tileFlames(ctx, x, y, size, now, seed, { px })` | Flames on a burning map tile; `size` is the tile's radius. |
| `pachinkoPin(ctx, x, y, r, glow, { px })` | A Pachinko pin; `glow` from 1 just hit to 0. |
| `firework(ctx, fromX, x, fromY, toY, t, color, seed, { px, climbMs, burstMs, sparks })` | A jackpot's firework, `t` ms after the ball landed: it climbs from fromX, fromY to x, toY for `climbMs`, then bursts. |
| `damageNumber(ctx, x, y, value, { age, life, lethal, skill, color, seed, rank, px })` | A big hit's damage over the fighter, rising. The context is faded already; `age` and `life` in milliseconds, `lethal` for a killing blow, `skill` for the god's skills, `color` the built-in color for it, `rank` its place among the hits of the same moment (0 the biggest). |
| `knockout(ctx, x, y, age, seed, { life, px })` | Drawn where a fighter falls, for `life` milliseconds (only when a theme has it). |
| `shade(ctx, x, y, width, height, { px })` | Shading on the dark side of a shape (fighters, bumpers, barrels, a Monument's right half): fill the rectangle, the context is clipped to the dark part. |
| `rays(ctx, { count, length, color, alpha, px })` | The rays behind a winner (a finished Monument, Pachinko's winning board). The context is moved to their middle and turned. |
| `caption(ctx, text, { color, age, font, width, px })` | The god's skill name at the bottom of the screen. The context is already moved to its middle, scaled for the pop-in and faded; the font is set. `color` is the caster's, `age` the milliseconds since it appeared, `width` the text's width. |

See `pixel/theme.js` for a complete small example and `comic/theme.js` for a larger one.

## Speed

OBS on Linux often draws browser sources without the graphics card, so every
frame is painted by the processor. Keep effects that touch every pixel of the
screen to a minimum: the built-in themes take 4 to 9 ms a frame there.
