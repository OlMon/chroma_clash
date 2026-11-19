import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { databaseProblem } from '../db/schema.ts';
import { databaseSize, readOverlayReport, type OverlayInfo } from './status.ts';
import { config, type GuildId, type SkillId, type StatId } from '../config.ts';
import type { Store } from '../db/store.ts';
import { BattleRunner, bannerStrip, type BannerPlace } from './battle-runner.ts';
import { prepareBattle, toughnessFor } from './battles.ts';
import { applyTuning, setTuning } from './tuning.ts';
import type { UserRow } from '../db/store.ts';
import type { ChatMessageEvent } from '../irc/events.ts';
import { assignClasses, type FighterSpec } from '../game/battle.ts';
import { createRng } from '../util/rng.ts';
import { ClashEngine } from './clash-engine.ts';
import { DraftEngine, drawFighters, drawProblem, type DraftMode } from './draft-engine.ts';
import { PachinkoEngine } from './pachinko-engine.ts';
import { EventRunner, type EventEngine } from './event-runner.ts';
import { GodEngine, type GodStartKind } from './god-engine.ts';
import { WarEngine } from './war-engine.ts';
import { buildSnapshot, overlayPanels, type GameSnapshot, type SourceInfo } from './state.ts';
import { listThemes } from './themes.ts';
import { addLanguagesFrom, guildName, isLanguage, languageList, languageOf, translator } from '../i18n.ts';
import { normalizeChannel } from '../app-settings.ts';
import { EmoteImages } from '../emotes/images.ts';
import { EmoteRegistry } from '../emotes/registry.ts';
import { THIRD_PARTY_SOURCES, type ThirdPartySource } from '../emotes/sources.ts';
import { estimatedRuntimes, type Runtime, type RuntimeKind } from './runtimes.ts';

export interface GameServerOptions {
  store: Store;
  /** Folder that contains `overlay/`, `control/` and `lang/`. */
  root: string;
  getSource: () => SourceInfo;
  /** Game time. The simulator can run faster than the real clock. */
  now: () => number;
  port?: number;
  host?: string;
  /** Source of battle seeds; injectable for tests. */
  random?: () => number;
  /** The BetterTTV, FrankerFaceZ and 7TV emote sets. Without one, only Twitch emotes are known. */
  emotes?: EmoteRegistry;
  /** Where emote images come from. Without one, they are fetched and kept in memory only. */
  emoteImages?: EmoteImages;
  /**
   * Called when the streamer enters another channel in the control panel,
   * after the answer went out. The caller then closes this server and starts
   * one for that channel. Without it, the channel cannot be changed.
   */
  onChannel?: (channel: string) => void;
  /** The channel database's file, for its size on the status page and for exports. */
  databasePath?: string;
  /**
   * Called to reset this channel's game (`reset`) or to replace it with an
   * imported database (`import`, a checked file next to the database). The
   * caller backs up the current database, closes this server and starts again.
   * Without it, neither is offered.
   */
  onDatabase?: (change: { kind: 'reset' } | { kind: 'import'; file: string }) => void;
  /** The secret of the action links (/api/action/<name>?key=…). Without it, the links are off. */
  actionKey?: string;
  /** Writing in chat: only with a Twitch token. Results are announced there when the streamer switches it on. */
  chat?: { canSay(): boolean; say(text: string): boolean };
  /** The program's version, and a newer one when the update check found it. */
  version?: () => { current: string; latest: { version: string; url: string; notes?: string } | null };
}

