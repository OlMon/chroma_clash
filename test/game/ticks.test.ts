import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levelForXp, tickXp, windowStartOf, xpForLevel } from '../../src/game/ticks.ts';

const MIN = 60_000;

test('cuts time into five-minute windows', () => {
  assert.equal(windowStartOf(0), 0);
  assert.equal(windowStartOf(5 * MIN - 1), 0);
  assert.equal(windowStartOf(5 * MIN), 5 * MIN);
  assert.equal(windowStartOf(1_700_000_123_456), 1_700_000_100_000);
});

test('tick XP: base, capped tile bonus, and boost', () => {
  assert.equal(tickXp(0, false), 10);
  assert.equal(tickXp(3, false), 13);
  assert.equal(tickXp(6, false), 16);
  assert.equal(tickXp(15, false), 16, 'tile bonus is capped at +6');
  assert.equal(tickXp(0, true), 15);
  assert.equal(tickXp(3, true), 20, '13 * 1.5 rounded');
});

test('levels follow 50 * n^2 total XP', () => {
  assert.equal(xpForLevel(1), 50);
  assert.equal(xpForLevel(4), 800);
  assert.equal(levelForXp(0), 0);
  assert.equal(levelForXp(49), 0);
  assert.equal(levelForXp(50), 1);
  assert.equal(levelForXp(199), 1);
  assert.equal(levelForXp(200), 2);
  assert.equal(levelForXp(799), 3);
  assert.equal(levelForXp(800), 4);
  for (let level = 0; level <= 200; level++) {
    assert.equal(levelForXp(xpForLevel(level)), level);
    if (level > 0) assert.equal(levelForXp(xpForLevel(level) - 1), level - 1);
  }
});
