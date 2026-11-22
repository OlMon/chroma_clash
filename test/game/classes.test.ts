import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type ClassId } from '../../src/config.ts';
import { assignClasses, Battle, FLAG, type Fighter, type FighterSpec } from '../../src/game/battle.ts';
import { createRng } from '../../src/util/rng.ts';

const STEP_MS = 1000 / config.battle.stepsPerSecond;

function spec(id: string, side: string, cls: ClassId | null): FighterSpec {
  return { id, name: id, color: null, side, level: 0, class: cls };
}

/** A battle between red and blue without luck or balance, so only the classes matter. */
function battle(fighters: FighterSpec[], seed = 1): Battle {
  return new Battle({
    seed,
    durationMs: 600_000,
    sizeBalance: false,
    fortune: false,
    sides: [
      { id: 'red', damageBonus: 0, healthBonus: 0 },
      { id: 'blue', damageBonus: 0, healthBonus: 0 },
    ],
    fighters,
  });
}

const get = (b: Battle, id: string): Fighter => b.fighters.find((f) => f.id === id)!;
const place = (f: Fighter, x: number, y: number): void => {
  f.x = x;
  f.y = y;
};
const distance = (a: Fighter, b: Fighter): number => Math.hypot(a.x - b.x, a.y - b.y);

test('classes are dealt at random by their shares, and the god gets none', () => {
  const fighters: FighterSpec[] = Array.from({ length: 3000 }, (_, i) => ({
    id: `f${i}`,
    name: '',
    color: null,
    side: 'red',
    level: 0,
  }));
  const god: FighterSpec = { id: 'god', name: 'God', color: null, side: 'god', level: 0, health: 500 };
  const preset = spec('preset', 'red', 'healer');
  assignClasses([...fighters, god, preset], createRng(4));
  assert.equal(god.class, undefined);
  assert.equal(preset.class, 'healer', 'a class that is already set stays');

  const counts: Record<string, number> = {};
  for (const fighter of fighters) counts[fighter.class!] = (counts[fighter.class!] ?? 0) + 1;
  for (const [id, share] of Object.entries(config.classes.shares)) {
    const got = (counts[id] ?? 0) / fighters.length;
    assert.ok(Math.abs(got - share) < 0.03, `${id}: ${got} of ${share}`);
  }

  const again: FighterSpec[] = fighters.map((f) => ({ ...f, class: undefined }));
  assignClasses(again, createRng(4));
  assert.deepEqual(again.map((f) => f.class), fighters.map((f) => f.class), 'the same seed deals the same classes');
});

test('a class sets health, damage and speed', () => {
  const ids = Object.keys(config.classes.names) as ClassId[];
  const b = battle([...ids.map((id) => spec(id, 'red', id)), spec('plain', 'blue', null)]);
  const plain = get(b, 'plain');
  assert.equal(plain.maxHealth, config.battle.baseHealth);
  for (const id of ids) {
    const fighter = get(b, id);
    const stats = config.classes[id];
    assert.ok(Math.abs(fighter.maxHealth - config.battle.baseHealth * stats.health) < 1e-9, id);
    assert.ok(Math.abs(fighter.damage - config.battle.baseDamage * stats.damage) < 1e-9, id);
  }
  assert.ok(get(b, 'tank').speed < get(b, 'fighter').speed && get(b, 'thief').speed > get(b, 'fighter').speed);
  assert.ok(get(b, 'tank').maxHealth > get(b, 'fighter').maxHealth);
});

test('Fighter: with two enemies around it, a spin hits both', () => {
  const b = battle([spec('f', 'red', 'fighter'), spec('a', 'blue', null), spec('b', 'blue', null)]);
  place(get(b, 'f'), 800, 500);
  place(get(b, 'a'), 800 - 85, 500);
  place(get(b, 'b'), 800 + 85, 500);
  let spins = 0;
  for (let i = 0; i < 160; i++) {
    const before = [get(b, 'a').health, get(b, 'b').health];
    b.step();
    const spin = b.events.find((e) => e.k === 'fx' && e.fx === 'spin');
    if (!spin) continue;
    spins++;
    assert.equal(spin.i, b.fighters.indexOf(get(b, 'f')));
    assert.ok(get(b, 'a').health < before[0]! && get(b, 'b').health < before[1]!, 'both were hit in the same step');
  }
  assert.ok(spins >= 1 && spins <= 3, `${spins} spins in 8 seconds`);
});

