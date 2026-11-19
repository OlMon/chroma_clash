/*
 * Chroma Clash website: the menu, three small canvas animations and two clips
 * recorded from the real overlay.
 * Each one only runs while it is on screen, and waits for a click on
 * "Play" when the visitor prefers reduced motion.
 */
(() => {
  'use strict';

  const GUILDS = [
    { name: 'Red', color: '#E5484D', light: '#FF8589', hue: 0 },
    { name: 'Green', color: '#46A758', light: '#74D887', hue: 120 },
    { name: 'Blue', color: '#3E8BFF', light: '#85B5FF', hue: 240 },
  ];
  const GOD = '#FFD54A';
  const HEAD_FONT = '"Jersey 10", ui-monospace, monospace';
  const TAU = Math.PI * 2;

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  /** A chatter's own name colour: a hue inside the guild's range. */
  const nameColor = (guild) => `hsl(${(GUILDS[guild].hue + rand(-50, 50) + 360) % 360} 78% 62%)`;

  // ---------------------------------------------------------------- menu
  const menuBtn = document.querySelector('.menu-btn');
  const nav = document.getElementById('nav');
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---------------------------------------------------------------- shared drawing
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function banner(ctx, W, y, text, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `44px ${HEAD_FONT}`;
    const w = Math.min(W - 20, ctx.measureText(text).width + 56);
    roundRect(ctx, (W - w) / 2, y - 32, w, 60, 12);
    ctx.fillStyle = 'rgba(8, 10, 16, 0.88)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, y + 1, W - 40);
    ctx.restore();
  }

  // ---------------------------------------------------------------- animation harness
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mountAnimation(canvas, scene) {
    // A wide scene can ask for a narrower canvas on phones, so it is not drawn tiny.
    const narrow = canvas.dataset.narrow && canvas.clientWidth > 0 && canvas.clientWidth < 600;
    if (narrow) [canvas.width, canvas.height] = canvas.dataset.narrow.split('x').map(Number);
    const W = canvas.width;
    const H = canvas.height;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene.init(W, H);

    const STEP = 1 / 60;
    let visible = false;
    let playing = !reducedMotion.matches;
    let running = false;
    let raf = 0;
    let last = 0;
    let carry = 0;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.draw(ctx);
    };
    const frame = (now) => {
      carry += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (carry >= STEP) {
        scene.update(STEP);
        carry -= STEP;
      }
      draw();
      raf = requestAnimationFrame(frame);
    };
    const sync = () => {
      const should = visible && playing && !document.hidden;
      if (should && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    // A still picture that already shows the idea: run the scene forward a little.
    for (let i = 0; i < (scene.warmup || 4) * 60; i++) scene.update(STEP);
    draw();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!running) draw(); });

    // Pause / play, for everyone: required when the visitor prefers reduced motion.
    addPlayButton(canvas.closest('figure') || canvas.parentElement, () => playing, () => {
      playing = !playing;
      sync();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const entry of entries) visible = entry.isIntersecting;
        sync();
      }, { rootMargin: '60px' }).observe(canvas);
    } else {
      visible = true;
    }
    document.addEventListener('visibilitychange', sync);
    sync();
  }

  /** The Pause / Play button under a figure, shared by the animations and the recorded clips. */
  function addPlayButton(figure, isPlaying, toggle) {
    const host = figure.querySelector('figcaption') || figure;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'play-btn';
    const label = () => {
      button.textContent = isPlaying() ? 'Pause' : 'Play';
      button.setAttribute('aria-label', `${isPlaying() ? 'Pause' : 'Play'} animation`);
    };
    label();
    button.addEventListener('click', () => {
      toggle();
      label();
    });
    host.appendChild(button);
  }

  /**
   * A clip recorded from the real overlay: a silent looping video that plays
   * like a GIF while it is on screen. It stays on its first frame when the
   * visitor prefers reduced motion, until they press Play.
   */
  function mountClip(video) {
    let visible = false;
    let playing = !reducedMotion.matches;
    const sync = () => {
      if (visible && playing && !document.hidden) video.play().catch(() => {});
      else video.pause();
    };
    addPlayButton(video.closest('figure') || video.parentElement, () => playing, () => {
      playing = !playing;
      sync();
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const entry of entries) visible = entry.isIntersecting;
        sync();
      }, { rootMargin: '60px' }).observe(video);
    } else {
      visible = true;
    }
    document.addEventListener('visibilitychange', sync);
    sync();
  }

  // ================================================================ 1. hex map
  function mapScene() {
    const SQ3 = Math.sqrt(3);
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const CITIES = [[2, -2], [0, 2], [-2, 0]];
    const RED_SECTOR = [[1, -2], [1, -1], [2, -1], [1, 0], [2, 0]];
    const rotate = ([q, r]) => [-q - r, q]; // a third of a circle
    const GOAL = 900;
    let W, H, S, cx, cy;
    let tiles, byKey, effects, mono, t, timers, log, finish;

    const key = (q, r) => `${q},${r}`;
    const pos = (tile) => ({ x: cx + S * SQ3 * (tile.q + tile.r / 2), y: cy + S * 1.5 * tile.r });
    const neighbors = (tile) => DIRS.map(([dq, dr]) => byKey.get(key(tile.q + dq, tile.r + dr))).filter(Boolean);
    const say = (text, color) => { log = { text, color, age: 0 }; };

    function reset() {
      tiles = [];
      byKey = new Map();
      for (let q = -2; q <= 2; q++) {
        for (let r = -2; r <= 2; r++) {
          if (Math.abs(q + r) > 2) continue;
          const tile = { q, r, owner: -1, level: 0, points: 0, city: false, center: q === 0 && r === 0, rate: rand(0.3, 1.8), hold: 0, scorch: 0 };
          tiles.push(tile);
          byKey.set(key(q, r), tile);
        }
      }
      CITIES.forEach(([q, r], g) => Object.assign(byKey.get(key(q, r)), { owner: g, city: true }));
      let sector = RED_SECTOR;
      for (let g = 0; g < 3; g++) {
        for (const [q, r] of sector) byKey.get(key(q, r)).owner = g;
        sector = sector.map(rotate);
      }
      mono = [0, 0, 0];
      effects = [];
      t = 0;
      timers = { tick: 0, window: 0, war: rand(4, 6), mishap: rand(3, 5), center: rand(6, 9) };
      log = null;
      finish = null;
      say('A new season: every guild starts with five tiles', '#FFFFFF');
    }

    function developable(g) {
      return tiles.filter((tile) => tile.owner === g && !tile.city && !tile.center && tile.level < 10);
    }

    function tick() {
      const g = randInt(0, 2);
      const list = developable(g);
      if (!list.length) return;
      // Uneven growth: each tile has its own speed.
      let roll = Math.random() * list.reduce((s, tile) => s + tile.rate, 0);
      let tile = list[0];
      for (const candidate of list) {
        roll -= candidate.rate;
        if (roll <= 0) { tile = candidate; break; }
      }
      tile.points += 1;
      if (tile.points >= 1.4 * (tile.level + 1)) {
        tile.points = 0;
        tile.level += 1;
        effects.push({ kind: 'pop', tile, age: 0, life: 0.9 });
      }
    }

    function war() {
      const attacker = randInt(0, 2);
      const targets = [];
      for (const tile of tiles) {
        if (tile.owner === attacker || tile.owner < 0 || tile.city || tile.center) continue;
        const from = neighbors(tile).find((n) => n.owner === attacker);
        if (from) targets.push({ tile, from });
      }
      if (!targets.length) return;
      const { tile, from } = pick(targets);
      effects.push({ kind: 'attack', tile, from, by: attacker, defender: tile.owner, age: 0, life: 1.6 });
      say(`War! ${GUILDS[attacker].name} attacks ${GUILDS[tile.owner].name}`, GUILDS[attacker].light);
    }

    function mishap() {
      const list = tiles.filter((tile) => tile.owner >= 0 && !tile.city && !tile.center && tile.level >= 2);
      if (!list.length) return;
      const tile = pick(list);
      const kind = Math.random() < 0.5 ? 'bolt' : 'fire';
      effects.push({ kind, tile, age: 0, life: 1.4, done: false });
      say(kind === 'bolt' ? 'Lightning strikes! A tile drops a level' : 'A small fire! A tile drops a level', '#FFE27A');
    }

    function update(dt) {
      t += dt;
      if (log) log.age += dt;
      for (const e of effects) e.age += dt;
      effects = effects.filter((e) => e.age < e.life);
      if (finish) {
        finish.age += dt;
        if (finish.age > 3.2) reset();
        return;
      }
      timers.tick -= dt;
      while (timers.tick <= 0) { tick(); timers.tick += 0.07; }

      // The war's outcome.
      for (const e of effects) {
        if (e.kind === 'attack' && !e.done && e.age > 1.1) {
          e.done = true;
          if (e.tile.owner === e.defender && Math.random() < 0.55) {
            e.tile.owner = e.by;
            e.tile.level = Math.floor(e.tile.level / 2);
            e.tile.points = 0;
            effects.push({ kind: 'flash', tile: e.tile, age: 0, life: 0.6 });
            say(`${GUILDS[e.by].name} takes the tile (it keeps half its level)`, GUILDS[e.by].light);
          } else {
            effects.push({ kind: 'hold', tile: e.tile, age: 0, life: 0.8 });
            say(`${GUILDS[e.defender].name} holds the line`, GUILDS[e.defender].light);
          }
        }
        if ((e.kind === 'bolt' || e.kind === 'fire') && !e.done && e.age > 0.35) {
          e.done = true;
          e.tile.level = Math.max(0, e.tile.level - 1);
          e.tile.points = 0;
        }
      }

      timers.war -= dt;
      if (timers.war <= 0) { war(); timers.war = rand(5, 7.5); }
      timers.mishap -= dt;
      if (timers.mishap <= 0) { mishap(); timers.mishap = rand(4, 6.5); }

      // The god's center tile: won for a while, then taken back.
      const center = byKey.get('0,0');
      if (center.owner >= 0) {
        center.hold -= dt;
        if (center.hold <= 0) {
          center.owner = -1;
          effects.push({ kind: 'flash', tile: center, age: 0, life: 0.6 });
          say('The god takes the center back', GOD);
        }
      } else {
        timers.center -= dt;
        if (timers.center <= 0) {
          center.owner = randInt(0, 2);
          center.hold = 9;
          timers.center = rand(8, 12);
          effects.push({ kind: 'flash', tile: center, age: 0, life: 0.6 });
          say(`${GUILDS[center.owner].name} wins a Clash and the center tile`, GUILDS[center.owner].light);
        }
      }

      // Monuments grow every "window" by 1 plus the levels of the guild's tiles.
      timers.window -= dt;
      if (timers.window <= 0) {
        timers.window += 0.5;
        for (let g = 0; g < 3; g++) {
          let income = 1;
          for (const tile of tiles) if (tile.owner === g && !tile.city) income += tile.center ? 5 : tile.level;
          mono[g] = Math.min(GOAL, mono[g] + income * rand(0.6, 1.2));
          if (mono[g] >= GOAL && !finish) finish = { guild: g, age: 0 };
        }
      }
    }

    function hexPath(ctx, x, y, size) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + size * Math.cos(a);
        const py = y + size * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    function drawCastle(ctx, x, y, s, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x - s, y - s * 0.4, s * 2, s * 1.2);
      for (let i = 0; i < 3; i++) ctx.fillRect(x - s + i * s * 0.8, y - s * 0.85, s * 0.4, s * 0.5);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.arc(x, y + s * 0.3, s * 0.32, Math.PI, 0);
      ctx.lineTo(x + s * 0.32, y + s * 0.8);
      ctx.lineTo(x - s * 0.32, y + s * 0.8);
      ctx.closePath();
      ctx.fill();
    }

    function drawCrown(ctx, x, y, s) {
      ctx.fillStyle = GOD;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.6);
      ctx.lineTo(x - s, y - s * 0.4);
      ctx.lineTo(x - s * 0.5, y + s * 0.05);
      ctx.lineTo(x, y - s * 0.7);
      ctx.lineTo(x + s * 0.5, y + s * 0.05);
      ctx.lineTo(x + s, y - s * 0.4);
      ctx.lineTo(x + s, y + s * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    function draw(ctx) {
      ctx.clearRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(cx, cy, 20, cx, cy, W * 0.7);
      bg.addColorStop(0, '#1A2034');
      bg.addColorStop(1, '#0C0F18');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      for (const tile of tiles) {
        const { x, y } = pos(tile);
        hexPath(ctx, x, y, S - 2);
        if (tile.owner >= 0) {
          const g = GUILDS[tile.owner];
          ctx.fillStyle = g.color;
          ctx.globalAlpha = tile.city ? 0.95 : 0.28 + (tile.center ? 5 : tile.level) * 0.06;
          ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = 'rgba(70, 80, 110, 0.45)';
          ctx.fill();
        }
        ctx.lineWidth = tile.city ? 3 : 1.5;
        ctx.strokeStyle = tile.city ? '#FFFFFF' : 'rgba(255, 255, 255, 0.28)';
        ctx.stroke();

        if (tile.center) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = GOD;
          ctx.beginPath();
          ctx.arc(x, y, S * 0.62, 0, TAU);
          ctx.globalAlpha = 0.35;
          ctx.stroke();
          ctx.globalAlpha = 1;
          if (tile.owner >= 0) {
            ctx.beginPath();
            ctx.arc(x, y, S * 0.62, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(tile.hold / 9, 0, 1));
            ctx.stroke();
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `26px ${HEAD_FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${Math.ceil(tile.hold * 3)}m`, x, y + 1);
          } else {
            drawCrown(ctx, x, y, S * 0.3);
          }
        } else if (tile.city) {
          drawCastle(ctx, x, y, S * 0.3, '#FFFFFF');
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.font = `${Math.round(S * 0.62)}px ${HEAD_FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(tile.level), x, y + 1);
          // Level pips under the number.
          const pips = Math.min(10, tile.level);
          for (let i = 0; i < pips; i++) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fillRect(x - 15 + (i % 5) * 6.5, y + S * 0.42 + Math.floor(i / 5) * 5, 4, 3);
          }
        }
      }

      for (const e of effects) {
        const p = pos(e.tile);
        const k = e.age / e.life;
        if (e.kind === 'pop') {
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2;
          hexPath(ctx, p.x, p.y, S * (0.75 + k * 0.35));
          ctx.stroke();
          ctx.fillStyle = '#FFE27A';
          ctx.font = `22px ${HEAD_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText('+1', p.x + S * 0.42, p.y - S * 0.3 - k * 18);
          ctx.globalAlpha = 1;
        } else if (e.kind === 'attack') {
          const from = pos(e.from);
          const color = GUILDS[e.by].color;
          const grow = clamp(e.age / 0.6, 0, 1);
          const tx = from.x + (p.x - from.x) * grow;
          const ty = from.y + (p.y - from.y) * grow;
          ctx.strokeStyle = color;
          ctx.lineWidth = 6;
          ctx.lineCap = 'round';
          ctx.setLineDash([10, 8]);
          ctx.lineDashOffset = -e.age * 40;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
          const a = Math.atan2(p.y - from.y, p.x - from.x);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(tx + Math.cos(a) * 12, ty + Math.sin(a) * 12);
          ctx.lineTo(tx + Math.cos(a + 2.4) * 12, ty + Math.sin(a + 2.4) * 12);
          ctx.lineTo(tx + Math.cos(a - 2.4) * 12, ty + Math.sin(a - 2.4) * 12);
          ctx.fill();
          if (e.age > 0.6) {
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(e.age * 18);
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#FFFFFF';
            hexPath(ctx, p.x, p.y, S - 4);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        } else if (e.kind === 'flash') {
          ctx.globalAlpha = 0.8 * (1 - k);
          ctx.fillStyle = '#FFFFFF';
          hexPath(ctx, p.x, p.y, S - 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else if (e.kind === 'hold') {
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = '#DDE6FF';
          ctx.lineWidth = 4;
          hexPath(ctx, p.x, p.y, S * 0.7);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else if (e.kind === 'bolt') {
          ctx.globalAlpha = (1 - k) * (0.6 + 0.4 * Math.sin(e.age * 50));
          ctx.strokeStyle = '#FFF6C2';
          ctx.lineWidth = 4;
          ctx.lineJoin = 'miter';
          ctx.beginPath();
          let bx = p.x + 30;
          let by = 0;
          ctx.moveTo(bx, by);
          const segs = 7;
          for (let i = 1; i <= segs; i++) {
            by = (p.y * i) / segs;
            bx = p.x + (i === segs ? 0 : (i % 2 ? -1 : 1) * (14 - i));
            ctx.lineTo(bx, by);
          }
          ctx.stroke();
          ctx.fillStyle = '#FFF6C2';
          ctx.globalAlpha *= 0.5;
          hexPath(ctx, p.x, p.y, S - 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else if (e.kind === 'fire') {
          ctx.globalAlpha = Math.min(1, (1 - k) * 2);
          for (let i = 0; i < 5; i++) {
            const fx = p.x - 18 + i * 9;
            const fh = 14 + 9 * Math.sin(e.age * 14 + i * 1.7);
            ctx.fillStyle = i % 2 ? '#FF8A3D' : '#FFD54A';
            ctx.beginPath();
            ctx.moveTo(fx - 6, p.y + 12);
            ctx.quadraticCurveTo(fx - 4, p.y + 12 - fh * 0.6, fx, p.y + 12 - fh);
            ctx.quadraticCurveTo(fx + 4, p.y + 12 - fh * 0.6, fx + 6, p.y + 12);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }

      // Monument bars.
      const top = cy + S * 4.4;
      const rowH = (H - top - 8) / 3;
      for (let g = 0; g < 3; g++) {
        const y = top + g * rowH;
        const share = mono[g] / GOAL;
        ctx.fillStyle = GUILDS[g].light;
        ctx.font = `24px ${HEAD_FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(GUILDS[g].name, 18, y + rowH / 2);
        const bx = 84;
        const bw = W - bx - 70;
        roundRect(ctx, bx, y + rowH / 2 - 7, bw, 14, 7);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fill();
        if (share > 0.01) {
          roundRect(ctx, bx, y + rowH / 2 - 7, Math.max(14, bw * share), 14, 7);
          ctx.fillStyle = GUILDS[g].color;
          ctx.fill();
        }
        for (let s = 1; s < 5; s++) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
          ctx.fillRect(bx + (bw * s) / 5 - 1, y + rowH / 2 - 7, 2, 14);
        }
        ctx.fillStyle = '#C9CEDD';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.floor(share * 100)}%`, W - 18, y + rowH / 2);
      }

      // The latest event.
      if (log && log.age < 3.2) {
        ctx.globalAlpha = clamp(Math.min(log.age * 5, (3.2 - log.age) * 2), 0, 1);
        ctx.font = `22px ${HEAD_FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = log.color;
        ctx.fillText(log.text, 14, 10, W - 28);
        ctx.globalAlpha = 1;
      }

      if (finish) {
        banner(ctx, W, cy, `${GUILDS[finish.guild].name} finishes its Monument!`, GUILDS[finish.guild].color, clamp(finish.age * 4, 0, 1));
      }
    }

    return {
      warmup: 14,
      init(w, h) {
        W = w;
        H = h;
        S = Math.min(W / (SQ3 * 5 + 0.6), (H - 150) / 8.2);
        cx = W / 2;
        cy = 44 + S * 4;
        reset();
      },
      update,
      draw,
    };
  }

  // ================================================================ 3. monuments
  function monumentScene() {
    // Parts of each design in units of its height: [stage, polygon of [u, v]], v going up.
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const DESIGNS = [
      {
        name: 'Obelisk',
        parts: [
          [1, rect(-0.26, 0, 0.26, 0.06)], [1, rect(-0.2, 0.06, 0.2, 0.12)],
          [2, [[-0.13, 0.12], [0.13, 0.12], [0.12, 0.38], [-0.12, 0.38]]],
          [3, [[-0.12, 0.38], [0.12, 0.38], [0.105, 0.64], [-0.105, 0.64]]],
          [4, [[-0.105, 0.64], [0.105, 0.64], [0.09, 0.86], [-0.09, 0.86]]],
          [5, [[-0.09, 0.86], [0.09, 0.86], [0, 1]]],
        ],
      },
      {
        name: 'Ziggurat',
        parts: [
          [1, rect(-0.46, 0, 0.46, 0.17)],
          [2, rect(-0.36, 0.17, 0.36, 0.34)],
          [3, rect(-0.26, 0.34, 0.26, 0.51)],
          [4, rect(-0.17, 0.51, 0.17, 0.66)],
          [5, rect(-0.09, 0.66, 0.09, 0.8)], [5, [[-0.12, 0.8], [0.12, 0.8], [0, 0.9]]],
        ],
      },
      {
        name: 'Temple',
        parts: [
          [1, rect(-0.46, 0, 0.46, 0.05)], [1, rect(-0.42, 0.05, 0.42, 0.1)],
          [2, rect(-0.37, 0.1, -0.29, 0.34)], [2, rect(-0.19, 0.1, -0.11, 0.34)], [2, rect(0.11, 0.1, 0.19, 0.34)], [2, rect(0.29, 0.1, 0.37, 0.34)],
          [3, rect(-0.37, 0.34, -0.29, 0.58)], [3, rect(-0.19, 0.34, -0.11, 0.58)], [3, rect(0.11, 0.34, 0.19, 0.58)], [3, rect(0.29, 0.34, 0.37, 0.58)],
          [4, rect(-0.42, 0.58, 0.42, 0.68)],
          [5, [[-0.44, 0.68], [0.44, 0.68], [0, 0.88]]],
        ],
      },
    ];
    let W, H, progress, speeds, order, celebrate, sparkles;

    function reset() {
      order = shuffle([0, 1, 2]); // designs dealt at random each season
      progress = [0, 0, 0];
      speeds = [rand(0.07, 0.11), rand(0.07, 0.11), rand(0.07, 0.11)];
      celebrate = null;
      sparkles = [];
    }

    const mix = (hexA, hexB, k) => {
      const a = parseInt(hexA.slice(1), 16);
      const b = parseInt(hexB.slice(1), 16);
      const ch = (s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
      return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
    };

    function update(dt) {
      for (const s of sparkles) { s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 120 * dt; }
      sparkles = sparkles.filter((s) => s.age < s.life);
      if (celebrate) {
        celebrate.age += dt;
        if (Math.random() < dt * 30) {
          const x = celebrate.x + rand(-60, 60);
          sparkles.push({ x, y: celebrate.y - rand(40, 200), vx: rand(-60, 60), vy: rand(-120, -20), age: 0, life: rand(0.7, 1.3), color: pick([GOD, '#FFFFFF', GUILDS[celebrate.guild].light]) });
        }
        if (celebrate.age > 3.2) reset();
        return;
      }
      for (let g = 0; g < 3; g++) {
        // Uneven speed: some windows are busier than others.
        speeds[g] = clamp(speeds[g] + rand(-0.02, 0.02) * dt * 10, 0.04, 0.14);
        progress[g] = Math.min(1, progress[g] + speeds[g] * dt);
        if (progress[g] >= 1) {
          celebrate = { guild: g, age: 0, x: ((g + 0.5) * W) / 3, y: H - 70 };
          break;
        }
      }
    }

    function drawMonument(ctx, design, share, x, y, height, color) {
      const stage = Math.min(5, Math.floor(share * 5 + 1e-9));
      const within = share * 5 - stage;
      const plan = mix('#2E3446', color, 0.18);
      const stone = mix('#D9D2BE', color, 0.35);
      const path = (poly) => {
        ctx.beginPath();
        poly.forEach(([u, v], i) => {
          const px = x + u * height;
          const py = y - v * height;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      };
      for (const [partStage, poly] of DESIGNS[design].parts) {
        path(poly);
        ctx.fillStyle = plan;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        let fill = 0;
        if (partStage <= stage) fill = 1;
        else if (partStage === stage + 1) fill = within;
        if (fill <= 0) continue;
        const vs = poly.map(([, v]) => v);
        const bottom = Math.min(...vs);
        const top = Math.max(...vs);
        ctx.save();
        path(poly);
        ctx.clip();
        const cut = y - (bottom + (top - bottom) * fill) * height;
        ctx.fillStyle = stone;
        ctx.fillRect(x - height, cut, height * 2, y - cut + 1);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.fillRect(x, cut, height, y - cut + 1);
        if (fill < 1) {
          ctx.fillStyle = color;
          ctx.fillRect(x - height, cut - 1, height * 2, 3);
        }
        ctx.restore();
        if (fill >= 1) {
          path(poly);
          ctx.strokeStyle = 'rgba(20, 16, 12, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    function draw(ctx) {
      ctx.clearRect(0, 0, W, H);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#141A2C');
      sky.addColorStop(1, '#0C0F18');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      const ground = H - 74;
      ctx.fillStyle = '#1B2133';
      ctx.fillRect(0, ground, W, H - ground);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(0, ground, W, 2);

      const colW = W / 3;
      const height = Math.min(colW * 0.95, ground - 40);
      for (let g = 0; g < 3; g++) {
        const x = colW * (g + 0.5);
        const color = GUILDS[g].color;
        if (celebrate && celebrate.guild === g) {
          const glow = ctx.createRadialGradient(x, ground - height * 0.5, 10, x, ground - height * 0.5, height * 0.8);
          glow.addColorStop(0, 'rgba(255, 213, 74, 0.35)');
          glow.addColorStop(1, 'rgba(255, 213, 74, 0)');
          ctx.fillStyle = glow;
          ctx.fillRect(x - colW / 2, 0, colW, ground);
        }
        drawMonument(ctx, order[g], progress[g], x, ground, height, color);

        const stage = Math.min(5, Math.floor(progress[g] * 5 + 1e-9));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = GUILDS[g].light;
        ctx.font = `24px ${HEAD_FONT}`;
        ctx.fillText(`${GUILDS[g].name}: ${DESIGNS[order[g]].name}`, x, ground + 20, colW - 10);
        const bw = colW - 40;
        roundRect(ctx, x - bw / 2, ground + 38, bw, 10, 5);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fill();
        if (progress[g] > 0.02) {
          roundRect(ctx, x - bw / 2, ground + 38, Math.max(10, bw * progress[g]), 10, 5);
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.fillStyle = '#C9CEDD';
        ctx.font = `20px ${HEAD_FONT}`;
        ctx.fillText(stage >= 5 ? 'Finished!' : `Stage ${stage + 1} of 5`, x, ground + 61);
      }
      for (const s of sparkles) {
        ctx.globalAlpha = 1 - s.age / s.life;
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
      if (celebrate) {
        banner(ctx, W, 40, `${GUILDS[celebrate.guild].name} wins the season!`, GUILDS[celebrate.guild].color, clamp(celebrate.age * 4, 0, 1));
      }
    }

    return {
      warmup: 5,
      init(w, h) { W = w; H = h; reset(); },
      update,
      draw,
    };
  }

  // ================================================================ 4. pachinko
  function pachinkoScene() {
    const VALUES = [100, 40, 10, 40, 100];
    const PER_BOARD = 6;
    const BALL = 6;
    const PEG = 3.5;
    let W, H, boards, end;

    function layout() {
      const pad = 10;
      const gap = 12;
      const bw = (W - pad * 2 - gap * 2) / 3;
      boards = [];
      for (let g = 0; g < 3; g++) {
        const x0 = pad + g * (bw + gap);
        const board = { guild: g, x0, x1: x0 + bw, y0: 48, y1: H - 10, pegs: [], balls: [], queue: PER_BOARD, spawn: 0.4 + g * 0.25, total: 0, slotFlash: VALUES.map(() => 0), stacks: VALUES.map(() => 0), pops: [] };
        board.slotTop = board.y1 - 46;
        const rows = 8;
        const spacing = 22;
        const top = board.y0 + 40;
        const rowGap = (board.slotTop - 22 - top) / (rows - 1);
        for (let row = 0; row < rows; row++) {
          const offset = row % 2 ? spacing / 2 : 0;
          for (let px = x0 + 12 + offset; px <= board.x1 - 10; px += spacing) {
            board.pegs.push({ x: px, y: top + row * rowGap, flash: 0 });
          }
        }
        boards.push(board);
      }
      end = null;
    }

    function update(dt) {
      if (end) {
        end.age += dt;
        if (end.age > 3) layout();
        return;
      }
      let finished = 0;
      for (const b of boards) {
        b.spawn -= dt;
        if (b.queue > 0 && b.spawn <= 0) {
          b.queue -= 1;
          b.spawn = rand(0.9, 1.4);
          b.balls.push({ x: (b.x0 + b.x1) / 2 + rand(-14, 14), y: b.y0 + 12, vx: rand(-25, 25), vy: 0, color: nameColor(b.guild), done: false });
        }
        for (const p of b.pegs) p.flash = Math.max(0, p.flash - dt);
        for (let i = 0; i < b.slotFlash.length; i++) b.slotFlash[i] = Math.max(0, b.slotFlash[i] - dt);
        for (const pop of b.pops) pop.age += dt;
        b.pops = b.pops.filter((pop) => pop.age < 1.1);
        const sw = (b.x1 - b.x0) / VALUES.length;
        for (const ball of b.balls) {
          if (ball.done) continue;
          ball.age = (ball.age || 0) + dt;
          const sub = 3;
          const h = dt / sub;
          for (let s = 0; s < sub; s++) {
            ball.vy += 900 * h;
            ball.x += ball.vx * h;
            ball.y += ball.vy * h;
            if (ball.y < b.slotTop) {
              // A ball that takes far too long falls straight through.
              if (ball.age < 5) for (const p of b.pegs) {
                const dx = ball.x - p.x;
                const dy = ball.y - p.y;
                const d = Math.hypot(dx, dy);
                if (d < BALL + PEG && d > 0.001) {
                  const nx = dx / d;
                  const ny = dy / d;
                  ball.x = p.x + nx * (BALL + PEG);
                  ball.y = p.y + ny * (BALL + PEG);
                  const vn = ball.vx * nx + ball.vy * ny;
                  if (vn < 0) {
                    ball.vx -= 1.35 * vn * nx;
                    ball.vy -= 1.35 * vn * ny;
                    ball.vx += rand(-15, 15);
                    ball.vy = Math.max(ball.vy, -60);
                  }
                  p.flash = 0.2;
                }
              }
            } else {
              // Inside a slot: fall straight down between its walls.
              const slot = clamp(Math.floor((ball.x - b.x0) / sw), 0, VALUES.length - 1);
              ball.slot = ball.slot ?? slot;
              const cxs = b.x0 + sw * (ball.slot + 0.5);
              ball.x += (cxs - ball.x) * Math.min(1, h * 12);
              ball.vx = 0;
              const rest = b.y1 - 4 - BALL - b.stacks[ball.slot] * (BALL * 2 - 2);
              if (ball.y >= rest) {
                ball.y = rest;
                ball.done = true;
                b.stacks[ball.slot] += 1;
                b.total += VALUES[ball.slot];
                b.slotFlash[ball.slot] = 0.6;
                b.pops.push({ x: cxs, y: b.slotTop - 6, text: `+${VALUES[ball.slot]}`, age: 0 });
                break;
              }
            }
            if (ball.x < b.x0 + BALL) { ball.x = b.x0 + BALL; ball.vx = Math.abs(ball.vx) * 0.5; }
            if (ball.x > b.x1 - BALL) { ball.x = b.x1 - BALL; ball.vx = -Math.abs(ball.vx) * 0.5; }
          }
          // A ball balanced on a pin or wedged at a wall gets a nudge.
          ball.still = Math.hypot(ball.vx, ball.vy) < 40 ? (ball.still || 0) + dt : 0;
          if (ball.still > 0.25 && !ball.done) {
            ball.still = 0;
            ball.vx = (ball.x < (b.x0 + b.x1) / 2 ? 1 : -1) * rand(60, 110);
            ball.y += 2;
          }
        }
        if (b.queue === 0 && b.balls.every((ball) => ball.done)) finished += 1;
      }
      if (finished === 3) {
        const best = Math.max(...boards.map((b) => b.total));
        const winners = boards.filter((b) => b.total === best);
        end = { winner: winners.length === 1 ? winners[0].guild : -1, age: 0 };
      }
    }

    function draw(ctx) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0C0F18';
      ctx.fillRect(0, 0, W, H);
      for (const b of boards) {
        const g = GUILDS[b.guild];
        const win = end && end.winner === b.guild;
        roundRect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 10);
        const bg = ctx.createLinearGradient(0, b.y0, 0, b.y1);
        bg.addColorStop(0, '#1B2134');
        bg.addColorStop(1, '#131726');
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.lineWidth = win ? 4 : 2;
        ctx.strokeStyle = win ? GOD : g.color;
        ctx.stroke();

        ctx.textBaseline = 'middle';
        ctx.font = `24px ${HEAD_FONT}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = g.light;
        ctx.fillText(g.name, b.x0 + 4, 22);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(String(b.total), b.x1 - 4, 22);

        for (const p of b.pegs) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, PEG + (p.flash > 0 ? 1 : 0), 0, TAU);
          ctx.fillStyle = p.flash > 0 ? '#FFFFFF' : '#8E97B3';
          ctx.fill();
        }

        const sw = (b.x1 - b.x0) / VALUES.length;
        for (let i = 0; i < VALUES.length; i++) {
          const sx = b.x0 + i * sw;
          if (b.slotFlash[i] > 0) {
            ctx.fillStyle = `rgba(255, 213, 74, ${b.slotFlash[i] * 0.5})`;
            ctx.fillRect(sx + 1, b.slotTop, sw - 2, b.y1 - b.slotTop - 2);
          }
          if (i > 0) {
            ctx.fillStyle = '#5A6380';
            ctx.fillRect(sx - 1, b.slotTop, 2, b.y1 - b.slotTop);
          }
          ctx.fillStyle = VALUES[i] >= 100 ? GOD : '#C9CEDD';
          ctx.font = `18px ${HEAD_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(String(VALUES[i]), sx + sw / 2, b.slotTop + 10);
        }

        for (const ball of b.balls) {
          ctx.beginPath();
          ctx.arc(ball.x, ball.y, BALL, 0, TAU);
          ctx.fillStyle = ball.color;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = g.color;
          ctx.stroke();
        }
        for (const pop of b.pops) {
          ctx.globalAlpha = 1 - pop.age / 1.1;
          ctx.fillStyle = GOD;
          ctx.font = `22px ${HEAD_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(pop.text, pop.x, pop.y - pop.age * 26);
          ctx.globalAlpha = 1;
        }
      }
      if (end) {
        const text = end.winner >= 0 ? `${GUILDS[end.winner].name} wins with ${boards[end.winner].total}!` : 'A tie!';
        banner(ctx, W, H / 2, text, end.winner >= 0 ? GUILDS[end.winner].color : '#FFFFFF', clamp(end.age * 4, 0, 1));
      }
    }

    return {
      warmup: 4,
      init(w, h) { W = w; H = h; layout(); },
      update,
      draw,
    };
  }

  // ---------------------------------------------------------------- start
  const SCENES = { map: mapScene, monument: monumentScene, pachinko: pachinkoScene };
  for (const canvas of document.querySelectorAll('canvas[data-anim]')) {
    const make = SCENES[canvas.dataset.anim];
    if (!make || !canvas.getContext) continue;
    try {
      mountAnimation(canvas, make());
    } catch (err) {
      // An animation is decoration; the page must work without it.
      console.error(err);
    }
  }
  for (const video of document.querySelectorAll('video.clip')) mountClip(video);
})();
