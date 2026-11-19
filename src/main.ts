/**
 * Starts the game: chat source, database, and the local server for the overlay
 * and the control panel.
 *
 *   node src/main.ts                           read the channel saved in the control panel
 *   node src/main.ts --channel <name>          read this channel (and remember it)
 *   node src/main.ts --sim [--speed 60]        use the chat simulator (--channel names its channel)
 *
 * Without a channel yet, the server starts and the control panel asks for it.
 * Options: --port 4747, --data <folder> (default data/), --db <file>, --chatters 60, --seed 1,
 * --open / --no-open (open the control panel in the browser; default on only in the packaged build).
 * A real chat logs in anonymously unless TWITCH_TOKEN and TWITCH_LOGIN are set.
 */
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newActionKey, normalizeChannel, readAppSettings, writeAppSettings } from './app-settings.ts';
import { config } from './config.ts';
import { Store } from './db/store.ts';
import { IrcClient } from './irc/client.ts';
import type { ChatMessageEvent } from './irc/events.ts';
import { startGameServer, type GameServer } from './server/server.ts';
import type { SourceInfo } from './server/state.ts';
import { SimulatedChatSource } from './sim/chat.ts';
import { EmoteImages } from './emotes/images.ts';
import { EmoteRegistry } from './emotes/registry.ts';
import { openBrowser } from './util/open-browser.ts';
import { appVersion, checkForUpdate, type UpdateInfo } from './update-check.ts';

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    sim: { type: 'boolean', default: false },
    speed: { type: 'string', default: '1' },
    chatters: { type: 'string', default: String(config.sim.chatterCount) },
    seed: { type: 'string', default: '1' },
    port: { type: 'string', default: String(config.server.port) },
    db: { type: 'string' },
    data: { type: 'string' },
    // Opens the control panel in the browser: on by default only in the packaged build.
    open: { type: 'boolean', default: isSea() },
  },
  allowNegative: true,
});

// The packaged build keeps overlay/, control/ and data/ next to the executable.
const root = isSea() ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = values.data ?? join(root, 'data');
const settingsFile = join(dataDir, 'settings.json');

if (values.channel !== undefined && !normalizeChannel(values.channel)) {
  console.error(`"${values.channel}" is not a Twitch channel name: 3 to 25 letters, digits or underscores.`);
  process.exit(1);
}
let channel: string | null = values.sim
  ? normalizeChannel(values.channel) ?? 'simchannel'
  : normalizeChannel(values.channel) ?? readAppSettings(settingsFile).channel ?? null;
if (!values.sim && values.channel) writeAppSettings(settingsFile, { ...readAppSettings(settingsFile), channel: channel! });

// The secret of the action links for a Stream Deck or OBS hotkeys, made once and kept.
let actionKey = readAppSettings(settingsFile).actionKey;
if (!actionKey) {
  actionKey = newActionKey();
  writeAppSettings(settingsFile, { ...readAppSettings(settingsFile), actionKey });
}

// BetterTTV, FrankerFaceZ and 7TV: the global sets now, the channel's once chat tells its id.
const emotes = new EmoteRegistry();
void emotes.start();
const emoteImages = new EmoteImages({ cacheDir: join(dataDir, 'emote-cache') });

let store: Store;
let source: SourceInfo;
let server: GameServer | null = null;
let now: () => number = Date.now;
let stopSource: () => void = () => {};
let dbPath = '';
/** Writing in chat: with a Twitch token, or the simulator's pretend chat (printed to the console). */
let chat: { canSay(): boolean; say(text: string): boolean } | null = null;

function onChat(event: ChatMessageEvent): void {
  emotes.setChannel(event.roomId);
  // The emote the chatter fights as: the last one in the message, from any switched-on source.
  event.emote = emotes.pickEmote(event, store.displaySettings().emoteSources);
  const result = store.recordMessage(event);
  // A tick can complete a guild's Monument, which ends the season on the spot.
  if (result?.seasonWonBy) server?.seasonWon(result.seasonWonBy);
  if (result?.centerReclaimed) server?.centerReclaimed();
  // A running countdown notes who wrote, after the author was recorded.
  server?.onChat(event);
  // The only chat command: the broadcaster or a moderator starts a War.
  const isCommand = event.text.trim().toLowerCase() === config.war.command;
  if (isCommand && (event.isBroadcaster || event.isModerator) && server?.warCommandEnabled()) {
    try {
      server.startWar();
    } catch (error) {
      console.error(`[war] ${event.displayName} typed ${config.war.command}: ${(error as Error).message}`);
    }
  }
}

