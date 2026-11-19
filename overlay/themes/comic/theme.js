// Dark Fantasy Comic: inked panels, cel-shaded class badges, flat inked flames
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

  /** A class badge as a comic draws it: flat color, a hard shadow crescent, a gleam, heavy ink. */
  function classIcon(ctx, cls, x, y, size, { color, icon }) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = darken(color, 0.38);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.arc(x - size * 0.2, y - size * 0.2, size * 0.95, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, size * 0.2);
    ctx.strokeStyle = INK;
    ctx.stroke();
    // The gleam, upper left.
    ctx.beginPath();
    ctx.arc(x, y, size * 0.68, Math.PI * 1.08, Math.PI * 1.38);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, size * 0.13);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    ctx.translate(x, y);
    icon(size * 0.6, '#140E0B');
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

  Theme.register({ art: { box, classIcon, caption, fireFlames } });
})();
