import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../../src/config.ts';
import { Battle, type Fighter, type FighterSpec } from '../../src/game/battle.ts';

const saved = { ...config.roam };
afterEach(() => Object.assign(config.roam, saved));

/**
 * One red fighter in the middle of a crowd of blue ones, and a blue straggler
 * far off. Positions are set by hand; the battle is never stepped.
 */
function crowd(): { battle: Battle; stuck: Fighter; straggler: Fighter; alive: Fighter[]; unit: number } {
  const specs: FighterSpec[] = [{ id: 'r', name: 'r', color: null, side: 'red', class: 'fighter', level: 0 }];
  for (let i = 0; i < 7; i++) specs.push({ id: `b${i}`, name: `b${i}`, color: null, side: 'blue', class: 'fighter', level: 0 });
  const battle = new Battle({
    seed: 3,
    sides: [{ id: 'red', damageBonus: 0, healthBonus: 0 }, { id: 'blue', damageBonus: 0, healthBonus: 0 }],
    fighters: specs,
  });
  const [stuck, ...blue] = battle.fighters as [Fighter, ...Fighter[]];
  const unit = stuck.radius;
  stuck.x = 300;
  stuck.y = 300;
  // Six around it, close; the seventh far away on its own.
  blue.slice(0, 6).forEach((f, i) => {
    f.x = 300 + Math.cos(i) * unit * 2;
    f.y = 300 + Math.sin(i) * unit * 2;
  });
  const straggler = blue[6]!;
  straggler.x = 900;
  straggler.y = 450;
  return { battle, stuck, straggler, alive: battle.fighters.filter((f) => f.alive), unit };
}

const roamTarget = (battle: Battle, fighter: Fighter, alive: Fighter[], now: number): Fighter | null =>
  (battle as unknown as { roamTarget: (f: Fighter, a: Fighter[], n: number) => Fighter | null }).roamTarget(fighter, alive, now);

test('a fighter stuck in a crowd breaks out toward a straggler, and only after standing still for a check', () => {
  Object.assign(config.roam, { chance: 1, pick: 1 });
  const { battle, stuck, straggler, alive } = crowd();
  assert.equal(roamTarget(battle, stuck, alive, 0), null, 'the first look only notes where it stands');
  assert.equal(roamTarget(battle, stuck, alive, config.roam.checkMs - 1), null, 'not before the check');
  assert.equal(roamTarget(battle, stuck, alive, config.roam.checkMs), straggler, 'goes for the enemy standing alone');
  assert.equal(roamTarget(battle, stuck, alive, config.roam.checkMs + 500), straggler, 'and keeps to it');
});

test('it gives up the straggler when it gets there, when time is up, or when the straggler falls', () => {
  Object.assign(config.roam, { chance: 1, pick: 1 });
  const { checkMs, roamMs } = config.roam;
  for (const ending of ['reached', 'time', 'fallen'] as const) {
    const { battle, stuck, straggler, alive } = crowd();
    roamTarget(battle, stuck, alive, 0);
    assert.equal(roamTarget(battle, stuck, alive, checkMs), straggler);
    let now = checkMs + 100;
    if (ending === 'reached') {
      stuck.x = straggler.x - stuck.radius * 2;
      stuck.y = straggler.y;
    } else if (ending === 'time') {
      now = checkMs + roamMs[1];
      // Still stuck at the next check it would roll again; here it does not.
      config.roam.chance = 0;
    } else {
      straggler.alive = false;
    }
    // Back to the nearest enemy.
    assert.equal(roamTarget(battle, stuck, alive, now), null, ending);
    config.roam.chance = 1;
  }
});

test('a fighter that is moving, or not in a crowd, does not break out; and it is random', () => {
  Object.assign(config.roam, { chance: 1, pick: 1 });
  const { checkMs } = config.roam;

  const moving = crowd();
  roamTarget(moving.battle, moving.stuck, moving.alive, 0);
  moving.stuck.x += moving.unit * 2;
  assert.equal(roamTarget(moving.battle, moving.stuck, moving.alive, checkMs), null, 'it moved since the last check');

  const alone = crowd();
  for (const f of alone.alive.slice(1, 7)) f.x += 400;
  roamTarget(alone.battle, alone.stuck, alone.alive, 0);
  assert.equal(roamTarget(alone.battle, alone.stuck, alone.alive, checkMs), null, 'nobody crowds it');

  Object.assign(config.roam, { chance: 0 });
  const unlucky = crowd();
  roamTarget(unlucky.battle, unlucky.stuck, unlucky.alive, 0);
  for (let check = 1; check <= 20; check++) {
    assert.equal(roamTarget(unlucky.battle, unlucky.stuck, unlucky.alive, check * checkMs), null, 'chance 0: never');
  }

  // With the real chance, some checks break out and some do not.
  Object.assign(config.roam, { chance: saved.chance });
  let breakouts = 0;
  for (let seed = 0; seed < 40; seed++) {
    const c = crowd();
    (c.battle as unknown as { roamRng: () => number }).roamRng = (() => {
      let s = seed * 7919 + 1;
      return () => ((s = (s * 16807) % 2147483647) / 2147483647);
    })();
    roamTarget(c.battle, c.stuck, c.alive, 0);
    if (roamTarget(c.battle, c.stuck, c.alive, checkMs)) breakouts++;
  }
  assert.ok(breakouts > 0 && breakouts < 40, `${breakouts} of 40 broke out`);
});

test('the god and healers never break out', () => {
  Object.assign(config.roam, { chance: 1, pick: 1 });
  for (const make of [(f: Fighter) => (f.holdsCenter = true), (f: Fighter) => (f.class = 'healer')]) {
    const { battle, stuck, alive } = crowd();
    make(stuck);
    roamTarget(battle, stuck, alive, 0);
    assert.equal(roamTarget(battle, stuck, alive, config.roam.checkMs), null);
  }
});
