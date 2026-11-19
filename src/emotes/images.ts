import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { cdnCandidates, imageType, isEmoteSource, isValidEmoteId, type EmoteRef } from './sources.ts';

/** Fetches an image's bytes; injectable so tests need no network. Resolves to null on any failure. */
export type FetchBytes = (url: string) => Promise<Uint8Array | null>;

export interface EmoteFile {
  type: string;
  data: Uint8Array;
}

/** How many images are kept in memory; the disk cache holds all of them. */
const MEMORY_LIMIT = 400;

/**
 * Emote images as the game server serves them: fetched from the source's CDN
 * once, then kept on disk and, for the most recent ones, in memory.
 */
export class EmoteImages {
  private readonly cacheDir: string | null;
  private readonly fetchBytes: FetchBytes;
  private readonly memory = new Map<string, EmoteFile | null>();
  private readonly pending = new Map<string, Promise<EmoteFile | null>>();

  /** Without a `cacheDir` nothing is written to disk. */
  constructor(options: { cacheDir?: string | null; fetchBytes?: FetchBytes } = {}) {
    this.cacheDir = options.cacheDir ?? null;
    this.fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  }

  /**
   * The image of an emote, still or moving, or null when the source or id is
   * malformed or no image could be found. Never throws.
   */
  async get(source: string, id: string, animated: boolean): Promise<EmoteFile | null> {
    if (!isEmoteSource(source) || !isValidEmoteId(id)) return null;
    const key = `${source}-${id}-${animated ? 'a' : 's'}`;
    if (this.memory.has(key)) return this.memory.get(key)!;
    let loading = this.pending.get(key);
    if (!loading) {
      loading = this.load({ source, id }, animated, key).finally(() => this.pending.delete(key));
      this.pending.set(key, loading);
    }
    return loading;
  }

  private async load(ref: EmoteRef, animated: boolean, key: string): Promise<EmoteFile | null> {
    const file = this.cacheDir ? join(this.cacheDir, key) : null;
    if (file) {
      try {
        const data = new Uint8Array(await readFile(file));
        const type = imageType(data);
        if (type) return this.remember(key, { type, data });
      } catch {
        // not cached yet
      }
    }
    for (const url of cdnCandidates(ref, animated)) {
      const data = await this.fetchBytes(url);
      const type = data ? imageType(data) : null;
      if (!data || !type) continue;
      if (file) {
        try {
          await mkdir(this.cacheDir!, { recursive: true });
          await writeFile(file, data);
        } catch {
          // a cache that cannot be written only costs a fetch next time
        }
      }
      return this.remember(key, { type, data });
    }
    // Not remembered: a CDN that failed now may answer later.
    return null;
  }

  private remember(key: string, value: EmoteFile): EmoteFile {
    if (this.memory.size >= MEMORY_LIMIT) this.memory.delete(this.memory.keys().next().value!);
    this.memory.set(key, value);
    return value;
  }
}

async function defaultFetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.emotes.fetchTimeoutMs) });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}
