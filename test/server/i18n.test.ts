import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config, type GuildId } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { Battle } from '../../src/game/battle.ts';
import { languageList, languageOf, text } from '../../src/i18n.ts';
import { startGameServer, type GameServer } from '../../src/server/server.ts';
import { buildSnapshot, type GameSnapshot } from '../../src/server/state.ts';
import { WarEngine } from '../../src/server/war-engine.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
type Strings = Record<string, string | { one: string; other: string }>;
const readLanguage = (id: string): Strings => JSON.parse(readFileSync(join(root, 'lang', `${id}.json`), 'utf8'));
const en = readLanguage('en');

/** The placeholders of a value, sorted; for a plural, those of both forms. */
function placeholders(value: Strings[string]): string[] {
  const texts = typeof value === 'string' ? [value] : [value.one, value.other];
  return [...new Set(texts.flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
}

test('every language file has the keys of English, with the same placeholders and plural forms', () => {
  const files = readdirSync(join(root, 'lang')).filter((name) => name.endsWith('.json'));
  assert.ok(files.includes('de.json'));
  for (const file of files) {
    const id = file.slice(0, -5);
    const other = readLanguage(id);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), `${file} has the same keys as en.json`);
    for (const [key, value] of Object.entries(en)) {
      const translated = other[key]!;
      assert.equal(typeof translated, typeof value, `${file}: ${key} is a plain text in one file and a plural in the other`);
      if (typeof value === 'object') assert.deepEqual(Object.keys(translated as object).sort(), ['one', 'other'], `${file}: ${key}`);
      assert.deepEqual(placeholders(translated), placeholders(value), `${file}: ${key} has the placeholders of English`);
      const forms = typeof translated === 'string' ? [translated] : [translated.one, translated.other];
      assert.ok(forms.every((form) => form.trim() !== ''), `${file}: ${key} is empty`);
    }
  }
});

