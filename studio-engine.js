/* Traumatic Studios engine toolkit: loop, input, audio, particles, camera, collision, grids and pathfinding. */
const Engine = (() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const held = new Set();
  const pressedKeys = new Set();
  const pointer = { x: 0, y: 0, down: false, pressed: false, released: false };
  const norm = (k) => (k === " " ? "space" : k.toLowerCase());
  const GAME_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "space", "tab"]);
  let restartFn = () => {};
  window.addEventListener("keydown", (e) => {
    const k = norm(e.key);
    if (GAME_KEYS.has(k)) e.preventDefault();
    if (!held.has(k)) pressedKeys.add(k);
    held.add(k);
    if (k === "r") restartFn();
  });
  window.addEventListener("keyup", (e) => held.delete(norm(e.key)));
  window.addEventListener("blur", () => held.clear());
  const place = (e) => {
    const b = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - b.left) / b.width) * W;
    pointer.y = ((e.clientY - b.top) / b.height) * H;
  };
  canvas.addEventListener("pointermove", place);
  canvas.addEventListener("pointerdown", (e) => { place(e); pointer.down = true; pointer.pressed = true; });
  window.addEventListener("pointerup", () => { pointer.down = false; pointer.released = true; });
  const restartButton = document.getElementById("restart");
  if (restartButton) restartButton.addEventListener("click", () => { restartFn(); restartButton.blur(); });

  const input = {
    held: (...keys) => keys.some((k) => held.has(k)),
    pressed: (...keys) => keys.some((k) => pressedKeys.has(k)),
    axis: (neg, pos) => (neg.some((k) => held.has(k)) ? -1 : 0) + (pos.some((k) => held.has(k)) ? 1 : 0),
    pointer,
  };
  const move = () => ({ x: input.axis(["arrowleft", "a"], ["arrowright", "d"]), y: input.axis(["arrowup", "w"], ["arrowdown", "s"]) });
  const action = () => input.pressed("space", "j", "z", "enter");

  function rng(seed) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (a, b) => a + next() * (b - a),
      int: (a, b) => Math.floor(a + next() * (b - a + 1)),
      chance: (p) => next() < p,
      pick: (list) => list[Math.floor(next() * list.length)],
      shuffle: (list) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; },
    };
  }
  const hashString = (text) => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

  let audioCtx = null;
  let muted = false;
  const PRESETS = {
    blip: { freq: 520, dur: 0.07, type: "square", vol: 0.06 },
    pickup: { freq: 660, dur: 0.14, type: "triangle", slide: 500, vol: 0.09 },
    hit: { freq: 160, dur: 0.14, type: "sawtooth", slide: -90, vol: 0.1 },
    jump: { freq: 300, dur: 0.16, type: "square", slide: 280, vol: 0.06 },
    shoot: { freq: 880, dur: 0.1, type: "square", slide: -600, vol: 0.05 },
    explode: { freq: 110, dur: 0.35, type: "sawtooth", slide: -80, vol: 0.14 },
    powerup: { freq: 400, dur: 0.35, type: "triangle", slide: 700, vol: 0.09 },
    lose: { freq: 300, dur: 0.6, type: "sawtooth", slide: -250, vol: 0.1 },
    win: { freq: 500, dur: 0.6, type: "triangle", slide: 500, vol: 0.1 },
  };
  function sfx(nameOrSpec) {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const s = typeof nameOrSpec === "string" ? PRESETS[nameOrSpec] || PRESETS.blip : nameOrSpec;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime;
      osc.type = s.type || "square";
      osc.frequency.setValueAtTime(s.freq, t);
      if (s.slide) osc.frequency.linearRampToValueAtTime(Math.max(30, s.freq + s.slide), t + s.dur);
      gain.gain.setValueAtTime(s.vol || 0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + s.dur);
    } catch (error) { muted = true; }
  }
  window.addEventListener("keydown", (e) => { if (norm(e.key) === "m") muted = !muted; });

  let particles = [];
  let floaters = [];
  let shakeTime = 0;
  let shakePower = 0;
  const fx = {
    burst(x, y, o = {}) {
      const n = o.count || 12;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (o.speed || 120) * (0.3 + Math.random());
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: o.life || 0.5, max: o.life || 0.5, size: o.size || 3, color: o.color || "#fff", gravity: o.gravity || 0 });
      }
    },
    text(x, y, str, color = "#fff") { floaters.push({ x, y, str, color, life: 0.9 }); },
    shake(power = 6, time = 0.25) { shakePower = power; shakeTime = time; },
    update(dt) {
      for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.gravity * dt; p.life -= dt; }
      particles = particles.filter((p) => p.life > 0);
      for (const f of floaters) { f.y -= 30 * dt; f.life -= dt; }
      floaters = floaters.filter((f) => f.life > 0);
      shakeTime = Math.max(0, shakeTime - dt);
    },
    draw(c) {
      for (const p of particles) { c.globalAlpha = Math.max(0, p.life / p.max); c.fillStyle = p.color; c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); }
      c.globalAlpha = 1;
      c.font = "bold 12px system-ui";
      c.textAlign = "center";
      for (const f of floaters) { c.globalAlpha = Math.min(1, f.life * 2); c.fillStyle = f.color; c.fillText(f.str, f.x, f.y); }
      c.globalAlpha = 1;
    },
    shakeOffset: () => (shakeTime > 0 ? { x: (Math.random() - 0.5) * shakePower, y: (Math.random() - 0.5) * shakePower } : { x: 0, y: 0 }),
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const hit = {
    rect: (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
    circle: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r,
    point: (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h,
  };

  const camera = {
    x: 0, y: 0,
    follow(target, bounds, smooth = 0.12) {
      this.x = lerp(this.x, target.x - W / 2, smooth);
      this.y = lerp(this.y, target.y - H / 2, smooth);
      if (bounds) { this.x = clamp(this.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.w - W)); this.y = clamp(this.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.h - H)); }
    },
    begin(c) { const s = fx.shakeOffset(); c.save(); c.translate(Math.round(-this.x + s.x), Math.round(-this.y + s.y)); },
    end(c) { c.restore(); },
  };

  const grid = {
    make: (w, h, fill = 0) => ({ w, h, cells: new Array(w * h).fill(fill) }),
    get: (g, x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? -1 : g.cells[y * g.w + x]),
    set: (g, x, y, v) => { if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.cells[y * g.w + x] = v; },
    // Breadth-first path over a grid; passable(value, x, y) decides walkability. Returns an array of {x,y} cells or null.
    path(g, from, to, passable) {
      const key = (x, y) => y * g.w + x;
      const prev = new Map([[key(from.x, from.y), null]]);
      const queue = [from];
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        if (c.x === to.x && c.y === to.y) {
          const out = [];
          for (let n = c; n; n = prev.get(key(n.x, n.y))) out.unshift(n);
          return out;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          const v = grid.get(g, nx, ny);
          if (v === -1 || prev.has(key(nx, ny)) || !passable(v, nx, ny)) continue;
          prev.set(key(nx, ny), c);
          queue.push({ x: nx, y: ny });
        }
      }
      return null;
    },
  };

  const ui = {
    hud: (text) => { const el = document.getElementById("hud"); if (el) el.textContent = text; },
    message: (text) => { const el = document.getElementById("message"); if (el) el.textContent = text; },
    text(c, str, x, y, o = {}) {
      c.font = `${o.bold === false ? "" : "bold "}${o.size || 16}px system-ui, sans-serif`;
      c.textAlign = o.align || "left";
      c.fillStyle = o.color || "#fff";
      c.fillText(str, x, y);
    },
    banner(c, title, sub) {
      c.fillStyle = "rgba(0,0,0,0.6)";
      c.fillRect(0, H / 2 - 50, W, 100);
      ui.text(c, title, W / 2, H / 2 - 4, { size: 30, align: "center" });
      if (sub) ui.text(c, sub, W / 2, H / 2 + 26, { size: 14, align: "center", bold: false });
    },
    bar(c, x, y, w, h, frac, color, back = "#0008") { c.fillStyle = back; c.fillRect(x, y, w, h); c.fillStyle = color; c.fillRect(x, y, w * clamp(frac, 0, 1), h); },
  };

  // Fixed 60 Hz simulation; game supplies { reset, update(dt), draw(ctx) }.
  function start(game) {
    restartFn = () => game.reset();
    game.reset();
    let last = performance.now();
    let acc = 0;
    const STEP = 1 / 60;
    function frame(now) {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP) {
        game.update(STEP);
        fx.update(STEP);
        pressedKeys.clear();
        pointer.pressed = false;
        pointer.released = false;
        acc -= STEP;
      }
      game.draw(ctx);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  return { canvas, ctx, W, H, input, move, action, rng, hashString, sfx, fx, clamp, lerp, dist, angle, hit, camera, grid, ui, start };
})();
