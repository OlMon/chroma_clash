import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config, type GuildId } from '../../src/config.ts';
import { Store, type UserRow } from '../../src/db/store.ts';
import { Battle } from '../../src/game/battle.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { DraftEngine, drawFighters, drawProblem, impsFor } from '../../src/server/draft-engine.ts';
import { startGameServer, type GameServer } from '../../src/server/server.ts';
import type { GameSnapshot } from '../../src/server/state.ts';
import { createRng } from '../../src/util/rng.ts';

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };
let nextId = 7000;

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

/** A store with a running session and `perGuild` chatters in each guild. */
function setupStore(perGuild: number): { store: Store; users: UserRow[] } {
  const store = Store.open(':memory:');
  store.startSession(T0);
  for (let i = 0; i < perGuild; i++) {
    for (const guild of ['red', 'green', 'blue'] as const) store.recordMessage(message(guild, T0 + i));
  }
  return { store, users: store.recentlyActive(0) };
}

test('the draw takes up to ten per guild by lot, whatever order chatters wrote in', () => {
  const { store, users } = setupStore(14);
  const picks = drawFighters(users, 'guild', createRng(5));
  for (const guild of ['red', 'green', 'blue'] as const) {
    assert.equal(picks.filter((u) => u.guild_id === guild).length, config.draft.perGuild);
  }
  assert.equal(new Set(picks.map((u) => u.user_id)).size, picks.length);
  assert.deepEqual(drawFighters([...users].reverse(), 'guild', createRng(5)), picks, 'writing first is no advantage');
  assert.notDeepEqual(drawFighters(users, 'guild', createRng(6)), picks);

  const few = users.filter((u) => u.guild_id !== 'blue').slice(0, 9);
  assert.equal(drawFighters(few, 'guild', createRng(1)).length, 9, 'a guild with few writers fields who it has');
  store.close();
});

test('a free-for-all draws thirty from everyone', () => {
  const { store, users } = setupStore(14);
  const picks = drawFighters(users, 'free', createRng(5));
  assert.equal(picks.length, config.draft.freeForAllFighters);
  assert.ok(new Set(picks.map((u) => u.guild_id)).size > 1);
  store.close();
});

test('a draw needs two guilds, or two fighters in a free-for-all', () => {
  const { store, users } = setupStore(3);
  const red = users.filter((u) => u.guild_id === 'red');
  assert.match(drawProblem(red, 'guild')!, /two guilds/);
  assert.equal(drawProblem(users, 'guild'), null);
  assert.match(drawProblem(red.slice(0, 1), 'free')!, /two chatters/);
  assert.equal(drawProblem(red, 'free'), null);
  store.close();
});

test('chatters who wrote shortly before the countdown fill the places its writers leave free', () => {
  const { store, users } = setupStore(14);
  const red = users.filter((u) => u.guild_id === 'red');
  const writers = [...red.slice(0, 4), ...users.filter((u) => u.guild_id === 'green').slice(0, 12)];
  const backups = users.filter((u) => !writers.includes(u));
  const picks = drawFighters(writers, 'guild', createRng(2), backups);
  const of = (guild: GuildId) => picks.filter((u) => u.guild_id === guild);
  assert.equal(of('red').length, config.draft.perGuild, 'red: its 4 writers and 6 who wrote before');
  for (const writer of red.slice(0, 4)) assert.ok(of('red').includes(writer), 'a writer is never left out for a backup');
  assert.ok(of('green').every((u) => writers.includes(u)), 'green had writers enough: no backups');
  assert.equal(of('blue').length, config.draft.perGuild, 'blue, with no writers, is filled from those who wrote before');
  assert.equal(new Set(picks.map((u) => u.user_id)).size, picks.length, 'nobody twice');
  assert.deepEqual(drawFighters(writers, 'guild', createRng(2), [...backups, ...writers]), picks, 'a writer among the backups changes nothing');

  const free = drawFighters(writers.slice(0, 5), 'free', createRng(4), backups);
  assert.equal(free.length, config.draft.freeForAllFighters);
  assert.deepEqual(free.slice(0, 5).map((u) => u.user_id).sort(), writers.slice(0, 5).map((u) => u.user_id).sort(), 'writers first');

  // Who counts as having written shortly before: by their latest message, not their tick.
  const late = message('red', T0 + 50_000);
  store.recordMessage(late);
  assert.deepEqual(store.recentWriters(T0 + 40_000, T0 + 60_000).map((u) => u.user_id), [late.userId]);
  store.setExcluded(late.login, true);
  assert.deepEqual(store.recentWriters(T0 + 40_000, T0 + 60_000), [], 'not an excluded chatter');
  store.close();
});

