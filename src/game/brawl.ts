import { config } from '../config.ts';
import { createRng, type Rng } from '../util/rng.ts';

/**
 * Brawl: an endless side-view free-for-all for the Arena, in the style of
 * Intro Fighters. Fighters are balls under gravity that hop at each other
 * with a weapon in hand; every hit takes a bite out of the one it lands on.
 * Chatters who write join a queue and drop in while the field has room. The
 * streamer can join as a fighter, or as the god: a big ball that lands with
 * a shockwave, whom chat then goes for, though their blows still hit each other.
 *
 * This is the game only: where everyone is, who hits whom, and the bites.
 * How the jelly wobbles and where the pieces fly is the overlay's business,
 * worked out from the events. A seeded random source and a fixed step make
 * a brawl play the same from the same seed and the same chat.
 */

const B = config.brawl;
const TAU = Math.PI * 2;
/** One step of the simulation, in seconds. */
export const BRAWL_STEP = 1 / (B.framesPerSecond * B.stepsPerFrame);

export type WeaponId = keyof typeof B.weapons;
export type TwistId = 'bouncy' | 'moon' | 'well' | 'boom';
export const TWISTS: readonly TwistId[] = ['bouncy', 'moon', 'well', 'boom'];
export type Role = 'chatter' | 'streamer' | 'god';

/** Who a fighter is, as the overlay shows them. The game only needs the id. */
export interface BrawlWho {
  id: string;
  name: string;
  color: string;
  emote?: unknown;
  image?: string | null;
}

