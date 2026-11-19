import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { config } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { monumentIncome, startingLand } from '../../src/game/land.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { applyTuning, setTuning, tuningValues } from '../../src/server/tuning.ts';

const T0 = 1_700_000_100_000;
const WINDOW = 5 * 60_000;

function message(sentAt: number, userId: string, color: string, login = `user${userId}`): ChatMessageEvent {
  return {
    type: 'chat',
    channel: 'somechannel',
    userId,
    login,
    displayName: login,
    color,
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    sentAt,
  };
}

function openStore(): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters);
  store.startSession(T0);
  return store;
}

const owners = (store: Store) =>
  Object.fromEntries(store.tiles().filter((t) => !t.is_city).map((t) => [t.tile_id, t.owner_guild_id]));

test('a new database starts its first season with the land dealt in equal sectors', () => {
  const store = Store.open(':memory:');
  const dealt = startingLand('equal', () => 0);
  assert.deepEqual(owners(store), { ...dealt, '0,0': null });
  for (const guild of ['red', 'green', 'blue'] as const) assert.equal(store.ownedTiles(guild), 5);
  assert.equal(store.seasonStart(), 'equal');
  store.close();
});

test('ended by hand, a season goes to the guild whose Monument is furthest', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000'));
  store.recordMessage(message(T0 + 1, '2', '#0000FF'));
  store.addMonument('blue', 900);
  store.addMonument('red', 400);

  const result = store.endSeason(T0 + 10 * WINDOW, 0.5);
  assert.deepEqual(result, { seasonId: 1, winner: 'blue' });
  assert.deepEqual(store.lastSeason(), { season_id: 1, winner_guild_id: 'blue' });
  assert.equal(store.currentSeasonId(T0 + 11 * WINDOW), 2);
  assert.equal(store.getUser('2')!.seasons_won, 1);
  assert.equal(store.getUser('1')!.seasons_won, 0);
  store.close();
});

test('ties go to the guild with more tiles, then to the seed', () => {
  const store = openStore();
  store.setTileOwner('0,0', 'green');
  assert.equal(store.endSeason(T0, 0).winner, 'green', 'equal Monuments, green holds one tile more');

  // A fresh season: everything is equal, so the seed decides among all three.
  const winners = new Set([0, 0.4, 0.99].map((tieBreak) => store.endSeason(T0, tieBreak).winner));
  assert.equal(winners.size, 3);
  store.close();
});

test('a finished Monument wins the season at once', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000'));
  store.addMonument('red', config.monument.goal - 5);
  assert.equal(store.currentSeasonId(T0), 1);

  // The next window's income takes red over the goal.
  for (const tile of store.tiles().filter((t) => t.owner_guild_id === 'red')) store.setTileLevel(tile.tile_id, 2);
  const result = store.recordMessage(message(T0 + WINDOW, '1', '#FF0000'))!;
  assert.equal(result.seasonWonBy, 'red');
  assert.deepEqual(store.lastSeason(), { season_id: 1, winner_guild_id: 'red' });
  assert.equal(store.currentSeasonId(T0 + WINDOW), 2);
  assert.equal(result.user.seasons_won, 1);
  assert.equal(result.user.xp, 0, 'the winner starts the new season like everyone else');
  assert.deepEqual(Object.values(store.monuments()), [0, 0, 0]);

  const later = store.recordMessage(message(T0 + 2 * WINDOW, '1', '#FF0000'))!;
  assert.equal(later.seasonWonBy, undefined);
  store.close();
});

test('a new season deals the land again and resets development, Monuments and levels; lifetime statistics stay', () => {
  const store = openStore();
  for (let window = 0; window < 6; window++) store.recordMessage(message(T0 + window * WINDOW, '1', '#FF0000'));
  store.setTileOwner('1,-1', 'blue', false);
  store.setTileOwner('-1,0', null, true);
  for (const tile of store.tiles()) store.setTileLevel(tile.tile_id, 4);
  store.addMonument('green', 300);
  store.addFightStats([{ id: '1', kills: 3, alive: false }]);
  const before = store.getUser('1')!;
  assert.ok(before.xp > 0 && before.level > 0);

  store.endSeason(T0 + 10 * WINDOW, 0);

  assert.deepEqual(owners(store), { ...startingLand('equal', () => 0), '0,0': null });
  // Everything starts undeveloped again; only the center keeps its fixed level.
  assert.ok(store.tiles().every((t) => t.points === 0 && t.scorched === 0 && t.level === (t.tile_id === '0,0' ? 5 : 0)));
  assert.deepEqual(Object.values(store.monuments()), [0, 0, 0]);
  const user = store.getUser('1')!;
  assert.equal(user.xp, 0);
  assert.equal(user.level, 0);
  assert.equal(user.guild_id, null);
  assert.deepEqual([user.kills, user.deaths, user.battles], [3, 1, 1], 'lifetime statistics stay');
  assert.deepEqual(store.guildSizes(), { red: 0, green: 0, blue: 0 });
  assert.deepEqual(store.recentlyActive(0), [], 'nobody fights until they are assigned again');
  store.close();
});

