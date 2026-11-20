import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
}

const FOLDER = /^[A-Za-z0-9_-]{1,40}$/;
/** How long a listing is reused before the folder is read again. */
const REUSE_MS = 3_000;
const cache = new Map<string, { at: number; themes: ThemeInfo[] }>();

/**
 * The overlay's themes: every folder in `overlay/themes` that has a
 * `theme.json` with a name. A folder without one, or with a broken one, is
 * skipped. Sorted by name; the folder name is the theme's id.
 */
export function listThemes(root: string, now = Date.now()): ThemeInfo[] {
  const cached = cache.get(root);
  if (cached && now - cached.at < REUSE_MS) return cached.themes;
  const dir = join(root, 'overlay', 'themes');
  const themes: ThemeInfo[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const id of entries) {
    if (!FOLDER.test(id)) continue;
    try {
      if (!statSync(join(dir, id)).isDirectory()) continue;
      const info: unknown = JSON.parse(readFileSync(join(dir, id, 'theme.json'), 'utf8'));
      if (typeof info !== 'object' || info === null) continue;
      const { name, description } = info as Record<string, unknown>;
      if (typeof name !== 'string' || name.trim() === '') continue;
      themes.push({ id, name, description: typeof description === 'string' ? description : '' });
    } catch {
      // no theme.json, or not valid JSON
    }
  }
  themes.sort((a, b) => a.name.localeCompare(b.name));
  cache.set(root, { at: now, themes });
  return themes;
}

/** The theme a new install starts with: Dark Fantasy Comic. */
export const DEFAULT_THEME = 'comic';

/** The theme in use: the chosen one if it still exists, else the default, else the first there is. */
export function activeTheme(chosen: string | null, themes: readonly ThemeInfo[]): string {
  if (chosen && themes.some((theme) => theme.id === chosen)) return chosen;
  if (themes.some((theme) => theme.id === DEFAULT_THEME)) return DEFAULT_THEME;
  return themes[0]?.id ?? 'plain';
}
