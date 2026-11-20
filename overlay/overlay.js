// The overlay only draws what it receives from the server. It decides nothing.
'use strict';

const canvas = document.getElementById('stage');
/** The visible canvas. `ctx` is what everything draws on: the screen, or the pixel layer of a pixel theme. */
const screen = canvas.getContext('2d');
let ctx = screen;

/**
 * Text, and emotes that are not to be pixelated, go on a second canvas over
 * the first. A pixel theme keeps its art in hard pixels at any size, but text
 * scaled that way breaks into jagged letters: this layer is scaled smoothly.
 */
const textCanvas = document.createElement('canvas');
textCanvas.width = canvas.width;
textCanvas.height = canvas.height;
canvas.after(textCanvas);
for (const layer of [canvas, textCanvas]) {
  layer.style.position = 'absolute';
  layer.style.left = '0';
  layer.style.top = '0';
}
const textLayer = textCanvas.getContext('2d');

/**
 * A theme named in the page address (overlay/?theme=pixel) wins over the one
 * chosen in the control panel: one OBS scene can use a different look.
 */
const pinnedTheme = new URLSearchParams(location.search).get('theme');
if (pinnedTheme) Theme.use(pinnedTheme);

/** The font of the current theme; see theme.js. */
let FONT = Theme.current.font;
// Each panel's place and size come from the server (state.overlay); these are the inner measures.
const PANEL = { width: 820, height: 360, margin: 28, radius: 18, padding: 22 };
const HEX_SIZE = 38;
const DEATH_FADE_MS = 700;

let state = null;
/** The battle being shown, or null. See onBattleStart for its shape. */
let battle = null;

function connect() {
  // The server counts overlays, for the setup guide, and shows their frame times on the status tab.
  const socket = new WebSocket(`ws://${location.host}/ws?page=overlay`);
  const reporter = setInterval(() => reportFrameTimes(socket), 5000);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      state = message.state;
      noteMishaps();
      noteMonumentGrowth();
      if (!pinnedTheme && state.display && state.display.theme) Theme.use(state.display.theme);
      // The language chosen in the control panel; `?lang=` in the address wins, like `?theme=`.
      I18n.follow(state.display && state.display.language);
      if (!battle) drawPanel();
    } else if (message.type === 'announce') {
      onAnnounce(message);
    } else if (message.type === 'countdown') {
      countdown = message.done ? null : message;
      if (!battle) drawPanel();
    } else if (message.type === 'pachinko') {
      onPachinko(message);
    } else if (message.type === 'show-end') {
      pachinko = null;
      if (!battle) drawPanel();
    } else if (message.type === 'battle-start') {
      onBattleStart(message);
    } else if (message.type === 'battle-frame') {
      onBattleFrame(message);
    } else if (message.type === 'battle-end') {
      onBattleEnd(message);
    }
  };
  socket.onclose = () => {
    clearInterval(reporter);
    setTimeout(connect, 2000);
  };
}

// --- Frames and themes ---------------------------------------------------------

/**
 * A theme with a pixel scale above 1 draws everything on a small canvas that
 * is then scaled up without smoothing: the chunky pixel look. A comic theme
 * draws on a full-size one and prints halftone dots over it.
 * Text, and emotes when they are not to be pixelated, are drawn afterwards on
 * a layer of their own in the theme's font, so they stay readable.
 */
let pixelLayer = document.createElement('canvas');
let pixelCtx = null;
/** Text and images that wait for the full-size screen, in the order they were drawn. */
let deferred = [];

function deferringContext(target) {
  const context = target.getContext('2d');
  const capture = (kind, text, x, y, maxWidth) => {
    deferred.push({
      kind,
      text: String(text),
      x,
      y,
      maxWidth,
      transform: context.getTransform(),
      font: context.font,
      fillStyle: context.fillStyle,
      strokeStyle: context.strokeStyle,
      lineWidth: context.lineWidth,
      lineJoin: context.lineJoin,
      globalAlpha: context.globalAlpha,
      textAlign: context.textAlign,
      textBaseline: context.textBaseline,
    });
  };
  context.fillText = (text, x, y, maxWidth) => capture('fill', text, x, y, maxWidth);
  context.strokeText = (text, x, y, maxWidth) => capture('stroke', text, x, y, maxWidth);
  return context;
}

/** Draws something on the full-size screen after the pixel layer. Only meaningful while a pixel theme draws. */
function deferImage(draw) {
  deferred.push({ kind: 'image', transform: ctx.getTransform(), globalAlpha: ctx.globalAlpha, draw });
}

/** How wide a text is drawn in the current font, including a theme's larger letters. */
function textWidth(text) {
  return ctx.measureText(text).width * (pixelated() ? Theme.current.fontScale : 1);
}

/** Whether the current frame is drawn on a pixel layer. */
function pixelated() {
  return ctx !== screen;
}

function replay(op, scale) {
  const target = textLayer;
  target.save();
  target.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]).multiply(op.transform));
  target.globalAlpha = op.globalAlpha;
  if (op.kind === 'image') {
    op.draw(target);
    target.restore();
    return;
  }
  // The theme's font is a little larger, so the pixel letters match the chunky art.
  const fontScale = Theme.current.fontScale;
  target.font = fontScale === 1 ? op.font : op.font.replace(/([\d.]+)px/, (_, size) => `${Number(size) * fontScale}px`);
  target.fillStyle = op.fillStyle;
  target.strokeStyle = op.strokeStyle;
  target.lineWidth = op.lineWidth;
  target.lineJoin = op.lineJoin;
  target.textAlign = op.textAlign;
  target.textBaseline = op.textBaseline;
  if (op.kind === 'fill') target.fillText(op.text, op.x, op.y, op.maxWidth);
  else target.strokeText(op.text, op.x, op.y, op.maxWidth);
  target.restore();
}

/**
 * The few transparencies a hard-edged pixel layer knows, as a table from any
 * alpha to its band. A faint fringe vanishes, so shapes get clean pixel
 * outlines; nearly solid pixels become solid; glows and smoke become flat,
 * stepped layers, as old games drew them. Pixels at least as opaque as a
 * panel (200) are left alone, so panels stay translucent.
 */
const ALPHA_BANDS = new Uint8Array(256).map((_, alpha) => {
  if (alpha >= 200) return alpha;
  if (alpha >= 150) return 255;
  if (alpha >= 100) return 150;
  if (alpha >= 55) return 95;
  if (alpha >= 22) return 55;
  return 0;
});
let edgesTainted = false;

/** Old games had no soft edges: every pixel of the small layer gets one of a few transparencies. */
function hardenEdges(context, width, height) {
  // An image from another site makes the layer unreadable; then the soft edges stay.
  if (edgesTainted) return;
  let image;
  try {
    image = context.getImageData(0, 0, width, height);
  } catch {
    edgesTainted = true;
    return;
  }
  const data = image.data;
  for (let i = 3; i < data.length; i += 4) data[i] = ALPHA_BANDS[data[i]];
  context.putImageData(image, 0, 0);
}

/** A comic theme's halftone dots: a sheet as large as the art layer, made on first use. */
let halftoneSheet = null;

/**
 * Prints a comic book's halftone dots over everything on the art layer:
 * a diagonal grid of dark dots, only where something is drawn.
 */
function applyHalftone(context, width, height, halftone) {
  if (!halftoneSheet || halftoneSheet.width !== width || halftoneSheet.height !== height) {
    const size = Math.max(3, Math.round(halftone.size || 6));
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const dots = tile.getContext('2d');
    dots.fillStyle = halftone.color || '#000000';
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.75]]) {
      dots.beginPath();
      dots.arc(x * size, y * size, size * (halftone.dot ?? 0.2), 0, Math.PI * 2);
      dots.fill();
    }
    // Copying a finished sheet each frame is cheaper than filling with a pattern.
    halftoneSheet = document.createElement('canvas');
    halftoneSheet.width = width;
    halftoneSheet.height = height;
    const sheet = halftoneSheet.getContext('2d');
    sheet.fillStyle = sheet.createPattern(tile, 'repeat');
    sheet.fillRect(0, 0, width, height);
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-atop';
  context.globalAlpha = halftone.alpha ?? 0.15;
  context.drawImage(halftoneSheet, 0, 0);
  context.restore();
}

/**
 * A comic theme's ink ("ink" in theme.json): fighters, map tiles and panels
 * get a bold outline and a hard shadow as they are drawn. Drawn with the
 * shapes, not over the finished picture: that would cost too much for OBS.
 */
function inkOf() {
  return Theme.current.ink;
}

/** Strokes the current path in the theme's ink, `extra` pixels wider than its outline. Nothing without ink. */
function inkPath(extra = 0) {
  const ink = inkOf();
  if (!ink) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = (ink.width ?? 3) * 2 + extra;
  ctx.strokeStyle = ink.color || '#0B0807';
  ctx.stroke();
  ctx.restore();
}

/** Whether the theme draws on a layer of its own (pixels, dots or larger letters) rather than straight on the screen. */
function themeHasLayer(theme) {
  return theme.pixelScale > 1 || Boolean(theme.halftone) || theme.fontScale !== 1;
}

/** Drawings that must lie over everything else of the frame, text included: see drawOnTop. */
let onTop = [];

/**
 * Draws something over everything drawn so far, names included: the
 * scoreboard, a battle's result, a skill's caption. On a theme's own layer,
 * text goes onto a sharp layer above the art, so a fighter's name would show
 * through a banner drawn later; these drawings get a pass of their own,
 * painted over that text.
 */
function drawOnTop(draw) {
  if (ctx === screen) draw();
  else onTop.push(draw);
}

/** Draws one frame with `render`, on the theme's layer if it has one. */
function frame(render) {
  const started = performance.now();
  try {
    drawFrame(render);
  } finally {
    noteFrameTime(performance.now() - started);
  }
}

// --- Frame times, for the control panel's status tab -----------------------------

const frameStats = { count: 0, totalMs: 0, slowMs: 0, since: performance.now() };

function noteFrameTime(ms) {
  frameStats.count++;
  frameStats.totalMs += ms;
  frameStats.slowMs = Math.max(frameStats.slowMs, ms);
}

/** Every few seconds: how long frames took to draw, so the streamer can see if OBS struggles. */
/**
 * Whether this browser draws with the graphics card: true, false (it draws
 * on the processor, as OBS does with "Browser Source Hardware Acceleration"
 * switched off, and battles stutter), or null when it cannot tell.
 */
const drawsWithGpu = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return null;
  }
})();

function reportFrameTimes(socket) {
  const now = performance.now();
  const seconds = (now - frameStats.since) / 1000;
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: 'overlay-stats',
        frameMs: frameStats.count ? frameStats.totalMs / frameStats.count : 0,
        slowMs: frameStats.slowMs,
        fps: seconds > 0 ? frameStats.count / seconds : 0,
        width: window.innerWidth,
        height: window.innerHeight,
        theme: Theme.current.id || '',
        gpu: drawsWithGpu,
      }),
    );
  }
  Object.assign(frameStats, { count: 0, totalMs: 0, slowMs: 0, since: now });
}

function drawFrame(render) {
  const theme = Theme.current;
  const scale = theme.pixelScale > 1 ? theme.pixelScale : 1;
  textLayer.setTransform(1, 0, 0, 1, 0, 0);
  textLayer.clearRect(0, 0, textCanvas.width, textCanvas.height);
  onTop = [];
  if (!themeHasLayer(theme)) {
    ctx = screen;
    render();
    return;
  }
  const width = Math.round(canvas.width / scale);
  const height = Math.round(canvas.height / scale);
  if (!pixelCtx || pixelLayer.width !== width || pixelLayer.height !== height) {
    pixelLayer.width = width;
    pixelLayer.height = height;
    pixelCtx = deferringContext(pixelLayer);
  }
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.clearRect(0, 0, canvas.width, canvas.height);
  // The art goes on the screen and its text on the text layer; later passes on the text layer, over both.
  let target = screen;
  let pass = render;
  for (let round = 0; pass && round < 3; round++) {
    // Everything keeps drawing in screen coordinates; the transform shrinks it onto the small layer.
    pixelCtx.setTransform(1, 0, 0, 1, 0, 0);
    pixelCtx.clearRect(0, 0, width, height);
    pixelCtx.setTransform(1 / scale, 0, 0, 1 / scale, 0, 0);
    deferred = [];
    ctx = pixelCtx;
    try {
      pass();
    } finally {
      ctx = screen;
    }
    if (scale > 1 && theme.hardEdges) hardenEdges(pixelCtx, width, height);
    if (theme.halftone) applyHalftone(pixelCtx, width, height, theme.halftone);
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.imageSmoothingEnabled = scale === 1;
    target.drawImage(pixelLayer, 0, 0, canvas.width, canvas.height);
    target.imageSmoothingEnabled = true;
    for (const op of deferred) replay(op, scale);
    deferred = [];
    const later = onTop;
    onTop = [];
    pass = later.length > 0 ? () => later.forEach((draw) => draw()) : null;
    target = textLayer;
  }
}

Theme.onChange(() => {
  FONT = Theme.current.font;
  // Shown at another size than 1920 x 1080 (a browser window, OBS scaling), the browser
  // must not smooth the pixels again: that is what makes pixel art look blurry.
  canvas.style.imageRendering = Theme.current.pixelScale > 1 ? 'pixelated' : 'auto';
  // A fresh layer: one read back by the hard-edge pass may have left the GPU.
  pixelLayer = document.createElement('canvas');
  pixelCtx = null;
  halftoneSheet = null;
  edgesTainted = false;
  if (!battle) drawPanel();
});

/**
 * Draws an element from the theme's image pack, if it has one, into a box.
 * Returns true when it did, so the caller skips its own drawing.
 */
function drawThemeImage(key, x, y, width, height) {
  const image = Theme.image(key);
  if (!image) return false;
  ctx.drawImage(image, x, y, width, height);
  return true;
}

/** A panel's background. Themes may draw their own (art.box). */
function drawBox(x, y, width, height, options = {}) {
  const theme = Theme.current;
  if (theme.art.box) {
    theme.art.box(ctx, x, y, width, height, { ...options, px: theme.pixelScale, palette: theme.palette });
    return;
  }
  const radius = options.radius ?? PANEL.radius;
  ctx.fillStyle = options.strong ? theme.palette.panelStrong : theme.palette.panel;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
  if (options.accent) {
    ctx.fillStyle = options.accent;
    ctx.beginPath();
    ctx.roundRect(x, y, 14, height, [radius, 0, 0, radius]);
    ctx.fill();
  }
}

// --- Background panel: map and cities --------------------------------------

function hexCenter(tile, originX, originY) {
  return {
    x: originX + HEX_SIZE * Math.sqrt(3) * (tile.q + tile.r / 2),
    y: originY + HEX_SIZE * 1.5 * tile.r,
  };
}

function hexPath(x, y, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** A small castle: a wall with three battlements. Marks a guild's city. */
function drawCastle(x, y) {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x - 10, y - 3, 20, 11);
  for (const dx of [-10, -3, 4]) ctx.fillRect(x + dx, y - 9, 6, 6);
}

/** Whether a tile is the god's tile in the center, which a guild only ever holds for a while. */
function isGodTile(tile) {
  return Boolean(state.center && tile.id === state.center.id);
}

/**
 * The god's tile: a ring in the god's color marks it whoever holds it. Free,
 * it shows a small crown; held, the minutes left before the god takes it back.
 */
