// Dark Fantasy Comic: inked panels, flat inked flames
// and the god's skills as a sound-effect burst. The ink rims on fighters and
// map tiles and the halftone dots over everything come from theme.json ("ink",
// "halftone"); this script only draws the elements that look different.
'use strict';

(() => {
  const INK = '#0B0807';

  /** A stable number from 0 to 1 for a seed: the same panel wobbles the same way every frame. */
  function noise(seed) {
    const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  /** A color darkened toward black by `share` (0 to 1). Accepts #RRGGBB. */
  function darken(color, share) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    if (!match) return color;
    const [r, g, b] = match.slice(1).map((part) => Math.round(parseInt(part, 16) * (1 - share)));
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * A rectangle as if inked by hand: cut corners, and edges a little off true.
   * Only builds the path.
   */
  function inkedRect(ctx, x, y, width, height, cut, jitter, seed) {
    const corners = [
      [x + cut, y], [x + width - cut, y], [x + width, y + cut], [x + width, y + height - cut],
      [x + width - cut, y + height], [x + cut, y + height], [x, y + height - cut], [x, y + cut],
    ];
    ctx.beginPath();
    let index = 0;
    corners.forEach(([x1, y1], c) => {
      const [x2, y2] = corners[(c + 1) % corners.length];
      const steps = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 90));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const px = x1 + (x2 - x1) * t + (noise(seed + index * 1.7) - 0.5) * jitter * 2;
        const py = y1 + (y2 - y1) * t + (noise(seed + index * 2.3 + 9) - 0.5) * jitter * 2;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        index++;
      }
    });
    ctx.closePath();
  }

  /**
   * A panel: dark, worn leather-brown, a heavy ink border, a thin parchment
   * rule inside with small diamonds at its corners, and the accent as a
   * stroke of a brush down the left side.
   */
  function box(ctx, x, y, width, height, { accent, strong }) {
    const seed = x * 0.13 + y * 0.71 + width * 0.031 + height * 0.017;
    const cut = Math.min(12, height / 6);
    ctx.save();
    const body = ctx.createLinearGradient(0, y, 0, y + height);
    body.addColorStop(0, strong ? 'rgba(48, 37, 30, 0.97)' : 'rgba(48, 37, 30, 0.93)');
    body.addColorStop(1, strong ? 'rgba(22, 16, 13, 0.97)' : 'rgba(22, 16, 13, 0.93)');
    // The hard comic shadow, down and to the right.
    inkedRect(ctx, x + 6, y + 6, width, height, cut, 1.4, seed);
    ctx.fillStyle = 'rgba(11, 8, 7, 0.5)';
    ctx.fill();
    inkedRect(ctx, x, y, width, height, cut, 1.4, seed);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();

    if (width > 60 && height > 40) {
      const inset = 8;
      inkedRect(ctx, x + inset, y + inset, width - inset * 2, height - inset * 2, Math.max(0, cut - 4), 0.8, seed + 5);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(205, 180, 130, 0.5)';
      ctx.stroke();
      ctx.fillStyle = '#CDB482';
      for (const [cx, cy] of [[x + inset, y + inset], [x + width - inset, y + inset], [x + inset, y + height - inset], [x + width - inset, y + height - inset]]) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx + 4, cy);
        ctx.lineTo(cx, cy + 4);
        ctx.lineTo(cx - 4, cy);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (accent) {
      // A brush stroke: thick in the middle, tapering to points, slightly bent.
      const left = x + 13;
      const top = y + 12;
      const bottom = y + height - 12;
      const bend = (noise(seed + 3) - 0.5) * 4;
      ctx.beginPath();
      ctx.moveTo(left, top);
      ctx.quadraticCurveTo(left + 7 + bend, (top + bottom) / 2, left + 1, bottom);
      ctx.quadraticCurveTo(left - 6 + bend, (top + bottom) / 2, left, top);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The god's skill, shouted like a comic's sound effect: a jagged burst in
   * blood red and fire, the word slanted across it in heavy letters, with a
   * shadow in the caster's color.
   */
  function caption(ctx, text, { color, age, width }) {
    const shake = Math.sin(age / 45) * Math.max(0, 1 - age / 400);
    ctx.rotate(-0.04 + shake * 0.04);
    const rx = width / 2 + 90;
    const ry = 92;
    const spikes = 26;
    const burst = (scale) => {
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const angle = (i / (spikes * 2)) * Math.PI * 2;
        const long = i % 2 === 0;
        const reach = (long ? 1 : 0.78) * (long ? 0.9 + 0.2 * noise(i * 3.1) : 1) * scale;
        const px = Math.cos(angle) * rx * reach;
        const py = Math.sin(angle) * ry * reach;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };
    burst(1);
    ctx.fillStyle = '#8E1A12';
    ctx.fill();
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    burst(0.72);
    ctx.fillStyle = '#E2902E';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();

    // Slanted letters: a heavy outline, a shadow in the caster's color, a bone-white face.
    ctx.transform(1, 0, -0.14, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 16;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, 7, 7);
    ctx.fillStyle = color;
    ctx.fillText(text, 7, 7);
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#FFF1D2';
    ctx.fillText(text, 0, 0);
  }

  /** How strongly a fire burns: it flares up quickly and dies down over its last second. */
  function fireStrength(mark, now) {
    const age = now - mark.start;
    return Math.max(0, Math.min(1, age / 150) * Math.min(1, (mark.ms - age) / 1000));
  }

  /**
   * Comic flames: flat tongues in three colors, solid enough that the ink
   * pass draws one bold outline around the whole fire; thick smoke puffs
   * above and sparks as little diamonds.
   */
  function fireFlames(ctx, mark, now) {
    const strength = fireStrength(mark, now);
    if (strength <= 0) return;
    const { x, y, r } = mark;
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const phase = (now / 2600 + noise(x + i * 5.1)) % 1;
      const sx = x + (noise(i * 9.7 + y) - 0.5) * r + Math.sin(now / 700 + i) * 8;
      const sy = y - r * 1.6 - phase * r * 2;
      ctx.globalAlpha = 0.9 * strength * Math.sin(Math.PI * phase);
      ctx.beginPath();
      ctx.arc(sx, sy, r * (0.22 + 0.4 * phase), 0, Math.PI * 2);
      ctx.fillStyle = '#4A413C';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
    ctx.globalAlpha = strength;
    const layers = [
      { color: '#B01E10', height: 1.7, width: 0.3, count: 8 },
      { color: '#EE6A14', height: 1.25, width: 0.23, count: 7 },
      { color: '#FFD24A', height: 0.8, width: 0.16, count: 5 },
    ];
    layers.forEach((layer, depth) => {
      const tongues = [];
      for (let i = 0; i < layer.count; i++) {
        const seed = x * 0.37 + y * 0.11 + depth * 17 + i * 3.7;
        const spread = (noise(seed) - 0.5) * 2;
        const fx = x + spread * r * (0.9 - depth * 0.22);
        const fy = y + noise(seed + 1) * r * 0.2;
        const lick = 0.7 + 0.3 * Math.sin(now / (80 + 30 * noise(seed + 2)) + seed);
        const height = r * layer.height * lick * strength * (1 - Math.abs(spread) * 0.35);
        const half = r * layer.width;
        const sway = Math.sin(now / 200 + seed) * half * 0.9;
        const tongue = new Path2D();
        tongue.moveTo(fx - half, fy);
        tongue.bezierCurveTo(fx - half * 1.1, fy - height * 0.5, fx + sway, fy - height * 0.55, fx + sway * 1.5, fy - height);
        tongue.bezierCurveTo(fx + sway * 0.6, fy - height * 0.5, fx + half * 1.1, fy - height * 0.4, fx + half, fy);
        tongue.closePath();
        tongues.push(tongue);
      }
      // The outer flames get one bold ink line around all of them: inked first, then filled over.
      if (depth === 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 7;
        ctx.strokeStyle = INK;
        for (const tongue of tongues) ctx.stroke(tongue);
      }
      ctx.fillStyle = layer.color;
      for (const tongue of tongues) ctx.fill(tongue);
    });
    for (let i = 0; i < 10; i++) {
      const seed = x + y * 0.5 + i * 13.37;
      const phase = (now / (1200 + 600 * noise(seed)) + noise(seed + 4)) % 1;
      const ex = x + (noise(seed + 5) - 0.5) * r * 1.4 + Math.sin(now / 250 + i) * 8 * phase;
      const ey = y - phase * r * 2.4;
      const s = 5 * (1 - phase) + 2;
      ctx.globalAlpha = strength * (1 - phase);
      ctx.fillStyle = phase < 0.5 ? '#FFE07A' : '#F07A22';
      ctx.beginPath();
      ctx.moveTo(ex, ey - s);
      ctx.lineTo(ex + s * 0.6, ey);
      ctx.lineTo(ex, ey + s);
      ctx.lineTo(ex - s * 0.6, ey);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Dense halftone dots, cached per canvas: the shading on the dark side of things. */
  const dotPatterns = new WeakMap();
  function dots(ctx) {
    let pattern = dotPatterns.get(ctx);
    if (!pattern) {
      const tile = document.createElement('canvas');
      tile.width = 6;
      tile.height = 6;
      const t = tile.getContext('2d');
      t.fillStyle = 'rgba(11, 8, 7, 0.62)';
      for (const [x, y] of [[1.5, 1.5], [4.5, 4.5]]) {
        t.beginPath();
        t.arc(x, y, 1.45, 0, Math.PI * 2);
        t.fill();
      }
      pattern = ctx.createPattern(tile, 'repeat');
      dotPatterns.set(ctx, pattern);
    }
    return pattern;
  }

  /** Shading on the dark side of a shape: the caller has clipped to it. */
  function shade(ctx, x, y, width, height) {
    ctx.fillStyle = dots(ctx);
    ctx.fillRect(x, y, width, height);
  }

  /**
   * A comic sunburst behind a winner: flat wedges in the color and in
   * parchment, each edged in ink, no soft light. The context is already
   * moved to the middle and turned.
   */
  function rays(ctx, { count, length, color, alpha }) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.lineJoin = 'miter';
    for (let i = 0; i < count; i++) {
      const a0 = (i / count) * Math.PI * 2;
      const a1 = ((i + 0.5) / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * length, Math.sin(a0) * length);
      ctx.lineTo(Math.cos(a1) * length, Math.sin(a1) * length);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? color : '#F3E2B3';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * A mage's circle, inked: a flat disc in the mage's color, a heavy ink
   * ring, a ring of rune ticks turning, and a parchment star with ink edges.
   */
  function mageRune(ctx, x, y, radius, p, now, color) {
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.3 * p;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.6 + 0.4 * p;
    ctx.lineWidth = 7;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#F3E2B3';
    ctx.stroke();
    const spin = now / 900;
    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const angle = spin + (i / 12) * Math.PI * 2;
      const from = radius * 0.78;
      const to = radius * (i % 3 === 0 ? 0.96 : 0.9);
      for (const [width, stroke] of [[6, INK], [2.5, '#F3E2B3']]) {
        ctx.lineWidth = width;
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * from, y + Math.sin(angle) * from);
        ctx.lineTo(x + Math.cos(angle) * to, y + Math.sin(angle) * to);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const angle = -spin * 1.4 + (i / 12) * Math.PI * 2;
      const reach = radius * (i % 2 === 0 ? 0.68 : 0.36);
      const px = x + Math.cos(angle) * reach;
      const py = y + Math.sin(angle) * reach;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#F3E2B3';
    ctx.globalAlpha = 0.5 + 0.5 * p;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  /** A jagged comic burst around 0, 0: `rx` by `ry`, `spikes` points, its own wobble from `seed`. */
  function burstPath(ctx, rx, ry, spikes, seed) {
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i / (spikes * 2)) * Math.PI * 2;
      const long = i % 2 === 0;
      const reach = long ? 0.92 + 0.22 * noise(seed + i * 3.1) : 0.62;
      const px = Math.cos(angle) * rx * reach;
      const py = Math.sin(angle) * ry * reach;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** Heavy comic letters: an ink outline, a shadow in `shadow`, a `face` colored front. */
  function shout(ctx, text, size, face, shadow) {
    ctx.font = `900 ${size}px ${Theme.current.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(5, size * 0.22);
    ctx.strokeStyle = INK;
    ctx.strokeText(text, 3, 3);
    ctx.fillStyle = shadow;
    ctx.fillText(text, 3, 3);
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = face;
    ctx.fillText(text, 0, 0);
  }

  const HEAVY = ['POW!', 'KRAK!', 'BAM!', 'WHAM!', 'THWACK!'];
  const KNOCKOUT = ['KO!', 'BONK!', 'SPLAT!'];

  /**
   * A big hit as a comic shouts it: the heaviest (40 or more, or a killing
   * blow, and the biggest of its blow) in a jagged burst with a sound word and
   * the number under it; the others as slanted inked numbers.
   */
  function damageNumber(ctx, x, y, value, { age, lethal, skill, seed, rank }) {
    const pop = Math.min(1.15, age < 140 ? (age / 140) * 1.15 : 1.15 - Math.min(0.15, (age - 140) / 600));
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    ctx.rotate((noise(seed) - 0.5) * 0.3);
    // Only the biggest of a blow gets the burst, so a blow that hits a crowd does not bury it.
    if ((value >= 40 || lethal) && !rank) {
      burstPath(ctx, 82, 54, 11, seed);
      ctx.fillStyle = lethal ? '#B01E10' : '#E2902E';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      burstPath(ctx, 60, 39, 11, seed + 7);
      ctx.fillStyle = '#FFD24A';
      ctx.fill();
      ctx.transform(1, 0, -0.15, 1, 0, 0);
      shout(ctx, HEAVY[Math.floor(noise(seed + 2) * HEAVY.length)], 34, '#FFF1D2', lethal ? '#B01E10' : '#8E1A12');
      // The number under the burst.
      ctx.translate(4, 50);
      shout(ctx, String(value), 26, lethal ? '#FF8A7A' : '#FFF1D2', '#0B0807');
      return;
    }
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    shout(ctx, String(value), 30, skill ? '#FFD24A' : '#FFF1D2', '#8E1A12');
  }

  /** Where a fighter falls: a small burst with "KO!", popping up and fading. */
  function knockout(ctx, x, y, age, seed, { life }) {
    const p = age / life;
    const pop = p < 0.2 ? p / 0.2 : 1;
    ctx.globalAlpha *= Math.min(1, (1 - p) / 0.35);
    ctx.translate(x, y - 10 - 18 * p);
    ctx.scale(pop, pop);
    ctx.rotate((noise(seed) - 0.5) * 0.5);
    burstPath(ctx, 40, 28, 9, seed);
    ctx.fillStyle = '#F3E2B3';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    shout(ctx, KNOCKOUT[Math.floor(noise(seed + 5) * KNOCKOUT.length)], 22, '#B01E10', '#0B0807');
  }

  Theme.register({ art: { box, caption, fireFlames, shade, rays, mageRune, damageNumber, knockout } });
})();
