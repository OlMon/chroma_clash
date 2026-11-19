import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, type SkillId } from '../../src/config.ts';
import {
  Battle,
  FLAG,
  radiusFor,
  skillHealthFactor,
  type Arena,
  type BattleEvent,
  type FighterSpec,
} from '../../src/game/battle.ts';

const STEP_MS = 1000 / config.battle.stepsPerSecond;
const ALL: SkillId[] = ['rampage', 'shockwave', 'leap', 'vortex', 'smite', 'shield', 'minions', 'enrage'];

/** A god with the given skills against `chatters` fighters. The god is the first fighter. */
function godBattle(skills: SkillId[], chatters = 20, seed = 1, godHealth = 100_000, arena?: Arena): Battle {
  const fighters: FighterSpec[] = [];
  const radius = radiusFor(chatters + 1);
  fighters.push({
    id: 'god',
    name: 'God',
    color: null,
    side: 'god',
    level: 0,
    health: godHealth,
    damage: config.god.damage,
    radius: radius * config.god.radiusFactor,
    splashRadius: radius * config.god.splashFactor,
    speed: config.god.speed,
    weight: config.god.weight,
    skills,
  });
  for (let i = 0; i < chatters; i++) {
    fighters.push({ id: `c${i}`, name: `C${i}`, color: null, side: 'red', level: 0 });
  }
  return new Battle({
    seed,
    durationMs: 120_000,
    sizeBalance: false,
    timeLimitWinner: 'god',
    sides: [
      { id: 'god', damageBonus: 0, healthBonus: 0 },
      { id: 'red', team: 'chat', damageBonus: 0, healthBonus: 0 },
    ],
    fighters,
    ...(arena ? { arena } : {}),
  });
}

/** Steps the battle until an event of the given kind and skill appears, and returns it. */
function until(battle: Battle, kind: BattleEvent['k'], skill: SkillId, maxSteps = 800): BattleEvent {
  for (let i = 0; i < maxSteps && !battle.finished; i++) {
    battle.step();
    const event = battle.events.find((e) => e.k === kind && e.s === skill);
    if (event) return event;
  }
  throw new Error(`no ${kind} of ${skill} within ${maxSteps} steps`);
}

const chatOf = (battle: Battle) => battle.fighters.filter((f) => f.side === 'red');

test('a fighter without skills casts nothing', () => {
  const battle = godBattle([], 10);
  for (let i = 0; i < 400 && !battle.finished; i++) {
    battle.step();
    assert.deepEqual(battle.events, []);
  }
  assert.equal(battle.fighters.length, 11, 'no minions wait off the field');
});

test('a skill is announced first and cast one second later', () => {
  const battle = godBattle(['shockwave']);
  const warn = until(battle, 'warn', 'shockwave');
  const warnedAt = battle.timeMs;
  const [first, last] = config.skills.firstCastMs;
  assert.ok(warnedAt >= first && warnedAt <= last + STEP_MS, `first cast announced at ${warnedAt} ms`);
  assert.equal(warn.i, 0, 'the caster is the god');
  assert.equal(warn.ms, config.skills.warnMs);

  until(battle, 'cast', 'shockwave');
  assert.ok(Math.abs(battle.timeMs - warnedAt - config.skills.warnMs) <= STEP_MS);

  // The next cast follows after the interval.
  until(battle, 'warn', 'shockwave');
  const gap = battle.timeMs - warnedAt - config.skills.warnMs;
  assert.ok(gap >= config.skills.intervalMs[0] && gap <= config.skills.intervalMs[1] + 2 * STEP_MS, `gap ${gap}`);
});

test('battles with skills are still decided by the seed alone', () => {
  const a = godBattle(ALL, 30, 5, 2_000);
  const b = godBattle(ALL, 30, 5, 2_000);
  for (let i = 0; i < 600 && !a.finished; i++) {
    a.step();
    b.step();
    assert.deepEqual(a.frame(), b.frame());
    assert.deepEqual(a.events, b.events);
  }
  assert.deepEqual(a.run(), b.run());
});

