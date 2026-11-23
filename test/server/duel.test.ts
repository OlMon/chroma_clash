import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config, type GuildId } from '../../src/config.ts';
import { Store, type UserRow } from '../../src/db/store.ts';
import { Battle } from '../../src/game/battle.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { recapMessage } from '../../src/server/recap.ts';
import { DuelEngine, drawDuelist } from '../../src/server/duel-engine.ts';
import { startGameServer, type GameServer, type ServerSnapshot } from '../../src/server/server.ts';
import { createRng } from '../../src/util/rng.ts';

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };
let nextId = 9000;

function message(guild: GuildId, sentAt: number): ChatMessageEvent {
  const id = String(++nextId);
  return {
    type: 'chat',
    channel: 'test',
    userId: id,
    login: `u${id}`,
    displayName: `U${id}`,
    color: COLORS[guild],
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    sentAt,
  };
}

/** A store with a session and chatters of the given guilds, writing one after another. */
function setupStore(guilds: GuildId[]): { store: Store; users: UserRow[] } {
  const store = Store.open(':memory:');
  store.startSession(T0);
  const ids = guilds.map((guild, i) => {
    const event = message(guild, T0 + i * 1000);
    store.recordMessage(event);
    return event.userId;
  });
  return { store, users: ids.map((id) => store.getUser(id)!) };
}

test('a duelist left to the lot comes from another guild when there is one', () => {
  const row = (id: string, guild: GuildId) => ({ user_id: id, guild_id: guild }) as UserRow;
  const reds = [row('1', 'red'), row('2', 'red'), row('3', 'red')];
  const blue = row('4', 'blue');
  for (let seed = 0; seed < 20; seed++) {
    assert.equal(drawDuelist([...reds, blue], reds[0]!, createRng(seed))?.user_id, '4');
  }
  // Only the same guild left: then one of them, never the first duelist.
  for (let seed = 0; seed < 20; seed++) {
    assert.notEqual(drawDuelist(reds, reds[0]!, createRng(seed))!.user_id, '1');
  }
  assert.equal(drawDuelist([reds[0]!], reds[0]!, createRng(1)), null, 'nobody else');
  assert.equal(drawDuelist([], null, createRng(1)), null);
});

test('a duel shows the two face to face, then one fight with equal, large fighters', () => {
  const { store, users } = setupStore(['red', 'green']);
  const [a, b] = [{ ...users[0]!, guild_id: 'red' }, { ...users[1]!, guild_id: 'green' }] as [UserRow, UserRow];
  const duel = new DuelEngine(store, () => T0 + 60_000, 42, a, b);
  const step = duel.next()!;
  assert.equal(duel.next(), null, 'one fight only');
  assert.equal(step.kind, 'duel');
  const lineup = step.lineup as ReturnType<DuelEngine['lineup']>;
  assert.equal(lineup.duel, true);
  assert.deepEqual(lineup.teams.map((t) => t.members[0]!.id), [a.user_id, b.user_id]);
  const guildColor = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!.color;
  assert.deepEqual(lineup.teams.map((t) => t.color), [guildColor('red'), guildColor('green')], 'each in their guild\'s color');
  assert.equal(step.meta?.duel, true);
  assert.equal(step.holdMs, config.duel.lineupMs);

  const battle = new Battle(step.setup!);
  assert.equal(battle.fighters.length, 2);
  assert.ok(battle.fighters.every((f) => f.radius === config.duel.radius), 'large on screen');
  assert.deepEqual(battle.fighters.map((f) => f.class), [duel.cls, duel.cls], 'both the class the line-up showed');
  assert.deepEqual(lineup.teams.map((t) => t.members[0]!.detail), [`${duel.cls[0]!.toUpperCase()}${duel.cls.slice(1)}`, `${duel.cls[0]!.toUpperCase()}${duel.cls.slice(1)}`]);
  assert.equal(battle.obstacleFrame(), null, 'no obstacles: the large duelists would get stuck');
  const result = battle.run();
  duel.apply(step, result);
  duel.finish();
  duel.finish();
  const closing = duel.closing();
  if (result.winner) {
    const winner = users.find((u) => u.user_id === result.winner)!;
    assert.match(closing.title, new RegExp(winner.display_name));
    assert.equal(store.duelWins(winner.user_id, T0 + 60_000), 1, 'counted once');
  } else {
    assert.equal(closing.subtitle, 'A draw: both fell at once.');
  }
  store.close();
});

test('two duelists of the same guild still look different', () => {
  const { store, users } = setupStore(['blue', 'blue']);
  const [a, b] = users.map((user) => ({ ...user, guild_id: 'blue' })) as [UserRow, UserRow];
  const lineup = new DuelEngine(store, () => T0, 1, a, b).lineup();
  assert.notEqual(lineup.teams[0]!.color, lineup.teams[1]!.color);
  store.close();
});

test("the season counts duel wins, and the recap names who won most", () => {
  const { store, users } = setupStore(['red', 'green']);
  const [a, b] = users as [UserRow, UserRow];
  store.noteDuelWin(a, T0);
  store.noteDuelWin(b, T0);
  store.noteDuelWin(b, T0);
  assert.equal(store.duelWins(a.user_id, T0), 1);
  assert.deepEqual(store.topDuelist(store.currentSeasonId(T0)), { displayName: b.display_name, wins: 2 });
  store.endSeason(T0 + 1000, 0);
  const season = store.seasonHistory()[0]!;
  assert.deepEqual(season.summary?.duel, { displayName: b.display_name, wins: 2 });
  const recap = recapMessage(season, { name: 'TheStreamer', color: '#FFD54A' }, 'en')!;
  assert.ok(recap.recap.rows.some((row) => row.label === 'Most duel wins' && row.value === `${b.display_name} · 2 wins`));
  assert.equal(store.duelWins(b.user_id, T0 + 2000), 0, 'a new season starts from nothing');
  store.close();
});

// --- Through the server --------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let served: { store: Store; users: UserRow[] };
let server: GameServer;
let base: string;
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async () => (await (await fetch(`${base}/api/state`)).json()) as ServerSnapshot;

before(async () => {
  served = setupStore(['red', 'green', 'blue']);
  server = await startGameServer({
    store: served.store,
    root,
    port: 0,
    now: () => T0 + 60_000,
    getSource: () => ({ kind: 'sim', channel: 'test', status: 'testing' }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  served.store.close();
});

test('the control panel lists who wrote lately, the latest first', async () => {
  const { candidates, minutes } = (await state()).duel;
  assert.equal(minutes, config.duel.recentMs / 60_000);
  assert.deepEqual(candidates.map((c) => c.id), [...served.users].reverse().map((u) => u.user_id));
  assert.deepEqual(candidates.map((c) => c.guild), [...served.users].reverse().map((u) => u.guild_id));
});

test('a duel starts with the chatters picked, or drawn by lot; one at a time', async () => {
  const [red, green] = served.users as [UserRow, UserRow];
  assert.equal((await post('/api/duel/start', { a: red.user_id, b: red.user_id })).status, 400, 'the same chatter twice');
  assert.equal((await post('/api/duel/start', { a: 'nobody', b: null })).status, 400, 'an unknown chatter');
  assert.equal((await post('/api/duel/start', { a: 5 })).status, 400);
  assert.equal((await post('/api/duel/start', { a: red.user_id, b: green.user_id })).status, 200);
  assert.equal((await state()).battle?.title, 'Duel');
  assert.equal((await post('/api/duel/start', { a: null, b: null })).status, 409, 'busy');
  assert.equal((await post('/api/battle/stop', {})).status, 200);
});
