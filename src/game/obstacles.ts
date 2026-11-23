import { config } from '../config.ts';
import type { Rng } from '../util/rng.ts';

/**
 * Obstacles on the battlefield: walls, pinball bumpers, rolling barrels and
 * spike traps. See `config.obstacles`. The battle owns one `Obstacles` and
 * asks it, every step, what to do to its fighters; the obstacles never decide
 * who wins, they only push, fling and hurt.
 */

export type ObstacleKind = 'wall' | 'bumper' | 'barrel' | 'trap';

/** How a battle uses obstacles: a layout for the whole fight, or ones that come and go. */
/** `hazards`: a duel's: bumpers and spike traps from the start, more coming and going, and barrels rolling in often; never walls. */
export type ObstacleMode = 'fixed' | 'changing' | 'hazards';

/** Kinds in a frame, as numbers. */
export const OBSTACLE_CODE: Record<ObstacleKind, number> = { wall: 0, bumper: 1, barrel: 2, trap: 3 };

/**
 * One obstacle in a frame: id, kind (see OBSTACLE_CODE), x, y, then
 * - wall: width, height;
 * - bumper: radius, 0;
 * - barrel: radius, how far it has rolled (an angle, times 100);
 * - trap: radius, 0;
 * then its state (bumper: 1 just bumped; barrel and wall: 1 broken; trap: 1 warning,
 * 2 striking) and how much of it is there, 0 to 100, while it appears or fades.
 */
export type FrameObstacle = [id: number, kind: number, x: number, y: number, a: number, b: number, state: number, life: number];

interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  y: number;
  /** Walls: width and height. Others: radius in `r`. */
  w: number;
  h: number;
  r: number;
  /** Barrels: velocity in units per second, how far they rolled, whom they already hit. */
  vx: number;
  vy: number;
  rolled: number;
  hits: Set<object>;
  brokenAt: number;
  /** Bumpers: lit up until this time after flinging someone. Traps: the last strike's cycle and their offset. */
  litUntil: number;
  cycle: number;
  offset: number;
  bornAt: number;
  until: number;
}

/** A fighter as obstacles see it. */
export interface ObstacleTarget {
  x: number;
  y: number;
  radius: number;
  weight: number;
  alive: boolean;
  flight: { vx: number; vy: number; until: number } | null;
  spinning: boolean;
}

/** What obstacles do to fighters; the battle carries it out. */
export interface ObstacleActions<F extends ObstacleTarget> {
  /** `kind` names what did it, for the battle's highlights. */
  hurt(fighter: F, amount: number, kind: 'barrel' | 'trap'): void;
  fling(fighter: F, vx: number, vy: number, ms: number): void;
  /** Keeps a moved fighter inside the arena and out of walls. */
  settle(fighter: F): void;
}

/** A circle obstacles keep clear of: where teams gather at the start (`soft`: planned obstacles may come nearer), or the god's middle. */
export interface ClearZone {
  x: number;
  y: number;
  r: number;
  soft?: boolean;
}

/** The arena area obstacles may stand in. */
export interface ObstacleBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function between(rng: Rng, [min, max]: [number, number]): number {
  return min + (max - min) * rng();
}

function whole(rng: Rng, range: [number, number]): number {
  return Math.floor(between(rng, [range[0], range[1] + 1 - 1e-9]));
}

/**
 * The arenas a team battle with obstacles is fought in: each a place with a
 * name (`arena.<id>.name` in the language files) and a plan of its own.
 * See `ARENA_PLANS`.
 */
export const ARENAS = ['pinball', 'fortress', 'brewery', 'spikepit', 'ruins', 'funhouse', 'gauntlet'] as const;
export type ArenaId = (typeof ARENAS)[number];

/** Where a planned obstacle stands, in shares of the arena's area (0 to 1 across and down); walls with a length in units. */
interface Spot {
  kind: 'wall' | 'bumper' | 'trap';
  x: number;
  y: number;
  /** Walls: how long, in units, or `span`, a share of the arena's width (across) or height (down); and whether it runs across (left to right) or down. */
  length?: number;
  span?: number;
  across?: boolean;
}

/** What an arena may add during a long battle: a kind, and for walls a length range in units. */
interface ArenaAdd {
  kind: 'wall' | 'bumper' | 'trap';
  length?: [number, number];
}

