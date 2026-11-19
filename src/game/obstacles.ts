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
export type ObstacleMode = 'fixed' | 'changing';

/** Kinds in a frame, as numbers. */
export const OBSTACLE_CODE: Record<ObstacleKind, number> = { wall: 0, bumper: 1, barrel: 2, trap: 3 };

/**
 * One obstacle in a frame: id, kind (see OBSTACLE_CODE), x, y, then
 * - wall: width, height;
 * - bumper: radius, 0;
 * - barrel: radius, how far it has rolled (an angle, times 100);
 * - trap: radius, 0;
 * then its state (bumper: 1 just bumped; barrel: 1 broken; trap: 1 warning,
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
  hurt(fighter: F, amount: number): void;
  fling(fighter: F, vx: number, vy: number, ms: number): void;
  /** Keeps a moved fighter inside the arena and out of walls. */
  settle(fighter: F): void;
}

/** A circle obstacles keep clear of: where teams gather at the start, or the god's middle. */
export interface ClearZone {
  x: number;
  y: number;
  r: number;
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

export class Obstacles {
  private list: Obstacle[] = [];
  private nextId = 1;
  /** Fixed layouts with barrels: when the next one rolls in. Changing mode: when the next obstacle appears. */
  private nextBarrelAt = Infinity;
  private nextChangeAt = Infinity;
  /** Barrels still to come in a wave, and when. */
  private wave: { at: number; edge: number; along: number }[] = [];

  private readonly rng: Rng;
  private readonly unit: number;
  private readonly bounds: ObstacleBounds;
  private readonly zones: ClearZone[];

  private constructor(rng: Rng, unit: number, bounds: ObstacleBounds, zones: ClearZone[]) {
    this.rng = rng;
    this.unit = unit;
    this.bounds = bounds;
    this.zones = zones;
  }

  /**
   * Obstacles for one battle, or null when it gets none. A fixed layout comes
   * with `config.obstacles.chance`; a changing battle always gets them, a few
   * at a time.
   */
  static create(mode: ObstacleMode, rng: Rng, unit: number, bounds: ObstacleBounds, zones: ClearZone[]): Obstacles | null {
    const obstacles = new Obstacles(rng, unit, bounds, zones);
    const settings = config.obstacles;
    if (mode === 'changing') {
      obstacles.nextChangeAt = between(rng, [3_000, 7_000]);
      return obstacles;
    }
    if (rng() >= settings.chance) return null;
    const kinds: ('walls' | 'bumpers' | 'traps' | 'barrels')[] = ['walls', 'bumpers', 'traps', 'barrels'];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
    }
    for (const kind of kinds.slice(0, rng() < 0.5 ? 1 : 2)) {
      if (kind === 'barrels') obstacles.nextBarrelAt = between(rng, [1_500, 3_000]);
      else {
        const one = kind === 'walls' ? 'wall' : kind === 'bumpers' ? 'bumper' : 'trap';
        const count = whole(rng, settings[one].count);
        for (let i = 0; i < count; i++) obstacles.place(one, 0, Infinity);
      }
    }
    return obstacles;
  }

  /** Whether there is anything at all: an empty layout is not sent to the overlay. */
  get empty(): boolean {
    return this.list.length === 0 && this.nextBarrelAt === Infinity && this.nextChangeAt === Infinity;
  }

  /** Puts an obstacle somewhere free: away from the clear zones and the other obstacles. False when no place was found. */
  private place(kind: 'wall' | 'bumper' | 'trap', now: number, until: number): boolean {
    const settings = config.obstacles;
    const u = this.unit;
    let w = 0;
    let h = 0;
    let r = 0;
    if (kind === 'wall') {
      const length = between(this.rng, settings.wall.length) * u;
      const thick = settings.wall.thickness * u;
      const across = this.rng() < 0.5;
      w = across ? length : thick;
      h = across ? thick : length;
      r = Math.hypot(w, h) / 2;
    } else {
      r = settings[kind].radius * u;
    }
    const { left, top, right, bottom } = this.bounds;
    const halfW = kind === 'wall' ? w / 2 : r;
    const halfH = kind === 'wall' ? h / 2 : r;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = left + halfW + u + this.rng() * Math.max(0, right - left - 2 * (halfW + u));
      const y = top + halfH + u + this.rng() * Math.max(0, bottom - top - 2 * (halfH + u));
      const free =
        this.zones.every((zone) => Math.hypot(zone.x - x, zone.y - y) > zone.r + r) &&
        this.list.every((other) => other.kind === 'barrel' || Math.hypot(other.x - x, other.y - y) > other.r + r + 2.5 * u);
      if (!free) continue;
      this.list.push(this.make(kind, x, y, w, h, r, now, until));
      return true;
    }
    return false;
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
  private rollBarrel(now: number, edge: number, along: number): void {
    const { radius, speed } = config.obstacles.barrel;
    const r = radius * this.unit;
    const { left, top, right, bottom } = this.bounds;
    const x = edge === 0 ? left - r : edge === 1 ? right + r : left + r + along * (right - left - 2 * r);
    const y = edge === 2 ? top - r : edge === 3 ? bottom + r : top + r + along * (bottom - top - 2 * r);
    // Mostly straight across, a little slanted.
    const slant = (this.rng() - 0.5) * 0.5;
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
      this.rollBarrel(now, Math.floor(this.rng() * 4), this.rng());
      this.nextBarrelAt = now + between(this.rng, settings.barrel.everyMs);
    }
    if (now >= this.nextChangeAt) {
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
    for (const next of this.wave.filter((w) => w.at <= now)) this.rollBarrel(now, next.edge, next.along);
    this.wave = this.wave.filter((w) => w.at > now);

    // A wall that has just become solid pushes out whoever stands where it rose.
    for (const wall of this.list) {
      if (wall.kind === 'wall' && wall.bornAt > 0 && now - wall.bornAt >= settings.fadeMs && now - wall.bornAt < settings.fadeMs + dt * 1000) {
        for (const fighter of grounded) act.settle(fighter);
      }
    }

    for (const obstacle of this.list) {
      if (!this.solid(obstacle, now)) continue;
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
        act.hurt(fighter, damage);
        return;
      }
      if (barrel.hits.has(fighter)) continue;
      barrel.hits.add(fighter);
      act.hurt(fighter, damage);
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
      if (Math.hypot(fighter.x - trap.x, fighter.y - trap.y) <= trap.r + fighter.radius * 0.4) act.hurt(fighter, damage);
    }
  }

  /** The obstacles for the overlay. */
  frame(now: number): FrameObstacle[] {
    const { periodMs, warnMs, strikeMs } = config.obstacles.trap;
    return this.list.map((o) => {
      let state = 0;
      if (o.kind === 'bumper') state = o.litUntil > now ? 1 : 0;
      if (o.kind === 'barrel') state = o.brokenAt > 0 ? 1 : 0;
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