test('with the random start, the next season deals the same tiles at random', () => {
  const store = openStore();
  store.setSeasonStart('random');
  assert.equal(store.seasonStart(), 'random');
  store.endSeason(T0, 0.3);
  const dealt = owners(store);
  assert.equal(dealt['0,0'], null, 'the center is still neutral');
  for (const guild of ['red', 'green', 'blue'] as const) assert.equal(store.ownedTiles(guild), 5);
  assert.notDeepEqual(dealt, { ...startingLand('equal', () => 0), '0,0': null });

  store.setSeasonStart('equal');
  store.endSeason(T0, 0.3);
  assert.deepEqual(owners(store), { ...startingLand('equal', () => 0), '0,0': null });
  store.close();
});

test('after a season chatters are assigned again, from their current color', () => {
  const store = openStore();
  const first = store.recordMessage(message(T0, '1', '#FF0000'))!.user;
  assert.equal(first.guild_id, 'red');
  store.endSeason(T0 + WINDOW, 0);

  const again = store.recordMessage(message(T0 + 2 * WINDOW, '1', '#0000FF'))!;
  assert.equal(again.user.guild_id, 'blue', 'the guild lock is per season');
  assert.equal(again.tickAwarded, true);
  assert.equal(again.user.xp, 15);
  store.close();
});

test('excluded users earn nothing and do not fight; they can be let back in', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000', 'alice'));
  store.recordMessage(message(T0, '2', '#0000FF', 'spammer'));
  assert.equal(store.recentlyActive(0).length, 2);

  store.setExcluded('@Spammer ', true);
  assert.deepEqual(store.excludedLogins(), ['spammer']);
  assert.equal(store.recordMessage(message(T0 + WINDOW, '2', '#0000FF', 'spammer')), null);
  assert.deepEqual(store.recentlyActive(0).map((u) => u.login), ['alice']);
  assert.deepEqual(store.activeByGuild(0), { red: 1, green: 0, blue: 0 });

  store.setExcluded('spammer', false);
  assert.deepEqual(store.excludedLogins(), []);
  assert.equal(store.recordMessage(message(T0 + 2 * WINDOW, '2', '#0000FF', 'spammer'))!.tickAwarded, true);
  store.close();
});

test('tuning values can be changed, are kept in the database, and can be reset', () => {
  const store = openStore();
  after(() => {
    // The config is shared by all tests in this process: put the defaults back.
    for (const key of ['ticks.xpPerTick', 'battle.durationMs', 'monument.goal']) setTuning(store, key, null);
    store.close();
  });

  setTuning(store, 'ticks.xpPerTick', 25);
  assert.equal(config.ticks.xpPerTick, 25);
  assert.equal(store.recordMessage(message(T0, '1', '#FF0000'))!.user.xp, 30, '25, plus 5 for the tiles');

  setTuning(store, 'battle.durationMs', 75);
  assert.equal(config.battle.durationMs, 75_000, 'the panel works in seconds');
  const shown = tuningValues().find((t) => t.key === 'battle.durationMs')!;
  assert.deepEqual([shown.value, shown.default], [75, 90]);

  setTuning(store, 'monument.goal', 500);
  assert.equal(config.monument.goal, 500, 'a shorter season');
  assert.deepEqual(
    [...new Set(tuningValues().map((t) => t.group))],
    ['Experience', 'Land and Monument', 'Battles', 'Countdown fights'],
  );

  // A restart reads the overrides back from the database.
  config.ticks.xpPerTick = 10;
  applyTuning(store);
  assert.equal(config.ticks.xpPerTick, 25);

  assert.throws(() => setTuning(store, 'ticks.xpPerTick', 0), /between 1 and 100/);
  assert.throws(() => setTuning(store, 'no.such.value', 1), /Unknown/);
  assert.equal(config.ticks.xpPerTick, 25, 'a rejected value changes nothing');

  setTuning(store, 'ticks.xpPerTick', null);
  assert.equal(config.ticks.xpPerTick, 10);
});

test('season kills start again with a new season; lifetime kills stay', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000'));
  store.addFightStats([{ id: '1', kills: 4, alive: true }]);
  assert.deepEqual(store.seasonTopKiller(), { displayName: 'user1', kills: 4 });
  assert.equal(store.seasonPlayers(), 1);

  store.endSeason(T0 + WINDOW, 0);
  assert.equal(store.seasonTopKiller(), null);
  assert.equal(store.seasonTopLevel(), null);
  assert.equal(store.seasonPlayers(), 0, 'nobody has played the new season yet');
  assert.equal(store.getUser('1')!.kills, 4);
  store.close();
});