export interface GameServer {
  port: number;
  /** Pushes the state to all pages now, if it changed. */
  broadcast(): void;
  /** Starts a War. Throws an Error with a message for the streamer if it cannot start. */
  startWar(): void;
  /** Whether the `!war` chat command is switched on. */
  warCommandEnabled(): boolean;
  /** Every chat message, after it was recorded. A running countdown notes who wrote. */
  onChat(event: ChatMessageEvent): void;
  /** A guild finished its Monument: the season ended. Announces it on the overlay. */
  seasonWon(winner: GuildId): void;
  /** A guild's time on the center tile ran out. Pushes the changed map to the pages at once. */
  centerReclaimed(): void;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
/** Folders served as they are: the two pages, and the language files both of them read. */
const PAGES = ['overlay', 'control', 'lang'];

/** The state sent to the pages: the game's, plus what only the server knows. */
/** The map banner's place from its setting: at the bottom unless the streamer chose otherwise. */
function bannerPlace(setting: string | null): BannerPlace {
  return setting === 'off' ? null : setting === 'top' ? 'top' : 'bottom';
}

export type ServerSnapshot = GameSnapshot & {
  mapBanner: 'top' | 'bottom' | 'off';
  /** `withoutGpu`: open overlays that draw without the graphics card, which makes battles stutter. */
  guide: { overlays: number; testBattleRun: boolean; withoutGpu: number };
  chatAnnounce: { available: boolean; enabled: boolean };
  /** Expected runtime of each event from the click, shortest and longest, in ms. */
  runtimes: Record<RuntimeKind, Runtime>;
  data: { resettable: boolean };
  version: { current: string; latest: { version: string; url: string; notes?: string } | null };
};

/** The action links, by name: what a Stream Deck button or an OBS hotkey can do. */
export const ACTIONS = [
  'war',
  'hero-clash',
  'guild-clash',
  'free-for-all',
  'pachinko',
  'gods-wrath',
  'streamer-vs-chat',
  'friendly-fight',
  'endless',
  'endless-on',
  'endless-off',
  'layer',
  'layer-on',
  'layer-off',
  'test-battle',
  'stop',
] as const;
export type ActionName = (typeof ACTIONS)[number];

/** Largest database the control panel accepts for an import. */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_BODY_BYTES = 10_000;

/** Image types accepted for the god's picture, recognized by the first bytes of the file. */
const PICTURE_TYPES: { mime: string; matches: (data: Buffer) => boolean }[] = [
  { mime: 'image/png', matches: (d) => d.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mime: 'image/jpeg', matches: (d) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff },
  {
    mime: 'image/webp',
    matches: (d) => d.subarray(0, 4).toString('latin1') === 'RIFF' && d.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Decodes an uploaded picture from a `data:` address. Throws an HttpError,
 * with a message from `tr` for the streamer, if it is not a usable image.
 */
function decodePicture(value: unknown, tr: (key: string) => string): { mime: string; data: Buffer } {
  const match = typeof value === 'string' ? /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match) throw new HttpError(400, tr('server.error.pictureType'));
  const data = Buffer.from(match[1]!, 'base64');
  const type = PICTURE_TYPES.find((candidate) => candidate.matches(data));
  if (!type) throw new HttpError(400, tr('server.error.pictureType'));
  if (data.length > config.god.maxPictureBytes) throw new HttpError(413, tr('server.error.pictureSize'));
  return { mime: type.mime, data };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // An oversized body is read to its end but not kept. Answering before the
    // sender has finished can reset the connection, and the sender never sees the error.
    if (size <= maxBytes) chunks.push(chunk as Buffer);
  }
  if (size > maxBytes) throw new HttpError(413, 'Request body too large.');
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new HttpError(400, 'The request body must be a JSON object.');
}

/**
 * Other websites open in the streamer's browser must not be able to control
 * the game. Browsers send an Origin header on such requests; accept only our own.
 */
function isForeignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export function startGameServer(options: GameServerOptions): Promise<GameServer> {
  const { store, root, getSource, now } = options;
  const random = options.random ?? Math.random;
  applyTuning(store);
  addLanguagesFrom(join(root, 'lang'));
  /** The texts the server writes, in the language the streamer chose; read anew each time, so a change applies at once. */
  const tr = (key: string, params?: Record<string, string | number>): string => translator(languageOf(store))(key, params);
  const emotes = options.emotes ?? new EmoteRegistry({ fetchJson: async () => null, log: () => {} });
  const emoteImages = options.emoteImages ?? new EmoteImages();
  const runner = new BattleRunner(
    (message) => sendAll(JSON.stringify(message)),
    (fighter) => {
      const display = store.displaySettings();
      return emotes.fighterEmote(fighter.emote, fighter.id, {
        sources: display.emoteSources,
        random: display.randomEmotes,
        // The god and its minions never get a random emote: they show the god's own, or none.
        special: fighter.minion || fighter.id === 'god',
      });
    },
    () => store.getSetting('obstacles') !== '0',
    () => bannerPlace(store.getSetting('map_banner')),
  );
  const war = new EventRunner({
    battles: runner,
    send: (message: object) => sendAll(JSON.stringify(message)),
    onChange: () => broadcast(),
    // The closing was written in the language chosen when the event started.
    onFinish: (closing) => announceInChat(tr('server.chat.closing', closing)),
  });

  /** Writes a result in chat, if the streamer switched that on and a token allows it. */
  function announceInChat(text: string): void {
    if (store.getSetting('chat_announce') !== '1' || !options.chat?.canSay()) return;
    options.chat.say(tr('server.chat.announce', { text }));
  }

  /**
   * How long the server was ever too busy to answer, over the last minute: a
   * pause of more than a battle step (50 ms) shows on the overlay as a stutter.
   */
  const pauses = monitorEventLoopDelay({ resolution: 10 });
  pauses.enable();
  let lastMinutePauses = { longestMs: 0, p99Ms: 0 };
  const pauseTimer = setInterval(() => {
    lastMinutePauses = { longestMs: pauses.max / 1e6, p99Ms: pauses.percentile(99) / 1e6 };
    pauses.reset();
  }, 60_000);
  pauseTimer.unref();

  /** Chat messages seen since the start, for the status page. */
  const chatSeen = { messages: 0, lastAt: null as number | null };
  /** Open overlay pages and control panels; overlays report their frame times. */
  const overlayPages = new Map<WebSocket, OverlayInfo>();
  let controlPages = 0;
  const newSeed = (): number => Math.floor(random() * 2 ** 31);

  /** Starts an event. Engine constructors throw an Error with a message for the streamer. */
  function startEvent(create: () => EventEngine, label: string): void {
    // The endless mode is decoration: any real event takes the screen from it.
    if (endless) stopEndless();
    if (war.running || runner.running || countdown) throw new HttpError(409, tr('server.error.busy'));
    let engine: EventEngine;
    try {
      engine = create();
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : tr('server.error.eventFailed'));
    }
    war.start(engine, label);
  }

