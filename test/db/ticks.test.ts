import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { fertility, homeTile, levelCost } from '../../src/game/land.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';

const MIN = 60_000;
/** A time that lies exactly on a window boundary. */
const T0 = 1_700_000_100_000;

function message(sentAt: number, overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    type: 'chat',
    channel: 'somechannel',
    userId: '42',
    login: 'alice',
    displayName: 'Alice',
    color: '#FF0000',
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    sentAt,
    ...overrides,
  };
}

/** A store whose channel size is pinned to the reference, so costs are the base costs. */
function openStore(): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters);
  return store;
}

const redTiles = (store: Store) => store.tiles().filter((t) => t.owner_guild_id === 'red' && !t.is_city);

test('no ticks while the background layer is off, but the user is still recorded', () => {
  const store = openStore();
  const result = store.recordMessage(message(T0))!;
  assert.equal(result.tickAwarded, false);
  assert.equal(result.user.xp, 0);
  assert.ok(store.getUser('42'));
  assert.deepEqual(Object.values(store.monuments()), [0, 0, 0]);
  store.close();
});

test('one tick per chatter per window: XP, a development point, and Monument growth', () => {
  const store = openStore();
  const session = store.startSession(T0);

  const first = store.recordMessage(message(T0 + 1_000))!;
  assert.equal(first.tickAwarded, true);
  assert.equal(first.user.xp, 15, '10 XP, plus 1 for each of the five tiles the guild holds');

  for (const offset of [2_000, 1 * MIN, 5 * MIN - 1]) {
    const again = store.recordMessage(message(T0 + offset))!;
    assert.equal(again.tickAwarded, false, 'spam in the same window earns nothing');
    assert.equal(again.user.xp, 15);
  }

  const next = store.recordMessage(message(T0 + 5 * MIN))!;
  assert.equal(next.tickAwarded, true);
  assert.equal(next.user.xp, 30);
  assert.equal(store.tickCount('42', session.session_id), 2);

  // Two ticks: two development points on red's land, none on anyone else's.
  assert.equal(redTiles(store).reduce((sum, t) => sum + t.points, 0), 2);
  assert.ok(
    store
      .tiles()
      .filter((t) => t.owner_guild_id !== 'red' && t.tile_id !== config.land.center.id)
      .every((t) => t.points === 0 && t.level === 0),
  );
  // Two windows: the Monument grew twice by the base income, as the land has no level yet.
  assert.deepEqual(store.monuments(), { red: 2 * config.monument.baseIncome, green: 0, blue: 0 });
  store.close();
});

test('the Monument grows once per window, however many members chat, by what the land yields', () => {
  const store = openStore();
  store.startSession(T0);
  for (const tile of redTiles(store)) store.setTileLevel(tile.tile_id, 3);
  store.recordMessage(message(T0));
  store.recordMessage(message(T0 + 1, { userId: '43', login: 'bob', displayName: 'Bob' }));
  store.recordMessage(message(T0 + 2, { userId: '44', login: 'cy', displayName: 'Cy' }));
  // The balancing of tiny channels spreads the three over the guilds; only red has developed land.
  assert.equal(store.monuments().red, 1 + 5 * 3);
  assert.equal(store.monuments().green, 1);
  store.recordMessage(message(T0 + 5 * MIN));
  assert.equal(store.monuments().red, 2 * (1 + 5 * 3));
  store.close();
});

test('a chatter builds their home tile, as fast as its fertility allows', () => {
  const { mishaps } = config;
  const saved = structuredClone(mishaps);
  // No lightning, fire or harvest here: only the chatter's own work.
  mishaps.lightning.chance = mishaps.fire.chance = mishaps.harvest.chance = 0;
  try {
    const store = openStore();
    store.startSession(T0);
    for (let window = 0; window < 12; window++) store.recordMessage(message(T0 + window * 5 * MIN));
    const grown = redTiles(store).filter((t) => t.level > 0 || t.points > 0);
    assert.equal(grown.length, 1, 'one chatter, one home tile');
    const home = grown[0]!;
    const own = redTiles(store).map((t) => ({ id: t.tile_id, level: 0, points: 0 }));
    assert.equal(home.tile_id, homeTile(message(T0).userId, own)!.id);
    // Twelve ticks at the tile's fertility: between its whole part and one more per tick.
    const total = home.level * levelCost(1, store.channelScale()) + home.points;
    const rate = fertility(store.currentSeasonId(T0), home.tile_id);
    assert.ok(total >= 12 * Math.floor(rate) && total <= 12 * Math.ceil(rate), `${total} points at ${rate.toFixed(2)}`);
    store.close();
  } finally {
    Object.assign(mishaps.lightning, saved.lightning);
    Object.assign(mishaps.fire, saved.fire);
    Object.assign(mishaps.harvest, saved.harvest);
  }
});

test('a guild without land puts its ticks straight into the Monument', () => {
  const store = openStore();
  store.startSession(T0);
  for (const tile of redTiles(store)) store.setTileOwner(tile.tile_id, 'blue');
  const result = store.recordMessage(message(T0))!;
  assert.equal(result.user.xp, 10, 'no tile bonus');
  assert.equal(store.monuments().red, 1 + config.monument.baseIncome, 'the tick itself, and the window');
  store.close();
});

