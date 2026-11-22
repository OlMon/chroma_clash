// Brawl prototype: drawing, in the Dark Fantasy Comic look (ink rims, hard
// shadows, sound-effect bursts). Each fighter is a jelly ball: its outline
// ripples, squashes and stretches, and loses the bits the simulation chipped off.
'use strict';

const BrawlDraw = (() => {
  const { W, FLOOR, RIM, WEAPONS } = BrawlSim;
  const INK = '#0B0807';
  const TAU = Math.PI * 2;
  const POINTS = 56;
  const images = new Map();

  function emoteImage(id) {
    if (!id) return null;
    let entry = images.get(id);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => { entry.ready = true; };
      img.src = `/emotes/twitch/${id}`;
      images.set(id, entry);
    }
    return entry.ready ? entry.img : null;
  }

  /** The rim's ripple at a local angle, between its springs. */
  function rippleAt(f, angle) {
    const p = ((((angle / TAU) * RIM) % RIM) + RIM) % RIM;
    const i = Math.floor(p);
    const t = p - i;
    return f.rim[i] * (1 - t) + f.rim[(i + 1) % RIM] * t;
  }

  /** Sets up the body's frame: position, squash and stretch, rotation. Units are the body's radius. */
  function bodyFrame(ctx, f) {
    const q = f.squash;
    const speed = Math.hypot(f.vx, f.vy);
    const s = f.grounded ? 0 : Math.min(0.16, speed / 9000);
    ctx.translate(f.x, f.y + f.r * Math.max(0, q) * 0.85);
    if (s > 0.005) {
      const phi = Math.atan2(f.vy, f.vx);
      ctx.rotate(phi);
      ctx.scale(1 + s, 1 - s * 0.6);
      ctx.rotate(-phi);
    }
    ctx.scale(1 + q, 1 - q);
    ctx.rotate(f.rot);
    ctx.scale(f.r, f.r);
  }

  function bodyPath(ctx, f, sim, grow = 0) {
    ctx.beginPath();
    for (let j = 0; j <= POINTS; j++) {
      const a = (j / POINTS) * TAU;
      const r = sim.shapeAt(f, a) + rippleAt(f, a) + grow;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function paintInside(ctx, who, flash, hx = 0, hy = 0) {
    ctx.fillStyle = '#1A1714';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const img = emoteImage(who.emote);
    if (img) ctx.drawImage(img, hx - 0.95, hy - 0.95, 1.9, 1.9);
    else {
      ctx.fillStyle = who.color;
      ctx.fillRect(hx - 1, hy - 1, 2, 2);
      ctx.fillStyle = INK;
      ctx.font = 'bold 1.1px "Pirata One", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(who.name[0], hx, hy + 0.05);
    }
    // Comic shading: the lower right in shadow.
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

  function drawFighter(ctx, f, sim, opts) {
    // A soft shadow on the floor, smaller the higher the fighter is.
    const height = Math.max(0, FLOOR - (f.y + f.r));
    const k = Math.max(0.25, 1 - height / 600);
    ctx.fillStyle = `rgba(0, 0, 0, ${0.35 * k})`;
    ctx.beginPath();
    ctx.ellipse(f.x, FLOOR + 2, f.r * 1.1 * k, f.r * 0.22 * k, 0, 0, TAU);
    ctx.fill();

    ctx.save();
    bodyFrame(ctx, f);
    // Hard ink shadow, ink rim, the emote, the name colour's ring.
    ctx.save();
    ctx.rotate(-f.rot);
    ctx.translate(6 / f.r, 6 / f.r);
    ctx.rotate(f.rot);
    bodyPath(ctx, f, sim, 0.1);
    ctx.fillStyle = 'rgba(11, 8, 7, 0.5)';
    ctx.fill();
    ctx.restore();
    bodyPath(ctx, f, sim, 0.12);
    ctx.fillStyle = INK;
    ctx.fill();
    bodyPath(ctx, f, sim);
    paintInside(ctx, f.who, f.flash);
    bodyPath(ctx, f, sim, -0.03);
    ctx.lineWidth = 0.09;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = f.who.color;
    ctx.stroke();
    // A glossy highlight: it is jelly.
    ctx.rotate(-f.rot);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.beginPath();
    ctx.ellipse(-0.38, -0.45, 0.26, 0.13, -0.6, 0, TAU);
    ctx.fill();
    ctx.restore();

    drawWeapon(ctx, f, sim);

    // The name, and the knockouts so far.
    const label = f.kills > 0 ? `${f.who.name}  ${f.kills} KO` : f.who.name;
    ctx.font = '24px "Pirata One", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    const ly = f.y - f.r * 1.25 - 6;
    ctx.strokeText(label, f.x, ly);
    ctx.fillStyle = f.who.color;
    ctx.fillText(label, f.x, ly);
    if (opts.health) {
      const w = f.r * 1.6;
      ctx.fillStyle = INK;
      ctx.fillRect(f.x - w / 2 - 2, ly + 2, w + 4, 8);
      ctx.fillStyle = f.hp > 50 ? '#7BD36B' : f.hp > 25 ? '#F2C14E' : '#E5533D';
      ctx.fillRect(f.x - w / 2, ly + 4, (w * f.hp) / 100, 4);
    }
  }

  function inked(ctx, fill, width = 3) {
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = width;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  function drawWeapon(ctx, f, sim) {
    const { hx, hy, angle, w } = sim.weaponOf(f);
    const r = f.r;
    const len = w.length * r;
    ctx.save();
    ctx.lineJoin = 'round';
    // The swing's smear, behind the blade.
    const a = f.attack;
    if (a && w.kind === 'swing' && a.t > w.windup && a.t < w.windup + w.swing + 0.06) {
      const p = Math.min(1, (a.t - w.windup) / w.swing);
      const face = f.face;
      const start = face === 1 ? -1.75 : Math.PI + 1.75;
      ctx.beginPath();
      ctx.arc(hx, hy, len * 1.02, start, angle, face === -1);
      ctx.arc(hx, hy, len * 0.45, angle, start, face === 1);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 244, 214, ${0.5 * (1 - Math.max(0, p - 0.7) / 0.3)})`;
      ctx.fill();
    }
    ctx.translate(hx, hy);
    ctx.rotate(angle);
    if (f.weapon === 'sword') {
      ctx.beginPath();
      ctx.rect(-r * 0.18, -3.5, r * 0.22, 7);
      inked(ctx, '#6B4A2E');
      ctx.beginPath();
      ctx.rect(r * 0.04, -r * 0.2, 7, r * 0.4);
      inked(ctx, '#C9A44B');
      ctx.beginPath();
      ctx.moveTo(r * 0.14, -5.5);
      ctx.lineTo(len - 12, -5.5);
      ctx.lineTo(len, 0);
      ctx.lineTo(len - 12, 5.5);
      ctx.lineTo(r * 0.14, 5.5);
      ctx.closePath();
      inked(ctx, '#DDE2E8');
      ctx.strokeStyle = 'rgba(11, 8, 7, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(r * 0.2, 0);
      ctx.lineTo(len - 14, 0);
      ctx.stroke();
    } else if (f.weapon === 'axe') {
      ctx.beginPath();
      ctx.rect(-r * 0.15, -4, len, 8);
      inked(ctx, '#7A5333');
      ctx.beginPath();
      ctx.moveTo(len - r * 0.45, -4);
      ctx.quadraticCurveTo(len - r * 0.3, -r * 0.55, len + r * 0.05, -r * 0.62);
      ctx.quadraticCurveTo(len - r * 0.05, 0, len + r * 0.05, r * 0.32);
      ctx.quadraticCurveTo(len - r * 0.3, r * 0.3, len - r * 0.45, 4);
      ctx.closePath();
      inked(ctx, '#C9CED6');
    } else {
      ctx.beginPath();
      ctx.rect(-r * 0.6, -3.5, len + r * 0.6 - 18, 7);
      inked(ctx, '#8A6440');
      ctx.beginPath();
      ctx.moveTo(len - 22, 0);
      ctx.quadraticCurveTo(len - 12, -10, len + 6, 0);
      ctx.quadraticCurveTo(len - 12, 10, len - 22, 0);
      ctx.closePath();
      inked(ctx, '#DDE2E8');
    }
    ctx.restore();
  }

  function drawChip(ctx, c, sim) {
    const age = sim.t - c.born;
    const fade = age > 7 ? 1 - (age - 7) / 2 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade);
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
    ctx.fillStyle = INK;
    ctx.fill();
    path(0);
    paintInside(ctx, c.who, 0, -c.ox, -c.oy);
    ctx.restore();
  }

  function drawDrop(ctx, d, sim) {
    const age = sim.t - d.born;
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 3.5) / 1.5);
    ctx.fillStyle = d.color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (d.landed !== undefined) ctx.ellipse(d.x, d.y, d.r * 1.8, d.r * 0.5, 0, 0, TAU);
    else ctx.arc(d.x, d.y, d.r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** A comic sound-effect burst: a jagged star with a word on it. */
  function burst(ctx, x, y, size, word, fill, age) {
    const pop = age < 0.12 ? age / 0.12 : 1;
    const fade = age > 0.7 ? Math.max(0, 1 - (age - 0.7) / 0.3) : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.rotate(-0.12);
    ctx.scale(pop * (1 + age * 0.15), pop * (1 + age * 0.15));
    ctx.beginPath();
    const spikes = 11;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * TAU;
      const r = i % 2 === 0 ? size : size * 0.62;
      ctx.lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.font = `${Math.round(size * 0.75)}px "Pirata One", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.strokeText(word, 0, 2);
    ctx.fillStyle = '#FFF4D6';
    ctx.fillText(word, 0, 2);
    ctx.restore();
  }

  const VERBS = ['bonked', 'flattened', 'chipped the last bit off', 'splattered', 'diced', 'popped', 'sent home'];

  function draw(ctx, sim, opts) {
    // The floor: the bottom of the stream, just a line of ink.
    ctx.fillStyle = 'rgba(11, 8, 7, 0.55)';
    ctx.fillRect(0, FLOOR, W, 1080 - FLOOR);
    ctx.fillStyle = INK;
    ctx.fillRect(0, FLOOR - 2, W, 5);

    for (const d of sim.drops) if (d.landed !== undefined) drawDrop(ctx, d, sim);
    for (const c of sim.chips) if (c.rest) drawChip(ctx, c, sim);
    for (const f of sim.fighters) if (f.alive) drawFighter(ctx, f, sim, opts);
    for (const c of sim.chips) if (!c.rest) drawChip(ctx, c, sim);
    for (const d of sim.drops) if (d.landed === undefined) drawDrop(ctx, d, sim);

    for (const e of sim.events) {
      const age = sim.t - e.t;
      if (e.k === 'hit') {
        if (e.big && age < 1) burst(ctx, e.x, e.y - 20, 44, ['POW!', 'KRAK!', 'THUD!'][e.v % 3], '#E5533D', age);
        else if (age < 0.8) {
          ctx.globalAlpha = 1 - age / 0.8;
          ctx.font = '30px "Pirata One", serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 5;
          ctx.strokeStyle = INK;
          ctx.strokeText(String(e.v), e.x, e.y - 30 - age * 60);
          ctx.fillStyle = '#FFD54A';
          ctx.fillText(String(e.v), e.x, e.y - 30 - age * 60);
          ctx.globalAlpha = 1;
        }
      } else if (e.k === 'ko' && age < 1.1) {
        burst(ctx, e.x, e.y - 30, 62, 'KO!', '#FFD54A', age / 1.1);
      }
    }

    // The banner on top: what this is and how to join.
    const alive = sim.fighters.filter((f) => f.alive).length;
    ctx.save();
    ctx.translate(W / 2, 46);
    ctx.font = '40px "Pirata One", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const title = 'BRAWL! Write in chat to jump in';
    const tw = ctx.measureText(title).width + 60;
    ctx.beginPath();
    ctx.rect(-tw / 2, -30, tw, 60);
    ctx.fillStyle = 'rgba(30, 23, 19, 0.93)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = '#FFD54A';
    ctx.fillText(title, 0, 2);
    ctx.font = '24px "Pirata One", serif';
    ctx.lineWidth = 5;
    const sub = `${alive} of ${sim.size} fighting${sim.queue.length ? ` · ${sim.queue.length} waiting` : ''}`;
    ctx.strokeText(sub, 0, 50);
    ctx.fillStyle = '#F3E6C8';
    ctx.fillText(sub, 0, 50);
    ctx.restore();

    // The feed: who knocked out whom.
    ctx.save();
    ctx.font = '26px "Pirata One", serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    let y = 40;
    for (const e of sim.events.filter((x) => x.k === 'ko').slice(-5).reverse()) {
      const age = sim.t - e.t;
      ctx.globalAlpha = age > 5 ? 1 - (age - 5) : 1;
      const parts = [[e.by.who.name, e.by.who.color], [` ${VERBS[(e.f.id + e.by.id) % VERBS.length]} `, '#F3E6C8'], [e.f.who.name, e.f.who.color]];
      let x = 40;
      for (const [text, color] of parts) {
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
      }
      y += 34;
    }
    ctx.restore();
  }

  return { draw };
})();