test('Tank: nearby enemies prefer it, and it raises a shield', () => {
  const b = battle([spec('tank', 'red', 'tank'), spec('weak', 'red', null), spec('e1', 'blue', null), spec('e2', 'blue', null)]);
  // The plain red fighter stands nearer to the enemies than the tank does.
  place(get(b, 'weak'), 700, 500);
  place(get(b, 'tank'), 700, 600);
  place(get(b, 'e1'), 800, 480);
  place(get(b, 'e2'), 800, 540);
  get(b, 'weak').speed = 0;
  let shielded = 0;
  for (let i = 0; i < 200; i++) {
    b.step();
    if (b.frame()[b.fighters.indexOf(get(b, 'tank'))]![3] & FLAG.shielded) shielded++;
  }
  assert.equal(get(b, 'weak').health, get(b, 'weak').maxHealth, 'the enemies went for the tank');
  assert.ok(get(b, 'tank').health < get(b, 'tank').maxHealth);
  const expected = config.classes.tank.shieldMs / STEP_MS;
  assert.ok(shielded >= expected - 2 && shielded <= expected * 2 + 2, `shielded for ${shielded} steps`);
});

test('Thief: goes for those who stand back, and darts away after each strike', (t) => {
  // The shadows are tested on their own; here the thief stays visible.
  const every = config.classes.thief.shadowEveryMs;
  config.classes.thief.shadowEveryMs = 10 ** 9;
  t.after(() => {
    config.classes.thief.shadowEveryMs = every;
  });
  const b = battle([spec('thief', 'red', 'thief'), spec('guard', 'blue', null), spec('archer', 'blue', 'archer')]);
  place(get(b, 'thief'), 400, 500);
  place(get(b, 'guard'), 520, 420); // nearer, and not in the straight line to the archer
  place(get(b, 'archer'), 900, 500);
  for (const id of ['guard', 'archer']) {
    get(b, id).speed = 0;
    get(b, id).damage = 0;
  }
  const thief = get(b, 'thief');
  const archer = get(b, 'archer');
  let strikes = 0;
  let dartedBack = 0;
  let previous = archer.health;
  let gapAtStrike = 0;
  let sinceStrike = -1;
  for (let i = 0; i < 400 && archer.alive; i++) {
    b.step();
    if (archer.health < previous) {
      strikes++;
      gapAtStrike = distance(thief, archer);
      sinceStrike = 0;
    } else if (sinceStrike >= 0) {
      sinceStrike++;
      if (sinceStrike === 10 && distance(thief, archer) > gapAtStrike + 40) dartedBack++;
    }
    previous = archer.health;
  }
  assert.equal(get(b, 'guard').health, get(b, 'guard').maxHealth, 'it ignored the nearer fighter');
  assert.ok(strikes >= 3, `${strikes} strikes on the archer`);
  assert.ok(dartedBack >= strikes - 1, `it darted back after ${dartedBack} of ${strikes} strikes`);
});

