// Pixel RPG: window frames and class icons as pixel sprites. Everything else
// comes from the built-in drawing, which the theme's pixel scale turns chunky.
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

  Theme.register({ art: { box, classIcon } });
})();