test('Shockwave pushes nearby fighters away, hurts and slows them', () => {
  const battle = godBattle(['shockwave'], 12);
  until(battle, 'warn', 'shockwave');
  // Step to just before the cast and note who stands near the god.
  for (let i = 0; i < config.skills.warnMs / STEP_MS - 1; i++) battle.step();
  const god = battle.fighters[0]!;
  const radius = god.radius + radiusFor(13) * config.skills.shockwave.radiusFactor;
  const near = chatOf(battle).filter((f) => f.alive && Math.hypot(f.x - god.x, f.y - god.y) <= radius - 40);
  assert.ok(near.length > 0, 'the god is surrounded by then');
  const before = new Map(near.map((f) => [f, { d: Math.hypot(f.x - god.x, f.y - god.y), health: f.health }]));

  const cast = until(battle, 'cast', 'shockwave', 3);
  assert.ok(cast.r! > 0);
  const frame = battle.frame();
  for (const fighter of near) {
    if (!fighter.alive) continue;
    const was = before.get(fighter)!;
    assert.ok(Math.hypot(fighter.x - god.x, fighter.y - god.y) > was.d, 'pushed away');
    assert.ok(fighter.health < was.health, 'hurt');
    assert.ok(fighter.slowUntil > battle.timeMs, 'slowed');
    assert.ok(frame[battle.fighters.indexOf(fighter)]![3] & FLAG.slowed);
  }
});

test('Leap lands the god on the announced spot and damages those around it', () => {
  const battle = godBattle(['leap'], 25);
  const warn = until(battle, 'warn', 'leap');
  const god = battle.fighters[0]!;
  const standingAt = { x: god.x, y: god.y };
  for (let i = 0; i < 5; i++) battle.step();
  // It does not walk during the warning, and the crowd around it is too light to shove it.
  assert.ok(Math.hypot(god.x - standingAt.x, god.y - standingAt.y) < 10, 'the god stands its ground');

  const health = new Map(chatOf(battle).map((f) => [f, f.health]));
  const cast = until(battle, 'cast', 'leap', 30);
  assert.ok(Math.hypot(cast.x - warn.x, cast.y - warn.y) < 60, 'it lands where the shadow was');
  assert.ok(Math.hypot(god.x - warn.x, god.y - warn.y) < 60);
  assert.ok(chatOf(battle).some((f) => f.health < health.get(f)!), 'someone was under it');
});

test('Rampage sends the god across the arena and back, inside the walls', () => {
  const battle = godBattle(['rampage'], 20);
  const warn = until(battle, 'warn', 'rampage');
  assert.ok(Math.abs(Math.hypot(warn.dx!, warn.dy!) - 1) < 0.02, 'the warning carries the direction');
  until(battle, 'cast', 'rampage');

  const god = battle.fighters[0]!;
  const { width, height, top } = config.battle.arena;
  let travelled = 0;
  let last = { x: god.x, y: god.y };
  const health = chatOf(battle).reduce((sum, f) => sum + f.health, 0);
  for (let i = 0; i < config.skills.rampage.maxMs / STEP_MS + 2; i++) {
    battle.step();
    travelled += Math.hypot(god.x - last.x, god.y - last.y);
    last = { x: god.x, y: god.y };
    assert.ok(god.x >= god.radius - 1 && god.x <= width - god.radius + 1);
    assert.ok(god.y >= top + god.radius - 1 && god.y <= height - god.radius + 1);
  }
  assert.ok(travelled > width, `the god travelled ${Math.round(travelled)} units`);
  assert.ok(chatOf(battle).reduce((sum, f) => sum + f.health, 0) < health, 'it ran fighters over');
});