function drawGodTile(tile, x, y, hexSize, textSize) {
  hexPath(x, y, hexSize);
  ctx.lineWidth = Math.max(2.5, hexSize / 9);
  ctx.strokeStyle = state.god.color;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (tile.owner) {
    const text = tr('overlay.map.minutes', { minutes: state.center.minutesLeft });
    ctx.font = `700 ${textSize}px ${FONT}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = textSize / 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeText(text, x, y + 1);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, x, y + 1);
  } else {
    // A crown: nobody holds the tile, it is the prize of the next Clash.
    const u = hexSize * 0.3;
    ctx.beginPath();
    ctx.moveTo(x - u * 1.3, y + u * 0.8);
    ctx.lineTo(x - u * 1.3, y - u * 0.6);
    ctx.lineTo(x - u * 0.6, y);
    ctx.lineTo(x, y - u * 0.9);
    ctx.lineTo(x + u * 0.6, y);
    ctx.lineTo(x + u * 1.3, y - u * 0.6);
    ctx.lineTo(x + u * 1.3, y + u * 0.8);
    ctx.closePath();
    ctx.fillStyle = state.god.color;
    ctx.fill();
  }
}

/** A tile's development level as a small number in its middle. Level 0 shows nothing. */
function drawTileLevel(tile, x, y, size) {
  if (tile.isCity || !tile.level || isGodTile(tile)) return;
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.strokeText(String(tile.level), x, y + 1);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(String(tile.level), x, y + 1);
}

function drawMap(guildColors, originX, originY) {
  for (const tile of state.tiles) {
    const { x, y } = hexCenter(tile, originX, originY);
    hexPath(x, y, HEX_SIZE - 2);
    inkPath();
    ctx.fillStyle = tile.owner ? guildColors[tile.owner] : Theme.current.palette.neutralTile;
    ctx.globalAlpha = tile.owner && !tile.isCity ? 0.8 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = tile.isCity ? 3 : 1.5;
    ctx.strokeStyle = tile.isCity ? '#FFFFFF' : 'rgba(255, 255, 255, 0.28)';
    ctx.stroke();
    if (tile.scorched && !tile.owner) {
      // Land the god laid waste: striped in the god's color until a guild claims it again.
      ctx.save();
      hexPath(x, y, HEX_SIZE - 3);
      ctx.clip();
      ctx.strokeStyle = state.god.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 3;
      for (let offset = -HEX_SIZE * 2; offset <= HEX_SIZE * 2; offset += 9) {
        ctx.beginPath();
        ctx.moveTo(x + offset - HEX_SIZE, y + HEX_SIZE);
        ctx.lineTo(x + offset + HEX_SIZE, y - HEX_SIZE);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (tile.isCity) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1.3, 1.3);
      drawCastle(0, 0);
      ctx.restore();
    }
    drawTileNature(tile, x, y, HEX_SIZE - 3);
    drawTileMark(tile, x, y, HEX_SIZE - 3);
    if (tile.burning) drawTileFlames(x, y, HEX_SIZE - 3, performance.now(), tile.q * 7 + tile.r * 3);
    if (isGodTile(tile)) drawGodTile(tile, x, y, HEX_SIZE - 3, 16);
    drawTileLevel(tile, x, y, 19);
  }
  drawMishapEffects(originX, originY);
}

// --- Mishaps on the corner map -----------------------------------------------

/** The newest mishap already known; null until the first state (older ones are not replayed). */
let mishapSeen = null;
/** Mishaps being shown on the corner map: the mishap and when its animation starts. */
let mishapEffects = [];
const MISHAP_MS = 2600;
/** The words floating up from a tile, by mishap kind: overlay.mishap.<kind> in the language files. */
const MISHAP_KINDS = ['lightning', 'fire', 'spread', 'burn', 'burntOut', 'doused', 'harvest'];

/**
 * Numbers rising at a Monument. Two kinds:
 * - "+3" in the guild's color, above it: what its land yields. A Monument
 *   grows once per window, all at once; so the overlay never sits still for
 *   minutes, it shows the gain in `parts` parts (fewer for a smaller gain) at
 *   random moments over the next `spreadMs`, the first within `firstMs`: with
 *   three guilds about one every 4 seconds. The Monument's bar and percentage
 *   on the overlay move with the parts; the totals are exact, only spread out.
 * - a small "+1" with a speech bubble beside it: a chatter of the guild just
 *   earned a tick by chatting. At most `maxTicks` at once, spread over a second.
 */
const MONUMENT_POP = { ms: 2600, firstMs: 3500, spreadMs: 240_000, parts: 20, tickMs: 1600, maxTicks: 8 };
let monumentPops = [];
/** Each guild's Monument progress at the last state, and the season it belongs to. */
let monumentsSeen = null;

/** Splits `amount` into `parts` whole numbers of at least 1 each, at random. */
function splitAmount(amount, parts) {
  const cuts = new Set();
  while (cuts.size < parts - 1) cuts.add(1 + Math.floor(Math.random() * (amount - 1)));
  const points = [0, ...[...cuts].sort((a, b) => a - b), amount];
  return points.slice(1).map((point, i) => point - points[i]);
}

function noteMonumentGrowth() {
  if (!state || !state.guilds) return;
  const now = performance.now();
  const progress = Object.fromEntries(state.guilds.map((g) => [g.id, g.monument.progress]));
  const ticks = Object.fromEntries(state.guilds.map((g) => [g.id, g.ticks || 0]));
  if (monumentsSeen && monumentsSeen.season === state.seasonId) {
    for (const guild of state.guilds) {
      // Chat ticks since the last state (the count starts again when the server does).
      const earned = Math.min(MONUMENT_POP.maxTicks, ticks[guild.id] - (monumentsSeen.ticks[guild.id] ?? ticks[guild.id]));
      for (let i = 0; i < earned; i++) monumentPops.push({ guild: guild.id, tick: true, amount: 1, start: now + Math.random() * 1000 });
    }
    for (const guild of state.guilds) {
      const grown = progress[guild.id] - (monumentsSeen.progress[guild.id] ?? progress[guild.id]);
      if (grown <= 0) continue;
      // What still waits from the last gain joins the new one, and the whole is spread out
      // again: two gains close together never show as a burst.
      const waiting = monumentPops.filter((pop) => pop.guild === guild.id && !pop.tick && pop.start > now);
      monumentPops = monumentPops.filter((pop) => !waiting.includes(pop));
      const total = grown + waiting.reduce((sum, pop) => sum + pop.amount, 0);
      const parts = Math.min(MONUMENT_POP.parts, total);
      const times = Array.from({ length: parts }, (_, i) =>
        i === 0 ? Math.random() * MONUMENT_POP.firstMs : Math.random() * MONUMENT_POP.spreadMs,
      ).sort((a, b) => a - b);
      splitAmount(total, parts).forEach((amount, i) => monumentPops.push({ guild: guild.id, amount, start: now + times[i] }));
    }
  } else {
    monumentPops = [];
  }
  monumentsSeen = { season: state.seasonId, progress, ticks };
}

/** A guild's Monument progress as the overlay shows it: without the parts of its gain still to pop. */
function shownProgress(guild) {
  const now = performance.now();
  const waiting = monumentPops.reduce((sum, pop) => sum + (pop.guild === guild.id && !pop.tick && pop.start > now ? pop.amount : 0), 0);
  return Math.max(0, guild.monument.progress - waiting);
}

/**
 * The popups of one guild at its Monument: its gains rising from x, y by
 * `rise`; its chat ticks smaller, from beside it at `tickX`, `tickY`.
 */
function drawMonumentPops(guildId, color, x, y, rise, size, tickX, tickY) {
  const now = performance.now();
  for (const pop of monumentPops) {
    if (pop.guild !== guildId || now < pop.start) continue;
    if (pop.tick) {
      drawTickPop(pop, tickX, tickY, rise, size * 0.62, now);
      continue;
    }
    const t = (now - pop.start) / MONUMENT_POP.ms;
    if (t >= 1) continue;
    ctx.save();
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const grow = popIn(t / 0.18);
    ctx.translate(x, y - rise * ease(t * 1.4));
    ctx.scale(grow, grow);
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    outlinedText(`+${pop.amount}`, 0, 0);
    ctx.restore();
  }
}

/** A chat tick: "+1" with a little speech bubble, rising and fading, a little to one side at random. */
function drawTickPop(pop, x, y, rise, size, now) {
  const t = (now - pop.start) / MONUMENT_POP.tickMs;
  if (t >= 1) return;
  pop.dx ??= (Math.random() - 0.5) * size * 0.8;
  ctx.save();
  ctx.globalAlpha = 0.9 * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
  ctx.translate(x + pop.dx, y - rise * 0.8 * ease(t * 1.3));
  // The bubble: a rounded box with a tail, then the number beside it.
  const w = size * 1.1;
  const h = size * 0.8;
  ctx.beginPath();
  ctx.roundRect(-w - 2, -h / 2, w, h, h * 0.3);
  ctx.moveTo(-w * 0.75, h / 2 - 1);
  ctx.lineTo(-w * 0.85, h / 2 + h * 0.35);
  ctx.lineTo(-w * 0.5, h / 2 - 1);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.stroke();
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  outlinedText('+1', 2, 0);
  ctx.restore();
}

/** Picks up mishaps that are new in the state, to animate them one after another. */
function noteMishaps() {
  const list = (state && state.mishaps) || [];
  const newest = list.reduce((max, m) => Math.max(max, m.id), 0);
  // Another channel's game, or a fresh season: start counting again.
  if (mishapSeen !== null && newest < mishapSeen) mishapSeen = newest;
  if (mishapSeen !== null) {
    const now = performance.now();
    list.filter((m) => m.id > mishapSeen).forEach((m, i) => mishapEffects.push({ ...m, start: now + i * 600 }));
  }
  mishapSeen = Math.max(mishapSeen ?? 0, newest);
}

/**
 * What a recent mishap left on a tile, fading over a few windows: lightning a
 * burnt patch with cracks running out from where it struck, a fire grey ash
 * with charred spots and a last few embers. Drawn the same each time (seeded
 * by the tile), so it does not flicker.
 */
function drawTileMark(tile, x, y, size) {
  const mark = tile.mark;
  if (!mark) return;
  const strength = 1 - mark.age * 0.6;
  const fresh = 1 - mark.age;
  const seed = tile.q * 31 + tile.r * 17 + 5;
  ctx.save();
  hexPath(x, y, size);
  ctx.clip();
  if (mark.kind === 'lightning') {
    const burn = ctx.createRadialGradient(x, y, 0, x, y, size * 0.85);
    burn.addColorStop(0, `rgba(18, 10, 6, ${0.8 * strength})`);
    burn.addColorStop(0.55, `rgba(30, 18, 10, ${0.45 * strength})`);
    burn.addColorStop(1, 'rgba(30, 18, 10, 0)');
    ctx.fillStyle = burn;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
    // Cracks, each a jagged line out from the middle; a fresh one still glows inside.
    for (const [color, width] of [[`rgba(12, 7, 4, ${0.9 * strength})`, 0.09], [`rgba(255, 214, 120, ${0.55 * fresh})`, 0.035]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size * width);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let c = 0; c < 4; c++) {
        let angle = hash01(seed + c) * Math.PI * 2;
        let px = x;
        let py = y;
        ctx.beginPath();
        ctx.moveTo(px, py);
        for (let step = 0; step < 3; step++) {
          angle += (hash01(seed + c * 7 + step) - 0.5) * 1.2;
          const reach = size * (0.22 + hash01(seed + c * 3 + step * 11) * 0.12);
          px += Math.cos(angle) * reach;
          py += Math.sin(angle) * reach;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = `rgba(72, 68, 64, ${0.55 * strength})`;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
    for (let i = 0; i < 6; i++) {
      const angle = hash01(seed + i) * Math.PI * 2;
      const reach = hash01(seed + i + 40) * size * 0.6;
      circle(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach, size * (0.12 + hash01(seed + i + 80) * 0.14));
      ctx.fillStyle = `rgba(22, 18, 16, ${0.6 * strength})`;
      ctx.fill();
    }
    for (let i = 0; i < 4; i++) {
      const angle = hash01(seed + i + 120) * Math.PI * 2;
      const reach = hash01(seed + i + 160) * size * 0.65;
      circle(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach, Math.max(1, size * 0.05));
      ctx.fillStyle = `rgba(255, 128, 40, ${0.8 * fresh})`;
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * What the land is like, in a tile's corners (the middle keeps its level
 * clear): fertile land grows tufts of grass, and the most fertile a flower
 * or two; barren land is cracked and stony. Middling land shows nothing.
 * Positions come from the tile, so they never jump.
 */
const NATURE = { lush: 0.62, barren: 0.38 };

function drawTileNature(tile, x, y, size) {
  const share = tile.fertility;
  if (typeof share !== 'number' || tile.isCity || isGodTile(tile)) return;
  if (share < NATURE.lush && share > NATURE.barren) return;
  const seed = tile.q * 31 + tile.r * 17 + 5;
  /** A spot in the tile's outer ring, the `i`th of `count`, turned by the tile's own angle. */
  const spot = (i, count, reach) => {
    const angle = hash01(seed) * Math.PI * 2 + (i / count) * Math.PI * 2 + (hash01(seed + i) - 0.5) * 0.6;
    const out = size * (reach + 0.08 * hash01(seed + i * 3));
    return { x: x + Math.cos(angle) * out, y: y + Math.sin(angle) * out * 0.92 };
  };
  ctx.save();
  hexPath(x, y, size);
  ctx.clip();
  if (share >= NATURE.lush) {
    const strength = (share - NATURE.lush) / (1 - NATURE.lush);
    const tufts = 3 + Math.round(strength * 3);
    ctx.lineCap = 'round';
    for (let i = 0; i < tufts; i++) {
      const p = spot(i, tufts, 0.6);
      const blade = size * 0.2;
      for (const [dx, lean, color] of [[-0.12, -0.5, '#2F6B26'], [0.12, 0.45, '#2F6B26'], [0, 0.05, '#A6E07A']]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.4, size * 0.055);
        ctx.beginPath();
        ctx.moveTo(p.x + dx * blade, p.y);
        ctx.quadraticCurveTo(p.x + dx * blade, p.y - blade * 0.6, p.x + dx * blade + lean * blade, p.y - blade);
        ctx.stroke();
      }
    }
    // The most fertile land flowers.
    if (strength > 0.55) {
      for (let i = 0; i < 2; i++) {
        const p = spot(i + 0.5, 2, 0.5);
        circle(p.x, p.y - size * 0.05, Math.max(1.6, size * 0.06));
        ctx.fillStyle = i === 0 ? '#FFE36E' : '#FFFFFF';
        ctx.fill();
      }
    }
  } else {
    const strength = (NATURE.barren - share) / NATURE.barren;
    // Cracks: short zigzags reaching in from the edge.
    const cracks = 1 + Math.round(strength * 2);
    ctx.strokeStyle = 'rgba(35, 22, 10, 0.55)';
    ctx.lineWidth = Math.max(1.2, size * 0.045);
    ctx.lineJoin = 'round';
    for (let i = 0; i < cracks; i++) {
      const angle = hash01(seed + 40 + i) * Math.PI * 2;
      ctx.beginPath();
      for (let k = 0; k <= 3; k++) {
        const out = size * (0.95 - k * 0.14);
        const bend = (k % 2 === 0 ? -1 : 1) * 0.16;
        const px = x + Math.cos(angle + bend) * out;
        const py = y + Math.sin(angle + bend) * out;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // Stones.
    const stones = 2 + Math.round(strength * 2);
    for (let i = 0; i < stones; i++) {
      const p = spot(i, stones, 0.62);
      const r = size * (0.06 + 0.04 * hash01(seed + i * 7));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * 1.3, r, hash01(seed + i) * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(205, 192, 172, 0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(50, 38, 26, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Small flames licking up from the lower part of a burning tile. */
function drawTileFlames(x, y, size, now, seed) {
  ctx.save();
  const base = y + size * 0.55;
  const tongues = [[-0.45, 0.7], [-0.16, 1.0], [0.14, 0.85], [0.44, 0.65]];
  const layers = [['#C8321E', 1], ['#F28A1E', 0.68], ['#FFE07A', 0.4]];
  for (const [color, scale] of layers) {
    ctx.fillStyle = color;
    tongues.forEach(([dx, tall], i) => {
      const lick = 0.75 + 0.25 * Math.sin(now / (85 + i * 19) + seed + i * 2.1);
      const height = size * tall * scale * lick;
      const fx = x + dx * size;
      const half = size * 0.17 * (0.5 + scale * 0.6);
      const sway = Math.sin(now / 160 + i + seed) * half * 0.6;
      ctx.beginPath();
      ctx.moveTo(fx - half, base);
      ctx.quadraticCurveTo(fx - half, base - height * 0.6, fx + sway, base - height);
      ctx.quadraticCurveTo(fx + half, base - height * 0.6, fx + half, base);
      ctx.closePath();
      ctx.fill();
    });
  }
  ctx.restore();
}

/** A jagged bolt from above down to x, y, the same shape for the same seed. */
function drawBolt(x, y, length, seed, width) {
  ctx.beginPath();
  ctx.moveTo(x + (hash01(seed) - 0.5) * 30, y - length);
  const steps = 6;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    ctx.lineTo(x + (hash01(seed + i * 3.1) - 0.5) * 34 * (1 - t), y - length * (1 - t));
  }
  ctx.lineTo(x, y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width + 6;
  ctx.strokeStyle = 'rgba(160, 190, 255, 0.45)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = '#FFFBE0';
  ctx.stroke();
}

/** Lightning, fires and harvests that just happened, each with a short animation and its effect in levels. */
function drawMishapEffects(originX, originY) {
  const now = performance.now();
  mishapEffects = mishapEffects.filter((e) => now - e.start < MISHAP_MS);
  for (const effect of mishapEffects) {
    const elapsed = now - effect.start;
    if (elapsed < 0) continue;
    const tile = state.tiles.find((t) => t.id === effect.tile);
    if (!tile) continue;
    const { x, y } = hexCenter(tile, originX, originY);
    const t = elapsed / MISHAP_MS;
    ctx.save();
    if (effect.kind === 'lightning' && t < 0.22) {
      // The bolt flickers, and the tile flashes white.
      if (Math.floor(elapsed / 60) % 3 !== 2) drawBolt(x, y, 150, effect.id * 13.7, 4);
      hexPath(x, y, HEX_SIZE - 2);
      ctx.fillStyle = `rgba(255, 255, 240, ${0.8 * (1 - t / 0.22)})`;
      ctx.fill();
    }
    if ((effect.kind === 'fire' || effect.kind === 'spread') && t < 0.35) {
      circle(x, y, HEX_SIZE * (0.4 + 1.4 * t));
      ctx.lineWidth = 5;
      ctx.strokeStyle = `rgba(255, 130, 30, ${1 - t / 0.35})`;
      ctx.stroke();
    }
    if (effect.kind === 'harvest' && t < 0.6) {
      hexPath(x, y, HEX_SIZE - 2);
      ctx.fillStyle = `rgba(255, 220, 90, ${0.55 * (1 - t / 0.6)})`;
      ctx.fill();
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + t * 3;
        const reach = HEX_SIZE * (0.3 + t);
        ctx.fillStyle = '#FFE58A';
        ctx.fillRect(x + Math.cos(angle) * reach - 2, y + Math.sin(angle) * reach - 2, 4, 4);
      }
    }
    if (effect.kind === 'doused' || effect.kind === 'burntOut') {
      // Steam or smoke rising off the tile.
      for (let i = 0; i < 3; i++) {
        const rise = (t + i * 0.2) % 1;
        circle(x + (i - 1) * 12, y - rise * 50, 6 + rise * 10);
        ctx.fillStyle = effect.kind === 'doused' ? `rgba(230, 240, 255, ${0.6 * (1 - rise)})` : `rgba(60, 55, 50, ${0.6 * (1 - rise)})`;
        ctx.fill();
      }
    }
    // What it did, floating up from the tile.
    const change = effect.to - effect.from;
    const kind = MISHAP_KINDS.includes(effect.kind) ? tr(`overlay.mishap.${effect.kind}`) : '';
    const label = `${kind}${change ? ` ${change > 0 ? '+' : '−'}${Math.abs(change)}` : ''}`;
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.font = `700 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    const ty = y - HEX_SIZE * 0.6 - 26 * Math.min(1, t * 2);
    ctx.strokeText(label, x, ty);
    ctx.fillStyle = change > 0 ? '#9BF07A' : change < 0 ? '#FF8A6A' : '#E6F0FF';
    ctx.fillText(label, x, ty);
    ctx.restore();
  }
}

/** Whether the corner panel moves by itself: something burns, or a mishap is being shown. */
let panelAnimating = false;
let panelDrawnAt = 0;

function panelBlocked() {
  return Boolean(pachinko || battle || (announcement && (announcement.map || announcement.lineup || announcement.celebrate || announcement.recap)));
}

function panelNeedsAnimation() {
  if (!state || !state.session.active || !state.overlay.map.visible) return false;
  const now = performance.now();
  mishapEffects = mishapEffects.filter((e) => now - e.start < MISHAP_MS);
  monumentPops = monumentPops.filter((p) => now - p.start < (p.tick ? MONUMENT_POP.tickMs : MONUMENT_POP.ms));
  // Only a number on its way up needs the animation; the ones still waiting are picked up by the next state.
  const popping = monumentPops.some((p) => p.start <= now);
  return mishapEffects.length > 0 || popping || state.tiles.some((t) => t.burning);
}

function ensurePanelAnimation() {
  if (panelAnimating || panelBlocked() || !panelNeedsAnimation()) return;
  panelAnimating = true;
  requestAnimationFrame(animatePanel);
}

function animatePanel(now) {
  if (panelBlocked() || !panelNeedsAnimation()) {
    panelAnimating = false;
    if (!panelBlocked()) frame(renderPanel);
    return;
  }
  // About 30 frames a second is plenty for small flames, and spares OBS.
  if (now - panelDrawnAt >= 33) {
    panelDrawnAt = now;
    frame(renderPanel);
  }
  requestAnimationFrame(animatePanel);
}

function drawGuildRows(x, y, width) {
  const rowHeight = 104;
  // Each row starts with the guild's Monument in a column of its own, wide enough for its
  // banner and scaffolding, so it never reaches the text or the bar beside it.
  const column = 104;
  // With its banner a finished Monument is about 1.25 times this tall; it must stay in its row.
  const monumentHeight = 72;
  state.guilds.forEach((guild, index) => {
    const top = y + index * rowHeight;
    const monument = guild.monument;
    const share = Math.min(1, shownProgress(guild) / monument.goal);
    // Centred a little left of the column's middle: the banner flies to the right.
    drawMonument(monumentDesign(guild, index), share, x + column * 0.42, top + 94, monumentHeight, guild.color);
    // The ticks beside the Monument, clear of the guild's texts to the right.
    drawMonumentPops(guild.id, guild.color, x + column * 0.42, top + 40, 34, 24, x + column * 0.7, top + 70);

    const tx = x + column;
    const tw = width - column;
    ctx.fillStyle = guild.color;
    ctx.font = `600 24px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(guild.name, tx, top + 22);

    const nameWidth = textWidth(guild.name);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `400 17px ${FONT}`;
    ctx.textAlign = 'right';
    const tiles = tr('overlay.guild.tiles', { count: guild.tiles });
    const boost = guild.xpBoost ? `${tr('overlay.guild.xpBoost')} · ` : '';
    // The long form if it fits beside the name, else a shorter one.
    let info = `${boost}${tr('overlay.guild.active', { count: guild.active })} · ${tiles}`;
    if (textWidth(info) > tw - nameWidth - 14) info = `${boost}${tiles}`;
    if (textWidth(info) > tw - nameWidth - 14) info = tiles;
    ctx.fillText(info, tx + tw, top + 22);

    // The Monument: the race that decides the season. While the guild's land burns, the line
    // tells chat how to put it out instead: enough of the guild writing before the window ends.
    ctx.textAlign = 'left';
    if (guild.fire) drawFireLine(guild.fire, tx, top + 54, tw - 60, index);
    else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = `400 16px ${FONT}`;
      ctx.fillText(tr('overlay.guild.monument', { income: guild.monument.income }), tx, top + 54, tw - 60);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(`${Math.floor(share * 100)}%`, tx + tw, top + 54);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(tx, top + 70, tw, 9);
    ctx.fillStyle = guild.color;
    ctx.fillRect(tx, top + 70, tw * share, 9);
  });
}

/**
 * A guild's fire line, at x and the text's middle y: small flames, then how
 * many more of the guild must write in chat to put the fire out, pulsing; or,
 * once enough wrote, that chat is putting it out.
 */
function drawFireLine(fire, x, y, width, seed) {
  const now = performance.now();
  const missing = Math.max(0, fire.needed - fire.writers);
  drawTileFlames(x + 10, y - 5, 17, now, seed * 5 + 1);
  ctx.font = `600 16px ${FONT}`;
  if (missing > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ctx.fillStyle = `rgb(255, ${Math.round(150 + 60 * pulse)}, ${Math.round(70 + 50 * pulse)})`;
    ctx.fillText(tr('overlay.guild.fire', { count: missing }), x + 26, y, width - 26);
  } else {
    ctx.fillStyle = '#BFE3FF';
    ctx.fillText(tr('overlay.guild.fireDousing'), x + 26, y, width - 26);
  }
}

/** A running countdown before a fight, as last reported by the server; null when none runs. */
let countdown = null;

/** A banner between battles, e.g. "Battle 2 of 3". Null when none is shown. */
let announcement = null;
let announcementTimer = null;

function onAnnounce(message) {
  clearTimeout(announcementTimer);
  // An announcement after a battle's result takes over the screen from it.
  if (battle && battle.end) battle = null;
  announcement = message.title ? { ...message, shownAt: performance.now() } : null;
  if (announcement) {
    announcementTimer = setTimeout(() => {
      announcement = null;
      if (!battle) drawPanel();
    }, message.holdMs);
    // The event map is animated, so it is redrawn every frame while it shows.
    if (announcement.map || announcement.lineup || announcement.celebrate || announcement.recap) requestAnimationFrame(animateAnnouncement);
  }
  if (!battle) drawPanel();
}

function animateAnnouncement() {
  if (!announcement || !(announcement.map || announcement.lineup || announcement.celebrate || announcement.recap) || battle) return;
  drawPanel();
  requestAnimationFrame(animateAnnouncement);
}

// --- Event map: the large map shown during a War or a god event ---------------

const BIG_HEX = 74;
const HEX_DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function hexDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function bigCenter(tile) {
  return {
    x: canvas.width / 2 + BIG_HEX * Math.sqrt(3) * (tile.q + tile.r / 2),
    y: 630 + BIG_HEX * 1.5 * tile.r,
  };
}

function ease(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Diagonal stripes in the god's color, clipped to a hexagon: scorched land. */
function drawScorch(x, y, size, alpha) {
  ctx.save();
  hexPath(x, y, size);
  ctx.clip();
  ctx.strokeStyle = state.god.color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = size / 9;
  for (let offset = -size * 2; offset <= size * 2; offset += size / 3.2) {
    ctx.beginPath();
    ctx.moveTo(x + offset - size, y + size);
    ctx.lineTo(x + offset + size, y - size);
    ctx.stroke();
  }
  ctx.restore();
}

/** An arrow from an attacker's tile to the tile it attacks, with dashes that run toward the target. */
function drawAttackArrow(from, to, color, elapsed) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const startX = from.x;
  const startY = from.y;
  const endX = to.x - ux * BIG_HEX * 0.5;
  const endY = to.y - uy * BIG_HEX * 0.5;

  ctx.save();
  ctx.lineCap = 'round';
  for (const [width, stroke] of [[16, 'rgba(0, 0, 0, 0.75)'], [9, '#FFFFFF']]) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.setLineDash(width === 9 ? [16, 14] : []);
    ctx.lineDashOffset = -elapsed / 22;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // The arrowhead, in the attacker's color with a dark edge.
  const head = 30;
  ctx.beginPath();
  ctx.moveTo(endX + ux * head * 0.7, endY + uy * head * 0.7);
  ctx.lineTo(endX - ux * head * 0.5 - uy * head * 0.6, endY - uy * head * 0.5 + ux * head * 0.6);
  ctx.lineTo(endX - ux * head * 0.5 + uy * head * 0.6, endY - uy * head * 0.5 - ux * head * 0.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.stroke();
  ctx.restore();
}

/** The god strikes from above: a flickering beam in the god's color down onto a tile. */
function drawGodBeam(to, mapTop, elapsed) {
  const flicker = 0.55 + 0.3 * Math.sin(elapsed / 70) + 0.15 * Math.sin(elapsed / 23);
  ctx.save();
  ctx.globalAlpha = Math.max(0.25, flicker);
  const gradient = ctx.createLinearGradient(0, mapTop, 0, to.y);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(1, state.god.color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(to.x - 7, mapTop);
  ctx.lineTo(to.x + 7, mapTop);
  ctx.lineTo(to.x + 26, to.y);
  ctx.lineTo(to.x - 26, to.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEventMap(elapsed) {
  const map = announcement.map;
  const colors = Object.fromEntries(state.guilds.map((g) => [g.id, g.color]));
  colors.god = state.god.color;
  const byId = Object.fromEntries(state.tiles.map((tile) => [tile.id, tile]));
  const changes = Object.fromEntries((map.changes || []).map((change) => [change.tile, change]));
  // The change plays shortly after the map appears, so the eye is already on it.
  const change = ease((elapsed - 700) / 1100);

  // Backdrop and headline.
  const box = { left: 420, top: 70, width: 1080, height: 950 };
  drawBox(box.left, box.top, box.width, box.height, { radius: 28, strong: true });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 54px ${FONT}`;
  // A long title (German runs about a third longer than English) is squeezed into the box.
  ctx.fillText(announcement.title, canvas.width / 2, box.top + 70, box.width - 60);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  let size = 26;
  do {
    ctx.font = `400 ${size}px ${FONT}`;
    size -= 1;
  } while (size > 14 && textWidth(announcement.subtitle || '') > box.width - 80);
  ctx.fillText(announcement.subtitle || '', canvas.width / 2, box.top + 128);

  // Tiles.
  for (const tile of state.tiles) {
    const { x, y } = bigCenter(tile);
    const changed = changes[tile.id];
    // A changing tile starts in its old color; the new one grows over it.
    const owner = changed ? changed.from : tile.owner;
    hexPath(x, y, BIG_HEX - 4);
    inkPath(2);
    ctx.fillStyle = owner ? colors[owner] : Theme.current.palette.neutralTileBig;
    ctx.globalAlpha = owner && !tile.isCity ? 0.85 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (!owner && tile.scorched && !changed) drawScorch(x, y, BIG_HEX - 5, 0.55);
    if (!changed) {
      drawTileNature(tile, x, y, BIG_HEX - 5);
      drawTileMark(tile, x, y, BIG_HEX - 5);
    }

    if (changed && change > 0) {
      hexPath(x, y, (BIG_HEX - 4) * change);
      ctx.fillStyle = changed.to ? colors[changed.to] : Theme.current.palette.neutralTileBig;
      ctx.globalAlpha = changed.to ? 0.95 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (changed.scorched) drawScorch(x, y, (BIG_HEX - 5) * change, 0.6);
      if (change < 1) {
        // A bright ring runs outward with the change.
        hexPath(x, y, (BIG_HEX - 4) * (0.3 + change));
        ctx.lineWidth = 8 * (1 - change) + 1;
        ctx.strokeStyle = `rgba(255, 255, 255, ${1 - change})`;
        ctx.stroke();
      }
    }

    hexPath(x, y, BIG_HEX - 4);
    ctx.lineWidth = tile.isCity ? 6 : 2.5;
    ctx.strokeStyle = tile.isCity ? '#FFFFFF' : 'rgba(255, 255, 255, 0.28)';
    ctx.stroke();

    if (tile.isCity) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(2.6, 2.6);
      drawCastle(0, 0);
      ctx.restore();
    }
    if (isGodTile(tile) && (!changed || change >= 1)) drawGodTile(tile, x, y, BIG_HEX - 6, 28);
    // A tile that is changing hands shows its level once the change is through.
    if (!changed || change >= 1) drawTileLevel(tile, x, y, 30);
  }

  // Tiles that were attacked and held: two rings in the owner's color close in and fade.
  for (const id of map.held || []) {
    const tile = byId[id];
    if (!tile) continue;
    const { x, y } = bigCenter(tile);
    for (const delay of [0, 500]) {
      const t = ease((elapsed - 500 - delay) / 900);
      if (t <= 0 || t >= 1) continue;
      hexPath(x, y, (BIG_HEX - 4) * (1.5 - 0.5 * t));
      ctx.lineWidth = 7;
      ctx.strokeStyle = tile.owner ? colors[tile.owner] : '#FFFFFF';
      ctx.globalAlpha = 1 - t;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    hexPath(x, y, BIG_HEX - 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
  }

  // Tiles under attack: a pulsing outline, and an arrow from the attacker or a beam from the god.
  for (const target of map.targets || []) {
    const tile = byId[target.tile];
    if (!tile) continue;
    const to = bigCenter(tile);
    const pulse = 1 + 0.05 * Math.sin(elapsed / 160);
    hexPath(to.x, to.y, (BIG_HEX - 2) * pulse);
    ctx.lineWidth = 8;
    ctx.strokeStyle = colors[target.by] || '#FFFFFF';
    ctx.stroke();
    hexPath(to.x, to.y, (BIG_HEX - 2) * pulse + 6);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();

    if (target.by === 'god') {
      drawGodBeam(to, box.top + 170, elapsed);
      continue;
    }
    // The attack starts from the attacker's own tile next to the target, nearest its city.
    const city = state.tiles.find((t) => t.isCity && t.owner === target.by);
    let origin = null;
    for (const [dq, dr] of HEX_DIRECTIONS) {
      const neighbor = byId[`${tile.q + dq},${tile.r + dr}`];
      if (!neighbor || neighbor.owner !== target.by) continue;
      if (!origin || (city && hexDistance(neighbor, city) < hexDistance(origin, city))) origin = neighbor;
    }
    if (origin || city) drawAttackArrow(bigCenter(origin || city), to, colors[target.by], elapsed);
  }

  // Beside each city, on the side facing away from the map: its Monument, and the guild's name under it.
  ctx.font = `700 26px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const tile of state.tiles) {
    if (!tile.isCity) continue;
    const index = state.guilds.findIndex((g) => g.id === tile.owner);
    const guild = state.guilds[index];
    if (!guild) continue;
    const { x, y } = bigCenter(tile);
    const outward = x < canvas.width / 2 - 1 ? -1 : 1;
    const mx = x + outward * (BIG_HEX + 112);
    const share = Math.min(1, guild.monument.progress / guild.monument.goal);
    drawMonument(monumentDesign(guild, index), share, mx, y + 52, 150, guild.color);
    ctx.font = `700 26px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = guild.color;
    outlinedText(guild.name, mx, y + 78);
  }
}

/** A centered banner with a headline and one line below it. */
function drawBanner(headline, subline, color) {
  const width = 980;
  const height = 190;
  const left = (canvas.width - width) / 2;
  const top = (canvas.height - height) / 2;
  drawBox(left, top, width, height, { radius: 22, strong: true, accent: color });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color || '#FFFFFF';
  ctx.font = `700 64px ${FONT}`;
  ctx.fillText(headline, canvas.width / 2, top + 78, width - 60);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  // Shrink a long line until it fits the banner.
  let size = 24;
  do {
    ctx.font = `400 ${size}px ${FONT}`;
    size -= 1;
  } while (size > 13 && textWidth(subline) > width - 70);
  ctx.fillText(subline, canvas.width / 2, top + 142);
}

function drawPanel() {
  frame(renderPanel);
  ensurePanelAnimation();
}

function renderPanel() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // The corner panels are the screen unless something else has it; they slide away and back.
  const corner = !pachinko && !announcement && !countdown;
  noteCorner(corner);
  if (corner) {
    drawCorner(cornerOut());
    return;
  }
  if (cornerOut() < 1) drawCorner(cornerOut());
  if (pachinko) {
    drawPachinko(performance.now() - pachinko.shownAt);
    return;
  }
  if (announcement && announcement.map && state && !announcement.celebrate) {
    // The large event map replaces the corner panel while it shows.
    drawEventMap(performance.now() - announcement.shownAt);
    return;
  }
  if (announcement && announcement.lineup) {
    drawLineup(announcement);
    return;
  }
  if (announcement && announcement.celebrate) {
    drawCelebration(announcement, performance.now() - announcement.shownAt);
    return;
  }
  if (announcement && announcement.recap) {
    drawRecap(announcement, performance.now() - announcement.shownAt);
    const strip = bannerOnScreen(state && state.mapStrip);
    if (strip) drawOnTop(() => drawMapBanner(strip));
    return;
  }
  if (countdown) {
    // Like a battle, a countdown has the screen to itself: the map banner stands in for the corner panels.
    drawCountdown();
    const banner = bannerOnScreen(countdown.banner);
    if (banner) drawOnTop(() => drawMapBanner(banner));
    return;
  }
  if (announcement) {
    // An event's closing words have the screen to themselves, like a countdown: the map banner
    // stands in for the corner panels, so the words never cover them wherever they were moved.
    drawBanner(announcement.title, announcement.subtitle || '', null);
    const strip = bannerOnScreen(state && state.mapStrip);
    if (strip) drawOnTop(() => drawMapBanner(strip));
  }
}

// --- Transitions -----------------------------------------------------------------

/**
 * The corner panels slide out toward the nearer side of the screen when a
 * battle, a countdown or an announcement takes the screen, and back in
 * after it, overshooting a little.
 */
const SLIDE = { outMs: 420, inMs: 600 };
/** Whether the corner panels are what the screen shows, and since when; `shown` is null before the first draw, which does not slide. */
const cornerShown = { shown: null, at: -Infinity };

function noteCorner(shown) {
  if (cornerShown.shown === shown) return;
  const first = cornerShown.shown === null;
  cornerShown.shown = shown;
  cornerShown.at = first ? -Infinity : performance.now();
  if (!first) runTransition();
}

function easeInCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x;
}

