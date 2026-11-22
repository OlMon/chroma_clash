// The Arena's brawl, as the server streams it: jelly balls in side view, each
// with a weapon, that wobble, squash and stretch and lose bits of themselves on
// every hit. The server decides who is where and who hits whom; this file only
// adds the jelly, the flying pieces and the show around it. It uses the
// overlay's helpers (ctx, FONT, tr, emoteImage, loadImage, drawWall, drawBumper).
'use strict';

/** The brawl being shown, or null. */
let brawlShow = null;

const BRAWL = {
  rim: 24,
  points: 56,
  maxChips: 180,
  chipLife: 9,
  dropLife: 5,
  feedMs: 6000,
  twistBannerMs: 2600,
  arrivalMs: 2200,
  fallMs: 7000,
  giantMs: 2200,
  ink: '#0B0807',
};
const BRAWL_TAU = Math.PI * 2;

function brawlWrap(a) {
  return ((((a + Math.PI) % BRAWL_TAU) + BRAWL_TAU) % BRAWL_TAU) - Math.PI;
}

/** The body's radius at an angle of its own frame, as a share of r; the same as the server's. */
function brawlShapeAt(bites, angle, upTo = bites.length) {
  let r = 1;
  for (let i = 0; i < upTo; i++) {
    const b = bites[i];
    const d = brawlWrap(angle - b.a) / b.w;
    if (Math.abs(d) >= 1) continue;
    const jag = b.jag[Math.floor((d + 1) * 4.5)] ?? 0;
    r -= b.d * (1 - d * d) * (0.75 + jag * 0.5);
  }
  return Math.max(0.3, r);
}

function brawlFighter(info) {
  return {
    ...info,
    bites: info.bites.slice(),
    rim: new Float32Array(BRAWL.rim),
    rimV: new Float32Array(BRAWL.rim),
    squash: 0,
    squashV: 0,
    flash: 0,
    alive: true,
    prev: null,
    cur: null,
  };
}

function onBrawlStart(message) {
  clearTimeout(announcementTimer);
  announcement = null;
  const now = performance.now();
  brawlShow = {
    ...message,
    fighters: new Map(message.fighters.map((f) => [f.id, brawlFighter(f)])),
    receivedAt: now,
    chips: [],
    drops: [],
    effects: [],
    feed: [],
    bumperLit: new Map(),
    previousLayout: null,
    layoutAt: -Infinity,
    twistAt: message.twist ? now - BRAWL.twistBannerMs : -Infinity,
    arrival: null,
    fall: null,
    shake: { until: 0, power: 0 },
    lastStep: now,
    toll: message.god ? message.god.toll : 0,
  };
  requestAnimationFrame(animateBrawl);
}

function onBrawlEnd() {
  brawlShow = null;
  if (!battle) drawPanel();
}

function animateBrawl() {
  if (!brawlShow || battle) return;
  frame(renderPanel);
  requestAnimationFrame(animateBrawl);
}

function onBrawlFrame(message) {
  const b = brawlShow;
  if (!b) return;
  const now = performance.now();
  b.receivedAt = now;
  b.waiting = message.waiting;
  b.size = message.size;
  if (message.toll !== undefined) b.toll = message.toll;
  for (const e of message.e || []) brawlEvent(b, e, now);
  for (const row of message.f) {
    const f = b.fighters.get(row[0]);
    if (!f) continue;
    const pos = { x: row[1], y: row[2], rot: row[3] / 100, face: row[4], angle: row[5] / 100, out: row[6] / 100, hp: row[7], flags: row[8], swing: row[9] / 100 };
    f.prev = f.cur || pos;
    f.cur = pos;
  }
}

/** Where a fighter is drawn now: between its last two frames. */
function brawlPose(b, f, now) {
  const t = Math.min(1, (now - b.receivedAt) / b.frameMs);
  const p = f.prev;
  const c = f.cur;
  if (!p || !c) return c;
  const lerp = (a, z) => a + (z - a) * t;
  return {
    x: lerp(p.x, c.x),
    y: lerp(p.y, c.y),
    rot: p.rot + brawlWrap(c.rot - p.rot) * t,
    angle: p.angle + brawlWrap(c.angle - p.angle) * t,
    out: lerp(p.out, c.out),
    face: c.face,
    hp: c.hp,
    flags: c.flags,
    swing: c.swing,
    vx: (c.x - p.x) / (b.frameMs / 1000),
    vy: (c.y - p.y) / (b.frameMs / 1000),
  };
}

/** Pokes the rim at an angle of the body's frame: it presses in there and bulges out elsewhere, then ripples. */
function brawlThump(f, angle, strength) {
  const s = Math.max(-1.5, Math.min(1.5, strength));
  for (let i = 0; i < BRAWL.rim; i++) {
    const d = Math.cos((i / BRAWL.rim) * BRAWL_TAU - angle);
    if (d > 0) f.rimV[i] -= d * d * s * 5;
    else f.rimV[i] += d * d * s * 1.6;
  }
}