interface ArenaPlan {
  /** The obstacles at the start, before the variation (mirroring, a little shift, a few left out). */
  spots(rng: Rng): Spot[];
  /** Barrels: the edges they roll in from (0 left, 1 right, 2 top, 3 bottom), how often, how many at once, where along the edge, how slanted. */
  barrels?: { edges: number[]; everyMs: [number, number]; wave: [number, number]; along: [number, number]; slant: number };
  /** During a long battle, obstacles of these kinds come and go: each fits the place. */
  adds: ArenaAdd[];
}

/** Points on an ellipse around the middle, `count` of them from `turn` (a share of a circle). */
function ring(kind: Spot['kind'], count: number, rx: number, ry: number, turn: number): Spot[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (turn + i / count) * Math.PI * 2;
    return { kind, x: 0.5 + Math.cos(angle) * rx, y: 0.5 + Math.sin(angle) * ry };
  });
}

/**
 * The arenas' plans:
 * - Pinball Hall: bumpers in a diamond, barrels and fighters bounce around.
 * - Fortress: four walls around the middle with gaps at the corners, spike traps before them.
 * - Brewery: barrels roll in from the sides in waves; crates (short walls) to hide behind.
 * - Spike Pit: a grid of spike traps with lanes between.
 * - Ruins: broken walls all over.
 * - Funhouse: a ring of bumpers with traps between.
 * - Gauntlet: a corridor through the middle, barrels rolling down it.
 */
const ARENA_PLANS: Record<ArenaId, ArenaPlan> = {
  pinball: {
    spots: () => [
      [0.5, 0.24], [0.5, 0.76], [0.43, 0.37], [0.57, 0.37], [0.43, 0.63], [0.57, 0.63],
    ].map(([x, y]) => ({ kind: 'bumper' as const, x: x!, y: y! })),
    adds: [{ kind: 'bumper' }],
  },
  fortress: {
    spots: (rng) => [
      { kind: 'wall', x: 0.5, y: 0.25, span: 0.22, across: true },
      { kind: 'wall', x: 0.5, y: 0.75, span: 0.22, across: true },
      { kind: 'wall', x: 0.34, y: 0.5, span: 0.3, across: false },
      { kind: 'wall', x: 0.66, y: 0.5, span: 0.3, across: false },
      ...[[0.31, 0.2], [0.69, 0.8], [0.31, 0.8], [0.69, 0.2]].slice(0, rng() < 0.5 ? 2 : 4).map(([x, y]) => ({ kind: 'trap' as const, x: x!, y: y! })),
    ],
    adds: [{ kind: 'trap' }, { kind: 'wall', length: [3, 5] }],
  },
  brewery: {
    spots: () => [
      { kind: 'wall', x: 0.38, y: 0.3, length: 2.5, across: true },
      { kind: 'wall', x: 0.62, y: 0.7, length: 2.5, across: true },
      { kind: 'wall', x: 0.62, y: 0.3, length: 2.5, across: false },
      { kind: 'wall', x: 0.38, y: 0.7, length: 2.5, across: false },
    ],
    barrels: { edges: [0, 1], everyMs: [2_600, 4_600], wave: [1, 2], along: [0.1, 0.9], slant: 0.3 },
    adds: [{ kind: 'wall', length: [2, 3] }],
  },
  spikepit: {
    spots: () => [
      [0.3, 0.3], [0.43, 0.3], [0.57, 0.3], [0.7, 0.3], [0.3, 0.7], [0.43, 0.7], [0.57, 0.7], [0.7, 0.7], [0.365, 0.5], [0.635, 0.5],
    ].map(([x, y]) => ({ kind: 'trap' as const, x: x!, y: y! })),
    adds: [{ kind: 'trap' }],
  },
  ruins: {
    spots: (rng) =>
      // More than are kept: those that land too near the teams or each other are left out.
      Array.from({ length: 6 + Math.floor(rng() * 3) }, () => ({
        kind: 'wall' as const,
        x: 0.15 + rng() * 0.7,
        y: 0.15 + rng() * 0.7,
        length: 2.5 + rng() * 2,
        across: rng() < 0.5,
      })),
    adds: [{ kind: 'wall', length: [2.5, 4.5] }],
  },
  funhouse: {
    spots: () => [...ring('bumper', 5, 0.2, 0.3, 0), ...ring('trap', 3, 0.33, 0.38, 1 / 12)],
    adds: [{ kind: 'bumper' }, { kind: 'trap' }],
  },
  gauntlet: {
    spots: () => [
      { kind: 'wall', x: 0.5, y: 0.36, span: 0.26, across: true },
      { kind: 'wall', x: 0.5, y: 0.64, span: 0.26, across: true },
    ],
    barrels: { edges: [0, 1], everyMs: [3_400, 5_400], wave: [1, 2], along: [0.45, 0.55], slant: 0 },
    adds: [{ kind: 'trap' }],
  },
};

