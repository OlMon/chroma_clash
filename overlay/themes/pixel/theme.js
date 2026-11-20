// Pixel RPG: window frames, class icons, obstacles, burning tiles, Pachinko
// pins and fireworks as pixel sprites. Everything else comes from the
// built-in drawing, which the theme's pixel scale turns chunky.
'use strict';

(() => {
  /** Rounds a length to whole pixels of the theme, so edges stay crisp. */
  const snap = (value, px) => Math.round(value / px) * px;

  /**
   * The window frame of an old role-playing game: a black edge, a light
   * border, and a deep blue body that darkens downward. Square, with the
   * corner pixels left out.
   */
  function box(ctx, x, y, width, height, { px, accent, strong }) {
    const left = snap(x, px);
    const top = snap(y, px);
    const w = snap(width, px);
    const h = snap(height, px);
    const rect = (inset, color, cut) => {
      ctx.fillStyle = color;
      const i = inset * px;
      const c = cut * px;
      ctx.fillRect(left + i + c, top + i, w - 2 * i - 2 * c, h - 2 * i);
      ctx.fillRect(left + i, top + i + c, w - 2 * i, h - 2 * i - 2 * c);
    };
    rect(0, 'rgba(8, 8, 18, 0.95)', 1);
    rect(1, '#ECE6D2', 1);
    rect(2, '#8C8A9E', 0);
    const body = ctx.createLinearGradient(0, top, 0, top + h);
    body.addColorStop(0, strong ? 'rgba(46, 62, 140, 0.97)' : 'rgba(46, 62, 140, 0.9)');
    body.addColorStop(1, strong ? 'rgba(18, 24, 66, 0.97)' : 'rgba(18, 24, 66, 0.9)');
    rect(3, body, 0);
    if (accent) {
      ctx.fillStyle = accent;
      ctx.fillRect(left + 4 * px, top + 4 * px, 3 * px, h - 8 * px);
    }
  }

  /** Class icons, 7 by 7: `#` is the icon, `.` lets the badge color show through. */
  const ICONS = {
    fighter: ['......#', '.....#.', '....#..', '.#.#...', '..#....', '.#.#...', '#......'],
    tank: ['#######', '###.###', '#.....#', '###.###', '###.###', '.##.##.', '..###..'],
    thief: ['...#...', '..###..', '.#####.', '##.#.##', '#######', '#######', '#.....#'],
    archer: ['.#.....', '#.#....', '#..#..#', '#######', '#..#..#', '#.#....', '.#.....'],
    mage: ['....#..', '...###.', '....#..', '...#...', '..#....', '.#.....', '#......'],
    healer: ['..###..', '..###..', '#######', '#######', '#######', '..###..', '..###..'],
  };

  /** The badge disc, 11 by 11: `o` the dark edge, `c` the class color, `h` a highlight. */
  const DISC = [
    '...ooooo...',
    '.oohhcccoo.',
    '.ohhccccco.',
    'ohhccccccco',
    'ohcccccccco',
    'occccccccco',
    'occccccccco',
    'occccccccCo',
    '.occcccCCo.',
    '.ooCCCCCoo.',
    '...ooooo...',
  ];

  function classIcon(ctx, cls, x, y, size, { px, color }) {
    const icon = ICONS[cls];
    if (!icon) return;
    // A cell is at least one theme pixel; the badge is 11 cells across.
    const cell = Math.max(px, snap((size * 2) / 11, px));
    const left = snap(x - cell * 5.5, px);
    const top = snap(y - cell * 5.5, px);
    const colors = { o: '#14121C', c: color || '#FFFFFF', h: '#FFFFFF', C: 'rgba(0, 0, 0, 0.25)' };
    DISC.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const key = row[c];
        if (key === '.') continue;
        ctx.fillStyle = colors[key] || colors.c;
        ctx.fillRect(left + c * cell, top + r * cell, cell, cell);
      }
    });
    ctx.fillStyle = '#14121C';
    icon.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '#') ctx.fillRect(left + (c + 2) * cell, top + (r + 2) * cell, cell, cell);
      }
    });
  }

  // --- Sprites for the battlefield, the map and Pachinko -------------------------

  const OUTLINE = '#14121C';

  /** A small stable number from 0 to 1 for a seed. */
  function noise(seed) {
    const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  }

  /** One square of `size` at a theme-pixel-aligned spot. */
  function dot(ctx, x, y, size, color, px) {
    ctx.fillStyle = color;
    ctx.fillRect(snap(x, px), snap(y, px), size, size);
  }

  /**
   * A round sprite painted cell by cell: `cells` across, about `radius` in
   * size, each cell's color from `paint(dx, dy, distance, R)` (cell units from
   * the middle; null leaves it empty).
   */
  function disc(ctx, x, y, radius, cells, paint, px) {
    const cell = Math.max(px, snap((radius * 2) / cells, px));
    const R = cells / 2;
    const left = snap(x - R * cell, px);
    const top = snap(y - R * cell, px);
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const dx = c + 0.5 - R;
        const dy = r + 0.5 - R;
        const d = Math.hypot(dx, dy);
        if (d > R) continue;
        const color = paint(dx, dy, d, R);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(left + c * cell, top + r * cell, cell, cell);
      }
    }
    return cell;
  }

  /** A pinball bumper: dark rim, red and white rings, a cap with a gleam; lit, it flashes gold. */
  function bumper(ctx, x, y, r, lit, now, { px }) {
    const cell = disc(ctx, x, y, r, 13, (dx, dy, d, R) => {
      if (d > R - 1) return OUTLINE;
      if (d > R - 2.4) return lit ? '#FFF6C8' : '#C7322B';
      if (d > R - 3.8) return '#F4EEE6';
      if (dx < -0.4 && dy < -0.4 && d < 1.8) return '#FFFFFF';
      return lit ? '#FFD84A' : (dx + dy > 1.5 ? '#B5322C' : '#E0473F');
    }, px);
    if (lit && Math.floor(now / 60) % 2 === 0) {
      // Flashing sparks on four sides.
      const reach = 7.5 * cell;
      for (const [sx, sy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) dot(ctx, x + sx * reach - cell / 2, y + sy * reach - cell / 2, cell, '#FFE27A', px);
    }
  }

  /**
   * A barrel rolling: staves and two hoops, its stripes turning a quarter at
   * a time as it rolls. Broken: a few planks flying apart.
   */
  function barrel(ctx, x, y, r, rolled, broken, id, { px }) {
    if (broken) {
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2 + id;
        const cell = Math.max(px, snap(r / 4, px));
        const bx = x + Math.cos(angle) * r;
        const by = y + Math.sin(angle) * r;
        ctx.fillStyle = OUTLINE;
        ctx.fillRect(snap(bx - cell * 1.5, px) - px, snap(by - cell / 2, px) - px, cell * 3 + 2 * px, cell + 2 * px);
        ctx.fillStyle = '#9A6634';
        ctx.fillRect(snap(bx - cell * 1.5, px), snap(by - cell / 2, px), cell * 3, cell);
      }
      return;
    }
    const turned = Math.floor(rolled / (Math.PI / 2)) % 2 === 1;
    disc(ctx, x, y, r, 12, (dx, dy, d, R) => {
      if (d > R - 1) return OUTLINE;
      const [along, across] = turned ? [dy, dx] : [dx, dy];
      if (Math.abs(Math.abs(across) - R * 0.45) < 0.6) return '#4C4A48';
      if ([-2.5, 0.5, 3.5].some((s) => Math.abs(along - s) < 0.5)) return '#6E4320';
      return dx + dy < -2 ? '#B98048' : '#9A6634';
    }, px);
  }

  /** A spike trap: an iron grate; its rim blinks red before it strikes, then spikes shoot up. */
  function trap(ctx, x, y, r, state, now, { px }) {
    const warn = state === 1 && Math.floor(now / 90) % 2 === 0;
    const holes = [[0, 0], [-2.6, -1.8], [2.6, -1.8], [-2.6, 2], [2.6, 2], [0, -3.6], [0, 3.6]];
    const cell = disc(ctx, x, y, r, 13, (dx, dy, d, R) => {
      if (d > R - 1) return warn ? '#FF4632' : OUTLINE;
      if (state !== 2 && holes.some(([hx, hy]) => Math.abs(dx - hx) < 0.6 && Math.abs(dy - hy) < 0.6)) return state === 1 ? '#8A2A20' : '#0D0C0B';
      return (Math.floor(dx + 10) + Math.floor(dy + 10)) % 4 === 0 ? '#45403D' : '#3A3634';
    }, px);
    if (state !== 2) return;
    // Spikes: a light point with a dark edge on each hole.
    for (const [hx, hy] of holes) {
      const sx = snap(x + hx * cell, px);
      const sy = snap(y + hy * cell, px);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(sx - cell * 1.5, sy - cell * 0.5, cell * 3, cell * 1.5);
      ctx.fillStyle = '#E4E6EA';
      ctx.fillRect(sx - cell, sy - cell * 0.5, cell * 2, cell);
      ctx.fillRect(sx - cell / 2, sy - cell * 1.5, cell, cell);
    }
  }

  /** A stone wall: dark edge, bricks in rows with mortar between, every other row shifted, a light top row. */
  function wall(ctx, x, y, w, h, id, { px }) {
    const left = snap(x - w / 2, px);
    const top = snap(y - h / 2, px);
    const width = Math.max(4 * px, snap(w, px));
    const height = Math.max(4 * px, snap(h, px));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(left + px * 2, top + px * 2, width, height);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(left, top, width, height);
    const across = width >= height;
    const inner = { left: left + px, top: top + px, width: width - 2 * px, height: height - 2 * px };
    const thick = across ? inner.height : inner.width;
    const length = across ? inner.width : inner.height;
    const rows = 2;
    const rowSize = Math.max(px, snap(thick / rows, px));
    const brick = Math.max(3 * px, snap(rowSize * 2.2, px));
    for (let row = 0; row < rows; row++) {
      const r0 = row * rowSize;
      const size = row === rows - 1 ? thick - r0 : rowSize;
      for (let at = row % 2 === 0 ? 0 : -Math.floor(brick / 2 / px) * px; at < length; at += brick) {
        const start = Math.max(0, at);
        const end = Math.min(length, at + brick - px);
        if (end <= start) continue;
        ctx.fillStyle = noise(id * 31 + row * 7 + at) < 0.5 ? '#857D76' : '#6C655F';
        if (across) ctx.fillRect(inner.left + start, inner.top + r0, end - start, size - px);
        else ctx.fillRect(inner.left + r0, inner.top + start, size - px, end - start);
      }
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    if (across) ctx.fillRect(inner.left, inner.top, inner.width, px);
    else ctx.fillRect(inner.left, inner.top, px, inner.height);
  }

  /** A wall the god broke: square bricks flying apart, `ms` after it broke. */
  function rubble(ctx, x, y, w, h, id, ms, { px }) {
    const p = Math.min(1, ms / 450);
    const across = w >= h;
    const length = across ? w : h;
    const thick = Math.max(2 * px, snap(across ? h : w, px));
    const pieces = Math.max(6, Math.round(length / thick));
    ctx.globalAlpha *= 1 - p * p;
    for (let i = 0; i < pieces; i++) {
      const along = ((i + 0.5) / pieces - 0.5) * length;
      const side = noise(id * 13 + i) < 0.5 ? -1 : 1;
      const fly = thick * (0.6 + 2.4 * noise(id * 7 + i * 3)) * p;
      const bx = x + (across ? along : side * fly);
      const by = y + (across ? side * fly : along);
      const size = snap(thick * 0.7, px);
      dot(ctx, bx - size / 2 - px, by - size / 2 - px, size + 2 * px, OUTLINE, px);
      dot(ctx, bx - size / 2, by - size / 2, size, noise(id + i) < 0.5 ? '#857D76' : '#6C655F', px);
    }
  }

  /** Flames on a burning map tile: three little pixel fires that flicker between two shapes. */
  const FLAMES = [
    ['..r..', '.rr..', '.ror.', 'rooor', 'royor', '.ryr.'],
    ['...r.', '..rr.', '.ror.', 'roorr', 'royor', '.ryr.'],
  ];
  function tileFlames(ctx, x, y, size, now, seed, { px }) {
    const colors = { r: '#C8321E', o: '#F28A1E', y: '#FFE07A' };
    const cell = Math.max(px, snap(size / 9, px));
    [-0.42, 0, 0.42].forEach((at, i) => {
      const shape = FLAMES[(Math.floor(now / 160) + i + seed) % 2];
      const left = snap(x + at * size - cell * 2.5, px);
      const top = snap(y + size * 0.62 - cell * shape.length - (i === 1 ? cell : 0), px);
      shape.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
          const key = row[c];
          if (key === '.') continue;
          ctx.fillStyle = colors[key];
          ctx.fillRect(left + c * cell, top + r * cell, cell, cell);
        }
      });
    });
  }

  /** A Pachinko pin: a small studded plus; hit, a gold diamond that shrinks back. */
  function pachinkoPin(ctx, x, y, r, glow, { px }) {
    const cell = Math.max(px, snap(r * 0.7, px));
    const left = snap(x - cell * 1.5, px);
    const top = snap(y - cell * 1.5, px);
    if (glow > 0.3) {
      ctx.fillStyle = '#FFD34A';
      ctx.fillRect(left - cell, top + cell, cell * 5, cell);
      ctx.fillRect(left + cell, top - cell, cell, cell * 5);
    }
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(left, top + cell, cell * 3, cell);
    ctx.fillRect(left + cell, top, cell, cell * 3);
    ctx.fillStyle = glow > 0 ? '#FFF2B0' : '#D9DEE6';
    ctx.fillRect(left + cell, top + cell, cell, cell);
  }

  /** A jackpot's firework in pixels: a rocket with a stepped trail, then square sparks flying out and falling. */
  function firework(ctx, fromX, x, fromY, toY, t, color, seed, { px, climbMs, burstMs, sparks }) {
    const cell = 2 * px;
    if (t < climbMs) {
      const p = t / climbMs;
      const along = 1 - (1 - p) * (1 - p);
      const hx = fromX + (x - fromX) * along;
      const hy = fromY + (toY - fromY) * along;
      for (let k = 4; k >= 1; k--) {
        const back = Math.max(0, along - k * 0.035);
        dot(ctx, fromX + (x - fromX) * back, fromY + (toY - fromY) * back, cell, k > 2 ? '#F28A1E' : '#FFE07A', px);
      }
      dot(ctx, hx - px, hy - px, cell + 2 * px, '#FFF6CF', px);
      return;
    }
    const b = (t - climbMs) / burstMs;
    if (b >= 1) return;
    for (let i = 0; i < sparks; i++) {
      const angle = (i / sparks) * Math.PI * 2 + noise(seed + i) * 0.3;
      const out = (150 + 70 * noise(seed + i * 3)) * (1 - Math.pow(1 - b, 2.2));
      const sx = x + Math.cos(angle) * out;
      const sy = toY + Math.sin(angle) * out + 90 * b * b;
      const c = i % 3 === 0 ? color : i % 3 === 1 ? '#FFD34A' : '#FFF6CF';
      if (b < 0.85 || Math.floor(t / 70 + i) % 2 === 0) {
        dot(ctx, sx, sy, b < 0.5 ? cell * 1.5 : cell, c, px);
        dot(ctx, x + Math.cos(angle) * out * 0.85, toY + Math.sin(angle) * out * 0.85 + 90 * b * b, cell / 2, c, px);
      }
    }
  }

  Theme.register({ art: { box, classIcon, bumper, barrel, trap, wall, rubble, tileFlames, pachinkoPin, firework } });
})();
