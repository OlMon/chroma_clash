import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EmoteImages } from '../../src/emotes/images.ts';
import { EmoteRegistry, parseEmoteSet, type EmoteEntry } from '../../src/emotes/registry.ts';
import { cdnCandidates, emoteImage, imageType, parseEmoteRef, TWITCH_GLOBALS } from '../../src/emotes/sources.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';
import { activeTheme, listThemes } from '../../src/server/themes.ts';

const ALL = { bttv: true, ffz: true, '7tv': true };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function message(text: string, extra: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    type: 'chat',
    channel: 'c',
    userId: '1',
    login: 'a',
    displayName: 'A',
    color: null,
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    text,
    emoteIds: [],
    sentAt: 0,
    ...extra,
  };
}

function entry(source: EmoteEntry['source'], id: string, code: string, animated = false): EmoteEntry {
  return { source, id, code, animated };
}

function registry(): EmoteRegistry {
  const r = new EmoteRegistry({ fetchJson: async () => null, log: () => {} });
  r.setEmotes('global', 'bttv', [entry('bttv', 'b1', 'catJAM', true), entry('bttv', 'b2', 'Clap')]);
  r.setEmotes('global', 'ffz', [entry('ffz', '9', 'ZrehplaR'), entry('ffz', '10', 'Clap')]);
  r.setEmotes('global', '7tv', [entry('7tv', 'S1', 'RainTime', true), entry('7tv', 'S2', 'Clap')]);
  r.setEmotes('channel', 'bttv', [entry('bttv', 'cb', 'catJAM')]);
  return r;
}

test('reads the answers of all three services, global and channel', () => {
  assert.deepEqual(
    parseEmoteSet('bttv', 'global', [{ id: 'x1', code: 'catJAM', animated: true }, { id: 'bad id', code: 'no' }, { code: 'noid' }]),
    [entry('bttv', 'x1', 'catJAM', true)],
  );
  assert.deepEqual(
    parseEmoteSet('bttv', 'channel', { channelEmotes: [{ id: 'c1', code: 'Own' }], sharedEmotes: [{ id: 's1', code: 'Shared', animated: true }] }),
    [entry('bttv', 'c1', 'Own'), entry('bttv', 's1', 'Shared', true)],
  );
  const ffz = {
    default_sets: [3],
    sets: {
      3: { emoticons: [{ id: 9, name: 'ZrehplaR' }, { id: 720717, name: 'Aware', animated: { 2: 'url' } }] },
      99: { emoticons: [{ id: 1, name: 'NotForEveryone' }] },
    },
  };
  assert.deepEqual(parseEmoteSet('ffz', 'global', ffz), [entry('ffz', '9', 'ZrehplaR'), entry('ffz', '720717', 'Aware', true)]);
  assert.equal(parseEmoteSet('ffz', 'channel', ffz).length, 3, 'a channel uses all its sets');
  assert.deepEqual(
    parseEmoteSet('7tv', 'global', { emotes: [{ id: 'S1', name: 'RainTime', data: { animated: true } }] }),
    [entry('7tv', 'S1', 'RainTime', true)],
  );
  assert.deepEqual(
    parseEmoteSet('7tv', 'channel', { emote_set: { emotes: [{ id: 'S9', name: 'GAMBA', data: { animated: false } }] } }),
    [entry('7tv', 'S9', 'GAMBA')],
  );
  assert.deepEqual(parseEmoteSet('7tv', 'channel', { emote_set: null }), []);
  assert.deepEqual(parseEmoteSet('ffz', 'global', 'nonsense'), []);
});

test('stored emotes carry their source; a plain id from before is a Twitch emote', () => {
  assert.deepEqual(parseEmoteRef('twitch:25'), { source: 'twitch', id: '25' });
  assert.deepEqual(parseEmoteRef('25'), { source: 'twitch', id: '25' });
  assert.deepEqual(parseEmoteRef('7tv:01FCY771D8'), { source: '7tv', id: '01FCY771D8' });
  assert.equal(parseEmoteRef('youtube:1'), null);
  assert.equal(parseEmoteRef('bttv:../../etc'), null);
  assert.equal(parseEmoteRef(''), null);
  assert.equal(parseEmoteRef(null), null);
});