export class Obstacles {
  private list: Obstacle[] = [];
  private nextId = 1;
  /** Fixed layouts with barrels: when the next one rolls in. Changing mode: when the next obstacle appears. */
  private nextBarrelAt = Infinity;
  private nextChangeAt = Infinity;
  /** Barrels still to come in a wave, and when. */
  private wave: { at: number; edge: number; along: number; slant?: number }[] = [];
  /** The arena of a team battle with obstacles: its name, how many obstacles it started with, and when it changes next. */
  readonly arena: ArenaId | null = null;
  private startCount = 0;
  private nextArenaChangeAt = Infinity;
  /** A duel's hazards: see `ObstacleMode`. */
  private hazards = false;

  private readonly rng: Rng;
  private readonly unit: number;
  private readonly bounds: ObstacleBounds;
  private readonly zones: ClearZone[];

  private constructor(rng: Rng, unit: number, bounds: ObstacleBounds, zones: ClearZone[], arena: ArenaId | null = null) {
    this.arena = arena;
    this.rng = rng;
    this.unit = unit;
    this.bounds = bounds;
    this.zones = zones;
  }

  /**
   * Obstacles for one battle, or null when it gets none. A team battle gets
   * an arena with `config.obstacles.chance` (or the one asked for): its plan,
   * varied a little, and changes during the battle. A changing battle always
   * gets obstacles, a few at a time.
   */
  static create(mode: ObstacleMode, rng: Rng, unit: number, bounds: ObstacleBounds, zones: ClearZone[], arena?: ArenaId): Obstacles | null {
    if (mode === 'changing') {
      const obstacles = new Obstacles(rng, unit, bounds, zones);
      obstacles.nextChangeAt = between(rng, [3_000, 7_000]);
      return obstacles;
    }
    if (mode === 'hazards') {
      const { hazards } = config.obstacles;
      const obstacles = new Obstacles(rng, unit, bounds, zones);
      obstacles.hazards = true;
      for (let i = 0; i < hazards.bumpers; i++) obstacles.place('bumper', 0, Infinity, undefined, [], hazards.spacing, hazards.zoneShare);
      for (let i = 0; i < hazards.traps; i++) obstacles.place('trap', 0, Infinity, undefined, [], hazards.spacing, hazards.zoneShare);
      obstacles.nextBarrelAt = between(rng, hazards.barrelEveryMs);
      obstacles.nextChangeAt = between(rng, hazards.changeEveryMs);
      return obstacles;
    }
    if (!arena && rng() >= config.obstacles.chance) return null;
    const id = arena ?? ARENAS[Math.floor(rng() * ARENAS.length)]!;
    const obstacles = new Obstacles(rng, unit, bounds, zones, id);
    const plan = ARENA_PLANS[id];
    // The variation: mirrored either way, shifted a little, and now and then one left out
    // (never one of the long walls that make the place, such as the Gauntlet's corridor).
    const flipX = rng() < 0.5;
    const flipY = rng() < 0.5;
    for (const spot of plan.spots(rng)) {
      if (rng() < 0.12 && spot.span === undefined) continue;
      const x = flipX ? 1 - spot.x : spot.x;
      const y = flipY ? 1 - spot.y : spot.y;
      obstacles.placeAt(spot, x + (rng() - 0.5) * 0.03, y + (rng() - 0.5) * 0.03);
    }
    obstacles.startCount = obstacles.list.length;
    if (plan.barrels) obstacles.nextBarrelAt = between(rng, [1_200, 2_500]);
    obstacles.nextArenaChangeAt = config.obstacles.arena.changeAfterMs;
    return obstacles;
  }