/** Overshoots a little before it settles at 1. */
function easeOutBack(t) {
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
}

/** How far out the corner panels are now: 0 in place, 1 off screen (a little below 0 while overshooting on the way in). */
function cornerOut() {
  const t = performance.now() - cornerShown.at;
  if (cornerShown.shown !== false) return t >= SLIDE.inMs ? 0 : 1 - easeOutBack(t / SLIDE.inMs);
  return t >= SLIDE.outMs ? 1 : easeInCubic(t / SLIDE.outMs);
}

/** How far to move a panel at `x`, `width` wide, toward its nearer side, `out` of the whole way. */
function slideAside(x, width, out) {
  if (out === 0) return 0;
  return x + width / 2 < canvas.width / 2 ? -(x + width + 40) * out : (canvas.width - x + 40) * out;
}

let transitionRunning = false;

/** Draws the panel every frame while the corner panels slide; a battle draws them in its own loop. */
function runTransition() {
  if (transitionRunning) return;
  transitionRunning = true;
  const tick = () => {
    const t = performance.now() - cornerShown.at;
    const sliding = t < (cornerShown.shown ? SLIDE.inMs : SLIDE.outMs);
    if (!battle) frame(renderPanel);
    if (sliding) requestAnimationFrame(tick);
    else transitionRunning = false;
  };
  requestAnimationFrame(tick);
}

/** The countdown before a fight: the seconds left, and who has joined the draw so far. */
function drawCountdown() {
  const width = 900;
  const height = 380;
  const left = (canvas.width - width) / 2;
  const top = 150;
  drawBox(left, top, width, height, { radius: 26, strong: true });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(countdown.title, canvas.width / 2, top + 58, width - 60);

  const seconds = Math.ceil(countdown.remainingMs / 1000);
  ctx.font = `800 150px ${FONT}`;
  ctx.fillStyle = seconds <= 5 ? '#FF6B5E' : '#FFE27A';
  ctx.fillText(String(seconds), canvas.width / 2, top + 178);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  const joined = tr('overlay.countdown.joined', { count: countdown.joined });
  const line = `${countdown.subtitle} · ${joined}`;
  // Shrink a long line until it fits the box.
  let size = 26;
  do {
    ctx.font = `400 ${size}px ${FONT}`;
    size -= 1;
  } while (size > 16 && textWidth(line) > width - 60);
  ctx.fillText(line, canvas.width / 2, top + 286, width - 40);

  // The latest names to join, so chatters see their message counted.
  ctx.font = `400 20px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  let names = (countdown.recent || []).join('  ·  ');
  while (names.length > 0 && textWidth(names) > width - 60) names = names.slice(names.indexOf('·') + 3);
  ctx.fillText(names, canvas.width / 2, top + 334);
}

/**
 * The line-up before a countdown fight. The fighters are revealed one by one,
 * each announced large as it is drawn and then kept in its team's list, so a
 * chatter can spot their own name without scanning a full list at once.
 */
/**
 * A chatter's emote on a dark disc with a ring, as their fighter wears it;
 * without an emote, a disc in their name color. For line-ups and lists.
 * `imp`, the name of one of the streamer's imps, draws that imp instead.
 */
function drawEmoteDisc(emote, x, y, r, ring, fill, imp = null) {
  if (imp) {
    // One of the streamer's imps: a small imp on a dark disc, in the guild's color.
    circle(x, y, r);
    ctx.fillStyle = 'rgba(17, 20, 24, 0.85)';
    ctx.fill();
    ctx.save();
    circle(x, y, r);
    ctx.clip();
    drawImp(x, y + r * 0.12, r * 0.62, ring, impSeed(imp));
    ctx.restore();
    circle(x, y, r);
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = ring;
    ctx.stroke();
    return;
  }
  const image = emoteImage(emote);
  circle(x, y, r);
  ctx.fillStyle = image ? 'rgba(17, 20, 24, 0.85)' : fill || ring;
  ctx.fill();
  if (image) {
    ctx.save();
    circle(x, y, r);
    ctx.clip();
    const size = r * 1.9;
    ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
    ctx.restore();
  }
  circle(x, y, r);
  ctx.lineWidth = Math.max(2, r * 0.14);
  ctx.strokeStyle = ring;
  ctx.stroke();
}

function drawLineup(a) {
  const elapsed = performance.now() - a.shownAt;
  // As tall as its longest column, at most 10 rows, and centered: three heroes need a small box.
  const longest = Math.min(10, Math.max(1, ...a.lineup.teams.map((team) => team.members.length)));
  const height = 284 + longest * 60 + 6;
  const box = { left: 260, top: Math.max(30, (canvas.height - height) / 2), width: 1400, height };
  drawBox(box.left, box.top, box.width, box.height, { radius: 28, strong: true });
  // Place numbers only where a team has more than one fighter.
  const numbered = a.lineup.teams.some((team) => team.members.length > 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 54px ${FONT}`;
  ctx.fillText(a.title, canvas.width / 2, box.top + 70, box.width - 80);

  // One column per team. A single team (a free-for-all) is spread over three columns.
  const rows = 10;
  let columns = a.lineup.teams.map((team) => ({ ...team, start: 0 }));
  if (columns.length === 1) {
    const team = columns[0];
    columns = [];
    for (let start = 0; start < team.members.length; start += rows) {
      columns.push({ ...team, members: team.members.slice(start, start + rows), start, name: start === 0 ? team.name : '' });
    }
  }

  // The order of the reveal: one fighter of each team in turn, so every team fills up together.
  const order = [];
  for (let row = 0; row < rows; row++) {
    columns.forEach((column, index) => {
      if (column.members[row]) order.push({ column: index, row });
    });
  }
  // The reveal takes most of the time the line-up shows; the rest shows the complete list.
  const interval = (a.holdMs * 0.8) / Math.max(1, order.length);
  const revealed = Math.min(order.length, Math.floor(elapsed / interval) + 1);
  const latest = order[revealed - 1];
  const sinceLatest = elapsed - (revealed - 1) * interval;
  const done = elapsed >= order.length * interval;

  // Under the title: the fighter just drawn, large; once all are drawn, how the fight works.
  if (!done && latest) {
    const column = columns[latest.column];
    const member = column.members[latest.row];
    const pop = 1 + 0.25 * Math.max(0, 1 - sinceLatest / 160);
    ctx.save();
    ctx.translate(canvas.width / 2, box.top + 132);
    ctx.scale(pop, pop);
    ctx.font = `700 40px ${FONT}`;
    // The name with the emote before it, the two centered together.
    const nameWidth = textWidth(member.name);
    const discR = 24;
    const left = -(nameWidth + discR * 2 + 14) / 2;
    drawEmoteDisc(member.emote, left + discR, 0, discR, column.color, member.color, member.imp ? member.name : null);
    ctx.textAlign = 'left';
    ctx.fillStyle = column.color;
    ctx.fillText(member.name, left + discR * 2 + 14, 0);
    ctx.restore();
    ctx.textAlign = 'center';
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText(a.lineup.note, canvas.width / 2, box.top + 130, box.width - 80);
  }

  const shown = new Set(order.slice(0, revealed).map((slot) => `${slot.column}:${slot.row}`));
  const columnWidth = (box.width - 80) / columns.length;
  columns.forEach((column, index) => {
    const center = box.left + 40 + index * columnWidth + columnWidth / 2;
    ctx.textAlign = 'center';
    if (column.name) {
      ctx.fillStyle = column.color;
      ctx.font = `700 34px ${FONT}`;
      ctx.fillText(column.name, center, box.top + 206);
      ctx.fillRect(center - 70, box.top + 232, 140, 5);
    }
    column.members.slice(0, rows).forEach((member, row) => {
      const y = box.top + 284 + row * 60;
      const isLatest = !done && latest && latest.column === index && latest.row === row;
      if (numbered) {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.font = `400 20px ${FONT}`;
        ctx.fillText(String(column.start + row + 1), center - 150, y);
      }
      // A place not drawn yet shows only its number.
      if (!shown.has(`${index}:${row}`)) return;
      if (isLatest) {
        // The newest name stands on a bar in its team's color for a moment.
        ctx.fillStyle = column.color;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.roundRect(center - 180, y - 24, 400, 48, 10);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // The emote the chatter fights as, so they can find themselves at a glance.
      drawEmoteDisc(member.emote, center - 116, y, 20, column.color, member.color, member.imp ? member.name : null);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(member.name, center - 86, y - (member.detail ? 9 : 0), 300);
      if (member.detail) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = `400 17px ${FONT}`;
        ctx.fillText(member.detail, center - 86, y + 17, 300);
      }
    });
  });
}

/** The map panel in the corner: territory and cities. Hidden while the background layer is off. */
function drawCorner(out = 0) {
  if (!state || !state.session.active) return;
  ctx.save();
  ctx.translate(slideAside(state.overlay.stats.x, state.overlay.stats.width, out), 0);
  drawSeasonPanel();
  ctx.restore();
  const box = state.overlay.map;
  if (!box.visible) return;
  ctx.save();
  ctx.translate(slideAside(box.x, PANEL.width, out), 0);
  drawMapPanel(box);
  ctx.restore();
}

/** The map panel: the map, and each guild's row beside it. */
function drawMapPanel(box) {
  const left = box.x;
  const top = box.y;

  drawBox(left, top, PANEL.width, PANEL.height);

  const guildColors = Object.fromEntries(state.guilds.map((g) => [g.id, g.color]));
  const mapWidth = HEX_SIZE * Math.sqrt(3) * 5;
  drawMap(guildColors, left + PANEL.padding + mapWidth / 2, top + PANEL.height / 2);

  const rowsX = left + PANEL.padding + mapWidth + 26;
  const rowsWidth = PANEL.width - PANEL.padding - (rowsX - left);
  drawGuildRows(rowsX, top + 22, rowsWidth);
}

/** The season's statistics: one row for each line the streamer has switched on. */
function drawSeasonPanel() {
  const box = state.overlay.stats;
  if (!box.visible) return;
  drawBox(box.x, box.y, box.width, box.height);

  const x = box.x + PANEL.padding;
  const right = box.x + box.width - PANEL.padding;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(tr('overlay.stats.season', { season: state.seasonId }), x, box.y + 34);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `400 16px ${FONT}`;
  ctx.fillText(tr('overlay.stats.day', { day: state.season.day }), right, box.y + 34);

  /** Shortens a text with an ellipsis until it fits a width. */
  const fit = (text, width) => {
    let shown = text;
    while (shown.length > 4 && textWidth(shown) > width) shown = `${shown.slice(0, -2)}…`;
    return shown;
  };
  state.seasonStats
    .filter((row) => row.enabled)
    .forEach((row, index) => {
      const y = box.y + 78 + index * 32;
      // The value is measured first; the label gets the room that is left.
      ctx.font = `600 17px ${FONT}`;
      const value = fit(row.value, box.width * 0.62);
      const valueWidth = textWidth(value);
      ctx.textAlign = 'right';
      ctx.fillStyle = row.color || '#FFFFFF';
      ctx.fillText(value, right, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = `400 17px ${FONT}`;
      ctx.fillText(fit(row.label, right - x - valueWidth - 16), x, y);
    });
}

// --- Monuments -----------------------------------------------------------------

/**
 * The three Monument designs, each built in five stages from the ground up.
 * A part is a polygon in units of the Monument's height: u across (0 is the
 * middle), v up from the ground. `stage` is the stage that completes it.
 */
function domePoints(cx, cv, rx, rv, steps = 10) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = Math.PI - (i / steps) * Math.PI;
    points.push([cx + Math.cos(angle) * rx, cv + Math.sin(angle) * rv]);
  }
  return points;
}

const MONUMENTS = [
  {
    name: 'Obelisk',
    parts: [
      { stage: 1, poly: [[-0.42, 0], [0.42, 0], [0.42, 0.07], [-0.42, 0.07]] },
      { stage: 1, poly: [[-0.32, 0.07], [0.32, 0.07], [0.32, 0.14], [-0.32, 0.14]] },
      { stage: 2, poly: [[-0.17, 0.14], [0.17, 0.14], [0.155, 0.42], [-0.155, 0.42]] },
      { stage: 3, poly: [[-0.155, 0.42], [0.155, 0.42], [0.135, 0.68], [-0.135, 0.68]] },
      { stage: 4, poly: [[-0.135, 0.68], [0.135, 0.68], [0.115, 0.86], [-0.115, 0.86]] },
      { stage: 5, poly: [[-0.115, 0.86], [0.115, 0.86], [0, 1]] },
    ],
    // Where the finished Monument shines, and its banner flies.
    crown: [0, 0.93],
  },
  {
    name: 'Ziggurat',
    parts: [
      { stage: 1, poly: [[-0.5, 0], [0.5, 0], [0.5, 0.18], [-0.5, 0.18]] },
      { stage: 2, poly: [[-0.4, 0.18], [0.4, 0.18], [0.4, 0.36], [-0.4, 0.36]] },
      { stage: 3, poly: [[-0.3, 0.36], [0.3, 0.36], [0.3, 0.54], [-0.3, 0.54]] },
      { stage: 4, poly: [[-0.2, 0.54], [0.2, 0.54], [0.2, 0.72], [-0.2, 0.72]] },
      { stage: 5, poly: [[-0.12, 0.72], [0.12, 0.72], [0.12, 0.86], [-0.12, 0.86]] },
      { stage: 5, poly: [[-0.15, 0.86], [0.15, 0.86], [0, 0.97]] },
    ],
    // The stairway up the front of every tier.
    stairs: [[-0.07, 0], [0.07, 0], [0.07, 0.72], [-0.07, 0.72]],
    crown: [0, 0.97],
  },
  {
    name: 'Temple',
    parts: [
      { stage: 1, poly: [[-0.5, 0], [0.5, 0], [0.5, 0.09], [-0.5, 0.09]] },
      { stage: 1, poly: [[-0.44, 0.09], [0.44, 0.09], [0.44, 0.14], [-0.44, 0.14]] },
      ...[-0.36, -0.12, 0.12, 0.36].flatMap((u) => [
        { stage: 2, poly: [[u - 0.045, 0.14], [u + 0.045, 0.14], [u + 0.045, 0.4], [u - 0.045, 0.4]] },
        { stage: 3, poly: [[u - 0.045, 0.4], [u + 0.045, 0.4], [u + 0.045, 0.6], [u - 0.045, 0.6]] },
      ]),
      { stage: 4, poly: [[-0.48, 0.6], [0.48, 0.6], [0.48, 0.7], [-0.48, 0.7]] },
      { stage: 4, poly: [[-0.48, 0.7], [0.48, 0.7], [0, 0.8]] },
      { stage: 5, poly: domePoints(0, 0.78, 0.22, 0.14) },
      { stage: 5, poly: [[-0.02, 0.91], [0.02, 0.91], [0.012, 1], [-0.012, 1]] },
    ],
    crown: [0, 1],
  },
];

/** Mixes two #RRGGBB colors; `share` of the second. */
function mixColor(a, b, share) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x, y) => Math.round(x + (y - x) * share);
  return `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`;
}

/**
 * A guild's Monument, standing on (x, y), `height` tall. Finished parts are
 * stone tinted in the guild's color; the part being built stands in
 * scaffolding, filled as far as it has come; parts still to come are faint
 * outlines. Finished, it shines and flies the guild's banner. Themes may draw
 * their own (art.monument) or supply images (monument.<design>.<stage 0-5>).
 */
