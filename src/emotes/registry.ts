import { config } from '../config.ts';
import type { ChatMessageEvent } from '../irc/events.ts';
import { hashString } from '../util/rng.ts';
import {
  emoteImage,
  formatEmoteRef,
  isValidEmoteId,
  parseEmoteRef,
  THIRD_PARTY_SOURCES,
  TWITCH_GLOBALS,
  type EmoteImage,
  type ThirdPartySource,
} from './sources.ts';

/** One emote of a third-party set: the word that shows it, and whether it moves. */
export interface EmoteEntry {
  source: ThirdPartySource;
  id: string;
  code: string;
  animated: boolean;
}

export type SourceSwitches = Record<ThirdPartySource, boolean>;

/** Fetches a JSON document; injectable so tests need no network. Resolves to null on any failure. */
export type FetchJson = (url: string) => Promise<unknown>;

/** The services' addresses for their global sets and for a channel's sets. */
const API = {
  bttv: {
    global: 'https://api.betterttv.net/3/cached/emotes/global',
    channel: (id: string) => `https://api.betterttv.net/3/cached/users/twitch/${id}`,
  },
  ffz: {
    global: 'https://api.frankerfacez.com/v1/set/global',
    channel: (id: string) => `https://api.frankerfacez.com/v1/room/id/${id}`,
  },
  '7tv': {
    global: 'https://7tv.io/v3/emote-sets/global',
    channel: (id: string) => `https://7tv.io/v3/users/twitch/${id}`,
  },
} satisfies Record<ThirdPartySource, { global: string; channel: (id: string) => string }>;

/**
 * When the same word is an emote in several sources, the one that wins. 7TV
 * comes first, as in the browser extensions that show all three.
 */
const PRECEDENCE: ThirdPartySource[] = ['7tv', 'bttv', 'ffz'];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Reads one service's answer into emotes. Unknown shapes give an empty list. */
export function parseEmoteSet(source: ThirdPartySource, scope: 'global' | 'channel', body: unknown): EmoteEntry[] {
  const entries: EmoteEntry[] = [];
  const add = (id: unknown, code: unknown, animated: unknown) => {
    if (typeof id !== 'string' && typeof id !== 'number') return;
    if (typeof code !== 'string' || code === '' || /\s/.test(code)) return;
    const value = String(id);
    if (!isValidEmoteId(value)) return;
    entries.push({ source, id: value, code, animated: animated === true });
  };
  if (source === 'bttv') {
    const items = scope === 'global' ? list(body) : isObject(body) ? [...list(body.channelEmotes), ...list(body.sharedEmotes)] : [];
    for (const item of items) if (isObject(item)) add(item.id, item.code, item.animated);
  } else if (source === 'ffz') {
    if (!isObject(body) || !isObject(body.sets)) return entries;
    const sets = body.sets as Json;
    // The global answer also lists sets only some users see; the default sets are everyone's.
    const ids = scope === 'global' ? list(body.default_sets).map(String) : Object.keys(sets);
    for (const setId of ids) {
      const set = sets[setId];
      if (!isObject(set)) continue;
      for (const item of list(set.emoticons)) {
        if (isObject(item)) add(item.id, item.name, isObject(item.animated));
      }
    }
  } else {
    const set = scope === 'global' ? body : isObject(body) ? body.emote_set : null;
    if (!isObject(set)) return entries;
    for (const item of list(set.emotes)) {
      if (!isObject(item)) continue;
      const data = isObject(item.data) ? item.data : {};
      add(item.id, item.name, data.animated);
    }
  }
  return entries;
}

/** Splits a message into words with the position of their first character, counted in characters. */
function words(text: string): { word: string; at: number }[] {
  const chars = Array.from(text);
  const found: { word: string; at: number }[] = [];
  let start = -1;
  for (let i = 0; i <= chars.length; i++) {
    const space = i === chars.length || /\s/.test(chars[i]!);
    if (!space && start === -1) start = i;
    if (space && start !== -1) {
      found.push({ word: chars.slice(start, i).join(''), at: start });
      start = -1;
    }
  }
  return found;
}

/**
 * The emote sets of BetterTTV, FrankerFaceZ and 7TV: the global sets, and the
 * channel's own once its Twitch id is known. Loads them, refreshes them now and
 * then, and finds emotes in chat messages.
 */
