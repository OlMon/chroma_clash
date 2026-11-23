import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.ts';
import { estimatedRuntimes } from '../../src/server/runtimes.ts';

test('every event has a runtime range, shortest first, of at least a minute (a duel: half a minute)', () => {
  for (const [kind, [shortest, longest]] of Object.entries(estimatedRuntimes())) {
    assert.ok(shortest >= (kind === 'duel' ? 30_000 : 60_000), `${kind} shortest ${shortest}`);
    assert.ok(shortest <= longest, `${kind} ${shortest} > ${longest}`);
  }
});

test('a War adds up its battles with their announcement, result and outcome, and the summary', () => {
  const { war, battle, pace } = config;
  const around = war.announceMs + war.resultHoldMs + war.outcomeMs;
  const battles = config.guilds.list.length;
  assert.deepEqual(estimatedRuntimes().war, [
    battles * (around + pace.shortestFightMs) + war.summaryHoldMs,
    battles * (around + battle.durationMs) + war.summaryHoldMs,
  ]);
});

test('the runtimes follow tuned values', () => {
  const before = estimatedRuntimes().guildClash;
  const countdown = config.draft.countdownMs;
  config.draft.countdownMs = countdown + 60_000;
  try {
    const after = estimatedRuntimes().guildClash;
    assert.deepEqual(after, [before[0] + 60_000, before[1] + 60_000]);
  } finally {
    config.draft.countdownMs = countdown;
  }
});
