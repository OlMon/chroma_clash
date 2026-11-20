import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { Battle, radiusFor, type BattleSetup, type FighterSpec } from '../../src/game/battle.ts';
import { ARENAS, OBSTACLE_CODE, Obstacles, type ArenaId } from '../../src/game/obstacles.ts';
import { createRng } from '../../src/util/rng.ts';

function setup(seed: number, extra: Partial<BattleSetup> = {}, perSide = 12, sides = ['red', 'blue']): BattleSetup {
  const fighters = [];
  for (let i = 0; i < perSide * sides.length; i++) {
    fighters.push({ id: `f${i}`, name: `f${i}`, color: null, side: sides[i % sides.length]!, level: 1 });
  }
  return { seed, sides: sides.map((id) => ({ id, damageBonus: 0, healthBonus: 0 })), fighters, ...extra };
}

/** Runs `body` with every team battle getting a layout. */
function alwaysObstacles(body: () => void): void {
  const saved = config.obstacles.chance;
  config.obstacles.chance = 1;
  try {
    body();
  } finally {
    config.obstacles.chance = saved;
  }
}

test('without obstacles a battle has none, and plays exactly as before', () => {
  const plain = new Battle(setup(3));
  assert.equal(plain.obstacleFrame(), null);
  // The obstacles have random numbers of their own: switching them on does not change the fighters' start.
  alwaysObstacles(() => {
    const withObstacles = new Battle(setup(3, { obstacles: 'fixed' }));
    assert.ok(withObstacles.obstacleFrame());
    const frame = plain.frame();
    withObstacles.frame().forEach((fighter, i) => {
      const [x, y] = frame[i]!;
      // Only a fighter that started on a wall or a bumper was moved off it.
      if (fighter[0] !== x || fighter[1] !== y) assert.ok(Math.hypot(fighter[0] - x, fighter[1] - y) < 4 * plain.fighters[i]!.radius);
    });
  });
});

test('only some team battles get obstacles', () => {
  let some = 0;
  for (let seed = 1; seed <= 60; seed++) if (new Battle(setup(seed, { obstacles: 'fixed' })).obstacleFrame()) some++;
  assert.ok(some > 60 * config.obstacles.chance * 0.5 && some < 60 * Math.min(1, config.obstacles.chance * 1.5), `${some} of 60`);
});

test('with obstacles, battles still end and nobody ever stands inside a wall', () => {
  alwaysObstacles(() => {
    for (let seed = 1; seed <= 12; seed++) {
      const battle = new Battle(setup(seed, { obstacles: 'fixed' }));
      while (!battle.finished) {
        battle.step();
        for (const wall of (battle.obstacleFrame() ?? []).filter((o) => o[1] === OBSTACLE_CODE.wall && o[7] === 100)) {
          for (const f of battle.fighters) {
            if (!f.alive || f.flight) continue;
            const inside = Math.abs(f.x - wall[2]) < wall[4] / 2 - 1 && Math.abs(f.y - wall[3]) < wall[5] / 2 - 1;
            assert.ok(!inside, `seed ${seed}: ${f.id} inside a wall at ${battle.timeMs} ms`);
          }
        }
      }
      assert.ok(battle.result());
    }
  });
});

test('a bumper flings whoever touches it straight away', () => {
  alwaysObstacles(() => {
    for (let seed = 1; seed <= 200; seed++) {
      const battle = new Battle(setup(seed, { obstacles: 'fixed' }));
      const bumper = (battle.obstacleFrame() ?? []).find((o) => o[1] === OBSTACLE_CODE.bumper);
      if (!bumper) continue;
      const [, , bx, by, r] = bumper;
      // Bumpers and traps keep quiet while the teams find their feet.
      while (battle.timeMs < config.obstacles.quietMs) battle.step();
      const fighter = battle.fighters[0]!;
      fighter.x = bx + r + fighter.radius;
      fighter.y = by;
      battle.step();
      assert.ok(fighter.flight, 'in the air');
      assert.ok(fighter.flight!.vx > 0.9, 'away from the bumper');
      return;
    }
    assert.fail('no layout with a bumper in 200 seeds');
  });
});