test('imps fill the places of guilds that drew fewer chatters; a guild nobody drew for sits out', () => {
  const { store, users } = setupStore(6);
  const picks = [...users.filter((u) => u.guild_id === 'red').slice(0, 5), ...users.filter((u) => u.guild_id === 'green').slice(0, 2)];
  const imps = impsFor(picks, 3);
  assert.deepEqual(imps.map((i) => i.guild), ['green', 'green', 'green']);
  assert.deepEqual(imps.map((i) => [i.id, i.name]), [['imp:green:1', 'Imp 1'], ['imp:green:2', 'Imp 2'], ['imp:green:3', 'Imp 3']]);
  assert.equal(impsFor(picks, 8).filter((i) => i.guild === 'red').length, 3, 'at least as many places as asked for');
  assert.equal(impsFor(picks, 8, 'de')[0]!.name, 'Wicht 1');
  store.close();
});

test('Guild Clash with imps: they fight in the guild\'s color, step in last, and never take the crown', () => {
  const { store, users } = setupStore(6);
  const picks = [...users.filter((u) => u.guild_id === 'red').slice(0, 6), ...users.filter((u) => u.guild_id === 'blue').slice(0, 1)];
  const engine = new DraftEngine(store, () => T0 + 60_000, 4, 'guild', picks);
  const step = engine.next()!;
  const blue = engine.lineup().teams.find((t) => t.name === 'Blue')!;
  assert.equal(blue.members.length, 6);
  assert.deepEqual(blue.members.slice(1).map((m) => [m.name, m.imp, m.id]), [1, 2, 3, 4, 5].map((n) => [`Imp ${n}`, true, undefined]));
  assert.equal(engine.lineup().teams.length, 2, 'green drew nobody and sits out');

  const battle = new Battle(step.setup!);
  const imps = battle.fighters.filter((f) => f.imp);
  assert.equal(imps.length, 5);
  assert.ok(imps.every((f) => f.side === 'blue' && f.class === null && !f.minion));
  // Three per guild on the field: blue's chatter first, then two imps; the other three wait.
  const blueChatter = battle.fighters.find((f) => f.side === 'blue' && !f.imp)!;
  assert.equal(blueChatter.benched, false);
  assert.deepEqual(imps.map((f) => f.benched), [false, false, true, true, true]);
  const result = battle.run();
  engine.apply(step, result);
  // Whoever wins, an imp never gets the crown.
  if (engine.champion) assert.ok(picks.includes(engine.champion));
  store.close();
});