test('Vortex: whirlwinds each catch a handful of fighters, spin them and carry them off', (t) => {
  // One cast is followed to its end here, so the next cast is pushed far away.
  const interval = config.skills.intervalMs;
  config.skills.intervalMs = [60_000, 60_000];
  t.after(() => {
    config.skills.intervalMs = interval;
  });
  const battle = godBattle(['vortex'], 30);
  const warn = until(battle, 'warn', 'vortex');
  const { size, durationMs, maxWhirlwinds } = config.skills.vortex;
  assert.ok(warn.g!.length >= 2 && warn.g!.length <= maxWhirlwinds, `${warn.g!.length} whirlwinds`);
  const caughtOnce = new Set(warn.g!.flat());
  assert.equal(caughtOnce.size, warn.g!.flat().length, 'nobody is in two whirlwinds');
  for (const group of warn.g!) assert.ok(group.length >= 1 && group.length <= size[1]);

  const cast = until(battle, 'cast', 'vortex');
  assert.equal(cast.g!.length, cast.d!.length);
  for (const duration of cast.d!) assert.ok(duration >= durationMs[0] && duration <= durationMs[1]);
  assert.ok(new Set(cast.d).size > 1, 'the whirlwinds do not all last the same time');

  const groups = cast.g!.map((group) => group.map((i) => battle.fighters[i]!));
  const flags = battle.frame();
  for (const index of cast.g!.flat()) assert.ok(flags[index]![3] & FLAG.spinning);
  const free = chatOf(battle).filter((f) => f.alive && !f.spinning);
  assert.ok(free.length > 0, 'not everyone is caught');

  // While caught, a group rides one ring around a common center that slowly wanders.
  const center = (group: typeof groups[0]) => ({
    x: group.reduce((sum, f) => sum + f.x, 0) / group.length,
    y: group.reduce((sum, f) => sum + f.y, 0) / group.length,
  });
  const shortest = Math.min(...cast.d!);
  const first = groups.map(center);
  const startAngles = groups.map((group, n) => Math.atan2(group[0]!.y - first[n]!.y, group[0]!.x - first[n]!.x));
  const damage = groups.map((group) => group.reduce((sum, f) => sum + f.damageDealt, 0));
  const steps = Math.floor(shortest / STEP_MS) - 2;
  for (let i = 0; i < steps; i++) battle.step();
  groups.forEach((group, n) => {
    const living = group.filter((f) => f.alive);
    if (living.length !== group.length || group.length < 3) return;
    const now = center(group);
    const radii = group.map((f) => Math.hypot(f.x - now.x, f.y - now.y));
    assert.ok(Math.max(...radii) - Math.min(...radii) < 2, 'all at the same distance from the center');
    assert.ok(Math.hypot(now.x - first[n]!.x, now.y - first[n]!.y) > 20, 'the whirlwind has wandered');
    const angle = Math.atan2(group[0]!.y - now.y, group[0]!.x - now.x);
    assert.ok(Math.abs(angle - startAngles[n]!) > 0.1, 'and turned');
    assert.equal(group.reduce((sum, f) => sum + f.damageDealt, 0), damage[n], 'caught fighters cannot strike');
  });

  // Each whirlwind lets go at its own time; afterwards everyone fights again.
  const released = (group: typeof groups[0]) => group.every((f) => !f.spinning);
  const order = cast.d!.map((duration, n) => ({ duration, n })).sort((a, b) => a.duration - b.duration);
  for (let i = 0; i < 6; i++) battle.step();
  assert.ok(released(groups[order[0]!.n]!), 'the shortest has blown out');
  assert.ok(!released(groups[order.at(-1)!.n]!) || order.at(-1)!.duration - shortest < 400, 'the longest still turns');
  for (let i = 0; i < (durationMs[1] - shortest) / STEP_MS + 4; i++) battle.step();
  assert.ok(groups.every(released));
  assert.ok(battle.frame().every((f) => (f[3] & FLAG.spinning) === 0));
});

