import { config } from '../config.ts';

/** What the control panel shows a runtime for. */
export type RuntimeKind =
  | 'war'
  | 'heroClash'
  | 'guildClash'
  | 'freeForAll'
  | 'pachinko'
  | 'godsWrath'
  | 'streamerVsChat'
  | 'friendly'
  | 'test';

/** Shortest and longest expected runtime in milliseconds, start to the last text leaving the screen. */
export type Runtime = [number, number];

/**
 * How long each event takes from the click, for the control panel. It adds up
 * the event runner's phases from the config (countdown, line-up, the map's
 * announcement, the result and the summary) around each fight, which lasts
 * from `config.pace.shortestFightMs` up to its time limit. A War has one battle
 * per guild; a Hero Clash at most one heat per hero rank and a final.
 */
export function estimatedRuntimes(): Record<RuntimeKind, Runtime> {
  const { war, draft, clash, battle, pachinko, pace } = config;
  const shortest = pace.shortestFightMs;
  /** A fight with its announcement before and the result after; `outcome` when the map then shows what changed. */
  const fight = (limitMs: number, outcome: boolean): Runtime => {
    const around = war.announceMs + war.resultHoldMs + (outcome ? war.outcomeMs : 0);
    return [around + Math.min(shortest, limitMs), around + limitMs];
  };
  const add = (...parts: (Runtime | number)[]): Runtime =>
    parts.reduce<Runtime>(
      (sum, part) => (typeof part === 'number' ? [sum[0] + part, sum[1] + part] : [sum[0] + part[0], sum[1] + part[1]]),
      [0, 0],
    );
  const times = (n: number, part: Runtime): Runtime => [part[0] * n, part[1] * n];

  const summary = war.summaryHoldMs;
  const countdown = draft.countdownMs;
  const guilds = config.guilds.list.length;
  // The draft's fight starts after the line-up instead of the map's announcement.
  const draftFight = add(fight(draft.durationMs, false), draft.lineupMs - war.announceMs);
  const god = add(fight(battle.durationMs, true), summary);
  return {
    war: add(times(guilds, fight(battle.durationMs, true)), summary),
    heroClash: add(times(clash.heroesPerGuild + 1, fight(clash.matchMs, false)), summary),
    guildClash: add(countdown, draftFight, summary),
    freeForAll: add(countdown, draftFight, summary),
    // The balls drop over about `targetMs`; the last one still has to fall.
    pachinko: add(countdown, draft.lineupMs, pachinko.targetMs + pachinko.rows * pachinko.hopMs + pachinko.holdMs, summary),
    godsWrath: god,
    streamerVsChat: god,
    friendly: god,
    test: [Math.min(shortest, battle.durationMs) + battle.resultHoldMs, battle.durationMs + battle.resultHoldMs],
  };
}