test('Thief: in the shadows it cannot be targeted or hurt, moves faster, and its strike gives it away', (t) => {
  const { shadowMs, shadowEveryMs, shadowSpeed } = config.classes.thief;
  // About the shadows alone: no charges or opening rush that would bring the guard upon the thief early.
  const { charge, opening, focus } = config.motion;
  const saved = { charge: charge.speed, opening: opening.speed, wander: focus.wanderChance };
  charge.speed = 1;
  opening.speed = 1;
  focus.wanderChance = 0;
  t.after(() => {
    charge.speed = saved.charge;
    opening.speed = saved.opening;
    focus.wanderChance = saved.wander;
  });
  const b = battle([spec('thief', 'red', 'thief'), spec('decoy', 'red', null), spec('guard', 'blue', null)]);
  const thief = get(b, 'thief');
  const guard = get(b, 'guard');
  const decoy = get(b, 'decoy');
  place(thief, 60, 160);
  place(decoy, 60, 520);
  place(guard, 990, 160);
  decoy.speed = 0;
  guard.damage = 1000; // one blow would fell the thief
  const index = b.fighters.indexOf(thief);
  const hidden = () => (b.frame()[index]![3] & FLAG.hidden) !== 0;

  // Before its first shadow: the guard heads for the thief, the nearer of the two.
  let steps = 0;
  while (!hidden() && steps < 200) {
    b.step();
    steps++;
  }
  assert.ok(hidden(), 'the thief slipped into the shadows');
  assert.ok(b.events.some((e) => e.fx === 'shadow'));
  const enteredAt = b.timeMs;

  // Hidden: it moves faster than it normally can, and the guard turns to the decoy.
  const from = { x: thief.x, y: thief.y };
  const toDecoy = () => Math.hypot(guard.x - decoy.x, guard.y - decoy.y);
  const decoyWas = toDecoy();
  for (let i = 0; i < 10; i++) b.step();
  assert.ok(hidden());
  const moved = Math.hypot(thief.x - from.x, thief.y - from.y);
  assert.ok(moved > thief.speed * 0.5 * 1.3, `it covered ${Math.round(moved)} units in half a second`);
  assert.ok(moved <= thief.speed * shadowSpeed * 0.5 + 5, `at most as fast as the shadows let it (${Math.round(moved)} units)`);
  assert.ok(toDecoy() < decoyWas - 20, 'the guard cannot see it and goes for the decoy');

  // Put the guard right upon it: hidden, the thief takes no harm, and its own strike ends the shadow.
  place(guard, thief.x + thief.radius + guard.radius, thief.y);
  guard.speed = 0;
  const health = thief.health;
  let struck = false;
  for (let i = 0; i < 40 && !struck; i++) {
    const before = guard.health;
    b.step();
    if (guard.health < before) struck = true;
    else assert.equal(thief.health, health, 'unhurt while hidden');
  }
  assert.ok(struck, 'the thief struck from the shadows');
  assert.equal(hidden(), false, 'which gave it away');
  assert.ok(b.timeMs - enteredAt < shadowMs, 'before the shadow would have ended by itself');

  // Left alone, a shadow ends by itself, and the next comes after the pause.
  const alone = battle([spec('thief', 'red', 'thief'), spec('far', 'blue', null)]);
  place(get(alone, 'thief'), 100, 200);
  place(get(alone, 'far'), 1500, 800);
  get(alone, 'far').speed = 0;
  get(alone, 'thief').speed = 1; // too slow to reach anyone
  const spans: number[] = [];
  const starts: number[] = [];
  let since = -1;
  for (let i = 0; i < 400; i++) {
    alone.step();
    const now = (alone.frame()[0]![3] & FLAG.hidden) !== 0;
    if (now && since < 0) {
      since = alone.timeMs;
      starts.push(since);
    }
    if (!now && since >= 0) {
      spans.push(alone.timeMs - since);
      since = -1;
    }
  }
  assert.ok(spans.length >= 2);
  for (const span of spans) assert.ok(Math.abs(span - shadowMs) <= STEP_MS, `a shadow lasted ${span} ms`);
  assert.ok(Math.abs(starts[1]! - starts[0]! - shadowEveryMs) <= STEP_MS);
});

test('Archer: shoots from a distance and backs off when approached', () => {
  const b = battle([spec('archer', 'red', 'archer'), spec('target', 'blue', null)]);
  const archer = get(b, 'archer');
  const target = get(b, 'target');
  place(archer, 500, 500);
  place(target, 900, 500);
  target.speed = 0;
  let arrows = 0;
  for (let i = 0; i < 100; i++) {
    b.step();
    arrows += b.events.filter((e) => e.k === 'fx' && e.fx === 'arrow').length;
  }
  assert.ok(arrows >= 4, `${arrows} arrows in 5 seconds`);
  assert.ok(target.health < target.maxHealth);
  assert.ok(distance(archer, target) > 200, 'it stays at range and does not walk up to its target');

  // Now the target comes for it: the archer gives ground.
  target.speed = 100;
  place(target, archer.x + 90, archer.y);
  const start = archer.x;
  for (let i = 0; i < 20; i++) b.step();
  assert.ok(archer.x < start - 40, 'it backed away');
});

