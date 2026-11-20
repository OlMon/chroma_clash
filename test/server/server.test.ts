import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { hexDistance, hexNeighbors, mapTiles } from '../../src/game/hex.ts';
import { startGameServer, type GameServer } from '../../src/server/server.ts';
import type { GameSnapshot } from '../../src/server/state.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = 1_700_000_100_000;
let clock = T0;
let store: Store;
let server: GameServer;
let base: string;

before(async () => {
  store = Store.open(':memory:');
  server = await startGameServer({
    store,
    root,
    port: 0,
    now: () => clock,
    getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  store.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('hex map: 19 tiles, distances and neighbors', () => {
  assert.equal(mapTiles().length, 19);
  assert.equal(hexDistance({ q: 2, r: -2 }, { q: 0, r: 2 }), 4);
  assert.equal(hexDistance({ q: 2, r: -2 }, { q: -2, r: 0 }), 4);
  assert.equal(hexDistance({ q: 0, r: 2 }, { q: -2, r: 0 }), 4);
  assert.equal(hexNeighbors({ q: 0, r: 0 }).length, 6);
  assert.equal(hexNeighbors({ q: 2, r: -2 }).length, 3, 'a corner has three neighbors');
});

test('the state has the map with one city and five tiles per guild, and no session', async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.equal(state.tiles.length, 19);
  const cities = state.tiles.filter((t) => t.isCity);
  assert.deepEqual(cities.map((t) => t.owner).sort(), ['blue', 'green', 'red']);
  // A season starts with the land dealt out: five tiles per guild, the center neutral.
  assert.deepEqual(state.tiles.filter((t) => t.owner === null).map((t) => t.id), ['0,0']);
  assert.deepEqual(state.guilds.map((g) => g.tiles), [5, 5, 5]);
  assert.ok(state.tiles.every((t) => t.level === (t.id === '0,0' ? 5 : 0)), 'only the center has a level, a fixed one');
  assert.deepEqual(state.center, { id: '0,0', owner: null, minutesLeft: 0 });
  assert.equal(state.session.active, false);
  assert.deepEqual(state.guilds.map((g) => g.id), ['red', 'green', 'blue']);
  const { design, ...monument } = state.guilds[0]!.monument;
  // The base income and 10 for each of the five tiles, all still at level 0.
  assert.deepEqual(monument, { progress: 0, goal: config.season.expectedPerHour * config.season.hours, income: 10 + 5 * 10 });
  assert.ok([0, 1, 2].includes(design));
  assert.deepEqual(state.guilds.map((g) => g.monument.design).sort(), [0, 1, 2], 'a different design for each guild');
  assert.equal(state.seasonStart, 'equal');
});

test('the panel can turn the background layer on and off', async () => {
  const on = (await (await post('/api/session', { active: true })).json()) as GameSnapshot;
  assert.equal(on.session.active, true);
  assert.equal(on.session.startedAt, T0);

  clock = T0 + 60_000;
  const off = (await (await post('/api/session', { active: false })).json()) as GameSnapshot;
  assert.equal(off.session.active, false);
  assert.equal((await post('/api/session', { active: 'yes' })).status, 400);
});

test('the channel size can be set by hand and back to automatic', async () => {
  const manual = (await (await post('/api/channel-size', { chatters: 50 })).json()) as GameSnapshot;
  assert.equal(manual.channelSize.manual, 50);
  assert.equal(manual.channelSize.scale, 2);

  const auto = (await (await post('/api/channel-size', { chatters: null })).json()) as GameSnapshot;
  assert.equal(auto.channelSize.manual, null);
  assert.equal((await post('/api/channel-size', { chatters: -3 })).status, 400);
});

test('commands from other websites are refused', async () => {
  const response = await post('/api/session', { active: true }, { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.equal(state.session.active, false);
});

test('serves the pages and nothing outside them', async () => {
  const overlay = await fetch(`${base}/overlay/`);
  assert.equal(overlay.status, 200);
  assert.match(await overlay.text(), /<canvas/);
  assert.equal((await fetch(`${base}/control/control.js`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/overlay/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/control/../src/main.ts`)).status, 404);
});

test('pages get the state over the WebSocket, and again when it changes', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const messages: GameSnapshot[] = [];
  const got = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no WebSocket message')), 3000);
      const check = () => {
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve();
        }
      };
      socket.addEventListener('message', check);
      check();
    });
  socket.addEventListener('message', (event) => {
    messages.push((JSON.parse(String(event.data)) as { state: GameSnapshot }).state);
  });

  await got(1);
  assert.equal(messages[0]!.session.active, false);
  await post('/api/session', { active: true });
  await got(2);
  assert.equal(messages[1]!.session.active, true);
  socket.close();
  await post('/api/session', { active: false });
});

test('a test battle uses stand-ins when chat is quiet, streams frames and can be stopped', async () => {
  // Nobody is active yet (setting up before a stream): stand-ins fight, so the overlay can be checked.
  const quiet = await post('/api/test-battle', { sides: ['red', 'blue'] });
  assert.equal(quiet.status, 200);
  const quietState = (await quiet.json()) as GameSnapshot & { guide: { testBattleRun: boolean } };
  assert.equal(quietState.battle?.title, 'Test battle with stand-ins');
  assert.equal(quietState.guide.testBattleRun, true, 'the setup guide ticks off its last step');
  await post('/api/battle/stop', {});

  assert.equal((await post('/api/test-battle', { sides: ['red'] })).status, 400);
  assert.equal((await post('/api/test-battle', { sides: ['red', 'purple'] })).status, 400);

  await post('/api/session', { active: true });
  for (let id = 0; id < 6; id++) {
    store.recordMessage({
      type: 'chat',
      channel: 'test',
      userId: String(900 + id),
      login: `fighter${id}`,
      displayName: `Fighter${id}`,
      color: id % 2 === 0 ? '#FF0000' : '#0000FF',
      badges: [],
      isBroadcaster: false,
      isModerator: false,
      text: 'hi',
      emoteIds: [],
      sentAt: clock + id,
    });
  }

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const types: string[] = [];
  let roster = 0;
  const seen = (type: string, count = 1) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} message`)), 3000);
      const check = () => {
        if (types.filter((t) => t === type).length >= count) {
          clearTimeout(timer);
          resolve();
        }
      };
      socket.addEventListener('message', check);
      check();
    });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; fighters?: unknown[] };
    types.push(message.type);
    if (message.type === 'battle-start') roster = message.fighters!.length;
  });
  await seen('state');

  const started = await post('/api/test-battle', { sides: ['red', 'green', 'blue'] });
  assert.equal(started.status, 200);
  assert.equal(((await started.json()) as GameSnapshot).battle?.title, 'Test battle');
  await seen('battle-start');
  await seen('battle-frame', 3);
  // Six chatters, two per guild: each guild filled up to the smallest team, with a double the god makes.
  assert.equal(roster, 3 * config.smallChat.minTeam);
  assert.equal((await post('/api/test-battle', {})).status, 409, 'one battle at a time');

  const stopped = (await (await post('/api/battle/stop', {})).json()) as GameSnapshot;
  assert.equal(stopped.battle, null);
  await seen('battle-end');
  socket.close();
  await post('/api/session', { active: false });
});

