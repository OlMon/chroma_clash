import { config } from '../config.ts';
import { Battle, type BattleResult, type BattleSetup, type Fighter } from '../game/battle.ts';
import type { EmoteImage } from '../emotes/sources.ts';

/** Where the map banner sits during battles: across the top, across the bottom, or nowhere. */
export type BannerPlace = 'top' | 'bottom' | null;

/**
 * The map banner's strip for the overlay outside a battle (a countdown,
 * Pachinko): its place, and its `height` on an arena `width` wide, which is
 * the screen's width. Null when the banner is off.
 */
export function bannerStrip(place: BannerPlace): { place: 'top' | 'bottom'; height: number; width: number } | null {
  return place ? { place, height: config.battle.bannerHeight, width: config.battle.arena.width } : null;
}

/** At most this many steps are run at once to catch up with the clock. */
const MAX_CATCH_UP = 6;

export interface BattleMeta {
  title: string;
  sides: { id: string; name: string; color: string }[];
  /**
   * An ambient battle is background decoration: the overlay shows no
   * scoreboard and no result. Like every battle, it hides the panels.
   */
  ambient?: boolean;
  /** Names and colors of teams that are not a single side, e.g. all of chat against the god. */
  teams?: Record<string, { name: string; color: string }>;
}

/**
 * Runs one battle at a time against the real clock and streams it to the
 * overlay: a `battle-start` message with the roster, a `battle-frame` per
 * step, and a `battle-end` with the result.
 */
export class BattleRunner {
  private readonly send: (message: object) => void;
  private battle: Battle | null = null;
  private meta: BattleMeta | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onEnd: ((result: BattleResult | null) => void) | null = null;
  private readonly emoteOf: (fighter: Fighter) => EmoteImage | null;
  private readonly obstacles: () => boolean;
  private readonly banner: () => BannerPlace;
  /** Where the map banner is during the running battle; null for none. */
  private bannerPlace: BannerPlace = null;

  /**
   * `emoteOf` turns a fighter's stored emote into the images the overlay
   * loads; without it, fighters are shown without emotes. `obstacles` tells
   * whether battles get obstacles (switched on in the control panel).
   */
  constructor(
    send: (message: object) => void,
    emoteOf?: (fighter: Fighter) => EmoteImage | null,
    obstacles?: () => boolean,
    banner?: () => BannerPlace,
  ) {
    this.send = send;
    this.emoteOf = emoteOf ?? (() => null);
    this.obstacles = obstacles ?? (() => false);
    this.banner = banner ?? (() => null);
  }

  get running(): boolean {
    return this.battle !== null;
  }

  get title(): string | null {
    return this.meta?.title ?? null;
  }

  /** The start message of the running battle, for pages that connect late. */
  startMessage(): object | null {
    if (!this.battle || !this.meta) return null;
    return {
      type: 'battle-start',
      title: this.meta.title,
      durationMs: this.battle.durationMs,
      elapsedMs: this.battle.timeMs,
      arena: this.battle.arena,
      // The map banner's strip of the screen, outside the arena.
      banner: this.bannerPlace ? { place: this.bannerPlace, height: config.battle.bannerHeight } : null,
      ambient: this.meta.ambient === true,
      // The arena's name, for the scoreboard and the highlights; null without one.
      place: this.battle.place,
      enrageGrow: config.skills.enrage.grow,
      sides: this.meta.sides.filter((side) => this.battle!.sides.some((s) => s.id === side.id)),
      fighters: this.battle.fighters.map((f) => ({
        name: f.name,
        color: f.color,
        emote: this.emoteOf(f),
        image: f.image ?? null,
        crown: f.crown === true,
        cls: f.class ?? null,
        minion: f.minion,
        imp: f.imp === true,
        leader: f.leader === true,
        // A double the god made: the index of the fighter it copies, else -1.
        double: f.doubleOf ? this.battle!.fighters.findIndex((o) => o.id === f.doubleOf) : -1,
        side: f.side,
        radius: f.radius * config.battle.drawnRadiusShare,
      })),
    };
  }

