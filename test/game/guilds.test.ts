import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignGuild,
  guildForHue,
  hexToHsl,
  usableHue,
} from '../../src/game/guilds.ts';

test('converts hex colors to HSL', () => {
  assert.deepEqual(hexToHsl('#FF0000'), { h: 0, s: 1, l: 0.5 });
  assert.deepEqual(hexToHsl('#00FF00'), { h: 120, s: 1, l: 0.5 });
  assert.deepEqual(hexToHsl('#0000ff'), { h: 240, s: 1, l: 0.5 });
  const dodger = hexToHsl('#1E90FF')!;
  assert.ok(Math.abs(dodger.h - 209.6) < 0.1);
  assert.ok(Math.abs(hexToHsl('#FF69B4')!.h - 330) < 0.1, 'negative hue wraps around');
  assert.equal(hexToHsl('#808080')!.s, 0);
  assert.equal(hexToHsl('red'), null);
  assert.equal(hexToHsl('#FFF'), null);
});

test('buckets hues into guilds with half-open ranges', () => {
  assert.equal(guildForHue(0), 'red');
  assert.equal(guildForHue(59.9), 'red');
  assert.equal(guildForHue(60), 'green');
  assert.equal(guildForHue(179.9), 'green');
  assert.equal(guildForHue(180), 'blue');
  assert.equal(guildForHue(299.9), 'blue');
  assert.equal(guildForHue(300), 'red');
  assert.equal(guildForHue(359.9), 'red');
});

test('assigns guilds from name colors, including the exact boundaries', () => {
  assert.equal(assignGuild('#FF0000', '1'), 'red');
  assert.equal(assignGuild('#008000', '1'), 'green');
  assert.equal(assignGuild('#1E90FF', '1'), 'blue');
  assert.equal(assignGuild('#FFFF00', '1'), 'green', 'hue 60');
  assert.equal(assignGuild('#00FFFF', '1'), 'blue', 'hue 180');
  assert.equal(assignGuild('#FF00FF', '1'), 'red', 'hue 300');
});

test('treats missing, grey, very dark and very light colors as having no hue', () => {
  assert.equal(usableHue(null), null);
  assert.equal(usableHue(''), null);
  assert.equal(usableHue('#808080'), null, 'grey');
  assert.equal(usableHue('#857B7B'), null, 'saturation below 0.15');
  assert.equal(usableHue('#1A0000'), null, 'lightness below 0.1');
  assert.equal(usableHue('#FFEEEE'), null, 'lightness above 0.9');
  assert.equal(usableHue('#B22222'), 0);
});

test('falls back to a stable and roughly even hash of the user id', () => {
  assert.equal(assignGuild(null, '4711'), assignGuild(null, '4711'));
  assert.equal(assignGuild(null, '4711'), assignGuild('#808080', '4711'));

  const counts = { red: 0, green: 0, blue: 0 };
  for (let id = 100_000; id < 103_000; id++) counts[assignGuild(null, String(id))]++;
  for (const [guild, count] of Object.entries(counts)) {
    assert.ok(count > 900 && count < 1100, `${guild} got ${count} of 3000`);
  }
});

test('very small channels fill the smallest guilds first', () => {
  // The color decides while its guild is among the smallest.
  assert.equal(assignGuild('#FF0000', '1', { red: 0, green: 0, blue: 0 }), 'red');
  assert.equal(assignGuild('#FF0000', '1', { red: 2, green: 2, blue: 2 }), 'red');
  assert.equal(assignGuild('#0000FF', '1', { red: 1, green: 0, blue: 0 }), 'blue');

  // Otherwise the chatter is steered to a smallest guild, stably.
  assert.equal(assignGuild('#FF0000', '1', { red: 1, green: 1, blue: 0 }), 'blue');
  const steered = assignGuild('#FF0000', '1', { red: 1, green: 0, blue: 0 });
  assert.ok(steered === 'green' || steered === 'blue');
  assert.equal(assignGuild('#FF0000', '1', { red: 1, green: 0, blue: 0 }), steered);

  // Chatters without a color are steered the same way.
  assert.equal(assignGuild(null, '4711', { red: 3, green: 2, blue: 3 }), 'green');
});

test('from 15 known chatters on, the color alone decides', () => {
  assert.equal(assignGuild('#FF0000', '1', { red: 10, green: 4, blue: 0 }), 'blue', '14 known');
  assert.equal(assignGuild('#FF0000', '1', { red: 10, green: 5, blue: 0 }), 'red', '15 known');
});

test('six red chatters in an empty channel end up two per guild', () => {
  const sizes = { red: 0, green: 0, blue: 0 };
  for (let id = 1; id <= 6; id++) sizes[assignGuild('#FF0000', String(id), sizes)]++;
  assert.deepEqual(sizes, { red: 2, green: 2, blue: 2 });
});