test('in a free-for-all obstacles appear and disappear', () => {
  const ffa = setup(5, { obstacles: 'changing', endless: true, field: { total: 10 } }, 1, Array.from({ length: 14 }, (_, i) => `s${i}`));
  const battle = new Battle(ffa);
  const seen = new Map<number, { first: number; last: number }>();
  for (let i = 0; i < config.battle.stepsPerSecond * 150; i++) {
    battle.step();
    for (const o of battle.obstacleFrame() ?? []) {
      const entry = seen.get(o[0]) ?? { first: battle.timeMs, last: 0 };
      entry.last = battle.timeMs;
      seen.set(o[0], entry);
    }
  }
  const standing = [...seen.values()];
  assert.ok(standing.length >= 4, `${standing.length} obstacles in two and a half minutes`);
  assert.ok(standing.some((o) => o.last < battle.timeMs - 1000), 'some are gone again');
});

// --- Arenas -----------------------------------------------------------------------

const kindsOf = (battle: Battle) => new Set((battle.obstacleFrame() ?? []).map((o) => o[1]));
const { wall, bumper, barrel, trap } = OBSTACLE_CODE;

test('a team battle with obstacles is fought in a named arena, built to its plan', () => {
  const expected: Record<ArenaId, number[]> = {
    pinball: [bumper],
    fortress: [wall, trap],
    brewery: [wall],
    spikepit: [trap],
    ruins: [wall],
    funhouse: [bumper, trap],
    gauntlet: [wall],
  };
  for (const place of ARENAS) {
    for (const seed of [1, 2, 3]) {
      const battle = new Battle(setup(seed, { obstacles: 'fixed', place }));
      assert.equal(battle.place, place);
      assert.deepEqual([...kindsOf(battle)].sort(), [...expected[place]].sort(), `${place}, seed ${seed}`);
      if (place === 'gauntlet') assert.equal(battle.obstacleFrame()!.filter((o) => o[1] === wall).length, 2, 'the corridor is always there');
    }
  }
  // Barrels roll in the Brewery and down the Gauntlet's corridor, and only there.
  for (const place of ARENAS) {
    const battle = new Battle(setup(4, { obstacles: 'fixed', place }));
    let rolled = false;
    while (battle.timeMs < 12_000 && !battle.finished) {
      battle.step();
      rolled ||= (battle.obstacleFrame() ?? []).some((o) => o[1] === barrel);
    }
    assert.equal(rolled, place === 'brewery' || place === 'gauntlet', place);
  }
  // By chance, every arena comes up; a battle without obstacles has none.
  const seen = new Set<string>();
  alwaysObstacles(() => {
    for (let seed = 1; seed <= 80; seed++) seen.add(new Battle(setup(seed, { obstacles: 'fixed' })).place ?? 'none');
  });
  assert.deepEqual([...seen].sort(), [...ARENAS].sort());
  assert.equal(new Battle(setup(1)).place, null);
});

test('in a long battle the arena changes: obstacles that fit it come and go', () => {
  for (const place of ['pinball', 'spikepit', 'ruins'] as const) {
    const battle = new Battle(setup(9, { obstacles: 'fixed', place, durationMs: 120_000, toughness: 6 }, 20));
    const standing = () => (battle.obstacleFrame() ?? []).filter((o) => o[1] !== barrel && o[7] === 100);
    const start = new Set(standing().map((o) => o[0]));
    const before = standing().length;
    while (battle.timeMs < config.obstacles.arena.changeAfterMs - 100) battle.step();
    assert.deepEqual(new Set(standing().map((o) => o[0])), start, `${place}: nothing changes early`);
    const ids = new Set<number>();
    while (battle.timeMs < 80_000 && !battle.finished) {
      battle.step();
      const now = standing();
      for (const o of now) ids.add(o[0]);
      assert.deepEqual([...kindsOf(battle)].filter((k) => k !== barrel).every((k) => kindsOf(new Battle(setup(9, { obstacles: 'fixed', place }))).has(k)), true, `${place}: only kinds that fit`);
      assert.ok(now.length <= before + 2 && now.length >= Math.max(1, before - 2) - 1, `${place}: about as many as at the start (${now.length} vs ${before})`);
    }
    const added = [...ids].filter((id) => !start.has(id));
    const gone = [...start].filter((id) => !standing().some((o) => o[0] === id));
    assert.ok(added.length + gone.length >= 2, `${place}: ${added.length} came, ${gone.length} went`);
  }
});

