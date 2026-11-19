import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Store } from '../../src/db/store.ts';
import { checkDatabaseFile } from '../../src/db/schema.ts';
import { BattleRunner } from '../../src/server/battle-runner.ts';
import { EventRunner, type EventEngine } from '../../src/server/event-runner.ts';
import { startGameServer, type GameServer, type ServerSnapshot } from '../../src/server/server.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = '0123456789abcdef01234567';
let folder: string;
let dbPath: string;
let store: Store;
let server: GameServer;
let base: string;
const said: string[] = [];
const changes: ({ kind: 'reset' } | { kind: 'import'; file: string })[] = [];

before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'chroma-handling-'));
  dbPath = join(folder, 'test.sqlite');
  store = Store.open(dbPath);
  server = await startGameServer({
    store,
    root,
    port: 0,
    now: Date.now,
    getSource: () => ({ kind: 'irc', channel: 'testchannel', status: 'joined' }),
    databasePath: dbPath,
    actionKey: KEY,
    chat: { canSay: () => true, say: (text) => (said.push(text), true) },
    onDatabase: (change) => changes.push(change),
    version: () => ({ current: '1.0.0', latest: null }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async () => (await (await fetch(`${base}/api/state`)).json()) as ServerSnapshot;
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out');
};

test('action links need the key, and do what they name', async () => {
  assert.equal((await fetch(`${base}/api/action/layer-on`)).status, 403, 'no key');
  assert.equal((await fetch(`${base}/api/action/layer-on?key=${'f'.repeat(24)}`)).status, 403, 'wrong key');
  assert.equal((await fetch(`${base}/api/action/dance?key=${KEY}`)).status, 404);

  const on = await fetch(`${base}/api/action/layer-on?key=${KEY}`);
  assert.equal(on.status, 200);
  assert.match(await on.text(), /on/);
  assert.equal((await state()).session.active, true);
  await fetch(`${base}/api/action/layer?key=${KEY}`);
  assert.equal((await state()).session.active, false, 'layer toggles');

  // A test battle with nobody active uses stand-ins; stop ends it.
  assert.equal((await fetch(`${base}/api/action/test-battle?key=${KEY}`)).status, 200);
  assert.ok((await state()).battle);
  const busy = await fetch(`${base}/api/action/war?key=${KEY}`);
  assert.equal(busy.status, 409, 'one thing at a time');
  assert.match(((await busy.json()) as { error: string }).error, /already running/);
  assert.equal((await fetch(`${base}/api/action/stop?key=${KEY}`)).status, 200);
  assert.equal((await state()).battle, null);
});

test('the key is only handed to the server\'s own pages', async () => {
  const own = (await (await fetch(`${base}/api/actions`)).json()) as { key: string; actions: string[] };
  assert.equal(own.key, KEY);
  assert.ok(own.actions.includes('war'));
  const foreign = await fetch(`${base}/api/actions`, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
});

test('other websites cannot open the live connection', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin: 'https://evil.example' } });
  const outcome = await new Promise<string>((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('error', () => resolve('refused'));
  });
  socket.close();
  assert.equal(outcome, 'refused');
});

test('overlays are counted for the guide and report their frame times to the status page', async () => {
  assert.equal((await state()).guide.overlays, 0);
  const overlay = new WebSocket(`ws://127.0.0.1:${server.port}/ws?page=overlay`);
  await new Promise((resolve) => overlay.on('open', resolve));
  await until(async () => (await state()).guide.overlays === 1);
  overlay.send(JSON.stringify({ type: 'overlay-stats', frameMs: 4.5, slowMs: 12, fps: 58, width: 1920, height: 1080, theme: 'pixel' }));
  overlay.send(JSON.stringify({ type: 'overlay-stats', frameMs: 'fast' }));
  type Status = { overlays: { frameMs?: number; theme?: string }[]; database: { bytes: number }; chat: { channel: string } };
  await until(async () => ((await (await fetch(`${base}/api/status`)).json()) as Status).overlays[0]?.frameMs === 4.5);
  const status = (await (await fetch(`${base}/api/status`)).json()) as Status;
  assert.equal(status.overlays[0]!.theme, 'pixel', 'a malformed report does not overwrite a good one');
  assert.ok(status.database.bytes > 0);
  assert.equal(status.chat.channel, 'testchannel');
  assert.equal((await state()).guide.withoutGpu, 0, 'an overlay that did not say is not counted as drawing without the graphics card');

  // An overlay that draws without the graphics card (OBS's hardware acceleration off) makes the panel warn.
  overlay.send(JSON.stringify({ type: 'overlay-stats', frameMs: 30, slowMs: 90, fps: 30, width: 1920, height: 1080, theme: 'comic', gpu: false }));
  await until(async () => (await state()).guide.withoutGpu === 1);
  overlay.send(JSON.stringify({ type: 'overlay-stats', frameMs: 4, slowMs: 9, fps: 60, width: 1920, height: 1080, theme: 'comic', gpu: true }));
  await until(async () => (await state()).guide.withoutGpu === 0);
  overlay.close();
  await until(async () => (await state()).guide.overlays === 0);
});

