import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Settings that belong to the program rather than to one channel's game, kept
 * in data/settings.json: which Twitch channel to read, and the key of the
 * action links. Each channel's game lives in a database of its own.
 */
export interface AppSettings {
  channel?: string;
  /**
   * The secret in the action links for a Stream Deck or OBS hotkeys
   * (/api/action/war?key=…). Made on the first start; it stays the same when
   * the channel changes, so the buttons keep working.
   */
  actionKey?: string;
}

const ACTION_KEY = /^[a-f0-9]{16,64}$/;

/** A new action key: 24 random hex digits. */
export function newActionKey(): string {
  return randomBytes(12).toString('hex');
}

/** A Twitch login name: letters, digits and underscores, 3 to 25 of them, written in lower case. */
export function normalizeChannel(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const channel = name.trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(channel) ? channel : null;
}

export function readAppSettings(file: string): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    const channel = normalizeChannel(record.channel);
    const actionKey = typeof record.actionKey === 'string' && ACTION_KEY.test(record.actionKey) ? record.actionKey : null;
    return { ...(channel ? { channel } : {}), ...(actionKey ? { actionKey } : {}) };
  } catch {
    return {};
  }
}

export function writeAppSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  // Written next to the file and moved over it, so a crash never leaves half a file.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, file);
}