  /**
   * Starts a battle. `onEnd` receives the result, or null if the battle was
   * stopped early. Throws if a battle is already running.
   */
  start(setup: BattleSetup, meta: BattleMeta, onEnd?: (result: BattleResult | null) => void): void {
    if (this.battle) throw new Error('A battle is already running.');
    if (setup.obstacles === undefined && this.obstacles()) {
      // A free-for-all or the endless mode has obstacles that come and go; a team battle, a layout of its own.
      const teams = new Set(setup.sides.map((side) => side.team ?? side.id)).size;
      setup = { ...setup, obstacles: setup.endless || teams > 3 ? 'changing' : 'fixed' };
    }
    // With the map banner on, the arena is shorter by the banner's strip: nothing in the battle can reach it.
    this.bannerPlace = setup.arena ? null : this.banner();
    if (this.bannerPlace) {
      const arena = config.battle.arena;
      setup = { ...setup, arena: { ...arena, height: arena.height - config.battle.bannerHeight } };
    }
    this.battle = new Battle(setup);
    this.meta = meta;
    this.onEnd = onEnd ?? null;
    this.send(this.startMessage()!);
    const first = this.battle.obstacleFrame();
    this.send({ type: 'battle-frame', t: 0, f: this.battle.frame(), ...(first ? { o: first } : {}) });

    if (this.battle.finished) {
      this.finish(false);
      return;
    }
    const stepMs = 1000 / config.battle.stepsPerSecond;
    const startedAt = performance.now();
    let steps = 0;
    this.timer = setInterval(() => {
      const battle = this.battle;
      if (!battle) return;
      // The battle follows the clock, not the timer: a timer that fires late
      // (the server was busy) catches up with a few steps at once instead of
      // stalling the battle, which looked like a freeze on the overlay.
      const due = Math.floor((performance.now() - startedAt) / stepMs) - steps;
      const events: unknown[] = [];
      for (let i = 0; i < Math.min(Math.max(due, 1), MAX_CATCH_UP) && !battle.finished; i++) {
        battle.step();
        steps++;
        events.push(...battle.events);
      }
      // Far behind (a long pause): the battle carries on from now rather than rushing.
      if (due > MAX_CATCH_UP) steps = Math.floor((performance.now() - startedAt) / stepMs);
      const obstacles = battle.obstacleFrame();
      this.send({
        type: 'battle-frame',
        t: battle.timeMs,
        f: battle.frame(),
        // Walls, bumpers, barrels and traps, when the battle has any.
        ...(obstacles ? { o: obstacles } : {}),
        // Skills announced or cast since the last frame, for the overlay's effects.
        ...(events.length > 0 ? { e: events } : {}),
      });
      if (battle.finished) this.finish(false);
    }, stepMs);
  }

  /** Stops the running battle without a result. */
  stop(): void {
    if (this.battle) this.finish(true);
  }

  private finish(cancelled: boolean): void {
    const battle = this.battle!;
    const meta = this.meta!;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.battle = null;
    const onEnd = this.onEnd;
    this.onEnd = null;
    this.meta = null;

    const result = cancelled ? null : battle.result();
    if (!result) {
      this.send({ type: 'battle-end', cancelled: true });
    } else {
      let best: { name: string; kills: number } | null = null;
      battle.fighters.forEach((f) => {
        // The streamer's imps, the god's doubles and its minions are never the best of a fight.
        if (f.imp || f.minion || f.doubleOf) return;
        if (f.kills > 0 && (!best || f.kills > best.kills)) best = { name: f.name, kills: f.kills };
      });
      const winner = result.winner
        ? (meta.teams?.[result.winner] ?? meta.sides.find((side) => side.id === result.winner) ?? null)
        : null;
      const winners = result.sides.filter((side) => side.team === result.winner);
      this.send({
        type: 'battle-end',
        cancelled: false,
        winner: result.winner,
        winnerName: winner?.name ?? null,
        winnerColor: winner?.color ?? null,
        survivors: winners.reduce((sum, side) => sum + side.survivors, 0),
        fighters: winners.reduce((sum, side) => sum + side.fighters, 0),
        endedBy: result.endedBy,
        sides: result.sides,
        mostKills: best,
        holdMs: config.battle.resultHoldMs,
      });
    }
    onEnd?.(result);
  }
}
