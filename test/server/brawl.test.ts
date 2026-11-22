import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { startGameServer, type GameServer, type ServerSnapshot } from '../../src/server/server.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = 1_700_000_100_000;
let store: Store;
let server: GameServer;
let base: string;

before(async () => {
  store = Store.open(':memory:');
  server = await startGameServer({
    store,
    root,
    port: 0,
    now: () => T0,
    actionKey: 'secret',
    getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  store.close();
});

const post = async (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async (response: Response) => ((await response.json()) as ServerSnapshot).brawl;

function message(n: number, extra: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    type: 'chat', channel: 'test', userId: `b${n}`, login: `brawler${n}`, displayName: `Brawler${n}`, color: null,
    badges: [], isBroadcaster: false, isModerator: false, text: 'hi Kappa', emoteIds: ['25'], sentAt: T0, ...extra,
  };
}

/** Collects overlay messages and resolves once one matches. */
function listen() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const messages: any[] = [];
  socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
  const until = (match: (m: any) => boolean, what: string) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${what}`)), 4000);
      const check = () => {
        const found = messages.find(match);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      socket.addEventListener('message', check);
      check();
    });
  return { socket, until };
}

test('the brawl turns on and off, keeps its size within bounds, and chatters who write drop in', async () => {
  const off = await state(await fetch(`${base}/api/state`));
  assert.deepEqual(off, { active: false, fighters: config.brawl.fighters, min: config.brawl.minFighters, max: config.brawl.maxFighters, streamer: null });
  assert.equal((await post('/api/brawl', { join: 'god' })).status, 409, 'nobody joins a brawl that is off');
  assert.equal((await post('/api/brawl', { fighters: 4 })).status, 400);
  assert.equal((await post('/api/brawl', { fighters: 13 })).status, 400);
  assert.equal((await post('/api/brawl', { fighters: 6.5 })).status, 400);
  assert.equal((await state(await post('/api/brawl', { fighters: 6 }))).fighters, 6);
  assert.equal(store.brawlFighters(), 6);

  const { socket, until } = listen();
  assert.equal((await state(await post('/api/brawl', { active: true }))).active, true);
  const start = await until((m) => m.type === 'brawl-start', 'brawl start');
  assert.equal(start.size, 6);
  // Chatters who write join without any game layer running; the broadcaster does not.
  server.onChat(message(1));
  server.onChat(message(2, { isBroadcaster: true }));
  const frame = await until((m) => m.type === 'brawl-frame' && m.f.length === 1, 'a fighter on the field');
  assert.equal(frame.f[0].length, 10);
  const joined = await until((m) => m.type === 'brawl-frame' && (m.e ?? []).some((e: any) => e.k === 'join'), 'join event');
  const who = joined.e.find((e: any) => e.k === 'join').f;
  assert.equal(who.name, 'Brawler1');
  assert.match(who.color, /^#[0-9A-F]{6}$/i, 'a chatter without a colour gets one of Twitch\'s');
  assert.ok(who.emote, 'and fights with the emote they wrote');

  socket.close();
  assert.equal((await state(await post('/api/brawl', { active: false }))).active, false);
});

test('the streamer joins as a fighter or as the god, once; any real fight or Stop ends the brawl', async () => {
  await post('/api/brawl', { active: true });
  assert.equal((await post('/api/brawl', { join: 'sideways' })).status, 400);
  assert.equal((await state(await post('/api/brawl', { join: 'god' }))).streamer, 'god');
  assert.equal((await post('/api/brawl', { join: 'fighter' })).status, 409, 'once on the field is enough');

  // A countdown takes the screen from the brawl, like from the endless mode.
  assert.equal((await post('/api/draft/start', { mode: 'free' })).status, 200);
  assert.equal((await state(await fetch(`${base}/api/state`))).active, false);
  await post('/api/battle/stop', {});

  // The action links switch it and let the streamer join.
  assert.equal((await fetch(`${base}/api/action/brawl-on?key=secret`)).status, 200);
  assert.equal((await fetch(`${base}/api/action/brawl-join?key=secret`)).status, 200);
  assert.equal((await state(await fetch(`${base}/api/state`))).streamer, 'streamer');
  assert.equal((await fetch(`${base}/api/action/brawl-god?key=secret`)).status, 409);
  await post('/api/battle/stop', {});
  assert.equal((await state(await fetch(`${base}/api/state`))).active, false, 'Stop ends it');
});

test('a second game on a port in use fails to start with an error to show, instead of crashing', async () => {
  const second = Store.open(':memory:');
  await assert.rejects(
    startGameServer({ store: second, root, port: server.port, now: () => T0, getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }) }),
    (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
  );
  second.close();
});
