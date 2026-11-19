import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../../src/config.ts';
import {
  adaptWindows,
  adapting,
  countWindow,
  forecast,
  freshPace,
  mishapStrength,
  priorGoal,
  retarget,
  type SeasonPace,
} from '../../src/game/season.ts';
import { rollMishaps } from '../../src/game/land.ts';

const saved = { ...config.season };
afterEach(() => Object.assign(config.season, saved));

const WINDOW = config.ticks.windowMs;
const flat = (value: number) => ({ red: value, green: value, blue: value });

/** Plays `windows` windows in which each guild's Monument grows by its `perWindow`. */
function play(pace: SeasonPace, windows: number, perWindow: { red: number; green: number; blue: number }): SeasonPace {
  let next = pace;
  for (let i = 0; i < windows; i++) {
    const n = next.windows;
    next = countWindow(next, (n + 1) * WINDOW, { red: perWindow.red * n, green: perWindow.green * n, blue: perWindow.blue * n });
  }
  return next;
}

test('before anything is measured, the goal is the expected pace times the season length', () => {
  Object.assign(config.season, { hours: 10, expectedPerHour: 2_000 });
  assert.equal(priorGoal(), 20_000);
  assert.equal(freshPace(1).goal, 20_000);
  assert.equal(freshPace(1, 5).goal, 10_000);
  assert.equal(adaptWindows(10), 36, 'adapts for the first 3 of 10 hours');
  assert.equal(adaptWindows(40), 72, 'at most 6 hours');
});

test('a window is counted once; the goal follows the chat\'s pace, then stays put', () => {
  Object.assign(config.season, { hours: 10, expectedPerHour: 2_000 });
  const start = freshPace(1);
  const once = countWindow(start, WINDOW, flat(0));
  assert.equal(once.windows, 1);
  assert.equal(countWindow(once, WINDOW, flat(50)), once, 'the same window again: nothing');
  assert.equal(countWindow(once, WINDOW / 2, flat(50)), once, 'an older one: nothing');

  // A chat twice as fast as expected (2,000 an hour is about 167 a window).
  const fast = play(start, adaptWindows(), { red: 333, green: 100, blue: 0 });
  assert.equal(adapting(fast), false);
  assert.ok(fast.goal > 36_000 && fast.goal < 44_000, `about twice the goal: ${fast.goal}`);
  const later = play(fast, 30, { red: 1000, green: 0, blue: 0 });
  assert.equal(later.goal, fast.goal, 'locked: a faster chat later does not move it');

  // A slow chat, a quarter of the pace.
  const slow = play(start, adaptWindows(), { red: 42, green: 42, blue: 42 });
  assert.ok(slow.goal > 4_000 && slow.goal < 6_000, `about a quarter: ${slow.goal}`);

  // Halfway through adapting, half way between the expected and the measured.
  const half = play(start, adaptWindows() / 2, { red: 333, green: 0, blue: 0 });
  assert.ok(half.goal > 27_000 && half.goal < 33_000, `between: ${half.goal}`);
});

test('the goal stays ahead of every Monument, and does not move away from one that reached it', () => {
  Object.assign(config.season, { hours: 10, expectedPerHour: 2_000 });
  const start = countWindow(freshPace(1), WINDOW, flat(0));
  const near = countWindow(start, 2 * WINDOW, { red: 19_990, green: 0, blue: 0 });
  assert.ok(near.goal > 19_990, 'a goal that would end the season by itself is raised');
  const reached = countWindow(start, 2 * WINDOW, { red: 20_000, green: 0, blue: 0 });
  assert.equal(reached.goal, 20_000, 'a Monument at the goal wins on the next tick');
});

test('the forecast names the guild that finishes first and the stream hours left', () => {
  Object.assign(config.season, { hours: 10, expectedPerHour: 2_000 });
  const early = forecast(freshPace(1), flat(0));
  assert.deepEqual([early.leader, early.remaining, early.played, early.adapting], [null, null, 0, true]);

  const pace = play(freshPace(1), 48, { red: 100, green: 200, blue: 50 });
  const now = { red: 4_800, green: 9_600, blue: 2_400 };
  const result = forecast(pace, now);
  assert.equal(result.leader, 'green');
  assert.equal(result.played, 4);
  assert.equal(result.adapting, false);
  // 200 a window, 12 windows an hour.
  assert.ok(Math.abs(result.remaining! - (pace.goal - 9_600) / 200 / 12) < 1e-9);
});

test('a new season length works the goal out again from the measured pace', () => {
  Object.assign(config.season, { hours: 10, expectedPerHour: 2_000 });
  const pace = play(freshPace(1), 80, { red: 200, green: 0, blue: 0 });
  const now = { red: 200 * 80, green: 0, blue: 0 };
  const longer = retarget(pace, 20, now);
  assert.equal(longer.hours, 20);
  assert.equal(adapting(longer), false, 'past the 6 hours a 20-hour season adapts for');
  // 160 more windows at 200, on top of the 16,000 there.
  assert.equal(longer.goal, 16_000 + 160 * 200);
  const shorter = retarget(pace, 4, now);
  assert.equal(shorter.goal, 17_600, 'already past 4 hours: a short finale, not an instant end');
  const young = retarget(play(freshPace(1), 3, flat(100)), 5, flat(300));
  assert.equal(young.goal, priorGoal(5), 'nothing measured yet: the expected pace');
});

test('lightning and fire start weak and reach full strength after the first stream hours', () => {
  const { startStrength, fullAfterHours } = config.mishaps.ramp;
  const at = (hours: number) => mishapStrength({ ...freshPace(1), windows: hours * 12 });
  assert.equal(at(0), startStrength);
  assert.ok(at(fullAfterHours / 2) > startStrength && at(fullAfterHours / 2) < 1);
  assert.equal(at(fullAfterHours), 1);
  assert.equal(at(fullAfterHours * 3), 1, 'capped');

  // At strength 0 no lightning or fire starts; harvests still come.
  const tiles = [{ id: '1,0', q: 1, r: 0, owner: 'red' as const, level: 5, burning: 0, developable: true }];
  for (let seed = 0; seed < 50; seed++) {
    const { events } = rollMishaps(tiles, {}, () => 0, 0);
    assert.ok(events.every((e) => e.kind === 'harvest'), `seed ${seed}`);
  }
});
