/**
 * The "a new version is out" notice: reads a small JSON file from the website,
 * e.g. `{ "version": "0.2.0", "url": "https://…/", "notes": "…" }`, and tells
 * whether it names a newer version than the one running.
 */
import packageJson from '../package.json' with { type: 'json' };
import { config } from './config.ts';

/** The running version. The release build inlines package.json, so this works in the executable too. */
export const appVersion: string = packageJson.version;

export interface UpdateInfo {
  /** The newer version, as the file names it. */
  latest: string;
  /** Where to download it (always http or https). */
  url: string;
  notes?: string;
}

/** Longest release note passed on; the file is not trusted to be small. */
const MAX_NOTES_LENGTH = 500;

interface ParsedVersion {
  core: number[];
  pre: string[];
}

function parseVersion(text: string): ParsedVersion | null {
  const match = /^\s*v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?\s*$/.exec(text);
  if (!match) return null;
  return { core: match[1]!.split('.').map(Number), pre: match[2] ? match[2].split('.') : [] };
}

/**
 * Compares two versions like semver ("1.2.3", "v1.2", "1.3.0-beta.2"): negative
 * when `a` is older, positive when newer, 0 when equal. Missing parts count as 0,
 * and a pre-release is older than its release. Null when either is not a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre.length === 0 || right.pre.length === 0) return (right.pre.length > 0 ? 1 : 0) - (left.pre.length > 0 ? 1 : 0);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function httpUrl(text: string, base?: string): string | null {
  try {
    const url = new URL(text, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the version file at `url` and returns the newer version it names, or
 * null when it names none, or on any failure (offline, timeout, bad JSON). Never throws.
 * A file without `url` points at the folder it sits in, which is the website.
 */
export async function checkForUpdate(
  currentVersion: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = config.updates.timeoutMs,
): Promise<UpdateInfo | null> {
  try {
    const source = httpUrl(url);
    if (!source) return null;
    const response = await fetchImpl(source, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data: unknown = JSON.parse(await response.text());
    if (typeof data !== 'object' || data === null) return null;
    const { version, url: page, notes } = data as Record<string, unknown>;
    if (typeof version !== 'string') return null;
    if ((compareVersions(version, currentVersion) ?? 0) <= 0) return null;
    const download = typeof page === 'string' ? httpUrl(page, source) : httpUrl('./', source);
    if (!download) return null;
    const info: UpdateInfo = { latest: version.trim(), url: download };
    if (typeof notes === 'string' && notes.trim()) info.notes = notes.trim().slice(0, MAX_NOTES_LENGTH);
    return info;
  } catch {
    return null;
  }
}