function drawMonument(design, progress, x, y, height, color) {
  const share = Math.max(0, Math.min(1, progress));
  const stage = Math.min(5, Math.floor(share * 5 + 1e-9));
  if (drawThemeImage(`monument.${design}.${stage}`, x - height / 2, y - height, height, height)) return;
  const theme = Theme.current;
  if (theme.art.monument) {
    theme.art.monument(ctx, design, share, x, y, height, color, { px: theme.pixelScale, palette: theme.palette });
    return;
  }
  const model = MONUMENTS[design % MONUMENTS.length];
  const within = share * 5 - stage; // how far the stage being built has come
  // Lines at least one theme pixel wide, or a pixel theme loses them.
  const line = (width) => Math.max(width, theme.pixelScale > 1 ? theme.pixelScale : 0);
  // The plan of what is still to come: a solid, dark silhouette, readable on any panel.
  const plan = mixColor('#3A4152', color, 0.25);
  const stone = mixColor(theme.palette.stone.startsWith('#') ? theme.palette.stone : '#C9C2B5', color, 0.35);
  const path = (poly) => {
    ctx.beginPath();
    poly.forEach(([u, v], i) => {
      const px = x + u * height;
      const py = y - v * height;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
  };
  const bottom = (poly) => Math.min(...poly.map(([, v]) => v));
  const top = (poly) => Math.max(...poly.map(([, v]) => v));

  ctx.save();
  ctx.lineJoin = 'round';
  for (const part of model.parts) {
    path(part.poly);
    if (part.stage <= stage) {
      ctx.fillStyle = stone;
      ctx.fill();
      // The right half in shade, for a little depth.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(x, y - height * 1.1, height, height * 1.2);
      ctx.restore();
      path(part.poly);
      ctx.lineWidth = line(Math.max(1.5, height * 0.025));
      ctx.strokeStyle = '#100C0A';
      ctx.stroke();
    } else if (part.stage === stage + 1 && within > 0) {
      // Being built: filled from the bottom as far as it has come, in scaffolding.
      const from = bottom(part.poly);
      const to = from + (top(part.poly) - from) * within;
      ctx.fillStyle = plan;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - height, y - to * height, height * 2, (to - from) * height + 1);
      ctx.clip();
      path(part.poly);
      ctx.fillStyle = stone;
      ctx.fill();
      ctx.restore();
      path(part.poly);
      ctx.lineWidth = line(Math.max(1.5, height * 0.02));
      ctx.strokeStyle = '#100C0A';
      ctx.stroke();
    } else {
      // Still to come: the plan, a dark silhouette with a light edge.
      ctx.fillStyle = plan;
      ctx.fill();
      ctx.lineWidth = line(Math.max(1.2, height * 0.015));
      ctx.strokeStyle = mixColor('#8A93A8', color, 0.3);
      ctx.stroke();
    }
  }
  if (model.stairs && stage >= 1) {
    const reach = Math.min(top(model.stairs), (Math.min(stage, 4) / 4) * 0.72);
    path(model.stairs.map(([u, v]) => [u, Math.min(v, reach)]));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fill();
  }
  // Scaffolding around the stage being built: two poles and cross braces.
  if (stage < 5 && within > 0) {
    const part = model.parts.find((p) => p.stage === stage + 1);
    const us = part.poly.map(([u]) => u);
    const left = x + (Math.min(...us) - 0.05) * height;
    const right = x + (Math.max(...us) + 0.05) * height;
    const low = y - bottom(part.poly) * height;
    const high = y - top(part.poly) * height - height * 0.04;
    ctx.strokeStyle = '#C08A4A';
    ctx.lineWidth = line(Math.max(1.5, height * 0.025));
    ctx.beginPath();
    ctx.moveTo(left, low);
    ctx.lineTo(left, high);
    ctx.moveTo(right, low);
    ctx.lineTo(right, high);
    ctx.moveTo(left, low);
    ctx.lineTo(right, high);
    ctx.moveTo(right, low);
    ctx.lineTo(left, high);
    ctx.moveTo(left, high);
    ctx.lineTo(right, high);
    ctx.stroke();
  }
  // Finished: a glow, and the guild's banner on top.
  if (stage === 5) {
    const [cu, cv] = model.crown;
    const cx = x + cu * height;
    const cy = y - cv * height;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, height * 0.25);
    glow.addColorStop(0, 'rgba(255, 245, 200, 0.85)');
    glow.addColorStop(1, 'rgba(255, 245, 200, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, height * 0.25, 0, Math.PI * 2);
    ctx.fill();
    const pole = height * 0.22;
    ctx.strokeStyle = '#2A2420';
    ctx.lineWidth = Math.max(1.5, height * 0.015);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - pole);
    ctx.stroke();
    const wave = Math.sin(performance.now() / 260) * height * 0.02;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - pole);
    ctx.quadraticCurveTo(cx + height * 0.1, cy - pole + wave, cx + height * 0.2, cy - pole + height * 0.02);
    ctx.lineTo(cx + height * 0.2, cy - pole + height * 0.09);
    ctx.quadraticCurveTo(cx + height * 0.1, cy - pole + height * 0.09 + wave, cx, cy - pole + height * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** A guild's Monument design, as the server dealt it for the season. */
function monumentDesign(guild, index) {
  const design = guild && guild.monument && guild.monument.design;
  return Number.isInteger(design) ? design : index % MONUMENTS.length;
}

/**
 * A finished Monument wins the season: it stands large in the middle of the
 * screen, light turning behind it, with the announcement below.
 */
function drawCelebration(a, elapsed) {
  const guild = state && state.guilds.find((g) => g.id === a.celebrate.guild);
  const color = guild ? guild.color : '#FFD54A';
  const cx = canvas.width / 2;
  const base = 640;
  ctx.save();
  // Rays turning slowly behind the Monument.
  ctx.translate(cx, base - 180);
  ctx.rotate(elapsed / 4000);
  for (let i = 0; i < 16; i++) {
    ctx.rotate((Math.PI * 2) / 16);
    const gradient = ctx.createLinearGradient(0, 0, 520, 0);
    gradient.addColorStop(0, i % 2 === 0 ? color : 'rgba(255, 245, 200, 0.9)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(520, -48);
    ctx.lineTo(520, 48);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // It rises into place over the first second.
  const rise = ease(elapsed / 1000);
  drawMonument(a.celebrate.design, 1, cx, base + (1 - rise) * 80, 360, color);
  // Sparkles drifting down.
  for (let i = 0; i < 40; i++) {
    const phase = (elapsed / 3000 + hash01(i * 7.3)) % 1;
    const sx = cx + (hash01(i * 2.1) - 0.5) * 1100;
    const sy = 120 + phase * 760;
    ctx.globalAlpha = 1 - phase;
    ctx.fillStyle = i % 3 === 0 ? color : '#FFF3C4';
    ctx.fillRect(sx - 3, sy - 3, 6, 6);
  }
  ctx.globalAlpha = 1;

  drawBox(cx - 520, 700, 1040, 170, { radius: 22, strong: true, accent: color });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.font = `700 60px ${FONT}`;
  ctx.fillText(a.title, cx, 768, 980);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  // Shrink a long line until it fits the banner.
  let size = 24;
  do {
    ctx.font = `400 ${size}px ${FONT}`;
    size -= 1;
  } while (size > 14 && textWidth(a.subtitle || '') > 980);
  ctx.fillText(a.subtitle || '', cx, 830, 980);
}

/**
 * A season's recap: its title, then one row after another (`stepMs` apart),
 * sliding in from the right, beside the winning guild's Monument (or a large
 * crown for the god). Worked out from the time since it appeared.
 */
function drawRecap(a, elapsed) {
  const { rows, stepMs, design, color } = a.recap;
  const rowHeight = 58;
  const width = 1240;
  const height = 150 + rows.length * rowHeight + 36;
  const left = (canvas.width - width) / 2;
  const top = Math.max(30, (canvas.height - height) / 2 - 30);
  drawBox(left, top, width, height, { radius: 28, strong: true, accent: color });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(a.title, canvas.width / 2, top + 70, width - 80);

  // The winner's Monument rises on the left; the god gets a crown.
  const art = { x: left + 215, base: top + height - 40, height: Math.min(330, height - 170) };
  const rise = ease(Math.min(1, elapsed / 1000));
  ctx.save();
  ctx.globalAlpha = rise;
  if (design !== null) {
    drawMonument(design, 1, art.x, art.base + (1 - rise) * 40, art.height, color);
  } else if (a.recap.winner === 'god') {
    ctx.translate(art.x, art.base - art.height / 2);
    ctx.scale(6, 6);
    ctx.fillStyle = color;
    drawCrown(0, 0);
    ctx.fill();
  }
  ctx.restore();

  const listLeft = left + 400;
  const listRight = left + width - 50;
  rows.forEach((row, index) => {
    const since = elapsed - index * stepMs;
    if (since < 0) return;
    const p = ease(Math.min(1, since / 400));
    const y = top + 150 + index * rowHeight + rowHeight / 2;
    ctx.save();
    ctx.globalAlpha = p;
    ctx.translate((1 - p) * 60, 0);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(listLeft, y + rowHeight / 2 - 1, listRight - listLeft, 2);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText(row.label, listLeft, y, 330);
    ctx.textAlign = 'right';
    ctx.fillStyle = row.color || '#FFFFFF';
    ctx.font = `700 ${index === 0 ? 30 : 26}px ${FONT}`;
    ctx.fillText(row.value, listRight, y, listRight - listLeft - 340);
    ctx.restore();
  });
}

// --- Battle ------------------------------------------------------------------

function onBattleStart(message) {
  clearTimeout(announcementTimer);
  announcement = null;
  const scale = canvas.width / message.arena.width;
  const banner = message.banner ? { place: message.banner.place, height: message.banner.height * scale } : null;
  battle = {
    title: message.title,
    durationMs: message.durationMs,
    scale,
    // Where the arena sits on screen: below a map banner at the top, or above one at the bottom.
    view: { top: banner && banner.place === 'top' ? banner.height : 0, height: message.arena.height * scale, banner },
    sides: message.sides,
    sideColors: Object.fromEntries(message.sides.map((s) => [s.id, s.color])),
    emoteUrl: message.emoteUrl,
    fighters: message.fighters,
    previous: null, // the frame before the latest
    latest: null, // { t, f, receivedAt }
    diedAt: new Array(message.fighters.length).fill(0),
    enrageGrow: message.enrageGrow || 1,
    ambient: message.ambient === true, // background decoration: no scoreboard and no result
    marks: [], // scorch marks lightning left on the ground
    shake: null, // { start, ms, power }: the battlefield shaking after a heavy blow
    effects: [], // skills being announced or cast, each with the time it started
    caption: null, // the name of the skill being cast, shown above the caster
    trail: { index: -1, until: 0, points: [] }, // afterimages behind a rampaging fighter
    end: null, // the battle-end message, with shownAt
    feed: { queue: [], lines: [], lastAt: -Infinity }, // the highlights: deaths waiting to be shown, and the lines shown
    place: message.place || null, // the arena's id, or null
    // When the battle began on this page: the arena's name is introduced then (not to a page that joins late).
    startedAt: performance.now() - (message.elapsedMs || 0),
    broken: new Map(), // obstacle id → when it was first seen broken, for crumbling walls
    numbers: [], // big hits' damage floating up: { x, y, v, l, c, start, seed } in arena units
    knockouts: [], // where fighters fell, for a theme that marks it (the comic's "KO" bursts): { x, y, start, seed, big }
    // When this page began showing the battle: fighters pop in and the scoreboard drops in from then.
    shownAt: performance.now(),
  };
  requestAnimationFrame(drawBattle);
}

function onBattleFrame(message) {
  if (!battle) return;
  const now = performance.now();
  battle.previous = battle.latest;
  battle.latest = { t: message.t, f: message.f, o: message.o || null, receivedAt: now };
  noteBigHits(message.e || [], now);
  for (const event of message.e || []) {
    if (event.k === 'hit') continue;
    if (event.k === 'death') {
      if (highlightsOn()) battle.feed.queue.push({ ...event, at: now });
      continue;
    }
    battle.effects.push({ ...event, start: now });
    if (event.k === 'warn' || event.s === 'enrage') {
      battle.caption = { text: skillCaption(event.s), index: event.i, start: now };
    }
    if (event.k === 'cast' && event.s === 'rampage') {
      battle.trail = { index: event.i, until: now + event.ms, points: [] };
    }
    if (event.k === 'fx' && event.fx === 'smash') {
      // The god breaking through a wall.
      battle.shake = { start: now, ms: 300, power: 9 };
    }
    if (event.k === 'fx' && (event.fx === 'dash' || event.fx === 'wrap')) {
      // The god's dash leaves the same afterimages as a rampage, briefly.
      battle.trail = { index: event.i, until: now + 450, points: [] };
    }
    if (event.k !== 'cast') continue;
    // Heavy blows shake the battlefield; lightning shakes it hardest and scorches the ground.
    const power = { smite: 18, leap: 12, shockwave: 10, enrage: 9 }[event.s];
    if (power) battle.shake = { start: now, ms: event.s === 'smite' ? 550 : 380, power };
    if (event.s === 'smite') {
      // Where lightning strikes, the ground burns for a while.
      (event.t || []).forEach((index, n) => {
        const [x, y] = message.f[index];
        battle.marks.push({
          x: x * battle.scale,
          y: y * battle.scale,
          r: (event.r || battle.fighters[index].radius * 2.6) * battle.scale,
          ms: (event.d && event.d[n]) || 5000,
          start: now,
        });
      });
    }
  }
  if (battle.previous) {
    message.f.forEach((fighter, i) => {
      if (fighter[2] === 0 && battle.previous.f[i][2] > 0) {
        battle.diedAt[i] = now;
        if (Theme.current.art.knockout && !battle.fighters[i].minion) {
          battle.knockouts.push({ x: fighter[0], y: fighter[1], start: now, seed: i * 7 + battle.knockouts.length, big: false });
          // A theme's knockout bursts: a few at a time, the newest.
          if (battle.knockouts.length > NUMBERS.maxKnockouts) battle.knockouts.shift();
        }
      }
      // A fighter that steps in from the bench starts fresh: its last death is forgotten.
      if (fighter[2] > 0 && battle.previous.f[i][2] === 0) battle.diedAt[i] = 0;
    });
  }
}

function onBattleEnd(message) {
  if (!battle) return;
  if (message.cancelled) {
    battle = null;
    drawPanel();
    return;
  }
  battle.end = { ...message, shownAt: performance.now() };
}

/** Text with a dark outline; `maxWidth`, when given, squeezes a longer text to fit. */
function outlinedText(text, x, y, maxWidth) {
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y, maxWidth);
  ctx.fillText(text, x, y, maxWidth);
}

/** Emote images by id. A failed download leaves the fighter as a plain circle. */
const emoteImages = new Map();

/**
 * An image by address, or null until it is ready to draw. "Ready" means
 * decoded too: the browser decodes it in the background first, because an
 * image decoded only when first drawn holds up that frame, and a battle start
 * with dozens of new emotes would stutter.
 */
function loadImage(url) {
  let entry = emoteImages.get(url);
  if (!entry) {
    const image = new Image();
    entry = { image, ready: false };
    image.src = url;
    // A broken image is marked, so nothing waits for it.
    image.decode().then(() => { entry.ready = true; }, () => { entry.failed = true; });
    emoteImages.set(url, entry);
  }
  return entry.ready ? entry.image : null;
}

/**
 * Animated emotes, decoded into frames. A chat full of different animated
 * emotes must not make the battle stutter, so:
 * - they are decoded in a worker (emote-worker.js), away from the drawing,
 *   one at a time, where the browser allows it;
 * - every frame is shrunk to `size`, the largest an emote is drawn at;
 * - at most `keep` animations stay in memory: the ones seen longest ago go,
 *   but never one seen in the last `recentMs`, so nothing on screen is
 *   dropped and decoded again (a battle has at most about 130 fighters).
 */
const ANIMATION = { size: 64, keep: 160, recentMs: 10_000 };

/** Decoded animations by address: { frames: [{ image, until }], total, seenAt }, 'loading', or null when it failed. */
const animations = new Map();

/** The worker that decodes animations, or null where the browser has none. */
const animationWorker = (() => {
  const script = document.currentScript && document.currentScript.src;
  if (typeof Worker === 'undefined' || !script) return null;
  try {
    const worker = new Worker(new URL('emote-worker.js', script));
    worker.onmessage = ({ data }) => {
      if (animations.get(data.key) !== 'loading') {
        // Forgotten while it was decoded: nobody needs it.
        if (data.frames) for (const frame of data.frames) frame.image.close();
        return;
      }
      animations.set(data.key, data.frames ? { frames: data.frames, total: data.total, seenAt: performance.now() } : null);
      forgetOldAnimations();
    };
    return worker;
  } catch {
    return null;
  }
})();

/** Keeps at most `ANIMATION.keep` decoded animations: the ones seen longest ago are closed, if not seen lately. */
function forgetOldAnimations() {
  const decoded = [...animations].filter(([, entry]) => entry && entry !== 'loading');
  if (decoded.length <= ANIMATION.keep) return;
  const lately = performance.now() - ANIMATION.recentMs;
  decoded.sort(([, a], [, b]) => a.seenAt - b.seenAt);
  const old = decoded.slice(0, decoded.length - ANIMATION.keep).filter(([, entry]) => entry.seenAt < lately);
  for (const [url, entry] of old) {
    for (const frame of entry.frames) frame.image.close();
    animations.delete(url);
  }
}

/** Decodes an animated emote here, for a browser without workers (OBS's browser has them). */
async function decodeAnimation(url) {
  if (typeof ImageDecoder === 'undefined') return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || 'image/gif';
    if (!(await ImageDecoder.isTypeSupported(type))) return null;
    const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type });
    await decoder.tracks.ready;
    const count = Math.min(decoder.tracks.selectedTrack.frameCount, 150);
    const frames = [];
    let total = 0;
    for (let index = 0; index < count; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      const scale = Math.min(1, ANIMATION.size / Math.max(image.displayWidth, image.displayHeight));
      // Durations are in microseconds; very short frames are stretched, as browsers do.
      total += Math.max(20, (image.duration || 100_000) / 1000);
      frames.push({
        image: await createImageBitmap(image, {
          resizeWidth: Math.max(1, Math.round(image.displayWidth * scale)),
          resizeHeight: Math.max(1, Math.round(image.displayHeight * scale)),
          resizeQuality: 'medium',
        }),
        until: total,
      });
      image.close();
    }
    decoder.close();
    return frames.length > 0 ? { frames, total, seenAt: performance.now() } : null;
  } catch {
    return null;
  }
}

function animationFrame(url) {
  const entry = animations.get(url);
  if (entry === undefined) {
    animations.set(url, 'loading');
    if (animationWorker) {
      animationWorker.postMessage({ key: url, url: new URL(url, location.href).href, size: ANIMATION.size });
    } else {
      decodeAnimation(url).then((result) => {
        animations.set(url, result);
        forgetOldAnimations();
      });
    }
    return null;
  }
  if (!entry || entry === 'loading') return null;
  entry.seenAt = performance.now();
  const time = entry.seenAt % entry.total;
  return (entry.frames.find((frame) => frame.until > time) || entry.frames[0]).image;
}

/**
 * The image a fighter's emote is drawn with: the current frame of its
 * animation when animated emotes are on, else the still image.
 */
function emoteImage(emote) {
  if (!emote) return null;
  // Older servers sent a bare Twitch emote id with an address template.
  if (typeof emote === 'string') {
    return battle.emoteUrl ? loadImage(battle.emoteUrl.replace('{id}', encodeURIComponent(emote))) : null;
  }
  const animate = !state || !state.display || state.display.animatedEmotes !== false;
  if (animate && emote.animatedUrl) {
    const frame = animationFrame(emote.animatedUrl);
    if (frame) return frame;
  }
  return emote.url ? loadImage(emote.url) : null;
}

/** A small gold crown, worn by the session's Hero Clash champion. */
function drawCrown(x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 13, y + 7);
  ctx.lineTo(x - 13, y - 6);
  ctx.lineTo(x - 6, y);
  ctx.lineTo(x, y - 9);
  ctx.lineTo(x + 6, y);
  ctx.lineTo(x + 13, y - 6);
  ctx.lineTo(x + 13, y + 7);
  ctx.closePath();
  ctx.fillStyle = '#FFD54A';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.stroke();
}

/** Each class's badge color: light, so the dark icon on it reads at a glance. A theme's palette may change them (classColors). */
const CLASS_COLORS = {
  fighter: '#FFB49A',
  tank: '#B9C8DE',
  thief: '#CDB6F5',
  archer: '#B8E6A3',
  mage: '#9FD6FF',
  healer: '#FFF0A0',
};

/**
 * A small badge at a fighter's lower right showing its class: a dark icon on
 * a light disc in the class's color. Themes may draw their own (art.classIcon)
 * or supply an image (classIcon.<class>).
 */
function drawClassBadge(cls, x, y, size) {
  if (drawThemeImage(`classIcon.${cls}`, x - size, y - size, size * 2, size * 2)) return;
  const theme = Theme.current;
  const color = (theme.palette.classColors && theme.palette.classColors[cls]) || CLASS_COLORS[cls] || '#FFFFFF';
  if (theme.art.classIcon) {
    // `icon` draws the built-in icon around the origin, `u` being half its extent.
    const icon = (u, iconColor) => drawClassIcon(cls, u, iconColor);
    theme.art.classIcon(ctx, cls, x, y, size, { px: theme.pixelScale, color, icon });
    return;
  }
  ctx.save();
  const shine = ctx.createRadialGradient(x - size * 0.35, y - size * 0.4, size * 0.1, x, y, size);
  shine.addColorStop(0, '#FFFFFF');
  shine.addColorStop(0.35, color);
  shine.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.16);
  ctx.strokeStyle = '#1A1E26';
  ctx.stroke();
  ctx.translate(x, y);
  drawClassIcon(cls, size * 0.62, '#1A1E26');
  ctx.restore();
}

