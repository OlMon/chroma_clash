import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { hexDistance, hexNeighbors, tileId } from '../../src/game/hex.ts';
import {
  addDevelopmentPoint,
  dealtTiles,
  defenseBonus,
  developTarget,
  fertility,
  homeTile,
  levelAfterCapture,
  levelCost,
  monumentIncome,
  rollMishaps,
  startingLand,
  tickPoints,
} from '../../src/game/land.ts';
import { createRng } from '../../src/util/rng.ts';

const GUILDS = ['red', 'green', 'blue'] as const;

test('equal start: every guild gets five tiles in the same position, and the center stays neutral', () => {
  const land = startingLand('equal', createRng(1));
  assert.equal(Object.keys(land).length, 15);
  assert.deepEqual(Object.keys(land).sort(), dealtTiles().sort(), 'every tile but the cities and the center');
  assert.equal(land['0,0'], undefined);

  const shape = (guild: (typeof GUILDS)[number]) => {
    const city = config.map.cities[guild];
    const own = Object.keys(land)
      .filter((id) => land[id] === guild)
      .map((id) => ({ q: Number(id.split(',')[0]), r: Number(id.split(',')[1]) }));
    return {
      count: own.length,
      // Distances to the own city and to the center describe the position without its direction.
      toCity: own.map((hex) => hexDistance(hex, city)).sort(),
      toCenter: own.map((hex) => hexDistance(hex, { q: 0, r: 0 })).sort(),
      touchesCity: own.filter((hex) => hexDistance(hex, city) === 1).length,
      own,
    };
  };
  const [red, green, blue] = GUILDS.map(shape) as [ReturnType<typeof shape>, ReturnType<typeof shape>, ReturnType<typeof shape>];
  for (const sector of [red, green, blue]) {
    assert.equal(sector.count, 5);
    assert.deepEqual(sector.toCity, red.toCity);
    assert.deepEqual(sector.toCenter, red.toCenter);
    assert.equal(sector.touchesCity, 3, 'the three tiles around the city are its own');
  }

  // Every guild borders both others from the start, so a War can begin at once.
  for (const guild of GUILDS) {
    const neighbors = new Set<string>();
    for (const hex of shape(guild).own) {
      for (const next of hexNeighbors(hex)) {
        const owner = land[tileId(next)];
        if (owner && owner !== guild) neighbors.add(owner);
      }
    }
    assert.equal(neighbors.size, 2, `${guild} touches both other guilds`);
  }
});

test('random start: the same fifteen tiles, five to each guild, by the seed', () => {
  const a = startingLand('random', createRng(7));
  assert.deepEqual(Object.keys(a).sort(), dealtTiles().sort());
  for (const guild of GUILDS) assert.equal(Object.values(a).filter((owner) => owner === guild).length, 5);
  assert.deepEqual(startingLand('random', createRng(7)), a);
  assert.notDeepEqual(startingLand('random', createRng(8)), a);
  assert.notDeepEqual(a, startingLand('equal', createRng(7)), 'not the tidy sectors');
});

test('developing a tile costs 12 points per level, and leftover points carry over', () => {
  assert.equal(levelCost(1), 12);
  assert.equal(levelCost(5), 60);
  assert.equal(levelCost(1, 10), 120, 'a ten times larger channel pays ten times as much');
  assert.equal(levelCost(1, 0.001), 1, 'never below one point');

  let tile = { level: 0, points: 0 };
  for (let i = 0; i < 11; i++) tile = addDevelopmentPoint(tile);
  assert.deepEqual(tile, { level: 0, points: 11 });
  tile = addDevelopmentPoint(tile);
  assert.deepEqual(tile, { level: 1, points: 0 });
  for (let i = 0; i < 30; i++) tile = addDevelopmentPoint(tile);
  assert.deepEqual(tile, { level: 2, points: 6 });

  const full = { level: config.land.maxLevel, points: 0 };
  assert.deepEqual(addDevelopmentPoint(full), full, 'a fully developed tile takes no more');
});

test('a guild develops its least developed tile first, so its land grows evenly', () => {
  const tiles = [
    { id: 'b', level: 2, points: 0 },
    { id: 'a', level: 1, points: 3 },
    { id: 'c', level: 1, points: 9 },
    { id: 'd', level: 1, points: 9 },
  ];
  assert.equal(developTarget(tiles)!.id, 'c', 'lowest level, then nearest its next level, then the lowest id');
  assert.equal(developTarget([{ id: 'x', level: config.land.maxLevel, points: 0 }]), null);
  assert.equal(developTarget([]), null);
});

test('the Monument grows by every tile held, its level on top, plus a little for a guild with nothing', () => {
  assert.equal(monumentIncome([]), 1);
  // Land at level 0 still yields: five empty tiles are worth more than one at level 1.
  assert.equal(monumentIncome([0, 0, 0]), 4);
  assert.ok(monumentIncome([0, 0, 0, 0, 0]) > monumentIncome([1]));
  assert.equal(monumentIncome([3, 4, 5]), 16);
});