/** A bite out of a fighter: at angle `a` of its own frame, `w` wide each way, `d` deep (shares of its radius), with a jagged edge. */
export interface Bite {
  a: number;
  w: number;
  d: number;
  jag: number[];
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Bumper { x: number; y: number; r: number }
export interface BrawlLayout { name: string; ledges: Rect[]; bumpers: Bumper[] }

export interface BrawlFighter {
  id: number;
  who: BrawlWho;
  role: Role;
  giant: boolean;
  r: number;
  weapon: WeaponId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  hp: number;
  maxHp: number;
  face: 1 | -1;
  grounded: boolean;
  /** Whether it stood on something in the step before. */
  standing: boolean;
  nextJump: number;
  cooldown: number;
  stun: number;
  attack: { t: number; hit: Set<number> } | null;
  target: BrawlFighter | null;
  retarget: number;
  kills: number;
  bites: Bite[];
  alive: boolean;
  bornAt: number;
  /** The god only: when it slams next, and whether it is in the air for a slam or still falling in. */
  slamAt: number;
  slamming: boolean;
  arriving: boolean;
}

export type BrawlEvent =
  | { k: 'join'; i: number }
  | { k: 'land'; i: number; v: number }
  | { k: 'bump'; i: number; a: number; v: number }
  | { k: 'bumper'; b: number; i: number }
  | { k: 'hit'; i: number; by: number; v: number; x: number; y: number; bite: Bite | null }
  | { k: 'ko'; i: number; by: number | null }
  | { k: 'boom'; x: number; y: number }
  | { k: 'slam'; i: number; x: number; y: number; r: number }
  | { k: 'god'; i: number }
  | { k: 'godfall'; i: number; by: number | null; toll: number; seconds: number }
  | { k: 'twist'; twist: TwistId | null }
  | { k: 'layout' };

const LEDGE = 26;
const BUMPER = 38;

/** Platforms and bumpers as shares of the play area: [left, top, width] for ledges, [x, y] for bumpers, [x, height, width] for pillars on the floor. */
const LAYOUTS: { name: string; ledges?: number[][]; bumpers?: number[][]; pillars?: number[][] }[] = [
  { name: 'open', bumpers: [[0.5, 0.42]] },
  { name: 'ledges', ledges: [[0.07, 0.64, 0.22], [0.71, 0.64, 0.22], [0.39, 0.42, 0.22]] },
  { name: 'pinball', ledges: [[0.4, 0.68, 0.2]], bumpers: [[0.2, 0.46], [0.5, 0.32], [0.8, 0.46]] },
  { name: 'towers', pillars: [[0.3, 0.2, 0.035], [0.67, 0.2, 0.035]], ledges: [[0.4, 0.5, 0.2]] },
  { name: 'stairs', ledges: [[0.05, 0.76, 0.17], [0.25, 0.6, 0.17], [0.45, 0.44, 0.17]], bumpers: [[0.82, 0.5]] },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const between = (rng: Rng, [lo, hi]: readonly number[]) => lo! + rng() * (hi! - lo!);

/** The body's radius at an angle of its own frame, as a share of r: less for every bite there. */
export function shapeAt(bites: readonly Bite[], angle: number, upTo = bites.length): number {
  let r = 1;
  for (let i = 0; i < upTo; i++) {
    const b = bites[i]!;
    const d = wrap(angle - b.a) / b.w;
    if (Math.abs(d) >= 1) continue;
    const jag = b.jag[Math.floor((d + 1) * 4.5)] ?? 0;
    r -= b.d * (1 - d * d) * (0.75 + jag * 0.5);
  }
  return Math.max(0.3, r);
}

export interface BrawlOptions {
  seed: number;
  size?: number;
}

export class Brawl {
  readonly width = B.arena.width;
  readonly floor = B.arena.floor;
  readonly wall = B.arena.wall;
  size: number;
  /** Seconds since the brawl began. */
  t = 0;
  fighters: BrawlFighter[] = [];
  queue: BrawlWho[] = [];
  layout: BrawlLayout;
  twist: TwistId | null = null;
  /** Events of the last steps, until the caller takes them. */
  events: BrawlEvent[] = [];
  /** While the god is on the field: when it came and how many others have fallen since. */
  god: { id: number; since: number; toll: number } | null = null;
  private readonly rng: Rng;
  private nextId = 1;
  /** Fighters by id, also some time after they fell, for the names in the events. */
  private readonly known = new Map<number, BrawlFighter>();
  private lastJoin = -Infinity;
  private twistAt: number;
  private twistEnds = 0;
  private layoutAt: number;

  constructor({ seed, size = B.fighters }: BrawlOptions) {
    this.rng = createRng(seed);
    this.size = clamp(Math.round(size), B.minFighters, B.maxFighters);
    this.layout = this.makeLayout();
    this.twistAt = B.twists.first;
    this.layoutAt = B.layoutEvery;
  }

  /** The events since the last call. */
  takeEvents(): BrawlEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** A fighter by id, on the field or fallen a little while ago. */
  byId(id: number | null): BrawlFighter | undefined {
    return id === null ? undefined : this.known.get(id);
  }

  get alive(): BrawlFighter[] {
    return this.fighters.filter((f) => f.alive);
  }

  /** A chatter wrote: they wait for a place, unless they are on the field or waiting already. */
  write(who: BrawlWho): void {
    if (this.fighters.some((f) => f.alive && f.who.id === who.id)) return;
    if (this.queue.some((w) => w.id === who.id)) return;
    this.queue.push(who);
  }

  /** Whether the streamer is on the field, and how. */
  streamer(): Role | null {
    const f = this.fighters.find((f) => f.alive && f.role !== 'chatter');
    return f ? f.role : null;
  }

  /**
   * The streamer joins: as a fighter like any chatter (straight away, even on
   * a full field), or as the god. Returns false when the streamer is in already.
   */
  join(who: BrawlWho, role: 'streamer' | 'god'): boolean {
    if (this.streamer()) return false;
    const f = this.spawn(who, role);
    if (role === 'god') {
      f.x = this.width / 2;
      f.y = -f.r * 1.5;
      f.vx = 0;
      f.vy = 900;
      f.rot = 0;
      f.spin = 0;
      f.arriving = true;
      this.god = { id: f.id, since: this.t, toll: 0 };
      this.events.push({ k: 'god', i: f.id });
    }
    return true;
  }

  private makeLayout(): BrawlLayout {
    const plan = LAYOUTS[Math.floor(this.rng() * LAYOUTS.length)]!;
    const mirror = this.rng() < 0.5;
    const left = this.wall;
    const span = this.width - 2 * this.wall;
    const flip = (x: number, w = 0) => (mirror ? 1 - x - w : x);
    const ledges: Rect[] = (plan.ledges ?? []).map(([x, y, w]) => ({
      x: Math.round(left + flip(x!, w!) * span), y: Math.round(y! * this.floor), w: Math.round(w! * span), h: LEDGE,
    }));
    for (const [x, height, w] of plan.pillars ?? []) {
      const h = Math.round(height! * this.floor);
      ledges.push({ x: Math.round(left + flip(x!, w!) * span), y: this.floor - h, w: Math.round(w! * span), h });
    }
    const bumpers = (plan.bumpers ?? []).map(([x, y]) => ({ x: Math.round(left + flip(x!) * span), y: Math.round(y! * this.floor), r: BUMPER }));
    return { name: plan.name, ledges, bumpers };
  }

  private spawn(who: BrawlWho, role: Role): BrawlFighter {
    const giant = role === 'chatter' && this.rng() < B.giant.chance;
    const scale = role === 'god' ? B.god.radius : giant ? B.giant.radius : 1;
    const r = B.radius * scale * (role === 'god' ? 1 : 0.92 + this.rng() * 0.16);
    const maxHp = role === 'god' ? B.god.healthPerFighter * this.size : B.health * (giant ? B.giant.health : 1);
    const weapons: WeaponId[] = ['sword', 'axe', 'spear'];
    const f: BrawlFighter = {
      id: this.nextId++, who, role, giant, r,
      weapon: role === 'god' ? 'hammer' : weapons[Math.floor(this.rng() * weapons.length)]!,
      x: this.wall + r + this.rng() * (this.width - 2 * this.wall - 2 * r),
      y: -r - 40 - this.rng() * 160,
      vx: (this.rng() - 0.5) * 160, vy: 0,
      rot: (this.rng() - 0.5) * 0.6, spin: (this.rng() - 0.5) * 3,
      hp: maxHp, maxHp, face: this.rng() < 0.5 ? -1 : 1, grounded: false, standing: false,
      nextJump: Infinity, cooldown: 0.5, stun: 0, attack: null, target: null, retarget: 0,
      kills: 0, bites: [], alive: true, bornAt: this.t,
      slamAt: this.t + between(this.rng, B.god.slamEvery), slamming: false, arriving: false,
    };
    this.fighters.push(f);
    this.known.set(f.id, f);
    if (this.known.size > 200) this.known.delete(this.known.keys().next().value!);
    this.events.push({ k: 'join', i: f.id });
    return f;
  }

  private gravity(): number {
    return B.gravity * (this.twist === 'moon' ? 0.45 : this.twist === 'well' ? 0.55 : 1);
  }

  step(): void {
    const dt = BRAWL_STEP;
    this.t += dt;
    this.fighters = this.fighters.filter((f) => f.alive);
    if (this.t >= this.twistAt) {
      this.twist = TWISTS[Math.floor(this.rng() * TWISTS.length)]!;
      this.twistEnds = this.t + B.twists.last;
      this.twistAt = this.twistEnds + between(this.rng, B.twists.gap);
      this.events.push({ k: 'twist', twist: this.twist });
    } else if (this.twist && this.t >= this.twistEnds) {
      this.twist = null;
      this.events.push({ k: 'twist', twist: null });
    }
    if (this.t >= this.layoutAt) {
      this.layoutAt = this.t + B.layoutEvery;
      this.layout = this.makeLayout();
      this.events.push({ k: 'layout' });
    }
    const chatters = this.fighters.filter((f) => f.role === 'chatter').length;
    if (chatters < this.size && this.queue.length > 0 && this.t >= this.lastJoin + B.joinGap) {
      this.spawn(this.queue.shift()!, 'chatter');
      this.lastJoin = this.t;
    }
    const alive = this.fighters;
    for (const f of alive) this.think(f, dt);
    for (const f of alive) this.move(f, dt);
    this.collide(alive);
    for (const f of alive) if (f.alive) this.strike(f);
  }

  private pickTarget(f: BrawlFighter): BrawlFighter | null {
    const god = this.god ? this.fighters.find((o) => o.id === this.god!.id && o.alive) : undefined;
    if (god && f !== god && this.rng() < B.god.chase) return god;
    let best: BrawlFighter | null = null;
    let bestScore = Infinity;
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      // The nearest, with a little whim so not everyone piles onto one.
      const score = Math.hypot(o.x - f.x, (o.y - f.y) * 1.4) * (0.7 + this.rng() * 0.6);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  private think(f: BrawlFighter, dt: number): void {
    const w = B.weapons[f.weapon];
    f.cooldown -= dt;
    f.stun -= dt;
    f.retarget -= dt;
    if (f.attack) {
      f.attack.t += dt;
      if (f.attack.t > w.windup + w.swing + 0.08) f.attack = null;
    }
    if (f.arriving) return;
    if (f.retarget <= 0 || !f.target || !f.target.alive) {
      f.target = this.pickTarget(f);
      f.retarget = 0.6 + this.rng() * 0.7;
    }
    const target = f.target;
    if (target && !f.attack) f.face = target.x >= f.x ? 1 : -1;
    if (f.stun > 0) return;
    if (f.role === 'god' && f.grounded && this.t >= f.slamAt) {
      // The god leaps high and comes down with a shockwave.
      f.vy = -1500;
      f.vx = target ? clamp((target.x - f.x) * 0.9, -500, 500) : 0;
      f.grounded = false;
      f.slamming = true;
      f.nextJump = Infinity;
      f.slamAt = this.t + between(this.rng, B.god.slamEvery);
      return;
    }
    if (!target) return;
    const dx = target.x - f.x;
    const dy = target.y - f.y;
    const dist = Math.hypot(dx, dy);
    const reach = f.r * (0.8 + w.length) + target.r * 0.7;
    if (!f.attack && f.cooldown <= 0 && dist < reach) {
      f.attack = { t: 0, hit: new Set() };
      f.cooldown = w.cooldown * (0.85 + this.rng() * 0.3);
    }
    if (f.grounded && this.t >= f.nextJump) {
      // Everyone gets around by hopping: short hops close in, big ones from afar, now and then one back.
      const hop = B.hop;
      const far = Math.abs(dx) > hop.far;
      const back = dist < f.r * 1.6 && this.rng() < 0.3;
      const dir = (back ? -1 : 1) * Math.sign(dx || 1);
      const heavy = f.role === 'god' ? 0.75 : f.giant ? 0.88 : 1;
      f.vx = dir * between(this.rng, far ? hop.farSpeed : hop.nearSpeed) * heavy;
      f.vy = -between(this.rng, far ? hop.farLift : hop.nearLift) * heavy;
      if (dy < -120) f.vy -= Math.min(450, -dy * 1.1);
      f.grounded = false;
      f.spin += (this.rng() - 0.5) * 2.5;
      f.nextJump = Infinity;
    }
  }

  /** Lands a fighter on something solid below it: a hard landing bounces, a soft one stands. */
  private land(f: BrawlFighter, impact: number): void {
    const bouncy = this.twist === 'bouncy';
    if (f.slamming || f.arriving) {
      this.slam(f, f.arriving);
      f.slamming = false;
      f.arriving = false;
    }
    if (impact > (bouncy ? 150 : 380)) {
      f.vy = -impact * (bouncy ? 0.85 : 0.32);
      this.events.push({ k: 'land', i: f.id, v: Math.round(impact) });
    } else {
      f.vy = 0;
      f.grounded = true;
      if (!f.standing) {
        f.nextJump = this.t + between(this.rng, B.hop.wait);
        if (impact > 120) this.events.push({ k: 'land', i: f.id, v: Math.round(impact) });
      }
    }
  }

  private move(f: BrawlFighter, dt: number): void {
    f.standing = f.grounded;
    f.grounded = false;
    f.vy += this.gravity() * dt;
    if (this.twist === 'well') {
      // A gravity well above the middle pulls everyone in.
      const dx = this.width / 2 - f.x;
      const dy = this.floor * 0.42 - f.y;
      const d = Math.hypot(dx, dy) || 1;
      f.vx += (dx / d) * 1300 * dt;
      f.vy += (dy / d) * 1300 * dt;
    }
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.rot += f.spin * dt;
    if (f.standing) {
      f.vx *= Math.exp(-dt * 9);
      // On the ground the fighter rights itself.
      f.spin += (-wrap(f.rot) * 40 - f.spin * 7) * dt;
    } else {
      f.spin *= Math.exp(-dt * 0.8);
    }
    if (f.y + f.r >= this.floor) {
      const impact = f.vy;
      f.y = this.floor - f.r;
      this.land(f, impact);
    }
    // The god falling in goes through everything down to the floor.
    if (f.arriving) return;
    // Ledges and pillars are solid all round.
    for (const box of this.layout.ledges) {
      const cx = clamp(f.x, box.x, box.x + box.w);
      const cy = clamp(f.y, box.y, box.y + box.h);
      const dx = f.x - cx;
      const dy = f.y - cy;
      const d = Math.hypot(dx, dy);
      if (d >= f.r) continue;
      const nx = d > 0 ? dx / d : 0;
      const ny = d > 0 ? dy / d : -1;
      f.x = cx + nx * f.r;
      f.y = cy + ny * f.r;
      if (ny < -0.7 && f.vy >= 0) {
        this.land(f, f.vy);
      } else {
        const into = f.vx * nx + f.vy * ny;
        if (into < 0) {
          f.vx -= 1.5 * into * nx;
          f.vy -= 1.5 * into * ny;
          if (-into > 250) this.events.push({ k: 'bump', i: f.id, a: Math.atan2(-ny, -nx) - f.rot, v: Math.round(-into) });
        }
      }
    }
    // Bumpers kick everyone off hard, like in a pinball machine.
    this.layout.bumpers.forEach((b, index) => {
      const dx = f.x - b.x;
      const dy = f.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d >= b.r + f.r) return;
      let nx = dx / d;
      let ny = dy / d;
      f.x = b.x + nx * (b.r + f.r);
      f.y = b.y + ny * (b.r + f.r);
      // Straight down onto a bumper: it throws to one side, so nobody is juggled on it for ever.
      if (Math.abs(nx) < 0.35) {
        nx = (nx < 0 || (nx === 0 && this.rng() < 0.5) ? -1 : 1) * (0.35 + this.rng() * 0.2);
        ny = -Math.sqrt(1 - nx * nx);
      }
      const kick = Math.max(900, Math.hypot(f.vx, f.vy)) * (f.role === 'god' ? 0.6 : 1);
      f.vx = nx * kick;
      f.vy = ny * kick - 150;
      f.spin += (this.rng() - 0.5) * 8;
      f.grounded = false;
      f.nextJump = Infinity;
      this.events.push({ k: 'bumper', b: index, i: f.id });
      this.events.push({ k: 'bump', i: f.id, a: Math.atan2(-ny, -nx) - f.rot, v: Math.round(kick) });
    });
    for (const [edge, side] of [[this.wall + f.r, 1], [this.width - this.wall - f.r, -1]] as const) {
      if ((side === 1 && f.x < edge) || (side === -1 && f.x > edge)) {
        f.x = edge;
        if (Math.abs(f.vx) > 200) this.events.push({ k: 'bump', i: f.id, a: (side === 1 ? Math.PI : 0) - f.rot, v: Math.round(Math.abs(f.vx)) });
        f.vx = -f.vx * (this.twist === 'bouncy' ? 0.9 : 0.55);
      }
    }
    if (f.grounded && f.nextJump === Infinity) f.nextJump = this.t + between(this.rng, B.hop.wait);
  }

  private mass(f: BrawlFighter): number {
    return f.role === 'god' ? 5 : f.giant ? 2.5 : 1;
  }

  private collide(alive: BrawlFighter[]): void {
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i]!;
        const b = alive[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const min = (a.r + b.r) * 0.9;
        if (d >= min) continue;
        const nx = dx / d;
        const ny = dy / d;
        const ma = this.mass(a);
        const mb = this.mass(b);
        const share = mb / (ma + mb);
        a.x -= nx * (min - d) * share;
        a.y -= ny * (min - d) * share;
        b.x += nx * (min - d) * (1 - share);
        b.y += ny * (min - d) * (1 - share);
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const impulse = (-rel * 1.8) / (1 / ma + 1 / mb);
          a.vx -= (nx * impulse) / ma;
          a.vy -= (ny * impulse) / ma;
          b.vx += (nx * impulse) / mb;
          b.vy += (ny * impulse) / mb;
          if (-rel > 200) {
            const angle = Math.atan2(ny, nx);
            this.events.push({ k: 'bump', i: a.id, a: angle - a.rot, v: Math.round(-rel) });
            this.events.push({ k: 'bump', i: b.id, a: angle + Math.PI - b.rot, v: Math.round(-rel) });
          }
        }
        // Standing on another's head counts as ground for a hop.
        for (const [top, below] of [[a, ny > 0.6], [b, ny < -0.6]] as const) {
          if (below && top.vy >= 0) {
            top.vy = Math.min(top.vy, 0);
            if (top.slamming || top.arriving) this.land(top, 0);
            if (top.nextJump === Infinity) top.nextJump = this.t + 0.15;
            top.grounded = true;
          }
        }
      }
    }
  }

  /** Where a fighter's weapon is now: hand, tip and angle, and how far into a swing it is (0 to 1, or -1). */
  weaponOf(f: BrawlFighter): { hx: number; hy: number; tx: number; ty: number; angle: number; out: number; swing: number } {
    const w = B.weapons[f.weapon];
    const a = f.attack;
    let angle: number;
    let out = 0;
    let swing = -1;
    if (w.kind === 'swing') {
      // Raised behind the head, then swung down in front.
      const rest = -1.25;
      if (!a) angle = rest + Math.sin(this.t * 3 + f.id) * 0.08;
      else if (a.t < w.windup) angle = rest - 0.5 * (a.t / w.windup);
      else {
        const p = clamp((a.t - w.windup) / w.swing, 0, 1);
        swing = p;
        angle = rest - 0.5 + (1 - Math.pow(1 - p, 3)) * 2.45;
      }
    } else {
      angle = -0.15 + Math.sin(this.t * 2.5 + f.id) * 0.05;
      if (a) {
        if (a.t < w.windup) out = -0.25 * (a.t / w.windup);
        else {
          const p = clamp((a.t - w.windup) / w.swing, 0, 1);
          swing = p;
          out = p < 0.4 ? -0.25 + (p / 0.4) * 1.2 : 0.95 - (p - 0.4) * 1.2;
        }
      }
    }
    const world = f.face === 1 ? angle : Math.PI - angle;
    const hx = f.x + f.face * f.r * 0.72 + Math.cos(world) * out * f.r;
    const hy = f.y + f.r * 0.12 + Math.sin(world) * out * f.r;
    const len = w.length * f.r;
    return { hx, hy, tx: hx + Math.cos(world) * len, ty: hy + Math.sin(world) * len, angle: world, out, swing };
  }

  private strike(f: BrawlFighter): void {
    const a = f.attack;
    if (!a) return;
    const w = B.weapons[f.weapon];
    if (a.t < w.windup || a.t > w.windup + w.swing) return;
    const { hx, hy, tx, ty } = this.weaponOf(f);
    // The blade: the outer two thirds of the weapon.
    const sx = hx + (tx - hx) * 0.3;
    const sy = hy + (ty - hy) * 0.3;
    const ex = tx - sx;
    const ey = ty - sy;
    for (const o of this.fighters) {
      if (o === f || !o.alive || a.hit.has(o.id)) continue;
      const p = clamp(((o.x - sx) * ex + (o.y - sy) * ey) / (ex * ex + ey * ey), 0, 1);
      const cx = sx + ex * p;
      const cy = sy + ey * p;
      if (Math.hypot(o.x - cx, o.y - cy) > o.r) continue;
      a.hit.add(o.id);
      this.hurt(o, f, w.damage * (0.85 + this.rng() * 0.3), cx, cy, w.knock);
    }
  }

  /** How much harder the god is hit once it is tired. */
  private tiredness(f: BrawlFighter): number {
    if (f.role !== 'god' || !this.god) return 1;
    const over = this.t - this.god.since - B.god.tiredAfter;
    return over > 0 ? 1 + over * B.god.tiredPerSecond : 1;
  }

  private hurt(o: BrawlFighter, by: BrawlFighter | null, damage: number, cx: number, cy: number, knock: number): void {
    const from = by ?? { x: cx, y: cy + 1 };
    const away = Math.atan2(o.y - from.y, o.x - from.x);
    const mass = this.mass(o);
    o.vx += (Math.cos(away) * knock) / mass;
    o.vy += (Math.sin(away) * knock * 0.5 - knock * 0.75) / mass;
    o.spin += (by ? by.face : 1) * (4 + this.rng() * 5) / mass;
    o.grounded = false;
    o.nextJump = Infinity;
    o.stun = o.role === 'god' ? 0.08 : 0.3;
    const dealt = Math.min(o.hp, damage * this.tiredness(o));
    o.hp -= dealt;
    const bite = this.bite(o, Math.atan2(cy - o.y, cx - o.x) - o.rot, dealt / o.maxHp);
    this.events.push({ k: 'hit', i: o.id, by: by ? by.id : 0, v: Math.round(dealt), x: Math.round(cx), y: Math.round(cy), bite });
    if (o.hp <= 0.001) this.knockOut(o, by);
  }

  /** Takes a bite out of a fighter, sized to the share of its health lost: 60 % of the body over its whole health. */
  private bite(f: BrawlFighter, angle: number, share: number): Bite | null {
    if (share <= 0) return null;
    const width = 0.55 + this.rng() * 0.5;
    const area = share * 0.6;
    const d = clamp(1 - Math.sqrt(Math.max(0, 1 - (2 * Math.PI * area) / width)), 0.04, 0.42);
    const bite: Bite = {
      a: Math.round((angle + (this.rng() - 0.5) * 0.4) * 100) / 100,
      w: Math.round(width * 100) / 100,
      d: Math.round(d * 100) / 100,
      jag: Array.from({ length: 10 }, () => Math.round(this.rng() * 9) / 9),
    };
    f.bites.push(bite);
    return bite;
  }

  private knockOut(f: BrawlFighter, by: BrawlFighter | null): void {
    f.alive = false;
    f.hp = 0;
    if (by) by.kills++;
    this.events.push({ k: 'ko', i: f.id, by: by ? by.id : null });
    if (this.god && f.id === this.god.id) {
      this.events.push({ k: 'godfall', i: f.id, by: by ? by.id : null, toll: this.god.toll, seconds: Math.round(this.t - this.god.since) });
      this.god = null;
    } else if (this.god) {
      this.god.toll++;
    }
    if (this.twist === 'boom') {
      // Exploding knockouts: everyone near is thrown and hurt.
      this.events.push({ k: 'boom', x: Math.round(f.x), y: Math.round(f.y) });
      for (const o of this.fighters) {
        if (!o.alive || o === f) continue;
        const d = Math.hypot(o.x - f.x, o.y - f.y);
        if (d < f.r * 4) this.hurt(o, null, 10 * (1 - d / (f.r * 4)) + 2, f.x, f.y, 700);
      }
    }
  }

  /** The god lands: a shockwave throws everyone near it up. Its arrival reaches the whole field and hurts nobody. */
  private slam(f: BrawlFighter, arrival: boolean): void {
    const radius = arrival ? this.width : B.god.slamRadius;
    this.events.push({ k: 'slam', i: f.id, x: Math.round(f.x), y: Math.round(this.floor), r: radius });
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      const d = Math.hypot(o.x - f.x, (o.y - f.y) * 0.7);
      if (d > radius) continue;
      const near = 1 - d / radius;
      o.vy = Math.min(o.vy, 0) - (arrival ? 900 + 500 * near : 500 + 700 * near);
      o.vx += Math.sign(o.x - f.x || 1) * (200 + 500 * near);
      o.spin += (this.rng() - 0.5) * 10;
      o.grounded = false;
      o.nextJump = Infinity;
      this.events.push({ k: 'bump', i: o.id, a: Math.PI / 2 - o.rot, v: 900 });
      if (!arrival) this.hurt(o, f, B.god.slamDamage * near + 2, o.x, o.y + o.r, 0);
    }
  }
}
