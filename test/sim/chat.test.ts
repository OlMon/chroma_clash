import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimulatedChat } from '../../src/sim/chat.ts';
import { createRng, hashString } from '../../src/util/rng.ts';

const START = 1_700_000_000_000;
const HOUR = 3_600_000;

function make(seed: number, chatterCount = 60) {
  return new SimulatedChat({ seed, channel: '#SimChannel', startAt: START, chatterCount });
}

test('the same seed gives the same chat, a different seed a different one', () => {
  const a = make(1).advanceTo(START + HOUR);
  const b = make(1).advanceTo(START + HOUR);
  const c = make(2).advanceTo(START + HOUR);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.length > 100);
});

test('slicing time differently does not change the result', () => {
  const whole = make(3).advanceTo(START + HOUR);
  const sliced = make(3);
  const parts = [];
  for (let t = START; t <= START + HOUR; t += 7_000) parts.push(...sliced.advanceTo(t));
  parts.push(...sliced.advanceTo(START + HOUR));
  assert.deepEqual(parts, whole);
});

test('events are ordered, inside the requested range, and never repeated', () => {
  const chat = make(4);
  const first = chat.advanceTo(START + HOUR);
  for (let i = 1; i < first.length; i++) {
    assert.ok(first[i]!.sentAt >= first[i - 1]!.sentAt);
  }
  assert.ok(first.every((e) => e.sentAt > START && e.sentAt <= START + HOUR));
  const second = chat.advanceTo(START + 2 * HOUR);
  assert.ok(second.every((e) => e.sentAt > START + HOUR));
  assert.deepEqual(chat.advanceTo(START + 2 * HOUR), []);
});

test('includes a broadcaster, a bot and moderators with matching flags', () => {
  const chat = make(5);
  const roles = chat.chatters.map((c) => c.role);
  assert.equal(roles.filter((r) => r === 'broadcaster').length, 1);
  assert.equal(roles.filter((r) => r === 'bot').length, 1);
  assert.equal(roles.filter((r) => r === 'moderator').length, 2);
  // 60 chatters (2 of them moderators) plus the broadcaster and one bot.
  assert.equal(chat.chatters.length, 62);
  assert.equal(chat.channel, 'simchannel');

  const events = chat.advanceTo(START + 24 * HOUR);
  const broadcaster = chat.chatters.find((c) => c.role === 'broadcaster')!;
  const fromBroadcaster = events.filter((e) => e.userId === broadcaster.userId);
  assert.ok(fromBroadcaster.length > 0);
  assert.ok(fromBroadcaster.every((e) => e.isBroadcaster && e.login === 'simchannel'));
  assert.ok(events.some((e) => e.isModerator && !e.isBroadcaster));
});

test('colors are valid hex or null, in roughly the configured shares', () => {
  const chat = make(6, 2000);
  const ids = new Set(chat.chatters.map((c) => c.userId));
  assert.equal(ids.size, chat.chatters.length);
  for (const chatter of chat.chatters) {
    if (chatter.color !== null) assert.match(chatter.color, /^#[0-9A-F]{6}$/);
  }
  const share = chat.chatters.filter((c) => c.color === null).length / chat.chatters.length;
  assert.ok(share > 0.25 && share < 0.35, `no-color share was ${share}`);
});

test('activity is skewed: a few chatters write most of the messages', () => {
  const chat = make(7, 200);
  const events = chat.advanceTo(START + 3 * HOUR);
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.userId, (counts.get(e.userId) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const top = sorted.slice(0, Math.ceil(sorted.length / 5)).reduce((a, b) => a + b, 0);
  assert.ok(top / events.length > 0.5, `top fifth wrote ${top / events.length}`);
});

test('rng helpers are deterministic', () => {
  const a = createRng(42);
  const b = createRng(42);
  const values = [a(), a(), a()];
  assert.deepEqual(values, [b(), b(), b()]);
  assert.ok(values.every((v) => v >= 0 && v < 1));
  assert.equal(hashString('1337'), hashString('1337'));
  assert.notEqual(hashString('1337'), hashString('1338'));
});