/** A class's icon around the origin, `u` being half its extent. */
function drawClassIcon(cls, u, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.4, u * 0.28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (cls === 'fighter') {
    // A sword: a long blade, a crossguard and a pommel.
    ctx.moveTo(-u * 0.75, u * 0.75);
    ctx.lineTo(u * 0.95, -u * 0.95);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-u * 0.85, u * 0.05);
    ctx.lineTo(-u * 0.05, u * 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-u * 0.82, u * 0.82, u * 0.17, 0, Math.PI * 2);
    ctx.fill();
  } else if (cls === 'tank') {
    // A shield with a band across it.
    ctx.moveTo(-u * 0.82, -u * 0.85);
    ctx.lineTo(u * 0.82, -u * 0.85);
    ctx.lineTo(u * 0.82, u * 0.05);
    ctx.quadraticCurveTo(u * 0.6, u * 0.75, 0, u);
    ctx.quadraticCurveTo(-u * 0.6, u * 0.75, -u * 0.82, u * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = CLASS_COLORS.tank;
    ctx.lineWidth = Math.max(1, u * 0.18);
    ctx.beginPath();
    ctx.moveTo(0, -u * 0.6);
    ctx.lineTo(0, u * 0.6);
    ctx.stroke();
  } else if (cls === 'thief') {
    // A hood with two eyes in its shadow.
    ctx.moveTo(-u * 0.95, u * 0.95);
    ctx.quadraticCurveTo(-u * 0.95, -u * 0.6, 0, -u);
    ctx.quadraticCurveTo(u * 0.95, -u * 0.6, u * 0.95, u * 0.95);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = CLASS_COLORS.thief;
    ctx.beginPath();
    ctx.ellipse(-u * 0.32, u * 0.05, u * 0.17, u * 0.1, 0.3, 0, Math.PI * 2);
    ctx.ellipse(u * 0.32, u * 0.05, u * 0.17, u * 0.1, -0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (cls === 'archer') {
    // A bow drawn with an arrow on its string.
    ctx.arc(-u * 0.55, 0, u * 1.05, -Math.PI / 2.7, Math.PI / 2.7);
    ctx.stroke();
    const tip = Math.PI / 2.7;
    ctx.lineWidth = Math.max(1, u * 0.12);
    ctx.beginPath();
    ctx.moveTo(-u * 0.55 + u * 1.05 * Math.cos(tip), -u * 1.05 * Math.sin(tip));
    ctx.lineTo(-u * 0.55, 0);
    ctx.lineTo(-u * 0.55 + u * 1.05 * Math.cos(tip), u * 1.05 * Math.sin(tip));
    ctx.stroke();
    ctx.lineWidth = Math.max(1.2, u * 0.18);
    ctx.beginPath();
    ctx.moveTo(-u * 0.55, 0);
    ctx.lineTo(u * 0.9, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(u * 1.05, 0);
    ctx.lineTo(u * 0.65, -u * 0.28);
    ctx.lineTo(u * 0.65, u * 0.28);
    ctx.closePath();
    ctx.fill();
  } else if (cls === 'mage') {
    // A staff with a star at its head.
    ctx.moveTo(-u * 0.8, u * 0.95);
    ctx.lineTo(u * 0.2, -u * 0.1);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i - Math.PI / 2;
      const length = i % 2 === 0 ? u * 0.62 : u * 0.22;
      const px = u * 0.38 + Math.cos(angle) * length;
      const py = -u * 0.38 + Math.sin(angle) * length;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  } else if (cls === 'healer') {
    // A heart with a cross on it.
    ctx.moveTo(0, u * 0.95);
    ctx.bezierCurveTo(-u * 1.3, u * 0.05, -u * 0.75, -u * 1.05, 0, -u * 0.4);
    ctx.bezierCurveTo(u * 0.75, -u * 1.05, u * 1.3, u * 0.05, 0, u * 0.95);
    ctx.fill();
    ctx.strokeStyle = CLASS_COLORS.healer;
    ctx.lineWidth = Math.max(1, u * 0.2);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(0, -u * 0.25);
    ctx.lineTo(0, u * 0.45);
    ctx.moveTo(-u * 0.35, u * 0.1);
    ctx.lineTo(u * 0.35, u * 0.1);
    ctx.stroke();
  }
}

/**
 * An arrow in flight, pointing along `angle`, its tip at (x, y). Themes may
 * draw their own (art.arrow) or supply an image (arrow), drawn pointing right.
 */
function drawArrowProjectile(x, y, angle, length) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const image = Theme.image('arrow');
  if (image) {
    ctx.drawImage(image, -length, -length * 0.15, length, length * 0.3);
    ctx.restore();
    return;
  }
  if (Theme.current.art.arrow) {
    Theme.current.art.arrow(ctx, length, { px: Theme.current.pixelScale });
    ctx.restore();
    return;
  }
  const w = Math.max(2.5, length * 0.07);
  // A dark outline first, then the parts on top of it.
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = w + 3;
  ctx.beginPath();
  ctx.moveTo(-length, 0);
  ctx.lineTo(-length * 0.15, 0);
  ctx.stroke();
  // The wooden shaft.
  ctx.strokeStyle = '#B98A55';
  ctx.lineWidth = w;
  ctx.stroke();
  // The fletching: two feathers at the tail.
  ctx.fillStyle = '#F2F2F2';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 1.5;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-length * 0.98, 0);
    ctx.lineTo(-length * 0.82, side * w * 2.2);
    ctx.lineTo(-length * 0.7, side * w * 2.2);
    ctx.lineTo(-length * 0.78, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // The steel head.
  ctx.fillStyle = '#DCE3EA';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-length * 0.24, -w * 1.9);
  ctx.lineTo(-length * 0.18, 0);
  ctx.lineTo(-length * 0.24, w * 1.9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Rays of light turning slowly around a shielded fighter. */
function drawHolyRays(x, y, r) {
  const now = performance.now();
  const rays = 14;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(now / 1400);
  for (let i = 0; i < rays; i++) {
    // Every other ray is longer, and all of them breathe a little.
    const length = r * (i % 2 === 0 ? 2.3 : 1.5) * (1 + 0.12 * Math.sin(now / 170 + i));
    const gradient = ctx.createLinearGradient(r, 0, r + length, 0);
    gradient.addColorStop(0, 'rgba(255, 236, 160, 0.85)');
    gradient.addColorStop(1, 'rgba(255, 236, 160, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(r * 0.9, -r * 0.11);
    ctx.lineTo(r + length, 0);
    ctx.lineTo(r * 0.9, r * 0.11);
    ctx.closePath();
    ctx.fill();
    ctx.rotate((Math.PI * 2) / rays);
  }
  ctx.restore();
}

/**
 * One of the god's minions, or one of the streamer's imps filling an empty
 * place in a guild: not a chatter but a shadow imp. A dark, spiky body that
 * turns slowly, two small horns and glowing eyes in its side's color, so
 * nobody takes it for a player. No name, no class.
 */
function drawMinion(fighter, x, y, r, health, flags, alpha) {
  const color = battle.sideColors[fighter.side] || '#B07CFF';
  // Each minion turns and blinks on its own beat.
  if (fighter.minionSeed === undefined) fighter.minionSeed = Math.random() * 6;
  ctx.save();
  ctx.globalAlpha = alpha;
  drawImp(x, y, r, color, fighter.minionSeed, (flags & FLAG.hit) !== 0);
  if (health > 0 && health < 1) {
    const width = r * 2.2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x - width / 2, y - r * 1.5 - 10, width, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, y - r * 1.5 - 10, width * health, 5);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** A shadow imp's body: haze, turning spikes, horns and blinking eyes in `color`. `seed` sets its own beat. */
function drawImp(x, y, r, color, seed = 0, hit = false) {
  const now = performance.now();
  // A dark haze around it.
  const haze = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 1.7);
  haze.addColorStop(0, 'rgba(20, 8, 30, 0.55)');
  haze.addColorStop(1, 'rgba(20, 8, 30, 0)');
  circle(x, y, r * 1.7);
  ctx.fillStyle = haze;
  ctx.fill();
  // The spiky body, turning.
  const spikes = 9;
  const turn = now / 900 + seed;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const angle = turn + (i / (spikes * 2)) * Math.PI * 2;
    const reach = r * (i % 2 === 0 ? 1.12 + 0.08 * Math.sin(now / 120 + i) : 0.78);
    const px = x + Math.cos(angle) * reach;
    const py = y + Math.sin(angle) * reach;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = hit ? '#FFFFFF' : '#1B1024';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.strokeStyle = color;
  ctx.stroke();
  // Horns.
  ctx.fillStyle = '#1B1024';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + side * r * 0.25, y - r * 0.55);
    ctx.quadraticCurveTo(x + side * r * 0.75, y - r * 0.95, x + side * r * 0.55, y - r * 1.45);
    ctx.lineTo(x + side * r * 0.5, y - r * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  // Glowing eyes that blink now and then.
  const blink = Math.sin(now / 1700 + seed * 5) > 0.96 ? 0.15 : 1;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * r * 0.3, y - r * 0.05, r * 0.17, r * 0.12 * blink, side * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + side * r * 0.3, y - r * 0.05, r * 0.07, r * 0.06 * blink, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  }
}

/** A stable beat for an imp drawn by name (in a list or on a ball), so neighbours do not turn in step. */
function impSeed(name) {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash / 97;
}

/**
 * How much a thrown fighter is squashed: stretched along its flight and
 * narrowed across it, by its speed (pixels a second). Its area stays the same.
 */
const SQUASH = { perSpeed: 1 / 3500, max: 0.5 };

/**
 * One fighter. `squash`, when given, is { angle, stretch }: the fighter is
 * thrown and drawn as an oval along `angle`; its name, badge and health bar
 * stay upright.
 */
function drawFighter(fighter, x, y, health, flags, alpha, squash) {
  let r = fighter.radius * battle.scale;
  if (fighter.minion || fighter.imp) {
    drawMinion(fighter, x, y, r, health, flags, alpha);
    return;
  }
  // An enraged fighter has grown, and swells and shrinks as it rages.
  const enraged = (flags & FLAG.enraged) !== 0;
  if (enraged) r *= battle.enrageGrow * (1 + 0.07 * Math.sin(performance.now() / 110));
  if (flags & FLAG.shielded) drawHolyRays(x, y, r);
  const hit = (flags & FLAG.hit) !== 0;
  const guildColor = battle.sideColors[fighter.side];
  // An uploaded picture (the god's) comes before the emote.
  const picture = fighter.image ? loadImage(fighter.image) : null;
  const emote = picture ? null : emoteImage(fighter.emote);
  const squashed = squash && squash.stretch > 1.01;
  if (squashed) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(squash.angle);
    ctx.scale(squash.stretch, 1 / squash.stretch);
    ctx.rotate(-squash.angle);
    ctx.translate(-x, -y);
  }
  const ink = inkOf();
  if (ink) {
    // A comic's ink: a hard shadow and a bold black rim behind the fighter.
    const rim = r + 2.5 + (ink.width ?? 3);
    ctx.fillStyle = ink.color || '#0B0807';
    if (ink.shadow) {
      ctx.globalAlpha = alpha * (ink.shadowAlpha ?? 0.45);
      circle(x + ink.shadow, y + ink.shadow, rim);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    circle(x, y, rim);
    ctx.fill();
  }
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (picture) {
    // A photo fills the whole disc, cropped to a centered square and clipped to the circle.
    ctx.save();
    ctx.clip();
    const side = Math.min(picture.naturalWidth, picture.naturalHeight);
    ctx.drawImage(
      picture,
      (picture.naturalWidth - side) / 2,
      (picture.naturalHeight - side) / 2,
      side,
      side,
      x - r,
      y - r,
      r * 2,
      r * 2,
    );
    if (hit) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (emote) {
    // The fighter is the chatter's emote on a dark disc; the ring shows the guild.
    ctx.fillStyle = 'rgba(17, 20, 24, 0.7)';
    ctx.fill();
    // Clipped to the circle, so an emote never sticks out past the fighter's ring.
    const size = r * 1.9;
    const paint = (target) => {
      target.save();
      target.beginPath();
      target.arc(x, y, r, 0, Math.PI * 2);
      target.clip();
      target.drawImage(emote, x - size / 2, y - size / 2, size, size);
      if (hit) {
        target.fillStyle = 'rgba(255, 255, 255, 0.6)';
        target.fill();
      }
      target.restore();
    };
    // With a pixel theme, emotes stay sharp unless the streamer wants them pixelated too.
    if (Theme.current.pixelScale > 1 && pixelated() && state && state.display && state.display.pixelateEmotes === false) deferImage(paint);
    else paint(ctx);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else {
    ctx.fillStyle = hit ? '#FFFFFF' : fighter.color || guildColor;
    ctx.fill();
  }
  // The ring always shows the guild, whatever the chatter's own color is.
  ctx.lineWidth = 4;
  ctx.strokeStyle = guildColor;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
  ctx.stroke();

  // Enraged: a red veil over the fighter that beats with its pulse.
  if (enraged) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 30, 20, ${0.38 + 0.2 * Math.sin(performance.now() / 110)})`;
    ctx.fill();
  }
  // Scorched by lightning: blackened, with a glowing rim.
  if (flags & FLAG.scorched) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(255, 140, 40, ${0.6 + 0.4 * Math.sin(performance.now() / 70 + x)})`;
    ctx.stroke();
  }

  // Status rings: shielded in gold, enraged in pulsing red, slowed in pale blue.
  if (flags & FLAG.shielded) {
    ctx.beginPath();
    ctx.arc(x, y, r + 9, 0, Math.PI * 2);
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#FFE27A';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 16, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 226, 122, 0.45)';
    ctx.stroke();
  }
  if (flags & FLAG.enraged) {
    ctx.beginPath();
    ctx.arc(x, y, r + 6 + 3 * Math.sin(performance.now() / 90), 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#FF3B30';
    ctx.stroke();
  }
  if (flags & FLAG.slowed) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#7FD4FF';
    ctx.stroke();
  }
  if (squashed) {
    ctx.restore();
    ctx.globalAlpha = alpha;
  }

  if (health > 0 && health < 1) {
    const width = r * 2.2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x - width / 2, y - r - 12, width, 5);
    ctx.fillStyle = health > 0.35 ? '#5BD66E' : '#FF6B5E';
    ctx.fillRect(x - width / 2, y - r - 12, width * health, 5);
  }

  if (fighter.name && namesOn()) {
    ctx.font = `600 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#FFFFFF';
    outlinedText(fighter.name, x, y - r - 17);
  }
  if (fighter.crown) drawCrown(x, y - r - 36);
  if (fighter.cls) drawClassBadge(fighter.cls, x + r * 0.72, y + r * 0.72, Math.max(9, r * 0.42));
  ctx.globalAlpha = 1;
}

// --- Skill effects -----------------------------------------------------------

/** How long an arrow is seen in flight. Longer than the simulation's hit, so the eye can follow it. */
const ARROW_FLIGHT_MS = 380;

const FLAG = {
  hit: 1,
  slowed: 2,
  shielded: 4,
  enraged: 8,
  flying: 16,
  scorched: 32,
  spinning: 64,
  benched: 128,
  hidden: 256,
  jumped: 512,
};
// --- Highlights: noteworthy deaths beside the scoreboard ------------------------

/** Whether the streamer shows fighters' names, and the highlights (both on unless switched off). */
function namesOn() {
  return !state || !state.display || state.display.names !== false;
}

function highlightsOn() {
  return !state || !state.display || state.display.highlights !== false;
}

/**
 * The highlights: a new line at most every `gapMs`, the most important
 * waiting death first (in the order of `RANKS`); a death that waited longer
 * than `waitMs` is dropped. At most `max` lines, newest on top, each for `lifeMs`.
 */
// Three rows fit in the strip kept free for the scoreboard, above the fighters' names.
const FEED = { gapMs: 800, waitMs: 3000, lifeMs: 6500, inMs: 250, fadeMs: 600, max: 3, font: 16, height: 26, gap: 4 };
const RANKS = ['godFalls', 'last', 'crown', 'streak', 'spree', 'cause', 'firstBlood', 'kill'];

/** A fighter's name for a highlight: a minion is "the god's minion". */
function feedName(fighter) {
  if (!fighter.minion) return fighter.name;
  const god = battle.fighters.find((f) => f.side === fighter.side && !f.minion);
  return tr('overlay.feed.minion', { god: god ? god.name : '' });
}

/**
 * The line for a death, as pieces of text with their colors: the names in
 * their side's color. Its kind is the reason; a death by an obstacle, which
 * has no killer, and one noteworthy by its cause alone, take the cause's lines.
 * One of the kind's variants is picked at random.
 */
function feedLine(event) {
  const victim = battle.fighters[event.i];
  const killer = event.b >= 0 ? battle.fighters[event.b] : null;
  const kind = !killer || event.h === 'cause' || event.h === 'kill' ? event.c : event.h;
  /** How many variants a family of lines has. */
  const variants = (family) => {
    let count = 0;
    while (tr(`${family}.${count + 1}`) !== `${family}.${count + 1}`) count++;
    return count;
  };
  let family = `overlay.feed.${kind}`;
  // In an arena, often a line of its own: a barrel in the Brewery, a plain kill in the Ruins.
  if (battle.place) {
    const plain = ['strike', 'arrow', 'spin', 'blast'].includes(kind);
    const own = `overlay.feed.place.${battle.place}.${plain ? 'kill' : kind}`;
    if (variants(own) > 0 && Math.random() < (plain ? 0.35 : 0.6) && (!plain || killer)) family = own;
  }
  const count = variants(family);
  if (!victim || count === 0) return null;
  const key = `${family}.${1 + Math.floor(Math.random() * count)}`;
  const color = (fighter) => battle.sideColors[fighter.side] || '#FFFFFF';
  const names = {
    '\u0001': { text: feedName(victim), color: color(victim) },
    '\u0002': killer ? { text: feedName(killer), color: color(killer) } : { text: '', color: '#FFFFFF' },
  };
  return tr(key, { victim: '\u0001', killer: '\u0002' })
    .split(/(\u0001|\u0002)/)
    .filter((part) => part !== '')
    .map((part) => names[part] || { text: part, color: null });
}

/** Moves waiting deaths into the shown lines, and lets old lines go. */
function updateFeed(now) {
  const feed = battle.feed;
  feed.queue = feed.queue.filter((event) => now - event.at <= FEED.waitMs);
  if (feed.queue.length > 0 && now - feed.lastAt >= FEED.gapMs) {
    const best = feed.queue.reduce((a, b) => (RANKS.indexOf(b.h) < RANKS.indexOf(a.h) ? b : a));
    feed.queue.splice(feed.queue.indexOf(best), 1);
    const parts = feedLine(best);
    if (parts) {
      feed.lines.unshift({ parts, shownAt: now });
      feed.lastAt = now;
    }
  }
  feed.lines = feed.lines.filter((line) => now - line.shownAt < FEED.lifeMs).slice(0, FEED.max);
}

/** The highlights, from (`left`, `top`) down, no wider than `maxWidth`. */
function drawFeed(now, left, top, maxWidth) {
  updateFeed(now);
  battle.feed.lines.forEach((line, row) => {
    const age = now - line.shownAt;
    const alpha = Math.min(1, age / FEED.inMs, (FEED.lifeMs - age) / FEED.fadeMs);
    const slide = (1 - Math.min(1, age / FEED.inMs)) * -30;
    let size = FEED.font;
    ctx.font = `600 ${size}px ${FONT}`;
    let width = line.parts.reduce((sum, part) => sum + textWidth(part.text), 0);
    // A long line gets smaller letters rather than running into the scoreboard.
    if (width > maxWidth - 24) {
      size = Math.max(11, Math.floor((size * (maxWidth - 24)) / width));
      ctx.font = `600 ${size}px ${FONT}`;
      width = line.parts.reduce((sum, part) => sum + textWidth(part.text), 0);
    }
    const y = top + row * (FEED.height + FEED.gap);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(slide, 0);
    ctx.beginPath();
    ctx.roundRect(left, y, Math.min(maxWidth, width + 24), FEED.height, FEED.height / 2);
    ctx.fillStyle = 'rgba(17, 20, 24, 0.78)';
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let x = left + 12;
    for (const part of line.parts) {
      ctx.fillStyle = part.color || '#FFFFFF';
      ctx.fillText(part.text, x, y + FEED.height / 2 + 1, maxWidth - 24);
      x += textWidth(part.text);
    }
    ctx.restore();
  });
}

/** Where the scoreboard is: its left edge, so the highlights keep left of it. */
function hudLeft() {
  if (battle.sides.length > 4) return (canvas.width - 520) / 2;
  const width = battle.sides.length * 230 + (battle.sides.length - 1) * 24 + 48;
  return (canvas.width - width) / 2;
}

/**
 * The caption over a caster: the skill's name from the language files. Enrage
 * is not cast but a state the god falls into, so it reads as one ("Enraged").
 */
function skillCaption(skill) {
  return skill === 'enrage' ? tr('overlay.caption.enraged') : tr(`skill.${skill}.name`);
}

/** A small number from 0 to 1 that is always the same for the same seed: for effects that must not jitter. */
function hash01(seed) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * A mage's spell being prepared: an orb flies from the mage to the spot, and
 * a circle of runes turns there, brighter as the blast nears.
 */
function drawMageRune(caster, x, y, radius, p, now, color) {
  if (Theme.current.art.mageRune) {
    Theme.current.art.mageRune(ctx, x, y, radius, p, now, color, { px: Theme.current.pixelScale });
    return;
  }
  ctx.save();
  // The ground darkens and glows in the mage's color.
  const glow = ctx.createRadialGradient(x, y, radius * 0.1, x, y, radius);
  glow.addColorStop(0, `rgba(255, 255, 255, ${0.1 + 0.25 * p})`);
  glow.addColorStop(0.6, color);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.globalAlpha = 0.18 + 0.32 * p;
  circle(x, y, radius);
  ctx.fillStyle = glow;
  ctx.fill();

  ctx.globalAlpha = 0.55 + 0.45 * p;
  ctx.strokeStyle = '#FFFFFF';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  // Two rings turning against each other, with rune marks between them.
  const spin = now / 900;
  ctx.lineWidth = 3;
  circle(x, y, radius);
  ctx.stroke();
  ctx.lineWidth = 2;
  circle(x, y, radius * 0.78);
  ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const angle = spin + (i / 12) * Math.PI * 2;
    const inner = radius * 0.8;
    const outer = radius * 0.97;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    ctx.lineTo(x + Math.cos(angle + 0.12) * outer, y + Math.sin(angle + 0.12) * outer);
    if (i % 3 === 0) ctx.lineTo(x + Math.cos(angle + 0.24) * inner, y + Math.sin(angle + 0.24) * inner);
    ctx.stroke();
  }
  // A six-pointed star turning the other way.
  for (const offset of [0, Math.PI / 3]) {
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const angle = -spin * 1.4 + offset + (i / 3) * Math.PI * 2;
      const px = x + Math.cos(angle) * radius * 0.74;
      const py = y + Math.sin(angle) * radius * 0.74;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  // The orb, in the first part of the warning, flying from the mage with a short tail.
  if (caster && p < 0.45) {
    const t = p / 0.45;
    const ox = caster.x + (x - caster.x) * t;
    const oy = caster.y + (y - caster.y) * t - Math.sin(Math.PI * t) * 60;
    ctx.save();
    for (let k = 4; k >= 0; k--) {
      const back = Math.max(0, t - k * 0.04);
      const tx = caster.x + (x - caster.x) * back;
      const ty = caster.y + (y - caster.y) * back - Math.sin(Math.PI * back) * 60;
      ctx.globalAlpha = 0.18 * (5 - k);
      circle(tx, ty, 9 - k);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const core = ctx.createRadialGradient(ox, oy, 0, ox, oy, 13);
    core.addColorStop(0, '#FFFFFF');
    core.addColorStop(0.5, color);
    core.addColorStop(1, 'rgba(0, 0, 0, 0)');
    circle(ox, oy, 13);
    ctx.fillStyle = core;
    ctx.fill();
    ctx.restore();
  }
}

/** A mage's blast going off: a flash, two rings and sparks flying out. */
function drawMageBlast(x, y, radius, p, color) {
  if (Theme.current.art.mageBlast) {
    Theme.current.art.mageBlast(ctx, x, y, radius, p, color, { px: Theme.current.pixelScale });
    return;
  }
  ctx.save();
  const fade = 1 - p;
  // The flash at the heart of it.
  const flash = ctx.createRadialGradient(x, y, 0, x, y, radius * (0.7 + 0.6 * p));
  flash.addColorStop(0, `rgba(255, 255, 255, ${0.95 * fade})`);
  flash.addColorStop(0.35, color);
  flash.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.globalAlpha = fade;
  circle(x, y, radius * (0.7 + 0.6 * p));
  ctx.fillStyle = flash;
  ctx.fill();
  // A second, fainter ring just behind the first.
  ctx.globalAlpha = fade * 0.5;
  ctx.lineWidth = 4 * fade + 1;
  ctx.strokeStyle = '#FFFFFF';
  circle(x, y, radius * (0.25 + 0.75 * p));
  ctx.stroke();
  // The ring that runs outward.
  ctx.globalAlpha = fade;
  ctx.lineWidth = 8 * fade + 2;
  ctx.strokeStyle = color;
  circle(x, y, radius * (0.4 + 0.9 * p));
  ctx.stroke();
  // Sparks: short streaks thrown outward, each in its own fixed direction.
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#FFFFFF';
  for (let i = 0; i < 16; i++) {
    const angle = hash01(x * 0.13 + y * 0.71 + i) * Math.PI * 2;
    const reach = radius * (0.5 + 1.1 * hash01(i * 3.1 + x) ) * (0.3 + 0.9 * p);
    const tail = reach * 0.7;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * tail, y + Math.sin(angle) * tail);
    ctx.lineTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
    ctx.stroke();
  }
  ctx.restore();
}

/** How strongly a fire burns: it flares up at once and dies down over its last second. */
function fireStrength(mark, now) {
  const age = now - mark.start;
  return Math.max(0, Math.min(1, age / 150) * Math.min(1, (mark.ms - age) / 1000));
}

/** Burning ground under the fighters: charred earth, a glow, and cracks of embers. */
function drawFireGround(mark, now) {
  if (Theme.current.art.fireGround) {
    Theme.current.art.fireGround(ctx, mark, now, { px: Theme.current.pixelScale });
    return;
  }
  const strength = fireStrength(mark, now);
  const { x, y, r } = mark;
  ctx.save();
  const char = ctx.createRadialGradient(x, y, 0, x, y, r * 1.1);
  char.addColorStop(0, `rgba(20, 8, 0, ${0.7 * strength})`);
  char.addColorStop(0.7, `rgba(20, 8, 0, ${0.45 * strength})`);
  char.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.1, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = char;
  ctx.fill();
  // Glowing cracks that pulse.
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const angle = hash01(x + i * 7.7) * Math.PI * 2;
    const length = r * (0.45 + 0.4 * hash01(y + i * 3.3));
    const pulse = 0.5 + 0.5 * Math.sin(now / 160 + i * 1.9);
    ctx.strokeStyle = `rgba(255, ${120 + Math.round(80 * pulse)}, 30, ${0.8 * strength})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const bend = angle + (hash01(i + x) - 0.5) * 0.8;
    ctx.quadraticCurveTo(
      x + Math.cos(bend) * length * 0.5,
      y + Math.sin(bend) * length * 0.35,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length * 0.7,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The fire itself, over the fighters: layered flame tongues that lick upward,
 * hotter in the middle, embers drifting up and a little smoke above.
 */
function drawFireFlames(mark, now) {
  if (Theme.current.art.fireFlames) {
    Theme.current.art.fireFlames(ctx, mark, now, { px: Theme.current.pixelScale });
    return;
  }
  const strength = fireStrength(mark, now);
  if (strength <= 0) return;
  const { x, y, r } = mark;
  ctx.save();
  // Smoke first, so the flames are in front of it.
  for (let i = 0; i < 5; i++) {
    const phase = (now / 2400 + hash01(x + i * 5.1)) % 1;
    const sx = x + (hash01(i * 9.7 + y) - 0.5) * r + Math.sin(now / 700 + i) * 10;
    const sy = y - r * 2.2 - phase * r * 2.6;
    ctx.globalAlpha = 0.35 * strength * Math.sin(Math.PI * phase);
    circle(sx, sy, r * (0.25 + 0.45 * phase));
    ctx.fillStyle = '#3A3530';
    ctx.fill();
  }
  // Three layers of flame tongues: dark red at the back, orange, then yellow-white in front.
  const layers = [
    { color: [190, 30, 10], height: 2.9, width: 0.34, count: 12 },
    { color: [255, 110, 20], height: 2.2, width: 0.26, count: 10 },
    { color: [255, 225, 120], height: 1.4, width: 0.17, count: 7 },
  ];
  ctx.globalCompositeOperation = 'lighter';
  layers.forEach((layer, depth) => {
    for (let i = 0; i < layer.count; i++) {
      const seed = x * 0.37 + y * 0.11 + depth * 17 + i * 3.7;
      const spread = (hash01(seed) - 0.5) * 2;
      const fx = x + spread * r * (0.95 - depth * 0.2);
      const fy = y + hash01(seed + 1) * r * 0.25;
      const lick = 0.65 + 0.35 * Math.sin(now / (70 + 25 * hash01(seed + 2)) + seed);
      const height = r * layer.height * lick * strength * (1 - Math.abs(spread) * 0.35);
      const half = r * layer.width;
      const sway = Math.sin(now / 180 + seed) * half * 0.8;
      const [cr, cg, cb] = layer.color;
      const gradient = ctx.createLinearGradient(fx, fy, fx, fy - height);
      gradient.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.85 * strength})`);
      gradient.addColorStop(1, `rgba(${cr}, ${Math.min(255, cg + 60)}, ${cb}, 0)`);
      ctx.beginPath();
      ctx.moveTo(fx - half, fy);
      ctx.bezierCurveTo(fx - half, fy - height * 0.45, fx + sway, fy - height * 0.6, fx + sway * 1.4, fy - height);
      ctx.bezierCurveTo(fx + sway, fy - height * 0.55, fx + half, fy - height * 0.4, fx + half, fy);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  });
  // Embers: bright specks rising and fading, each on its own track.
  for (let i = 0; i < 14; i++) {
    const seed = x + y * 0.5 + i * 13.37;
    const phase = (now / (1100 + 600 * hash01(seed)) + hash01(seed + 4)) % 1;
    const ex = x + (hash01(seed + 5) - 0.5) * r * 1.4 + Math.sin(now / 250 + i) * 8 * phase;
    const ey = y - phase * r * 3.4;
    ctx.globalAlpha = strength * (1 - phase);
    ctx.fillStyle = phase < 0.5 ? '#FFE9A0' : '#FF8A30';
    ctx.fillRect(ex - 2, ey - 2, 4, 4);
  }
  ctx.restore();
}

/** How long an effect is drawn. Some outlast the simulation's event, to be seen. */
function effectLife(e) {
  if (e.fx === 'arrow') return ARROW_FLIGHT_MS;
  if (e.fx === 'blink') return 450;
  if (e.fx === 'blast') return 700;
  return e.ms || 500;
}

function circle(x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, radius), 0, Math.PI * 2);
}

/**
 * The middle of a group of fighters and a radius that covers them, or null if
 * none of them is on the field. With `caught`, only fighters a whirlwind holds count.
 */
function groupCenter(group, at, caught) {
  const members = group
    .map((index) => at[index])
    .filter((d) => d && d.health > 0 && (!caught || d.flags & FLAG.spinning));
  if (members.length === 0) return null;
  const x = members.reduce((sum, d) => sum + d.x, 0) / members.length;
  const y = members.reduce((sum, d) => sum + d.y, 0) / members.length;
  const reach = Math.max(...members.map((d) => Math.hypot(d.x - x, d.y - y) + d.r));
  return { x, y, r: reach + 14 };
}

/** A whirlwind seen from above: a hazy disc, turning arms, and rings that are sucked inward. */
function drawWhirlwind(x, y, radius, now, alpha, color) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const haze = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * 1.15);
  haze.addColorStop(0, 'rgba(235, 240, 255, 0.05)');
  haze.addColorStop(0.75, 'rgba(235, 240, 255, 0.22)');
  haze.addColorStop(1, 'rgba(235, 240, 255, 0)');
  circle(x, y, radius * 1.15);
  ctx.fillStyle = haze;
  ctx.fill();

  // Rings fall toward the middle.
  for (let ring = 0; ring < 3; ring++) {
    const t = (now / 700 + ring / 3) % 1;
    circle(x, y, radius * (1.15 - 0.9 * t));
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * (1 - t)})`;
    ctx.stroke();
  }

  // Five curved arms turn with the fighters; every other one carries the caster's color.
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 5; arm++) {
    ctx.beginPath();
    for (let step = 0; step <= 14; step++) {
      const angle = now / 200 + (arm * Math.PI * 2) / 5 + step * 0.17;
      const distance = radius * (0.25 + 0.065 * step);
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance;
      if (step === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineWidth = arm % 2 === 0 ? 6 : 4;
    ctx.strokeStyle = arm % 2 === 0 ? 'rgba(255, 255, 255, 0.75)' : color;
    ctx.stroke();
  }
  ctx.restore();
}

/** Effects that lie on the ground, under the fighters: warnings, rings, the rampage trail. */
function drawGroundEffects(now, at) {
  const scale = battle.scale;
  battle.effects = battle.effects.filter((e) => now - e.start < effectLife(e) + 150);

  for (const e of battle.effects) {
    const caster = at[e.i];
    if (!caster) continue;
    const p = Math.min(1, (now - e.start) / (e.ms || 500));
    const color = battle.sideColors[caster.fighter.side] || '#FFFFFF';
    const key = `${e.k}:${e.s}`;
    ctx.save();

    if (e.k === 'fx' && e.fx === 'blink') {
      // The god's blink: a burst of smoke where it was, and a ring closing in where it lands.
      const p2 = Math.min(1, (now - e.start) / 450);
      circle(e.x * scale, e.y * scale, caster.r * (1 + 1.4 * p2));
      ctx.fillStyle = `rgba(20, 14, 30, ${0.55 * (1 - p2)})`;
      ctx.fill();
      const [tx, ty] = e.t || [e.x, e.y];
      circle(tx * scale, ty * scale, caster.r * (2.2 - 1.2 * p2));
      ctx.lineWidth = 6 * (1 - p2) + 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 1 - p2;
      ctx.stroke();
    } else if (e.k === 'fx' && (e.fx === 'dash' || e.fx === 'wrap')) {
      // A dash raises a puff of dust where it started.
      circle(e.x * scale, e.y * scale, caster.r * (0.8 + 1.2 * p));
      ctx.fillStyle = `rgba(255, 255, 255, ${0.25 * (1 - p)})`;
      ctx.fill();
    } else if (e.k === 'fx' && e.fx === 'shadow') {
      // A puff of dark smoke where a thief vanishes or steps back out.
      circle(caster.x, caster.y, caster.r * (1 + 1.8 * p));
      ctx.fillStyle = `rgba(10, 8, 20, ${0.6 * (1 - p)})`;
      ctx.fill();
    } else if (e.k === 'fx' && e.fx === 'spin') {
      // A fighter's spin: a bright arc sweeps once around it.
      const sweep = p * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(caster.x, caster.y, e.r * scale, sweep - 2.4, sweep);
      ctx.lineWidth = 9 * (1 - p) + 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * (1 - p * 0.6)})`;
      ctx.stroke();
    } else if (e.k === 'fx' && e.fx === 'blast-warn') {
      drawMageRune(caster, e.x * scale, e.y * scale, e.r * scale, p, now, color);
    } else if (e.k === 'fx' && e.fx === 'blast') {
      drawMageBlast(e.x * scale, e.y * scale, e.r * scale, Math.min(1, (now - e.start) / effectLife(e)), color);
    } else if (e.k === 'enter') {
      // A fighter steps in from the bench: a ring in their side's color closes in on them.
      circle(caster.x, caster.y, caster.r * (3 - 2 * p));
      ctx.lineWidth = 6 * (1 - p) + 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = p;
      ctx.stroke();
    } else if (key === 'warn:shockwave') {
      // The area about to be blasted fills in around the caster.
      circle(caster.x, caster.y, e.r * scale + caster.r);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + 0.13 * p})`;
      ctx.fill();
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.stroke();
    } else if (key === 'cast:shockwave') {
      circle(caster.x, caster.y, e.r * scale * p);
      ctx.lineWidth = 14 * (1 - p) + 2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${1 - p})`;
      ctx.stroke();
    } else if (key === 'warn:leap') {
      // A shadow grows where the god will land.
      circle(e.x * scale, e.y * scale, e.r * scale * (0.25 + 0.75 * p));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fill();
      circle(e.x * scale, e.y * scale, e.r * scale);
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else if (key === 'cast:leap') {
      circle(e.x * scale, e.y * scale, e.r * scale * (0.5 + 0.7 * p));
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * (1 - p)})`;
      ctx.fill();
      ctx.lineWidth = 12 * (1 - p) + 2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${1 - p})`;
      ctx.stroke();
    } else if (key === 'warn:rampage') {
      // A lane shows which way the god is about to charge.
      const length = 620;
      ctx.lineCap = 'round';
      ctx.lineWidth = caster.r * 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.12 + 0.14 * p + 0.06 * Math.sin(now / 60);
      ctx.beginPath();
      ctx.moveTo(caster.x, caster.y);
      ctx.lineTo(caster.x + e.dx * length, caster.y + e.dy * length);
      ctx.stroke();
    } else if (key === 'warn:vortex') {
      // A whirl gathers around each group that is about to be caught.
      for (const group of e.g || []) {
        const spot = groupCenter(group, at, false);
        if (spot) drawWhirlwind(spot.x, spot.y, spot.r * (0.4 + 0.6 * p), now, 0.25 + 0.45 * p, color);
      }
    } else if (key === 'cast:vortex') {
      // Each whirlwind lasts its own time, then thins out as it lets its fighters go.
      (e.g || []).forEach((group, n) => {
        const left = e.d[n] - (now - e.start);
        if (left <= -250) return;
        const spot = groupCenter(group, at, true);
        if (spot) drawWhirlwind(spot.x, spot.y, spot.r, now, left > 0 ? 1 : 1 + left / 250, color);
      });
    } else if (key === 'cast:minions') {
      for (const index of e.t || []) {
        const minion = at[index];
        if (!minion) continue;
        circle(minion.x, minion.y, minion.r * (1 + 2 * p));
        ctx.lineWidth = 6 * (1 - p) + 1;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1 - p;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Burning ground where lightning struck: charred earth glowing under the flames.
  battle.marks = battle.marks.filter((mark) => now - mark.start < mark.ms);
  for (const mark of battle.marks) drawFireGround(mark, now);

  // Afterimages behind a rampaging fighter.
  const trail = battle.trail;
  const runner = at[trail.index];
  if (runner && now < trail.until && runner.health > 0) {
    trail.points.push({ x: runner.x, y: runner.y });
    if (trail.points.length > 9) trail.points.shift();
  } else if (trail.points.length > 0) {
    trail.points.shift();
  }
  if (runner) {
    trail.points.forEach((point, index) => {
      circle(point.x, point.y, runner.r * (0.55 + 0.4 * (index / 9)));
      ctx.fillStyle = battle.sideColors[runner.fighter.side] || '#FFFFFF';
      ctx.globalAlpha = 0.07 + 0.035 * index;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
}

/** Effects drawn over the fighters: lightning, target marks, and the skill's name. */
function drawTopEffects(now, at) {
  // Class effects that fly over the fighters: arrows and heals.
  for (const e of battle.effects) {
    if (e.k !== 'fx' || (e.fx !== 'arrow' && e.fx !== 'heal')) continue;
    const from = at[e.i];
    const to = at[(e.t || [])[0]];
    if (!from || !to) continue;
    const p = Math.min(1, (now - e.start) / (e.ms || 200));
    ctx.save();
    ctx.lineCap = 'round';
    if (e.fx === 'arrow') {
      // An arrow on a shallow arc from the archer to its target, nose following its path.
      const flight = Math.min(1, (now - e.start) / ARROW_FLIGHT_MS);
      if (flight >= 1) {
        ctx.restore();
        continue;
      }
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const lift = Math.min(110, Math.hypot(dx, dy) * 0.22);
      const x = from.x + dx * flight;
      const y = from.y + dy * flight - Math.sin(Math.PI * flight) * lift;
      const angle = Math.atan2(dy - Math.cos(Math.PI * flight) * Math.PI * lift, dx);
      drawArrowProjectile(x, y, angle, Math.max(30, from.r * 1.6));
    } else {
      // A soft green beam from the healer, and a ring around the one being healed.
      ctx.globalAlpha = 0.75 * (1 - p * 0.6);
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#7CF29A';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      circle(to.x, to.y, to.r + 4 + 6 * p);
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  // The flames of burning ground rise over the fighters standing in it, so the fire is never hidden by a crowd.
  for (const mark of battle.marks) drawFireFlames(mark, now);

  for (const e of battle.effects) {
    if (e.s !== 'smite') continue;
    const p = Math.min(1, (now - e.start) / (e.ms || 500));
    ctx.save();
    for (const index of e.t || []) {
      const target = at[index];
      if (!target) continue;
      if (e.k === 'warn') {
        // A mark closes in on each fighter about to be struck.
        circle(target.x, target.y, target.r + 26 * (1 - p) + 6);
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#FFE27A';
        ctx.stroke();
      } else {
        // A jagged bolt from the top of the screen; its shape is fixed per target.
        ctx.beginPath();
        ctx.moveTo(target.x + 40, 0);
        const segments = 7;
        for (let i = 1; i <= segments; i++) {
          const jitter = i === segments ? 0 : Math.sin(index * 12.9898 + i * 78.233) * 34;
          ctx.lineTo(target.x + 40 * (1 - i / segments) + jitter, (target.y * i) / segments);
        }
        ctx.lineWidth = 9 * (1 - p) + 2;
        ctx.strokeStyle = `rgba(255, 244, 190, ${1 - p})`;
        ctx.lineJoin = 'round';
        ctx.stroke();
        circle(target.x, target.y, target.r * (1 + 1.5 * p));
        ctx.fillStyle = `rgba(255, 244, 190, ${0.6 * (1 - p)})`;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // The skill's name, large across the bottom of the screen, fading out; over the fighters' names too.
  drawOnTop(() => drawCaption(now, at));
}

/** The name of the skill being cast, large across the bottom of the screen. */
function drawCaption(now, at) {
  const caption = battle.caption;
  if (caption) {
    const age = now - caption.start;
    const caster = at[caption.index];
    if (age < 1800 && caster && caster.health > 0) {
      const color = battle.sideColors[caster.fighter.side] || '#FFE27A';
      ctx.save();
      // It pops in slightly oversized, settles, and fades at the end.
      ctx.globalAlpha = age < 1300 ? 1 : 1 - (age - 1300) / 500;
      const pop = 1 + 0.18 * Math.max(0, 1 - age / 180);
      // Low in the arena: above a map banner at the bottom, never over it.
      ctx.translate(canvas.width / 2, battle.view.top + battle.view.height - 120);
      ctx.scale(pop, pop);
      ctx.font = `800 96px ${FONT}`;
      if (Theme.current.art.caption) {
        Theme.current.art.caption(ctx, caption.text, { color, age, font: FONT, width: textWidth(caption.text), px: Theme.current.pixelScale });
        ctx.restore();
        return;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 14;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.strokeText(caption.text, 0, 0);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(caption.text, 0, 0);
      // A bar in the caster's color under the name ties it to the god.
      const width = textWidth(caption.text);
      ctx.fillStyle = color;
      ctx.fillRect(-width / 2, 58, width, 8);
      ctx.restore();
    }
  }
}

function drawBattleHud(frame) {
  const remaining = Math.max(0, battle.durationMs - frame.t);
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  // A free-for-all has one side per fighter: far too many for columns. Show how many are left.
  if (battle.sides.length > 4) {
    const left = (canvas.width - 520) / 2;
    drawBox(left, 24, 520, 92, { radius: 16 });
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(battle.title, left + 24, 50, 400);
    ctx.textAlign = 'right';
    ctx.fillText(clock, left + 496, 50);
    let remaining = 0;
    let fighting = 0;
    battle.fighters.forEach((fighter, i) => {
      if (fighter.minion) return;
      if (frame.f[i][2] > 0) fighting++;
      if (frame.f[i][2] > 0 || frame.f[i][3] & FLAG.benched) remaining++;
    });
    ctx.textAlign = 'left';
    ctx.font = `400 18px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    const stillIn = tr('overlay.hud.left', { left: remaining, total: battle.fighters.length });
    ctx.fillText(`${stillIn} · ${tr('overlay.hud.onField', { count: fighting })}`, left + 24, 86, 472);
    return;
  }

  const columnWidth = 230;
  const gap = 24;
  const width = battle.sides.length * columnWidth + (battle.sides.length - 1) * gap + 48;
  const left = (canvas.width - width) / 2;
  drawBox(left, 24, width, 108, { radius: 16 });

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 20px ${FONT}`;
  const clockWidth = textWidth('0:00');
  // The arena's name sits left of the clock, in the place's gold; the title gets the room that is left.
  let placeWidth = 0;
  if (battle.place) {
    const name = tr(`arena.${battle.place}.name`);
    ctx.font = `600 16px ${FONT}`;
    placeWidth = Math.min(textWidth(name), width * 0.4);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#F2C76B';
    ctx.fillText(name, left + width - 24 - clockWidth - 18, 51, placeWidth);
    placeWidth += 18;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillStyle = '#FFFFFF';
  }
  ctx.textAlign = 'left';
  // Room is left for the clock on the right.
  ctx.fillText(battle.title, left + 24, 50, width - 48 - clockWidth - 24 - placeWidth);
  ctx.textAlign = 'right';
  ctx.fillText(clock, left + width - 24, 50);

  battle.sides.forEach((side, index) => {
    let total = 0;
    let alive = 0;
    let health = 0;
    battle.fighters.forEach((fighter, i) => {
      if (fighter.side !== side.id) return;
      // Minions count only while they are on the field.
      if (fighter.minion && frame.f[i][2] === 0) return;
      total++;
      // A fighter on the bench is still in the fight, at full health.
      const benched = frame.f[i][2] === 0 && (frame.f[i][3] & FLAG.benched) !== 0;
      if (frame.f[i][2] > 0 || benched) alive++;
      health += benched ? 1 : frame.f[i][2];
    });
    const x = left + 24 + index * (columnWidth + gap);
    ctx.textAlign = 'left';
    ctx.font = `600 17px ${FONT}`;
    ctx.fillStyle = side.color;
    ctx.fillText(side.name, x, 84);
    ctx.textAlign = 'right';
    ctx.font = `400 16px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(tr('overlay.hud.alive', { alive, total }), x + columnWidth, 84);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x, 102, columnWidth, 8);
    ctx.fillStyle = side.color;
    ctx.fillRect(x, 102, columnWidth * (total ? health / total : 0), 8);
  });
}

