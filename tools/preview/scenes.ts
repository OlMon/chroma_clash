// Preview scenes: still pages of the real overlay, fed by the real game code.
//
// Each scene is a self-contained html page that loads overlay/overlay.js, with
// a stand-in for the server connection that replays recorded messages: a state,
// an announcement, or a deterministic, seeded battle cut down to a dozen frames
// around an interesting moment. The overlay's own animation loop is off; the
// page draws once, at the moment named by `?at=<ms>`, and then sets its title
// to "ready". `?theme=<id>` pins a theme, as in OBS.
//
// Run alone to only write the pages: node tools/preview/scenes.ts [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../src/config.ts';
import { Battle, assignClasses, godHealth, radiusFor, type BattleEvent, type BattleSetup, type FighterSpec } from '../../src/game/battle.ts';
import { assignGuild } from '../../src/game/guilds.ts';
import { mapTiles, tileId } from '../../src/game/hex.ts';
import { fertility, startingLand } from '../../src/game/land.ts';
import { ARENAS, type FrameObstacle } from '../../src/game/obstacles.ts';
import { playPachinko } from '../../src/game/pachinko.ts';
import { SimulatedChat } from '../../src/sim/chat.ts';
import { createRng } from '../../src/util/rng.ts';
import { guildName, text } from '../../src/i18n.ts';
import { recapMessage } from '../../src/server/recap.ts';
import { BrawlRunner } from '../../src/server/brawl-runner.ts';
import type { BrawlWho } from '../../src/game/brawl.ts';

export interface Scene {
  name: string;
  /** The moments to render, in ms after the scene's effects began (`?at=`). */
  moments: number[];
}

interface PageOptions {
  /** Messages the stand-in server sends, in order, 400 ms after load. */
  messages: unknown[];
  moments: number[];
  /** JavaScript run before every draw, for what no message can set up (it sees the overlay's globals). */
  tweak?: string;
}

/** Twitch emotes go through the preview server, as through the game's server. */
const twitch = (id: string | null) => (id ? { url: `/emotes/twitch/${id}`, animatedUrl: null } : null);
type Emote = ReturnType<typeof twitch>;

// --- The page --------------------------------------------------------------------