test('bumpers and traps keep quiet while the teams find their feet', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 560 };
  const obstacles = Obstacles.create('fixed', createRng(3), 20, bounds, [], 'funhouse')!;
  const frame = obstacles.frame(0);
  const [, , tx, ty] = frame.find((o) => o[1] === trap)!;
  const [, , bx, by, br] = frame.find((o) => o[1] === bumper)!;
  const onTrap = { x: tx, y: ty, radius: 10, weight: 1, alive: true, flight: null, spinning: false };
  const byBumper = { x: bx + br + 10, y: by, radius: 10, weight: 1, alive: true, flight: null, spinning: false };
  const done: ('hurt' | 'fling')[] = [];
  const act = {
    hurt: () => done.push('hurt'),
    fling: () => done.push('fling'),
    settle: () => {},
  };
  const step = 1000 / config.battle.stepsPerSecond;
  for (let t = 0; t < config.obstacles.quietMs; t += step) obstacles.update(t, step / 1000, [onTrap, byBumper], act);
  assert.equal(done.length, 0, 'nothing before');
  for (let t = config.obstacles.quietMs; t < config.obstacles.quietMs + config.obstacles.trap.periodMs + step; t += step) {
    obstacles.update(t, step / 1000, [onTrap, byBumper], act);
  }
  assert.ok(done.includes('hurt') && done.includes('fling'), 'then both act');
});

/** A god holding the middle with Rampage, against `chatters` fighters, in an arena. */
function godInArena(place: ArenaId, seed: number, chatters = 20): Battle {
  const radius = radiusFor(chatters + 1);
  const fighters: FighterSpec[] = [
    {
      id: 'god', name: 'God', color: null, side: 'god', level: 0, health: 100_000,
      damage: config.god.damage, radius: radius * config.god.radiusFactor, splashRadius: radius * config.god.splashFactor,
      speed: config.god.speed, weight: config.god.weight, skills: ['rampage'],
    },
  ];
  for (let i = 0; i < chatters; i++) fighters.push({ id: `c${i}`, name: `C${i}`, color: null, side: 'red', level: 0 });
  return new Battle({
    seed, durationMs: 120_000, sizeBalance: false, timeLimitWinner: 'god', obstacles: 'fixed', place,
    sides: [{ id: 'god', damageBonus: 0, healthBonus: 0 }, { id: 'red', team: 'chat', damageBonus: 0, healthBonus: 0 }],
    fighters,
  });
}

test('the god\'s Rampage breaks the walls in its way', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const battle = godInArena('fortress', seed);
    const walls = () => (battle.obstacleFrame() ?? []).filter((o) => o[1] === wall);
    const before = walls().length;
    while (!battle.finished && battle.timeMs < 60_000) {
      battle.step();
      const smash = battle.events.find((e) => e.k === 'fx' && e.fx === 'smash');
      if (!smash) continue;
      assert.equal(battle.events.find((e) => e.k === 'cast' || e.k === 'fx')?.i, 0, 'the god did it');
      assert.ok(walls().some((o) => o[6] === 1), 'a wall shows broken');
      for (let i = 0; i < config.battle.stepsPerSecond; i++) battle.step();
      assert.ok(walls().length < before, 'and is gone a moment later');
      return;
    }
  }
  assert.fail('no Rampage broke a wall in 10 battles');
});

test('a fighter thrown into a bumper bounces off it, at full speed again', () => {
  const battle = new Battle(setup(3, { obstacles: 'fixed', place: 'pinball' }, 4));
  while (battle.timeMs < config.obstacles.quietMs) battle.step();
  const [, , bx, by, r] = battle.obstacleFrame()!.find((o) => o[1] === bumper)!;
  const fighter = battle.fighters[0]!;
  // Thrown from the left straight at it.
  fighter.x = bx - r - fighter.radius - 6;
  fighter.y = by;
  const now = battle.timeMs;
  fighter.flight = { vx: 1, vy: 0, speed: config.skills.shockwave.launchSpeed, from: now - 200, until: now + 100 };
  for (let i = 0; i < 3 && fighter.flight?.vx! > 0; i++) battle.step();
  assert.ok(fighter.flight, 'still flying');
  assert.ok(fighter.flight!.vx < 0, 'back the way it came');
  assert.ok(fighter.flight!.until - battle.timeMs >= config.obstacles.bumper.flingMs, 'sent off again');
  assert.ok(battle.obstacleFrame()!.some((o) => o[1] === bumper && o[6] === 1), 'the bumper lights up');
});