test('Guild Clash: three per guild on the field, equal stats, and the Hero Clash reward', () => {
  const { store, users } = setupStore(12);
  // Levels must not matter: make one guild far stronger on paper.
  for (const user of users.filter((u) => u.guild_id === 'red')) store.addXp(user.user_id, 50_000);
  const picks = drawFighters(store.recentlyActive(0), 'guild', createRng(3));
  const now = T0 + 60_000;
  const engine = new DraftEngine(store, () => now, 3, 'guild', picks);

  const step = engine.next()!;
  assert.equal(engine.next(), null);
  assert.equal(step.holdMs, config.draft.lineupMs, 'the line-up stays long enough to place bets');
  const lineup = engine.lineup();
  assert.deepEqual(lineup.teams.map((t) => [t.name, t.members.length]), [['Red', 10], ['Green', 10], ['Blue', 10]]);
  const classNames = Object.values(config.classes.names);
  assert.ok(lineup.teams.every((t) => t.members.every((m) => classNames.includes(m.detail))), 'a class is shown, not a level');
  assert.ok(new Set(lineup.teams.flatMap((t) => t.members.map((m) => m.detail))).size >= 4, 'the classes are mixed');

  const battle = new Battle(step.setup!);
  assert.equal(battle.fighters.filter((f) => f.alive).length, 3 * config.draft.onFieldPerGuild);
  assert.equal(battle.fighters.filter((f) => f.benched).length, 30 - 9);
  for (const fighter of battle.fighters) {
    // A high level gives nothing here: the stats follow from the class alone.
    const stats = config.classes[fighter.class!];
    // Everyone is equally tough in this kind of fight (config.pace): only the class differs.
    assert.ok(Math.abs(fighter.maxHealth - config.battle.baseHealth * stats.health * step.setup!.toughness!) < 1e-9);
    assert.ok(Math.abs(fighter.damage - config.battle.baseDamage * stats.damage) < 1e-9);
    assert.equal(config.classes.names[fighter.class!], lineup.teams.flatMap((t) => t.members).find((m) => m.name === fighter.name)!.detail);
  }

  const result = battle.run();
  engine.apply(step, result);
  engine.finish();
  const winner = engine.winnerGuild!;
  assert.equal(winner, result.winner);
  assert.ok(store.guildBoostActive(winner, now + 1));
  assert.equal(engine.champion!.guild_id, winner, 'the crown goes to a fighter of the winning guild');
  assert.equal(store.champion()!.user_id, engine.champion!.user_id);
  assert.match(engine.closing().title, /wins the Guild Clash/);
  store.close();
});

test('free-for-all: everyone for themselves, a limited field, and nothing changes in the game', () => {
  const { store, users } = setupStore(12);
  const picks = drawFighters(users, 'free', createRng(8));
  const engine = new DraftEngine(store, () => T0 + 60_000, 8, 'free', picks);
  const step = engine.next()!;
  assert.equal(engine.lineup().teams.length, 1);
  assert.equal(engine.lineup().teams[0]!.members.length, 30);

  const battle = new Battle(step.setup!);
  assert.equal(battle.fighters.filter((f) => f.alive).length, config.draft.freeForAllOnField);
  assert.equal(new Set(battle.fighters.map((f) => f.team)).size, 30);
  const result = battle.run();
  engine.apply(step, result);
  engine.finish();

  assert.equal(engine.champion!.user_id, result.winner);
  assert.equal(engine.winnerGuild, null);
  assert.match(engine.closing().title, / wins$/);
  assert.equal(store.champion(), null, 'no crown');
  for (const guild of ['red', 'green', 'blue'] as const) assert.equal(store.guildBoostActive(guild, T0 + 60_001), false);
  assert.ok(store.recentlyActive(0).every((u) => u.battles === 0 && u.kills === 0), 'no statistics either');
  store.close();
});

// --- Through the server: the countdown and the endless mode --------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let store: Store;
let server: GameServer;
let base: string;
const original = { countdownMs: config.draft.countdownMs, lineupMs: config.draft.lineupMs, recentMs: config.draft.recentMs };

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
  // Far shorter than the panel allows, so the tests do not wait. Set after the
  // server started, because starting it applies the stored tuning values.
  config.draft.countdownMs = 700;
  config.draft.lineupMs = 200;
});

