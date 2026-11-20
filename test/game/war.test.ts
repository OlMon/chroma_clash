import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import type { MapTile } from '../../src/game/expansion.ts';
import { mapTiles, tileId } from '../../src/game/hex.ts';
import { battleOrder, chooseTarget, tileCounts } from '../../src/game/war.ts';
import { createRng } from '../../src/util/rng.ts';

function makeMap(owners: Record<string, GuildId> = {}): MapTile[] {
  return mapTiles().map((hex) => {
    const id = tileId(hex);
    const city = (Object.keys(config.map.cities) as GuildId[]).find(
      (g) => config.map.cities[g].q === hex.q && config.map.cities[g].r === hex.r,
    );
    return { id, q: hex.q, r: hex.r, owner: city ?? owners[id] ?? null, isCity: city !== undefined };
  });
}

test('counts tiles without the cities', () => {
  assert.deepEqual(tileCounts(makeMap()), { red: 0, green: 0, blue: 0 });
  assert.deepEqual(tileCounts(makeMap({ '1,-1': 'red', '0,0': 'red', '0,1': 'green' })), {
    red: 2,
    green: 1,
    blue: 0,
  });
});

test('the guild with the fewest tiles attacks first; ties follow the seed', () => {
  const map = makeMap({ '1,-1': 'red', '0,0': 'red', '0,1': 'green' });
  for (let seed = 1; seed <= 20; seed++) {
    assert.deepEqual(battleOrder(map, createRng(seed)), ['blue', 'green', 'red']);
  }
  const orders = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) orders.add(battleOrder(makeMap(), createRng(seed)).join());
  assert.ok(orders.size > 1, 'equal guilds are ordered by the seed');
  assert.deepEqual(battleOrder(makeMap(), createRng(5)), battleOrder(makeMap(), createRng(5)));
});

test('early in a season a guild raids the neutral tile it would claim next', () => {
  const target = chooseTarget(makeMap(), 'red', createRng(1));
  assert.deepEqual(target && { kind: target.kind, tile: target.tile.id }, { kind: 'skirmish', tile: '1,-1' });
});

test('a guild attacks an enemy tile it touches, never a city', () => {
  // Red owns the center and touches green's tile at 0,1.
  const map = makeMap({ '1,-1': 'red', '0,0': 'red', '0,1': 'green' });
  for (let seed = 1; seed <= 20; seed++) {
    const target = chooseTarget(map, 'red', createRng(seed));
    assert.ok(target && target.kind === 'attack');
    assert.equal(target.defender, 'green');
    assert.equal(target.tile.id, '0,1');
  }
  // Green's city touches 0,1 only through its own tile; from blue's side nothing is in reach but neutral land.
  assert.equal(chooseTarget(map, 'blue', createRng(1))?.kind, 'skirmish');
});

test('with two neighbors the one owning more tiles is attacked', () => {
  // Red sits in the middle and touches both; green owns two tiles, blue one.
  const map = makeMap({ '0,0': 'red', '1,-1': 'red', '0,1': 'green', '1,0': 'green', '-1,0': 'blue' });
  for (let seed = 1; seed <= 20; seed++) {
    const target = chooseTarget(map, 'red', createRng(seed));
    assert.ok(target && target.kind === 'attack');
    assert.equal(target.defender, 'green');
    assert.ok(['0,1', '1,0'].includes(target.tile.id));
  }
  const tiles = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) tiles.add(chooseTarget(map, 'red', createRng(seed))!.tile.id);
  assert.equal(tiles.size, 2, 'either touched tile can be picked');
});

test('a guild that is walled in by cities and own land has no target', () => {
  // Every non-city tile belongs to red: blue touches only red tiles (attackable), red touches only cities.
  const owners: Record<string, GuildId> = {};
  for (const tile of makeMap()) if (!tile.isCity) owners[tile.id] = 'red';
  const map = makeMap(owners);
  assert.equal(chooseTarget(map, 'red', createRng(1)), null);
  assert.equal(chooseTarget(map, 'blue', createRng(1))?.kind, 'attack');
});

test('a guild goes for the most developed tile it touches; equal levels are drawn by lot', () => {
  const map = makeMap({ '0,0': 'red', '1,-1': 'red', '0,1': 'green', '1,0': 'green', '-1,1': 'green' });
  const level = (id: string, value: number) => (map.find((tile) => tile.id === id)!.level = value);
  level('0,1', 2);
  level('1,0', 8);
  for (let seed = 1; seed <= 20; seed++) {
    const target = chooseTarget(map, 'red', createRng(seed));
    assert.equal(target?.kind === 'attack' && target.tile.id, '1,0', 'the level-8 tile is the prize');
  }
  level('0,1', 8);
  const picked = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) picked.add(chooseTarget(map, 'red', createRng(seed))!.tile.id);
  assert.deepEqual([...picked].sort(), ['0,1', '1,0'], 'two level-8 tiles: either');
});