test('Smite strikes the three chatters who dealt the most damage', () => {
  const battle = godBattle(['smite'], 15);
  const warn = until(battle, 'warn', 'smite');
  const ranked = chatOf(battle)
    .filter((f) => f.alive)
    .sort((a, b) => b.damageDealt - a.damageDealt)
    .slice(0, 3)
    .map((f) => battle.fighters.indexOf(f));
  assert.deepEqual(warn.t, ranked);
  assert.ok(ranked.every((i) => battle.fighters[i]!.damageDealt > 0));

  const health = ranked.map((i) => battle.fighters[i]!.health);
  const cast = until(battle, 'cast', 'smite', 30);
  for (const index of cast.t!) {
    const fighter = battle.fighters[index]!;
    const before = health[ranked.indexOf(index)]!;
    assert.ok(fighter.health <= Math.max(0, before - config.skills.smite.damage), 'struck by lightning');
  }
  assert.ok(cast.t!.length >= 1);
});

test('Divine Shield keeps the god unhurt for its duration', () => {
  const battle = godBattle(['shield'], 20);
  until(battle, 'cast', 'shield');
  const god = battle.fighters[0]!;
  const health = god.health;
  const steps = config.skills.shield.durationMs / STEP_MS - 2;
  for (let i = 0; i < steps; i++) {
    battle.step();
    assert.equal(god.health, health);
    assert.ok(battle.frame()[0]![3] & FLAG.shielded);
  }
  for (let i = 0; i < 40; i++) battle.step();
  assert.ok(god.health < health, 'the shield has run out');
  assert.equal(battle.frame()[0]![3] & FLAG.shielded, 0);
});

test('Minions wait off the field, join when summoned, and fall with the god', () => {
  const { count, casts } = config.skills.minions;
  const battle = godBattle(['minions'], 12);
  const minions = battle.fighters.filter((f) => f.minion);
  assert.equal(minions.length, count * casts);
  assert.ok(minions.every((m) => !m.alive && !m.spawned));
  assert.ok(battle.frame().slice(13).every((f) => f[2] === 0), 'the overlay sees them as absent');

  const cast = until(battle, 'cast', 'minions');
  assert.equal(cast.t!.length, count);
  const summoned = cast.t!.map((i) => battle.fighters[i]!);
  const god = battle.fighters[0]!;
  for (const minion of summoned) {
    assert.ok(minion.alive && minion.spawned);
    assert.equal(minion.team, god.team);
    assert.ok(Math.hypot(minion.x - god.x, minion.y - god.y) < god.radius + 4 * minion.radius);
  }

  // Leave the god with almost no health, so the next blow fells it.
  god.health = 1;
  const result = battle.run();
  assert.equal(result.winner, 'chat');
  assert.ok(battle.fighters.filter((f) => f.minion).every((m) => !m.alive), 'no minion outlives the god');
  assert.ok(result.fighters.every((f) => !f.id.includes('#')), 'minions are not in the statistics');
  const godSide = result.sides.find((s) => s.id === 'god')!;
  assert.ok(godSide.fighters >= 1 + count && godSide.fighters <= 1 + count * casts, 'only summoned minions count');
});

test('Enrage sets in once, below 30% health, and makes the god faster and stronger', () => {
  const battle = godBattle(['enrage'], 20);
  const god = battle.fighters[0]!;
  for (let i = 0; i < 120; i++) {
    battle.step();
    assert.deepEqual(battle.events, [], 'nothing happens while the god is healthy');
  }
  assert.equal(god.enraged, false);

  // Bring the god just above the threshold; the blows of the next steps take it below.
  god.health = god.maxHealth * config.skills.enrage.below + 5;
  let events = 0;
  for (let i = 0; i < 200 && !battle.finished; i++) {
    battle.step();
    for (const event of battle.events) {
      assert.deepEqual([event.k, event.s], ['cast', 'enrage'], 'enrage is never announced, it sets in');
      assert.ok(god.health / god.maxHealth <= config.skills.enrage.below);
      events++;
    }
  }
  assert.equal(events, 1, 'it sets in exactly once');
  assert.equal(god.enraged, true);
  assert.ok(battle.frame()[0]![3] & FLAG.enraged);
});