after(async () => {
  config.draft.countdownMs = original.countdownMs;
  config.draft.lineupMs = original.lineupMs;
  await server.close();
  store.close();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
  return { socket, messages, until };
}

test('a countdown collects chatters, shows the line-up, and starts the fight', async () => {
  const { socket, messages, until } = listen();
  await until((m) => m.type === 'state', 'state');
  assert.equal((await post('/api/draft/start', { mode: 'sideways' })).status, 400);

  const started = (await (await post('/api/draft/start', { mode: 'guild' })).json()) as GameSnapshot;
  assert.equal(started.battle?.title, 'Guild Clash: countdown');
  assert.equal((await post('/api/draft/start', { mode: 'free' })).status, 409, 'one at a time');

  // Twelve chatters write during the countdown; one of them twice, and the broadcaster once.
  const writers: ChatMessageEvent[] = [];
  for (let i = 0; i < 4; i++) for (const guild of ['red', 'green', 'blue'] as const) writers.push(message(guild, T0 + 60_000));
  for (const event of [...writers, writers[0]!]) {
    store.recordMessage(event);
    server.onChat(event);
  }
  const broadcaster = { ...message('red', T0 + 60_000), isBroadcaster: true };
  store.recordMessage(broadcaster);
  server.onChat(broadcaster);

  const counting = await until((m) => m.type === 'countdown' && m.joined === 12, 'countdown with 12 joined');
  assert.equal(counting.title, 'Guild Clash');
  assert.ok(counting.remainingMs > 0 && counting.remainingMs <= 700);
  assert.ok(counting.recent.length > 0);
  // The overlay shows the map banner during the countdown, in place of the corner panels.
  assert.deepEqual(counting.banner, { place: 'bottom', height: config.battle.bannerHeight, width: config.battle.arena.width });

  const lineup = await until((m) => m.type === 'announce' && m.lineup, 'line-up');
  assert.equal(lineup.holdMs, 200);
  assert.deepEqual(lineup.lineup.teams.map((t: any) => t.members.length), [4, 4, 4]);
  // Each fighter comes with their emote (none in this chat) and name color, to be found at a glance.
  for (const member of lineup.lineup.teams.flatMap((t: any) => t.members)) {
    assert.ok('emote' in member, `${member.name} has an emote field`);
    assert.ok(Object.values(COLORS).includes(member.color), `${member.name} has their name color`);
  }
  assert.ok(messages.some((m) => m.type === 'countdown' && m.done), 'the countdown display is cleared');

  const battle = await until((m) => m.type === 'battle-start', 'battle');
  assert.equal(battle.title, 'Guild Clash');
  assert.equal(battle.fighters.length, 12);
  assert.equal(battle.ambient, false);

  const stopped = (await (await post('/api/battle/stop', {})).json()) as GameSnapshot;
  assert.equal(stopped.battle, null);
  socket.close();
});

test('the countdown and the line-up time are settings of the control panel', async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  const keys = state.tuning.map((t) => t.key);
  assert.ok(keys.includes('draft.countdownMs') && keys.includes('draft.lineupMs'));
  assert.deepEqual(
    state.tuning.filter((t) => t.key.startsWith('draft.')).map((t) => t.default),
    [30, 15],
    'shown in seconds',
  );
  // The values come grouped into sections, each section's values together.
  const groups = state.tuning.map((t) => t.group);
  assert.deepEqual([...new Set(groups)], ['Experience', 'Land and Monument', 'Battles', 'Countdown fights']);
  assert.deepEqual(groups, [...groups].sort((a, b) => groups.indexOf(a) - groups.indexOf(b)), 'no section is split');

  const changed = (await (await post('/api/tuning', { key: 'draft.countdownMs', value: 45 })).json()) as GameSnapshot;
  assert.equal(config.draft.countdownMs, 45_000);
  assert.equal(changed.tuning.find((t) => t.key === 'draft.countdownMs')!.value, 45);
  assert.equal((await post('/api/tuning', { key: 'draft.countdownMs', value: 2 })).status, 400, 'at least 5 seconds');

  await post('/api/tuning', { key: 'draft.countdownMs', value: null });
  assert.equal(config.draft.countdownMs, 30_000);
  // Back to the short times the other tests here rely on.
  config.draft.countdownMs = 700;
  config.draft.lineupMs = 200;
});

test('a countdown nobody answers ends with a notice, not a fight', async () => {
  const { socket, until } = listen();
  // Nobody wrote shortly before it either (the test's chatters all wrote at the server's "now").
  config.draft.recentMs = 0;
  try {
    await post('/api/draft/start', { mode: 'free' });
    const notice = await until((m) => m.type === 'announce' && /two chatters/.test(m.subtitle), 'notice');
    assert.equal(notice.title, 'Free-for-all');
    const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
    assert.equal(state.battle, null);
  } finally {
    config.draft.recentMs = original.recentMs;
    socket.close();
  }
});