function pageHtml({ messages, tweak = '' }: PageOptions): string {
  // `</` inside the JSON would end the script tag.
  const replay = JSON.stringify(messages).replace(/<\//g, '<\\/');
  return `<!doctype html><html><head><meta charset="utf-8"><base href="/overlay/">
<style>html,body{margin:0;background:transparent;overflow:hidden}canvas{display:block;width:100vw}
#preview-status{position:absolute;z-index:9;left:0;right:0;top:0;padding:16px;font:bold 28px sans-serif;color:#fff;background:#B00020;white-space:pre-wrap}</style></head>
<body><canvas id="stage" width="1920" height="1080"></canvas>
<div id="preview-status">preview: not ready (the page did not finish in time)</div>
<script>
// Errors show up in the picture, not only in a console nobody reads.
window.addEventListener('error', (e) => {
  const box = document.getElementById('preview-status');
  box.style.display = '';
  box.textContent = (box.dataset.errors ? box.textContent + '\\n' : 'preview error: ') + (e.message || e.type) + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '');
  box.dataset.errors = '1';
}, true);
window.REPLAY = ${replay};
window.WebSocket = class {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 1;
  constructor() { setTimeout(() => { for (const m of window.REPLAY) this.onmessage({ data: JSON.stringify(m) }); }, 400); }
  send() {}
  close() {}
};
window.requestAnimationFrame = () => 0;
</script>
<script src="/lang/i18n.js"></script><script src="theme.js"></script><script src="overlay.js"></script><script src="brawl.js"></script>
<script>
(() => {
  // A still at a chosen moment: ?at=<ms> after the effects began. The overlay's own animation is off.
  const at = Number(new URLSearchParams(location.search).get('at') || 0);
  const render = () => {
    ${tweak}
    if (battle) frame(() => renderBattle(performance.now() + at));
    else drawPanel();
  };
  let tries = 0;
  let shifted = false;
  // Images load when first drawn: draw, wait until they are in (a broken one counts as in), draw again.
  function settle() {
    render();
    // The animation is off here, so a slide of the corner panels would wait for the picture: it is over by then
    // (a scene that shows one sets it again in its tweak before every draw).
    cornerShown.at = -1e9;
    const pending = [...emoteImages.values()].some((e) => !e.ready && !e.failed) || document.fonts.status !== 'loaded';
    if (pending && tries++ < 80) { setTimeout(settle, 50); return; }
    if (!shifted) {
      // Announcements and pachinko keep their own clock: move it back once, then settle again,
      // since the later moment may show images the first draw did not ask for.
      shifted = true;
      tries = 0;
      if (!battle && announcement) announcement.shownAt -= at;
      if (pachinko) pachinko.shownAt -= at;
      settle();
      return;
    }
    const box = document.getElementById('preview-status');
    if (!box.dataset.errors) box.style.display = 'none';
    document.title = 'ready';
    console.log('preview: ready'); // render.ts looks for this line
  }
  setTimeout(settle, 1500);
})();
</script></body></html>`;
}

// --- A season in progress ----------------------------------------------------------

/** The texts in it are written as the server writes them, in `lang`. */
function seasonState(lang: string) {
  const land = startingLand('equal', () => 0);
  const rng = createRng(4);
  const cities: Record<string, string> = {};
  for (const [guildId, at] of Object.entries(config.map.cities)) cities[tileId(at)] = guildId;
  const tiles = mapTiles().map((hex) => {
    const id = tileId(hex);
    const city = cities[id];
    const owner: string | null = city ?? (id === '0,0' ? 'red' : (land[id] ?? null));
    const level = city ? 0 : id === '0,0' ? 5 : 1 + Math.floor(rng() * 5);
    // How fertile it is, as the server works it out for season 3.
    const share = (fertility(3, id) - config.land.fertility.min) / (config.land.fertility.max - config.land.fertility.min);
    return { id, q: hex.q, r: hex.r, owner, isCity: Boolean(city), scorched: false, burning: false, level, fertility: Math.round(share * 100) / 100 };
  });
  const greenTile = tiles.find((t) => t.id === '1,0');
  if (greenTile) greenTile.owner = 'green';
  const guild = (id: string, color: string, progress: number, design: number, tileCount: number, dev: number) => ({
    id, name: guildName(lang, id), color, xpBoost: id === 'blue', members: 18, active: 14, tiles: tileCount, development: dev,
    // As the server works it out: the base income, and per tile its share plus its levels.
    monument: { progress: progress * 10, goal: config.season.expectedPerHour * config.season.hours, design,
      income: config.monument.baseIncome + tileCount * config.monument.perTile + dev * config.monument.perLevel },
    ticks: 0,
  });
  return {
    session: { active: true, startedAt: 0 },
    seasonId: 3,
    season: { startedAt: 0, day: 4, wars: 6 },
    center: { id: '0,0', owner: 'red', minutesLeft: 20 },
    overlay: {
      map: { x: 1072, y: 692, width: 820, height: 360, visible: true },
      stats: { x: 28, y: 28, width: 440, height: 60 + 32 * 5 + 16, visible: true },
    },
    seasonStats: [
      { id: 'leading', label: text(lang, 'server.stats.leading'), value: text(lang, 'server.stats.leader', { guild: guildName(lang, 'blue'), percent: 85 }), color: '#3E8BFF', enabled: true },
      { id: 'seasonEnd', label: text(lang, 'server.stats.seasonEnd'), value: text(lang, 'server.stats.seasonEndIn', { count: 2 }), color: '#3E8BFF', enabled: true },
      { id: 'champion', label: text(lang, 'server.stats.champion'), value: 'PixelWizard15', color: '#FFD54A', enabled: true },
      { id: 'godSeason', label: text(lang, 'server.stats.godSeason', { god: 'TheStreamer' }), value: '2 : 3', color: null, enabled: true },
      { id: 'mostKills', label: text(lang, 'server.stats.mostKills'), value: `RustyPigeon2 · ${text(lang, 'server.stats.kills', { count: 14 })}`, color: null, enabled: true },
    ],
    god: { name: 'TheStreamer', color: '#9146FF', seasonWins: 2, seasonLosses: 3 },
    tiles,
    guilds: [
      guild('red', '#E5484D', 2700, 1, 6, 22),
      guild('green', '#46A758', 480, 0, 5, 18),
      guild('blue', '#3E8BFF', 6000, 2, 4, 15),
    ],
    display: { theme: 'plain', pixelateEmotes: true, animatedEmotes: true, language: lang },
  };
}

// --- Battles ---------------------------------------------------------------------

interface BattleFrameMessage {
  type: 'battle-frame';
  t: number;
  f: unknown;
  e: BattleEvent[];
  o: FrameObstacle[] | null;
}

interface SideInfo {
  id: string;
  name: string;
  color: string;
}

/**
 * Runs a battle to its end (or 1400 steps) and keeps the 12 frames starting at
 * the step `pick` scores highest: the moment worth a picture.
 */
function recordBattle(
  title: string,
  setup: BattleSetup,
  sides: SideInfo[],
  emotes: Map<string, Emote>,
  pick: (frames: BattleFrameMessage[], i: number) => number,
  /** Whether the picture shows the battle's start as it begins (the arena's name introduced), not a page joining later. */
  fromStart = false,
  /** More of the start message, such as `duel: true`. */
  extra: object = {},
): unknown[] {
  const battle = new Battle(setup);
  const start = {
    ...extra,
    type: 'battle-start', title, durationMs: battle.durationMs, arena: config.battle.arena, enrageGrow: config.skills.enrage.grow, ambient: false, sides,
    place: battle.place, elapsedMs: 0, overtimeMs: battle.overtimeAt,
    fighters: battle.fighters.map((f) => ({
      name: f.name, color: f.color, emote: emotes.get(f.doubleOf ?? f.id) ?? null, image: null, cls: f.class ?? null, crown: false,
      minion: f.minion, imp: f.imp === true, leader: f.leader === true, double: f.doubleOf ? battle.fighters.findIndex((o) => o.id === f.doubleOf) : -1, side: f.side, radius: f.radius * config.battle.drawnRadiusShare,
    })),
  };
  const frames: BattleFrameMessage[] = [];
  while (!battle.finished && frames.length < 1400) {
    battle.step();
    frames.push({ type: 'battle-frame', t: battle.timeMs, f: battle.frame(), e: battle.events, o: battle.obstacleFrame() });
  }
  let best = fromStart ? 0 : 20;
  let bestScore = -Infinity;
  for (let i = fromStart ? 0 : 20; i < frames.length - 12; i++) {
    const score = pick(frames, i);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  // Joined at the picked moment: the arena's introduction is long over.
  if (!fromStart) start.elapsedMs = frames[best]?.t ?? 0;
  return [start, ...frames.slice(best, best + 12)];
}

/**
 * A brawl as a page joining it sees it: the start message from 12 frames
 * before the moment, and those frames. Chat writes a message a second; the
 * god joins at `godAt` seconds; it stops `seconds` in, or 3 frames after the
 * first frame `until` picks.
 */
function recordBrawl(chatters: BrawlWho[], seconds: number, godAt?: number, until?: (frame: any) => boolean): unknown[] {
  const sent: any[] = [];
  const runner = new BrawlRunner((m) => sent.push(m));
  runner.begin(11, 8);
  const rng = createRng(11);
  for (const who of chatters.slice(0, 8)) runner.write(who);
  const history: { start: unknown; frame: unknown }[] = [];
  let stopAt = seconds * config.brawl.framesPerSecond;
  for (let i = 0; i < stopAt; i++) {
    if (rng() < 1 / config.brawl.framesPerSecond) runner.write(chatters[Math.floor(rng() * chatters.length)]!);
    if (godAt !== undefined && i === godAt * config.brawl.framesPerSecond) {
      runner.join({ id: 'streamer', name: 'TheStreamer', color: '#9146FF', image: null, emote: null }, 'god');
    }
    const start = runner.startMessage();
    runner.tick(1);
    const frame = sent.at(-1);
    history.push({ start, frame });
    if (until && until(frame) && stopAt > i + 3) stopAt = i + 4;
  }
  const from = Math.max(0, history.length - 12);
  return [history[from]!.start, ...history.slice(from).map((h) => h.frame)];
}

const countFx = (frames: BattleFrameMessage[], i: number, fx: string) =>
  frames.slice(i, i + 12).reduce((n, f) => n + f.e.filter((e) => e.fx === fx).length, 0);
const castAt = (frame: BattleFrameMessage | undefined, skill: string) =>
  Boolean(frame?.e.some((e) => e.k === 'cast' && e.s === skill));

// --- All scenes ----------------------------------------------------------------------

/**
 * Writes every scene page into `outDir` and returns the scenes with their
 * moments. `lang` is the language of the texts the server would have written;
 * the overlay's own texts follow `?lang=` in the page address.
 */
export function generateScenes(outDir: string, lang = 'en'): Scene[] {
  mkdirSync(outDir, { recursive: true });
  const scenes: Scene[] = [];
  const page = (name: string, options: PageOptions) => {
    writeFileSync(join(outDir, `${name}.html`), pageHtml(options));
    scenes.push({ name, moments: options.moments });
  };

  const state = seasonState(lang);
  const t = (key: string, params?: Record<string, string | number>) => text(lang, key, params);
  const guild = (id: string) => guildName(lang, id);
  const stateMessage = { type: 'state', state };
  // What the server adds for its own screens: the map banner's strip, at the bottom.
  const withStrip = { type: 'state', state: { ...state, mapStrip: { place: 'bottom', height: config.battle.bannerHeight, width: config.battle.arena.width } } };
  // In a battle the panels are hidden, as the game does.
  const battleState = {
    type: 'state',
    state: { ...state, overlay: { map: { ...state.overlay.map, visible: false }, stats: { ...state.overlay.stats, visible: false } } },
  };

  // Panels: the map and the season stats.
  page('panels', { messages: [stateMessage], moments: [0] });

  // Mishaps on the map: two burning tiles, a lightning strike, a harvest, a fire put out,
  // marks left by earlier ones (scorch marks from lightning, ash from fires, one fading),
  // and a Monument growing.
  const burning = new Set(['1,0', '-2,1']);
  const marks: Record<string, { kind: 'lightning' | 'fire'; age: number }> = {
    '2,-1': { kind: 'lightning', age: 0 },
    '-1,0': { kind: 'lightning', age: 0.67 },
    '-1,-1': { kind: 'fire', age: 0 },
    '1,1': { kind: 'fire', age: 0.33 },
  };
  page('mishaps', {
    // Green's fire still needs a writer; Blue has enough writing to put its fire out.
    messages: [
      {
        type: 'state',
        state: {
          ...state,
          tiles: state.tiles.map((t) => ({ ...t, burning: burning.has(t.id), mark: marks[t.id] ?? null })),
          guilds: state.guilds.map((g) => ({
            ...g,
            fire: g.id === 'green' ? { tiles: 1, writers: 1, needed: 2 } : g.id === 'blue' ? { tiles: 1, writers: 3, needed: 2 } : null,
          })),
        },
      },
    ],
    moments: [0],
    tweak: `if (state && !window.__mishaps) { window.__mishaps = 1; const now = performance.now();
      monumentPops.push({ guild: 'red', amount: 3, start: now - 500 }, { guild: 'blue', amount: 2, start: now - 1200 },
        { guild: 'red', tick: true, amount: 1, start: now - 300, dx: 4 }, { guild: 'green', tick: true, amount: 1, start: now - 700, dx: -5 }, { guild: 'blue', tick: true, amount: 1, start: now - 200, dx: 0 });
      mishapEffects.push({ id: 5, kind: 'lightning', tile: '2,-1', from: 6, to: 4, start: now - 90 },
        { id: 6, kind: 'harvest', tile: '0,2', from: 2, to: 3, start: now - 700 },
        { id: 7, kind: 'doused', tile: '-1,-1', from: 3, to: 3, start: now - 900 }); }`,
  });

  // An event's closing words: the map banner along the edge instead of the corner panels.
  page('closing', {
    messages: [withStrip, { type: 'announce', title: t('server.war.over'), subtitle: t('server.war.tookTile', { attacker: guild('blue'), defender: guild('red') }), holdMs: 600000 }],
    moments: [0],
  });

  // Announcements: a war's battle on the map, and a season's winner.
  page('eventmap', {
    // An attack on developed land: the subtitle names the stake, as the War engine words it.
    messages: [stateMessage, { type: 'announce', title: t('server.war.battleOf', { n: 2, total: 3 }), subtitle: t('server.war.stake', { attack: t('server.war.attacksLevel', { attacker: guild('green'), defender: guild('red'), level: 4 }), kept: 2, defender: guild('red'), bonus: 12 }), map: { targets: [{ tile: '2,-1', by: 'green' }] }, holdMs: 600000 }],
    moments: [1500],
  });
  page('celebrate', {
    messages: [stateMessage, { type: 'announce', title: t('server.season.wins', { guild: guild('blue'), season: 3 }), subtitle: t('server.season.winsSubtitle'), map: {}, celebrate: { guild: 'blue', design: 2 }, holdMs: 600000 }],
    moments: [800, 3000],
  });

  // The season's recap after it: the first rows coming in, then all of them; and the god's season.
  const ended = {
    id: 3, startedAt: 0, endedAt: 1, winner: 'blue' as const, wars: 4, godWins: 2, godLosses: 5,
    summary: {
      endedBy: 'monument' as const, players: 87, monumentGoal: 20_000,
      topLevel: { displayName: 'TinyMoth4', level: 9 }, topKiller: { displayName: 'SaltyOtter23', kills: 41 },
      champion: { displayName: 'RustyPigeon2', wins: 3 }, pachinko: { displayName: 'LuckyRaven14', points: 100 },
      guilds: {
        red: { monument: 14_000, tiles: 5, development: 20, members: 30, design: 0 },
        green: { monument: 9_000, tiles: 4, development: 12, members: 20, design: 1 },
        blue: { monument: 20_050, tiles: 6, development: 25, members: 37, design: 2 },
      },
    },
  };
  const recapOf = (record: typeof ended | (Omit<typeof ended, 'winner'> & { winner: 'god' })) =>
    ({ ...recapMessage(record, { name: 'TheStreamer', color: '#9146FF' }, lang)!, holdMs: 600000 });
  page('recap', { messages: [stateMessage, recapOf(ended)], moments: [2000, 12000] });
  page('recapgod', { messages: [stateMessage, recapOf({ ...ended, winner: 'god', godWins: 5 })], moments: [12000] });

  // Fighters: simulated chatters with their colors and favorite emotes.
  const chat = new SimulatedChat({ seed: 1, channel: 'x', startAt: 0, chatterCount: 45 });
  const chatters = chat.chatters.filter((c) => c.role === 'chatter' || c.role === 'moderator');
  const emotes = new Map(chatters.map((c) => [c.userId, twitch(c.favoriteEmote)]));
  const noEmotes = new Map<string, Emote>();
  const guildSides: SideInfo[] = config.guilds.list.map((g) => ({ id: g.id, name: guild(g.id), color: g.color }));
  const redAttacksBlue = t('server.war.attacks', { attacker: guild('red'), defender: guild('blue') });
  const versusTitle = t('server.god.versusTitle', { god: 'TheStreamer' });

  // A team battle with classes: Red against Blue, picked where arrows, blasts and heals fly.
  const fighters: FighterSpec[] = chatters
    .map((c) => ({ id: c.userId, name: c.displayName, color: c.color, side: assignGuild(c.color, c.userId) as string, level: 2 }))
    .filter((f) => f.side !== 'green');
  assignClasses(fighters, createRng(3));
  const twoSides = guildSides.filter((g) => g.id !== 'green');
  const teamSides = () => twoSides.map((g) => ({ id: g.id, damageBonus: 0, healthBonus: 0 }));
  // Healers at work: the arc of light, its motes, and the crosses rising from the patient.
  page('heals', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 7, sides: teamSides(), fighters }, twoSides, emotes,
      (frames, i) => countFx(frames, i, 'heal') * 10 - i / 1000)],
    moments: [0],
    tweak: 'if (battle) battle.effects.forEach((e, k) => { if (e.fx === "heal") e.start = performance.now() - 180 - (k % 3) * 60; });',
  });

  // A mage's spell ball in flight over the crowd, a third of the way to its spot.
  page('spellball', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 7, sides: teamSides(), fighters }, twoSides, emotes,
      (frames, i) => countFx(frames, i, 'blast-warn') * 10)],
    moments: [0],
    tweak: 'if (battle) battle.effects.forEach((e) => { if (e.fx === "blast-warn") e.start = performance.now() - (e.ms || 1000) * 0.15; });',
  });

  page('classes', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 7, sides: teamSides(), fighters }, twoSides, emotes,
      (frames, i) => countFx(frames, i, 'arrow') * 3 + countFx(frames, i, 'blast-warn') * 6 + countFx(frames, i, 'blast') * 6 + countFx(frames, i, 'heal') * 4)],
    moments: [250],
  });

  // The highlights beside the scoreboard, and the same battle with names switched off.
  const classesBattle = recordBattle(redAttacksBlue, { seed: 7, sides: teamSides(), fighters }, twoSides, emotes,
    (frames, i) => countFx(frames, i, 'arrow') * 3 + countFx(frames, i, 'blast-warn') * 6 + countFx(frames, i, 'blast') * 6 + countFx(frames, i, 'heal') * 4);
  page('highlights', {
    messages: [battleState, ...classesBattle],
    moments: [1200],
    // Three lines shown a moment ago, newest on top.
    tweak: `const of = (side) => battle.fighters.map((f, i) => [f, i]).filter(([f]) => f.side === side).map(([, i]) => i);
      const [red, blue] = [of('red'), of('blue')];
      const now = performance.now();
      battle.feed.lastAt = now;
      battle.feed.lines = [[red[2], blue[3], 'spin', 'streak'], [blue[1], -1, 'trap', 'cause'], [red[0], blue[0], 'strike', 'crown']]
        .map(([i, b, c, h], row) => ({ parts: feedLine({ k: 'death', i, b, c, h }), shownAt: now - 1000 - row * 900 }));`,
  });
  page('nonames', {
    messages: [battleState, ...classesBattle],
    moments: [250],
    tweak: 'state.display = { ...state.display, names: false };',
  });

  // A Guild Clash in which Blue drew few chatters: the streamer's imps fight in its color.
  const fewBlue = [...fighters.filter((f) => f.side === 'red').slice(0, 8), ...fighters.filter((f) => f.side === 'blue').slice(0, 3)];
  const blueImps: FighterSpec[] = Array.from({ length: 5 }, (_, i) => ({ id: `imp:blue:${i + 1}`, name: t('server.imp.name', { n: i + 1 }), color: null, class: null, side: 'blue', level: 0, imp: true }));
  page('imps', {
    messages: [battleState, ...recordBattle(t('mode.guildClash'), { seed: 5, sides: teamSides(), fighters: [...fewBlue, ...blueImps], sizeBalance: false }, twoSides, emotes,
      (_frames, i) => (i === 60 ? 1 : 0))],
    moments: [250],
  });

  // Overtime in a Hero Clash match: a tank and two others, late in the match, the clock red.
  const trio: FighterSpec[] = fighters.filter((f) => f.side === 'red').slice(0, 3).map((f, i) => ({ ...f, side: f.id, class: (['tank', 'tank', 'healer'] as const)[i]! }));
  page('overtime', {
    messages: [battleState, ...recordBattle(t('server.clash.heatBattle', { n: 1, total: 3 }), {
      seed: 8, durationMs: config.clash.matchMs, toughness: 30, sizeBalance: false, fortune: false, levelBonus: false, overtime: config.clash.overtime,
      sides: trio.map((f) => ({ id: f.side, damageBonus: 0, healthBonus: 0 })), fighters: trio,
    }, trio.map((f) => ({ id: f.side, name: f.name, color: '#E5484D' })), emotes, (frames, i) => (frames[i]!.t >= config.clash.overtime.afterMs + 4_000 ? 100 - i / 1000 : -1))],
    moments: [250],
  });

  // A duel: two chatters face to face on the "VS" screen, then the fight with the health bars of a fighting game.
  const duelists: FighterSpec[] = [fighters.find((f) => f.side === 'red')!, fighters.find((f) => f.side === 'blue')!]
    .map((f) => ({ ...f, side: f.id, level: 0, radius: config.duel.radius, class: 'fighter' as const }));
  const duelColors = [config.guilds.list.find((g) => g.id === 'red')!.color, config.guilds.list.find((g) => g.id === 'blue')!.color];
  page('duellineup', {
    messages: [stateMessage, {
      type: 'announce', title: t('server.duel.title', { a: duelists[0]!.name, b: duelists[1]!.name }), subtitle: '', holdMs: config.duel.lineupMs,
      lineup: {
        duel: true,
        teams: duelists.map((f, i) => ({
          name: guild(i === 0 ? 'red' : 'blue'), color: duelColors[i]!,
          members: [{ name: f.name, detail: t(`class.${f.class}`), emote: emotes.get(f.id) ?? null, color: f.color }],
        })),
        note: t('server.duel.note'),
      },
    }],
    moments: [350, 700, 3000],
  });
  page('duel', {
    messages: [battleState, ...recordBattle(t('mode.duel'), {
      seed: 12, durationMs: config.duel.durationMs, toughness: config.pace.kinds.duel.toughness, classSwitch: { everyMs: config.duel.switchEveryMs }, sizeBalance: false, fortune: false, levelBonus: false,
      overtime: config.duel.overtime, hitSpread: config.duel.hitSpread, obstacles: 'hazards',
      sides: duelists.map((f) => ({ id: f.side, damageBonus: 0, healthBonus: 0 })), fighters: duelists,
    }, duelists.map((f, i) => ({ id: f.side, name: f.name, color: duelColors[i]! })), emotes,
    // A moment after both took some hits.
    (frames, i) => { const f = frames[i]!.f as number[][]; return f[0]![2]! < 0.75 && f[1]![2]! < 0.6 ? 100 - i / 100 : -1; }, false, { duel: true })],
    moments: [150, 400],
  });

  // A small chat's War: one guild of two chatters against five, filled up the small-chat way: the god doubles
  // the two (a status line says so), an imp takes the last place; the chatters lead them under banners.
  const { impStrength, leaderStrength, cloneStrength } = config.smallChat;
  const lead = (f: FighterSpec): FighterSpec => ({ ...f, leader: true, strength: leaderStrength });
  const reds = fighters.filter((f) => f.side === 'red').slice(0, 2).map(lead);
  const smallWar: FighterSpec[] = [
    ...reds,
    ...reds.map((f): FighterSpec => ({ ...f, id: `double:${f.id}:1`, doubleOf: f.id, leader: false, strength: cloneStrength })),
    { id: 'imp:red:1', name: t('server.imp.name', { n: 1 }), color: null, class: null, side: 'red', level: 0, imp: true, strength: impStrength },
    ...fighters.filter((f) => f.side === 'blue').slice(0, 5).map(lead),
    { id: 'imp:blue:1', name: t('server.imp.name', { n: 1 }), color: null, class: null, side: 'blue', level: 0, imp: true, strength: impStrength },
  ];
  page('smallwar', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 6, sides: teamSides(), fighters: smallWar }, twoSides, emotes,
      (_frames, i) => (i === 50 ? 1 : 0))],
    moments: [250],
  });
  // The doubles stepping out of their chatters as the battle begins, and the status line.
  page('doubles', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 6, sides: teamSides(), fighters: smallWar }, twoSides, emotes, (_frames, i) => -i, true)],
    moments: [0],
    tweak: 'if (battle && !window.__doubles) { window.__doubles = 1; battle.shownAt = performance.now() - 900; battle.feed.lines.forEach((l, i) => { l.shownAt = performance.now() - 300 - i * 500; }); }',
  });

  // The streamer against chat: no classes or emotes, only the god's skills, and steady timing.
  const crowd: FighterSpec[] = chatters.map((c) => ({ id: c.userId, name: c.displayName, color: c.color, side: assignGuild(c.color, c.userId), level: 2, class: null }));
  const r = radiusFor(crowd.length + 1);
  const god: FighterSpec = {
    id: 'god', name: 'TheStreamer', color: '#9146FF', side: 'god', level: 0, skills: ['smite'], holdsCenter: true, weight: config.god.weight,
    health: godHealth(crowd.length) * 3, damage: config.god.damage, radius: r * config.god.radiusFactor, splashRadius: r * config.god.splashFactor, speed: config.god.speed,
  };
  const godSides: SideInfo[] = [{ id: 'god', name: 'TheStreamer', color: '#9146FF' }, ...guildSides];
  const godSetup = (seed: number, godSpec: FighterSpec): BattleSetup => ({
    seed, sizeBalance: false, timeLimitWinner: 'god',
    sides: [{ id: 'god', damageBonus: 0, healthBonus: 0 }, ...config.guilds.list.map((g) => ({ id: g.id, team: 'chat', damageBonus: 0, healthBonus: 0 }))],
    fighters: [godSpec, ...crowd.map((f) => ({ ...f }))],
  });
  // Picked where the god casts Divine Smite: fire on the ground.
  const fire = recordBattle(versusTitle, godSetup(9, god), godSides, noEmotes, (frames, i) => (castAt(frames[i], 'smite') ? 100 - i / 100 : -1));
  page('fire', { messages: [battleState, ...fire], moments: [1500, 4000] });
  // The same moment with the skill's name shown, and with the battle's result.
  page('caption', {
    messages: [battleState, ...fire],
    moments: [300, 1000],
    tweak: `if (battle && !battle.caption) battle.caption = { text: skillCaption('smite'), index: 0, start: performance.now() };`,
  });
  page('endscreen', {
    messages: [battleState, ...fire, {
      type: 'battle-end', cancelled: false, winner: 'red', winnerName: guild('red'), winnerColor: '#E5484D', fighters: 45, survivors: 12,
      mostKills: { name: 'RustyPigeon2', kills: 4 }, holdMs: 1e9,
    }],
    moments: [1500],
  });

  // The god with minions: picked a little after they were summoned.
  page('minions', {
    messages: [battleState, ...recordBattle(versusTitle, godSetup(11, { ...god, skills: ['minions'] }), godSides, noEmotes,
      (frames, i) => (castAt(frames[i - 3], 'minions') ? 100 - i / 100 : -1))],
    moments: [1500],
  });

  // Big hits: the god's Leap landing in a crowd, its damage numbers rising (a killing blow in red).
  page('bighits', {
    messages: [battleState, ...recordBattle(versusTitle, godSetup(19, { ...god, skills: ['leap'] }), godSides, noEmotes,
      (frames, i) => (castAt(frames[i + 11], 'leap') ? 100 - i / 100 : -1))],
    moments: [0],
    tweak: 'if (battle) { battle.numbers.forEach((n, k) => { n.start = performance.now() - 220 - (k % 4) * 60; }); battle.knockouts.forEach((n, k) => { n.start = performance.now() - 150 - k * 80; }); }',
  });

  // Shockwave: picked just after it hurled the nearest chatters, who fly off squashed by their speed.
  page('shockwave', {
    messages: [battleState, ...recordBattle(versusTitle, godSetup(13, { ...god, skills: ['shockwave'] }), godSides, noEmotes,
      (frames, i) => (castAt(frames[i - 2], 'shockwave') ? 100 - i / 100 : -1))],
    moments: [0, 300],
  });

  // Arenas: a team battle in each, picked where its obstacles are busy (barrels rolling, traps striking, bumpers lit).
  const busy = (frames: BattleFrameMessage[], i: number) => {
    const o = frames[i]?.o;
    return o ? o.filter((x) => x[1] === 2).length * 10 + o.filter((x) => x[6] > 0).length * 5 + o.length - i / 1000 : -1;
  };
  for (const place of ARENAS) {
    page(`arena-${place}`, {
      messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 21, sides: teamSides(), fighters: fighters.map((f) => ({ ...f })), obstacles: 'fixed', place }, twoSides, emotes, busy)],
      moments: [1000],
    });
  }
  // The arena's name, introduced as the battle begins.
  page('arenaintro', {
    messages: [battleState, ...recordBattle(redAttacksBlue, { seed: 22, sides: teamSides(), fighters: fighters.map((f) => ({ ...f })), obstacles: 'fixed', place: 'brewery' }, twoSides, emotes, (_frames, i) => -i, true)],
    moments: [700],
  });
  // Transitions: a battle coming in while the corner panels slide away, and the panels sliding back after it.
  page('battlein', {
    messages: [stateMessage, ...recordBattle(redAttacksBlue, { seed: 22, sides: teamSides(), fighters: fighters.map((f) => ({ ...f })), obstacles: 'fixed', place: 'pinball' }, twoSides, emotes, (_frames, i) => -i, true)],
    moments: [0],
    tweak: `cornerShown.at = performance.now() - 230; if (battle) { battle.shownAt = performance.now() - 330; battle.startedAt = -1e9; }`,
  });
  page('panelsin', {
    messages: [stateMessage],
    moments: [0],
    tweak: `cornerShown.shown = true; cornerShown.at = performance.now() - 260;`,
  });

  // The god's Rampage breaking through the walls of the Ruins.
  page('smash', {
    messages: [battleState, ...recordBattle(versusTitle, { ...godSetup(17, { ...god, skills: ['rampage'] }), obstacles: 'fixed', place: 'ruins' }, godSides, noEmotes,
      (frames, i) => (frames[i + 2]?.o ?? []).filter((x) => x[1] === 0 && x[6] === 1).length * 10 - i / 1000)],
    moments: [300],
  });

  // A countdown fight: the countdown with the chatters who joined, then the line-up with their classes.
  // These carry the longest texts the server writes, so they show first where a language runs long.
  const guildClash = t('mode.guildClash');
  page('countdown', {
    messages: [stateMessage, {
      type: 'countdown', title: guildClash, subtitle: t('server.countdown.subtitle'), remainingMs: 23_400, joined: 17,
      recent: chatters.slice(0, 8).map((c) => c.displayName),
      banner: { place: 'bottom', height: config.battle.bannerHeight, width: config.battle.arena.width },
    }],
    moments: [0],
  });
  const drawn: FighterSpec[] = chatters.slice(0, 24).map((c) => ({ id: c.userId, name: c.displayName, color: c.color, side: assignGuild(c.color, c.userId) as string, level: 0 }));
  assignClasses(drawn, createRng(5));
  page('lineup', {
    messages: [stateMessage, {
      // The fighters are revealed over the hold time: the real one, and a moment near its end.
      type: 'announce', title: t('server.lineupTitle', { mode: guildClash }), subtitle: '', holdMs: config.draft.lineupMs,
      lineup: {
        teams: config.guilds.list.map((g) => ({
          name: guild(g.id), color: g.color,
          // With the emote each fights as and their name color, as the server adds them.
          // Blue drew only four: the streamer's imps fill its other places.
          members: [
            ...drawn.filter((f) => f.side === g.id).slice(0, g.id === 'blue' ? 4 : 10)
              .map((f) => ({ name: f.name, detail: t(`class.${f.class}`), emote: emotes.get(f.doubleOf ?? f.id) ?? null, color: f.color })),
            ...(g.id === 'blue' ? Array.from({ length: 6 }, (_, i) => ({ name: t('server.imp.name', { n: i + 1 }), detail: t('server.imp.detail'), imp: true })) : []),
          ],
        })),
        note: t('server.draft.guildNote', { n: config.draft.onFieldPerGuild }),
      },
    }],
    moments: [Math.round(config.draft.lineupMs * 0.85)],
  });

  // A Hero Clash heat: the three heroes presented with their guilds, classes and emotes.
  const heroes = config.guilds.list.map((g) => drawn.find((f) => f.side === g.id)!);
  page('heat', {
    messages: [stateMessage, {
      type: 'announce', title: t('server.clash.heatTitle', { n: 1, total: 3 }), subtitle: '', holdMs: config.war.announceMs,
      lineup: {
        teams: heroes.map((f) => ({
          name: guild(f.side), color: config.guilds.list.find((g) => g.id === f.side)!.color,
          members: [{ name: f.name, detail: t(`class.${f.class}`), emote: emotes.get(f.doubleOf ?? f.id) ?? null, color: f.color }],
        })),
        note: t('server.clash.lineupNote'),
      },
    }],
    moments: [1600, 4600],
    // It shows only 5 seconds; loading the page's images can take longer than that.
    tweak: 'clearTimeout(announcementTimer);',
  });

  // Pachinko: three boards of balls dropping, at the start, midway and at the end.
  const emoteIds = ['25', '1902', '305954156', '88', '354', '86', '41', '9', '58765', '1'];
  const teams = config.guilds.list.map((g, gi) => ({
    team: g.id,
    // Blue drew seven: three of the streamer's imps take its other balls.
    players: Array.from({ length: 10 }, (_, i) =>
      gi === 2 && i >= 7
        ? { name: t('server.imp.name', { n: i - 6 }), emote: null, imp: true }
        : { name: `${g.name}Hero${i}`, emote: { url: `/emotes/twitch/${emoteIds[(i + gi) % emoteIds.length]}?animated=0` }, imp: false }),
  }));
  const game = playPachinko(teams, createRng(4));
  const pachinkoMessage = (game: ReturnType<typeof playPachinko<(typeof teams)[number]['players'][number]>>, jelly = false) => ({
      type: 'pachinko', title: t('mode.pachinko'), rows: config.pachinko.rows, slots: config.pachinko.slots, hopMs: config.pachinko.hopMs, durationMs: game.durationMs, winner: game.winner,
      banner: { place: 'bottom', height: config.battle.bannerHeight, width: config.battle.arena.width },
      boards: game.boards.map((b) => {
        const g = config.guilds.list.find((x) => x.id === b.team);
        return {
          team: b.team, name: guild(b.team), color: g?.color ?? null, total: b.total,
          drops: b.drops.map((d) => ({ name: d.player.name, color: d.player.imp ? g?.color ?? null : null, emote: d.player.emote, imp: d.player.imp, path: d.path, slot: d.slot, points: d.points, at: d.at, ...(jelly ? { jelly: true } : {}) })),
        };
      }),
    });
  // A jackpot's firework bursting over the pins, in another game that has one early.
  const lucky = playPachinko(teams, createRng(12));
  const jackpot = lucky.boards.flatMap((b) => b.drops).filter((d) => d.points === Math.max(...config.pachinko.slots)).sort((a, b) => a.at - b.at)[0]!;
  const fall = (config.pachinko.rows + 1) * config.pachinko.hopMs;
  page('jackpot', {
    messages: [stateMessage, pachinkoMessage(lucky)],
    moments: [Math.round(jackpot.at + fall + 300), Math.round(jackpot.at + fall + 800)],
    // The game's clock starts at the first draw, not when the page loaded, so the moments are exact: the rocket climbing, then the burst.
    tweak: 'if (pachinko && !window.__clock) { window.__clock = 1; pachinko.shownAt = performance.now(); }',
  });
  // Jelly balls (every ball here, for the picture): splatting on a pin and jiggling on.
  page('pachinkojelly', { messages: [stateMessage, pachinkoMessage(game, true)], moments: [2500, 2650, 9000] });
  page('pachinko', {
    messages: [stateMessage, pachinkoMessage(game)],
    // During the game, then the winner's celebration: the pop, the crown landing, the confetti raining.
    moments: [2500, 9000, 16000, game.durationMs + 300, game.durationMs + 1200, game.durationMs + 3500],
  });

  // The Arena's brawl: jelly fighters in side view; the god landing; the god's fall.
  const brawlers: BrawlWho[] = chatters.map((c) => ({ id: c.userId, name: c.displayName, color: c.color ?? '#9ACD32', emote: twitch(c.favoriteEmote) }));
  page('brawl', { messages: [stateMessage, ...recordBrawl(brawlers, 25)], moments: [0] });
  page('brawlgod', { messages: [stateMessage, ...recordBrawl(brawlers, 16, 12)], moments: [0] });
  // A giant dropping in, announced (every joiner is one here, for the picture).
  const chance = config.brawl.giant.chance;
  config.brawl.giant.chance = 1;
  page('brawlgiant', {
    messages: [stateMessage, ...recordBrawl(brawlers, 30, undefined, (frame) => frame.t > 6000 && (frame.e ?? []).some((e: any) => e.k === 'join'))],
    moments: [0],
  });
  config.brawl.giant.chance = chance;
  page('brawlfall', {
    messages: [stateMessage, ...recordBrawl(brawlers, 400, 8, (frame) => (frame.e ?? []).some((e: any) => e.k === 'godfall'))],
    moments: [0],
  });

  writeFileSync(join(outDir, 'scenes.json'), JSON.stringify(scenes, null, 2));
  return scenes;
}

if (import.meta.main) {
  const outDir = resolve(process.argv[2] ?? join(import.meta.dirname, 'out', 'pages'));
  for (const scene of generateScenes(outDir)) console.log(scene.name, scene.moments.join(', '));
  console.log(`pages in ${outDir}`);
}
