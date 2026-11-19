import { config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { DEFAULT_LANGUAGE, languageOf, text } from '../i18n.ts';

/** The sections of the tuning card, in the order they are shown. Their names are in the language files. */
const GROUPS = ['experience', 'land', 'battles', 'countdown'] as const;

/**
 * A tuning value the streamer may change in the control panel. Its label is
 * the language files' `server.tuning.<key>`.
 */
interface Tunable {
  key: string;
  /** The section of the control panel's tuning card the value is listed under. */
  group: (typeof GROUPS)[number];
  min: number;
  max: number;
  /** The panel shows `config value / scale`, e.g. seconds for a value kept in ms. */
  scale?: number;
  get: () => number;
  set: (value: number) => void;
}

const TUNABLES: Tunable[] = [
  {
    key: 'ticks.xpPerTick',
    group: 'experience',
    min: 1,
    max: 100,
    get: () => config.ticks.xpPerTick,
    set: (v) => (config.ticks.xpPerTick = v),
  },
  {
    key: 'land.costPerLevel',
    group: 'land',
    min: 1,
    max: 1000,
    get: () => config.land.costPerLevel,
    set: (v) => (config.land.costPerLevel = v),
  },
  {
    key: 'monument.goal',
    group: 'land',
    min: 500,
    max: 10_000_000,
    get: () => config.monument.goal,
    set: (v) => (config.monument.goal = v),
  },
  {
    key: 'god.winsToWinSeason',
    group: 'land',
    min: 1,
    max: 100,
    get: () => config.god.winsToWinSeason,
    set: (v) => (config.god.winsToWinSeason = v),
  },
  {
    key: 'battle.durationMs',
    group: 'battles',
    min: 10,
    max: 300,
    scale: 1000,
    get: () => config.battle.durationMs,
    set: (v) => (config.battle.durationMs = v),
  },
  {
    key: 'battle.maxFightersPerSide',
    group: 'battles',
    min: 3,
    max: 100,
    get: () => config.battle.maxFightersPerSide,
    set: (v) => (config.battle.maxFightersPerSide = v),
  },
  {
    key: 'battle.fortune',
    group: 'battles',
    min: 0,
    max: 0.5,
    get: () => config.battle.fortune,
    set: (v) => (config.battle.fortune = v),
  },
  {
    key: 'draft.countdownMs',
    group: 'countdown',
    min: 5,
    max: 600,
    scale: 1000,
    get: () => config.draft.countdownMs,
    set: (v) => (config.draft.countdownMs = v),
  },
  {
    key: 'draft.lineupMs',
    group: 'countdown',
    min: 5,
    max: 120,
    scale: 1000,
    get: () => config.draft.lineupMs,
    set: (v) => (config.draft.lineupMs = v),
  },
  {
    key: 'war.participationXp',
    group: 'experience',
    min: 0,
    max: 500,
    get: () => config.war.participationXp,
    set: (v) => (config.war.participationXp = v),
  },
];

/** The values from the config file, before any override. */
const DEFAULTS = new Map(TUNABLES.map((t) => [t.key, t.get()]));
const SETTING = 'tuning';

export interface TuningValue {
  key: string;
  /** The section's name and the value's label, in the streamer's language. */
  group: string;
  label: string;
  value: number;
  default: number;
  min: number;
  max: number;
}

function readOverrides(store: Store): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(store.getSetting(SETTING) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Puts the stored overrides into the running config. Call once at startup. */
export function applyTuning(store: Store): void {
  const overrides = readOverrides(store);
  for (const tunable of TUNABLES) {
    const value = overrides[tunable.key];
    tunable.set(typeof value === 'number' && Number.isFinite(value) ? value : DEFAULTS.get(tunable.key)!);
  }
}

/** The editable values as the control panel shows them, section by section. */
export function tuningValues(lang = DEFAULT_LANGUAGE): TuningValue[] {
  const ordered = [...TUNABLES].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  return ordered.map((t) => {
    const scale = t.scale ?? 1;
    return {
      key: t.key,
      group: text(lang, `server.tuningGroup.${t.group}`),
      label: text(lang, `server.tuning.${t.key}`),
      value: t.get() / scale,
      default: DEFAULTS.get(t.key)! / scale,
      min: t.min,
      max: t.max,
    };
  });
}

/**
 * Changes one value, or resets it with `null`. `value` is in the panel's unit.
 * Throws an Error with a message for the streamer if the key or value is invalid.
 */
export function setTuning(store: Store, key: string, value: number | null): void {
  const tunable = TUNABLES.find((t) => t.key === key);
  if (!tunable) throw new Error(`Unknown tuning value: ${key}`);
  const overrides = readOverrides(store);
  if (value === null) {
    delete overrides[key];
  } else {
    if (!Number.isFinite(value) || value < tunable.min || value > tunable.max) {
      const label = text(languageOf(store), `server.tuning.${key}`);
      throw new Error(text(languageOf(store), 'server.tuning.outOfRange', { label, min: tunable.min, max: tunable.max }));
    }
    overrides[key] = value * (tunable.scale ?? 1);
  }
  store.setSetting(SETTING, JSON.stringify(overrides));
  applyTuning(store);
}