test('endless mode: an ambient free-for-all that leaves the game alone and yields to real events', async () => {
  const { socket, messages, until } = listen();
  await until((m) => m.type === 'state', 'state');
  const before = store.recentlyActive(0).map((u) => [u.user_id, u.xp, u.battles]);

  assert.equal((await post('/api/endless', { concurrent: 1 })).status, 400);
  assert.equal((await post('/api/endless', {})).status, 400);
  const sized = (await (await post('/api/endless', { concurrent: 5 })).json()) as GameSnapshot;
  assert.deepEqual(sized.endless, { active: false, concurrent: 5 });

  const on = (await (await post('/api/endless', { active: true })).json()) as GameSnapshot;
  assert.deepEqual(on.endless, { active: true, concurrent: 5 });
  assert.equal(on.battle, null, 'the control panel stays free for real events');
  const battle = await until((m) => m.type === 'battle-start', 'battle');
  assert.equal(battle.ambient, true);
  assert.equal(battle.fighters.length, 12);
  const frame = await until((m) => m.type === 'battle-frame' && m.t > 0, 'frame');
  assert.equal(frame.f.filter((f: number[]) => f[2]! > 0).length, 5, 'five on screen at once');

  // Changing the number restarts it at once.
  messages.length = 0;
  await post('/api/endless', { concurrent: 8 });
  const again = await until((m) => m.type === 'battle-frame' && m.t > 0, 'frame after the change');
  assert.equal(again.f.filter((f: number[]) => f[2]! > 0).length, 8);

  // A real event takes the screen: endless mode ends.
  const draft = (await (await post('/api/draft/start', { mode: 'free' })).json()) as GameSnapshot;
  assert.equal(draft.endless.active, false);
  assert.equal(draft.battle?.title, 'Free-for-all: countdown');
  await post('/api/battle/stop', {});

  await post('/api/endless', { active: true });
  const off = (await (await post('/api/endless', { active: false })).json()) as GameSnapshot;
  assert.equal(off.endless.active, false);
  assert.deepEqual(store.recentlyActive(0).map((u) => [u.user_id, u.xp, u.battles]), before, 'nothing in the game changed');
  socket.close();
});

test('the overlay panels can be dragged anywhere, hidden, and reset; endless fighters keep off them', async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.deepEqual(state.overlay.map, { x: 1072, y: 692, width: 820, height: 360, visible: true });
  assert.deepEqual(
    [state.overlay.stats.x, state.overlay.stats.y, state.overlay.stats.visible],
    [28, 28, true],
  );
  assert.equal(state.season.day, 1);
  assert.equal(state.season.wars, 0);

  assert.equal((await post('/api/overlay', { map: 'top-right' })).status, 400);
  assert.equal((await post('/api/overlay', { map: { x: 'left' } })).status, 400);
  assert.equal((await post('/api/overlay', {})).status, 400);

  const moved = (await (await post('/api/overlay', { map: { x: 600, y: 90 }, stats: { visible: false } })).json()) as GameSnapshot;
  assert.deepEqual([moved.overlay.map.x, moved.overlay.map.y], [600, 90]);
  assert.equal(moved.overlay.stats.visible, false);

  // A place outside the screen is pulled back inside it.
  const pushed = (await (await post('/api/overlay', { map: { x: 5000, y: -40 } })).json()) as GameSnapshot;
  assert.deepEqual([pushed.overlay.map.x, pushed.overlay.map.y], [1920 - 820, 0]);
  await post('/api/overlay', { map: { x: 600, y: 90 } });

  // An endless fight hides the panels like every battle: its fighters may go anywhere on the screen.
  const { socket, until } = listen();
  await post('/api/endless', { active: true, concurrent: 12 });
  const start = await until((m) => m.type === 'battle-start', 'the endless fight starts');
  assert.equal(start.ambient, true);
  await until((m) => m.type === 'battle-frame' && m.t > 1000, 'a second of endless fight');
  await post('/api/endless', { active: false });

  const reset = (await (await post('/api/overlay', { map: { reset: true }, stats: { reset: true, visible: true } })).json()) as GameSnapshot;
  assert.deepEqual([reset.overlay.map.x, reset.overlay.map.y, reset.overlay.stats.x, reset.overlay.stats.visible], [1072, 692, 28, true]);
  socket.close();
});