/** Opens the channel's database and starts reading its chat. Without a channel: an empty game that waits. */
function openChannel(): void {
  if (!channel) {
    // Nothing is saved for good until a channel is known.
    dbPath = ':memory:';
    store = Store.open(dbPath);
    source = { kind: 'none', channel: '', status: 'waiting for the channel name' };
    now = Date.now;
    stopSource = () => {};
    chat = null;
    return;
  }
  dbPath = values.db ?? join(dataDir, `${values.sim ? 'sim-' : ''}${channel}.sqlite`);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  store = Store.open(dbPath);
  source = { kind: values.sim ? 'sim' : 'irc', channel, status: 'starting' };

  if (values.sim) {
    const sim = new SimulatedChatSource({
      seed: Number(values.seed),
      chatterCount: Number(values.chatters),
      channel,
      speed: Number(values.speed),
      // Earlier fast runs left the database in the simulated future: carry on from there.
      startAt: store.latestActivity() ?? undefined,
      onChat,
      // A few global BetterTTV and 7TV emotes, so simulated chat exercises them too.
      extraEmoteWords: () => [...emotes.globalWords('bttv').slice(0, 8), ...emotes.globalWords('7tv').slice(0, 8)],
    });
    now = () => sim.now();
    source.status = `simulating ${sim.chat.chatters.length} chatters at x${values.speed}`;
    sim.start();
    stopSource = () => sim.stop();
    chat = {
      canSay: () => true,
      say: (text) => {
        console.log(`[chat] ${text}`);
        return true;
      },
    };
    return;
  }
  now = Date.now;
  const irc = new IrcClient({
    channel,
    token: process.env.TWITCH_TOKEN,
    login: process.env.TWITCH_LOGIN,
    onChat,
    onStatus: (status) => {
      if (status.type === 'notice') return;
      source.status = status.type;
      console.error(`[irc] ${JSON.stringify(status)}`);
      server?.broadcast();
    },
  });
  irc.start();
  stopSource = () => irc.stop();
  chat = { canSay: () => irc.canSay, say: (text) => irc.say(text) };
}

async function startServer(): Promise<void> {
  server = await startGameServer({
    store,
    root,
    getSource: () => source,
    now,
    port: Number(values.port),
    emotes,
    emoteImages,
    // The simulator keeps its made-up channel; a real chat can be switched in the control panel.
    onChannel: values.sim ? undefined : (name) => void switchChannel(name),
    databasePath: dbPath,
    onDatabase: (change) => void changeDatabase(change),
    actionKey,
    chat: { canSay: () => chat?.canSay() ?? false, say: (text) => chat?.say(text) ?? false },
    version: () => ({
      current: appVersion,
      latest: update ? { version: update.latest, url: update.url, ...(update.notes ? { notes: update.notes } : {}) } : null,
    }),
  });
}

/**
 * Resets the channel's game, or replaces it with an imported database. The
 * current one is copied to data/backups/ first, so nothing is ever lost.
 */
async function changeDatabase(change: { kind: 'reset' } | { kind: 'import'; file: string }): Promise<void> {
  if (switching || dbPath === ':memory:') return;
  switching = true;
  try {
    const backups = join(dataDir, 'backups');
    mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = join(backups, `${basename(dbPath, '.sqlite')}-${stamp}-before-${change.kind}.sqlite`);
    store.copyTo(backup);
    console.log(`${change.kind === 'reset' ? 'Resetting' : 'Importing'} the game; the old one is kept in ${backup}`);
    stopSource();
    await server?.close();
    server = null;
    store.close();
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(file, { force: true });
    if (change.kind === 'import') renameSync(change.file, dbPath);
    openChannel();
    await startServer();
    announce();
  } finally {
    switching = false;
  }
}

/** Reads another channel: its own database, its own chat. The pages reconnect by themselves. */
let switching = false;
async function switchChannel(name: string): Promise<void> {
  if (switching || name === channel) return;
  switching = true;
  try {
    console.log(`Switching to #${name}…`);
    writeAppSettings(settingsFile, { ...readAppSettings(settingsFile), channel: name });
    stopSource();
    await server?.close();
    server = null;
    store.close();
    channel = name;
    openChannel();
    await startServer();
    announce();
  } finally {
    switching = false;
  }
}

function announce(): void {
  if (channel) console.log(`Chroma Clash is running for #${channel} (database: ${dbPath})`);
  else console.log('Chroma Clash is running. Enter your Twitch channel in the control panel to begin.');
  console.log(`  Control panel: http://localhost:${server!.port}/control/`);
  console.log(`  Overlay (OBS browser source, 1920x1080): http://localhost:${server!.port}/overlay/`);
}

openChannel();
await startServer();
announce();
if (values.open) openBrowser(`http://localhost:${server!.port}/control/`);

// A newer version, if the website announces one (config.updates.url); the control panel shows it.
let update: UpdateInfo | null = null;
async function lookForUpdate(): Promise<void> {
  const found = await checkForUpdate(appVersion, config.updates.url);
  if (found && found.latest !== update?.latest) {
    update = found;
    console.log(`Chroma Clash ${found.latest} is available (this is ${appVersion}): ${found.url}`);
    server?.broadcast();
  }
}
if (config.updates.url) {
  void lookForUpdate();
  setInterval(() => void lookForUpdate(), config.updates.everyMs).unref();
}

async function shutdown(): Promise<void> {
  stopSource();
  emotes.stop();
  await server?.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