test('levels rise with XP', () => {
  const store = openStore();
  store.startSession(T0);
  let user = store.recordMessage(message(T0))!.user;
  for (let window = 1; window < 4; window++) {
    assert.equal(user.level, 0);
    user = store.recordMessage(message(T0 + window * 5 * MIN))!.user;
  }
  assert.equal(user.xp, 60);
  assert.equal(user.level, 1);
  store.close();
});

test('the broadcaster and bots earn nothing', () => {
  const store = openStore();
  store.startSession(T0);
  assert.equal(store.recordMessage(message(T0, { isBroadcaster: true })), null);
  assert.equal(store.recordMessage(message(T0, { userId: '7', login: 'nightbot' })), null);
  assert.ok(store.tiles().every((t) => t.points === 0));
  assert.deepEqual(Object.values(store.monuments()), [0, 0, 0]);
  store.close();
});

test('sessions: ticks stop when the layer is turned off and are counted per session', () => {
  const store = openStore();
  const first = store.startSession(T0);
  assert.equal(store.startSession(T0 + 1).session_id, first.session_id, 'starting twice is harmless');
  store.recordMessage(message(T0));
  store.recordMessage(message(T0 + 5 * MIN));
  store.endSession(T0 + 10 * MIN);
  assert.equal(store.activeSession(), null);
  assert.equal(store.recordMessage(message(T0 + 15 * MIN))!.tickAwarded, false);

  const second = store.startSession(T0 + 60 * MIN);
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(store.recordMessage(message(T0 + 59 * MIN))!.tickAwarded, false, 'sent before the session');
  assert.equal(store.recordMessage(message(T0 + 61 * MIN))!.tickAwarded, true);

  assert.equal(store.tickCount('42', first.session_id), 2);
  assert.equal(store.tickCount('42', second.session_id), 1);
  store.close();
});

test('finds recently active chatters and ranks the most active', () => {
  const store = openStore();
  const session = store.startSession(T0);
  const bob = { userId: '43', login: 'bob', displayName: 'Bob', color: '#0000FF' };
  for (let window = 0; window < 4; window++) store.recordMessage(message(T0 + window * 5 * MIN));
  store.recordMessage(message(T0, bob));

  assert.deepEqual(store.recentlyActive(T0).map((u) => u.user_id), ['42', '43']);
  assert.deepEqual(store.recentlyActive(T0 + 5 * MIN).map((u) => u.user_id), ['42']);

  const top = store.topTickers(session.session_id, 5);
  assert.deepEqual(top.map((u) => [u.user_id, u.ticks]), [['42', 4], ['43', 1]]);
  store.close();
});

test('measures the channel size, and development costs scale with it', () => {
  const store = Store.open(':memory:');
  assert.equal(store.channelScale(), 1, 'no measurement yet');
  store.startSession(T0);

  // Six chatters write in each of three windows.
  for (let window = 0; window < 3; window++) {
    for (let id = 0; id < 6; id++) {
      store.recordMessage(
        message(T0 + window * 5 * MIN + id, { userId: String(500 + id), login: `user${id}` }),
      );
    }
  }
  // The running window is not measured; the two completed ones are.
  assert.equal(store.measuredChatters(), 6);
  assert.equal(store.channelScale(), 6 / config.scaling.referenceChatters);
  // In a small channel a level is cheap: six ticks per guild-window already raised tiles.
  assert.ok(store.development('red') + store.development('green') + store.development('blue') > 0);

  store.setManualChatters(2 * config.scaling.referenceChatters);
  assert.equal(store.channelScale(), 2, 'a manual size wins over the measurement');
  store.setManualChatters(null);
  assert.equal(store.channelScale(), 6 / config.scaling.referenceChatters);
  store.close();
});

test('the measurement freezes after the warm-up and is refreshed when a session starts', () => {
  const store = Store.open(':memory:');
  store.startSession(T0);
  const windows = config.scaling.warmupWindows + 4;
  for (let window = 0; window < windows; window++) {
    // One chatter during the warm-up, three afterwards.
    const chatters = window <= config.scaling.warmupWindows ? 1 : 3;
    for (let id = 0; id < chatters; id++) {
      store.recordMessage(
        message(T0 + window * 5 * MIN + id, { userId: String(500 + id), login: `user${id}` }),
      );
    }
  }
  assert.equal(store.measuredChatters(), 1, 'frozen after the warm-up');

  store.endSession(T0 + windows * 5 * MIN);
  store.startSession(T0 + 24 * 60 * MIN);
  assert.ok(store.measuredChatters()! > 1, 're-measured for the next session');
  store.close();
});

test('activity counts only the activity window, whatever else the ticks table holds', () => {
  const store = Store.open(':memory:');
  const now = 1_800_000_000_000;
  store.startSession(now - 3_600_000);
  const chat = (id: string, sentAt: number) =>
    store.recordMessage({
      type: 'chat', channel: 'c', userId: id, login: `u${id}`, displayName: `U${id}`, color: '#FF0000',
      badges: [], isBroadcaster: false, isModerator: false, text: 'hi', emoteIds: [], sentAt,
    });
  chat('1', now - 60_000);
  // A tick dated far ahead, as a simulator that ran fast leaves behind, is not "active now".
  chat('2', now + 30 * 86_400_000);
  const since = now - config.server.activeWindowMs;
  assert.equal(store.activeByGuild(since, now).red, 1);
  assert.deepEqual(store.recentlyActive(since, now).map((u) => u.user_id), ['1']);
  // The simulator carries on from the latest activity instead of going back in time.
  assert.ok(store.latestActivity()! > now + 29 * 86_400_000);
  store.close();
});
