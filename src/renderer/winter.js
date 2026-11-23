// Winter style ("Style spécial hiver" in Paramètres): night sky with an aurora, snow with real physics, frost,
// an ice JOUER button and gold flakes. Everything is drawn on one canvas over the window (it never takes clicks).
//
// Physics, in window pixels per frame (60 fps):
//  - the cursor is a solid disc: flakes bounce off it, and it digs and pushes settled snow aside in any direction;
//  - settled snow is granular: a slope steeper than the angle of repose slides, edges hold a little then spill;
//  - snow that falls off something lands on what is below it, or on the ground at the bottom of the window;
//  - on the title, snow rests on the real shape of the letters (read from the rendered text).
// app.js controls it with window.winter.configure({ style, effects, amount }) and pause(true/false).
(() => {
  const canvas = document.getElementById('winter-snow');
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CELL = 4; // width of one snow column
  const REPOSE = 1.8; // steepest difference between two columns before snow slides
  const SLIDE = 0.3;
  const STICK = 3.5; // an edge holds this much before it spills over
  const MAX_PILE = 12; // tallest pile on a card or a button
  const MAX_TEXT = 7; // on the letters of the title
  const MAX_GROUND = 18;
  const GRAIN = 1.4; // snow carried by one falling clump
  const R = 26; // the cursor
  const GRAVITY = 0.16;
  const AMOUNTS = [70, 200, 380];
  // Where snow settles. A "text" surface follows the shape of its letters.
  const SURFACES = [
    { selector: '#pack-name', text: true },
    { selector: '.news-card' },
    { selector: '#btn-play' },
    { selector: '#btn-settings' },
  ];

  const config = {
    style: 'base',
    effects: { snow: true, physics: true, pile: true, wind: true, aurora: true, frost: true, gold: true },
    amount: 1,
  };
  let W = innerWidth, H = innerHeight, dpr = 1;
  let paused = false;
  let running = false;
  let surfaces = [];
  const flakes = [];
  const grains = [];
  const shards = [];
  const mouse = { x: -999, y: -999, vx: 0, vy: 0, inside: false };
  const on = (key) => config.style === 'winter' && config.effects[key];

  // ---------- Sizes and surfaces ----------

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = innerWidth;
    H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    measure();
  }

  // Each surface gets its own uneven top, so the snow never looks cut straight.
  function texture(n) {
    const tex = new Float32Array(n);
    const waves = [0, 1, 2].map(() => ({ f: 0.08 + Math.random() * 0.35, p: Math.random() * 6.28, a: 0.5 + Math.random() }));
    for (let i = 0; i < n; i++) tex[i] = waves.reduce((sum, w) => sum + Math.sin(i * w.f + w.p) * w.a, 0) * 0.7 + (Math.random() - 0.5) * 0.8;
    return tex;
  }

  // Text surfaces: draw the letters as the window laid them out, then find the top of the ink in each column.
  const letterCache = new Map(); // element -> { key, top (relative), solid }
  function letterTops(s, top, solid) {
    const el = s.el;
    const cs = getComputedStyle(el);
    const key = `${el.textContent}|${Math.round(s.w)}|${Math.round(s.h)}|${cs.font}`;
    const cached = letterCache.get(el);
    if (cached && cached.key === key && cached.top.length === top.length) {
      for (let i = 0; i < top.length; i++) { top[i] = s.y + cached.top[i]; solid[i] = cached.solid[i]; }
      return;
    }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(s.w));
    c.height = Math.max(1, Math.ceil(s.h));
    const g = c.getContext('2d');
    g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = g.measureText('M');
    const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let k = 0; k < node.length; k++) {
        const ch = node.data[k];
        if (!ch.trim()) continue;
        range.setStart(node, k);
        range.setEnd(node, k + 1);
        const r = range.getBoundingClientRect();
        g.fillText(ch, r.left - s.x, r.top - s.y + (r.height - (asc + desc)) / 2 + asc);
      }
    }
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const rel = new Float32Array(top.length);
    for (let i = 0; i < top.length; i++) {
      let best = Infinity;
      for (let x = i * CELL; x < Math.min(c.width, i * CELL + CELL); x++) {
        for (let y = 0; y < Math.min(best, c.height); y++) {
          if (data[(y * c.width + x) * 4 + 3] > 120) { best = y; break; }
        }
      }
      solid[i] = best === Infinity ? 0 : 1;
      rel[i] = best === Infinity ? 0 : best;
      top[i] = s.y + rel[i];
    }
    letterCache.set(el, { key, top: rel, solid: Uint8Array.from(solid) });
  }

  function visible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getClientRects().length > 0 && !el.closest('[hidden]');
  }

  function measure() {
    const found = [];
    for (const def of SURFACES) {
      for (const el of document.querySelectorAll(def.selector)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        // only the part on screen (news cards scroll inside their list)
        const clip = el.closest('.news-list')?.getBoundingClientRect();
        if (clip && (r.top < clip.top - 1 || r.top > clip.bottom)) continue;
        found.push({ el, x: r.left, y: r.top, w: r.width, h: r.height, max: def.text ? MAX_TEXT : MAX_PILE, text: Boolean(def.text) });
      }
    }
    found.push({ el: 'ground', x: 0, y: H - 4, w: W, h: 4, max: MAX_GROUND, text: false });
    surfaces = found.map((s) => {
      const old = surfaces.find((o) => o.el === s.el);
      const n = Math.max(1, Math.ceil(s.w / CELL));
      const top = new Float32Array(n).fill(s.y);
      const solid = new Uint8Array(n).fill(1);
      if (s.text) letterTops(s, top, solid);
      // moved or resized: keep the snow it held, stretched to the new width
      const pile = new Float32Array(n);
      if (old) for (let i = 0; i < n; i++) pile[i] = solid[i] ? old.pile[Math.min(old.n - 1, Math.floor((i / n) * old.n))] : 0;
      else for (let i = 0; i < n; i++) pile[i] = 0;
      return { ...s, n, top, solid, pile, tex: old && old.n === n ? old.tex : texture(n), spill: new Float32Array(n), fresh: !old };
    });
  }

  // A first thin layer, so the snow is there as soon as the style is turned on.
  function seed() {
    for (const s of surfaces) for (let i = 0; i < s.n; i++) {
      if (s.solid[i]) s.pile[i] = Math.max(s.pile[i], s.el === 'ground' ? 7 + Math.sin(i * 0.05) * 3 + s.tex[i] : s.text ? 2 + s.tex[i] * 0.6 : 3 + s.tex[i]);
    }
  }

  // ---------- Particles ----------

  function newFlake(y) {
    const gold = on('gold') && Math.random() < 0.012;
    return { x: Math.random() * W, y: y ?? -10 - Math.random() * 40, r: gold ? 4 : 1 + Math.random() * 2.2, vx: 0, vy: 0.5 + Math.random() * 0.6, sway: Math.random() * 6.28, gold };
  }
  function setAmount() {
    const want = on('snow') && !reduce ? AMOUNTS[config.amount] ?? AMOUNTS[1] : on('snow') ? 40 : 0;
    while (flakes.length > want) flakes.pop();
    while (flakes.length < want) flakes.push(newFlake(Math.random() * H));
  }
  function grain(x, y, vx, vy, mass = GRAIN) {
    if (grains.length < 900) grains.push({ x, y, vx, vy, mass, size: 1.6 + mass });
  }
  function sparkle(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = 1 + Math.random() * 4;
      shards.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, life: 45 + Math.random() * 30, color, size: 1.5 + Math.random() * 2.5 });
    }
  }
  function catchGold(f) {
    sparkle(f.x, f.y, 22, '#ffb35c');
    Object.assign(f, newFlake());
    f.gold = false;
    window.winter.onGold?.();
  }

  // ---------- Physics ----------

  // Snow can't be inside the cursor: what's in its way is pushed aside, away from the cursor's centre.
  function plow(s) {
    if (!on('physics') || !mouse.inside) return;
    if (mouse.x < s.x - R || mouse.x > s.x + s.w + R || mouse.y < s.y - s.max - R || mouse.y > s.y + s.h + R) return;
    for (let i = 0; i < s.n; i++) {
      if (!s.solid[i]) continue;
      const cx = s.x + i * CELL + 2, dx = cx - mouse.x;
      if (Math.abs(dx) >= R) continue;
      const half = Math.sqrt(R * R - dx * dx);
      const floor = s.top[i];
      if (mouse.y + half <= floor - s.pile[i] || mouse.y - half >= floor) continue;
      const allowed = Math.max(0, floor - (mouse.y + half)); // packed under the cursor, never inside or above it
      const excess = s.pile[i] - allowed;
      if (excess <= 0.01) continue;
      s.pile[i] = allowed;
      const side = dx === 0 ? (mouse.vx >= 0 ? 1 : -1) : Math.sign(dx);
      const j = i + side * (Math.ceil((R - Math.abs(dx)) / CELL) + 1);
      if (j >= 0 && j < s.n && s.solid[j] && Math.hypot(mouse.vx, mouse.vy) < 9) {
        let left = excess;
        [0.4, 0.3, 0.2, 0.1].forEach((w, k) => {
          const c = j + side * k;
          if (c >= 0 && c < s.n && s.solid[c]) { s.pile[c] += excess * w; left -= excess * w; }
        });
        if (left > 0.05) grain(cx + side * (R + 2), floor - allowed - 3, side * 1.2, -1, left);
      } else {
        for (let m = excess; m > 0.05; m -= GRAIN) {
          grain(cx + side * 2, floor - allowed - 2, side * (1 + Math.random()) + mouse.vx * 0.5, -0.5 - Math.random() * 1.5 + Math.min(0, mouse.vy) * 0.4, Math.min(GRAIN, m));
        }
      }
    }
  }

  function relax(s) {
    const p = s.pile, floor = s.top, ok = s.solid;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < s.n - 1; i++) {
        if (!ok[i] || !ok[i + 1]) continue;
        const d = floor[i + 1] - p[i + 1] - (floor[i] - p[i]); // > 0: column i's snow is higher
        if (Math.abs(d) <= REPOSE) continue;
        const want = (Math.abs(d) - REPOSE) * SLIDE * 0.5;
        if (d > 0) { const m = Math.min(want, p[i]); p[i] -= m; p[i + 1] += m; }
        else { const m = Math.min(want, p[i + 1]); p[i + 1] -= m; p[i] += m; }
      }
    }
    for (let i = 0; i < s.n; i++) {
      if (p[i] > s.max) { const next = i + 1 < s.n && ok[i + 1] ? i + 1 : i; p[next] += (p[i] - s.max) * 0.5; p[i] = Math.min(p[i], s.max); }
    }
    if (s.el === 'ground') return;
    const stick = s.text ? 2.5 : STICK;
    for (let i = 0; i < s.n; i++) {
      if (!ok[i] || p[i] <= stick) continue;
      const leftEnd = i === 0 || !ok[i - 1], rightEnd = i === s.n - 1 || !ok[i + 1];
      if (!leftEnd && !rightEnd) continue;
      const m = (p[i] - stick) * SLIDE;
      p[i] -= m;
      s.spill[i] += m;
      if (s.spill[i] >= GRAIN * 0.7) {
        const side = leftEnd && !rightEnd ? -1 : rightEnd && !leftEnd ? 1 : Math.random() < 0.5 ? -1 : 1;
        grain(s.x + i * CELL + 2 + side * 3, floor[i] - p[i] - 1, side * (0.3 + Math.random() * 0.6), 0, s.spill[i]);
        s.spill[i] = 0;
      }
    }
  }

  function land(f, prevY, mass) {
    if (!on('pile')) return false;
    for (const s of surfaces) {
      if (f.x < s.x || f.x >= s.x + s.w) continue;
      const i = Math.min(s.n - 1, Math.floor((f.x - s.x) / CELL));
      if (!s.solid[i]) continue;
      const top = s.top[i] - s.pile[i];
      if (f.vy >= 0 && prevY <= top + 1 && f.y >= top - 0.5) {
        s.pile[i] += mass * 0.7;
        if (i > 0 && s.solid[i - 1]) s.pile[i - 1] += mass * 0.15; else s.pile[i] += mass * 0.15;
        if (i < s.n - 1 && s.solid[i + 1]) s.pile[i + 1] += mass * 0.15; else s.pile[i] += mass * 0.15;
        return true;
      }
    }
    return false;
  }

  function collideCursor(f, radius = R) {
    if (!on('physics') || !mouse.inside) return;
    const dx = f.x - mouse.x, dy = f.y - mouse.y, d = Math.hypot(dx, dy);
    if (d >= radius || d === 0) return;
    const nx = dx / d, ny = dy / d;
    f.x = mouse.x + nx * radius;
    f.y = mouse.y + ny * radius;
    const vn = (f.vx - mouse.vx) * nx + (f.vy - mouse.vy) * ny;
    if (vn < 0) { f.vx -= 1.35 * vn * nx; f.vy -= 1.35 * vn * ny; }
    f.vx += mouse.vx * 0.15;
    f.vy += mouse.vy * 0.15;
    f.vx *= 0.96;
  }

  function step() {
    if (on('pile')) for (const s of surfaces) { plow(s); relax(s); }
    for (const f of flakes) {
      f.sway += 0.02;
      if (f.gold && mouse.inside && Math.hypot(f.x - mouse.x, f.y - mouse.y) < 24) { catchGold(f); continue; }
      if (on('wind') && mouse.inside && !f.gold) {
        const dx = f.x - mouse.x, dy = f.y - mouse.y, d = Math.hypot(dx, dy);
        if (d < 85) { const k = (85 - d) / 85; f.vx += (dx / (d || 1)) * k * 0.5 + mouse.vx * 0.02 * k; f.vy += (dy / (d || 1)) * k * 0.3; }
      }
      const prevY = f.y;
      f.vx *= 0.96;
      f.vy += (0.45 + f.r * 0.12 - f.vy) * 0.04;
      f.x += f.vx + Math.sin(f.sway) * 0.35;
      f.y += f.vy;
      if (!f.gold) collideCursor(f);
      if (f.x < -10) f.x = W + 10;
      if (f.x > W + 10) f.x = -10;
      if (f.y > H + 10 || (!f.gold && land(f, prevY, f.r * 0.5))) Object.assign(f, newFlake());
    }
    for (let i = grains.length - 1; i >= 0; i--) {
      const g = grains[i];
      const prevY = g.y;
      g.vy += GRAVITY;
      g.vx *= 0.985;
      g.vy *= 0.995;
      g.x += g.vx;
      g.y += g.vy;
      collideCursor(g, R + 1);
      if (land(g, prevY, g.mass) || g.y > H + 20 || g.x < -30 || g.x > W + 30) grains.splice(i, 1);
    }
    for (let i = shards.length - 1; i >= 0; i--) {
      const b = shards[i];
      b.vy += 0.15; b.x += b.vx; b.y += b.vy; b.life -= 1;
      if (b.life <= 0 || b.y > H) shards.splice(i, 1);
    }
    mouse.vx *= 0.7;
    mouse.vy *= 0.7;
  }

  // ---------- Drawing ----------

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    if (on('pile')) {
      for (const s of surfaces) {
        const grad = ctx.createLinearGradient(0, s.y - 20, 0, s.y + (s.text ? s.h * 0.4 : 0));
        grad.addColorStop(0, '#f4faff');
        grad.addColorStop(1, '#cfe3f7');
        const lip = s.el === 'ground' ? 0 : s.text ? 1 : 2;
        for (let a = 0; a < s.n; a++) {
          if (!s.solid[a]) continue;
          let b = a;
          while (b + 1 < s.n && s.solid[b + 1]) b++;
          const shown = (i) => {
            const h = s.pile[i];
            if (h < 0.2) return 0;
            const end = Math.min(i - a, b - i);
            const taper = s.el === 'ground' ? 1 : Math.min(1, 0.35 + end * 0.22);
            return Math.max(0, (h + s.tex[i] * Math.min(1, h / 3)) * taper);
          };
          const X = (i) => s.x + i * CELL + 2;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(X(a) - 2 - lip, s.top[a] + 1);
          let px = X(a) - 2 - lip, py = s.top[a] + 1 - shown(a) * 0.5;
          ctx.lineTo(px, py);
          for (let i = a; i <= b; i++) {
            const x = X(i), y = s.top[i] + 1 - shown(i);
            ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
            px = x; py = y;
          }
          ctx.quadraticCurveTo(px, py, X(b) + 2 + lip, s.top[b] + 1 - shown(b) * 0.5);
          ctx.lineTo(X(b) + 2 + lip, s.top[b] + 1);
          for (let i = b; i >= a; i--) ctx.lineTo(X(i), s.top[i] + 1.5);
          ctx.closePath();
          ctx.fill();
          for (let i = a + 2; i <= b - 2; i += 3) {
            const h = shown(i);
            if (h > 2.5 && s.tex[i] > 0.2) {
              ctx.beginPath();
              ctx.arc(X(i), s.top[i] + 1 - h + 0.8, 1.2 + s.tex[i] * 0.9, 0, 6.29);
              ctx.fill();
            }
          }
          a = b;
        }
      }
    }
    ctx.fillStyle = '#eef7ff';
    for (const g of grains) ctx.fillRect(g.x - g.size / 2, g.y - g.size / 2, g.size, g.size);
    for (const f of flakes) {
      if (f.gold) {
        ctx.fillStyle = '#ffb35c';
        ctx.shadowColor = '#ffb35c';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        for (let k = 0; k < 12; k++) { const a = (k * Math.PI) / 6 + t * 0.03, rr = k % 2 ? 2 : 6; ctx.lineTo(f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr); }
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = `rgba(238, 247, 255, ${0.55 + f.r * 0.15})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, 6.29);
        ctx.fill();
      }
    }
    for (const b of shards) {
      ctx.globalAlpha = Math.max(0, Math.min(1, b.life / 40));
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.y, b.size, b.size);
      ctx.globalAlpha = 1;
    }
  }

  let t = 0;
  let lastMeasure = 0;
  function loop(now) {
    if (!running) return;
    if (!paused) {
      t += 1;
      if (now - lastMeasure > 500) { lastMeasure = now; measure(); } // news, buttons and the title can move
      step();
      draw(t);
    }
    requestAnimationFrame(loop);
  }

  // ---------- Input ----------

  addEventListener('pointermove', (e) => {
    if (mouse.inside) { mouse.vx = e.clientX - mouse.x; mouse.vy = e.clientY - mouse.y; }
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    document.documentElement.style.setProperty('--frost-x', `${e.clientX}px`);
    document.documentElement.style.setProperty('--frost-y', `${e.clientY}px`);
  });
  document.addEventListener('pointerleave', () => { mouse.inside = false; mouse.x = mouse.y = -999; mouse.vx = mouse.vy = 0; });
  addEventListener('blur', () => { mouse.inside = false; mouse.x = mouse.y = -999; });

  // A click (outside the dialogs) sends a gust that also lifts the snow around it.
  addEventListener('click', (e) => {
    if (config.style !== 'winter' || document.querySelector('dialog[open]')) return;
    const p = { x: e.clientX, y: e.clientY };
    for (const f of flakes) if (f.gold && Math.hypot(f.x - p.x, f.y - p.y) < 24) return catchGold(f);
    if (!on('wind')) return;
    for (const list of [flakes, grains]) for (const f of list) {
      const dx = f.x - p.x, dy = f.y - p.y, d = Math.hypot(dx, dy);
      if (d < 160) { const k = ((160 - d) / 160) * 5; f.vx += (dx / (d || 1)) * k; f.vy += (dy / (d || 1)) * k; }
    }
  });

  // JOUER: the ice cracks and the snow on the button falls off.
  document.getElementById('btn-play').addEventListener('click', (e) => {
    const button = e.currentTarget;
    if (config.style !== 'winter' || button.disabled) return;
    button.classList.add('cracked');
    setTimeout(() => button.classList.remove('cracked'), 2000);
    const s = surfaces.find((x) => x.el === button);
    if (!s) return;
    for (let i = 0; i < s.n; i++) {
      for (let m = s.pile[i]; m > 0.3; m -= GRAIN) grain(s.x + i * CELL + 2, s.y - m, (Math.random() - 0.5) * 3, -1 - Math.random() * 3, Math.min(GRAIN, m));
      s.pile[i] = 0;
    }
    sparkle(s.x + s.w / 2, s.y + s.h / 2, 26, '#d7ecff');
  });

  addEventListener('resize', resize);

  // ---------- Control (app.js) ----------

  function apply() {
    const winter = config.style === 'winter';
    const body = document.body.classList;
    body.toggle('winter', winter);
    body.toggle('with-aurora', winter && config.effects.aurora);
    body.toggle('with-frost', winter && config.effects.frost);
    canvas.hidden = !winter;
    if (!config.effects.pile) { surfaces.forEach((s) => s.pile.fill(0)); grains.length = 0; }
    if (!config.effects.gold) flakes.forEach((f) => (f.gold = false));
    setAmount();
    if (winter && !running) {
      running = true;
      resize();
      seed();
      requestAnimationFrame(loop);
    } else if (!winter && running) {
      running = false;
      ctx.clearRect(0, 0, W, H);
      surfaces = [];
    }
  }

  window.winter = {
    /** { style: 'base' | 'winter', effects: { snow, physics, pile, wind, aurora, frost, gold }, amount: 0 | 1 | 2 } */
    configure(next) {
      if (next.style) config.style = next.style === 'winter' ? 'winter' : 'base';
      if (next.effects) config.effects = { ...config.effects, ...next.effects };
      if (next.amount !== undefined) config.amount = Number(next.amount);
      apply();
    },
    /** Paused while the game runs: no CPU taken from Minecraft. */
    pause(value) { paused = Boolean(value); },
    onGold: null, // set by app.js: a gold flake was caught
  };
})();
