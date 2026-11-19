import { config, type GuildId } from '../config.ts';

/**
 * How a season is paced: its Monument goal from the stream hours it should
 * last, and a forecast of when it ends. See `config.season`.
 */

/** Windows of stream time in an hour. */
export function windowsPerHour(): number {
  return (60 * 60_000) / config.ticks.windowMs;
}

/** The goal before the chat's pace is measured. */
export function priorGoal(hours = config.season.hours): number {
  return roundGoal(config.season.expectedPerHour * hours);
}

/** How many windows of stream time the goal keeps adapting for. */
export function adaptWindows(hours = config.season.hours): number {
  const { adaptShare, adaptHours } = config.season;
  return Math.max(1, Math.round(Math.min(adaptShare * hours, adaptHours) * windowsPerHour()));
}

/**
 * What the season remembers of its pace: how many windows of stream time it
 * has had, each guild's Monument at the start of the most recent windows
 * (oldest first), and the goal.
 */
export interface SeasonPace {
  seasonId: number;
  /** The start of the latest window counted. */
  lastWindow: number;
  windows: number;
  history: Record<GuildId, number>[];
  goal: number;
  /** The stream hours the goal was set for. */
  hours: number;
}

export function freshPace(seasonId: number, hours = config.season.hours): SeasonPace {
  return { seasonId, lastWindow: 0, windows: 0, history: [], goal: priorGoal(hours), hours };
}

/** Whether the goal still adapts to the chat's pace. */
export function adapting(pace: SeasonPace): boolean {
  return pace.windows < adaptWindows(pace.hours);
}

/**
 * Each guild's Monument growth per window, between the oldest and the newest
 * remembered window start; null until a few windows are known.
 */
export function ratesPerWindow(pace: SeasonPace): Record<GuildId, number> | null {
  const oldest = pace.history[0];
  const newest = pace.history.at(-1);
  const span = pace.history.length - 1;
  if (!oldest || !newest || span < 3) return null;
  const rate = (guild: GuildId): number => Math.max(0, (newest[guild] - oldest[guild]) / span);
  return { red: rate('red'), green: rate('green'), blue: rate('blue') };
}

/**
 * Where the Monuments will stand when the season's stream hours are up, at
 * the pace measured now: the furthest one. (The land levels off early in a
 * season, where growth and mishaps meet, so the pace is taken as it is.)
 */
function projected(pace: SeasonPace, now: Record<GuildId, number>, rates: Record<GuildId, number>): number {
  const remaining = Math.max(0, pace.hours * windowsPerHour() - pace.windows);
  return Math.max(...(Object.keys(rates) as GuildId[]).map((g) => now[g] + rates[g] * remaining));
}

/**
 * The goal while it adapts: from the expected pace at first, moving over to
 * the measured projection as the season's first windows go by. Always ahead
 * of every Monument as it stands, so a new goal cannot end the season by itself.
 */
export function adaptedGoal(pace: SeasonPace, now: Record<GuildId, number>): number {
  const prior = priorGoal(pace.hours);
  const rates = ratesPerWindow(pace);
  const ahead = roundGoal(Math.max(now.red, now.green, now.blue) + config.season.roundTo);
  if (!rates) return Math.max(prior, ahead);
  const weight = Math.min(1, pace.windows / adaptWindows(pace.hours));
  return Math.max(roundGoal(prior * (1 - weight) + projected(pace, now, rates) * weight), ahead);
}

/**
 * Counts one more window of stream time: remembers the Monuments as they
 * stand at its start and, while the goal adapts, moves the goal. Returns the
 * new record; the old one is left as it was.
 */
export function countWindow(pace: SeasonPace, windowStart: number, now: Record<GuildId, number>): SeasonPace {
  if (windowStart <= pace.lastWindow) return pace;
  const history = [...pace.history, { ...now }].slice(-config.season.paceWindows);
  const next: SeasonPace = { ...pace, lastWindow: windowStart, windows: pace.windows + 1, history };
  // The goal is moved at the start of the window, from what was measured
  // before it; not once a Monument has reached it (a fight's reward can do
  // that between ticks): the next tick ends the season.
  const reached = Math.max(now.red, now.green, now.blue) >= pace.goal;
  if (adapting(pace) && !reached) next.goal = adaptedGoal({ ...pace, history }, now);
  return next;
}

/**
 * A new season length, set by the streamer: the goal is worked out again at
 * once, from the measured pace if there is one, and keeps adapting only
 * where the season is still young enough for the new length.
 */
export function retarget(pace: SeasonPace, hours: number, now: Record<GuildId, number>): SeasonPace {
  const next = { ...pace, hours };
  const rates = ratesPerWindow(next);
  const lead = Math.max(now.red, now.green, now.blue);
  if (adapting(next) || !rates) return { ...next, goal: adaptedGoal(next, now) };
  return { ...next, goal: Math.max(roundGoal(projected(next, now, rates)), roundGoal(lead * 1.1)) };
}

/**
 * How strong lightning and fire are now, from 0 to 1: weak in a young
 * season, full after `fullAfterHours` of its stream time.
 */
export function mishapStrength(pace: SeasonPace): number {
  const { startStrength, fullAfterHours } = config.mishaps.ramp;
  const played = pace.windows / windowsPerHour();
  return Math.min(1, startStrength + (1 - startStrength) * (played / fullAfterHours));
}

export interface SeasonForecast {
  /** The stream hours the season is set to last. */
  hours: number;
  /** The stream hours it has had. */
  played: number;
  goal: number;
  /** Whether the goal still adapts to the chat's pace, and until how many stream hours. */
  adapting: boolean;
  adaptUntil: number;
  /** The guild expected to finish first, and in how many more stream hours; null until the pace is measured. */
  leader: GuildId | null;
  remaining: number | null;
}

/** When the season will end at the pace measured now. */
export function forecast(pace: SeasonPace, now: Record<GuildId, number>): SeasonForecast {
  const base = {
    hours: pace.hours,
    played: pace.windows / windowsPerHour(),
    goal: pace.goal,
    adapting: adapting(pace),
    adaptUntil: adaptWindows(pace.hours) / windowsPerHour(),
  };
  const rates = ratesPerWindow(pace);
  if (!rates) return { ...base, leader: null, remaining: null };
  let best: { guild: GuildId; windows: number } | null = null;
  for (const guild of Object.keys(rates) as GuildId[]) {
    const left = Math.max(0, pace.goal - now[guild]);
    if (rates[guild] <= 0 && left > 0) continue;
    const windows = left === 0 ? 0 : left / rates[guild];
    if (!best || windows < best.windows) best = { guild, windows };
  }
  if (!best) return { ...base, leader: null, remaining: null };
  return { ...base, leader: best.guild, remaining: best.windows / windowsPerHour() };
}

function roundGoal(value: number): number {
  const { roundTo, minGoal } = config.season;
  return Math.max(minGoal, Math.ceil(value / roundTo) * roundTo);
}