function brawlEvent(b, e, now) {
  const f = e.i !== undefined ? b.fighters.get(e.i) : null;
  // A fighter not drawn yet has no place to show anything at.
  if (f && !f.cur && e.k !== 'hit') return;
  if (f && !f.cur) {
    if (e.bite) f.bites.push(e.bite);
    return;
  }
  switch (e.k) {
    case 'join':
      b.fighters.set(e.f.id, brawlFighter(e.f));
      // A giant is announced, so chat knows why one is so big.
      if (e.f.giant) b.effects.push({ k: 'giant', name: e.f.name, color: e.f.color, at: now });
      break;
    case 'land':
      if (f) {
        f.squashV += Math.min(9, e.v / 150);
        brawlThump(f, Math.PI / 2 - (f.cur ? f.cur.rot : 0), e.v / 900);
        if (e.v > 500) brawlSpatter(b, f.cur.x, f.cur.y + f.r, f.color, Math.min(6, e.v / 300), null, now);
      }
      break;
    case 'bump':
      if (f) brawlThump(f, e.a, e.v / 1100);
      break;
    case 'bumper':
      b.bumperLit.set(e.b, now);
      break;
    case 'hit':
      if (f) {
        f.flash = 1;
        const local = e.bite ? e.bite.a : 0;
        brawlThump(f, local, 0.9);
        if (e.bite) {
          const before = f.bites.length;
          f.bites.push(e.bite);
          brawlChip(b, f, brawlBitePiece(f, e.bite, before), now);
        }
        brawlSpatter(b, e.x, e.y, f.color, 5, Math.atan2(e.y - f.cur.y, e.x - f.cur.x), now);
      }
      b.effects.push({ k: 'number', x: e.x, y: e.y, v: e.v, at: now, big: e.v >= 18, seed: e.x + e.y });
      break;
    case 'ko':
      if (f) {
        f.alive = false;
        brawlShatter(b, f, e.i === (b.god && b.god.id) ? 14 : 6, now);
        b.effects.push({ k: 'ko', x: f.cur.x, y: f.cur.y, at: now, seed: e.i, big: f.role === 'god' });
        const by = e.by !== null ? b.fighters.get(e.by) : null;
        if (by) by.kills++;
        b.feed.push({ at: now, by: by ? { name: by.name, color: by.color, role: by.role } : null, who: { name: f.name, color: f.color }, verb: (e.i * 7 + (e.by || 0)) % 7 });
        if (b.feed.length > 5) b.feed.shift();
        b.fighters.delete(e.i);
      }
      break;
    case 'boom':
      b.effects.push({ k: 'boom', x: e.x, y: e.y, at: now });
      b.shake = { until: now + 300, power: 6 };
      break;
    case 'slam': {
      const arrival = e.r >= b.arena.width;
      b.effects.push({ k: 'slam', x: e.x, y: e.y, r: Math.min(e.r, b.arena.width * 0.6), at: now, arrival });
      b.shake = { until: now + (arrival ? 700 : 350), power: arrival ? 16 : 8 };
      if (f) f.squashV += arrival ? 9 : 6;
      break;
    }
    case 'god':
      b.god = { id: e.i, since: 0, toll: 0 };
      b.toll = 0;
      b.arrival = { at: now, id: e.i };
      break;
    case 'godfall':
      b.fall = { at: now, name: e.name, killer: e.killer, toll: e.toll, seconds: e.seconds };
      b.god = null;
      b.shake = { until: now + 800, power: 18 };
      break;
    case 'twist':
      b.twist = e.twist;
      if (e.twist) b.twistAt = now;
      break;
    case 'layout':
      b.previousLayout = b.layout;
      b.layout = e.layout;
      b.layoutAt = now;
      break;
  }
}

/** The piece a bite takes out: between the outline before it and after it, in the body's own units. */
function brawlBitePiece(f, bite, before) {
  const outer = [];
  const inner = [];
  for (let i = 0; i <= 10; i++) {
    const a = bite.a - bite.w + (2 * bite.w * i) / 10;
    const ro = brawlShapeAt(f.bites, a, before);
    const ri = brawlShapeAt(f.bites, a, before + 1);
    outer.push([Math.cos(a) * ro, Math.sin(a) * ro]);
    inner.unshift([Math.cos(a) * ri, Math.sin(a) * ri]);
  }
  return outer.concat(inner);
}

/** Throws a piece of a fighter: a polygon in its own units that carries its bit of the emote. */
function brawlChip(b, f, poly, now, speed = 1) {
  const pose = f.cur;
  if (!pose) return;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const cos = Math.cos(pose.rot);
  const sin = Math.sin(pose.rot);
  const out = Math.atan2(cy, cx) + pose.rot;
  const fling = (220 + Math.random() * 260) * speed;
  b.chips.push({
    f: { emote: f.emote, image: f.image, color: f.color, name: f.name },
    r: f.r,
    poly: poly.map(([x, y]) => [x - cx, y - cy]),
    ox: cx,
    oy: cy,
    x: pose.x + (cx * cos - cy * sin) * f.r,
    y: pose.y + (cx * sin + cy * cos) * f.r,
    vx: Math.cos(out) * fling,
    vy: Math.sin(out) * fling - 300 * speed,
    rot: pose.rot,
    spin: (Math.random() - 0.5) * 16,
    at: now,
    rest: false,
  });
  if (b.chips.length > BRAWL.maxChips) b.chips.splice(0, b.chips.length - BRAWL.maxChips);
}

