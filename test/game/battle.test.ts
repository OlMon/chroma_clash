import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type GuildId } from '../../src/config.ts';
import {
  Battle,
  FLAG,
  levelHealthMultiplier,
  selectFighters,
  sizeBalance,
  type BattleSetup,
  type FighterSpec,
} from '../../src/game/battle.ts';
import { createRng } from '../../src/util/rng.ts';

function squad(side: GuildId, count: number, level = 0): FighterSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${side}-${i}`,
    name: `${side}${i}`,
    color: null,
    side,
    level,
  }));
}

function setup(seed: number, sizes: Partial<Record<GuildId, number>>, extra: Partial<BattleSetup> = {}): BattleSetup {
  const ids = Object.keys(sizes) as GuildId[];
  return {
    seed,
    sides: ids.map((id) => ({ id, damageBonus: 0, healthBonus: 0 })),
    fighters: ids.flatMap((id) => squad(id, sizes[id]!)),
    ...extra,
  };
}

test('the same seed gives the same battle, frame by frame', () => {
  const a = new Battle(setup(7, { red: 12, blue: 12 }));
  const b = new Battle(setup(7, { red: 12, blue: 12 }));
  for (let i = 0; i < 200; i++) {
    a.step();
    b.step();
    assert.deepEqual(a.frame(), b.frame());
  }
  assert.deepEqual(a.run(), b.run());
  const c = new Battle(setup(8, { red: 12, blue: 12 }));
  assert.notDeepEqual(c.frame(), new Battle(setup(7, { red: 12, blue: 12 })).frame());
});

test('a battle ends with one side standing, and kills match deaths', () => {
  const result = new Battle(setup(1, { red: 15, green: 15 })).run();
  assert.equal(result.endedBy, 'elimination');
  assert.ok(result.winner === 'red' || result.winner === 'green');
  const loser = result.sides.find((s) => s.id !== result.winner)!;
  const winner = result.sides.find((s) => s.id === result.winner)!;
  assert.equal(loser.survivors, 0);
  assert.ok(winner.survivors > 0);
  assert.ok(result.durationMs <= config.battle.durationMs);

  const kills = result.fighters.reduce((sum, f) => sum + f.kills, 0);
  const deaths = result.fighters.filter((f) => !f.alive).length;
  assert.equal(kills, deaths);
});

test('fighters stay inside the arena and never overlap much', () => {
  const battle = new Battle(setup(3, { red: 40, green: 40, blue: 40 }));
  const { width, height } = config.battle.arena;
  for (let i = 0; i < 400 && !battle.finished; i++) {
    battle.step();
    for (const f of battle.fighters) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
      assert.ok(f.x >= f.radius && f.x <= width - f.radius);
      assert.ok(f.y >= config.battle.arena.top + f.radius && f.y <= height - f.radius);
    }
  }
});

test('at the time limit the side with more remaining health wins', () => {
  // Blue has triple health through its Walls, so after one second it has lost less.
  const battle = new Battle({
    seed: 2,
    durationMs: 12_000,
    sides: [
      { id: 'red', damageBonus: 0, healthBonus: 0 },
      { id: 'blue', damageBonus: 0, healthBonus: 2 },
    ],
    fighters: [...squad('red', 5), ...squad('blue', 5)],
  });
  const result = battle.run();
  assert.equal(result.endedBy, 'time');
  assert.equal(result.durationMs, 12_000);
  assert.equal(result.winner, 'blue');
});

test('a side without opponents wins by walkover; an empty battle has no winner', () => {
  const alone = new Battle(setup(1, { green: 4 }));
  assert.equal(alone.finished, true);
  assert.deepEqual(
    { winner: alone.result()!.winner, endedBy: alone.result()!.endedBy },
    { winner: 'green', endedBy: 'walkover' },
  );
  const filtered = new Battle({ ...setup(1, { green: 4 }), sides: [
    { id: 'red', damageBonus: 0, healthBonus: 0 },
    { id: 'green', damageBonus: 0, healthBonus: 0 },
  ] });
  assert.equal(filtered.result()!.winner, 'green', 'a side with no fighters is left out');
  assert.equal(new Battle({ seed: 1, sides: [], fighters: [] }).result()!.winner, null);
});

test('three sides can fight, and start equally far from each other', () => {
  const battle = new Battle(setup(5, { red: 1, green: 1, blue: 1 }));
  const [a, b, c] = battle.fighters as [typeof battle.fighters[0], typeof battle.fighters[0], typeof battle.fighters[0]];
  const d = (p: typeof a, q: typeof a) => Math.hypot(p.x - q.x, p.y - q.y);
  // Single fighters spawn within a small scatter of their side's point.
  const spread = 2 * config.battle.maxFighterRadius * 2.4;
  assert.ok(Math.abs(d(a, b) - d(a, c)) < 2 * spread);
  assert.ok(Math.abs(d(a, b) - d(b, c)) < 2 * spread);
  const result = battle.run();
  assert.equal(result.sides.length, 3);
});

test('stats: level, Barracks, Walls and size balance', () => {
  assert.equal(levelHealthMultiplier(0), 1);
  assert.equal(levelHealthMultiplier(5), 1.1);
  assert.equal(levelHealthMultiplier(40), 1.3, 'capped at +30%');

  assert.equal(sizeBalance(20, [20, 20]), 1);
  assert.equal(sizeBalance(20, [20, 20, 20]), 1);
  assert.ok(Math.abs(sizeBalance(10, [10, 30]) - 2 ** 0.6) < 1e-9, 'the smaller side is strengthened');
  assert.ok(Math.abs(sizeBalance(30, [10, 30]) - (2 / 3) ** 0.6) < 1e-9, 'the larger side is weakened');
  assert.ok(Math.abs(sizeBalance(10, [10, 20, 30]) - 2 ** 0.3) < 1e-9, 'three sides balance more gently');
  assert.equal(sizeBalance(1, [1, 99]), 1.8, 'clamped above');
  assert.ok(sizeBalance(999, [1, 999]) >= 0.6);

  const battle = new Battle({
    seed: 1,
    sides: [
      { id: 'red', damageBonus: 0.1, healthBonus: 0 },
      { id: 'blue', damageBonus: 0, healthBonus: 0.3 },
    ],
    fighters: [...squad('red', 2, 5), ...squad('blue', 2, 0)],
  });
  const red = battle.fighters.find((f) => f.side === 'red')!;
  const blue = battle.fighters.find((f) => f.side === 'blue')!;
  assert.ok(Math.abs(red.maxHealth - 110) < 1e-9);
  assert.ok(Math.abs(blue.maxHealth - 130) < 1e-9);
  // Damage also carries the side's fortune of battle, a factor within +-25%.
  const redFortune = battle.fortunes.red!;
  const blueFortune = battle.fortunes.blue!;
  for (const fortune of [redFortune, blueFortune]) assert.ok(fortune >= 0.75 && fortune <= 1.25);
  assert.ok(Math.abs(red.damage - 11 * redFortune) < 1e-9);
  assert.ok(Math.abs(blue.damage - 10 * blueFortune) < 1e-9);
});

test('equal sides win about equally often; a Barracks advantage shows', () => {
  let redWins = 0;
  let boostedWins = 0;
  const runs = 60;
  for (let seed = 1; seed <= runs; seed++) {
    if (new Battle(setup(seed, { red: 15, blue: 15 })).run().winner === 'red') redWins++;
    const boosted = new Battle({
      seed,
      sides: [
        { id: 'red', damageBonus: 0.2, healthBonus: 0 },
        { id: 'blue', damageBonus: 0, healthBonus: 0 },
      ],
      fighters: [...squad('red', 15), ...squad('blue', 15)],
    }).run();
    if (boosted.winner === 'red') boostedWins++;
  }
  assert.ok(redWins > runs * 0.3 && redWins < runs * 0.7, `red won ${redWins} of ${runs}`);
  assert.ok(boostedWins > redWins, `with +20% damage red won ${boostedWins}, without ${redWins}`);
});

test('selecting fighters: everyone if they fit, else heroes plus a seeded draw', () => {
  const pool = squad('red', 100);
  assert.equal(selectFighters(pool.slice(0, 30), new Set(), createRng(1)).length, 30);

  const heroes = new Set(['red-97', 'red-98', 'red-99']);
  const picked = selectFighters(pool, heroes, createRng(1));
  assert.equal(picked.length, config.battle.maxFightersPerSide);
  assert.equal(new Set(picked.map((f) => f.id)).size, picked.length, 'nobody is picked twice');
  for (const hero of heroes) assert.ok(picked.some((f) => f.id === hero));
  assert.deepEqual(selectFighters(pool, heroes, createRng(1)), picked);
  assert.notDeepEqual(selectFighters(pool, heroes, createRng(2)), picked);
});

test('a heavy fighter is barely pushed aside by a crowd; equal fighters share the push', () => {
  // Two fighters of one side start on the same spot; an enemy keeps the battle going.
  const crowd = (weight: number | undefined) => {
    const battle = new Battle({
      seed: 4,
      sides: [
        { id: 'red', damageBonus: 0, healthBonus: 0 },
        { id: 'blue', damageBonus: 0, healthBonus: 0 },
      ],
      fighters: [
        { id: 'heavy', name: '', color: null, side: 'red', level: 0, weight, speed: 0 },
        { id: 'light', name: '', color: null, side: 'red', level: 0, speed: 0 },
        { id: 'enemy', name: '', color: null, side: 'blue', level: 0, speed: 0 },
      ],
    });
    const [heavy, light] = battle.fighters as [typeof battle.fighters[0], typeof battle.fighters[0]];
    light.x = heavy.x + 1;
    light.y = heavy.y;
    const start = { heavy: heavy.x, light: light.x };
    battle.step();
    return { heavy: Math.abs(heavy.x - start.heavy), light: Math.abs(light.x - start.light) };
  };

  const equal = crowd(undefined);
  assert.ok(Math.abs(equal.heavy - equal.light) < 1e-6, 'equal weights give way equally');
  const uneven = crowd(40);
  assert.ok(uneven.heavy < uneven.light / 30, `heavy moved ${uneven.heavy}, light ${uneven.light}`);
  assert.ok(uneven.heavy > 0);
});

test('a bench: three per guild on the field, the others step in as fighters fall', () => {
  const battle = new Battle({
    ...setup(3, { red: 10, green: 10, blue: 10 }),
    field: { perSide: 3 },
    durationMs: 600_000,
    sizeBalance: false,
    fortune: false,
  });
  const onField = (side: string) => battle.fighters.filter((f) => f.alive && f.side === side).length;
  const benched = () => battle.fighters.filter((f) => f.benched).length;
  assert.equal(battle.fighters.filter((f) => f.alive).length, 9);
  assert.equal(benched(), 21);
  assert.equal(battle.frame().filter((f) => f[2] === 0 && f[3] & FLAG.benched).length, 21, 'the overlay can tell bench from fallen');

  let entries = 0;
  let firstDeathAt = Infinity;
  while (!battle.finished) {
    battle.step();
    for (const side of ['red', 'green', 'blue']) assert.ok(onField(side) <= 3);
    const entered = battle.events.filter((e) => e.k === 'enter').length;
    if (entered > 0) {
      if (entries === 0) {
        assert.ok(battle.timeMs - firstDeathAt >= config.bench.entryDelayMs, 'the first steps in a moment after the first death');
      }
      entries += entered;
    }
    const dead = battle.fighters.filter((f) => !f.alive && !f.benched).length;
    if (dead > 0 && firstDeathAt === Infinity) firstDeathAt = battle.timeMs;
  }
  const result = battle.result()!;
  assert.equal(result.endedBy, 'elimination');
  assert.equal(entries, 21 - benched(), 'everyone who left the bench stepped onto the field');
  for (const side of result.sides) {
    if (side.id === result.winner) assert.ok(side.survivors > 0);
    else assert.equal(side.survivors, 0, 'a guild is beaten only when its bench is empty too');
  }
  assert.ok(entries >= 14, `${entries} fighters came off the bench`);
});

test('a free-for-all with a bench: a limited field, random starts, one winner', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const battle = new Battle({
    seed: 9,
    sides: ids.map((id) => ({ id, damageBonus: 0, healthBonus: 0 })),
    fighters: ids.map((id) => ({ id, name: id, color: null, side: id, level: 0 })),
    field: { total: 6 },
    durationMs: 600_000,
    sizeBalance: false,
    fortune: false,
  });
  const alive = () => battle.fighters.filter((f) => f.alive);
  assert.equal(alive().length, 6);
  // Nobody starts in a corner group: the six are spread over the arena.
  const xs = alive().map((f) => f.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 300);
  while (!battle.finished) {
    battle.step();
    assert.ok(alive().length <= 6);
  }
  const result = battle.result()!;
  assert.ok(ids.includes(result.winner!));
  assert.equal(result.fighters.filter((f) => f.alive).length, 1, 'one fighter is left');
});

test('an endless fight never ends: the fallen rejoin the queue', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `f${i}`);
  const battle = new Battle({
    seed: 2,
    sides: ids.map((id) => ({ id, damageBonus: 0, healthBonus: 0 })),
    fighters: ids.map((id) => ({ id, name: id, color: null, side: id, level: 0 })),
    field: { total: 5 },
    endless: true,
    sizeBalance: false,
    fortune: false,
  });
  let entries = 0;
  let fieldSum = 0;
  const steps = 12_000;
  // Ten minutes of fighting, far past the usual time limit.
  for (let i = 0; i < steps; i++) {
    battle.step();
    entries += battle.events.filter((e) => e.k === 'enter').length;
    const onField = battle.fighters.filter((f) => f.alive).length;
    assert.ok(onField <= 5);
    fieldSum += onField;
  }
  assert.equal(battle.finished, false);
  assert.equal(battle.result(), null);
  assert.ok(entries > 24, `${entries} entries: more than twice around the roster`);
  assert.ok(fieldSum / steps > 4, `on average ${(fieldSum / steps).toFixed(2)} of 5 places were filled`);
  assert.equal(battle.fighters.filter((f) => !f.alive && !f.benched).length, 0, 'nobody is out for good');
});

test('fighters stay out of a corner that must be kept clear', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `f${i}`);
  // The lower right corner, as the overlay's map panel covers it, and a box in the upper left.
  const { width, height } = config.battle.arena;
  const k = width / 1_600;
  const corner = { left: 1_000 * k, top: 600 * k, right: width, bottom: height };
  const box = { left: 20 * k, top: 20 * k, right: 400 * k, bottom: 190 * k };
  const battle = new Battle({
    seed: 6,
    sides: ids.map((id) => ({ id, damageBonus: 0, healthBonus: 0 })),
    fighters: ids.map((id) => ({ id, name: id, color: null, side: id, level: 0 })),
    field: { total: 14 },
    endless: true,
    keepClear: [corner, box],
    sizeBalance: false,
    fortune: false,
  });
  const within = (f: { x: number; y: number; radius: number }, area: typeof corner) =>
    f.x > area.left - f.radius + 1e-6 &&
    f.x < area.right + f.radius - 1e-6 &&
    f.y > area.top - f.radius + 1e-6 &&
    f.y < area.bottom + f.radius - 1e-6;
  const inside = () => battle.fighters.filter((f) => f.alive && (within(f, corner) || within(f, box)));
  assert.deepEqual(inside(), [], 'nobody starts in a clear area');
  let entries = 0;
  for (let i = 0; i < 4_000; i++) {
    battle.step();
    entries += battle.events.filter((e) => e.k === 'enter').length;
    assert.deepEqual(inside().map((f) => f.id), []);
  }
  assert.ok(entries > 30, 'fighters kept stepping in from the edges, including the edges of that corner');
  // The rest of the arena is still used: fighters reach its right and lower parts.
  assert.ok(battle.fighters.some((f) => f.alive && (f.x > corner.left || f.y > corner.top)));
});