test('the history lists every finished season, newest first, with its winner, Wars and the god\'s score', () => {
  const store = openStore();
  assert.deepEqual(store.seasonHistory(), [], 'the running season is not in it');

  // Season 1: two Wars, the god 1 : 2 against chat and one friendly fight; red finishes its Monument.
  store.endWar(store.createWar(T0, 1), T0 + 1);
  store.endWar(store.createWar(T0 + 2, 2), T0 + 3);
  const fight = (kind: 'wrath' | 'versus' | 'friendly', godWon: boolean) =>
    store.insertGodFight({ kind, tileId: null, targetGuild: null, godWon, topDamageGuild: null, startedAt: T0, seed: 1 });
  fight('wrath', true);
  fight('wrath', false);
  fight('versus', false);
  fight('friendly', true);
  const day = 86_400_000;
  store.endSeason(T0 + 3 * day, 0, 'red');

  // Season 2: no War, and the god wins it.
  store.endSeason(T0 + 4 * day, 0, 'god');

  // The summaries have their own test; here only the rows.
  assert.deepEqual(store.seasonHistory().map(({ summary: _summary, ...row }) => row), [
    { id: 2, startedAt: T0 + 3 * day, endedAt: T0 + 4 * day, winner: 'god', wars: 0, godWins: 0, godLosses: 0 },
    { id: 1, startedAt: T0, endedAt: T0 + 3 * day, winner: 'red', wars: 2, godWins: 1, godLosses: 2 },
  ]);
  assert.equal(store.currentSeasonId(T0 + 4 * day), 3);
  store.close();
});

test('the center is the god\'s tile: held for 30 minutes of stream time, then taken back', () => {
  const store = openStore();
  const { id, level, holdWindows } = config.land.center;
  assert.deepEqual(store.center(), { id, owner: null, windowsLeft: 0 });
  assert.equal(store.tiles().find((t) => t.tile_id === id)!.level, level, 'a fixed level');

  store.recordMessage(message(T0, '1', '#FF0000'));
  store.setTileOwner(id, 'red');
  assert.deepEqual(store.center(), { id, owner: 'red', windowsLeft: holdWindows });
  assert.equal(store.ownedTiles('red'), 6);

  // While held it feeds red's Monument like a level 5 tile, and it is never developed.
  const before = store.monuments().red;
  store.recordMessage(message(T0 + WINDOW, '1', '#FF0000'));
  const levels = store.tiles().filter((t) => t.owner_guild_id === 'red' && t.is_city === 0).map((t) => t.level);
  assert.equal(store.monuments().red - before, monumentIncome(levels));
  assert.ok(levels.includes(level), 'the center counts with its fixed level');
  assert.equal(store.tiles().find((t) => t.tile_id === id)!.points, 0);
  assert.equal(store.center().windowsLeft, holdWindows - 1);

  // Spam inside a window does not shorten the time; only stream time does.
  store.recordMessage(message(T0 + WINDOW + 1000, '1', '#FF0000'));
  store.recordMessage(message(T0 + WINDOW + 2000, '2', '#00FF00'));
  assert.equal(store.center().windowsLeft, holdWindows - 1);

  let reclaimed = 0;
  for (let window = 2; window <= holdWindows; window++) {
    const result = store.recordMessage(message(T0 + window * WINDOW, '1', '#FF0000'))!;
    if (result.centerReclaimed) reclaimed = window;
  }
  assert.equal(reclaimed, holdWindows, 'after six windows the god takes it back');
  assert.deepEqual(store.center(), { id, owner: null, windowsLeft: 0 });
  assert.equal(store.ownedTiles('red'), 5);
  assert.equal(store.tiles().find((t) => t.tile_id === id)!.level, level, 'its level is untouched');

  // A new holder gets the full time again, and a new season frees it.
  store.setTileOwner(id, 'blue', false, true);
  assert.deepEqual(store.center(), { id, owner: 'blue', windowsLeft: holdWindows });
  assert.equal(store.tiles().find((t) => t.tile_id === id)!.level, level, 'taking it by force does not halve it');
  store.setTileLevel(id, 9);
  assert.equal(store.tiles().find((t) => t.tile_id === id)!.level, level);
  store.endSeason(T0 + 20 * WINDOW, 0);
  assert.deepEqual(store.center(), { id, owner: null, windowsLeft: 0 });
  store.close();
});

test('time on the center does not run while nobody chats', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000'));
  store.setTileOwner(config.land.center.id, 'red');
  // The next message comes a day later: one window of stream time has passed, not 288.
  store.recordMessage(message(T0 + 24 * 12 * WINDOW, '1', '#FF0000'));
  assert.equal(store.center().windowsLeft, config.land.center.holdWindows - 1);
  assert.equal(store.center().owner, 'red');
  store.close();
});