/** What is left of a fighter bursts into wedges. */
function brawlShatter(b, f, parts, now) {
  const start = Math.random() * BRAWL_TAU;
  for (let p = 0; p < parts; p++) {
    const a0 = start + (p / parts) * BRAWL_TAU;
    const a1 = start + ((p + 1) / parts) * BRAWL_TAU;
    const poly = [[0, 0]];
    for (let i = 0; i <= 6; i++) {
      const a = a0 + ((a1 - a0) * i) / 6;
      const r = brawlShapeAt(f.bites, a);
      poly.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    brawlChip(b, f, poly, now, f.role === 'god' ? 1.8 : 1.2);
  }
  if (f.cur) for (let i = 0; i < 4; i++) brawlSpatter(b, f.cur.x, f.cur.y, f.color, 6, Math.random() * BRAWL_TAU, now);
}

/** Drops of jelly in the fighter's colour. `angle` null sprays upward. */
function brawlSpatter(b, x, y, color, count, angle, now) {
  for (let i = 0; i < count; i++) {
    const a = angle === null ? -Math.PI / 2 + (Math.random() - 0.5) * 2.4 : angle + (Math.random() - 0.5) * 1.6;
    const v = 250 + Math.random() * 500;
    b.drops.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, r: 3 + Math.random() * 5, color, at: now });
  }
  if (b.drops.length > 300) b.drops.splice(0, b.drops.length - 300);
}

/** Moves what only the overlay knows: the jelly, the pieces and drops. Small fixed steps. */
function brawlAdvance(b, now) {
  const gravity = 2000;
  let elapsed = Math.min(0.1, (now - b.lastStep) / 1000);
  b.lastStep = now;
  const floor = b.arena.floor;
  const tops = b.layout.ledges;
  while (elapsed > 0) {
    const dt = Math.min(1 / 120, elapsed);
    elapsed -= dt;
    for (const f of b.fighters.values()) {
      const rim = f.rim;
      const v = f.rimV;
      const n = BRAWL.rim;
      for (let i = 0; i < n; i++) {
        v[i] += (-320 * rim[i] + 260 * (rim[(i + n - 1) % n] + rim[(i + 1) % n] - 2 * rim[i]) - 9 * v[i]) * dt;
      }
      for (let i = 0; i < n; i++) rim[i] = Math.max(-0.35, Math.min(0.35, rim[i] + v[i] * dt));
      f.squashV += (-260 * f.squash - 11 * f.squashV) * dt;
      f.squash = Math.max(-0.3, Math.min(0.36, f.squash + f.squashV * dt));
      f.flash = Math.max(0, f.flash - dt * 4);
    }
    for (const c of b.chips) {
      if (c.rest) continue;
      c.vy += gravity * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.spin * dt;
      // Pieces come to rest on the floor or on top of a ledge.
      let ground = floor - 3;
      for (const box of tops) {
        if (c.x > box.x && c.x < box.x + box.w && c.y - c.vy * dt <= box.y + 2) ground = Math.min(ground, box.y - 3);
      }
      if (c.y > ground) {
        c.y = ground;
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
      if (c.x < b.arena.wall || c.x > b.arena.width - b.arena.wall) {
        c.vx = -c.vx * 0.5;
        c.x = Math.max(b.arena.wall, Math.min(b.arena.width - b.arena.wall, c.x));
      }
    }
    for (const d of b.drops) {
      if (d.landed) continue;
      d.vy += gravity * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y > floor - 2) {
        d.y = floor - 2;
        d.landed = true;
      }
    }
  }
  b.chips = b.chips.filter((c) => now - c.at < BRAWL.chipLife * 1000);
  b.drops = b.drops.filter((d) => now - d.at < BRAWL.dropLife * 1000);
}

// --- Drawing ---------------------------------------------------------------------

function brawlInk() {
  const ink = inkOf();
  return ink ? { color: ink.color || BRAWL.ink, width: ink.width ?? 3, shadow: ink.shadow ?? 0, shadowAlpha: ink.shadowAlpha ?? 0.45 } : null;
}

function brawlRipple(f, angle) {
  const p = ((((angle / BRAWL_TAU) * BRAWL.rim) % BRAWL.rim) + BRAWL.rim) % BRAWL.rim;
  const i = Math.floor(p);
  const t = p - i;
  return f.rim[i] * (1 - t) + f.rim[(i + 1) % BRAWL.rim] * t;
}

/** The body's frame: where it is, squashed and stretched, turned; in units of its radius. */
function brawlBodyFrame(f, pose) {
  const q = f.squash;
  const speed = Math.hypot(pose.vx, pose.vy);
  const s = pose.flags & 1 ? 0 : Math.min(0.15, speed / 9000);
  ctx.translate(pose.x, pose.y + f.r * Math.max(0, q) * 0.85);
  if (s > 0.005) {
    const phi = Math.atan2(pose.vy, pose.vx);
    ctx.rotate(phi);
    ctx.scale(1 + s, 1 - s * 0.6);
    ctx.rotate(-phi);
  }
  ctx.scale(1 + q, 1 - q);
  ctx.rotate(pose.rot);
  ctx.scale(f.r, f.r);
}

