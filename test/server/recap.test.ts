import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.ts';
import { Store, type SeasonRecord, type UserRow } from '../../src/db/store.ts';
import { PachinkoEngine } from '../../src/server/pachinko-engine.ts';
import { recapMessage } from '../../src/server/recap.ts';
import { startGameServer, type GameServer } from '../../src/server/server.ts';

const T0 = 1_700_000_000_000;

function season(overrides: Partial<SeasonRecord> = {}, summary: Partial<NonNullable<SeasonRecord['summary']>> = {}): SeasonRecord {
  return {
    id: 4,
    startedAt: T0,
    endedAt: T0 + 1000,
    winner: 'blue',
    wars: 3,
    godWins: 2,
    godLosses: 5,
    summary: {
      endedBy: 'monument',
      topLevel: { displayName: 'TinyMoth4', level: 9 },
      topKiller: { displayName: 'SaltyOtter23', kills: 41 },
      champion: { displayName: 'RustyPigeon2', wins: 1 },
      pachinko: { displayName: 'LuckyRaven14', points: 100 },
      players: 87,
      monumentGoal: 20_000,
      guilds: {
        red: { monument: 14_000, tiles: 5, development: 20, members: 30, design: 0 },
        green: { monument: 9_000, tiles: 4, development: 12, members: 20, design: 1 },
        blue: { monument: 20_050, tiles: 6, development: 25, members: 37, design: 2 },
      },
      ...summary,
    },
    ...overrides,
  };
}

const god = { name: 'TheStreamer', color: '#9146FF' };

test('a recap names the winner, the season\'s best and the god\'s score, row by row', () => {
  const message = recapMessage(season(), god, 'en')!;
  assert.equal(message.title, 'Season 4: the recap');
  assert.deepEqual(
    message.recap.rows.map((row) => [row.label, row.value]),
    [
      ['Winner', 'Blue · Monument finished'],
      ['Most kills', 'SaltyOtter23 · 41 kills'],
      ['Highest level', 'TinyMoth4 · level 9'],
      ['Most Clash wins', 'RustyPigeon2 · 1 win'],
      ['Best Pachinko run', 'LuckyRaven14 · 100 points'],
      ['TheStreamer vs Chat', '2 : 5'],
      ['Chatters playing', '87'],
    ],
  );
  assert.deepEqual([message.recap.winner, message.recap.design], ['blue', 2], 'the winner\'s Monument is drawn beside it');
  assert.equal(message.holdMs, 7 * config.recap.stepMs + config.recap.holdMs, 'long enough for every row, then a while');

  // Ended by hand: the furthest Monument wins, at its share. Nobody with kills or Pachinko: no row for them.
  const byHand = recapMessage(season({}, { endedBy: 'streamer', topKiller: null, pachinko: null }), god, 'de')!;
  assert.equal(byHand.recap.rows[0]!.value, 'Blau · Monument 100%');
  assert.ok(!byHand.recap.rows.some((row) => /Kills|Pachinko/.test(row.label)));

  const godSeason = recapMessage(season({ winner: 'god', godWins: 5 }, { endedBy: 'god' }), god, 'en')!;
  assert.equal(godSeason.recap.rows[0]!.value, 'TheStreamer, with 5 wins against chat');
  assert.deepEqual([godSeason.recap.winner, godSeason.recap.design, godSeason.recap.color], ['god', null, '#9146FF']);
  assert.equal(recapMessage({ ...season(), summary: null }, god, 'en'), null, 'a season from before summaries has no recap');
});

test('the season keeps its best Pachinko run, from games shown to their end', () => {
  const store = Store.open(':memory:');
  store.startSession(T0);
  const user = (id: string, guild: 'red' | 'blue'): UserRow =>
    ({ user_id: id, display_name: `U${id}`, guild_id: guild, color: null, emote_id: null }) as UserRow;
  const picks = [user('1', 'red'), user('2', 'red'), user('3', 'blue')];
  const look = () => ({ emote: null });
  const runs: [string, number][] = [];

  const stopped = new PachinkoEngine(7, picks, look, 'en', null, (name, points) => runs.push([name, points]));
  stopped.next();
  stopped.finish();
  assert.deepEqual(runs, [], 'stopped during the show: it does not count');

  const played = new PachinkoEngine(7, picks, look, 'en', null, (name, points) => store.notePachinkoRun(name, points, T0));
  played.next();
  assert.equal(played.next(), null);
  played.finish();
  const best = played.bestRun()!;
  assert.ok(['U1', 'U2', 'U3'].includes(best.name), 'never an imp');
  const seasonId = store.currentSeasonId(T0);
  assert.deepEqual(store.bestPachinkoRun(seasonId), { displayName: best.name, points: best.points });

  store.notePachinkoRun('Lower', best.points - 1, T0);
  store.notePachinkoRun('Same', best.points, T0);
  assert.equal(store.bestPachinkoRun(seasonId)!.displayName, best.name, 'a lower or equal run does not replace it');
  store.notePachinkoRun('Higher', best.points + 1, T0);
  assert.equal(store.bestPachinkoRun(seasonId)!.displayName, 'Higher');

  store.endSeason(T0 + 1000, 0);
  assert.deepEqual(store.seasonHistory()[0]!.summary!.pachinko, { displayName: 'Higher', points: best.points + 1 });
  assert.equal(store.bestPachinkoRun(store.currentSeasonId(T0 + 2000)), null, 'the next season starts without one');
  store.close();
});

// --- Through the server ---------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let store: Store;
let server: GameServer;

before(async () => {
  store = Store.open(':memory:');
  store.startSession(T0);
  server = await startGameServer({ store, root, port: 0, now: () => T0 + 60_000, getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }) });
});

after(async () => {
  await server.close();
  store.close();
});

test('a season ended by hand gets its recap on the overlay, once', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const messages: any[] = [];
  socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  await new Promise((resolve) => setTimeout(resolve, config.server.broadcastIntervalMs + 200));
  assert.ok(!messages.some((m) => m.recap), 'nothing to recap yet');

  const response = await fetch(`http://127.0.0.1:${server.port}/api/season/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(response.status, 200);
  for (let i = 0; i < 40 && !messages.some((m) => m.recap); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const recap = messages.find((m) => m.recap);
  assert.ok(recap, 'the recap arrived');
  assert.equal(recap.type, 'announce');
  assert.match(recap.title, /^Season 1/);
  assert.equal(messages.filter((m) => m.recap).length, 1, 'once');
  socket.close();
});
