import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBadges, parseEmotes, toChatEvent } from '../../src/irc/events.ts';
import { parseLine, unescapeTagValue } from '../../src/irc/parser.ts';

const CHAT =
  '@badge-info=;badges=broadcaster/1,subscriber/12;color=#1E90FF;display-name=Olmon;emotes=;' +
  'id=abc-123;mod=0;room-id=1337;subscriber=1;tmi-sent-ts=1700000000123;turbo=0;user-id=1337;user-type= ' +
  ':olmon!olmon@olmon.tmi.twitch.tv PRIVMSG #olmon :hello world: how are you';

test('parses tags, prefix, command and params of a PRIVMSG', () => {
  const msg = parseLine(CHAT);
  assert.ok(msg);
  assert.equal(msg.command, 'PRIVMSG');
  assert.equal(msg.prefix, 'olmon!olmon@olmon.tmi.twitch.tv');
  assert.equal(msg.nick, 'olmon');
  assert.deepEqual(msg.params, ['#olmon', 'hello world: how are you']);
  assert.equal(msg.tags['color'], '#1E90FF');
  assert.equal(msg.tags['user-id'], '1337');
  assert.equal(msg.tags['badge-info'], '');
  assert.equal(msg.tags['user-type'], '');
});

test('parses a PING without prefix', () => {
  const msg = parseLine('PING :tmi.twitch.tv');
  assert.ok(msg);
  assert.equal(msg.command, 'PING');
  assert.equal(msg.prefix, null);
  assert.equal(msg.nick, null);
  assert.deepEqual(msg.params, ['tmi.twitch.tv']);
});

test('parses server lines: numeric, CAP ACK and RECONNECT', () => {
  const welcome = parseLine(':tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!');
  assert.equal(welcome?.command, '001');
  assert.equal(welcome?.nick, null);
  assert.deepEqual(welcome?.params, ['justinfan123', 'Welcome, GLHF!']);

  const ack = parseLine(':tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands');
  assert.deepEqual(ack?.params, ['*', 'ACK', 'twitch.tv/tags twitch.tv/commands']);

  const reconnect = parseLine(':tmi.twitch.tv RECONNECT');
  assert.equal(reconnect?.command, 'RECONNECT');
  assert.deepEqual(reconnect?.params, []);
});

test('strips the line ending and tolerates empty or malformed lines', () => {
  assert.equal(parseLine('PING :tmi.twitch.tv\r\n')?.params[0], 'tmi.twitch.tv');
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('@only=tags'), null);
  assert.equal(parseLine(':only.prefix'), null);
});

test('keeps an empty trailing parameter', () => {
  assert.deepEqual(parseLine(':a!a@a PRIVMSG #chan :')?.params, ['#chan', '']);
});

test('unescapes tag values', () => {
  assert.equal(unescapeTagValue('a\\sb'), 'a b');
  assert.equal(unescapeTagValue('a\\:b'), 'a;b');
  assert.equal(unescapeTagValue('a\\\\b'), 'a\\b');
  assert.equal(unescapeTagValue('a\\rb\\nc'), 'a\rb\nc');
  assert.equal(unescapeTagValue('a\\xb'), 'axb');
  assert.equal(unescapeTagValue('trailing\\'), 'trailing');
  const msg = parseLine('@display-name=Two\\sWords;flag :a!a@a PRIVMSG #c :x');
  assert.equal(msg?.tags['display-name'], 'Two Words');
  assert.equal(msg?.tags['flag'], '');
});

test('parses badges', () => {
  assert.deepEqual(parseBadges('broadcaster/1,subscriber/12'), [
    { name: 'broadcaster', version: '1' },
    { name: 'subscriber', version: '12' },
  ]);
  assert.deepEqual(parseBadges(''), []);
  assert.deepEqual(parseBadges(undefined), []);
});

test('builds a chat event from a PRIVMSG', () => {
  const event = toChatEvent(parseLine(CHAT)!, 42);
  assert.deepEqual(event, {
    type: 'chat',
    channel: 'olmon',
    userId: '1337',
    login: 'olmon',
    displayName: 'Olmon',
    color: '#1E90FF',
    badges: [
      { name: 'broadcaster', version: '1' },
      { name: 'subscriber', version: '12' },
    ],
    isBroadcaster: true,
    isModerator: false,
    text: 'hello world: how are you',
    emoteIds: [],
    lastEmoteAt: -1,
    roomId: '1337',
    sentAt: 1700000000123,
  });
});

test('handles empty color and display name, and detects moderators', () => {
  const line =
    '@badges=moderator/1;color=;display-name=;mod=1;user-id=7 ' +
    ':some_mod!some_mod@some_mod.tmi.twitch.tv PRIVMSG #olmon :!war';
  const event = toChatEvent(parseLine(line)!, 42);
  assert.ok(event);
  assert.equal(event.color, null);
  assert.equal(event.displayName, 'some_mod');
  assert.equal(event.isModerator, true);
  assert.equal(event.isBroadcaster, false);
  assert.equal(event.sentAt, 42);
});

test('rejects malformed colors and unwraps /me actions', () => {
  const line =
    '@color=red;display-name=A;user-id=9;tmi-sent-ts=5 ' +
    ':a!a@a.tmi.twitch.tv PRIVMSG #olmon :\u0001ACTION waves\u0001';
  const event = toChatEvent(parseLine(line)!, 42);
  assert.equal(event?.color, null);
  assert.equal(event?.text, 'waves');
});

test('ignores non-chat messages and messages without a user id', () => {
  assert.equal(toChatEvent(parseLine('PING :tmi.twitch.tv')!, 0), null);
  assert.equal(toChatEvent(parseLine(':a!a@a PRIVMSG #c :hi')!, 0), null);
});

test('parses the emotes tag, ordered by where each emote was last used', () => {
  assert.deepEqual(parseEmotes('25:0-4,12-16/1902:6-10'), ['1902', '25']);
  assert.deepEqual(parseEmotes('1902:6-10/25:0-4'), ['25', '1902']);
  assert.deepEqual(parseEmotes('emotesv2_abc123:3-9'), ['emotesv2_abc123']);
  assert.deepEqual(parseEmotes(''), []);
  assert.deepEqual(parseEmotes(undefined), []);
  assert.deepEqual(parseEmotes('bad id:0-1/../:0-1/25/7:x-y'), [], 'malformed entries are dropped');

  const line =
    '@color=#FF0000;display-name=A;emotes=25:0-4,12-16/1902:6-10;user-id=9 ' +
    ':a!a@a.tmi.twitch.tv PRIVMSG #olmon :Kappa Keepo Kappa';
  const event = toChatEvent(parseLine(line)!, 1)!;
  assert.deepEqual(event.emoteIds, ['1902', '25']);
  assert.equal(event.lastEmoteAt, 12, 'Kappa last starts at character 12');
});