/** The arena's name, introduced when a battle starts: it grows in, holds a moment and fades. */
const ARENA_INTRO = { ms: 2600, inMs: 350, outMs: 600 };

function drawArenaIntro(elapsed, height) {
  const p = Math.min(1, elapsed / ARENA_INTRO.inMs);
  const alpha = Math.min(p, (ARENA_INTRO.ms - elapsed) / ARENA_INTRO.outMs);
  if (alpha <= 0) return;
  const grow = 0.85 + 0.15 * (1 - (1 - p) ** 3);
  const x = canvas.width / 2;
  const y = height * 0.5;
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(x, y);
  ctx.scale(grow, grow);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const name = tr(`arena.${battle.place}.name`);
  const tagline = tr(`arena.${battle.place}.tagline`);
  ctx.font = `800 72px ${FONT}`;
  const width = Math.max(textWidth(name), 360) + 120;
  // A dark band behind the words, fading out at its ends, so they read over any crowd.
  const band = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);
  band.addColorStop(0, 'rgba(17, 20, 24, 0)');
  band.addColorStop(0.2, 'rgba(17, 20, 24, 0.72)');
  band.addColorStop(0.8, 'rgba(17, 20, 24, 0.72)');
  band.addColorStop(1, 'rgba(17, 20, 24, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(-width / 2, -78, width, 150);
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.strokeText(name, 0, -14);
  ctx.fillStyle = '#F2C76B';
  ctx.fillText(name, 0, -14);
  ctx.font = `500 24px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillText(tagline, 0, 42, width - 60);
  ctx.restore();
}

function drawBattleResult() {
  const end = battle.end;
  // The winner may be a team of several sides, such as all of chat against the god.
  const winner = end.winnerName ? { name: end.winnerName, color: end.winnerColor } : null;
  const headline = winner ? tr('overlay.result.wins', { name: winner.name }) : tr('overlay.result.noWinner');
  const parts = [];
  if (winner && end.fighters > 1) parts.push(tr('overlay.result.survived', { survivors: end.survivors, fighters: end.fighters }));
  if (end.endedBy === 'time') parts.push(tr('overlay.result.timeLimit'));
  if (end.mostKills) {
    parts.push(tr('overlay.result.mostKills', { name: end.mostKills.name, count: end.mostKills.kills }));
  }

  drawBanner(headline, parts.join(' · '), winner ? winner.color : null);
}

function drawBattle(now) {
  if (!battle) return;
  if (battle.end && now - battle.end.shownAt > battle.end.holdMs) {
    battle = null;
    drawPanel();
    return;
  }
  requestAnimationFrame(drawBattle);
  frame(() => renderBattle(now));
}

// --- Pachinko -----------------------------------------------------------------

/** The Pachinko game being shown: the server's message, and when it arrived. */
let pachinko = null;

function onPachinko(message) {
  clearTimeout(announcementTimer);
  announcement = null;
  // A page that opened during the game joins it where it has got to.
  pachinko = { ...message, shownAt: performance.now() - (message.elapsedMs || 0) };
  pachinko.banner = bannerOnScreen(message.banner);
  // Who lands where, in order, so balls stack up in their slots.
  for (const board of pachinko.boards) {
    const counts = new Array(pachinko.slots.length).fill(0);
    for (const drop of board.drops) drop.stack = counts[drop.slot]++;
  }
  requestAnimationFrame(animatePachinko);
}

function animatePachinko() {
  if (!pachinko || battle) return;
  frame(renderPanel);
  requestAnimationFrame(animatePachinko);
}

/** Where things are on one board: its box, the pins, the slots. */
function pachinkoLayout(index, count) {
  const gap = 40;
  const width = Math.min(580, (canvas.width - 80 - gap * (count - 1)) / count);
  const left = (canvas.width - (width * count + gap * (count - 1))) / 2 + index * (width + gap);
  const rows = pachinko.rows;
  const spacing = (width - 70) / (rows + 1);
  const top = 70;
  const startY = top + 150;
  const rowHeight = 70;
  const slotTop = startY + 50 + rows * rowHeight;
  return { left, top, width, height: slotTop + 130 - top, cx: left + width / 2, rows, spacing, startY, rowHeight, slotTop };
}

const PIN_RADIUS = 6;
const BALL_RADIUS = 21;
/** How long a pin glows after a ball hits it. */
const PIN_GLOW_MS = 420;
/** A falling ball's trail: how many ghosts, how far apart in time, how strong the nearest. */
const TRAIL = { length: 4, stepMs: 28, alpha: 0.32 };

/** The center of a pin: row `r`, `c` of `r + 1` pins. */
function pinAt(layout, r, c) {
  return { x: layout.cx + (c - r / 2) * layout.spacing, y: layout.startY + 50 + r * layout.rowHeight };
}

/** Where a ball is `t` milliseconds after it was dropped, and whether it has landed. */
function ballAt(layout, drop, t) {
  const hop = pachinko.hopMs;
  const rows = layout.rows;
  // The points it passes: the top, resting on one pin per row, then its slot.
  const point = (step) => {
    if (step === 0) return { x: layout.cx, y: layout.startY - 20 };
    if (step <= rows) {
      const c = drop.path.slice(0, step - 1).reduce((sum, v) => sum + v, 0);
      const pin = pinAt(layout, step - 1, c);
      return { x: pin.x, y: pin.y - PIN_RADIUS - BALL_RADIUS };
    }
    // Landed balls pile up two abreast, a little smaller, so a busy slot does not reach into the pins.
    const x = layout.cx + (drop.slot - rows / 2) * layout.spacing + (drop.stack % 2 === 0 ? -1 : 1) * BALL_RADIUS * 0.3;
    return { x, y: layout.slotTop + 92 - BALL_RADIUS * 0.8 - Math.floor(drop.stack / 2) * BALL_RADIUS * 1.2 - (drop.stack % 2) * BALL_RADIUS * 0.6 };
  };
  if (t >= (rows + 1) * hop) return { ...point(rows + 1), landed: true };
  const step = Math.floor(t / hop);
  const f = (t - step * hop) / hop;
  const from = point(step);
  const to = point(step + 1);
  // Across in a straight line, down under gravity, with a little hop off each pin.
  const bounce = step === 0 ? 0 : Math.sin(Math.PI * f) * 22;
  return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f * f - bounce, landed: false };
}

/** One ball: the chatter's emote in a ring of the guild's color. */
function drawBall(x, y, drop, color) {
  circle(x + 3, y + 4, BALL_RADIUS);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fill();
  circle(x, y, BALL_RADIUS);
  inkPath();
  ctx.fillStyle = drop.imp ? '#2A1838' : drop.color || color;
  ctx.fill();
  if (drop.imp) {
    // One of the streamer's imps rides this ball.
    ctx.save();
    circle(x, y, BALL_RADIUS);
    ctx.clip();
    drawImp(x, y + BALL_RADIUS * 0.12, BALL_RADIUS * 0.62, color, impSeed(drop.name));
    ctx.restore();
  }
  const image = drop.imp ? null : emoteImage(drop.emote);
  if (image) {
    ctx.save();
    circle(x, y, BALL_RADIUS);
    ctx.clip();
    ctx.fillStyle = 'rgba(17, 20, 24, 0.7)';
    ctx.fill();
    const size = BALL_RADIUS * 1.9;
    ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
    ctx.restore();
  }
  circle(x, y, BALL_RADIUS);
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/**
 * The celebration once the last ball has landed. Everything in it is worked
 * out from the time since then, so a page that opens late, or the preview's
 * still pictures, show the same moment.
 */
const PARTY = {
  /** The winning board pops forward over this long, and the others dim. */
  popMs: 450,
  dimMs: 700,
  /** Confetti: a burst from the winning board's two lower corners, then a slower rain over the screen. */
  burst: 130,
  rain: 90,
  rainMs: 3500,
  /** Falling confetti: gravity and air drag, which together give its top speed (gravity / drag). */
  gravity: 900,
  drag: 2.2,
};

/** 0 to 1 with a small overshoot past 1 on the way: things that pop into place. */
function popIn(t) {
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
}

/** How long a board's total takes to count up to a ball's points after it lands. */
const SCORE_ROLL_MS = 450;

/** A board's points from the balls that have landed by `elapsed`, counting up over `SCORE_ROLL_MS` after each lands. */
function pachinkoScore(board, elapsed) {
  const fall = (pachinko.rows + 1) * pachinko.hopMs;
  const sum = board.drops.reduce((total, d) => {
    const since = elapsed - d.at - fall;
    return since < 0 ? total : total + d.points * Math.min(1, since / SCORE_ROLL_MS);
  }, 0);
  return Math.round(sum);
}

/**
 * When each pin of a board was last hit by `elapsed`, keyed "row,column":
 * a ball rests on one pin per row on its way down.
 */
function pinHits(board, elapsed) {
  const hop = pachinko.hopMs;
  const hits = new Map();
  for (const drop of board.drops) {
    let c = 0;
    for (let r = 0; r < pachinko.rows; r++) {
      const at = drop.at + (r + 1) * hop;
      if (at > elapsed) break;
      const key = `${r},${c}`;
      if ((hits.get(key) ?? -Infinity) < at) hits.set(key, at);
      c += drop.path[r] || 0;
    }
  }
  return hits;
}

/**
 * A firework for a jackpot, `t` ms after the ball landed: a rocket climbs
 * from the slot, then bursts into a ball of sparks in gold and the guild's
 * color that drift down and fade.
 */
const FIREWORK = { climbMs: 520, burstMs: 1300, sparks: 26 };

function drawFirework(fromX, x, fromY, toY, t, color, seed) {
  ctx.save();
  if (t < FIREWORK.climbMs) {
    // The rocket: a bright head with a fading tail.
    const p = t / FIREWORK.climbMs;
    const along = 1 - (1 - p) * (1 - p);
    const y = fromY + (toY - fromY) * along;
    const hx = fromX + (x - fromX) * along + Math.sin(t / 40 + seed) * 3;
    // The tail points back down the way it came.
    const dx = x - fromX;
    const dy = toY - fromY;
    const length = Math.hypot(dx, dy) || 1;
    const tx = hx - (dx / length) * 70;
    const ty = y - (dy / length) * 70;
    const tail = ctx.createLinearGradient(hx, y, tx, ty);
    tail.addColorStop(0, 'rgba(255, 236, 160, 0.9)');
    tail.addColorStop(1, 'rgba(255, 236, 160, 0)');
    ctx.strokeStyle = tail;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(hx, y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    circle(hx, y, 5);
    ctx.fillStyle = '#FFF6CF';
    ctx.fill();
    ctx.restore();
    return;
  }
  const b = (t - FIREWORK.climbMs) / FIREWORK.burstMs;
  if (b >= 1) {
    ctx.restore();
    return;
  }
  // A flash, then the sparks.
  if (b < 0.15) {
    circle(x, toY, 30 + 140 * b);
    ctx.fillStyle = `rgba(255, 250, 220, ${0.55 * (1 - b / 0.15)})`;
    ctx.fill();
  }
  ctx.globalAlpha = 1 - b * b;
  for (let i = 0; i < FIREWORK.sparks; i++) {
    const angle = (i / FIREWORK.sparks) * Math.PI * 2 + hash01(seed + i) * 0.3;
    const speed = 150 + 70 * hash01(seed + i * 3);
    const out = speed * (1 - Math.pow(1 - b, 2.2));
    const sx = x + Math.cos(angle) * out;
    const sy = toY + Math.sin(angle) * out + 90 * b * b;
    ctx.fillStyle = i % 3 === 0 ? color : i % 3 === 1 ? '#FFD34A' : '#FFF6CF';
    // A short streak behind each spark, along its way out.
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * out * 0.82, toY + Math.sin(angle) * out * 0.82 + 90 * b * b);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    circle(sx, sy, 3.5 * (1 - b) + 1.2);
    ctx.fill();
  }
  ctx.restore();
}

/** Lights all around the winning board, chasing each other like on a real machine. */
function drawMarquee(layout, color, since) {
  const inset = -12;
  const x0 = layout.left + inset;
  const y0 = layout.top + inset;
  const w = layout.width - inset * 2;
  const h = layout.height - inset * 2;
  const perimeter = 2 * (w + h);
  const count = Math.round(perimeter / 30);
  const step = Math.floor(since / 110);
  for (let i = 0; i < count; i++) {
    let d = (i / count) * perimeter;
    let x;
    let y;
    if (d < w) [x, y] = [x0 + d, y0];
    else if ((d -= w) < h) [x, y] = [x0 + w, y0 + d];
    else if ((d -= h) < w) [x, y] = [x0 + w - d, y0 + h];
    else [x, y] = [x0, y0 + h - (d - w)];
    const lit = (i + step) % 3 === 0;
    circle(x, y, lit ? 7 : 5);
    ctx.fillStyle = lit ? '#FFF3B0' : color;
    ctx.globalAlpha = lit ? 1 : 0.55;
    ctx.fill();
    if (lit) {
      circle(x, y, 13);
      ctx.fillStyle = 'rgba(255, 230, 140, 0.25)';
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Slow rays turning behind the winner's score. */
function drawRays(x, y, layout, color, since) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(layout.left, layout.top, layout.width, 170, PANEL.radius);
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(since / 2600);
  ctx.globalAlpha = 0.22 * ease(since / 600);
  ctx.fillStyle = color;
  const rays = 14;
  for (let i = 0; i < rays; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, layout.width, (i / rays) * Math.PI * 2, ((i + 0.45) / rays) * Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** The "WINNER" ribbon across the board's header, with a shine passing over it. */
function drawRibbon(x, y, width, color, since) {
  const grow = popIn((since - 150) / 420);
  if (grow <= 0) return;
  const h = 46;
  const half = width / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(grow, grow);
  ctx.rotate(-0.03);
  // Its folded ends, darker, behind.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * (half - 10), -h / 2 + 8);
    ctx.lineTo(side * (half + 26), -h / 2 + 8);
    ctx.lineTo(side * (half + 12), 4);
    ctx.lineTo(side * (half + 26), h / 2 + 8);
    ctx.lineTo(side * (half - 10), h / 2 + 8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.roundRect(-half, -h / 2, width, h, 6);
  inkPath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.stroke();
  // The shine: a bright band sweeping across now and then.
  ctx.save();
  ctx.clip();
  const sweep = ((since - 600) % 1800) / 1800;
  if (since > 600 && sweep < 0.45) {
    const sx = -half - 60 + (width + 120) * (sweep / 0.45);
    const shine = ctx.createLinearGradient(sx - 40, 0, sx + 40, 0);
    shine.addColorStop(0, 'rgba(255, 255, 255, 0)');
    shine.addColorStop(0.5, 'rgba(255, 255, 255, 0.55)');
    shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = shine;
    ctx.fillRect(-half, -h / 2, width, h);
  }
  ctx.restore();
  ctx.font = `800 30px ${FONT}`;
  ctx.fillStyle = '#FFFFFF';
  outlinedText(tr('overlay.pachinko.winner'), 0, 2);
  ctx.restore();
}

/** A big crown that drops onto the winning board and then sways a little. */
function drawWinnerCrown(x, y, since) {
  const land = Math.min(1, since / 520);
  // Falls, then bounces once.
  const bounce = land < 1 ? (1 - land) * (1 - land) * -260 : -Math.abs(Math.sin((since - 520) / 160)) * 14 * Math.max(0, 1 - (since - 520) / 700);
  ctx.save();
  ctx.translate(x, y + bounce);
  ctx.rotate(Math.sin(since / 420) * 0.06);
  ctx.scale(3.2, 3.2);
  drawCrown(0, 0);
  ctx.restore();
}

/** Bright sparks bursting from a point: a jackpot landing. `p` runs from 0 to 1. */
function drawSparks(x, y, p, seed) {
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.fillStyle = '#FFE27A';
  ctx.strokeStyle = '#FFF6CF';
  ctx.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 + hash01(seed + i) * 0.4;
    const reach = 20 + (60 + hash01(seed + i + 50) * 50) * ease(p * 1.4);
    const sx = x + Math.cos(angle) * reach;
    const sy = y + Math.sin(angle) * reach * 0.8;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * reach * 0.6, y + Math.sin(angle) * reach * 0.48);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    circle(sx, sy, 4 * (1 - p) + 1.5);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Confetti for the winner: one piece, `i`, `since` ms after the last ball.
 * The first ones burst from the winning board's lower corners, the rest drift
 * down from the top of the screen.
 */
function confettiPiece(i, since, layout) {
  const r = (n) => hash01(i * 13.7 + n);
  const { gravity, drag } = PARTY;
  let start;
  let x0;
  let y0;
  let vx;
  let vy;
  if (i < PARTY.burst) {
    const left = i % 2 === 0;
    start = r(1) * 280;
    x0 = left ? layout.left + 10 : layout.left + layout.width - 10;
    y0 = layout.top + layout.height - 20;
    vx = (left ? 1 : -1) * (180 + r(2) * 620);
    vy = -(1100 + r(3) * 900);
  } else {
    start = 250 + r(1) * PARTY.rainMs;
    x0 = r(2) * canvas.width;
    y0 = -30;
    vx = (r(3) - 0.5) * 120;
    vy = 60 + r(4) * 120;
  }
  const t = (since - start) / 1000;
  if (t < 0) return null;
  // Air drag slows it towards a gentle top speed: it shoots up, then flutters down.
  const slow = (1 - Math.exp(-drag * t)) / drag;
  const x = x0 + vx * slow + Math.sin(t * (3 + r(5) * 3) + r(6) * 6) * 26 * Math.min(1, t * 2);
  const y = y0 + vy * slow + (gravity / drag) * (t - slow);
  if (y > canvas.height + 30) return null;
  return { x, y, t, spin: t * (4 + r(7) * 8) + r(8) * 6, flip: t * (6 + r(9) * 8), shape: r(10), shade: r(11) };
}

function drawConfetti(layout, color, since) {
  const colors = [color, '#FFD34A', '#FFFFFF', color, '#FF8FC8'];
  const total = PARTY.burst + PARTY.rain;
  for (let i = 0; i < total; i++) {
    const piece = confettiPiece(i, since, layout);
    if (!piece) continue;
    ctx.save();
    ctx.translate(piece.x, piece.y);
    ctx.rotate(piece.spin);
    // Turning over in the air: it narrows and widens.
    ctx.scale(Math.max(0.15, Math.abs(Math.cos(piece.flip))), 1);
    ctx.fillStyle = colors[Math.floor(piece.shade * colors.length)];
    if (piece.shape < 0.7) ctx.fillRect(-8, -4.5, 16, 9);
    else {
      circle(0, 0, 6);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * The players' list in a board's two upper corners, beside the narrow top of
 * the pins: places 1 to 5 on the left, 6 to 10 on the right. It keeps clear
 * of every ball on any path (`inner` from the board's middle) and of the
 * header and its WINNER ribbon (`top`). A falling ball's name only shows
 * below the list (`labelFrom`); while it falls past, the list marks its player.
 */
const PLAYER_LIST = { top: 186, lineHeight: 21, perColumn: 5, inner: 106, outer: 20, moveMs: 350, flashMs: 900 };

/** The lowest point of the players' list, from the board's top: a ball's name shows only below it. */
const LIST_BOTTOM = PLAYER_LIST.top + (PLAYER_LIST.perColumn - 0.5) * PLAYER_LIST.lineHeight + 3;

/** Each player's points from the balls landed by `elapsed`, best first; ties keep the order they first dropped in. */
function playerRanking(board, elapsed) {
  const fall = (pachinko.rows + 1) * pachinko.hopMs;
  const players = new Map();
  board.drops.forEach((drop, order) => {
    const entry = players.get(drop.name) ?? { name: drop.name, emote: drop.emote, color: drop.color, imp: drop.imp === true, points: 0, landed: false, order, lastLanded: -Infinity };
    if (elapsed - drop.at >= fall) {
      entry.points += drop.points;
      entry.landed = true;
      entry.lastLanded = Math.max(entry.lastLanded, drop.at + fall);
    }
    players.set(drop.name, entry);
  });
  return [...players.values()].sort((a, b) => b.points - a.points || a.order - b.order);
}

/** The list of a board's players and their points, sliding into place when the ranking changes. */
function drawPlayerList(layout, board, elapsed) {
  const { top, lineHeight, perColumn, inner, outer, moveMs, flashMs } = PLAYER_LIST;
  const fall = (pachinko.rows + 1) * pachinko.hopMs;
  const ranking = playerRanking(board, elapsed).slice(0, perColumn * 2);
  // The ranking before the latest landing, to slide from.
  const lastLanding = Math.max(-Infinity, ...board.drops.map((d) => d.at + fall).filter((t) => t <= elapsed));
  const moving = elapsed - lastLanding < moveMs;
  const before = moving ? playerRanking(board, lastLanding - 1) : ranking;
  const width = layout.width / 2 - inner - outer;
  const spot = (place) => {
    const left = place < perColumn;
    const x = left ? layout.left + outer : layout.cx + inner;
    return { x, y: layout.top + top + (place % perColumn) * lineHeight };
  };
  const leader = ranking[0] && ranking[0].points > 0 ? ranking[0].name : null;
  // Whose balls are falling right now.
  const falling = new Set(board.drops.filter((d) => elapsed >= d.at && elapsed - d.at < fall).map((d) => d.name));

  // A faint backing for each column, so the list reads over the board.
  for (const left of [true, false]) {
    const count = left ? Math.min(perColumn, ranking.length) : Math.max(0, ranking.length - perColumn);
    if (count === 0) continue;
    const x = left ? layout.left + outer - 8 : layout.cx + inner - 8;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.roundRect(x, layout.top + top - lineHeight / 2 - 3, width + 16, count * lineHeight + 6, 8);
    ctx.fill();
  }

  ctx.save();
  ctx.textBaseline = 'middle';
  ranking.forEach((player, place) => {
    const to = spot(place);
    const fromPlace = before.findIndex((p) => p.name === player.name);
    const from = fromPlace >= 0 ? spot(fromPlace) : to;
    const p = moving ? ease((elapsed - lastLanding) / moveMs) : 1;
    const x = from.x + (to.x - from.x) * p;
    const y = from.y + (to.y - from.y) * p;
    const flash = Math.max(0, 1 - (elapsed - player.lastLanded) / flashMs);
    const top1 = player.name === leader;

    const dropping = falling.has(player.name);
    // The player's emote, as on their ball; a pulsing white ring while their ball is falling.
    drawEmoteDisc(player.emote, x + 8, y, 8, board.color, player.color || board.color, player.imp ? player.name : null);
    if (dropping) {
      circle(x + 8, y, 10.5 + Math.sin(elapsed / 90));
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }

    ctx.font = `${top1 || dropping ? 800 : 600} 14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = dropping ? '#FFFFFF' : top1 ? '#FFD34A' : 'rgba(255, 255, 255, 0.88)';
    let name = player.name;
    const room = width - 22 - 40;
    if (textWidth(name) > room) {
      while (name.length > 1 && textWidth(`${name}…`) > room) name = name.slice(0, -1);
      name = `${name}…`;
    }
    ctx.fillText(name, x + 22, y);

    ctx.font = `800 15px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = flash > 0 ? `rgba(255, ${Math.round(255 - 44 * flash)}, ${Math.round(255 - 181 * flash)}, 1)` : top1 ? '#FFD34A' : '#FFFFFF';
    ctx.save();
    if (flash > 0) {
      const grow = 1 + 0.35 * flash;
      ctx.translate(x + width, y);
      ctx.scale(grow, grow);
      ctx.translate(-(x + width), -y);
    }
    ctx.fillText(player.landed ? String(player.points) : '–', x + width, y);
    ctx.restore();
  });
  ctx.restore();
  ctx.textAlign = 'center';
}

/** How tall the boards are drawn, the winner's crown and lights included: what has to fit beside the map banner. */
const PACHINKO_HEIGHT = 1000;

/**
 * All boards: pins, slots, falling balls, scores, and the winner's
 * celebration at the end. With the map banner on, the boards shrink a little
 * to fit the rest of the screen, and the banner is drawn over everything.
 */
function drawPachinko(elapsed) {
  const banner = pachinko.banner;
  const areaTop = banner && banner.place === 'top' ? banner.height : 0;
  const fit = Math.min(1, (canvas.height - (banner ? banner.height : 0)) / PACHINKO_HEIGHT);
  ctx.save();
  ctx.translate(canvas.width / 2, areaTop);
  ctx.scale(fit, fit);
  ctx.translate(-canvas.width / 2, 0);
  const losers = drawBoards(elapsed);
  ctx.restore();
  // The other boards step back into the shade once the winner is known: over
  // everything on them, their texts too (a theme's texts are on a layer above).
  if (losers.length > 0) {
    const shade = 0.5 * ease((elapsed - pachinko.durationMs) / PARTY.dimMs);
    const onScreen = (x, y) => [canvas.width / 2 + (x - canvas.width / 2) * fit, areaTop + y * fit];
    drawOnTop(() => {
      ctx.save();
      ctx.globalAlpha = shade;
      ctx.fillStyle = '#05070B';
      for (const layout of losers) {
        const [x, y] = onScreen(layout.left, layout.top);
        ctx.beginPath();
        ctx.roundRect(x, y, layout.width * fit, layout.height * fit, PANEL.radius * fit);
        ctx.fill();
      }
      ctx.restore();
    });
  }
  if (banner) drawOnTop(() => drawMapBanner(banner));
}

/** Draws the boards; returns the layouts of the boards that lost, once the game is over. */
function drawBoards(elapsed) {
  const count = pachinko.boards.length;
  const best = Math.max(...pachinko.slots);
  const finished = elapsed >= pachinko.durationMs;
  const since = elapsed - pachinko.durationMs;
  const fall = (pachinko.rows + 1) * pachinko.hopMs;
  let winnerLayout = null;
  let winnerColor = null;
  const losers = [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  pachinko.boards.forEach((board, index) => {
    const layout = pachinkoLayout(index, count);
    const winner = finished && board.team === pachinko.winner;
    ctx.save();
    if (winner) {
      winnerLayout = layout;
      winnerColor = board.color;
      // The winning board pops forward, glowing in its guild's color.
      const grow = 1 + 0.045 * popIn(since / PARTY.popMs) + 0.006 * Math.sin(since / 300);
      const cy = layout.top + layout.height / 2;
      ctx.translate(layout.cx, cy);
      ctx.scale(grow, grow);
      ctx.translate(-layout.cx, -cy);
      ctx.save();
      ctx.shadowColor = board.color;
      ctx.shadowBlur = 40 + 18 * Math.sin(since / 260);
      ctx.fillStyle = board.color;
      ctx.beginPath();
      ctx.roundRect(layout.left, layout.top, layout.width, layout.height, PANEL.radius);
      ctx.fill();
      ctx.restore();
    }
    drawBox(layout.left, layout.top, layout.width, layout.height, { strong: true, accent: board.color });
    if (winner) {
      drawMarquee(layout, board.color, since);
      drawRays(layout.cx, layout.top + 100, layout, board.color, since);
    }

    // Header: the guild and its points so far.
    const landed = board.drops.filter((d) => elapsed - d.at >= fall);
    const score = pachinkoScore(board, elapsed);
    ctx.font = `800 40px ${FONT}`;
    ctx.fillStyle = board.color;
    ctx.fillText(board.name, layout.cx, layout.top + 44, layout.width - 30);
    ctx.save();
    ctx.translate(layout.cx, layout.top + 100);
    if (winner) {
      const pulse = 1 + 0.08 * Math.max(0, Math.sin(since / 190));
      ctx.scale(pulse, pulse);
    }
    ctx.font = `800 54px ${FONT}`;
    ctx.fillStyle = winner ? '#FFE680' : '#FFFFFF';
    ctx.fillText(String(score), 0, 0);
    ctx.restore();
    drawPlayerList(layout, board, elapsed);
    const dropping = [...board.drops].reverse().find((d) => elapsed >= d.at);
    if (dropping && !finished) {
      ctx.font = `600 18px ${FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(dropping.name, layout.cx, layout.top + 140);
    }

    // Pins: one lights up as a ball hits it, in a glow that fades.
    const hits = pinHits(board, elapsed);
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c <= r; c++) {
        const pin = pinAt(layout, r, c);
        const since = elapsed - (hits.get(`${r},${c}`) ?? -Infinity);
        const glow = since < PIN_GLOW_MS ? 1 - since / PIN_GLOW_MS : 0;
        if (glow > 0) {
          circle(pin.x, pin.y, PIN_RADIUS * (1.6 + 1.6 * glow));
          ctx.fillStyle = `rgba(255, 226, 122, ${0.45 * glow})`;
          ctx.fill();
        }
        circle(pin.x, pin.y, PIN_RADIUS * (1 + 0.35 * glow));
        ctx.fillStyle = glow > 0 ? `rgb(255, ${Math.round(222 + 24 * (1 - glow))}, ${Math.round(140 + 90 * (1 - glow))})` : '#D9DEE6';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#2A2E36';
        ctx.stroke();
      }
    }

    // Slots, with their points; the best ones in gold.
    pachinko.slots.forEach((value, slot) => {
      const x = layout.cx + (slot - layout.rows / 2) * layout.spacing;
      const w = layout.spacing - 6;
      const lit = landed.some((d) => d.slot === slot && elapsed - d.at - fall < 500);
      ctx.fillStyle = lit ? 'rgba(255, 240, 160, 0.5)' : value === best ? 'rgba(255, 200, 60, 0.22)' : 'rgba(255, 255, 255, 0.07)';
      ctx.fillRect(x - w / 2, layout.slotTop, w, 92);
      ctx.fillStyle = '#2A2E36';
      ctx.fillRect(x - layout.spacing / 2 - 2, layout.slotTop - 6, 4, 98);
      ctx.font = `800 ${value >= 100 ? 20 : 22}px ${FONT}`;
      ctx.fillStyle = value === best ? '#FFD34A' : '#FFFFFF';
      ctx.fillText(String(value), x, layout.slotTop + 112);
    });

    // Balls: landed ones rest in their slots, the others fall. The winner's dance in a wave.
    for (const drop of board.drops) {
      const t = elapsed - drop.at;
      if (t < 0) continue;
      const ball = ballAt(layout, drop, t);
      if (ball.landed) {
        let hop = 0;
        if (winner) {
          const wave = since / 1000 * Math.PI * 2 * 1.3 - drop.slot * 0.7 - drop.stack * 0.35;
          hop = Math.max(0, Math.sin(wave)) * 16 * ease(since / 400);
        }
        ctx.save();
        ctx.translate(ball.x, ball.y - hop);
        ctx.scale(0.8, 0.8);
        drawBall(0, 0, drop, board.color);
        ctx.restore();
      } else {
        // A short trail behind a falling ball, in its guild's color.
        for (let k = TRAIL.length; k >= 1; k--) {
          const back = t - k * TRAIL.stepMs;
          if (back < 0) continue;
          const ghost = ballAt(layout, drop, back);
          circle(ghost.x, ghost.y, BALL_RADIUS * (1 - k * 0.13));
          ctx.fillStyle = board.color;
          ctx.globalAlpha = TRAIL.alpha * (1 - k / (TRAIL.length + 1));
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        drawBall(ball.x, ball.y, drop, board.color);
      }
      // The ball's name, once it is below the players' list (the list marks it until then).
      const labelY = ball.y - BALL_RADIUS - 10;
      const clear = (labelY - 8 - (layout.top + LIST_BOTTOM)) / 30;
      if (!ball.landed && t < fall && clear > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, clear);
        ctx.font = `600 13px ${FONT}`;
        ctx.fillStyle = '#FFFFFF';
        outlinedText(drop.name, ball.x, labelY, 140);
        ctx.restore();
      }
      // Points rise from the slot as the ball lands; a jackpot bursts into sparks.
      const after = t - fall;
      if (after >= 0 && after < 1200) {
        const p = after / 1200;
        if (drop.points === best && after < 800) drawSparks(ball.x, layout.slotTop + 40, after / 800, drop.at + index * 7);
        ctx.save();
        ctx.globalAlpha = 1 - p;
        ctx.font = `800 ${drop.points === best ? 40 : 28}px ${FONT}`;
        ctx.fillStyle = drop.points === best ? '#FFD34A' : '#FFFFFF';
        const label = drop.points === best ? tr('overlay.pachinko.jackpot', { points: drop.points }) : `+${drop.points}`;
        // Kept on the board above an edge slot.
        const half = textWidth(label) / 2 + 12;
        const labelX = Math.min(layout.left + layout.width - half, Math.max(layout.left + half, ball.x));
        outlinedText(label, labelX, layout.slotTop - 20 - 50 * p);
        ctx.restore();
      }
    }

    // A jackpot sends up a firework from its slot, bursting over the pins.
    for (const drop of board.drops) {
      const after = elapsed - drop.at - fall;
      if (drop.points !== best || after < 0 || after >= FIREWORK.climbMs + FIREWORK.burstMs) continue;
      const x = layout.cx + (drop.slot - layout.rows / 2) * layout.spacing;
      // It climbs a little toward the middle, so an edge slot's firework bursts over the pins, clear of the players' list.
      const toX = x + (layout.cx - x) * 0.45;
      const toY = layout.startY + 50 + layout.rows * layout.rowHeight * (0.32 + 0.12 * hash01(drop.at));
      drawFirework(x, toX, layout.slotTop, toY, after, board.color, drop.at + index * 13);
    }

    // Where the name of the dropping chatter was, above the players' list.
    if (winner) drawRibbon(layout.cx, layout.top + 138, Math.min(layout.width - 80, 300), board.color, since);
    ctx.restore();

    if (finished && !winner) losers.push(layout);
  });

  if (winnerLayout) {
    // Above the board, clear of the guild's name.
    drawWinnerCrown(winnerLayout.cx, winnerLayout.top - 30, since);
    drawConfetti(winnerLayout, winnerColor, since);
  }
  return losers;
}