function brawlBodyPath(f, grow) {
  ctx.beginPath();
  for (let j = 0; j <= BRAWL.points; j++) {
    const a = (j / BRAWL.points) * BRAWL_TAU;
    const r = brawlShapeAt(f.bites, a) + brawlRipple(f, a) + grow;
    if (j === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
}

/** Fills the current path with the fighter's emote or picture (centred on hx, hy in body units), shaded, flashing white when hit. */
function brawlPaintInside(who, flash, hx, hy) {
  ctx.fillStyle = '#1A1714';
  ctx.fill();
  ctx.save();
  ctx.clip();
  const picture = who.image ? loadImage(who.image) : null;
  const emote = picture ? null : emoteImage(who.emote);
  if (picture) {
    const side = Math.min(picture.naturalWidth, picture.naturalHeight);
    ctx.drawImage(picture, (picture.naturalWidth - side) / 2, (picture.naturalHeight - side) / 2, side, side, hx - 1, hy - 1, 2, 2);
  } else if (emote) {
    ctx.drawImage(emote, hx - 0.95, hy - 0.95, 1.9, 1.9);
  } else {
    ctx.fillStyle = who.color;
    ctx.fillRect(hx - 1, hy - 1, 2, 2);
  }
  const shade = ctx.createLinearGradient(hx - 0.6, hy - 0.6, hx + 1, hy + 1);
  shade.addColorStop(0.45, 'rgba(11, 8, 7, 0)');
  shade.addColorStop(1, 'rgba(11, 8, 7, 0.45)');
  ctx.fillStyle = shade;
  ctx.fillRect(hx - 1.2, hy - 1.2, 2.4, 2.4);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.75 * flash})`;
    ctx.fillRect(hx - 1.2, hy - 1.2, 2.4, 2.4);
  }
  ctx.restore();
}

function drawBrawlFighter(b, f, pose, now) {
  const ink = brawlInk();
  const floor = b.arena.floor;
  // A soft shadow on the floor, smaller the higher up.
  const height = Math.max(0, floor - (pose.y + f.r));
  const k = Math.max(0.25, 1 - height / 600);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.35 * k})`;
  ctx.beginPath();
  ctx.ellipse(pose.x, floor + 2, f.r * 1.1 * k, f.r * 0.22 * k, 0, 0, BRAWL_TAU);
  ctx.fill();

  if (f.role === 'god') {
    // The god glows.
    const glow = ctx.createRadialGradient(pose.x, pose.y, f.r * 0.8, pose.x, pose.y, f.r * 1.7);
    glow.addColorStop(0, 'rgba(255, 213, 74, 0.45)');
    glow.addColorStop(1, 'rgba(255, 213, 74, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(pose.x - f.r * 2, pose.y - f.r * 2, f.r * 4, f.r * 4);
  }

  ctx.save();
  brawlBodyFrame(f, pose);
  if (ink) {
    if (ink.shadow) {
      ctx.save();
      ctx.rotate(-pose.rot);
      ctx.translate(ink.shadow / f.r, ink.shadow / f.r);
      ctx.rotate(pose.rot);
      brawlBodyPath(f, 0.1);
      ctx.fillStyle = `rgba(11, 8, 7, ${ink.shadowAlpha})`;
      ctx.fill();
      ctx.restore();
    }
    brawlBodyPath(f, (ink.width * 2 + 2) / f.r);
    ctx.fillStyle = ink.color;
    ctx.fill();
  } else {
    brawlBodyPath(f, 3 / f.r);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
  }
  brawlBodyPath(f, 0);
  brawlPaintInside(f, f.flash, 0, 0);
  brawlBodyPath(f, -0.03);
  ctx.lineWidth = (f.role === 'god' ? 6 : 4) / f.r;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = f.role === 'god' ? '#FFD54A' : f.color;
  ctx.stroke();
  // A glossy spot: it is jelly.
  ctx.rotate(-pose.rot);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.beginPath();
  ctx.ellipse(-0.38, -0.45, 0.26, 0.13, -0.6, 0, BRAWL_TAU);
  ctx.fill();
  ctx.restore();

  drawBrawlWeapon(b, f, pose);

  // The name, the knockouts so far, and a crown for the god.
  const showNames = !state || !state.display || state.display.names !== false;
  const label = f.kills > 0 ? tr('overlay.brawl.kills', { name: f.name, count: f.kills }) : f.name;
  const size = f.role === 'god' ? 32 : 24;
  const ly = pose.y - f.r * 1.25 - 6;
  if (showNames || f.role !== 'chatter') {
    ctx.font = `${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = BRAWL.ink;
    ctx.strokeText(label, pose.x, ly);
    ctx.fillStyle = f.role === 'god' ? '#FFD54A' : f.color;
    ctx.fillText(label, pose.x, ly);
  }
  if (f.role !== 'chatter') drawBrawlCrown(pose.x, ly - size - 4, f.role === 'god' ? 1.3 : 0.8);
  else if (f.giant) brawlLine(tr('overlay.brawl.giantTag'), pose.x, ly - size - 6, 18, '#C9A6FF');
}

function drawBrawlCrown(x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(-16, 8);
  ctx.lineTo(-18, -8);
  ctx.lineTo(-8, 0);
  ctx.lineTo(0, -12);
  ctx.lineTo(8, 0);
  ctx.lineTo(18, -8);
  ctx.lineTo(16, 8);
  ctx.closePath();
  ctx.fillStyle = '#FFD54A';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = BRAWL.ink;
  ctx.stroke();
  ctx.restore();
}

function brawlInked(fill, width = 3) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = BRAWL.ink;
  ctx.stroke();
}

function drawBrawlWeapon(b, f, pose) {
  const w = b.weapons[f.weapon];
  const r = f.r;
  const hx = pose.x + pose.face * r * 0.72 + Math.cos(pose.angle) * pose.out * r;
  const hy = pose.y + r * 0.12 + Math.sin(pose.angle) * pose.out * r;
  const len = w.length * r;
  ctx.save();
  ctx.lineJoin = 'round';
  if (w.kind === 'swing' && pose.swing >= 0) {
    // The swing's smear, behind the blade.
    const start = pose.face === 1 ? -1.75 : Math.PI + 1.75;
    ctx.beginPath();
    ctx.arc(hx, hy, len * 1.02, start, pose.angle, pose.face === -1);
    ctx.arc(hx, hy, len * 0.45, pose.angle, start, pose.face === 1);
    ctx.closePath();
    ctx.fillStyle = `rgba(255, 244, 214, ${0.5 * (1 - Math.max(0, pose.swing - 0.7) / 0.3)})`;
    ctx.fill();
  }
  ctx.translate(hx, hy);
  ctx.rotate(pose.angle);
  const thick = r / 42;
  if (f.weapon === 'sword') {
    ctx.beginPath();
    ctx.rect(-r * 0.18, -3.5 * thick, r * 0.22, 7 * thick);
    brawlInked('#6B4A2E');
    ctx.beginPath();
    ctx.rect(r * 0.04, -r * 0.2, 7 * thick, r * 0.4);
    brawlInked('#C9A44B');
    ctx.beginPath();
    ctx.moveTo(r * 0.14, -5.5 * thick);
    ctx.lineTo(len - 12 * thick, -5.5 * thick);
    ctx.lineTo(len, 0);
    ctx.lineTo(len - 12 * thick, 5.5 * thick);
    ctx.lineTo(r * 0.14, 5.5 * thick);
    ctx.closePath();
    brawlInked('#DDE2E8');
  } else if (f.weapon === 'axe') {
    ctx.beginPath();
    ctx.rect(-r * 0.15, -4 * thick, len, 8 * thick);
    brawlInked('#7A5333');
    ctx.beginPath();
    ctx.moveTo(len - r * 0.45, -4);
    ctx.quadraticCurveTo(len - r * 0.3, -r * 0.55, len + r * 0.05, -r * 0.62);
    ctx.quadraticCurveTo(len - r * 0.05, 0, len + r * 0.05, r * 0.32);
    ctx.quadraticCurveTo(len - r * 0.3, r * 0.3, len - r * 0.45, 4);
    ctx.closePath();
    brawlInked('#C9CED6');
  } else if (f.weapon === 'hammer') {
    ctx.beginPath();
    ctx.rect(-r * 0.15, -5 * thick, len, 10 * thick);
    brawlInked('#7A5333', 4);
    ctx.beginPath();
    ctx.rect(len - r * 0.31, -r * 0.5, r * 0.62, r);
    brawlInked('#9AA3AE', 4);
    ctx.beginPath();
    ctx.rect(len - r * 0.31, -r * 0.5, r * 0.62, r * 0.16);
    brawlInked('#FFD54A', 3);
    // The streamer swings the ban hammer: the word along its head, turned to read upright.
    ctx.save();
    ctx.translate(len, r * 0.08);
    ctx.rotate(Math.cos(pose.angle + Math.PI / 2) >= 0 ? Math.PI / 2 : -Math.PI / 2);
    ctx.font = `${Math.round(r * 0.38)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(3, r * 0.05);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = BRAWL.ink;
    ctx.strokeText(tr('overlay.brawl.ban'), 0, 1, r * 0.8);
    ctx.fillStyle = '#E5533D';
    ctx.fillText(tr('overlay.brawl.ban'), 0, 1, r * 0.8);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.rect(-r * 0.6, -3.5 * thick, len + r * 0.6 - 18 * thick, 7 * thick);
    brawlInked('#8A6440');
    ctx.beginPath();
    ctx.moveTo(len - 22 * thick, 0);
    ctx.quadraticCurveTo(len - 12 * thick, -10 * thick, len + 6 * thick, 0);
    ctx.quadraticCurveTo(len - 12 * thick, 10 * thick, len - 22 * thick, 0);
    ctx.closePath();
    brawlInked('#DDE2E8');
  }
  ctx.restore();
}

function drawBrawlChip(c, now) {
  const age = (now - c.at) / 1000;
  const fade = age > BRAWL.chipLife - 2 ? (BRAWL.chipLife - age) / 2 : 1;
  ctx.save();
  ctx.globalAlpha *= Math.max(0, fade);
  ctx.translate(c.x, c.y);
  ctx.rotate(c.rot);
  ctx.scale(c.r, c.r);
  const path = (grow) => {
    ctx.beginPath();
    c.poly.forEach(([x, y], i) => {
      const g = 1 + grow / Math.max(0.08, Math.hypot(x, y) + 0.2);
      if (i === 0) ctx.moveTo(x * g, y * g);
      else ctx.lineTo(x * g, y * g);
    });
    ctx.closePath();
  };
  path(0.06);
  ctx.fillStyle = BRAWL.ink;
  ctx.fill();
  path(0);
  brawlPaintInside(c.f, 0, -c.ox, -c.oy);
  ctx.restore();
}

function drawBrawlDrop(d, now) {
  const age = (now - d.at) / 1000;
  ctx.save();
  ctx.globalAlpha *= Math.max(0, 1 - Math.max(0, age - 3.5) / 1.5);
  ctx.fillStyle = d.color;
  ctx.strokeStyle = BRAWL.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (d.landed) ctx.ellipse(d.x, d.y, d.r * 1.8, d.r * 0.5, 0, 0, BRAWL_TAU);
  else ctx.arc(d.x, d.y, d.r, 0, BRAWL_TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A sound-effect burst: a jagged star with a word on it. */
function drawBrawlBurst(x, y, size, word, fill, age) {
  const pop = age < 0.12 ? age / 0.12 : 1;
  const fade = age > 0.7 ? Math.max(0, 1 - (age - 0.7) / 0.3) : 1;
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.translate(x, y);
  ctx.rotate(-0.12);
  const grow = pop * (1 + age * 0.15);
  ctx.scale(grow, grow);
  // As wide as its word needs: a long one gets a long star.
  ctx.font = `${Math.round(size * 0.75)}px ${FONT}`;
  const wide = Math.max(1.25, (textWidth(word) / 2 + size * 0.45) / size);
  ctx.beginPath();
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * BRAWL_TAU;
    const r = i % 2 === 0 ? size : size * 0.62;
    ctx.lineTo(Math.cos(a) * r * wide, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = BRAWL.ink;
  ctx.stroke();
  ctx.font = `${Math.round(size * 0.75)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeText(word, 0, 2);
  ctx.fillStyle = '#FFF4D6';
  ctx.fillText(word, 0, 2);
  ctx.restore();
}

function drawBrawlEffects(b, now) {
  const art = Theme.current.art;
  b.effects = b.effects.filter((e) => now - e.at < (e.k === 'giant' ? BRAWL.giantMs : 1400));
  for (const e of b.effects) {
    const age = now - e.at;
    if (e.k === 'number') {
      if (e.big && age < 1000) {
        drawBrawlBurst(e.x, e.y - 20, 40, tr(`overlay.brawl.pow.${Math.floor(e.seed) % 3}`), '#E5533D', age / 1000);
      } else if (age < 800) {
        ctx.save();
        if (art.damageNumber) {
          ctx.globalAlpha *= 1 - age / 800;
          art.damageNumber(ctx, e.x, e.y - 30 - age * 0.06, e.v, { age, life: 800, lethal: false, skill: false, color: '#FFD54A', seed: e.seed, rank: 0, px: Theme.current.pixelScale });
        } else {
          ctx.globalAlpha *= 1 - age / 800;
          ctx.font = `30px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 5;
          ctx.strokeStyle = BRAWL.ink;
          ctx.strokeText(String(e.v), e.x, e.y - 30 - age * 0.06);
          ctx.fillStyle = '#FFD54A';
          ctx.fillText(String(e.v), e.x, e.y - 30 - age * 0.06);
        }
        ctx.restore();
      }
    } else if (e.k === 'giant') {
      drawBrawlBurst(b.arena.width / 2, 300, 70, tr('overlay.brawl.giant', { name: e.name }), '#8E5BD9', age / BRAWL.giantMs);
    } else if (e.k === 'ko') {
      const life = e.big ? 1400 : 1100;
      if (age > life) continue;
      ctx.save();
      if (art.knockout && !e.big) art.knockout(ctx, e.x, e.y - 30, age, e.seed, { px: Theme.current.pixelScale, life });
      else drawBrawlBurst(e.x, e.y - 30, e.big ? 110 : 62, tr('overlay.brawl.ko'), '#FFD54A', age / life);
      ctx.restore();
    } else if (e.k === 'slam' || e.k === 'boom') {
      // A ring of force along the floor (or round an explosion), and dust.
      const life = e.k === 'slam' && e.arrival ? 900 : 600;
      if (age > life) continue;
      const p = age / life;
      const reach = e.k === 'boom' ? 170 : e.r;
      ctx.save();
      ctx.globalAlpha *= 1 - p;
      ctx.lineWidth = e.k === 'boom' ? 10 : 14;
      ctx.strokeStyle = e.k === 'boom' ? '#FF8A3A' : '#FFF4D6';
      ctx.beginPath();
      if (e.k === 'boom') ctx.arc(e.x, e.y, reach * easeOutBack(p), 0, BRAWL_TAU);
      else ctx.ellipse(e.x, e.y, reach * p, reach * p * 0.18, 0, 0, BRAWL_TAU);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = BRAWL.ink;
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawBrawlLayout(b, layout, alpha, now) {
  if (!layout || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  layout.ledges.forEach((box, i) => drawWall(box.x + box.w / 2, box.y + box.h / 2, box.w, box.h, i + 1));
  layout.bumpers.forEach((bumper, i) => {
    const lit = now - (b.bumperLit.get(i) ?? -Infinity) < 220;
    drawBumper(bumper.x, bumper.y, bumper.r, lit, now);
  });
  ctx.restore();
}

/** A strip of text on a dark panel, centred at x, y. */
function brawlPlate(text, x, y, size, color) {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = textWidth(text) + size * 1.4;
  const height = size * 1.5;
  ctx.beginPath();
  ctx.rect(x - width / 2, y - height / 2, width, height);
  ctx.fillStyle = Theme.current.palette ? Theme.current.palette.panelStrong || 'rgba(24, 18, 15, 0.94)' : 'rgba(24, 18, 15, 0.94)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = BRAWL.ink;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 2);
}

function brawlLine(text, x, y, size, color, align = 'center') {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = BRAWL.ink;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawBrawlHud(b, now) {
  const w = b.arena.width;
  const god = b.god ? b.fighters.get(b.god.id) : null;
  if (god) {
    // The god's fight: its health across the top, and how many have fallen so far.
    brawlPlate(tr('overlay.brawl.godTitle', { name: god.name }), w / 2, 44, 36, '#FFD54A');
    const barW = 640;
    const hp = god.cur ? god.cur.hp : 100;
    ctx.fillStyle = BRAWL.ink;
    ctx.fillRect(w / 2 - barW / 2 - 4, 82, barW + 8, 24);
    ctx.fillStyle = '#3A2F28';
    ctx.fillRect(w / 2 - barW / 2, 86, barW, 16);
    ctx.fillStyle = hp > 50 ? '#E5533D' : hp > 25 ? '#FF8A3A' : '#FFD54A';
    ctx.fillRect(w / 2 - barW / 2, 86, (barW * hp) / 100, 16);
    brawlLine(tr('overlay.brawl.toll', { count: b.toll }), w / 2, 130, 28, '#F3E6C8');
  } else {
    brawlPlate(tr('overlay.brawl.title'), w / 2, 44, 38, '#FFD54A');
    const alive = [...b.fighters.values()].filter((f) => f.role === 'chatter').length;
    const sub = b.waiting > 0 ? tr('overlay.brawl.fightingWaiting', { count: alive, size: b.size, waiting: b.waiting }) : tr('overlay.brawl.fighting', { count: alive, size: b.size });
    brawlLine(sub, w / 2, 96, 24, '#F3E6C8');
  }
  if (b.twist) brawlLine(tr('overlay.brawl.twistNow', { twist: tr(`overlay.brawl.twist.${b.twist}`) }), w / 2, god ? 162 : 128, 24, '#9BE0FF');

  // Who knocked out whom, top left.
  let y = 40;
  for (const line of b.feed.slice().reverse()) {
    const age = now - line.at;
    if (age > BRAWL.feedMs) continue;
    ctx.save();
    ctx.globalAlpha *= age > BRAWL.feedMs - 1000 ? (BRAWL.feedMs - age) / 1000 : 1;
    const parts = line.by
      ? [[line.by.name, line.by.role === 'god' ? '#FFD54A' : line.by.color], [` ${tr(`overlay.brawl.verb.${line.verb}`)} `, '#F3E6C8'], [line.who.name, line.who.color]]
      : [[line.who.name, line.who.color], [` ${tr('overlay.brawl.verbAlone')}`, '#F3E6C8']];
    let x = 40;
    for (const [text, color] of parts) {
      brawlLine(text, x, y, 26, color, 'left');
      x += textWidth(text);
    }
    ctx.restore();
    y += 34;
  }

  // A twist is announced in big letters.
  const twistAge = now - b.twistAt;
  if (b.twist && twistAge < BRAWL.twistBannerMs) {
    drawBrawlBurst(w / 2, 380, 90, tr(`overlay.brawl.twist.${b.twist}`), '#3A8FD9', twistAge / BRAWL.twistBannerMs);
  }
}

/** The god comes: a light falls where it will land, and its name in big letters. */
function drawBrawlArrival(b, now) {
  const a = b.arrival;
  if (!a) return;
  const age = now - a.at;
  if (age > BRAWL.arrivalMs) {
    b.arrival = null;
    return;
  }
  const w = b.arena.width;
  const p = age / BRAWL.arrivalMs;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, (1 - p) * 3) * 0.5;
  const beam = ctx.createLinearGradient(0, 0, 0, b.arena.floor);
  beam.addColorStop(0, 'rgba(255, 230, 140, 0)');
  beam.addColorStop(1, 'rgba(255, 230, 140, 0.9)');
  ctx.fillStyle = beam;
  ctx.fillRect(w / 2 - 140, 0, 280, b.arena.floor);
  ctx.restore();
  const god = b.fighters.get(a.id);
  if (god) drawBrawlBurst(w / 2, 300, 100, tr('overlay.brawl.descends', { name: god.name }), '#E5533D', Math.min(0.99, age / BRAWL.arrivalMs));
}

/** The god has fallen: a flash, rays, and how many chatters it took. */
function drawBrawlFall(b, now) {
  const fall = b.fall;
  if (!fall) return;
  const age = now - fall.at;
  if (age > BRAWL.fallMs) {
    b.fall = null;
    return;
  }
  const w = b.arena.width;
  const h = b.arena.height;
  const fade = age > BRAWL.fallMs - 600 ? (BRAWL.fallMs - age) / 600 : 1;
  if (age < 400) {
    ctx.save();
    ctx.globalAlpha *= 0.85 * (1 - age / 400);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.fillStyle = 'rgba(11, 8, 7, 0.45)';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h * 0.42);
  ctx.rotate(age / 3000);
  if (Theme.current.art.rays) {
    Theme.current.art.rays(ctx, { count: 16, length: 900, color: '#FFD54A', alpha: 0.6, px: Theme.current.pixelScale });
  } else {
    for (let i = 0; i < 16; i++) {
      ctx.rotate(BRAWL_TAU / 16);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(900, -50);
      ctx.lineTo(900, 50);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 213, 74, 0.18)';
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha *= fade;
  const pop = easeOutBack(Math.min(1, (age - 200) / 500));
  if (age > 200) {
    ctx.save();
    ctx.translate(w / 2, h * 0.32);
    ctx.scale(pop, pop);
    brawlLine(tr('overlay.brawl.fallen', { name: fall.name }), 0, 0, 92, '#FFD54A');
    ctx.restore();
  }
  // The counter rolls up to how many chatters fell while the god stood.
  if (age > 900) {
    const roll = Math.min(1, (age - 900) / 1600);
    const shown = Math.round(fall.toll * (1 - Math.pow(1 - roll, 3)));
    brawlLine(String(shown), w / 2, h * 0.47, 150, '#FFF4D6');
    brawlLine(tr('overlay.brawl.tookFallen', { count: fall.toll }), w / 2, h * 0.58, 40, '#F3E6C8');
  }
  if (age > 2700 && fall.killer) {
    brawlLine(tr('overlay.brawl.finalBlow', { name: fall.killer.name }), w / 2, h * 0.66, 36, fall.killer.color);
  }
  if (age > 3200) brawlLine(tr('overlay.brawl.reigned', { seconds: fall.seconds }), w / 2, h * 0.72, 26, '#C9BFA6');
  ctx.restore();
}

/** Draws the brawl over everything; the corner panels have slid away. */
function drawBrawl(now) {
  const b = brawlShow;
  brawlAdvance(b, now);
  const s = canvas.width / b.arena.width;
  ctx.save();
  if (now < b.shake.until) {
    const k = (b.shake.until - now) / 700;
    ctx.translate((Math.random() - 0.5) * b.shake.power * k, (Math.random() - 0.5) * b.shake.power * k);
  }
  ctx.scale(s, s);
  // The floor: the bottom of the screen, a line of ink.
  ctx.fillStyle = 'rgba(11, 8, 7, 0.55)';
  ctx.fillRect(0, b.arena.floor, b.arena.width, b.arena.height - b.arena.floor);
  ctx.fillStyle = BRAWL.ink;
  ctx.fillRect(0, b.arena.floor - 2, b.arena.width, 5);
  const change = Math.min(1, (now - b.layoutAt) / 600);
  if (change < 1) drawBrawlLayout(b, b.previousLayout, 1 - change, now);
  drawBrawlLayout(b, b.layout, change, now);

  for (const d of b.drops) if (d.landed) drawBrawlDrop(d, now);
  for (const c of b.chips) if (c.rest) drawBrawlChip(c, now);
  const poses = [];
  for (const f of b.fighters.values()) {
    const pose = brawlPose(b, f, now);
    if (pose) poses.push([f, pose]);
  }
  // The god behind everyone, so the chatters on it stay visible.
  poses.sort(([a], [z]) => (z.role === 'god') - (a.role === 'god'));
  for (const [f, pose] of poses) drawBrawlFighter(b, f, pose, now);
  for (const c of b.chips) if (!c.rest) drawBrawlChip(c, now);
  for (const d of b.drops) if (!d.landed) drawBrawlDrop(d, now);
  drawBrawlEffects(b, now);
  drawBrawlArrival(b, now);
  drawBrawlHud(b, now);
  drawBrawlFall(b, now);
  ctx.restore();
}
