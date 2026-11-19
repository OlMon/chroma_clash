import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeChannel, readAppSettings, writeAppSettings } from '../../src/app-settings.ts';

test('a channel name is accepted as typed, with #, or as a Twitch address', () => {
  assert.equal(normalizeChannel('SomeStreamer'), 'somestreamer');
  assert.equal(normalizeChannel('  #some_streamer42 '), 'some_streamer42');
  assert.equal(normalizeChannel('https://www.twitch.tv/SomeStreamer/videos'), 'somestreamer');
  assert.equal(normalizeChannel('twitch.tv'), null);
  assert.equal(normalizeChannel('ab'), null);
  assert.equal(normalizeChannel('two words'), null);
  assert.equal(normalizeChannel(42), null);
});

test('the saved channel survives a restart, and a broken file means none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroma-settings-'));
  try {
    const file = join(dir, 'settings.json');
    assert.deepEqual(readAppSettings(file), {});
    writeAppSettings(file, { channel: 'somestreamer' });
    assert.deepEqual(readAppSettings(file), { channel: 'somestreamer' });
    writeFileSync(file, '{ not json');
    assert.deepEqual(readAppSettings(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