test('developed land defends better, and loses half its level when taken', () => {
  assert.equal(defenseBonus(0), 0);
  assert.ok(Math.abs(defenseBonus(10) - 0.3) < 1e-9);
  assert.equal(levelAfterCapture(6), 3);
  assert.equal(levelAfterCapture(5), 2);
  assert.equal(levelAfterCapture(0), 0);
});

// --- Uneven growth and mishaps -------------------------------------------------

/** A run of rolls in a fixed order, then the fallback. */
function rolls(values: number[], fallback = 0.99): () => number {
  let index = 0;
  return () => (index < values.length ? values[index++]! : fallback);
}

function mishapTile(id: string, level: number, owner: 'red' | 'green' | 'blue' | null = 'red', burning = 0) {
  const [q, r] = id.split(',').map(Number) as [number, number];
  return { id, q, r, owner, level, burning, developable: true };
}

test('a home tile stays the home tile while the guild keeps it', () => {
  const tiles = ['1,-2', '1,-1', '2,-1', '1,0', '2,0'].map((id) => ({ id, level: 0, points: 0 }));
  const homes = new Map<string, string>();
  for (let user = 0; user < 40; user++) homes.set(`u${user}`, homeTile(`u${user}`, tiles)!.id);
  assert.ok(new Set(homes.values()).size >= 4, 'chatters live all over the land');
  // Losing one tile moves only the chatters who lived there.
  const fewer = tiles.filter((t) => t.id !== '1,-1');
  for (const [user, home] of homes) {
    if (home !== '1,-1') assert.equal(homeTile(user, fewer)!.id, home);
  }
  // A finished tile takes no more work: its chatters build elsewhere.
  const full = tiles.map((t) => (t.id === homes.get('u0') ? { ...t, level: config.land.maxLevel } : t));
  assert.notEqual(homeTile('u0', full)!.id, homes.get('u0'));
});

test('fertility differs from tile to tile and season to season, within its limits', () => {
  const { min, max } = config.land.fertility;
  const values = ['1,-2', '1,-1', '2,-1', '1,0', '2,0'].flatMap((id) => [1, 2, 3].map((season) => fertility(season, id)));
  for (const value of values) assert.ok(value >= min && value <= max);
  assert.ok(Math.max(...values) - Math.min(...values) > 0.4);
  assert.equal(tickPoints(1.4, 0.3), 2);
  assert.equal(tickPoints(1.4, 0.5), 1);
  assert.equal(tickPoints(0.6, 0.7), 0);
});

test('a fire burns a level each window until enough of the guild is there to put it out', () => {
  const tiles = [mishapTile('1,-1', 6, 'red', 1)];
  // Nobody around: it burns on (no spread, no new mishaps).
  let result = rollMishaps(tiles, {}, rolls([0.99]));
  assert.deepEqual(result.changed.get('1,-1'), { level: 5, burning: 2 });
  assert.equal(result.events[0]!.kind, 'burn');
  // Enough members were active: they douse it, and it keeps its level.
  result = rollMishaps(tiles, { red: config.mishaps.fire.douse }, rolls([]));
  assert.deepEqual(result.changed.get('1,-1'), { level: 6, burning: 0 });
  assert.equal(result.events[0]!.kind, 'doused');
  // In its last window it burns out by itself.
  result = rollMishaps([mishapTile('1,-1', 6, 'red', config.mishaps.fire.maxWindows - 1)], {}, rolls([]));
  assert.deepEqual(result.changed.get('1,-1'), { level: 5, burning: 0 });
  assert.equal(result.events[0]!.kind, 'burntOut');
});

test('a fire can spread to a neighbour, whoever owns it', () => {
  const tiles = [mishapTile('1,-1', 6, 'red', 1), mishapTile('1,0', 4, 'green')];
  const { changed, events } = rollMishaps(tiles, {}, rolls([0, 0]));
  assert.deepEqual(changed.get('1,0'), { level: 3, burning: 1 });
  assert.deepEqual(events.map((e) => e.kind).slice(0, 2), ['burn', 'spread']);
});

test('lightning seeks the tallest tiles, and mishaps leave cities and the center alone', () => {
  const tiles = [mishapTile('1,-1', 1), mishapTile('1,0', 9), { ...mishapTile('0,0', 9), developable: false }];
  const rng = createRng(7);
  const struck: Record<string, number> = {};
  for (let i = 0; i < 300; i++) {
    for (const event of rollMishaps(tiles, {}, rng).events) {
      assert.notEqual(event.tile, '0,0');
      if (event.kind === 'lightning') struck[event.tile] = (struck[event.tile] ?? 0) + 1;
    }
  }
  assert.ok((struck['1,0'] ?? 0) > 10 * (struck['1,-1'] ?? 0), JSON.stringify(struck));
});