test('every key the code names exists in English', () => {
  const sources: { file: string; pattern: RegExp }[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  // Calls with a written-out key: t('…'), tr('…'), text(lang, '…'). Keys built at runtime are not checked here.
  for (const file of walk(join(root, 'src'))) {
    sources.push({ file, pattern: /\b(?:t|tr)\(\s*'([a-z][\w-]*\.[\w.-]+)'|\btext\([^,()]+,\s*'([a-z][\w-]*\.[\w.-]+)'/g });
  }
  for (const file of ['overlay/overlay.js', 'control/control.js']) sources.push({ file: join(root, file), pattern: /\btr\(\s*'([^']+)'/g });
  sources.push({ file: join(root, 'control/index.html'), pattern: /data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"/g });
  const missing: string[] = [];
  let checked = 0;
  for (const { file, pattern } of sources) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const key = match[1] ?? match[2]!;
      checked++;
      if (!(key in en)) missing.push(`${file.slice(root.length + 1)}: ${key}`);
    }
  }
  assert.ok(checked > 100, `found ${checked} keys in the code`);
  assert.deepEqual(missing, []);
});

test('texts fill their placeholders, pick plurals by count, and fall back to English', () => {
  assert.equal(text('de', 'server.war.attacks', { attacker: 'Rot', defender: 'Blau' }), 'Rot greift Blau an');
  assert.equal(text('de', 'server.stats.kills', { count: 1 }), '1 Kill');
  assert.equal(text('de', 'server.stats.kills', { count: 4 }), '4 Kills');
  assert.equal(text('xx', 'server.war.over'), 'The War is over', 'an unknown language shows English');
  assert.equal(text('de', 'no.such.key'), 'no.such.key');
  assert.deepEqual(languageList().map((l) => l.id).slice(0, 2), ['en', 'de']);
  assert.equal(languageList().find((l) => l.id === 'de')?.name, 'Deutsch');

  const store = Store.open(':memory:');
  assert.equal(languageOf(store), 'en', 'English until the streamer chooses');
  store.setSetting('language', 'xx');
  assert.equal(languageOf(store), 'en', 'a language whose file is gone falls back to English');
  store.close();
});

// --- German at the source: the engines and the state ---------------------------

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };
let nextId = 9000;

function chatters(store: Store, perGuild: number, at: number): void {
  for (let i = 0; i < perGuild; i++) {
    for (const guild of ['red', 'green', 'blue'] as const) {
      const id = String(++nextId);
      store.recordMessage({
        type: 'chat', channel: 'test', userId: id, login: `u${id}`, displayName: `U${id}`, color: COLORS[guild],
        badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [], sentAt: at,
      });
    }
  }
}

test('with the language set to German, a War is announced and summed up in German', () => {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters * 100);
  store.startSession(T0);
  chatters(store, 15, T0 + 1);
  store.setSetting('language', 'de');

  const engine = new WarEngine(store, () => T0 + 60_000, 7);
  const titles: string[] = [];
  for (let step = engine.next(); step; step = engine.next()) {
    titles.push(step.title, step.subtitle, step.label);
    if (step.kind !== 'skipped') {
      const outcome = engine.apply(step, new Battle(step.setup!).run());
      titles.push(outcome.display!.title);
      assert.ok(step.meta!.sides.every((side) => ['Rot', 'Grün', 'Blau'].includes(side.name)), 'the overlay gets German guild names');
    }
  }
  engine.finish();
  assert.match(titles[0]!, /^Kampf 1 von \d$/);
  assert.match(titles[1]!, /^(Rot|Grün|Blau) (greift (Rot|Grün|Blau) an|überfällt neutrales Land)/);
  assert.match(titles[2]!, /^Krieg: Kampf 1 von \d$/);
  assert.match(titles[3]!, /erobert|hält gegen|gescheitert/);
  const closing = engine.closing();
  assert.equal(closing.title, 'Der Krieg ist vorbei');
  assert.doesNotMatch(closing.subtitle, /\b(took|held|raid|attack)\b/);

  const snapshot = buildSnapshot(store, { kind: 'sim', channel: 'test', status: '' }, T0 + 60_000);
  assert.equal(snapshot.display.language, 'de');
  assert.deepEqual(snapshot.guilds.map((g) => g.name), ['Rot', 'Grün', 'Blau']);
  assert.equal(snapshot.seasonStats.find((line) => line.id === 'wars')?.label, 'Kriege geführt');
  assert.equal(snapshot.tuning.find((value) => value.key === 'ticks.xpPerTick')?.label, 'XP pro Tick');
  assert.equal(snapshot.god.skills.find((skill) => skill.id === 'shield')?.name, 'Göttlicher Schild');
  store.close();
});

// --- Through the server: the setting, the pages' files, a countdown -------------

let store: Store;
let server: GameServer;
let base: string;
const original = { countdownMs: config.draft.countdownMs };

before(async () => {
  store = Store.open(':memory:');
  store.startSession(T0);
  server = await startGameServer({
    store,
    root,
    port: 0,
    now: () => T0 + 60_000,
    getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }),
  });
  base = `http://127.0.0.1:${server.port}`;
  config.draft.countdownMs = 60_000;
});

after(async () => {
  config.draft.countdownMs = original.countdownMs;
  await server.close();
  store.close();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the control panel switches the language; the server then writes German, and the pages get the files', async () => {
  const before = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.equal(before.display.language, 'en');
  assert.ok(before.display.languages.some((l) => l.id === 'de' && l.name === 'Deutsch'));

  assert.equal((await post('/api/display', { language: 'klingon' })).status, 400);
  const switched = (await (await post('/api/display', { language: 'de' })).json()) as GameSnapshot;
  assert.equal(switched.display.language, 'de');
  assert.equal(store.getSetting('language'), 'de');
  assert.equal(switched.guilds[0]!.name, 'Rot');

  // The countdown's announcement on the overlay, and the label in the control panel.
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const countdown = new Promise<any>((resolve) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'countdown' && !message.done) resolve(message);
    });
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  const started = (await (await post('/api/draft/start', { mode: 'guild' })).json()) as GameSnapshot;
  assert.equal(started.battle?.title, 'Gildenkampf: Countdown');
  const shown = await countdown;
  assert.equal(shown.title, 'Gildenkampf');
  assert.equal(shown.subtitle, text('de', 'server.countdown.subtitle'));
  // An error the streamer sees in the control panel's error line.
  const busy = await post('/api/draft/start', { mode: 'free' });
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { error: string }).error, 'Es läuft schon ein Kampf.');
  await post('/api/battle/stop', {});
  socket.close();

  const file = await fetch(`${base}/lang/de.json`);
  assert.equal(file.status, 200);
  assert.equal(((await file.json()) as Strings)['mode.guildClash'], 'Gildenkampf');
  assert.equal((await fetch(`${base}/lang/i18n.js`)).status, 200);

  await post('/api/display', { language: 'en' });
});