test('the history keeps what a season looked like when it ended', () => {
  const store = openStore();
  store.recordMessage(message(T0, '1', '#FF0000', 'alice'));
  store.recordMessage(message(T0 + 1, '2', '#0000FF', 'bob'));
  store.addXp('1', 900);
  store.addFightStats([
    { id: '1', kills: 2, alive: true },
    { id: '2', kills: 7, alive: false },
  ]);
  const session = store.activeSession()!;
  store.insertClash(session.session_id, T0 + 10, 1, store.getUser('2'));
  store.insertClash(session.session_id, T0 + 20, 2, store.getUser('2'));
  store.insertClash(session.session_id, T0 + 30, 3, store.getUser('1'));
  store.addMonument('blue', 3000);
  for (const tile of store.tiles().filter((t) => t.owner_guild_id === 'red')) store.setTileLevel(tile.tile_id, 3);

  store.endSeason(T0 + WINDOW, 0);
  const [season] = store.seasonHistory();
  assert.equal(season!.winner, 'blue');
  const summary = season!.summary!;
  assert.equal(summary.endedBy, 'streamer', 'ended by hand');
  assert.deepEqual(summary.topLevel, { displayName: 'alice', level: store.getUser('1') ? 4 : 0 });
  assert.deepEqual(summary.topKiller, { displayName: 'bob', kills: 7 });
  assert.deepEqual(summary.champion, { displayName: 'bob', wins: 2 });
  assert.equal(summary.players, 2);
  assert.equal(summary.monumentGoal, config.monument.goal);
  // 3000 given, and its window's income from five tiles at level 0.
  assert.equal(summary.guilds.blue.monument, 3000 + monumentIncome([0, 0, 0, 0, 0]));
  assert.deepEqual(
    [summary.guilds.red.tiles, summary.guilds.red.development, summary.guilds.red.members],
    [5, 15, 1],
  );

  // The next season's Clash wins are its own.
  store.recordMessage(message(T0 + 2 * WINDOW, '1', '#FF0000', 'alice'));
  store.insertClash(session.session_id, T0 + 3 * WINDOW, 4, store.getUser('1'));
  store.endSeason(T0 + 4 * WINDOW, 0);
  const [second, first] = store.seasonHistory();
  assert.deepEqual(second!.summary!.champion, { displayName: 'alice', wins: 1 });
  assert.deepEqual(first!.summary!.champion, { displayName: 'bob', wins: 2 }, 'the first season is unchanged');

  // The history also records the two ways a season decides itself.
  store.endSeason(T0 + 5 * WINDOW, 0, 'god');
  assert.equal(store.seasonHistory()[0]!.summary!.endedBy, 'god');
  store.recordMessage(message(T0 + 6 * WINDOW, '1', '#FF0000', 'alice'));
  store.addMonument('red', config.monument.goal);
  assert.equal(store.recordMessage(message(T0 + 7 * WINDOW, '1', '#FF0000', 'alice'))!.seasonWonBy, 'red');
  assert.equal(store.seasonHistory()[0]!.summary!.endedBy, 'monument');
  store.close();
});

test('each season deals the three Monument designs anew, a different one to each guild', () => {
  const store = openStore();
  const designs = store.monumentDesigns();
  assert.deepEqual(Object.values(designs).sort(), [0, 1, 2]);
  assert.deepEqual(store.monumentDesigns(), designs, 'stable within a season');

  const seen = new Set<string>();
  for (let season = 0; season < 12; season++) {
    store.endSeason(T0 + season * WINDOW, (season * 0.37) % 1);
    const dealt = store.monumentDesigns();
    assert.deepEqual(Object.values(dealt).sort(), [0, 1, 2]);
    seen.add(JSON.stringify(dealt));
    // The ended season remembers what each guild built.
    const summary = store.seasonHistory()[0]!.summary!;
    assert.ok([0, 1, 2].includes(summary.guilds.red.design!));
  }
  assert.ok(seen.size > 2, 'the designs change hands between seasons');
  store.close();
});

test('display settings: everything on by default, each switch stored on its own', () => {
  const store = openStore();
  assert.deepEqual(store.displaySettings(), {
    theme: null,
    pixelateEmotes: true,
    animatedEmotes: true,
    randomEmotes: true,
    emoteSources: { bttv: true, ffz: true, '7tv': true },
  });
  store.setDisplay({ theme: 'plain', animatedEmotes: false, emoteSources: { ffz: false } });
  store.setDisplay({ emoteSources: { '7tv': false } });
  assert.deepEqual(store.displaySettings(), {
    theme: 'plain',
    pixelateEmotes: true,
    animatedEmotes: false,
    randomEmotes: true,
    emoteSources: { bttv: true, ffz: false, '7tv': false },
  });
  store.close();
});