// --- Obstacles ----------------------------------------------------------------

/** Kinds as the server numbers them (see src/game/obstacles.ts). */
const OBSTACLE = { wall: 0, bumper: 1, barrel: 2, trap: 3 };

/** Walls, bumpers, barrels and traps, under the fighters. Barrels move smoothly between frames. */
function drawObstacles(previous, latest, blend, now) {
  if (!latest.o) return;
  const before = new Map((previous.o || []).map((o) => [o[0], o]));
  const s = battle.scale;
  for (const o of latest.o) {
    const [id, kind, x2, y2, a, b, state, life] = o;
    const old = before.get(id);
    const x = (old ? old[2] + (x2 - old[2]) * blend : x2) * s;
    const y = (old ? old[3] + (y2 - old[3]) * blend : y2) * s;
    ctx.save();
    ctx.globalAlpha *= life / 100;
    if (kind === OBSTACLE.wall && state === 1) {
      if (!battle.broken.has(id)) battle.broken.set(id, now);
      drawRubble(x, y, a * s, b * s, id, now - battle.broken.get(id));
    } else if (kind === OBSTACLE.wall) drawWall(x, y, a * s, b * s, id);
    else if (kind === OBSTACLE.bumper) drawBumper(x, y, a * s, state === 1, now);
    else if (kind === OBSTACLE.barrel) drawBarrel(x, y, a * s, (old ? old[5] + (b - old[5]) * blend : b) / 100, state === 1, now, id);
    else if (kind === OBSTACLE.trap) drawTrap(x, y, a * s, state, now);
    ctx.restore();
  }
}

