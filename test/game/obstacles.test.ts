import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { Battle, type BattleSetup } from '../../src/game/battle.ts';
import { OBSTACLE_CODE } from '../../src/game/obstacles.ts';

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