  function startWar(): void {
    startEvent(() => {
      if (store.recentlyActive(now() - config.server.activeWindowMs, now()).length === 0) {
        throw new Error(tr('server.war.needsActive'));
      }
      return new WarEngine(store, now, newSeed());
    }, tr('mode.war'));
  }
  // --- Countdown fights --------------------------------------------------------

  /** A running countdown: chatters who write before it ends can be drawn for the fight. */
  let countdown: {
    mode: DraftMode;
    endsAt: number;
    writers: Map<string, UserRow>;
    recent: string[];
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  const send = (message: object): void => sendAll(JSON.stringify(message));
  const countdownTitle = (mode: DraftMode): string =>
    tr(mode === 'free' ? 'mode.freeForAll' : mode === 'pachinko' ? 'mode.pachinko' : 'mode.guildClash');

  function sendCountdown(): void {
    if (!countdown) return;
    send({
      type: 'countdown',
      title: countdownTitle(countdown.mode),
      subtitle: tr('server.countdown.subtitle'),
      remainingMs: Math.max(0, countdown.endsAt - Date.now()),
      joined: countdown.writers.size,
      recent: countdown.recent,
      // During a countdown the overlay shows the map banner instead of the corner panels.
      banner: bannerStrip(bannerPlace(store.getSetting('map_banner'))),
    });
  }

  function startCountdown(mode: DraftMode): void {
    if (endless) stopEndless();
    if (war.running || runner.running || countdown) throw new HttpError(409, tr('server.error.busy'));
    countdown = {
      mode,
      endsAt: Date.now() + config.draft.countdownMs,
      writers: new Map(),
      recent: [],
      timer: setInterval(() => {
        if (countdown && Date.now() >= countdown.endsAt) finishCountdown();
        else sendCountdown();
      }, 500),
    };
    sendCountdown();
    broadcast();
  }

  function cancelCountdown(): void {
    if (!countdown) return;
    clearInterval(countdown.timer);
    countdown = null;
    send({ type: 'countdown', done: true });
  }

  function finishCountdown(): void {
    if (!countdown) return;
    const { mode, writers } = countdown;
    cancelCountdown();
    const seed = newSeed();
    // Chatters excluded or reassigned during the countdown drop out here.
    const eligible = [...writers.keys()]
      .map((id) => store.getUser(id))
      .filter((user): user is UserRow => user !== null && user.guild_id !== null)
      .filter((user) => !store.excludedLogins().includes(user.login));
    const picks = drawFighters(eligible, mode, createRng(seed));
    const problem = drawProblem(picks, mode, languageOf(store));
    if (problem) {
      send({ type: 'announce', title: countdownTitle(mode), subtitle: problem, holdMs: config.war.summaryHoldMs });
    } else if (mode === 'pachinko') {
      const look = (user: UserRow) => {
        const display = store.displaySettings();
        return { emote: emotes.fighterEmote(user.emote_id, user.user_id, { sources: display.emoteSources, random: display.randomEmotes, special: false }) };
      };
      war.start(
        new PachinkoEngine(seed, picks, look, languageOf(store), bannerPlace(store.getSetting('map_banner'))),
        countdownTitle(mode),
      );
    } else {
      war.start(new DraftEngine(store, now, seed, mode, picks), countdownTitle(mode));
    }
    broadcast();
  }

  function onChat(event: ChatMessageEvent): void {
    chatSeen.messages++;
    chatSeen.lastAt = Date.now();
    if (!countdown || countdown.writers.has(event.userId)) return;
    const user = store.isPlayer(event) ? store.getUser(event.userId) : null;
    if (!user || user.guild_id === null) return;
    countdown.writers.set(user.user_id, user);
    countdown.recent = [...countdown.recent, user.display_name].slice(-8);
  }

  // --- Endless mode ------------------------------------------------------------

  /** Set while the endless mode is on: the timer that renews its roster. */
  let endless: { timer: ReturnType<typeof setInterval> } | null = null;

  /** Starts (or restarts) the endless free-for-all with the chatters active right now. */
  function runEndlessBattle(): void {
    const seed = newSeed();
    const rng = createRng(seed);
    const active = store.recentlyActive(now() - config.server.activeWindowMs, now());
    for (let i = active.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [active[i], active[j]] = [active[j]!, active[i]!];
    }
    const roster = active.slice(0, config.endless.roster);
    if (roster.length < 2) {
      throw new Error(tr('server.error.endlessNeedsTwo'));
    }
    const colors = Object.fromEntries(config.guilds.list.map((guild) => [guild.id, guild.color]));
    const fighters: FighterSpec[] = roster.map((user) => ({
      id: user.user_id,
      name: user.display_name,
      color: user.color,
      emote: user.emote_id,
      side: user.user_id,
      level: 0,
    }));
    assignClasses(fighters, rng);
    runner.stop();
    runner.start(
      {
        seed,
        endless: true,
        field: { total: store.endlessConcurrent() },
        sizeBalance: false,
        fortune: false,
        levelBonus: false,
        sides: roster.map((user) => ({ id: user.user_id, damageBonus: 0, healthBonus: 0 })),
        fighters,
      },
      {
        title: tr('mode.endless'),
        ambient: true,
        sides: roster.map((user) => ({ id: user.user_id, name: user.display_name, color: colors[user.guild_id]! })),
      },
    );
  }

  function startEndless(): void {
    if (war.running || countdown || (runner.running && !endless)) {
      throw new HttpError(409, tr('server.error.busy'));
    }
    try {
      runEndlessBattle();
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : tr('server.error.endlessFailed'));
    }
    if (endless) clearInterval(endless.timer);
    endless = {
      // Renew the roster now and then, so chatters who arrived later get their turn.
      timer: setInterval(() => {
        try {
          runEndlessBattle();
        } catch {
          stopEndless();
          broadcast();
        }
      }, config.endless.refreshMs),
    };
  }

