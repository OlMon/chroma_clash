import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../../src/config.ts';
import { Brawl, BRAWL_STEP, shapeAt, type BrawlEvent, type BrawlWho } from '../../src/game/brawl.ts';
import { createRng } from '../../src/util/rng.ts';

const B = config.brawl;
const chatter = (n: number): BrawlWho => ({ id: `u${n}`, name: `Chatter${n}`, color: '#FF0000' });
const streamer: BrawlWho = { id: 'streamer', name: 'TheStreamer', color: '#9146FF' };

/** Runs a brawl for `seconds` with a chat of 30 that writes `perSecond` messages; returns every event. */
function run(brawl: Brawl, seconds: number, perSecond = 1, seed = 5, each?: (events: BrawlEvent[]) => void): BrawlEvent[] {
  const rng = createRng(seed);
  const all: BrawlEvent[] = [];
  const end = brawl.t + seconds;
  while (brawl.t < end) {
    if (rng() < perSecond * BRAWL_STEP) brawl.write(chatter(Math.floor(rng() * 30)));
    brawl.step();
    const events = brawl.takeEvents();
    each?.(events);
    all.push(...events);
  }
  return all;
}

test('chatters who write fill the field one after another, up to its size, and nobody twice', () => {
  const brawl = new Brawl({ seed: 1, size: 6 });
  for (let i = 0; i < 9; i++) brawl.write(chatter(i));
  brawl.write(chatter(0));
  assert.equal(brawl.queue.length, 9, 'a chatter waiting already is not queued again');
  run(brawl, 0.2, 0);
  assert.equal(brawl.fighters.length, 1, 'they drop in one at a time');
  run(brawl, 4, 0);
  assert.equal(brawl.fighters.length, 6);
  assert.equal(brawl.queue.length, 3, 'the rest wait for a place');
  brawl.write(chatter(1));
  assert.equal(brawl.queue.length, 3, 'a chatter on the field is not queued');
  assert.equal(new Brawl({ seed: 1, size: 99 }).size, B.maxFighters);
  assert.equal(new Brawl({ seed: 1, size: 1 }).size, B.minFighters);
});

test('the same seed and the same chat play the same brawl', () => {
  const a = run(new Brawl({ seed: 9 }), 30);
  const b = run(new Brawl({ seed: 9 }), 30);
  assert.deepEqual(a, b);
  assert.notDeepEqual(run(new Brawl({ seed: 10 }), 30), a);
});

test('fighters hop, hit and fall, every hit takes a bite, and the fallen make room for the next', () => {
  const brawl = new Brawl({ seed: 3, size: 8 });
  const events = run(brawl, 120);
  const hits = events.filter((e) => e.k === 'hit');
  const kos = events.filter((e) => e.k === 'ko');
  assert.ok(events.some((e) => e.k === 'land'), 'they land after hops');
  assert.ok(hits.length > 50, `many hits (${hits.length})`);
  assert.ok(hits.every((e) => e.k === 'hit' && e.bite !== null && e.bite.d > 0), 'each a bite');
  assert.ok(kos.length >= 8, `fighters fall (${kos.length})`);
  assert.ok(brawl.fighters.filter((f) => f.role === 'chatter').length <= 8);
  assert.ok(brawl.fighters.length >= 6, 'and the field fills up again');
  // A bitten body is smaller where it was bitten, and never less than 30 % of its radius.
  const bitten = brawl.fighters.find((f) => f.bites.length > 0);
  if (bitten) {
    const b = bitten.bites[0]!;
    assert.ok(shapeAt(bitten.bites, b.a) < 1);
    assert.ok(shapeAt(bitten.bites, b.a) >= 0.3);
  }
});

test('the streamer joins as a fighter even on a full field, but only once', () => {
  const brawl = new Brawl({ seed: 4, size: 5 });
  for (let i = 0; i < 5; i++) brawl.write(chatter(i));
  run(brawl, 4, 0);
  assert.equal(brawl.join(streamer, 'streamer'), true);
  assert.equal(brawl.streamer(), 'streamer');
  assert.equal(brawl.fighters.length, 6);
  assert.equal(brawl.join(streamer, 'god'), false, 'not twice, in any form');
  assert.equal(brawl.god, null);
});

test('the god lands with a shockwave that throws everyone up, chat goes for it, and its fall counts the toll', () => {
  const brawl = new Brawl({ seed: 6, size: 8 });
  for (let i = 0; i < 8; i++) brawl.write(chatter(i));
  run(brawl, 6, 0);
  assert.equal(brawl.join(streamer, 'god'), true);
  const god = brawl.fighters.find((f) => f.role === 'god')!;
  assert.equal(god.r, B.radius * B.god.radius);
  assert.equal(god.maxHp, B.god.healthPerFighter * 8);
  let thrown = false;
  const events = run(brawl, 4, 0, 5, (step) => {
    if (step.some((e) => e.k === 'slam' && e.r >= brawl.width)) {
      thrown = brawl.fighters.filter((f) => f.role === 'chatter').every((f) => f.vy < 0);
    }
  });
  assert.ok(events.some((e) => e.k === 'slam' && e.r >= brawl.width), 'it lands with a shockwave over the whole field');
  assert.ok(thrown, 'and every chatter flies up');

  const fight = run(brawl, 400, 1.5, 7);
  const fall = fight.find((e) => e.k === 'godfall');
  assert.ok(fall && fall.k === 'godfall', 'the god falls in the end');
  const before = fight.slice(0, fight.indexOf(fall));
  const hits = before.filter((e): e is Extract<BrawlEvent, { k: 'hit' }> => e.k === 'hit');
  const onGod = hits.filter((e) => e.i === god.id).length;
  const friendly = hits.filter((e) => e.i !== god.id && e.by !== god.id && e.by !== 0).length;
  assert.ok(onGod > friendly, `chat goes for the god (${onGod} hits on it, ${friendly} among chatters)`);
  assert.ok(friendly > 0, 'but their blows still hit each other');
  const fallen = [...events, ...before].filter((e) => e.k === 'ko' && e.i !== god.id).length;
  assert.equal(fall.toll, fallen, 'the toll is everyone who fell while the god stood');
  assert.equal(brawl.god, null);
  assert.equal(brawl.streamer(), null);
});

test('twists come and go, and the platforms change now and then', () => {
  const brawl = new Brawl({ seed: 2 });
  const events = run(brawl, B.layoutEvery + 1, 0.5);
  const twists = events.filter((e) => e.k === 'twist');
  assert.ok(twists.length >= 2);
  assert.notEqual(twists[0]!.k === 'twist' && twists[0]!.twist, null);
  assert.equal(twists[1]!.k === 'twist' && twists[1]!.twist, null, 'a twist ends again');
  assert.equal(events.filter((e) => e.k === 'layout').length, 1);
});
