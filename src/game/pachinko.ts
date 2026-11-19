import { config } from '../config.ts';
import type { Rng } from '../util/rng.ts';

/** One ball: who it is, the way it bounces (0 left, 1 right, one per row of pins), and where it lands. */
export interface PachinkoDrop<P> {
  player: P;
  path: number[];
  slot: number;
  points: number;
  /** When it is dropped, in milliseconds after the boards appear. */
  at: number;
}

export interface PachinkoBoard<P> {
  team: string;
  drops: PachinkoDrop<P>[];
  total: number;
  /** How many balls landed in the best slots: the first tie-break. */
  jackpots: number;
}

export interface PachinkoGame<P> {
  boards: PachinkoBoard<P>[];
  /** The winning team, or null with no boards. */
  winner: string | null;
  /** From the first drop until the last ball has landed. */
  durationMs: number;
}

/** The way one ball bounces down the pins: left or right at each row, by chance. */
export function dropPath(rng: Rng, rows = config.pachinko.rows): { path: number[]; slot: number } {
  const path = Array.from({ length: rows }, () => (rng() < 0.5 ? 0 : 1));
  return { path, slot: path.reduce<number>((sum, step) => sum + step, 0) };
}

/** How long a ball takes from the top to its slot. */
export function fallMs(): number {
  return (config.pachinko.rows + 1) * config.pachinko.hopMs;
}

/**
 * Plays pachinko for some teams. Every player drops once; a team with fewer
 * players drops some of them again, in turn, until every team has dropped as
 * many balls as the largest, and at least `config.pachinko.minBalls`. Highest total wins; a tie goes to the team with
 * more balls in the best slots, then by lot.
 */
export function playPachinko<P>(teams: { team: string; players: P[] }[], rng: Rng): PachinkoGame<P> {
  const { slots, targetMs, minGapMs, maxGapMs, minBalls } = config.pachinko;
  const best = Math.max(...slots);
  const playing = teams.filter((t) => t.players.length > 0);
  const balls = playing.length === 0 ? 0 : Math.max(minBalls, ...playing.map((t) => t.players.length));
  // One ball at a time, the boards taking turns: everyone watches each drop.
  const total = balls * playing.length;
  const gap = Math.min(maxGapMs, Math.max(minGapMs, (targetMs - fallMs()) / Math.max(1, total - 1)));
  const boards: PachinkoBoard<P>[] = playing.map((t, board) => {
    const drops: PachinkoDrop<P>[] = [];
    for (let i = 0; i < balls; i++) {
      const { path, slot } = dropPath(rng);
      const at = (i * playing.length + board) * gap;
      drops.push({ player: t.players[i % t.players.length]!, path, slot, points: slots[slot]!, at });
    }
    return {
      team: t.team,
      drops,
      total: drops.reduce((sum, d) => sum + d.points, 0),
      jackpots: drops.filter((d) => d.points === best).length,
    };
  });
  const ranked = boards
    .map((board) => ({ board, lot: rng() }))
    .sort((a, b) => b.board.total - a.board.total || b.board.jackpots - a.board.jackpots || b.lot - a.lot);
  return {
    boards,
    winner: ranked[0]?.board.team ?? null,
    durationMs: total > 0 ? (total - 1) * gap + fallMs() : 0,
  };
}