  function stopEndless(): void {
    if (!endless) return;
    clearInterval(endless.timer);
    endless = null;
    runner.stop();
  }

  const snapshot = (): ServerSnapshot => ({
    ...buildSnapshot(
      store,
      getSource(),
      now(),
      war.title ?? (countdown ? tr('server.countdown.label', { mode: countdownTitle(countdown.mode) }) : endless ? null : runner.title),
      endless !== null,
      listThemes(root),
    ),
    // The setup guide's steps that the game state does not show by itself.
    mapBanner: bannerPlace(store.getSetting('map_banner')) ?? 'off',
    guide: {
      overlays: overlayPages.size,
      testBattleRun: store.getSetting('test_battle_run') === '1',
      withoutGpu: [...overlayPages.values()].filter((page) => page.gpu === false).length,
    },
    chatAnnounce: { available: options.chat?.canSay() ?? false, enabled: store.getSetting('chat_announce') === '1' },
    runtimes: estimatedRuntimes(),
    data: { resettable: Boolean(options.onDatabase) && Boolean(databaseSize(options.databasePath)) },
    version: options.version?.() ?? { current: '', latest: null },
  });

  /** A battle between the given guilds that changes nothing in the game. */
  function startTestBattle(requested: unknown): void {
    const all = config.guilds.list.map((guild) => guild.id);
    let sides: GuildId[] = all;
    if (requested !== undefined) {
      const valid =
        Array.isArray(requested) &&
        requested.length >= 2 &&
        new Set(requested).size === requested.length &&
        requested.every((id) => all.includes(id as GuildId));
      if (!valid) throw new HttpError(400, '`sides` must be two or three different guild ids.');
      sides = requested as GuildId[];
    }
    if (endless) stopEndless();
    if (runner.running || war.running || countdown) throw new HttpError(409, tr('server.error.busy'));

    const { setup, meta } = prepareBattle(store, {
      title: tr('mode.testBattle'),
      sides,
      seed: Math.floor(random() * 2 ** 31),
      now: now(),
    });
    setup.toughness = toughnessFor('war', setup.fighters.length);
    const present = new Set(setup.fighters.map((f) => f.side));
    if (present.size < 2) {
      // Too quiet for a real line-up (setting up before a stream, say): stand-ins
      // fill the empty guilds, so the overlay can still be checked.
      const rng = createRng(setup.seed);
      for (const side of sides) {
        if (present.has(side)) continue;
        for (let i = 1; i <= config.battle.standIns; i++) {
          setup.fighters.push({ id: `stand-in:${side}:${i}`, name: tr('server.test.standIn', { n: i }), color: null, side, level: 1 });
        }
      }
      assignClasses(setup.fighters, rng);
      meta.title = tr('server.test.withStandIns');
    }
    runner.start(setup, meta, () => broadcast());
    // The setup guide's last step: the streamer saw a battle on the overlay.
    store.setSetting('test_battle_run', '1');
  }

  /** Starts one of the god's fights. */
  function startGod(kind: GodStartKind): void {
    startEvent(
      () => new GodEngine(store, now, newSeed(), kind, getSource().channel),
      tr(kind === 'wrath' ? 'mode.godsWrath' : kind === 'friendly' ? 'mode.friendly' : 'mode.streamerVsChat'),
    );
  }

  /** Stops whatever is on screen: a countdown, an event with its current battle, endless mode or a test battle. */
  function stopAll(): void {
    cancelCountdown();
    war.stop();
    stopEndless();
    runner.stop();
  }