test('Mage: marks a circle, and the blast hits everyone in it a moment later', () => {
  const b = battle([spec('mage', 'red', 'mage'), spec('a', 'blue', null), spec('b', 'blue', null), spec('far', 'blue', null)]);
  place(get(b, 'mage'), 400, 500);
  place(get(b, 'a'), 800, 500);
  place(get(b, 'b'), 850, 520);
  place(get(b, 'far'), 800, 250);
  for (const id of ['a', 'b', 'far']) get(b, id).speed = 0;

  let warnedAt = -1;
  let warn: { x: number; y: number; r?: number } | null = null;
  let blastAt = -1;
  for (let i = 0; i < 200 && blastAt < 0; i++) {
    b.step();
    for (const event of b.events) {
      if (event.fx === 'blast-warn' && warnedAt < 0) {
        warnedAt = b.timeMs;
        warn = event;
        assert.equal(get(b, 'a').health, get(b, 'a').maxHealth, 'the warning itself does no harm');
      }
      if (event.fx === 'blast') blastAt = b.timeMs;
    }
  }
  assert.ok(warn && warn.r! > 0);
  assert.ok(Math.abs(blastAt - warnedAt - config.classes.mage.warnMs) <= STEP_MS);
  assert.ok(get(b, 'a').health < get(b, 'a').maxHealth && get(b, 'b').health < get(b, 'b').maxHealth);
  assert.equal(get(b, 'far').health, get(b, 'far').maxHealth, 'outside the circle, unharmed');
});

test('Healer: heals the ally with the least health, never itself, and strikes nobody', () => {
  const b = battle([spec('healer', 'red', 'healer'), spec('hurt', 'red', null), spec('fine', 'red', null), spec('enemy', 'blue', null)]);
  place(get(b, 'healer'), 400, 300);
  place(get(b, 'hurt'), 400, 600);
  place(get(b, 'fine'), 300, 300);
  place(get(b, 'enemy'), 1400, 800);
  for (const id of ['hurt', 'fine', 'enemy']) get(b, id).speed = 0;
  const healer = get(b, 'healer');
  const hurt = get(b, 'hurt');
  hurt.health = 30;
  healer.health = 40;

  let heals = 0;
  for (let i = 0; i < 160; i++) {
    b.step();
    for (const event of b.events) {
      if (event.fx !== 'heal') continue;
      heals++;
      assert.deepEqual(event.t, [b.fighters.indexOf(hurt)]);
    }
  }
  assert.ok(heals >= 8, `${heals} heals`);
  assert.ok(hurt.health > 60, `the hurt ally is at ${hurt.health}`);
  assert.ok(hurt.health <= hurt.maxHealth);
  assert.equal(healer.health, 40, 'it does not heal itself');
  assert.equal(healer.damageDealt, 0);
  // Within its healing range of its patient (a fighter's radius is the battle's unit), from much further away.
  assert.ok(distance(healer, hurt) < config.classes.healer.rangeFactor * hurt.radius + hurt.radius + 20, 'it went to its patient');
});

test('Healers left alone fight for themselves, so a battle of healers still ends', () => {
  const b = battle([
    spec('h1', 'red', 'healer'),
    spec('h2', 'red', 'healer'),
    spec('h3', 'blue', 'healer'),
    spec('h4', 'blue', 'healer'),
  ]);
  const result = b.run();
  // With equal fighters the last two may fall to each other in the same moment, which leaves no winner.
  assert.equal(result.endedBy, 'elimination', 'it did not run to the time limit');
  assert.ok(result.fighters.filter((f) => f.alive).length <= 2);
  assert.ok(result.fighters.some((f) => f.kills > 0), 'healers struck each other');
});

test('battles of mixed classes end, and are decided by the seed alone', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const fighters: FighterSpec[] = [];
    for (let i = 0; i < 20; i++) fighters.push(spec(`r${i}`, 'red', null), spec(`b${i}`, 'blue', null));
    for (const fighter of fighters) fighter.class = undefined;
    assignClasses(fighters, createRng(seed));
    const first = battle(fighters.map((f) => ({ ...f })), seed);
    const second = battle(fighters.map((f) => ({ ...f })), seed);
    const { width, height, top, margin } = config.battle.arena;
    while (!first.finished) {
      first.step();
      second.step();
      for (const f of first.fighters) {
        if (!f.alive) continue;
        assert.ok(f.x >= f.radius + margin - 1 && f.x <= width - f.radius - margin + 1, 'inside the screen');
        assert.ok(f.y >= top + f.radius - 1 && f.y <= height - f.radius - margin + 1, 'inside the screen');
      }
    }
    const result = first.result()!;
    assert.deepEqual(second.run(), result);
    assert.ok(result.durationMs < 600_000, `seed ${seed} ran to the long test limit`);
    assert.ok(result.winner === 'red' || result.winner === 'blue' || result.winner === null);
  }
});
