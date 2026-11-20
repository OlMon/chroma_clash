import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { Battle } from '../../src/game/battle.ts';
import { WarEngine, type WarStep } from '../../src/server/war-engine.ts';

const T0 = 1_700_000_100_000;
const COLORS: Record<GuildId, string> = { red: '#FF0000', green: '#00FF00', blue: '#0000FF' };

/** A store with a running session and `perGuild` active chatters in each named guild. */
function setupStore(perGuild: Partial<Record<GuildId, number>>): Store {
  const store = Store.open(':memory:');
  store.setManualChatters(config.scaling.referenceChatters * 100);
  store.startSession(T0);
  let id = 1000;
  // Fill past the small-channel balancing first, so colors decide the guild.
  const order: GuildId[] = [];
  for (const guild of Object.keys(perGuild) as GuildId[]) {
    for (let i = 0; i < perGuild[guild]!; i++) order.push(guild);
  }
  for (const guild of order) {
    id++;
    store.recordMessage({
      type: 'chat',
      channel: 'test',
      userId: String(id),
      login: `u${id}`,
      displayName: `U${id}`,
      color: COLORS[guild],
      badges: [],
      isBroadcaster: false,
      isModerator: false,
      text: 'hi',
      emoteIds: [],
      sentAt: T0 + id,
    });
  }
  return store;
}

/** Makes every tile but the cities neutral: the map as it would be with no land dealt. */
function clearLand(store: Store): void {
  for (const tile of store.tiles()) if (!tile.is_city) store.setTileOwner(tile.tile_id, null);
}

function runWar(store: Store, seed: number): { engine: WarEngine; steps: WarStep[] } {
  const engine = new WarEngine(store, () => T0 + 60_000, seed);
  const steps: WarStep[] = [];
  for (let step = engine.next(); step; step = engine.next()) {
    steps.push(step);
    if (step.kind !== 'skipped') engine.apply(step, new Battle(step.setup!).run());
  }
  engine.finish();
  return { engine, steps };
}

test('a War has one battle per guild; with the land dealt, each is an attack on a neighbor', () => {
  const store = setupStore({ red: 20, green: 20, blue: 20 });
  const { engine, steps } = runWar(store, 7);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.attacker).sort(), ['blue', 'green', 'red']);
  assert.deepEqual(steps.map((s) => s.position), [1, 2, 3]);

  const rows = store.battles(engine.warId);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.kind, 'attack', 'every guild borders the others from the first minute');
    assert.ok(row.defender_guild_id && row.defender_guild_id !== row.attacker_guild_id);
    assert.ok(row.duration_ms !== null);
  }
  assert.equal(engine.outcomes.length, 3);
  assert.ok(engine.summary().length > 0);
  store.close();
});