  function checkActionKey(given: string | null): void {
    const key = options.actionKey;
    if (!key) throw new HttpError(404, tr('server.error.actionsOff'));
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(key);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(403, tr('server.error.actionKey'));
    }
  }

  /** Does what an action link names; returns a line saying what happened. Throws an HttpError when it cannot. */
  function runAction(name: ActionName): string {
    const session = store.activeSession();
    switch (name) {
      case 'war':
        startWar();
        return tr('server.action.war');
      case 'hero-clash':
        startEvent(() => new ClashEngine(store, now, newSeed()), tr('mode.heroClash'));
        return tr('server.action.heroClash');
      case 'guild-clash':
        startCountdown('guild');
        return tr('server.action.guildClash');
      case 'free-for-all':
        startCountdown('free');
        return tr('server.action.freeForAll');
      case 'pachinko':
        startCountdown('pachinko');
        return tr('server.action.pachinko');
      case 'gods-wrath':
        startGod('wrath');
        return tr('server.action.godsWrath');
      case 'streamer-vs-chat':
        startGod('versus');
        return tr('server.action.streamerVsChat');
      case 'friendly-fight':
        startGod('friendly');
        return tr('server.action.friendly');
      case 'endless':
        return runAction(endless ? 'endless-off' : 'endless-on');
      case 'endless-on':
        if (!endless) startEndless();
        return tr('server.action.endlessOn');
      case 'endless-off':
        stopEndless();
        return tr('server.action.endlessOff');
      case 'layer':
        return runAction(session ? 'layer-off' : 'layer-on');
      case 'layer-on':
        if (!getSource().channel) throw new HttpError(409, tr('server.error.channelFirst'));
        if (!session) store.startSession(now());
        return tr('server.action.layerOn');
      case 'layer-off':
        if (session) store.endSession(now());
        return tr('server.action.layerOff');
      case 'test-battle':
        startTestBattle(undefined);
        return tr('server.action.testBattle');
      case 'stop':
        stopAll();
        return tr('server.action.stop');
    }
  }

  /** What the status tab shows: is chat coming in, are the emote sources reachable, how do the overlays run. */
  function status(): object {
    const source = getSource();
    return {
      version: options.version?.() ?? { current: '', latest: null },
      node: process.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      chat: {
        kind: source.kind,
        channel: source.channel,
        status: source.status,
        messages: chatSeen.messages,
        lastMessageAt: chatSeen.lastAt,
        canSay: options.chat?.canSay() ?? false,
        announce: store.getSetting('chat_announce') === '1',
      },
      emotes: emotes.status(),
      overlays: [...overlayPages.values()],
      controlPanels: controlPages,
      database: databaseSize(options.databasePath),
      running: war.title ?? runner.title ?? null,
      // The longest pause in the running minute, or the last full one when that was worse.
      serverPauseMs: Math.max(pauses.max / 1e6, lastMinutePauses.longestMs),
    };
  }

  /** Sends a consistent copy of the channel's database as a download. */
  async function exportDatabase(res: ServerResponse): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), 'chroma-clash-'));
    const file = join(folder, 'export.sqlite');
    try {
      store.copyTo(file);
      const name = `chroma-clash-${getSource().channel || 'game'}-${new Date().toISOString().slice(0, 10)}.sqlite`;
      res.writeHead(200, {
        'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      await pipeline(createReadStream(file), res);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  /** Receives a database file, checks it, and hands it over to replace the channel's game. */
  async function importDatabase(req: IncomingMessage): Promise<void> {
    const target = options.databasePath;
    if (!options.onDatabase || !databaseSize(target)) {
      throw new HttpError(409, tr('server.error.importFirst'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= MAX_IMPORT_BYTES) chunks.push(chunk as Buffer);
    }
    if (size > MAX_IMPORT_BYTES) throw new HttpError(413, tr('server.error.importTooLarge'));
    const data = Buffer.concat(chunks);
    if (!data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'))) {
      throw new HttpError(400, tr('server.error.notSqlite'));
    }
    const file = join(dirname(target!), `import-${Date.now()}.sqlite`);
    writeFileSync(file, data);
    const problem = databaseProblem(file);
    if (problem) {
      rmSync(file, { force: true });
      throw new HttpError(400, tr(`server.error.${problem}`));
    }
    const onDatabase = options.onDatabase;
    // The switch closes this server: it happens once the answer is on its way.
    setTimeout(() => onDatabase({ kind: 'import', file }), 50);
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    let relative = pathname;
    if (relative === '/') relative = '/control/';
    if (relative.endsWith('/')) relative += 'index.html';
    const page = relative.split('/')[1] ?? '';
    const file = normalize(join(root, relative));
    const allowed = PAGES.includes(page) && file.startsWith(join(root, page) + sep);
    if (!allowed) throw new HttpError(404, 'Not found.');
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
  }

  async function handleApi(req: IncomingMessage, pathname: string, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, snapshot());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      sendJson(res, 200, { seasons: store.seasonHistory() });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/god/picture') {
      const picture = store.godPicture();
      if (!picture) throw new HttpError(404, 'No picture was uploaded.');
      // The address carries a version, so each version can be cached for good.
      res.writeHead(200, {
        'content-type': picture.mime,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      res.end(picture.data);
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/api/action/')) {
      // A Stream Deck button or an OBS hotkey: a plain link with the secret key.
      checkActionKey(new URL(req.url ?? '/', 'http://localhost').searchParams.get('key'));
      const name = pathname.slice('/api/action/'.length);
      if (!(ACTIONS as readonly string[]).includes(name)) throw new HttpError(404, `No action "${name}". Known: ${ACTIONS.join(', ')}.`);
      const done = runAction(name as ActionName);
      broadcast();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(done);
      return;
    }
    if (isForeignOrigin(req)) throw new HttpError(403, 'Requests from other sites are not allowed.');
    if (req.method === 'GET' && pathname === '/api/actions') {
      // Only pages of this server can read this answer: the key stays with the streamer.
      sendJson(res, 200, { key: options.actionKey ?? null, actions: ACTIONS });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, status());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/database/export') {
      await exportDatabase(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/database/import') {
      await importDatabase(req);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // A picture is larger than any other request; base64 adds a third on top of the file size.
    const isPicture = pathname === '/api/god/picture';
    const body = await readJson(req, isPicture ? config.god.maxPictureBytes * 1.4 + 1_000 : MAX_BODY_BYTES);

    if (pathname === '/api/session') {
      if (typeof body.active !== 'boolean') throw new HttpError(400, '`active` must be true or false.');
      if (body.active) store.startSession(now());
      else store.endSession(now());
    } else if (pathname === '/api/channel') {
      const channel = normalizeChannel(body.channel);
      if (!channel) throw new HttpError(400, tr('server.error.channelName'));
      if (!options.onChannel) throw new HttpError(409, tr('server.error.simulator'));
      const onChannel = options.onChannel;
      // The switch closes this server: it happens once the answer is on its way.
      setTimeout(() => onChannel(channel), 50);
    } else if (pathname === '/api/channel-size') {
      const chatters = body.chatters;
      if (chatters === null) {
        store.setManualChatters(null);
      } else if (typeof chatters === 'number' && Number.isFinite(chatters) && chatters > 0) {
        store.setManualChatters(chatters);
      } else {
        throw new HttpError(400, tr('server.error.chatters'));
      }
    } else if (pathname === '/api/test-battle') {
      startTestBattle(body.sides);
    } else if (pathname === '/api/war/start') {
      startWar();
    } else if (pathname === '/api/clash/start') {
      startEvent(() => new ClashEngine(store, now, newSeed()), tr('mode.heroClash'));
    } else if (pathname === '/api/god/skills') {
      const known = typeof body.skill === 'string' && body.skill in config.skills.names;
      if (!known || typeof body.enabled !== 'boolean') {
        throw new HttpError(400, '`skill` must be a god skill and `enabled` true or false.');
      }
      store.setGodSkill(body.skill as SkillId, body.enabled);
    } else if (pathname === '/api/god/picture') {
      store.setGodPicture(body.image === null ? null : decodePicture(body.image, tr));
    } else if (pathname === '/api/god/start') {
      if (body.kind !== 'wrath' && body.kind !== 'versus' && body.kind !== 'friendly') {
        throw new HttpError(400, '`kind` must be "wrath", "versus" or "friendly".');
      }
      startGod(body.kind);
    } else if (pathname === '/api/battle/stop') {
      stopAll();
    } else if (pathname === '/api/overlay') {
      // Move, show or hide a panel: { map: { x, y, visible, reset }, stats: { ... } }.
      // Switch a statistics line: { line: { id, enabled } }.
      let changed = false;
      for (const panel of ['map', 'stats'] as const) {
        const change = body[panel];
        if (change === undefined) continue;
        if (typeof change !== 'object' || change === null) {
          throw new HttpError(400, `\`${panel}\` must be an object with x, y, visible or reset.`);
        }
        const { x, y, visible, reset } = change as Record<string, unknown>;
        const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
        if ((x !== undefined && !isNumber(x)) || (y !== undefined && !isNumber(y))) {
          throw new HttpError(400, '`x` and `y` must be numbers, in screen pixels.');
        }
        if (visible !== undefined && typeof visible !== 'boolean') {
          throw new HttpError(400, '`visible` must be true or false.');
        }
        store.setOverlayPanel(panel, { x, y, visible, reset: reset === true });
        changed = true;
      }
      if (body.line !== undefined) {
        const { id, enabled } = (body.line ?? {}) as Record<string, unknown>;
        if (!config.overlay.statLines.includes(id as StatId) || typeof enabled !== 'boolean') {
          throw new HttpError(400, '`line` must name a statistics line and `enabled` be true or false.');
        }
        store.setStatLine(id as StatId, enabled);
        changed = true;
      }
      if (!changed) throw new HttpError(400, 'Send `map`, `stats` or `line`.');
      // Panels are kept inside the screen: store what was actually used.
      const panels = overlayPanels(store);
      for (const panel of ['map', 'stats'] as const) store.setOverlayPanel(panel, { x: panels[panel].x, y: panels[panel].y });
      // A running endless fight must keep off the panels where they are now.
      if (endless) startEndless();
    } else if (pathname === '/api/draft/start') {
      if (body.mode !== 'guild' && body.mode !== 'free' && body.mode !== 'pachinko') {
        throw new HttpError(400, '`mode` must be "guild", "free" or "pachinko".');
      }
      startCountdown(body.mode);
    } else if (pathname === '/api/endless') {
      if (body.concurrent !== undefined) {
        const { minConcurrent, maxConcurrent } = config.endless;
        const value = body.concurrent;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < minConcurrent || value > maxConcurrent) {
          throw new HttpError(400, `\`concurrent\` must be a number from ${minConcurrent} to ${maxConcurrent}.`);
        }
        store.setEndlessConcurrent(value);
        // A change applies at once to a running endless fight.
        if (endless && body.active === undefined) startEndless();
      }
      if (body.active === true) startEndless();
      else if (body.active === false) stopEndless();
      else if (body.concurrent === undefined) {
        throw new HttpError(400, 'Send `active` (true or false), `concurrent` (a number), or both.');
      }
    } else if (pathname === '/api/display') {
      // Any subset of: theme, pixelateEmotes, animatedEmotes, randomEmotes, emoteSources, language.
      const change: Parameters<Store['setDisplay']>[0] = {};
      const known = ['theme', 'pixelateEmotes', 'animatedEmotes', 'randomEmotes', 'emoteSources', 'language'];
      const unknown = Object.keys(body).filter((key) => !known.includes(key));
      if (unknown.length > 0 || Object.keys(body).length === 0) {
        throw new HttpError(400, `Send any of: ${known.join(', ')}.`);
      }
      if (body.theme !== undefined) {
        if (typeof body.theme !== 'string' || !listThemes(root, 0).some((theme) => theme.id === body.theme)) {
          throw new HttpError(400, '`theme` must be the id of an installed theme.');
        }
        change.theme = body.theme;
      }
      for (const flag of ['pixelateEmotes', 'animatedEmotes', 'randomEmotes'] as const) {
        if (body[flag] === undefined) continue;
        if (typeof body[flag] !== 'boolean') throw new HttpError(400, `\`${flag}\` must be true or false.`);
        change[flag] = body[flag];
      }
      if (body.emoteSources !== undefined) {
        const sources = body.emoteSources;
        if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) {
          throw new HttpError(400, '`emoteSources` must be an object such as { "bttv": false }.');
        }
        const entries = Object.entries(sources as Record<string, unknown>);
        const valid = entries.every(
          ([key, value]) => (THIRD_PARTY_SOURCES as string[]).includes(key) && typeof value === 'boolean',
        );
        if (!valid || entries.length === 0) {
          throw new HttpError(400, '`emoteSources` may switch bttv, ffz and 7tv, each true or false.');
        }
        change.emoteSources = Object.fromEntries(entries) as Partial<Record<ThirdPartySource, boolean>>;
      }
      if (body.language !== undefined && !isLanguage(body.language)) {
        throw new HttpError(400, `\`language\` must be one of: ${languageList().map((l) => l.id).join(', ')}.`);
      }
      if (Object.keys(change).length > 0) store.setDisplay(change);
      if (body.language !== undefined) store.setSetting('language', body.language as string);
    } else if (pathname === '/api/season/start') {
      if (body.mode !== 'equal' && body.mode !== 'random') {
        throw new HttpError(400, '`mode` must be "equal" or "random".');
      }
      store.setSeasonStart(body.mode);
    } else if (pathname === '/api/season/end') {
      if (body.confirm !== true) throw new HttpError(400, 'Ending a season must be confirmed.');
      if (war.running || runner.running) {
        throw new HttpError(409, tr('server.error.seasonBusy'));
      }
      store.endSeason(now(), random());
    } else if (pathname === '/api/exclusions') {
      if (typeof body.login !== 'string' || typeof body.excluded !== 'boolean') {
        throw new HttpError(400, '`login` must be a name and `excluded` true or false.');
      }
      if (!/^@?[A-Za-z0-9_]{1,25}$/.test(body.login.trim())) {
        throw new HttpError(400, tr('server.error.login'));
      }
      store.setExcluded(body.login, body.excluded);
    } else if (pathname === '/api/tuning') {
      const value = body.value;
      if (typeof body.key !== 'string' || !(value === null || typeof value === 'number')) {
        throw new HttpError(400, '`key` must be a tuning value and `value` a number, or null to reset.');
      }
      try {
        setTuning(store, body.key, value);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid value.');
      }
    } else if (pathname === '/api/settings') {
      const known = ['warCommand', 'obstacles', 'chatAnnounce'].filter((key) => key in body);
      if (known.length === 0 || known.some((key) => typeof body[key] !== 'boolean')) {
        throw new HttpError(400, '`warCommand`, `obstacles` and `chatAnnounce` must be true or false.');
      }
      if ('warCommand' in body) store.setSetting('war_command', body.warCommand ? '1' : '0');
      if ('obstacles' in body) store.setSetting('obstacles', body.obstacles ? '1' : '0');
      if ('chatAnnounce' in body) store.setSetting('chat_announce', body.chatAnnounce ? '1' : '0');
    } else if (pathname === '/api/map-banner') {
      if (body.place !== 'top' && body.place !== 'bottom' && body.place !== 'off') {
        throw new HttpError(400, '`place` must be "top", "bottom" or "off".');
      }
      store.setSetting('map_banner', body.place);
    } else if (pathname === '/api/database/reset') {
      const channel = getSource().channel;
      if (!options.onDatabase || !databaseSize(options.databasePath)) {
        throw new HttpError(409, tr('server.error.noSavedGame'));
      }
      if (body.confirm !== channel) throw new HttpError(400, tr('server.error.confirmReset', { channel }));
      const onDatabase = options.onDatabase;
      // The reset closes this server: it happens once the answer is on its way.
      setTimeout(() => onDatabase({ kind: 'reset' }), 50);
    } else {
      throw new HttpError(404, 'Not found.');
    }
    broadcast();
    sendJson(res, 200, snapshot());
  }

  /** GET /emotes/<source>/<id>?animated=0|1: an emote image, fetched once and then served from the cache. */
  async function serveEmote(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const parts = url.pathname.split('/');
    if (parts.length !== 4) throw new HttpError(404, 'Not found.');
    let id: string;
    try {
      id = decodeURIComponent(parts[3]!);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    const image = await emoteImages.get(parts[2]!, id, url.searchParams.get('animated') === '1');
    if (!image) throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      'content-type': image.type,
      'cache-control': 'public, max-age=604800',
      'x-content-type-options': 'nosniff',
    });
    res.end(image.data);
  }

  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const work = pathname.startsWith('/api/')
      ? handleApi(req, pathname, res)
      : pathname.startsWith('/emotes/')
        ? serveEmote(req, url, res)
        : serveStatic(pathname, res);
    work.catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const message = error instanceof HttpError ? error.message : 'Internal error.';
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });

  // Pages of other websites must not listen in or talk to the game.
  const sockets = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: 64 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => !isForeignOrigin(req),
  });
  let lastSent = '';

  function sendAll(message: string): void {
    for (const client of sockets.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }

  /** Set once the server shuts down: its store may already be closed, so nothing reads it any more. */
  let closing = false;

  function broadcast(): void {
    if (closing) return;
    const message = JSON.stringify({ type: 'state', state: snapshot() });
    if (message === lastSent) return;
    lastSent = message;
    sendAll(message);
  }

  sockets.on('connection', (socket, req) => {
    if (closing) {
      socket.terminate();
      return;
    }
    // Overlays and control panels say which they are; overlays then report how fast they draw.
    const page = new URL(req.url ?? '/', 'http://localhost').searchParams.get('page');
    if (page === 'overlay') {
      overlayPages.set(socket, { connectedAt: Date.now(), reportedAt: null });
      socket.on('message', (data) => {
        let message: unknown;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'overlay-stats') return;
        const report = readOverlayReport(message as Record<string, unknown>);
        const info = overlayPages.get(socket);
        if (!report || !info) return;
        overlayPages.set(socket, { ...info, ...report, reportedAt: Date.now() });
        // The panel warns as soon as an overlay turns out to draw without the graphics card.
        if (report.gpu === false && info.gpu !== false) broadcast();
      });
      socket.on('close', () => {
        overlayPages.delete(socket);
        broadcast();
      });
      broadcast();
    } else if (page === 'control') {
      controlPages++;
      socket.on('close', () => controlPages--);
    }
    socket.send(JSON.stringify({ type: 'state', state: snapshot() }));
    // A page that opens during a battle joins it in progress.
    const running = runner.startMessage() ?? war.showMessage();
    if (running) socket.send(JSON.stringify(running));
  });

  const timer = setInterval(broadcast, config.server.broadcastIntervalMs);

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? config.server.port, options.host ?? config.server.host, () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        broadcast,
        startWar: () => {
          try {
            startWar();
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : 'The War could not start.');
          }
        },
        warCommandEnabled: () => store.getSetting('war_command') === '1',
        onChat,
        centerReclaimed: () => broadcast(),
        seasonWon: (winner) => {
          // The map was dealt anew: whatever was being fought over is gone.
          cancelCountdown();
          war.stop();
          if (!endless) runner.stop();
          const guild = guildName(languageOf(store), winner);
          const season = store.lastSeason();
          // The design the winner built in the season that just ended; a new season deals new ones.
          const design = store.seasonHistory()[0]?.summary?.guilds[winner]?.design ?? 0;
          send({
            type: 'announce',
            title: tr('server.season.wins', { guild, season: season?.season_id ?? '' }).trim(),
            subtitle: tr('server.season.winsSubtitle'),
            map: {},
            celebrate: { guild: winner, design },
            holdMs: config.war.summaryHoldMs,
          });
          announceInChat(tr('server.season.winsChat', { guild, season: season?.season_id ?? '' }));
          broadcast();
        },
        close: () =>
          new Promise<void>((done) => {
            closing = true;
            clearInterval(pauseTimer);
            pauses.disable();
            clearInterval(timer);
            cancelCountdown();
            war.stop();
            stopEndless();
            runner.stop();
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
