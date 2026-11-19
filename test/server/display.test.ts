import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/db/store.ts';
import { EmoteImages } from '../../src/emotes/images.ts';
import { EmoteRegistry } from '../../src/emotes/registry.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { startGameServer, type GameServer } from '../../src/server/server.ts';
import type { GameSnapshot } from '../../src/server/state.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = 1_700_000_100_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let store: Store;
let server: GameServer;
let base: string;
const fetched: string[] = [];

before(async () => {
  store = Store.open(':memory:');
  store.startSession(T0);
  const emotes = new EmoteRegistry({ fetchJson: async () => null, log: () => {} });
  emotes.setEmotes('global', '7tv', [{ source: '7tv', id: 'S1', code: 'RainTime', animated: true }]);
  server = await startGameServer({
    store,
    root,
    port: 0,
    now: () => T0 + 60_000,
    getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }),
    emotes,
    emoteImages: new EmoteImages({
      fetchBytes: async (url) => {
        fetched.push(url);
        return url.includes('/emoticons/v2/25/') ? PNG : null;
      },
    }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  store.close();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function chat(userId: string, color: string, emote: string | null): ChatMessageEvent {
  return {
    type: 'chat',
    channel: 'test',
    userId,
    login: `u${userId}`,
    displayName: `U${userId}`,
    color,
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    emote,
    sentAt: T0 + Number(userId),
  };
}

test('the snapshot carries the display settings and the installed themes', async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.ok(state.display.themes.some((theme) => theme.id === 'pixel'));
  assert.equal(state.display.theme, 'pixel', 'the pixel theme by default');
  assert.deepEqual(
    [state.display.pixelateEmotes, state.display.animatedEmotes, state.display.randomEmotes, state.display.emoteSources],
    [true, true, true, { bttv: true, ffz: true, '7tv': true }],
  );
});

test('the display endpoint changes any subset and refuses anything else', async () => {
  for (const bad of [
    {},
    { theme: 'does-not-exist' },
    { theme: 3 },
    { animatedEmotes: 'yes' },
    { emoteSources: { youtube: true } },
    { emoteSources: { bttv: 'off' } },
    { emoteSources: [] },
    { colour: 'red' },
  ]) {
    assert.equal((await post('/api/display', bad)).status, 400, JSON.stringify(bad));
  }
  const changed = (await (await post('/api/display', { theme: 'plain', pixelateEmotes: false, emoteSources: { ffz: false } })).json()) as GameSnapshot;
  assert.equal(changed.display.theme, 'plain');
  assert.equal(changed.display.pixelateEmotes, false);
  assert.deepEqual(changed.display.emoteSources, { bttv: true, ffz: false, '7tv': true });
  await post('/api/display', { theme: 'pixel', pixelateEmotes: true, emoteSources: { ffz: true } });
});

test('emote images are served from the game server; malformed requests get a 404 and fetch nothing', async () => {
  const image = await fetch(`${base}/emotes/twitch/25?animated=0`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);
  const before = fetched.length;
  for (const bad of ['/emotes/twitch/..%2F..%2Fpackage.json', '/emotes/youtube/1', '/emotes/twitch/', '/emotes/twitch/a/b', '/emotes/bttv/%E0%A4%A']) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
  assert.equal(fetched.length, before);
  assert.equal((await fetch(`${base}/emotes/bttv/missing`)).status, 404, 'an emote no CDN has');
});

test('fighters arrive at the overlay with emote images: their own, a random one, or none', async () => {
  // Three chatters: one with a 7TV emote, one with an old plain Twitch id, one who never used an emote.
  store.recordMessage(chat('11', '#FF0000', '7tv:S1'));
  store.recordMessage(chat('12', '#00FF00', 'twitch:25'));
  store.recordMessage(chat('13', '#0000FF', null));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const start = new Promise<any>((resolve) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'battle-start') resolve(message);
    });
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  assert.equal((await post('/api/test-battle', { sides: ['red', 'green', 'blue'] })).status, 200);
  const battle = await start;
  assert.equal(battle.emoteUrl, undefined, 'the old template is gone');
  const byName = Object.fromEntries(battle.fighters.map((f: any) => [f.name, f.emote]));
  assert.deepEqual(byName.U11, { url: '/emotes/7tv/S1?animated=0', animatedUrl: '/emotes/7tv/S1?animated=1' });
  assert.deepEqual(byName.U12, { url: '/emotes/twitch/25?animated=0', animatedUrl: null });
  assert.ok(byName.U13 && byName.U13.url.startsWith('/emotes/'), 'a random one');
  await post('/api/battle/stop', {});

  // With random emotes off, the third has none; with 7TV off, the first has none.
  await post('/api/display', { randomEmotes: false, emoteSources: { '7tv': false } });
  const again = new Promise<any>((resolve) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'battle-start') resolve(message);
    });
  });
  await post('/api/test-battle', { sides: ['red', 'green', 'blue'] });
  const second = Object.fromEntries((await again).fighters.map((f: any) => [f.name, f.emote]));
  assert.equal(second.U11, null);
  assert.equal(second.U13, null);
  assert.ok(second.U12);
  await post('/api/battle/stop', {});
  await post('/api/display', { randomEmotes: true, emoteSources: { '7tv': true } });
  socket.close();
});

test('an old database: plain emote ids become Twitch ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-emotes-'));
  try {
    const file = join(dir, 'old.sqlite');
    const first = Store.open(file);
    first.recordMessage(chat('21', '#FF0000', null));
    first.close();
    // Roll the database back to before the migration, with a plain id as it was stored then.
    const db = new DatabaseSync(file);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    // Back before the emote migration and the ones after it (the tiles' fires, the session
    // ticks, Monument points in tens; that last one only multiplies, so it can simply run again).
    db.exec(
      `UPDATE users SET emote_id = '25' WHERE user_id = '21'; DROP TABLE session_ticks; ALTER TABLE tiles DROP COLUMN burning; PRAGMA user_version = ${version - 4};`,
    );
    db.close();
    const reopened = Store.open(file);
    assert.equal(reopened.getUser('21')!.emote_id, 'twitch:25');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old database: Monument points and a tuned goal are converted to tens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-monument-'));
  try {
    const file = join(dir, 'old.sqlite');
    const first = Store.open(file);
    first.close();
    // Roll back to before the conversion, with numbers as they were stored then.
    const db = new DatabaseSync(file);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.exec(`UPDATE guilds SET monument = 3000 WHERE guild_id = 'red';
      INSERT OR REPLACE INTO settings (key, value) VALUES ('tuning', '{"monument.goal":8000,"war.participationXp":30}');
      PRAGMA user_version = ${version - 1};`);
    db.close();
    const reopened = Store.open(file);
    assert.equal(reopened.monuments().red, 30_000, 'the same share of a goal ten times as large');
    assert.deepEqual(JSON.parse(reopened.getSetting('tuning')!), { 'monument.goal': 80_000, 'war.participationXp': 30 });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