  /** Whether there is anything at all: an empty layout is not sent to the overlay. */
  get empty(): boolean {
    return this.list.length === 0 && this.nextBarrelAt === Infinity && this.nextChangeAt === Infinity;
  }

  /**
   * Whether an obstacle of half size `halfW` by `halfH` (a circle when
   * `round`) at x, y keeps clear of the clear zones (their radius times
   * `zoneShare`), of the other obstacles by `spacing` units, and of the
   * fighters standing in `avoid`.
   */
  private free(
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    round: boolean,
    { zoneShare = 1, spacing = 2.5, avoid = [] as readonly ObstacleTarget[] } = {},
  ): boolean {
    const u = this.unit;
    /** How far a point is from this obstacle's edge. */
    const away = (px: number, py: number) =>
      round
        ? Math.hypot(px - x, py - y) - halfW
        : Math.hypot(Math.max(0, Math.abs(px - x) - halfW), Math.max(0, Math.abs(py - y) - halfH));
    return (
      this.zones.every((zone) => away(zone.x, zone.y) > zone.r * (zone.soft ? zoneShare : 1)) &&
      avoid.every((fighter) => !fighter.alive || away(fighter.x, fighter.y) > fighter.radius * 1.5) &&
      this.list.every((other) => {
        if (other.kind === 'barrel' || other.brokenAt > 0 || other.until !== Infinity) return true;
        if (other.kind !== 'wall') return away(other.x, other.y) > other.r + spacing * u;
        // Two rectangles (or a circle's box and a rectangle): the gap between them.
        const gapX = Math.abs(other.x - x) - other.w / 2 - halfW;
        const gapY = Math.abs(other.y - y) - other.h / 2 - halfH;
        return Math.max(gapX, gapY) > spacing * u;
      })
    );
  }

  /** The size of a new obstacle: walls of a length in units (or a share of the arena), the others their radius. */
  private shape(kind: 'wall' | 'bumper' | 'trap', length: number, span: number | undefined, across: boolean) {
    const u = this.unit;
    if (kind !== 'wall') {
      const r = config.obstacles[kind].radius * u;
      return { w: 0, h: 0, r, halfW: r, halfH: r };
    }
    const { left, top, right, bottom } = this.bounds;
    const long = span !== undefined ? span * (across ? right - left : bottom - top) : length * u;
    const thick = config.obstacles.wall.thickness * u;
    const w = across ? long : thick;
    const h = across ? thick : long;
    return { w, h, r: Math.hypot(w, h) / 2, halfW: w / 2, halfH: h / 2 };
  }

