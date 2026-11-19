import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../src/db/store.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';

function message(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    type: 'chat',
    channel: 'somechannel',
    userId: '42',
    login: 'alice',
    displayName: 'Alice',
    color: '#FF0000',
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text: 'hi',
    emoteIds: [],
    sentAt: 1_000,
    ...overrides,
  };
}

test('a new database has the three guilds and starts season 1 on demand', () => {
  const store = Store.open(':memory:');
  assert.deepEqual(store.guildSizes(), { red: 0, green: 0, blue: 0 });
  assert.equal(store.currentSeasonId(500), 1);
  assert.equal(store.currentSeasonId(900), 1);
  store.close();
});

test('the first message creates the user with its guild', () => {
  const store = Store.open(':memory:');
  const user = store.upsertUser(message());
  assert.ok(user);
  assert.equal(user.guild_id, 'red');
  assert.equal(user.display_name, 'Alice');
  assert.equal(user.first_seen, 1_000);
  assert.equal(user.last_seen, 1_000);
  assert.equal(user.xp, 0);
  assert.deepEqual(store.guildSizes(), { red: 1, green: 0, blue: 0 });
  store.close();
});

test('the guild is locked: a color change updates the color but not the guild', () => {
  const store = Store.open(':memory:');
  const first = store.upsertUser(message())!;
  const later = store.upsertUser(
    message({ color: '#0000FF', displayName: 'Alice_New', login: 'alice_new', sentAt: 5_000 }),
  )!;
  assert.equal(later.guild_id, 'red');
  assert.equal(later.color, '#0000FF');
  assert.equal(later.display_name, 'Alice_New');
  assert.equal(later.login, 'alice_new');
  assert.equal(later.first_seen, 1_000);
  assert.equal(later.last_seen, 5_000);
  store.close();
});

test('an out-of-order older message does not move last_seen back', () => {
  const store = Store.open(':memory:');
  store.upsertUser(message({ sentAt: 5_000 }));
  const user = store.upsertUser(message({ sentAt: 2_000 }))!;
  assert.equal(user.last_seen, 5_000);
  store.close();
});

test('chatters without a color still get a guild', () => {
  const store = Store.open(':memory:');
  const user = store.upsertUser(message({ color: null }))!;
  assert.ok(['red', 'green', 'blue'].includes(user.guild_id));
  store.close();
});

test('the broadcaster and known bots are not recorded', () => {
  const store = Store.open(':memory:');
  assert.equal(store.upsertUser(message({ isBroadcaster: true })), null);
  assert.equal(store.upsertUser(message({ userId: '7', login: 'nightbot' })), null);
  assert.equal(store.getUser('42'), null);
  assert.deepEqual(store.guildSizes(), { red: 0, green: 0, blue: 0 });
  store.close();
});

test('data survives reopening the file, and migrations are not applied twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroma-clash-'));
  try {
    const path = join(dir, 'channel.sqlite');
    const first = Store.open(path);
    first.upsertUser(message());
    first.close();

    const second = Store.open(path);
    assert.equal(second.getUser('42')?.guild_id, 'red');
    assert.equal(second.currentSeasonId(9_000), 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remembers the most recent emote; messages without emotes keep it', () => {
  const store = Store.open(':memory:');
  assert.equal(store.upsertUser(message())!.emote_id, null);
  assert.equal(store.upsertUser(message({ emoteIds: ['1902', '25'] }))!.emote_id, 'twitch:25');
  assert.equal(store.upsertUser(message({ emoteIds: [] }))!.emote_id, 'twitch:25');
  assert.equal(store.upsertUser(message({ emoteIds: ['86'] }))!.emote_id, 'twitch:86');
  // An emote worked out from all sources wins over the Twitch tag.
  assert.equal(store.upsertUser(message({ emoteIds: ['86'], emote: '7tv:01ABC' }))!.emote_id, '7tv:01ABC');
  store.close();
});