test('the health factor averages the cast skills and multiplies Enrage on top', () => {
  const f = (skill: SkillId) => config.skills[skill].healthFactor;
  assert.equal(skillHealthFactor([]), 1);
  assert.equal(skillHealthFactor(['leap']), f('leap'));
  assert.ok(Math.abs(skillHealthFactor(['leap', 'shield']) - Math.sqrt(f('leap') * f('shield'))) < 1e-9);
  assert.ok(Math.abs(skillHealthFactor(['enrage']) - f('enrage')) < 1e-9);
  assert.ok(Math.abs(skillHealthFactor(['leap', 'enrage']) - f('leap') * f('enrage')) < 1e-9);
  const all = skillHealthFactor(ALL);
  assert.ok(all > 0.6 && all < 0.9, `all eight give ${all}`);
});

test('Shockwave hurls the five nearest fighters across the arena, bouncing off the walls', () => {
  const battle = godBattle(['shockwave'], 20);
  const cast = until(battle, 'cast', 'shockwave');
  const god = battle.fighters[0]!;
  const launched = cast.t!.map((i) => battle.fighters[i]!);
  assert.ok(launched.length >= 1 && launched.length <= config.skills.shockwave.launchCount);
  for (const fighter of launched) assert.ok(fighter.flight, 'in the air');

  // The others nearby were only pushed back (a short throw of their own) and slowed.
  const grounded = chatOf(battle).filter((f) => f.alive && !launched.includes(f) && f.slowUntil > battle.timeMs);
  assert.ok(grounded.length > 0, 'others were only pushed back and slowed');

  const { width, height, top } = config.battle.arena;
  const start = launched.map((f) => ({ x: f.x, y: f.y }));
  const travelled = launched.map(() => 0);
  const flags = battle.frame();
  for (const index of cast.t!) assert.ok(flags[index]![3] & FLAG.flying);
  const steps = config.skills.shockwave.launchMs / STEP_MS;
  /** How far the first hurled fighter got in each step: it slows down. */
  const perStep: number[] = [];
  for (let i = 0; i < steps; i++) {
    const before = launched.map((f) => ({ x: f.x, y: f.y }));
    battle.step();
    launched.forEach((fighter, n) => {
      const moved = Math.hypot(fighter.x - before[n]!.x, fighter.y - before[n]!.y);
      if (n === 0) perStep.push(moved);
      travelled[n]! += moved;
      assert.ok(fighter.x >= fighter.radius - 1 && fighter.x <= width - fighter.radius + 1);
      assert.ok(fighter.y >= top + fighter.radius - 1 && fighter.y <= height - fighter.radius + 1);
    });
  }
  launched.forEach((fighter, n) => {
    if (!fighter.alive) return;
    assert.equal(fighter.flight, null, 'landed');
    // As far as at launch speed for the whole flight; a bounce turns it around without slowing it,
    // so in a small arena it may land near where it took off.
    assert.ok(travelled[n]! > 1_500, `flew ${Math.round(travelled[n]!)} units`);
  });
  // Fast at first, slow at the end: it lands softly.
  assert.ok(perStep[0]! > 4 * perStep[perStep.length - 1]!, `from ${perStep[0]!.toFixed(0)} to ${perStep.at(-1)!.toFixed(0)} units a step`);
  assert.ok(god.alive);
});

test('Smite leaves its targets scorched for a few seconds', () => {
  const battle = godBattle(['smite'], 15);
  const cast = until(battle, 'cast', 'smite');
  const struck = cast.t!.filter((i) => battle.fighters[i]!.alive);
  for (const index of struck) assert.ok(battle.frame()[index]![3] & FLAG.scorched);
  for (let i = 0; i < config.skills.smite.scorchMs / STEP_MS + 2; i++) battle.step();
  for (const index of struck) assert.equal(battle.frame()[index]![3] & FLAG.scorched, 0, 'the marks fade');
});

