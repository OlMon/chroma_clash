import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import {
  claimTarget,
  type MapTile,
} from '../../src/game/expansion.ts';
import { hexDistance, hexNeighbors, isOnMap, mapTiles, tileId } from '../../src/game/hex.ts';

/** A fresh map: cities owned, everything else neutral, plus the given owners. */
function makeMap(owners: Record<string, GuildId> = {}): MapTile[] {
  return mapTiles().map((hex) => {
    const id = tileId(hex);
    const city = (Object.keys(config.map.cities) as GuildId[]).find(
      (g) => config.map.cities[g].q === hex.q && config.map.cities[g].r === hex.r,
    );
    return { id, q: hex.q, r: hex.r, owner: city ?? owners[id] ?? null, isCity: city !== undefined };
  });
}

test('hex math: distance is symmetric and neighbors are one step away', () => {
  const tiles = mapTiles();
  for (const a of tiles) {
    assert.equal(hexDistance(a, a), 0);
    for (const n of hexNeighbors(a)) {
      assert.equal(hexDistance(a, n), 1);
      assert.ok(isOnMap(n));
    }
    for (const b of tiles) assert.equal(hexDistance(a, b), hexDistance(b, a));
  }
  assert.equal(hexDistance({ q: -2, r: 2 }, { q: 2, r: -2 }), 4);
  assert.equal(isOnMap({ q: 2, r: 1 }), false);
  // Edge tiles have four neighbors, corners three, inner tiles six.
  const counts = tiles.map((t) => hexNeighbors(t).length).sort();
  assert.deepEqual(counts, [...Array(6).fill(3), ...Array(6).fill(4), ...Array(7).fill(6)]);
});

test('every city is in the same position: same distances to the center and each other', () => {
  const cities = Object.values(config.map.cities);
  for (const city of cities) {
    assert.equal(hexDistance(city, { q: 0, r: 0 }), 2);
    assert.equal(hexNeighbors(city).length, 3);
    for (const other of cities) {
      if (other !== city) assert.equal(hexDistance(city, other), 4);
    }
  }
});

test('on an empty map the raid target is the tile next to the city that is nearest the center', () => {
  const map = makeMap();
  assert.equal(claimTarget(map, 'red')?.id, '1,-1');
  assert.equal(claimTarget(map, 'green')?.id, '0,1');
  assert.equal(claimTarget(map, 'blue')?.id, '-1,0');
});

test('tiles nearer the city come first; ties go to the center, then the lowest id', () => {
  let map = makeMap({ '1,-1': 'red' });
  assert.equal(claimTarget(map, 'red')?.id, '1,-2', 'distance 1 beats the center tile at distance 2');
  map = makeMap({ '1,-1': 'red', '1,-2': 'red' });
  assert.equal(claimTarget(map, 'red')?.id, '2,-1');
  map = makeMap({ '1,-1': 'red', '1,-2': 'red', '2,-1': 'red' });
  assert.equal(claimTarget(map, 'red')?.id, '0,0', 'of the tiles at distance 2, the center');
});

test('only neutral tiles touching the own territory can be targeted', () => {
  const map = makeMap({ '1,-1': 'blue', '1,-2': 'blue', '2,-1': 'green' });
  assert.equal(claimTarget(map, 'red'), null, 'red is walled in');
  const target = claimTarget(map, 'blue');
  assert.ok(target);
  assert.equal(target.owner, null);
});