test('the game can be exported as a database, and an export can be imported again', async () => {
  const exported = await fetch(`${base}/api/database/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /chroma-clash-testchannel-.*\.sqlite/);
  const data = Buffer.from(await exported.arrayBuffer());
  assert.equal(data.subarray(0, 15).toString('latin1'), 'SQLite format 3');

  const notADatabase = await fetch(`${base}/api/database/import`, { method: 'POST', body: 'hello' });
  assert.equal(notADatabase.status, 400);

  const imported = await fetch(`${base}/api/database/import`, { method: 'POST', body: data });
  assert.equal(imported.status, 200);
  await until(async () => changes.length === 1);
  const change = changes.pop()!;
  assert.equal(change.kind, 'import');
  if (change.kind === 'import') {
    assert.equal(checkDatabaseFile(change.file), null, 'the checked file waits next to the database');
    assert.deepEqual(readFileSync(change.file), data);
    rmSync(change.file);
  }
});

test('a reset must be confirmed with the channel name', async () => {
  assert.equal((await post('/api/database/reset', { confirm: 'yes' })).status, 400);
  assert.equal(changes.length, 0);
  assert.equal((await post('/api/database/reset', { confirm: 'testchannel' })).status, 200);
  await until(async () => changes.length === 1);
  assert.deepEqual(changes.pop(), { kind: 'reset' });
  assert.ok(existsSync(dbPath), 'the server only asks; the caller backs up and replaces the file');
});

test('a file that is not a game is turned away', () => {
  assert.match(checkDatabaseFile(join(root, 'package.json')) ?? '', /not an SQLite/);
  const empty = join(folder, 'empty.sqlite');
  const other = Store.open(empty);
  other.db.exec('PRAGMA foreign_keys = OFF; DROP TABLE users;');
  other.close();
  assert.match(checkDatabaseFile(empty) ?? '', /not a Chroma Clash database/);
});

test('results go to chat only when switched on', async () => {
  const snapshot = await state();
  assert.deepEqual(snapshot.chatAnnounce, { available: true, enabled: false });
  assert.equal((await post('/api/settings', { chatAnnounce: true })).status, 200);
  assert.equal((await state()).chatAnnounce.enabled, true);
  assert.equal((await post('/api/settings', { chatAnnounce: 'yes' })).status, 400);
});

test('an event that runs to its end reports its closing summary', () => {
  const finished: string[] = [];
  const engine: EventEngine = {
    next: () => null,
    apply: () => undefined,
    finish: () => {},
    closing: () => ({ title: 'Red wins Pachinko', subtitle: 'Red 120 · Blue 80' }),
  } as unknown as EventEngine;
  const runner = new EventRunner({
    battles: new BattleRunner(() => {}),
    send: () => {},
    onChange: () => {},
    onFinish: (closing) => finished.push(`${closing.title}. ${closing.subtitle}`),
  });
  runner.start(engine, 'Pachinko');
  assert.deepEqual(finished, ['Red wins Pachinko. Red 120 · Blue 80']);
});

test('a server that closes with an overlay open does not touch its closed database', async () => {
  // As on a channel switch or a reset: the server closes, then the store at once.
  const other = Store.open(':memory:');
  const closing = await startGameServer({
    store: other,
    root,
    port: 0,
    now: Date.now,
    getSource: () => ({ kind: 'sim', channel: 'other', status: 'testing' }),
  });
  const overlay = new WebSocket(`ws://127.0.0.1:${closing.port}/ws?page=overlay`);
  await new Promise((resolve) => overlay.on('open', resolve));
  const closed = closing.close();
  other.close();
  await closed;
  // A read of the closed database would throw here, outside any handler.
  await new Promise((resolve) => setTimeout(resolve, 100));
});