export class EmoteRegistry {
  private readonly fetchJson: FetchJson;
  private readonly log: (message: string) => void;
  private readonly sets = {
    global: { bttv: new Map<string, EmoteEntry>(), ffz: new Map<string, EmoteEntry>(), '7tv': new Map<string, EmoteEntry>() },
    channel: { bttv: new Map<string, EmoteEntry>(), ffz: new Map<string, EmoteEntry>(), '7tv': new Map<string, EmoteEntry>() },
  };
  /** Whether each loaded emote moves, by its stored id. */
  private readonly animated = new Map<string, boolean>();
  private readonly failed = new Set<string>();
  /** The last attempt to load each source's global and channel set, for the status page. */
  private readonly loads = new Map<string, { ok: boolean; at: number }>();
  private channelId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { fetchJson?: FetchJson; log?: (message: string) => void } = {}) {
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Loads the global sets now and every `refreshMs`. */
  start(): Promise<void> {
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), config.emotes.refreshMs);
      this.timer.unref?.();
    }
    return this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * How each source stands: how many global and channel emotes are loaded,
   * and whether the last attempt to reach it worked (null: not tried yet).
   * A channel without an account at a source fails to load there; that is normal.
   */
  status(): { source: ThirdPartySource; global: number; channel: number; reachable: boolean | null; checkedAt: number | null }[] {
    return THIRD_PARTY_SOURCES.map((source) => {
      const global = this.loads.get(`${source}:global`);
      return {
        source,
        global: this.sets.global[source].size,
        channel: this.sets.channel[source].size,
        reachable: global ? global.ok : null,
        checkedAt: global?.at ?? null,
      };
    });
  }

  /** The channel's Twitch id, from the `room-id` tag. Its sets are loaded when it is new. */
  setChannel(channelId: string | null | undefined): void {
    if (!channelId || channelId === this.channelId || !/^\d{1,20}$/.test(channelId)) return;
    this.channelId = channelId;
    void this.loadScope('channel');
  }

  /** Loads everything again: the global sets, and the channel's if known. */
  async refresh(): Promise<void> {
    await Promise.all([this.loadScope('global'), this.channelId ? this.loadScope('channel') : Promise.resolve()]);
  }

  /** Puts a set in place directly. For tests and the simulator. */
  setEmotes(scope: 'global' | 'channel', source: ThirdPartySource, entries: EmoteEntry[]): void {
    const map = new Map<string, EmoteEntry>();
    for (const entry of entries) {
      map.set(entry.code, entry);
      this.animated.set(formatEmoteRef(entry), entry.animated);
    }
    this.sets[scope][source] = map;
  }

  private async loadScope(scope: 'global' | 'channel'): Promise<void> {
    const channelId = this.channelId;
    await Promise.all(
      THIRD_PARTY_SOURCES.map(async (source) => {
        const url = scope === 'global' ? API[source].global : API[source].channel(channelId!);
        const body = await this.fetchJson(url);
        this.loads.set(`${source}:${scope}`, { ok: body !== null, at: Date.now() });
        if (body === null) {
          // One line per source and scope, not one per refresh.
          const key = `${source}:${scope}`;
          if (!this.failed.has(key)) {
            this.failed.add(key);
            this.log(`[emotes] ${source} ${scope} emotes could not be loaded; continuing without them`);
          }
          return;
        }
        // A channel that changed while loading keeps the newer channel's sets.
        if (scope === 'channel' && channelId !== this.channelId) return;
        this.setEmotes(scope, source, parseEmoteSet(source, scope, body));
      }),
    );
  }

  /** The emote a word shows, from the switched-on sources; a channel emote beats a global one. */
  find(word: string, enabled: SourceSwitches): EmoteEntry | null {
    for (const source of PRECEDENCE) {
      if (!enabled[source]) continue;
      const entry = this.sets.channel[source].get(word) ?? this.sets.global[source].get(word);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * The emote a message leaves the chatter with, as a stored id: the one
   * nearest the end of the message, whether from Twitch or another source.
   * Null when the message has none.
   */
  pickEmote(event: ChatMessageEvent, enabled: SourceSwitches): string | null {
    const twitchId = event.emoteIds.at(-1);
    // Without a known position, a Twitch emote counts as the last one.
    const twitchAt = twitchId === undefined ? -1 : (event.lastEmoteAt ?? Number.POSITIVE_INFINITY);
    let best: { ref: string; at: number } | null = twitchId === undefined ? null : { ref: `twitch:${twitchId}`, at: twitchAt };
    for (const { word, at } of words(event.text)) {
      if (best && at <= best.at) continue;
      const entry = this.find(word, enabled);
      if (entry) best = { ref: formatEmoteRef(entry), at };
    }
    return best?.ref ?? null;
  }

  /** Whether a loaded emote moves; undefined for an emote this registry has not seen. */
  isAnimated(ref: string): boolean | undefined {
    return this.animated.get(ref);
  }

  /** The emotes a chatter without one of their own may be given: Twitch's and the switched-on global sets. */
  randomPool(enabled: SourceSwitches): string[] {
    const pool = TWITCH_GLOBALS.map((emote) => `twitch:${emote.id}`);
    for (const source of THIRD_PARTY_SOURCES) {
      if (!enabled[source]) continue;
      for (const entry of this.sets.global[source].values()) pool.push(formatEmoteRef(entry));
    }
    return [...new Set(pool)].sort();
  }

  /** The words of a global set, for the simulator to put in its messages. */
  globalWords(source: ThirdPartySource): string[] {
    return [...this.sets.global[source].keys()];
  }

  /**
   * What a fighter shows: its own emote if its source is switched on; else,
   * with random emotes on and for an ordinary chatter, one from the pool
   * picked by its id, so it stays the same from fight to fight.
   */
  fighterEmote(
    stored: string | null | undefined,
    fighterId: string,
    options: { sources: SourceSwitches; random: boolean; special: boolean },
  ): EmoteImage | null {
    let ref = parseEmoteRef(stored);
    if (ref && ref.source !== 'twitch' && !options.sources[ref.source]) ref = null;
    if (!ref && options.random && !options.special) {
      const pool = this.randomPool(options.sources);
      ref = parseEmoteRef(pool[hashString(`emote:${fighterId}`) % pool.length]);
    }
    if (!ref) return null;
    return emoteImage(ref, this.isAnimated(formatEmoteRef(ref)));
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.emotes.fetchTimeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