/** A stone wall seen from above: a slab of bricks with a lit top edge and a shadow. */
function drawWall(x, y, w, h, id) {
  const left = x - w / 2;
  const top = y - h / 2;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(left + 5, top + 7, w, h);
  ctx.beginPath();
  ctx.rect(left, top, w, h);
  inkPath();
  ctx.fillStyle = '#77706A';
  ctx.fill();
  // Bricks in rows along the wall, every other row shifted by half a brick.
  ctx.save();
  ctx.clip();
  const across = w >= h;
  const thick = across ? h : w;
  const length = across ? w : h;
  const rows = 2;
  const brick = thick * 1.1;
  ctx.strokeStyle = 'rgba(40, 34, 30, 0.7)';
  ctx.lineWidth = 2;
  for (let row = 0; row < rows; row++) {
    const r0 = (row * thick) / rows;
    for (let at = row % 2 === 0 ? 0 : -brick / 2; at < length; at += brick) {
      ctx.fillStyle = hash01(id * 31 + row * 7 + at) < 0.5 ? '#857D76' : '#6C655F';
      if (across) {
        ctx.fillRect(left + at + 1, top + r0 + 1, brick - 2, thick / rows - 2);
      } else {
        ctx.fillRect(left + r0 + 1, top + at + 1, thick / rows - 2, brick - 2);
      }
    }
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  if (across) ctx.fillRect(left, top, w, 3);
  else ctx.fillRect(left, top, 3, h);
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#2A2420';
  ctx.strokeRect(left, top, w, h);
}

/** A wall the god broke through: its bricks fly apart in a puff of dust, `ms` after it broke. */
function drawRubble(x, y, w, h, id, ms) {
  const p = Math.min(1, ms / 450);
  const across = w >= h;
  const length = across ? w : h;
  const thick = across ? h : w;
  // Dust.
  ctx.save();
  ctx.globalAlpha *= 0.45 * (1 - p);
  ctx.fillStyle = '#B8AEA4';
  for (let i = 0; i < 5; i++) {
    const at = (i / 4 - 0.5) * length;
    circle(x + (across ? at : 0), y + (across ? 0 : at), thick * (0.8 + 1.6 * p));
    ctx.fill();
  }
  ctx.restore();
  // Bricks, thrown out to both sides and turning.
  const pieces = Math.max(6, Math.round(length / (thick * 1.1)));
  ctx.save();
  ctx.globalAlpha *= 1 - p * p;
  for (let i = 0; i < pieces; i++) {
    const along = ((i + 0.5) / pieces - 0.5) * length;
    const side = hash01(id * 13 + i) < 0.5 ? -1 : 1;
    const fly = thick * (0.6 + 2.4 * hash01(id * 7 + i * 3)) * p;
    const spread = (hash01(id + i * 11) - 0.5) * thick * 2 * p;
    const px = x + (across ? along + spread : side * fly);
    const py = y + (across ? side * fly : along + spread);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate((hash01(id * 3 + i) - 0.5) * 6 * p);
    ctx.fillStyle = hash01(id * 31 + i) < 0.5 ? '#857D76' : '#6C655F';
    ctx.fillRect(-thick * 0.45, -thick * 0.3, thick * 0.9, thick * 0.6);
    ctx.strokeStyle = '#2A2420';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-thick * 0.45, -thick * 0.3, thick * 0.9, thick * 0.6);
    ctx.restore();
  }
  ctx.restore();
}

/** A pinball bumper: rings of red and white around a lit cap. It flashes when it flings someone. */
function drawBumper(x, y, r, lit, now) {
  circle(x + 4, y + 6, r);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fill();
  circle(x, y, r);
  inkPath();
  ctx.fillStyle = lit ? '#FFF6C8' : '#C7322B';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.strokeStyle = '#2A1414';
  ctx.stroke();
  circle(x, y, r * 0.72);
  ctx.fillStyle = '#F4EEE6';
  ctx.fill();
  const cap = ctx.createRadialGradient(x - r * 0.18, y - r * 0.2, r * 0.05, x, y, r * 0.5);
  cap.addColorStop(0, '#FFFFFF');
  cap.addColorStop(1, lit ? '#FFD84A' : '#E0473F');
  circle(x, y, r * 0.5);
  ctx.fillStyle = cap;
  ctx.fill();
  if (lit) {
    circle(x, y, r * (1.25 + 0.15 * Math.sin(now / 30)));
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 230, 120, 0.85)';
    ctx.stroke();
  }
}

/** A barrel rolling across: wooden staves and two iron hoops that turn as it rolls. Broken, it is a few flying staves. */
function drawBarrel(x, y, r, rolled, broken, now, id) {
  if (broken) {
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + id;
      const fly = r * 0.9;
      ctx.save();
      ctx.translate(x + Math.cos(angle) * fly, y + Math.sin(angle) * fly);
      ctx.rotate(angle + i);
      ctx.fillStyle = '#8A5A2E';
      ctx.fillRect(-r * 0.4, -r * 0.1, r * 0.8, r * 0.2);
      ctx.restore();
    }
    return;
  }
  circle(x + 3, y + 5, r);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fill();
  circle(x, y, r);
  inkPath();
  ctx.fillStyle = '#9A6634';
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(rolled);
  // Staves, then the two hoops across them.
  ctx.strokeStyle = 'rgba(60, 34, 14, 0.7)';
  ctx.lineWidth = 2;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * r * 0.4, -r);
    ctx.lineTo(i * r * 0.4, r);
    ctx.stroke();
  }
  ctx.fillStyle = '#4C4A48';
  ctx.fillRect(-r, -r * 0.55, r * 2, r * 0.18);
  ctx.fillRect(-r, r * 0.37, r * 2, r * 0.18);
  ctx.restore();
  circle(x, y, r);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#3A2410';
  ctx.stroke();
}

/** A spike trap: an iron grate in the ground. Before it strikes its rim glows red; then the spikes shoot up. */
function drawTrap(x, y, r, state, now) {
  circle(x, y, r);
  inkPath();
  ctx.fillStyle = '#3A3634';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = state === 1 ? `rgba(255, 70, 50, ${0.6 + 0.4 * Math.sin(now / 50)})` : '#1C1A19';
  ctx.stroke();
  // Holes, or spikes.
  const holes = [[0, 0], [-0.45, -0.3], [0.45, -0.3], [-0.45, 0.35], [0.45, 0.35], [0, -0.62], [0, 0.62]];
  for (const [hx, hy] of holes) {
    const px = x + hx * r;
    const py = y + hy * r;
    if (state === 2) {
      const tall = r * 0.42;
      ctx.beginPath();
      ctx.moveTo(px - r * 0.12, py + r * 0.08);
      ctx.lineTo(px, py - tall);
      ctx.lineTo(px + r * 0.12, py + r * 0.08);
      ctx.closePath();
      ctx.fillStyle = '#E4E6EA';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#4A4D55';
      ctx.stroke();
    } else {
      circle(px, py, r * 0.09);
      ctx.fillStyle = state === 1 ? '#8A2A20' : '#121110';
      ctx.fill();
    }
  }
}

/** How a battle comes in: obstacles fade in, fighters pop up spread over `popMs`, each in `growMs`, the scoreboard drops in; at the end the battlefield fades over `leaveMs`. */
const BATTLE_IN = { obstaclesMs: 450, popMs: 500, growMs: 260, hudMs: 600, leaveMs: 450 };

/** How big a fighter is drawn as the battle comes in: 0 not yet there, overshooting a little, then 1. */
function fighterPopIn(shown, index) {
  if (shown >= BATTLE_IN.popMs + BATTLE_IN.growMs) return 1;
  const start = hash01(index * 7.3 + 1) * BATTLE_IN.popMs;
  return shown <= start ? 0 : easeOutBack((shown - start) / BATTLE_IN.growMs);
}

// --- Big hits ----------------------------------------------------------------------

/**
 * Damage numbers over big hits (the battle reports a hit of `config.battle.bigHit`
 * or more): at most `perFrame` from one frame, the killing blows and the
 * biggest first, and `max` on screen. Each pops up, rises and fades over `lifeMs`.
 */
const NUMBERS = { perFrame: 4, max: 12, lifeMs: 950, rise: 54, maxKnockouts: 4, knockoutMs: 700 };
/** Causes that are the god's skills: their numbers glow orange. */
const SKILL_CAUSES = new Set(['rampage', 'shockwave', 'leap', 'smite', 'fire']);

function noteBigHits(events, now) {
  const hits = events.filter((e) => e.k === 'hit').sort((a, b) => (b.l || 0) - (a.l || 0) || b.v - a.v);
  for (const hit of hits.slice(0, NUMBERS.perFrame)) {
    battle.numbers.push({ x: hit.x, y: hit.y, v: hit.v, l: hit.l === 1, c: hit.c, start: now, seed: hit.i * 13 + hit.v });
  }
  if (battle.numbers.length > NUMBERS.max) battle.numbers.splice(0, battle.numbers.length - NUMBERS.max);
}

function drawBigHits(now) {
  const s = battle.scale;
  battle.knockouts = battle.knockouts.filter((k) => now - k.start < NUMBERS.knockoutMs);
  for (const k of battle.knockouts) {
    ctx.save();
    Theme.current.art.knockout(ctx, k.x * s, k.y * s, now - k.start, k.seed, { px: Theme.current.pixelScale, life: NUMBERS.knockoutMs });
    ctx.restore();
  }
  battle.numbers = battle.numbers.filter((n) => now - n.start < NUMBERS.lifeMs);
  for (const n of battle.numbers) {
    const age = now - n.start;
    const p = age / NUMBERS.lifeMs;
    // Up and a little to one side, so numbers from one blow fan out.
    const drift = (hash01(n.seed) - 0.5) * 40 * p;
    const x = n.x * s + drift;
    const y = n.y * s - 30 - NUMBERS.rise * (1 - (1 - p) * (1 - p));
    const color = n.l ? '#FF5A4E' : SKILL_CAUSES.has(n.c) ? '#FFB13B' : '#FFFFFF';
    ctx.save();
    ctx.globalAlpha *= Math.min(1, (1 - p) / 0.3);
    if (Theme.current.art.damageNumber) {
      Theme.current.art.damageNumber(ctx, x, y, n.v, { age, life: NUMBERS.lifeMs, lethal: n.l, skill: SKILL_CAUSES.has(n.c), color, seed: n.seed, px: Theme.current.pixelScale });
    } else {
      const pop = easeOutBack(age / 180);
      const size = Math.round((30 + Math.min(22, (n.v - 20) * 0.5)) * (n.l ? 1.2 : 1));
      ctx.translate(x, y);
      ctx.scale(pop, pop);
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineJoin = 'round';
      ctx.strokeText(String(n.v), 0, 0);
      ctx.fillText(String(n.v), 0, 0);
    }
    ctx.restore();
  }
}

/** The squash of a fighter that moved `dx`, `dy` pixels in `ms` milliseconds; null when it barely moves. */
function squashFor(dx, dy, ms) {
  const speed = (Math.hypot(dx, dy) * 1000) / ms;
  if (speed < 1) return null;
  return { angle: Math.atan2(dy, dx), stretch: 1 + Math.min(SQUASH.max, speed * SQUASH.perSpeed) };
}

function renderBattle(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // The corner panels slide away while the battle comes in.
  noteCorner(false);
  if (cornerOut() < 1) drawCorner(cornerOut());
  const latest = battle.latest;
  if (!latest) return;
  // Coming in: fighters pop up one after another. Going: the battlefield fades as the result ends.
  const shown = performance.now() - battle.shownAt;
  const leaving = battle.end ? Math.min(1, Math.max(0, (performance.now() - battle.end.shownAt - battle.end.holdMs + BATTLE_IN.leaveMs) / BATTLE_IN.leaveMs)) : 0;

  // Move smoothly from the previous frame to the latest one.
  const previous = battle.previous || latest;
  const interval = Math.max(1, latest.receivedAt - previous.receivedAt);
  const blend = battle.previous ? Math.min(1, (now - latest.receivedAt) / interval) : 1;

  const drawn = battle.fighters.map((fighter, i) => {
    const [x1, y1, healthBefore, flagsBefore] = previous.f[i];
    const [x2, y2, health, flags] = latest.f[i];
    // A fighter that just appeared (a summoned minion) does not slide in from where it waited,
    // and the god does not slide across the screen when it blinks or crosses the edge.
    const jumped = flags & FLAG.jumped && !(flagsBefore & FLAG.jumped);
    const mix = (healthBefore === 0 && health > 0) || jumped ? 1 : blend;
    return {
      fighter,
      index: i,
      x: (x1 + (x2 - x1) * mix) * battle.scale,
      y: (y1 + (y2 - y1) * mix) * battle.scale,
      fromX: x1 * battle.scale,
      fromY: y1 * battle.scale,
      // Thrown through the air: squashed along the flight, by how fast it goes between the two frames.
      squash: flags & FLAG.flying && !jumped ? squashFor((x2 - x1) * battle.scale, (y2 - y1) * battle.scale, interval) : null,
      r: fighter.radius * battle.scale,
      health,
      flags,
    };
  });
  const at = [];
  for (const d of drawn) at[d.index] = d;

  // After a heavy blow the whole battlefield shakes, fading out; the scoreboard stays still.
  ctx.save();
  const view = battle.view;
  if (view.banner) {
    // The battle keeps to its own strip of the screen; the map banner has the rest.
    ctx.beginPath();
    ctx.rect(0, view.top, canvas.width, view.height);
    ctx.clip();
    ctx.translate(0, view.top);
  }
  const shake = battle.shake;
  if (shake && now - shake.start < shake.ms) {
    const strength = shake.power * (1 - (now - shake.start) / shake.ms);
    ctx.translate(Math.sin(now / 13) * strength, Math.cos(now / 17) * strength);
  }
  drawGroundEffects(now, at);
  ctx.save();
  ctx.globalAlpha = Math.min(1, shown / BATTLE_IN.obstaclesMs) * (1 - leaving);
  drawObstacles(previous, latest, blend, now);
  ctx.restore();
  // Lower fighters are drawn last so names overlap in a natural order.
  drawn.sort((a, b) => a.y - b.y);

  for (const d of drawn) {
    if (d.health > 0) continue;
    const since = now - battle.diedAt[d.index];
    if (battle.diedAt[d.index] && since < DEATH_FADE_MS) {
      drawFighter(d.fighter, d.x, d.y, 0, 0, 0.6 * (1 - since / DEATH_FADE_MS));
    }
  }
  for (const d of drawn) {
    if (d.health <= 0) continue;
    if (d.flags & FLAG.flying) {
      // A fighter hurled through the air drags a streak behind it.
      const dx = d.x - d.fromX;
      const dy = d.y - d.fromY;
      ctx.lineCap = 'round';
      ctx.lineWidth = d.r * 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.beginPath();
      ctx.moveTo(d.x - dx * 2.2, d.y - dy * 2.2);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
    if (d.flags & FLAG.hidden) {
      // A thief in the shadows: a dark haze where it moves, and the fighter itself barely visible.
      const haze = ctx.createRadialGradient(d.x, d.y, d.r * 0.3, d.x, d.y, d.r * 1.9);
      haze.addColorStop(0, 'rgba(10, 8, 20, 0.55)');
      haze.addColorStop(1, 'rgba(10, 8, 20, 0)');
      circle(d.x, d.y, d.r * 1.9);
      ctx.fillStyle = haze;
      ctx.fill();
    }
    const pop = fighterPopIn(shown, d.index);
    if (pop <= 0) continue;
    if (pop < 1) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.scale(pop, pop);
      ctx.translate(-d.x, -d.y);
    }
    drawFighter(d.fighter, d.x, d.y, d.health, d.flags, (d.flags & FLAG.hidden ? 0.3 : 1) * (1 - leaving), d.squash);
    if (pop < 1) ctx.restore();
    // The god running across the screen's edge shows on both sides while it crosses.
    if (d.x - d.r < 0) drawFighter(d.fighter, d.x + canvas.width, d.y, d.health, d.flags, 1);
    else if (d.x + d.r > canvas.width) drawFighter(d.fighter, d.x - canvas.width, d.y, d.health, d.flags, 1);
  }
  drawTopEffects(now, at);
  drawBigHits(performance.now());
  ctx.restore();

  // The highlights keep left of the scoreboard; without one (the endless mode), in the corner.
  drawOnTop(() => {
    ctx.save();
    ctx.translate(0, view.top);
    const right = battle.ambient ? 24 + 560 : hudLeft() - 24;
    drawFeed(now, 24, 24, right - 24);
    ctx.restore();
  });
  if (!battle.ambient) {
    if (battle.place && now - battle.startedAt < ARENA_INTRO.ms) {
      drawOnTop(() => {
        ctx.save();
        ctx.translate(0, view.top);
        drawArenaIntro(now - battle.startedAt, view.height);
        ctx.restore();
      });
    }
    drawOnTop(() => {
      ctx.save();
      // The scoreboard drops in from above, and rises away as the battle goes.
      const drop = (1 - easeOutBack(shown / BATTLE_IN.hudMs)) + easeInCubic(leaving);
      ctx.translate(0, view.top - drop * 160);
      drawBattleHud(latest);
      ctx.restore();
      if (battle.end) {
        // In the middle of the arena, not of the screen.
        ctx.save();
        ctx.globalAlpha = 1 - leaving;
        ctx.translate(0, view.top + (view.height - canvas.height) / 2);
        drawBattleResult();
        ctx.restore();
      }
    });
  }
  // Last of all, so nothing in the battle is ever drawn over it.
  if (view.banner) drawOnTop(() => drawMapBanner(view.banner));
}

// --- Map banner: the state of the map during a battle -----------------------------

/** The map banner's strip as the server sends it outside a battle (a height on an arena of a given width), in pixels. */
function bannerOnScreen(banner) {
  return banner ? { place: banner.place, height: (banner.height * canvas.width) / banner.width } : null;
}

/**
 * A strip across the top or the bottom of the screen: the map, and each
 * guild's land and Monument. `banner` is its place and height in pixels,
 * during a battle or Pachinko.
 */
function drawMapBanner(banner) {
  if (!state) return;
  const { place, height } = banner;
  const top = place === 'top' ? 0 : canvas.height - height;
  drawBox(0, top, canvas.width, height, { radius: 0, strong: true });

  // The map, as small as fits the strip: five rows of hexagons are eight radii tall.
  const size = (height - 14) / 8;
  const mapWidth = Math.sqrt(3) * size * 5;
  const mapX = 28 + mapWidth / 2;
  drawMiniMap(mapX, top + height / 2, size);

  const left = 28 + mapWidth + 36;
  const blockWidth = (canvas.width - left - 12) / state.guilds.length;
  state.guilds.forEach((guild, index) => drawBannerGuild(guild, index, left + index * blockWidth, top, blockWidth - 36, height));
}

function drawMiniMap(cx, cy, size) {
  const guildColors = Object.fromEntries(state.guilds.map((g) => [g.id, g.color]));
  const now = performance.now();
  for (const tile of state.tiles) {
    const x = cx + size * Math.sqrt(3) * (tile.q + tile.r / 2);
    const y = cy + size * 1.5 * tile.r;
    hexPath(x, y, size - 1);
    inkPath();
    ctx.fillStyle = tile.owner ? guildColors[tile.owner] : Theme.current.palette.neutralTile;
    ctx.globalAlpha = tile.owner && !tile.isCity ? 0.8 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = tile.isCity ? 2 : 1;
    ctx.strokeStyle = tile.isCity ? '#FFFFFF' : 'rgba(255, 255, 255, 0.28)';
    ctx.stroke();
    if (tile.isCity) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(size / 32, size / 32);
      drawCastle(0, 0);
      ctx.restore();
    }
    drawTileMark(tile, x, y, size - 1);
    if (tile.burning) drawTileFlames(x, y, size - 1, now, tile.q * 7 + tile.r * 3);
    if (isGodTile(tile)) drawGodTile(tile, x, y, size - 1, Math.round(size * 0.75));
    drawTileLevel(tile, x, y, Math.round(size * 0.95));
  }
}

/** One guild in the map banner: its Monument, name, tiles, land level and the Monument's progress. */
function drawBannerGuild(guild, index, x, top, width, height) {
  const monument = guild.monument;
  const share = Math.min(1, shownProgress(guild) / monument.goal);
  const column = 78;
  drawMonument(monumentDesign(guild, index), share, x + column * 0.42, top + height - 14, height - 34, guild.color);
  // Inside the banner: it rises over the Monument but stays within the strip.
  drawMonumentPops(guild.id, guild.color, x + column * 0.42, top + height * 0.5, height * 0.3, 22, x + column * 0.66, top + height * 0.62);

  const tx = x + column;
  const tw = width - column;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = guild.color;
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText(guild.name, tx, top + height * 0.27, tw * 0.5);
  const nameWidth = Math.min(textWidth(guild.name), tw * 0.5);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.font = `400 18px ${FONT}`;
  ctx.fillText(tr('overlay.guild.tiles', { count: guild.tiles }), tx + tw, top + height * 0.27, tw - nameWidth - 16);

  ctx.textAlign = 'left';
  ctx.font = `400 17px ${FONT}`;
  ctx.fillText(tr('overlay.guild.monument', { income: guild.monument.income }), tx, top + height * 0.56, tw - 64);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(`${Math.floor(share * 100)}%`, tx + tw, top + height * 0.56);
  const barY = top + height * 0.74;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(tx, barY, tw, 11);
  ctx.fillStyle = guild.color;
  ctx.fillRect(tx, barY, tw * share, 11);
}

// A new language redraws what shows now; a running battle redraws on its own every frame.
I18n.onChange(() => {
  if (!battle) drawPanel();
});

// Texts come from the language files: connect once the first one is loaded, so nothing shows a bare key.
I18n.ready.then(connect);