  /** Puts an obstacle somewhere free: away from the clear zones and the other obstacles. False when no place was found. */
  private place(
    kind: 'wall' | 'bumper' | 'trap',
    now: number,
    until: number,
    length?: [number, number],
    avoid: readonly ObstacleTarget[] = [],
    spacing = 2.5,
    zoneShare = 1,
  ): boolean {
    const shape = this.shape(kind, between(this.rng, length ?? config.obstacles.wall.length), undefined, this.rng() < 0.5);
    const u = this.unit;
    const { left, top, right, bottom } = this.bounds;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = left + shape.halfW + u + this.rng() * Math.max(0, right - left - 2 * (shape.halfW + u));
      const y = top + shape.halfH + u + this.rng() * Math.max(0, bottom - top - 2 * (shape.halfH + u));
      if (!this.free(x, y, shape.halfW, shape.halfH, kind !== 'wall', { avoid, spacing, zoneShare })) continue;
      this.list.push(this.make(kind, x, y, shape.w, shape.h, shape.r, now, until));
      return true;
    }
    return false;
  }

  /**
   * Puts a planned obstacle at its spot (shares of the arena), also where a
   * team gathers at the start: fighters placed on a wall are moved off it,
   * and nothing acts before `config.obstacles.quietMs`. Where it would be in
   * the god's way or on another obstacle, it is left out. Planned obstacles
   * may stand nearer to each other than random ones.
   */
  private placeAt(spot: Spot, fx: number, fy: number): void {
    const shape = this.shape(spot.kind, spot.length ?? 4, spot.span, spot.across ?? true);
    const { left, top, right, bottom } = this.bounds;
    const u = this.unit;
    const x = Math.max(left + shape.halfW + u, Math.min(right - shape.halfW - u, left + fx * (right - left)));
    const y = Math.max(top + shape.halfH + u, Math.min(bottom - shape.halfH - u, top + fy * (bottom - top)));
    const round = spot.kind !== 'wall';
    if (this.free(x, y, shape.halfW, shape.halfH, round, { zoneShare: 0, spacing: 0.6 })) {
      this.list.push(this.make(spot.kind, x, y, shape.w, shape.h, shape.r, 0, Infinity));
    }
  }

  /**
   * One change to an arena during a long battle: an obstacle that fits it
   * fades away, or a new one rises somewhere free. The arena keeps about as
   * many as it started with.
   */
  private changeArena(now: number, fighters: readonly ObstacleTarget[]): void {
    const plan = ARENA_PLANS[this.arena!];
    const standing = this.list.filter((o) => o.kind !== 'barrel' && o.until === Infinity && o.brokenAt === 0);
    const removable = standing.filter((o) => plan.adds.some((add) => add.kind === o.kind));
    const fewest = Math.max(1, this.startCount - 2);
    const most = this.startCount + 2;
    const remove = removable.length > 0 && standing.length > fewest && (standing.length >= most || this.rng() < 0.5);
    if (remove) {
      const going = removable[Math.floor(this.rng() * removable.length)]!;
      going.until = now + config.obstacles.fadeMs;
      return;
    }
    const add = plan.adds[Math.floor(this.rng() * plan.adds.length)]!;
    // Not on top of anyone: it rises where nobody stands, as near to the others as the plan's own.
    this.place(add.kind, now, Infinity, add.length, fighters, 0.6);
  }

  /**
   * The god rampaging through walls: every wall its circle touches breaks.
   * Returns how many broke.
   */
  smash(x: number, y: number, r: number, now: number): number {
    let broken = 0;
    for (const wall of this.list) {
      if (wall.kind !== 'wall' || !this.solid(wall, now)) continue;
      const dx = Math.max(0, Math.abs(x - wall.x) - wall.w / 2);
      const dy = Math.max(0, Math.abs(y - wall.y) - wall.h / 2);
      if (Math.hypot(dx, dy) > r) continue;
      wall.brokenAt = now;
      broken++;
    }
    return broken;
  }

  /**
   * A fighter thrown through the air into a bumper or a wall bounces off it:
   * returns its new direction (a bumper lights up), or null when it hit nothing.
   */
  deflect(x: number, y: number, r: number, vx: number, vy: number, now: number): { vx: number; vy: number; bumper: boolean } | null {
    for (const o of this.list) {
      if (!this.solid(o, now)) continue;
      if (o.kind === 'bumper') {
        const dx = x - o.x;
        const dy = y - o.y;
        const d = Math.hypot(dx, dy);
        if (d >= o.r + r || d < 1e-6) continue;
        const nx = dx / d;
        const ny = dy / d;
        const along = vx * nx + vy * ny;
        o.litUntil = now + 250;
        // Away from the bumper, as off a pinball post.
        return along < 0 ? { vx: vx - 2 * along * nx, vy: vy - 2 * along * ny, bumper: true } : { vx, vy, bumper: true };
      }
      if (o.kind === 'wall') {
        const px = Math.abs(x - o.x) - o.w / 2;
        const py = Math.abs(y - o.y) - o.h / 2;
        if (px >= r || py >= r) continue;
        // Off the side it came through: the one it is least deep in.
        if (px > py) return { vx: Math.sign(x - o.x) * Math.abs(vx), vy, bumper: false };
        return { vx, vy: Math.sign(y - o.y) * Math.abs(vy), bumper: false };
      }
    }
    return null;
  }

  private make(kind: ObstacleKind, x: number, y: number, w: number, h: number, r: number, now: number, until: number): Obstacle {
    return {
      id: this.nextId++,
      kind,
      x,
      y,
      w,
      h,
      r,
      vx: 0,
      vy: 0,
      rolled: 0,
      hits: new Set(),
      brokenAt: 0,
      litUntil: 0,
      cycle: -1,
      offset: this.rng() * config.obstacles.trap.periodMs,
      bornAt: now,
      until,
    };
  }

  /** A barrel rolling in from an edge (0 left, 1 right, 2 top, 3 bottom), `along` it from 0 to 1. */
  private rollBarrel(now: number, edge: number, along: number, slantBy = 0.5): void {
    const { radius, speed } = config.obstacles.barrel;
    const r = radius * this.unit;
    const { left, top, right, bottom } = this.bounds;
    const x = edge === 0 ? left - r : edge === 1 ? right + r : left + r + along * (right - left - 2 * r);
    const y = edge === 2 ? top - r : edge === 3 ? bottom + r : top + r + along * (bottom - top - 2 * r);
    // Mostly straight across, a little slanted.
    const slant = (this.rng() - 0.5) * slantBy;
    const [dx, dy] = edge === 0 ? [1, slant] : edge === 1 ? [-1, slant] : edge === 2 ? [slant, 1] : [slant, -1];
    const length = Math.hypot(dx, dy);
    // A barrel needs no fading in: it rolls in from outside the field.
    const barrel = this.make('barrel', x, y, 0, 0, r, 0, Infinity);
    barrel.vx = (dx / length) * speed;
    barrel.vy = (dy / length) * speed;
    this.list.push(barrel);
  }

  /** How much of an obstacle is there, 0 to 1: it fades in after it appears and out before it goes. */
  private presence(obstacle: Obstacle, now: number): number {
    const fade = config.obstacles.fadeMs;
    const appear = obstacle.bornAt === 0 ? 1 : (now - obstacle.bornAt) / fade;
    const leave = obstacle.until === Infinity ? 1 : (obstacle.until - now) / fade;
    return Math.max(0, Math.min(1, appear, leave));
  }

  /** Whether an obstacle blocks and acts: fully there, and for a barrel, not broken. */
  private solid(obstacle: Obstacle, now: number): boolean {
    return this.presence(obstacle, now) >= 1 && obstacle.brokenAt === 0;
  }

  /** Walls that stand in the way now, as rectangles. */
  walls(now: number): { left: number; top: number; right: number; bottom: number }[] {
    return this.list
      .filter((o) => o.kind === 'wall' && this.solid(o, now))
      .map((o) => ({ left: o.x - o.w / 2, top: o.y - o.h / 2, right: o.x + o.w / 2, bottom: o.y + o.h / 2 }));
  }

  /** Bumpers that stand in the way now, as circles. */
  posts(now: number): ClearZone[] {
    return this.list.filter((o) => o.kind === 'bumper' && this.solid(o, now)).map((o) => ({ x: o.x, y: o.y, r: o.r }));
  }

  /** One step: obstacles come and go, barrels roll, bumpers fling, traps strike. */
  update<F extends ObstacleTarget>(now: number, dt: number, fighters: readonly F[], act: ObstacleActions<F>): void {
    const settings = config.obstacles;
    const grounded = fighters.filter((f) => f.alive && !f.flight && !f.spinning);

    // New obstacles: barrels of a fixed layout, or anything in a changing battle.
    if (now >= this.nextBarrelAt) {
      const barrels = this.arena ? ARENA_PLANS[this.arena].barrels : undefined;
      if (barrels) {
        // The arena's own: from its edges, in waves one behind the other.
        const edge = barrels.edges[Math.floor(this.rng() * barrels.edges.length)]!;
        const count = whole(this.rng, barrels.wave);
        for (let i = 0; i < count; i++) this.wave.push({ at: now + i * 650, edge, along: between(this.rng, barrels.along), slant: barrels.slant });
        this.nextBarrelAt = now + between(this.rng, barrels.everyMs);
      } else {
        this.rollBarrel(now, Math.floor(this.rng() * 4), this.rng());
        this.nextBarrelAt = now + between(this.rng, this.hazards ? settings.hazards.barrelEveryMs : settings.barrel.everyMs);
      }
    }
    if (now >= this.nextArenaChangeAt) {
      this.changeArena(now, grounded);
      this.nextArenaChangeAt = now + between(this.rng, settings.arena.changeEveryMs);
    }
    if (now >= this.nextChangeAt && this.hazards) {
      // A duel's hazards: a bumper or a trap more, for a while, or a wave of barrels.
      this.nextChangeAt = now + between(this.rng, settings.hazards.changeEveryMs);
      const standing = this.list.filter((o) => o.kind !== 'barrel').length;
      const roll = this.rng();
      if (roll < 0.3) {
        const edge = Math.floor(this.rng() * 4);
        for (let i = 0; i < 3; i++) this.wave.push({ at: now + i * 650, edge, along: 0.2 + 0.6 * this.rng() });
      } else if (standing < settings.hazards.max) {
        this.place(roll < 0.65 ? 'bumper' : 'trap', now, now + between(this.rng, settings.changing.lifeMs), undefined, grounded, settings.hazards.spacing, settings.hazards.zoneShare);
      }
    } else if (now >= this.nextChangeAt) {
      this.nextChangeAt = now + between(this.rng, settings.changing.everyMs);
      const standing = this.list.filter((o) => o.kind !== 'barrel').length;
      const roll = this.rng();
      if (roll < 0.25) {
        // A wave of barrels from one edge.
        const edge = Math.floor(this.rng() * 4);
        for (let i = 0; i < 3; i++) this.wave.push({ at: now + i * 650, edge, along: 0.2 + 0.6 * this.rng() });
      } else if (standing < settings.changing.max) {
        const kind = roll < 0.5 ? 'wall' : roll < 0.75 ? 'bumper' : 'trap';
        const count = kind === 'wall' ? 1 : 2;
        const life = between(this.rng, settings.changing.lifeMs);
        for (let i = 0; i < count; i++) this.place(kind, now, now + life);
      }
    }
    for (const next of this.wave.filter((w) => w.at <= now)) this.rollBarrel(now, next.edge, next.along, next.slant);
    this.wave = this.wave.filter((w) => w.at > now);

    // A wall that has just become solid pushes out whoever stands where it rose.
    for (const wall of this.list) {
      if (wall.kind === 'wall' && wall.bornAt > 0 && now - wall.bornAt >= settings.fadeMs && now - wall.bornAt < settings.fadeMs + dt * 1000) {
        for (const fighter of grounded) act.settle(fighter);
      }
    }

    for (const obstacle of this.list) {
      if (!this.solid(obstacle, now)) continue;
      // The first moments are quiet: the teams find their feet, also where an arena put a bumper or a trap among them.
      if (now < settings.quietMs && obstacle.kind !== 'barrel') continue;
      if (obstacle.kind === 'bumper') this.bump(obstacle, now, grounded, act);
      else if (obstacle.kind === 'barrel') this.roll(obstacle, now, dt, grounded, act);
      else if (obstacle.kind === 'trap') this.spring(obstacle, now, grounded, act);
    }

    // Gone: faded out, broken a while ago, or rolled off the field.
    const { left, top, right, bottom } = this.bounds;
    this.list = this.list.filter((o) => {
      if (o.until <= now) return false;
      if (o.brokenAt > 0 && now - o.brokenAt > 450) return false;
      if (o.kind === 'barrel') {
        const margin = o.r * 2;
        return o.x > left - margin && o.x < right + margin && o.y > top - margin && o.y < bottom + margin;
      }
      return true;
    });
  }

  /** A bumper flings whoever touches it straight away from its middle. Heavy fighters, like the god, only lean on it. */
  private bump<F extends ObstacleTarget>(bumper: Obstacle, now: number, fighters: readonly F[], act: ObstacleActions<F>): void {
    for (const fighter of fighters) {
      if (fighter.flight || fighter.weight > 3) continue;
      const dx = fighter.x - bumper.x;
      const dy = fighter.y - bumper.y;
      const d = Math.hypot(dx, dy);
      if (d > bumper.r + fighter.radius + 1.5) continue;
      const [ux, uy] = d < 1e-6 ? [1, 0] : [dx / d, dy / d];
      act.fling(fighter, ux, uy, config.obstacles.bumper.flingMs);
      bumper.litUntil = now + 250;
    }
  }

  /** A barrel rolls on: it knocks fighters aside and hurts them once each, bounces off bumpers and breaks on walls. */
  private roll<F extends ObstacleTarget>(barrel: Obstacle, now: number, dt: number, fighters: readonly F[], act: ObstacleActions<F>): void {
    const { damage, knock } = config.obstacles.barrel;
    barrel.x += barrel.vx * dt;
    barrel.y += barrel.vy * dt;
    barrel.rolled += (Math.hypot(barrel.vx, barrel.vy) * dt) / barrel.r;
    for (const wall of this.walls(now)) {
      const nx = Math.max(wall.left, Math.min(barrel.x, wall.right));
      const ny = Math.max(wall.top, Math.min(barrel.y, wall.bottom));
      if (Math.hypot(barrel.x - nx, barrel.y - ny) < barrel.r) {
        barrel.brokenAt = now;
        return;
      }
    }
    for (const post of this.posts(now)) {
      const dx = barrel.x - post.x;
      const dy = barrel.y - post.y;
      const d = Math.hypot(dx, dy);
      if (d >= post.r + barrel.r || d < 1e-6) continue;
      // Reflected like a ball off a pinball post.
      const nx = dx / d;
      const ny = dy / d;
      const along = barrel.vx * nx + barrel.vy * ny;
      if (along < 0) {
        barrel.vx -= 2 * along * nx;
        barrel.vy -= 2 * along * ny;
      }
      barrel.x = post.x + nx * (post.r + barrel.r);
      barrel.y = post.y + ny * (post.r + barrel.r);
      const bumper = this.list.find((o) => o.kind === 'bumper' && o.x === post.x && o.y === post.y);
      if (bumper) bumper.litUntil = now + 250;
    }
    const speed = Math.hypot(barrel.vx, barrel.vy);
    for (const fighter of fighters) {
      const dx = fighter.x - barrel.x;
      const dy = fighter.y - barrel.y;
      if (Math.hypot(dx, dy) > barrel.r + fighter.radius) continue;
      if (fighter.weight > 3) {
        // The god stops a barrel dead: it breaks on it.
        barrel.brokenAt = now;
        act.hurt(fighter, damage, 'barrel');
        return;
      }
      if (barrel.hits.has(fighter)) continue;
      barrel.hits.add(fighter);
      act.hurt(fighter, damage, 'barrel');
      // Knocked to the side of the barrel's path it stood on.
      const side = (dx * -barrel.vy + dy * barrel.vx) / speed >= 0 ? 1 : -1;
      act.fling(fighter, (-barrel.vy / speed) * side, (barrel.vx / speed) * side, (knock * this.unit * 1000) / config.skills.shockwave.launchSpeed);
    }
  }

  /** A spike trap strikes once per cycle, everyone on it, after a warning the overlay shows. */
  private spring<F extends ObstacleTarget>(trap: Obstacle, now: number, fighters: readonly F[], act: ObstacleActions<F>): void {
    const { periodMs, strikeMs, damage } = config.obstacles.trap;
    const time = now + trap.offset;
    const cycle = Math.floor(time / periodMs);
    const phase = time - cycle * periodMs;
    if (phase < periodMs - strikeMs || cycle === trap.cycle) return;
    trap.cycle = cycle;
    for (const fighter of fighters) {
      if (Math.hypot(fighter.x - trap.x, fighter.y - trap.y) <= trap.r + fighter.radius * 0.4) act.hurt(fighter, damage, 'trap');
    }
  }

  /** The obstacles for the overlay. */
  frame(now: number): FrameObstacle[] {
    const { periodMs, warnMs, strikeMs } = config.obstacles.trap;
    return this.list.map((o) => {
      let state = 0;
      if (o.kind === 'bumper') state = o.litUntil > now ? 1 : 0;
      if (o.kind === 'barrel' || o.kind === 'wall') state = o.brokenAt > 0 ? 1 : 0;
      if (o.kind === 'trap') {
        const phase = (now + o.offset) % periodMs;
        state = phase >= periodMs - strikeMs ? 2 : phase >= periodMs - strikeMs - warnMs ? 1 : 0;
      }
      const a = o.kind === 'wall' ? o.w : o.r;
      const b = o.kind === 'wall' ? o.h : o.kind === 'barrel' ? o.rolled * 100 : 0;
      return [o.id, OBSTACLE_CODE[o.kind], Math.round(o.x), Math.round(o.y), Math.round(a), Math.round(b), state, Math.round(this.presence(o, now) * 100)];
    });
  }
}
