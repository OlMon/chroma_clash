import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../lang/en.json' with { type: 'json' };
import de from '../lang/de.json' with { type: 'json' };

/**
 * The texts the game shows, in every language it has. The strings live in
 * lang/<id>.json, one file per language, shared with the overlay and the
 * control panel. English is the source: a key missing from another language
 * shows in English.
 *
 * A value is a string with `{name}` placeholders, or, where a count changes the
 * wording, `{ "one": "...", "other": "..." }` picked by the `count` parameter.
 */
export type Strings = Record<string, string | { one: string; other: string }>;
export type Params = Record<string, string | number>;

const languages = new Map<string, Strings>([
  ['en', en as Strings],
  ['de', de as Strings],
]);

export const DEFAULT_LANGUAGE = 'en';

/**
 * Adds the language files found in a folder, or replaces the built-in copies
 * with them: a translation can be edited next to the program without a new
 * build. Files that cannot be read are skipped.
 */
export function addLanguagesFrom(folder: string): void {
  let files: string[];
  try {
    files = readdirSync(folder).filter((name) => /^[a-z]{2,3}(-[A-Za-z]{2,4})?\.json$/.test(name));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(folder, file), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        languages.set(file.slice(0, -'.json'.length), parsed as Strings);
      }
    } catch {
      // A broken file must not stop the game; the language is just not offered.
    }
  }
}

export function isLanguage(id: unknown): id is string {
  return typeof id === 'string' && languages.has(id);
}

/** Every language, with its name in its own language, for the control panel's choice. */
export function languageList(): { id: string; name: string }[] {
  return [...languages.keys()].map((id) => ({ id, name: text(id, 'language.name') }));
}

/** The language the streamer chose in the control panel; English if none, or one that is gone. */
export function languageOf(store: { getSetting(key: string): string | null }): string {
  const chosen = store.getSetting('language');
  return isLanguage(chosen) ? chosen : DEFAULT_LANGUAGE;
}

function lookup(lang: string, key: string): Strings[string] | undefined {
  return languages.get(lang)?.[key] ?? languages.get(DEFAULT_LANGUAGE)![key];
}

/**
 * The text for a key in a language, with its placeholders filled in. A key
 * nobody translated comes back as the key itself, which is easy to spot.
 */
export function text(lang: string, key: string, params: Params = {}): string {
  const value = lookup(lang, key);
  if (value === undefined) return key;
  const chosen = typeof value === 'string' ? value : params.count === 1 ? value.one : value.other;
  return chosen.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** A shorthand bound to one language: `const t = translator(lang); t('key', { n: 1 })`. */
export function translator(lang: string): (key: string, params?: Params) => string {
  return (key, params) => text(lang, key, params);
}

/** A guild's name in a language. */
export function guildName(lang: string, id: string): string {
  return text(lang, `guild.${id}`);
}