test('third-party emotes are whole words; the last emote of the message wins, across all sources', () => {
  const r = registry();
  assert.equal(r.pickEmote(message('hello RainTime'), ALL), '7tv:S1');
  assert.equal(r.pickEmote(message('RainTimeX and xRainTime'), ALL), null, 'only whole words');
  assert.equal(r.pickEmote(message('RainTime then ZrehplaR'), ALL), 'ffz:9');
  assert.equal(r.pickEmote(message('nothing here'), ALL), null);

  // A Twitch emote at character 0, a 7TV word later: the later one wins, and the other way round.
  assert.equal(r.pickEmote(message('Kappa RainTime', { emoteIds: ['25'], lastEmoteAt: 0 }), ALL), '7tv:S1');
  assert.equal(r.pickEmote(message('RainTime Kappa', { emoteIds: ['25'], lastEmoteAt: 9 }), ALL), 'twitch:25');
  assert.equal(r.pickEmote(message('Kappa', { emoteIds: ['25'] }), ALL), 'twitch:25');
  // Positions count characters, not bytes: an emoji before the emote does not shift it.
  assert.equal(r.pickEmote(message('😀 Kappa RainTime', { emoteIds: ['25'], lastEmoteAt: 2 }), ALL), '7tv:S1');
});

test('a word in several sources goes to 7TV, then BetterTTV, then FrankerFaceZ; a channel emote beats a global one', () => {
  const r = registry();
  assert.equal(r.pickEmote(message('Clap'), ALL), '7tv:S2');
  assert.equal(r.pickEmote(message('Clap'), { ...ALL, '7tv': false }), 'bttv:b2');
  assert.equal(r.pickEmote(message('Clap'), { bttv: false, ffz: true, '7tv': false }), 'ffz:10');
  assert.equal(r.pickEmote(message('catJAM'), ALL), 'bttv:cb', "the channel's own catJAM");
});

test('a switched-off source is neither recognised nor shown', () => {
  const r = registry();
  const noSeven = { ...ALL, '7tv': false };
  assert.equal(r.pickEmote(message('RainTime'), noSeven), null);
  const options = { sources: noSeven, random: false, special: false };
  assert.equal(r.fighterEmote('7tv:S1', 'u1', options), null, 'a stored 7TV emote is not shown either');
  assert.deepEqual(r.fighterEmote('bttv:b1', 'u1', options), {
    url: '/emotes/bttv/b1?animated=0',
    animatedUrl: '/emotes/bttv/b1?animated=1',
  });
  assert.deepEqual(r.fighterEmote('25', 'u1', options), { url: '/emotes/twitch/25?animated=0', animatedUrl: null });
});

test('a chatter without an emote gets a random one, always the same, unless switched off', () => {
  const r = registry();
  const on = { sources: ALL, random: true, special: false };
  const first = r.fighterEmote(null, 'user-7', on);
  assert.ok(first);
  assert.deepEqual(r.fighterEmote(null, 'user-7', on), first, 'the same one every fight');
  const seen = new Set(Array.from({ length: 40 }, (_, i) => r.fighterEmote(null, `user-${i}`, on)!.url));
  assert.ok(seen.size > 5, 'different chatters get different ones');
  assert.equal(r.fighterEmote(null, 'user-7', { ...on, random: false }), null);
  assert.equal(r.fighterEmote(null, 'god', { ...on, special: true }), null, 'the god never gets a random one');
  // Twitch's globals are always in the pool; switched-off sources are not.
  const pool = r.randomPool({ bttv: false, ffz: false, '7tv': false });
  assert.deepEqual(pool, TWITCH_GLOBALS.map((e) => `twitch:${e.id}`).sort());
});

test('image addresses: moving emotes get an animated one, still ones none', () => {
  assert.deepEqual(emoteImage({ source: '7tv', id: 'S1' }, true), {
    url: '/emotes/7tv/S1?animated=0',
    animatedUrl: '/emotes/7tv/S1?animated=1',
  });
  assert.equal(emoteImage({ source: 'ffz', id: '9' }, false).animatedUrl, null);
  assert.equal(emoteImage({ source: 'twitch', id: '25' }, undefined).animatedUrl, null);
  assert.ok(emoteImage({ source: 'twitch', id: 'emotesv2_abc' }, undefined).animatedUrl, 'newer Twitch emotes may move');
  assert.deepEqual(cdnCandidates({ source: '7tv', id: 'S1' }, false), [
    'https://cdn.7tv.app/emote/S1/2x_static.webp',
    'https://cdn.7tv.app/emote/S1/2x.webp',
  ]);
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(GIF), 'image/gif');
  assert.equal(imageType(new TextEncoder().encode('<html>')), null);
});