test('an enraged god grows', () => {
  const battle = godBattle(['enrage'], 20);
  const god = battle.fighters[0]!;
  for (let i = 0; i < 120; i++) battle.step();
  const radius = god.radius;
  god.health = god.maxHealth * config.skills.enrage.below + 5;
  until(battle, 'cast', 'enrage', 200);
  assert.ok(Math.abs(god.radius - radius * config.skills.enrage.grow) < 1e-9);
});

// --- The god holds the middle; nothing leaves the screen ------------------------

const ARENA = config.battle.arena;
const MIDDLE = { x: ARENA.width / 2, y: (ARENA.top + ARENA.height - ARENA.margin) / 2 };
const fromMiddle = (f: { x: number; y: number }) => Math.hypot(f.x - MIDDLE.x, f.y - MIDDLE.y);

/** Like `godBattle`, but the god holds the middle, as it does in the real god events. */
function centerGodBattle(skills: SkillId[], chatters = 40, seed = 1, godHealth = 1_000_000): Battle {
  const radius = radiusFor(chatters + 1);
  const fighters: FighterSpec[] = [
    {
      id: 'god',
      name: 'God',
      color: null,
      side: 'god',
      level: 0,
      health: godHealth,
      damage: config.god.damage,
      radius: radius * config.god.radiusFactor,
      splashRadius: radius * config.god.splashFactor,
      speed: config.god.speed,
      weight: config.god.weight,
      skills,
      holdsCenter: true,
    },
  ];
  for (let i = 0; i < chatters; i++) {
    fighters.push({ id: `c${i}`, name: `C${i}`, color: null, side: ['red', 'green', 'blue'][i % 3]!, level: 0 });
  }
  return new Battle({
    seed,
    durationMs: 90_000,
    sizeBalance: false,
    timeLimitWinner: 'god',
    sides: [
      { id: 'god', damageBonus: 0, healthBonus: 0 },
      ...['red', 'green', 'blue'].map((id) => ({ id, team: 'chat', damageBonus: 0, healthBonus: 0 })),
    ],
    fighters,
  });
}

function assertOnScreen(battle: Battle): void {
  for (const f of battle.fighters) {
    if (!f.alive) continue;
    assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
    // The god running across the screen's edge is the one exception, and only sideways.
    if (f.maneuver?.kind === 'wrap') {
      assert.ok(f.x > -3 * f.radius && f.x < ARENA.width + 3 * f.radius, `${f.id} x ${f.x} while crossing the edge`);
      continue;
    }
    assert.ok(f.x >= f.radius + ARENA.margin - 1e-6 && f.x <= ARENA.width - f.radius - ARENA.margin + 1e-6, `${f.id} x ${f.x}`);
    assert.ok(f.y >= ARENA.top + f.radius - 1e-6 && f.y <= ARENA.height - f.radius - ARENA.margin + 1e-6, `${f.id} y ${f.y}`);
  }
}

test('a god that holds the middle starts there, surrounded by chat on all sides', () => {
  const battle = centerGodBattle([], 40);
  const god = battle.fighters[0]!;
  assert.ok(fromMiddle(god) < 1e-6);
  const chat = battle.fighters.slice(1);
  // Distances relative to a 1600 units wide arena.
  const k = ARENA.width / 1_600;
  assert.ok(chat.every((f) => fromMiddle(f) > 200 * k), 'nobody starts next to the god');
  // Fighters on every side: left and right, above and below.
  assert.ok(chat.some((f) => f.x < MIDDLE.x - 300 * k) && chat.some((f) => f.x > MIDDLE.x + 300 * k));
  assert.ok(chat.some((f) => f.y < MIDDLE.y - 150 * k) && chat.some((f) => f.y > MIDDLE.y + 150 * k));
  assertOnScreen(battle);
});