test('season statistics: every line can be switched off and on, and the panel shrinks with them', async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.deepEqual(
    state.seasonStats.map((row) => row.id),
    ['leading', 'champion', 'godSeason', 'godAllTime', 'wars', 'mostKills', 'highestLevel', 'players', 'started'],
  );
  assert.ok(state.seasonStats.every((row) => row.enabled), 'all lines are on at first');
  const value = (id: string) => state.seasonStats.find((row) => row.id === id)!.value;
  // The Monuments have barely begun and stand level.
  assert.ok(['nobody yet', 'tied'].includes(value('leading')), value('leading'));
  assert.equal(value('mostKills'), 'nobody yet');
  assert.equal(value('godAllTime'), '0 : 0');
  assert.match(value('started'), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number(value('players')) >= 12);
  const full = state.overlay.stats.height;

  assert.equal((await post('/api/overlay', { line: { id: 'weather', enabled: false } })).status, 400);
  const fewer = (await (await post('/api/overlay', { line: { id: 'players', enabled: false } })).json()) as GameSnapshot;
  assert.equal(fewer.seasonStats.find((row) => row.id === 'players')!.enabled, false);
  assert.equal(fewer.overlay.stats.height, full - config.overlay.statsPanel.rowHeight);
  const back = (await (await post('/api/overlay', { line: { id: 'players', enabled: true } })).json()) as GameSnapshot;
  assert.equal(back.overlay.stats.height, full);

  // Kills count for the season's top killer, and a new season starts the count again.
  const [first, second] = store.recentlyActive(0);
  store.addFightStats([
    { id: first!.user_id, kills: 3, alive: true },
    { id: second!.user_id, kills: 5, alive: false },
  ]);
  store.addXp(first!.user_id, 500);
  const after = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.equal(after.seasonStats.find((row) => row.id === 'mostKills')!.value, `${second!.display_name} · 5 kills`);
  assert.equal(after.seasonStats.find((row) => row.id === 'highestLevel')!.value, `${first!.display_name} · level 3`);
  assert.deepEqual(store.seasonTopKiller(), { displayName: second!.display_name, kills: 5 });
});

test('the god can be started three ways; the history is served', async () => {
  assert.equal((await post('/api/god/start', { kind: 'sideways' })).status, 400);

  // Friendly: always there while the layer is on, and it leaves the map fight available.
  const before = (await (await fetch(`${base}/api/state`)).json()) as GameSnapshot;
  assert.deepEqual(
    [before.god.versusAvailable, before.god.versusUsed, before.god.friendlyAvailable],
    [true, false, true],
  );
  const friendly = (await (await post('/api/god/start', { kind: 'friendly' })).json()) as GameSnapshot;
  assert.match(friendly.battle!.title, /friendly/);
  await post('/api/battle/stop', {});

  const versus = await post('/api/god/start', { kind: 'versus' });
  assert.equal(versus.status, 200);
  await post('/api/battle/stop', {});
  const wrath = await post('/api/god/start', { kind: 'wrath' });
  assert.equal(wrath.status, 200);
  await post('/api/battle/stop', {});

  const history = (await (await fetch(`${base}/api/history`)).json()) as { seasons: unknown[] };
  assert.deepEqual(history.seasons, []);
  await post('/api/season/end', { confirm: true });
  const after = (await (await fetch(`${base}/api/history`)).json()) as { seasons: { id: number; winner: string }[] };
  assert.equal(after.seasons.length, 1);
  assert.equal(after.seasons[0]!.id, 1);
  assert.ok(['red', 'green', 'blue'].includes(after.seasons[0]!.winner));
});