test("the god's picture can be uploaded, is served back, and can be removed", async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await fetch(`${base}/api/god/picture`)).status, 404);
  assert.equal(((await (await fetch(`${base}/api/state`)).json()) as GameSnapshot).god.picture, null);

  const uploaded = (await (
    await post('/api/god/picture', { image: `data:image/png;base64,${png}` })
  ).json()) as GameSnapshot;
  assert.match(uploaded.god.picture!, /^\/api\/god\/picture\?v=\d+$/);
  const served = await fetch(base + uploaded.god.picture!);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), png);

  // A second upload gets a new address, so pages do not show a cached old picture.
  const again = (await (
    await post('/api/god/picture', { image: `data:image/png;base64,${png}` })
  ).json()) as GameSnapshot;
  assert.notEqual(again.god.picture, uploaded.god.picture);

  // Only real images are accepted, whatever the upload claims to be.
  const text = Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await post('/api/god/picture', { image: `data:image/png;base64,${text}` })).status, 400);
  assert.equal((await post('/api/god/picture', { image: 'not a picture' })).status, 400);
  assert.equal((await post('/api/god/picture', { image: `data:image/svg+xml;base64,${text}` })).status, 400);
  const huge = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(450_000)]).toString('base64');
  assert.equal((await post('/api/god/picture', { image: `data:image/png;base64,${huge}` })).status, 413);
  assert.equal((await fetch(base + again.god.picture!)).status, 200, 'rejected uploads change nothing');

  const removed = (await (await post('/api/god/picture', { image: null })).json()) as GameSnapshot;
  assert.equal(removed.god.picture, null);
  assert.equal((await fetch(`${base}/api/god/picture`)).status, 404);
});