test('without skills the god still moves about and strikes who comes near', () => {
  const battle = centerGodBattle([], 30);
  const god = battle.fighters[0]!;
  let moved = 0;
  let last = { x: god.x, y: god.y };
  for (let i = 0; i < 1_200 && !battle.finished; i++) {
    battle.step();
    // A jump across the screen's edge is not distance covered.
    if (Math.abs(god.x - last.x) < 500) moved += Math.hypot(god.x - last.x, god.y - last.y);
    last = { x: god.x, y: god.y };
  }
  // Its drift, its dashes and blinks: it never stands still.
  assert.ok(moved > 1_500, `it moved ${Math.round(moved)} units`);
  assert.ok(god.damageDealt > 0, 'and it fights');
});

test('with all skills the god keeps coming back to the middle, and nothing ever leaves the screen', () => {
  let crossed = 0;
  for (const seed of [1, 2, 3]) {
    const battle = centerGodBattle(ALL, 60, seed);
    const god = battle.fighters[0]!;
    let steps = 0;
    let near = 0;
    assertOnScreen(battle);
    while (!battle.finished && steps < 1_800) {
      battle.step();
      steps++;
      assertOnScreen(battle);
      if (fromMiddle(god) <= 250) near++;
      if (god.maneuver?.wrapped) crossed++;
    }
    assert.ok(steps > 100, `seed ${seed}: the fight lasted ${steps} steps`);
    assert.ok(near / steps > 0.6, `seed ${seed}: near the middle ${Math.round((near / steps) * 100)}% of the time`);
  }
  assert.ok(crossed > 0, 'the god crossed the screen\'s edge in at least one fight');
});

test('Rampage ends where it began: back in the middle', () => {
  const battle = centerGodBattle(['rampage'], 40);
  const god = battle.fighters[0]!;
  until(battle, 'cast', 'rampage');
  let farthest = 0;
  let arrivedAt = -1;
  const steps = config.skills.rampage.maxMs / STEP_MS + 2;
  for (let i = 0; i < steps; i++) {
    battle.step();
    farthest = Math.max(farthest, fromMiddle(god));
    // The dash ends on the middle; in the same step the god takes up its drift again.
    if (arrivedAt < 0 && farthest > 300 && fromMiddle(god) <= config.god.wander + 10) arrivedAt = i;
  }
  assert.ok(farthest > 300, `it dashed ${Math.round(farthest)} units out`);
  assert.ok(arrivedAt > 0, 'it came back to the middle');
  assert.ok(arrivedAt * STEP_MS < config.skills.rampage.maxMs, 'by itself, not because the skill timed out');
  // Afterwards the god's own moves (dash, blink, crossing the edge) take it on again.
});

test('Leap lands in the middle part of the arena, exactly where it was announced', () => {
  for (const seed of [1, 2, 3, 4]) {
    const battle = centerGodBattle(['leap'], 40, seed);
    const god = battle.fighters[0]!;
    const warn = until(battle, 'warn', 'leap');
    const cast = until(battle, 'cast', 'leap', 30);
    assert.deepEqual([cast.x, cast.y], [warn.x, warn.y], 'the shadow showed the landing spot');
    // It lands on the spot; in the same step it starts drifting back toward the middle.
    assert.ok(Math.hypot(god.x - warn.x, god.y - warn.y) < 10);
    const playable = ARENA.height - ARENA.margin - ARENA.top;
    assert.ok(warn.x >= ARENA.width * 0.22 - 1 && warn.x <= ARENA.width * 0.78 + 1);
    assert.ok(warn.y >= ARENA.top + playable * 0.25 - 1 && warn.y <= ARENA.top + playable * 0.75 + 1);
  }
});