// Last: it adds chatters that the tests above would count.
test('Pachinko: drawn like a Guild Clash, played on one board per guild, and the most points win', async () => {
  const saved = { ...config.pachinko };
  Object.assign(config.pachinko, { targetMs: 600, minGapMs: 10, maxGapMs: 40, hopMs: 15, holdMs: 60 });
  // Only this test's chatters: nobody else wrote shortly before.
  config.draft.recentMs = 0;
  try {
    const { socket, until } = listen();
    await until((m) => m.type === 'state', 'state');
    const started = (await (await post('/api/draft/start', { mode: 'pachinko' })).json()) as GameSnapshot;
    assert.equal(started.battle?.title, 'Pachinko: countdown');
    // Five chatters; however the guilds come out, they are not all the same size.
    for (const guild of ['red', 'red', 'red', 'green', 'green'] as const) {
      const event = message(guild, T0 + 60_000);
      store.recordMessage(event);
      server.onChat(event);
    }
    const lineup = await until((m) => m.type === 'announce' && m.lineup && m.title?.startsWith('Pachinko'), 'line-up');
    const chatters = lineup.lineup.teams.map((t: any) => t.members.filter((m: any) => !m.imp).length);
    assert.equal(chatters.reduce((a: number, b: number) => a + b, 0), 5);
    // The streamer's imps fill the empty places, so every guild in the game has as many.
    const balls = Math.max(config.pachinko.minBalls, ...chatters);
    for (const team of lineup.lineup.teams) {
      assert.equal(team.members.length, balls);
      assert.ok(team.members.filter((m: any) => m.imp).every((m: any) => /^Imp \d+$/.test(m.name) && !m.id));
    }
    const game = await until((m) => m.type === 'pachinko', 'the boards');
    assert.equal(game.boards.length, chatters.length, 'a board per guild with players');
    for (const board of game.boards) {
      assert.equal(board.drops.length, balls, 'every guild drops as many balls');
      const names = board.drops.filter((d: any) => !d.imp).map((d: any) => d.name);
      assert.equal(new Set(names).size, names.length, 'each chatter drops once; imps take the other balls');
      for (const drop of board.drops.filter((d: any) => d.imp)) assert.deepEqual([drop.color, drop.emote], [board.color, null]);
    }
    // The map banner shows during Pachinko as in a battle: at the bottom unless set otherwise.
    assert.deepEqual(game.banner, { place: 'bottom', height: config.battle.bannerHeight, width: config.battle.arena.width });
    const closing = await until((m) => m.type === 'announce' && /wins Pachinko/.test(m.title ?? ''), 'the result');
    const winner = game.boards.find((b: any) => b.team === game.winner);
    assert.ok(closing.title.startsWith(winner.name));
    assert.ok(closing.subtitle.includes(String(winner.total)));
    socket.close();
  } finally {
    Object.assign(config.pachinko, saved);
    config.draft.recentMs = original.recentMs;
  }
});

test('every message during a countdown counts, also from chatters who already earned this window\'s tick', async () => {
  const { socket, until } = listen();
  // Three chatters write before the countdown: they get their one tick of this 5-minute window.
  const early = (['red', 'green', 'blue'] as const).map((guild) => message(guild, T0 + 60_000));
  for (const event of early) assert.equal(store.recordMessage(event)!.tickAwarded, true);
  // Only these three: nobody else wrote shortly before (the recent writers have a test of their own).
  config.draft.recentMs = 0;
  await post('/api/draft/start', { mode: 'pachinko' });
  config.draft.recentMs = original.recentMs;
  // During the countdown, in the same window, they write again: no tick, but they join.
  for (const event of early) {
    const again = { ...event, sentAt: T0 + 61_000 };
    assert.equal(store.recordMessage(again)!.tickAwarded, false, 'one tick per window');
    server.onChat(again);
  }
  await until((m) => m.type === 'countdown' && m.joined === 3, 'all three joined');
  await post('/api/battle/stop', {});
  socket.close();
});