test('emote images are fetched once, cached on disk, and malformed requests fetch nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emote-cache-'));
  try {
    const fetched: string[] = [];
    const fetchBytes = async (url: string) => {
      fetched.push(url);
      if (url.includes('/static/2x.webp')) return null; // a still emote: no separate still file
      if (url.includes('html')) return new TextEncoder().encode('<html>');
      return url.endsWith('2x.webp') ? GIF : PNG;
    };
    const images = new EmoteImages({ cacheDir: dir, fetchBytes });
    const first = await images.get('bttv', 'abc', false);
    assert.deepEqual(first, { type: 'image/gif', data: GIF });
    assert.deepEqual(fetched, ['https://cdn.betterttv.net/emote/abc/static/2x.webp', 'https://cdn.betterttv.net/emote/abc/2x.webp']);
    await images.get('bttv', 'abc', false);
    assert.equal(fetched.length, 2, 'served from memory the second time');
    assert.deepEqual(readdirSync(dir), ['bttv-abc-s']);

    // A new process finds it on disk.
    const again = new EmoteImages({ cacheDir: dir, fetchBytes: async () => assert.fail('no fetch') });
    assert.deepEqual(await again.get('bttv', 'abc', false), { type: 'image/gif', data: GIF });

    for (const [source, id] of [['bttv', '../secret'], ['bttv', 'a/b'], ['youtube', '1'], ['twitch', '']]) {
      assert.equal(await images.get(source!, id!, false), null);
    }
    assert.equal(fetched.length, 2, 'nothing was fetched for them');
    // Something that is not an image is not served.
    mkdirSync(join(dir, 'x'), { recursive: true });
    writeFileSync(join(dir, 'twitch-html-s'), '<html>');
    assert.equal(await new EmoteImages({ cacheDir: dir, fetchBytes: async () => null }).get('twitch', 'html', false), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry loads all three services, and a failing one only contributes nothing', async () => {
  const logs: string[] = [];
  const r = new EmoteRegistry({
    log: (line) => logs.push(line),
    fetchJson: async (url) => {
      if (url.includes('betterttv') && url.includes('global')) return [{ id: 'b1', code: 'catJAM', animated: true }];
      if (url.includes('7tv.io/v3/users/twitch/123')) return { emote_set: { emotes: [{ id: 'C7', name: 'GAMBA', data: {} }] } };
      if (url.includes('7tv')) return { emotes: [{ id: 'S1', name: 'RainTime', data: { animated: true } }] };
      return null;
    },
  });
  await r.refresh();
  await r.refresh();
  assert.equal(r.pickEmote(message('catJAM'), ALL), 'bttv:b1');
  assert.equal(r.isAnimated('bttv:b1'), true);
  assert.equal(logs.filter((line) => line.includes('ffz global')).length, 1, 'a failure is logged once');
  r.setChannel('123');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(r.pickEmote(message('GAMBA'), ALL), '7tv:C7');
  r.setChannel('not a number');
  assert.deepEqual(r.globalWords('7tv'), ['RainTime']);
});

test('themes are the folders of overlay/themes with a theme.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'themes-'));
  try {
    const add = (id: string, json: string | null) => {
      mkdirSync(join(root, 'overlay', 'themes', id), { recursive: true });
      if (json !== null) writeFileSync(join(root, 'overlay', 'themes', id, 'theme.json'), json);
    };
    add('pixel', JSON.stringify({ name: 'Pixel RPG', description: 'Chunky.' }));
    add('plain', JSON.stringify({ name: 'Plain' }));
    add('empty', null);
    add('broken', '{ not json');
    add('nameless', JSON.stringify({ description: 'x' }));
    const themes = listThemes(root, 0);
    assert.deepEqual(themes, [
      { id: 'pixel', name: 'Pixel RPG', description: 'Chunky.' },
      { id: 'plain', name: 'Plain', description: '' },
    ]);
    assert.equal(activeTheme(null, themes), 'pixel', 'pixel by default');
    assert.equal(activeTheme('plain', themes), 'plain');
    assert.equal(activeTheme('removed', themes), 'pixel', 'a theme that is gone falls back');
    assert.equal(activeTheme(null, themes.filter((t) => t.id !== 'pixel')), 'plain');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
