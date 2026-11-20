import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { Battle, HIGHLIGHTS, assignClasses, godHealth, radiusFor, type BattleEvent, type FighterSpec } from '../../src/game/battle.ts';
import { createRng } from '../../src/util/rng.ts';

/** Runs a battle to its end and collects its highlights, with the time each came. */
function highlights(battle: Battle): (BattleEvent & { at: number })[] {
  const found: (BattleEvent & { at: number })[] = [];
  while (!battle.finished) {
    battle.step();
    for (const event of battle.events) if (event.k === 'death') found.push({ ...event, at: battle.timeMs });
  }
  return found;
}

function war(seed: number, extra: Partial<FighterSpec>[] = []): Battle {
  const fighters: FighterSpec[] = [];
  for (const side of ['red', 'blue']) for (let i = 0; i < 20; i++) fighters.push({ id: `${side}${i}`, name: `${side}${i}`, color: null, side, level: 0, crown: side === 'red' && i === 0 });
  extra.forEach((spec, i) => fighters.push({ id: `x${i}`, name: `x${i}`, color: null, side: 'blue', level: 0, ...spec }));
  assignClasses(fighters, createRng(seed));
  return new Battle({ seed, toughness: 2, sides: ['red', 'blue'].map((id) => ({ id, damageBonus: 0, healthBonus: 0 })), fighters, obstacles: 'fixed' });
}

test('a battle reports its noteworthy deaths: who fell, to whom, how, and why it matters', () => {
  for (const seed of [1, 2, 3]) {
    const battle = war(seed);
    const found = highlights(battle);
    assert.ok(found.length >= 3, `seed ${seed}: ${found.length} highlights`);
    for (const event of found) {
      const victim = battle.fighters[event.i]!;
      assert.equal(victim.alive, false);
      assert.ok(HIGHLIGHTS.includes(event.h!));
      if (event.c === 'barrel' || event.c === 'trap') assert.equal(event.b, -1, 'an obstacle is nobody');
      else assert.ok(event.b! >= 0 && battle.fighters[event.b!]!.side !== victim.side, 'killed by an enemy');
      if (event.h === 'crown') assert.ok(victim.crown);
    }
    // Exactly one side lost its last fighter: the one that lost.
    const last = found.filter((e) => e.h === 'last');
    assert.equal(last.length, 1);
    assert.notEqual(battle.fighters[last[0]!.i]!.side, battle.result()!.winner);
    // Never long without a line while fighters fall (the quiet filler), give or take a step.
    for (let i = 1; i < found.length; i++) assert.ok(found[i]!.at - found[i - 1]!.at < 60_000);
  }
});

test('the first death of a battle is first blood unless something weightier explains it', () => {
  const battle = war(5);
  const first = highlights(battle)[0]!;
  assert.ok(['firstBlood', 'cause', 'crown'].includes(first.h!), first.h);
});

test("the streamer's imps and the god's minions never make a highlight; the god falling always does", () => {
  const imps = war(4, [{ imp: true }, { imp: true }, { imp: true }]);
  const found = highlights(imps);
  assert.ok(found.every((e) => !imps.fighters[e.i]!.imp));

  const crowd: FighterSpec[] = [];
  for (const side of ['red', 'green', 'blue']) for (let i = 0; i < 15; i++) crowd.push({ id: `${side}${i}`, name: `${side}${i}`, color: null, side, level: 0 });
  assignClasses(crowd, createRng(1));
  const r = radiusFor(46);
  const god: FighterSpec = {
    id: 'god', name: 'God', color: null, side: 'god', level: 0, skills: ['minions', 'smite', 'rampage'], holdsCenter: true, weight: config.god.weight,
    // Without the fight toughness, chat wins.
    health: godHealth(45), damage: config.god.damage, radius: r * config.god.radiusFactor, splashRadius: r * config.god.splashFactor, speed: config.god.speed,
  };
  const fight = new Battle({
    seed: 2, sizeBalance: false, timeLimitWinner: 'god',
    sides: [{ id: 'god', damageBonus: 0, healthBonus: 0 }, ...['red', 'green', 'blue'].map((id) => ({ id, team: 'chat', damageBonus: 0, healthBonus: 0 }))],
    fighters: [god, ...crowd],
  });
  const events = highlights(fight);
  assert.ok(events.every((e) => !fight.fighters[e.i]!.minion), 'no line for a minion');
  assert.equal(fight.result()!.winner, 'chat');
  const falls = events.filter((e) => e.h === 'godFalls');
  assert.equal(falls.length, 1);
  assert.ok(falls[0]!.b! >= 0, 'with whoever landed the blow');
  assert.ok(events.some((e) => ['smite', 'rampage', 'fire'].includes(e.c!)), "the god's skills make lines of their own");
});