test('an attack on developed land names the stake: the level, what a taken tile keeps, the defender\'s bonus', () => {
  const store = setupStore({ red: 20, green: 20, blue: 20 });
  // Every guild's land at level 8, so whatever is attacked is a level-8 tile.
  for (const tile of store.tiles()) if (!tile.is_city && tile.tile_id !== '0,0') store.setTileLevel(tile.tile_id, 8);
  const engine = new WarEngine(store, () => T0 + 60_000, 3);
  const step = engine.next()!;
  assert.equal(step.kind, 'attack');
  assert.match(step.meta!.title, /^\w+ attacks \w+'s level 8$/);
  assert.match(step.subtitle, /^At stake: a level-8 tile, which keeps level 4 if taken · \w+ defends with \+24% health$/);
  store.close();
});

test('on neutral land a guild raids: a won raid takes the tile, a lost one changes nothing', () => {
  const store = setupStore({ red: 20, green: 20, blue: 20 });
  clearLand(store);
  const { engine } = runWar(store, 7);
  for (const outcome of engine.outcomes) {
    assert.equal(outcome.kind, 'skirmish');
    assert.equal(outcome.captured, outcome.winner === outcome.attacker);
  }
  const taken = engine.outcomes.filter((o) => o.captured).length;
  const owned = (['red', 'green', 'blue'] as const).reduce((sum, g) => sum + store.ownedTiles(g), 0);
  assert.equal(owned, taken);
  store.close();
});

test('an attack: the winner decides who owns the tile, and captured land loses half its development', () => {
  let captures = 0;
  let holds = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const store = setupStore({ red: 20, green: 20, blue: 20 });
    for (const tile of store.tiles()) store.setTileLevel(tile.tile_id, 6);
    const engine = new WarEngine(store, () => T0 + 60_000, seed);
    for (let step = engine.next(); step; step = engine.next()) {
      assert.equal(step.kind, 'attack');
      const tileOf = () => store.tiles().find((t) => t.tile_id === step.tileId)!;
      assert.equal(tileOf().owner_guild_id, step.defender);
      const level = tileOf().level;
      // Before the battle the overlay's map marks the attacked tile and the attacker.
      assert.deepEqual(step.map, { targets: [{ tile: step.tileId, by: step.attacker }] });
      const outcome = engine.apply(step, new Battle(step.setup!).run());
      if (outcome.captured) {
        captures++;
        assert.equal(tileOf().owner_guild_id, step.attacker);
        assert.equal(tileOf().level, Math.floor(level / 2), 'conquest costs development');
        assert.deepEqual(outcome.display!.map, {
          changes: [{ tile: step.tileId, from: step.defender, to: step.attacker, scorched: false }],
        });
      } else {
        holds++;
        assert.equal(tileOf().owner_guild_id, step.defender);
        assert.equal(tileOf().level, level, 'defended land keeps its development');
        assert.deepEqual(outcome.display!.map, { held: [step.tileId] });
      }
    }
    engine.finish();
    store.close();
  }
  assert.ok(captures > 0 && holds > 0, `captures ${captures}, holds ${holds}`);
});

test('the defender is tougher on developed land; nobody has a damage bonus', () => {
  const store = setupStore({ red: 5, green: 5, blue: 5 });
  for (const tile of store.tiles()) store.setTileLevel(tile.tile_id, 5);
  const engine = new WarEngine(store, () => T0 + 60_000, 3);
  let checked = 0;
  for (let step = engine.next(); step; step = engine.next()) {
    if (step.kind !== 'attack') continue;
    const attacker = step.setup!.sides.find((s) => s.id === step.attacker)!;
    const defender = step.setup!.sides.find((s) => s.id === step.defender)!;
    // Land captured earlier in this War has lost half its level; the bonus follows the tile as it is now.
    const level = store.tiles().find((t) => t.tile_id === step.tileId)!.level;
    assert.ok(level === 5 || level === 2);
    assert.equal(attacker.healthBonus, 0);
    assert.ok(Math.abs(defender.healthBonus - level * config.land.defensePerLevel) < 1e-9, `level ${level} land`);
    assert.equal(attacker.damageBonus, 0);
    assert.equal(defender.damageBonus, 0);
    engine.apply(step, new Battle(step.setup!).run());
    checked++;
  }
  assert.ok(checked >= 1);
  store.close();
});

test('statistics and XP: kills match deaths, everyone active is rewarded', () => {
  const store = setupStore({ red: 10, green: 10, blue: 10 });
  const before = new Map(store.recentlyActive(0).map((u) => [u.user_id, u.xp]));
  const { engine } = runWar(store, 11);
  const users = store.recentlyActive(0);
  assert.equal(users.length, 30);

  const kills = users.reduce((sum, u) => sum + u.kills, 0);
  const deaths = users.reduce((sum, u) => sum + u.deaths, 0);
  assert.equal(kills, deaths);
  assert.ok(kills > 0);
  assert.ok(users.every((u) => u.battles >= 1));

  const wins: Record<GuildId, number> = { red: 0, green: 0, blue: 0 };
  for (const outcome of engine.outcomes) if (outcome.winner) wins[outcome.winner]++;
  for (const user of users) {
    const expected = config.war.participationXp + config.war.winXp * wins[user.guild_id];
    assert.equal(user.xp - before.get(user.user_id)!, expected);
  }
  assert.deepEqual(engine.finish(), { rewarded: 0 }, 'finishing twice rewards nobody again');
  store.close();
});

test('the same seed gives the same War', () => {
  const a = runWar(setupStore({ red: 12, green: 12, blue: 12 }), 21).engine.outcomes;
  const b = runWar(setupStore({ red: 12, green: 12, blue: 12 }), 21).engine.outcomes;
  assert.deepEqual(a, b);
});
