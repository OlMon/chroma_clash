// Brawl prototype: the simulation. An endless side-view free-for-all for the
// Arena, in the style of Intro Fighters: chatters drop in as jelly balls under
// gravity, hop at each other with a weapon in hand and lose bits of themselves
// on every hit. Plain JavaScript with a seeded random source and a fixed time
// step, so it can move to the server later and play the same everywhere.
'use strict';

const BrawlSim = (() => {
  const W = 1920;
  const H = 1080;
  const FLOOR = 1040;
  const WALL = 30;
  const GRAVITY = 2600;
  const STEP = 1 / 120;
  /** Springs around a body's rim, for the jelly ripple. */
  const RIM = 24;
  const MAX_CHIPS = 160;

  const WEAPONS = {
    // reach and length in body radii; times in seconds.
    sword: { length: 1.45, damage: 14, windup: 0.08, swing: 0.2, cooldown: 0.75, kind: 'swing', knock: 520 },
    axe: { length: 1.3, damage: 21, windup: 0.16, swing: 0.24, cooldown: 1.15, kind: 'swing', knock: 720 },
    spear: { length: 2.2, damage: 10, windup: 0.1, swing: 0.16, cooldown: 0.6, kind: 'thrust', knock: 420 },
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TAU = Math.PI * 2;
  const wrap = (a) => ((a % TAU) + TAU + Math.PI) % TAU - Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  class Brawl {
    constructor({ seed = 1, size = 8, radius = 42 } = {}) {
      this.rng = mulberry32(seed);
      this.size = size;
      this.radius = radius;
      this.t = 0;
      this.fighters = [];
      this.chips = [];
      this.drops = [];
      this.events = [];
      this.queue = [];
      this.nextId = 1;
    }

    /** A chatter wrote: they join the queue unless they are already in or waiting. */
    write(chatter) {
      if (this.fighters.some((f) => f.alive && f.who.id === chatter.id)) return;
      if (this.queue.some((c) => c.id === chatter.id)) return;
      this.queue.push(chatter);
    }

    spawn(who) {
      const r = this.radius * (0.92 + this.rng() * 0.16);
      const names = Object.keys(WEAPONS);
      const f = {
        id: this.nextId++, who, r,
        weapon: names[Math.floor(this.rng() * names.length)],
        x: WALL + r + this.rng() * (W - 2 * WALL - 2 * r), y: -r - 40 - this.rng() * 160,
        vx: (this.rng() - 0.5) * 200, vy: 0,
        rot: (this.rng() - 0.5) * 0.6, spin: (this.rng() - 0.5) * 4,
        hp: 100, alive: true, grounded: false, face: this.rng() < 0.5 ? -1 : 1,
        nextJump: 0, cooldown: 0.4, stun: 0, attack: null, target: null, retarget: 0,
        squash: 0, squashV: 0,
        rim: new Float32Array(RIM), rimV: new Float32Array(RIM),
        bites: [], flash: 0, kills: 0, born: this.t,
      };
      this.fighters.push(f);
      this.events.push({ k: 'join', f, t: this.t });
    }

    step() {
      const dt = STEP;
      this.t += dt;
      // Fill the field from the queue, one every few tenths of a second.
      const alive = this.fighters.filter((f) => f.alive);
      if (alive.length < this.size && this.queue.length > 0 && this.t >= (this.lastSpawn ?? -1) + 0.35) {
        this.spawn(this.queue.shift());
        this.lastSpawn = this.t;
      }
      for (const f of alive) this.think(f, dt);
      for (const f of alive) this.move(f, dt);
      this.collide(alive);
      for (const f of alive) this.strike(f);
      for (const f of alive) this.jelly(f, dt);
      this.moveChips(dt);
      this.fighters = this.fighters.filter((f) => f.alive || this.t - f.diedAt < 0.01);
      this.events = this.events.filter((e) => this.t - e.t < 6);
    }

    think(f, dt) {
      f.cooldown -= dt;
      f.stun -= dt;
      f.flash = Math.max(0, f.flash - dt * 4);
      f.retarget -= dt;
      if (f.retarget <= 0 || !f.target || !f.target.alive) {
        // The nearest other fighter, with a little whim so not everyone piles onto one.
        let best = null;
        let bestScore = Infinity;
        for (const o of this.fighters) {
          if (o === f || !o.alive) continue;
          const score = Math.hypot(o.x - f.x, (o.y - f.y) * 1.4) * (0.7 + this.rng() * 0.6);
          if (score < bestScore) { bestScore = score; best = o; }
        }
        f.target = best;
        f.retarget = 0.5 + this.rng() * 0.6;
      }
      const target = f.target;
      if (target && !f.attack) f.face = target.x >= f.x ? 1 : -1;
      if (f.attack) {
        f.attack.t += dt;
        const w = WEAPONS[f.weapon];
        if (f.attack.t > w.windup + w.swing + 0.08) f.attack = null;
      }
      if (!target || f.stun > 0) return;
      const w = WEAPONS[f.weapon];
      const dx = target.x - f.x;
      const dy = target.y - f.y;
      const dist = Math.hypot(dx, dy);
      const reach = f.r * (0.8 + w.length) + target.r * 0.7;
      if (!f.attack && f.cooldown <= 0 && dist < reach) {
        f.attack = { t: 0, hit: new Set() };
        f.cooldown = w.cooldown * (0.85 + this.rng() * 0.3);
      }
      if (f.grounded && this.t >= f.nextJump) {
        // Everyone gets around by hopping: short hops close in, big ones from afar.
        const far = Math.abs(dx) > 420;
        const backOff = dist < f.r * 1.6 && this.rng() < 0.35;
        const dir = backOff ? -Math.sign(dx || 1) : Math.sign(dx || 1);
        const speed = far ? 420 + this.rng() * 320 : 140 + this.rng() * 260;
        f.vx = dir * speed;
        f.vy = -(far ? 1050 + this.rng() * 450 : 650 + this.rng() * 600);
        if (dy < -120) f.vy -= Math.min(500, -dy * 1.2);
        f.grounded = false;
        f.squashV -= 6;
        f.spin += (this.rng() - 0.5) * 3;
        f.nextJump = Infinity;
      }
    }

    move(f, dt) {
      f.vy += GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.spin * dt;
      if (f.grounded) {
        f.vx *= Math.exp(-dt * 9);
        // On the ground the emote rights itself, wobbling.
        f.spin += (-wrap(f.rot) * 40 - f.spin * 7) * dt;
      } else {
        f.spin *= Math.exp(-dt * 0.8);
      }
      if (f.y + f.r >= FLOOR) {
        const impact = f.vy;
        f.y = FLOOR - f.r;
        if (impact > 380) {
          f.vy = -impact * 0.32;
          this.thump(f, Math.PI / 2 - f.rot, impact / 900);
          f.squashV += impact / 140;
          this.drop(f.x, FLOOR - 4, f.who.color, Math.min(6, impact / 300), -1);
        } else {
          f.vy = 0;
          if (!f.grounded) {
            f.grounded = true;
            f.nextJump = this.t + 0.18 + this.rng() * 0.5;
            f.squashV += Math.max(0, impact) / 160;
          }
        }
      } else if (f.y + f.r < FLOOR - 1) {
        f.grounded = false;
        if (f.nextJump === Infinity) { /* in the air after a jump */ }
      }
      if (f.grounded && f.nextJump === Infinity) f.nextJump = this.t + 0.2;
      for (const [edge, side] of [[WALL + f.r, 1], [W - WALL - f.r, -1]]) {
        if ((side === 1 && f.x < edge) || (side === -1 && f.x > edge)) {
          f.x = edge;
          if (Math.abs(f.vx) > 200) this.thump(f, (side === 1 ? Math.PI : 0) - f.rot, Math.abs(f.vx) / 1100);
          f.vx = -f.vx * 0.55;
          f.spin += f.vy * 0.002 * side;
        }
      }
    }

    collide(alive) {
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i];
          const b = alive[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const min = (a.r + b.r) * 0.9;
          if (d >= min) continue;
          const nx = dx / d;
          const ny = dy / d;
          const push = (min - d) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const j2 = -rel * 0.8;
            a.vx -= nx * j2; a.vy -= ny * j2;
            b.vx += nx * j2; b.vy += ny * j2;
            const angle = Math.atan2(ny, nx);
            this.thump(a, angle - a.rot, -rel / 1200);
            this.thump(b, angle + Math.PI - b.rot, -rel / 1200);
          }
          // Landing on another's head counts as ground for a hop.
          if (ny > 0.6 && a.vy >= 0) { a.vy = Math.min(a.vy, 0); if (a.nextJump === Infinity) a.nextJump = this.t + 0.15; a.grounded = true; }
          if (ny < -0.6 && b.vy >= 0) { b.vy = Math.min(b.vy, 0); if (b.nextJump === Infinity) b.nextJump = this.t + 0.15; b.grounded = true; }
        }
      }
    }

    /** Where a fighter's weapon is now: hand, tip and the angle, in the world. */
    weaponOf(f) {
      const w = WEAPONS[f.weapon];
      const face = f.face;
      let angle;
      let out = 0;
      const a = f.attack;
      if (w.kind === 'swing') {
        // Raised behind the head, then swung down in front.
        const rest = -1.25;
        if (!a) angle = rest + Math.sin(this.t * 3 + f.id) * 0.08;
        else if (a.t < w.windup) angle = rest - 0.5 * (a.t / w.windup);
        else {
          const p = clamp((a.t - w.windup) / w.swing, 0, 1);
          angle = rest - 0.5 + (1 - Math.pow(1 - p, 3)) * 2.45;
        }
      } else {
        angle = -0.15 + Math.sin(this.t * 2.5 + f.id) * 0.05;
        if (a) {
          if (a.t < w.windup) out = -0.25 * (a.t / w.windup);
          else {
            const p = clamp((a.t - w.windup) / w.swing, 0, 1);
            out = p < 0.4 ? -0.25 + (p / 0.4) * 1.2 : 0.95 - (p - 0.4) * 1.2;
          }
        }
      }
      const world = face === 1 ? angle : Math.PI - angle;
      const hx = f.x + face * f.r * 0.72 + Math.cos(world) * out * f.r;
      const hy = f.y + f.r * 0.12 + Math.sin(world) * out * f.r;
      const len = w.length * f.r;
      return { hx, hy, tx: hx + Math.cos(world) * len, ty: hy + Math.sin(world) * len, angle: world, w };
    }

    strike(f) {
      const a = f.attack;
      if (!a) return;
      const w = WEAPONS[f.weapon];
      if (a.t < w.windup || a.t > w.windup + w.swing) return;
      const { hx, hy, tx, ty } = this.weaponOf(f);
      for (const o of this.fighters) {
        if (o === f || !o.alive || a.hit.has(o.id)) continue;
        // Distance from the target's centre to the weapon's blade (the outer two thirds).
        const sx = hx + (tx - hx) * 0.3;
        const sy = hy + (ty - hy) * 0.3;
        const ex = tx - sx;
        const ey = ty - sy;
        const p = clamp(((o.x - sx) * ex + (o.y - sy) * ey) / (ex * ex + ey * ey), 0, 1);
        const cx = sx + ex * p;
        const cy = sy + ey * p;
        if (Math.hypot(o.x - cx, o.y - cy) > o.r) continue;
        a.hit.add(o.id);
        this.hurt(o, f, w.damage * (0.85 + this.rng() * 0.3), cx, cy, w.knock);
      }
    }

    hurt(o, by, damage, cx, cy, knock) {
      const away = Math.atan2(o.y - by.y, o.x - by.x);
      o.vx += Math.cos(away) * knock;
      o.vy += Math.sin(away) * knock * 0.5 - knock * 0.75;
      o.spin += (by.face) * (4 + this.rng() * 5);
      o.grounded = false;
      o.nextJump = Infinity;
      o.stun = 0.3;
      o.flash = 1;
      const local = Math.atan2(cy - o.y, cx - o.x) - o.rot;
      this.thump(o, local, 0.9);
      const before = o.hp;
      o.hp = Math.max(0, o.hp - damage);
      this.bite(o, local, (before - o.hp) / 100, Math.cos(away) * knock * 0.6, -300);
      this.drop(cx, cy, o.who.color, 5, away);
      this.events.push({ k: 'hit', x: cx, y: cy, v: Math.round(damage), t: this.t, big: damage > 18 });
      if (o.hp <= 0) this.knockOut(o, by);
    }

    /** The body's radius at a local angle, as a share of r: 1 less every bite there. */
    shapeAt(f, angle, upTo = f.bites.length) {
      let r = 1;
      for (let i = 0; i < upTo; i++) {
        const b = f.bites[i];
        const d = wrap(angle - b.a) / b.w;
        if (Math.abs(d) >= 1) continue;
        const k = Math.floor((d + 1) * 4.5);
        const jag = b.jag[k] ?? 0;
        r -= b.d * (1 - d * d) * (0.75 + jag * 0.5);
      }
      return Math.max(0.3, r);
    }

    /** Takes a bite out of a fighter at a local angle, sized to the share of health lost, and throws it as a chip. */
    bite(f, angle, share, vx, vy) {
      if (share <= 0) return;
      // Up to 60 % of the body goes over its whole health, the rest is the core that shatters at the end.
      const area = share * 0.6;
      const width = 0.55 + this.rng() * 0.5;
      const d = clamp(1 - Math.sqrt(Math.max(0, 1 - (2 * Math.PI * area) / width)), 0.08, 0.42);
      const bite = { a: angle + (this.rng() - 0.5) * 0.4, w: width, d, jag: Array.from({ length: 10 }, () => this.rng()) };
      const n = f.bites.length;
      f.bites.push(bite);
      const outer = [];
      const inner = [];
      for (let i = 0; i <= 10; i++) {
        const a = bite.a - bite.w + (2 * bite.w * i) / 10;
        const ro = this.shapeAt(f, a, n);
        const ri = this.shapeAt(f, a, n + 1);
        outer.push([Math.cos(a) * ro, Math.sin(a) * ro]);
        inner.unshift([Math.cos(a) * ri, Math.sin(a) * ri]);
      }
      this.chip(f, [...outer, ...inner], vx, vy);
    }

    /** A piece of a fighter flying off: a polygon in the body's own units, carrying its bit of the emote. */
    chip(f, poly, vx, vy) {
      let cx = 0;
      let cy = 0;
      for (const [x, y] of poly) { cx += x; cy += y; }
      cx /= poly.length;
      cy /= poly.length;
      const cos = Math.cos(f.rot);
      const sin = Math.sin(f.rot);
      const out = Math.atan2(cy, cx) + f.rot;
      this.chips.push({
        who: f.who, r: f.r, poly: poly.map(([x, y]) => [x - cx, y - cy]), ox: cx, oy: cy,
        x: f.x + (cx * cos - cy * sin) * f.r, y: f.y + (cx * sin + cy * cos) * f.r,
        vx: f.vx * 0.4 + vx + Math.cos(out) * (200 + this.rng() * 250),
        vy: f.vy * 0.4 + vy + Math.sin(out) * (200 + this.rng() * 250) - 250,
        rot: f.rot, spin: (this.rng() - 0.5) * 18, born: this.t, rest: false,
      });
      if (this.chips.length > MAX_CHIPS) this.chips.splice(0, this.chips.length - MAX_CHIPS);
    }

    knockOut(f, by) {
      f.alive = false;
      f.diedAt = this.t;
      by.kills++;
      // What is left shatters into wedges.
      const parts = 5 + Math.floor(this.rng() * 3);
      const start = this.rng() * TAU;
      for (let p = 0; p < parts; p++) {
        const a0 = start + (p / parts) * TAU;
        const a1 = start + ((p + 1) / parts) * TAU;
        const poly = [[0, 0]];
        for (let i = 0; i <= 6; i++) {
          const a = a0 + ((a1 - a0) * i) / 6;
          const r = this.shapeAt(f, a);
          poly.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        this.chip(f, poly, (f.x - by.x > 0 ? 1 : -1) * 250, -500);
      }
      for (let i = 0; i < 4; i++) this.drop(f.x, f.y, f.who.color, 6, this.rng() * TAU);
      this.events.push({ k: 'ko', f, by, x: f.x, y: f.y, t: this.t });
    }

    /** Spatters of jelly in the chatter's colour. */
    drop(x, y, color, count, angle) {
      for (let i = 0; i < count; i++) {
        const a = angle === -1 ? -Math.PI / 2 + (this.rng() - 0.5) * 2.4 : angle + (this.rng() - 0.5) * 1.6;
        const v = 250 + this.rng() * 500;
        this.drops.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, r: 3 + this.rng() * 5, color, born: this.t });
      }
      if (this.drops.length > 300) this.drops.splice(0, this.drops.length - 300);
    }

    /** Pokes the rim at a local angle: positive presses it in, and the jelly ripples from there. */
    thump(f, angle, strength) {
      const s = clamp(strength, -1.5, 1.5);
      for (let i = 0; i < RIM; i++) {
        const d = Math.cos((i / RIM) * TAU - angle);
        if (d > 0) f.rimV[i] -= d * d * s * 5;
        else f.rimV[i] += d * d * s * 1.6;
      }
    }

    jelly(f, dt) {
      const rim = f.rim;
      const v = f.rimV;
      for (let i = 0; i < RIM; i++) {
        const l = rim[(i + RIM - 1) % RIM];
        const r = rim[(i + 1) % RIM];
        v[i] += (-320 * rim[i] + 260 * (l + r - 2 * rim[i]) - 9 * v[i]) * dt;
      }
      for (let i = 0; i < RIM; i++) rim[i] = clamp(rim[i] + v[i] * dt, -0.35, 0.35);
      f.squashV += (-260 * f.squash - 11 * f.squashV) * dt;
      f.squash = clamp(f.squash + f.squashV * dt, -0.32, 0.38);
    }

    moveChips(dt) {
      for (const c of this.chips) {
        if (c.rest) continue;
        c.vy += GRAVITY * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.spin * dt;
        const bottom = FLOOR - 3;
        if (c.y > bottom) {
          c.y = bottom;
          if (c.vy > 220) {
            c.vy = -c.vy * 0.35;
            c.vx *= 0.7;
            c.spin *= 0.6;
          } else {
            c.vy = 0;
            c.vx *= 0.8;
            c.spin *= 0.8;
            if (Math.abs(c.vx) < 15) c.rest = true;
          }
        }
        if (c.x < WALL || c.x > W - WALL) { c.vx = -c.vx * 0.5; c.x = clamp(c.x, WALL, W - WALL); }
      }
      for (const d of this.drops) {
        d.vy += GRAVITY * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (d.y > FLOOR - 2) { d.y = FLOOR - 2; d.vy = 0; d.vx = 0; d.landed ??= this.t; }
      }
      this.chips = this.chips.filter((c) => this.t - c.born < 9);
      this.drops = this.drops.filter((d) => this.t - d.born < 5);
    }
  }

  return { Brawl, W, H, FLOOR, WALL, RIM, STEP, WEAPONS, mulberry32 };
})();