test('Smite leaves burning ground that hurts whoever stands in it, until it burns out', (t) => {
  // One strike is followed to the end of its fire, so the next cast is pushed far away.
  const interval = config.skills.intervalMs;
  config.skills.intervalMs = [60_000, 60_000];
  t.after(() => {
    config.skills.intervalMs = interval;
  });
  const { fireMs, fireDamage, fireTickMs, fireRadiusFactor } = config.skills.smite;
  const battle = godBattle(['smite'], 15);
  const god = battle.fighters[0]!;
  const cast = until(battle, 'cast', 'smite');
  assert.equal(cast.r, Math.round(radiusFor(16) * fireRadiusFactor));
  assert.deepEqual(cast.d, cast.t!.map(() => fireMs));

  // The fire is where the struck fighter stood. Stand someone else in it; the god's own blows are switched off.
  const spot = { x: battle.fighters[cast.t![0]!]!.x, y: battle.fighters[cast.t![0]!]!.y };
  god.damage = 0;
  const victim = chatOf(battle).find((f) => f.alive && !cast.t!.includes(battle.fighters.indexOf(f)) && f.health > 90)!;
  const outside = chatOf(battle).find((f) => f.alive && f !== victim && Math.hypot(f.x - spot.x, f.y - spot.y) > cast.r! + 100);
  const start = victim.health;
  const outsideStart = outside?.health;
  for (let i = 0; i < fireMs / STEP_MS; i++) {
    victim.x = spot.x;
    victim.y = spot.y;
    battle.step();
  }
  const ticks = fireMs / fireTickMs;
  const lost = start - victim.health;
  assert.ok(lost >= (ticks - 1) * fireDamage && lost <= ticks * fireDamage, `the fire took ${lost} health`);
  if (outside && outside.alive && Math.hypot(outside.x - spot.x, outside.y - spot.y) > cast.r!) {
    assert.equal(outside.health, outsideStart, 'a fighter outside the fire is unharmed');
  }

  // Burned out: standing there no longer hurts.
  const after = victim.health;
  for (let i = 0; i < 40; i++) {
    victim.x = spot.x;
    victim.y = spot.y;
    battle.step();
  }
  assert.equal(victim.health, after);
});

test('with the map banner on, nothing in a god fight ever reaches its strip', () => {
  // The banner at the bottom takes this strip; the battle gets the arena above it.
  const full = config.battle.arena;
  const arena = { ...full, height: full.height - config.battle.bannerHeight };
  for (let seed = 1; seed <= 4; seed++) {
    const battle = godBattle(ALL, 30, seed, 3000, arena);
    let lowest = 0;
    for (let i = 0; i < 1200 && !battle.finished; i++) {
      battle.step();
      for (const f of battle.fighters) if (f.alive) lowest = Math.max(lowest, f.y + f.radius);
    }
    assert.ok(lowest <= arena.height, `seed ${seed}: a fighter reached ${lowest.toFixed(1)}, the banner starts at ${arena.height}`);
  }
});

test('between skills the god dashes, blinks and runs across the edge, even with every skill off', () => {
  const seen = new Set<string>();
  for (const seed of [1, 2, 3]) {
    const battle = centerGodBattle([], 40, seed);
    const god = battle.fighters[0]!;
    for (let i = 0; i < 30_000 / STEP_MS && !battle.finished; i++) {
      battle.step();
      assertOnScreen(battle);
      for (const e of battle.events) {
        if (e.k !== 'fx' || e.i !== 0 || !e.fx) continue;
        seen.add(e.fx);
        // A blink is a jump: the overlay shows the god at its new spot at once.
        if (e.fx === 'blink') assert.ok(battle.frame()[0]![3] & FLAG.jumped);
      }
      if (god.maneuver?.wrapped) seen.add('crossed');
    }
  }
  for (const move of ['dash', 'blink', 'wrap', 'crossed']) assert.ok(seen.has(move), `no ${move} in three fights`);
});
