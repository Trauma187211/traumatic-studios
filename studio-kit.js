/* Traumatic Studios Kit: pre-tested building blocks that sit on top of Engine (tilemaps, movement, AI, pathfinding, procedural generation, music, dialogue). */
const Kit = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

  // ---------- Tilemaps and collision ----------
  // A map is { w, h, ts, cells, solid(v) }. Tiles outside the map count as solid.
  const tiles = {
    make(w, h, ts = 32, solid = (v) => v === 1, fill = 0) {
      return { w, h, ts, cells: new Array(w * h).fill(fill), solid };
    },
    fromRows(rows, ts = 32, legend = { "#": 1, ".": 0 }, solid = (v) => v === 1) {
      const map = tiles.make(rows[0].length, rows.length, ts, solid, 0);
      rows.forEach((row, y) => [...row].forEach((ch, x) => { map.cells[y * map.w + x] = legend[ch] !== undefined ? legend[ch] : 0; }));
      return map;
    },
    get: (map, x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? -1 : map.cells[y * map.w + x]),
    set(map, x, y, v) { if (x >= 0 && y >= 0 && x < map.w && y < map.h) map.cells[y * map.w + x] = v; },
    isSolid(map, x, y) { const v = tiles.get(map, x, y); return v === -1 || map.solid(v); },
    solidAt: (map, px, py) => tiles.isSolid(map, Math.floor(px / map.ts), Math.floor(py / map.ts)),
    overlaps(map, r) {
      const x0 = Math.floor(r.x / map.ts);
      const x1 = Math.floor((r.x + r.w - 1e-6) / map.ts);
      const y0 = Math.floor(r.y / map.ts);
      const y1 = Math.floor((r.y + r.h - 1e-6) / map.ts);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tiles.isSolid(map, x, y)) return true;
      return false;
    },
    // Moves a body {x,y,w,h} by dx,dy one axis at a time and slides along walls. Returns which axes were blocked.
    move(map, b, dx, dy) {
      const hit = { x: 0, y: 0 };
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (map.ts / 2)));
      const sx = dx / steps;
      const sy = dy / steps;
      for (let i = 0; i < steps; i++) {
        if (sx) {
          b.x += sx;
          if (tiles.overlaps(map, b)) {
            b.x = sx > 0 ? Math.floor((b.x + b.w - 1e-6) / map.ts) * map.ts - b.w : (Math.floor(b.x / map.ts) + 1) * map.ts;
            hit.x = Math.sign(sx);
          }
        }
        if (sy) {
          b.y += sy;
          if (tiles.overlaps(map, b)) {
            b.y = sy > 0 ? Math.floor((b.y + b.h - 1e-6) / map.ts) * map.ts - b.h : (Math.floor(b.y / map.ts) + 1) * map.ts;
            hit.y = Math.sign(sy);
          }
        }
      }
      return hit;
    },
    // True when nothing solid lies on the straight line between two world points.
    lineClear(map, a, b) {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (map.ts / 4)));
      for (let i = 0; i <= n; i++) if (tiles.solidAt(map, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return false;
      return true;
    },
    // Draws only the visible tiles. colors maps a tile value to a fill color, or is a function (v, x, y) => color|null.
    draw(c, map, colors, cam = { x: 0, y: 0 }, view = { w: 640, h: 480 }) {
      const x0 = Math.max(0, Math.floor(cam.x / map.ts));
      const y0 = Math.max(0, Math.floor(cam.y / map.ts));
      const x1 = Math.min(map.w - 1, Math.floor((cam.x + view.w) / map.ts));
      const y1 = Math.min(map.h - 1, Math.floor((cam.y + view.h) / map.ts));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = map.cells[y * map.w + x];
          const color = typeof colors === "function" ? colors(v, x, y) : colors[v];
          if (!color) continue;
          c.fillStyle = color;
          c.fillRect(x * map.ts, y * map.ts, map.ts, map.ts);
        }
      }
    },
  };

  // ---------- Movement controllers ----------
  // Platformer body: { x, y, w, h, vx, vy }. ctl = { x: -1..1, jumpPressed, jumpHeld }. Includes coyote time, jump buffering and variable jump height.
  function platformer(b, ctl, dt, map, o = {}) {
    const p = { speed: 150, accel: 1200, friction: 1500, gravity: 1500, jump: 460, maxFall: 700, coyote: 0.1, buffer: 0.12, cutGravity: 2.6, ...o };
    b.vx = b.vx || 0;
    b.vy = b.vy || 0;
    b.coyote = b.onGround ? p.coyote : Math.max(0, (b.coyote || 0) - dt);
    b.buffer = ctl.jumpPressed ? p.buffer : Math.max(0, (b.buffer || 0) - dt);
    b.vx = approach(b.vx, ctl.x * p.speed, (ctl.x ? p.accel : p.friction) * dt);
    let jumped = false;
    if (b.buffer > 0 && b.coyote > 0) { b.vy = -p.jump; b.buffer = 0; b.coyote = 0; jumped = true; }
    b.vy = Math.min(p.maxFall, b.vy + p.gravity * (b.vy < 0 && !ctl.jumpHeld ? p.cutGravity : 1) * dt);
    const hit = tiles.move(map, b, b.vx * dt, b.vy * dt);
    if (hit.x) b.vx = 0;
    b.onGround = hit.y > 0;
    if (hit.y) b.vy = 0;
    return { jumped, landed: hit.y > 0, bumped: hit.y < 0 };
  }

  // Top-down body: ctl = { x, y } in -1..1. Diagonals are normalised so they are not faster.
  function topdown(b, ctl, dt, map, o = {}) {
    const speed = o.speed || 120;
    const len = Math.hypot(ctl.x, ctl.y) || 1;
    const scale = len > 1 ? 1 / len : 1;
    b.vx = approach(b.vx || 0, ctl.x * scale * speed, (o.accel || 1400) * dt);
    b.vy = approach(b.vy || 0, ctl.y * scale * speed, (o.accel || 1400) * dt);
    const hit = tiles.move(map, b, b.vx * dt, b.vy * dt);
    if (hit.x) b.vx = 0;
    if (hit.y) b.vy = 0;
    if (ctl.x || ctl.y) b.facing = Math.abs(ctl.x) > Math.abs(ctl.y) ? { x: Math.sign(ctl.x), y: 0 } : { x: 0, y: Math.sign(ctl.y) };
    return hit;
  }

  // ---------- Health, knockback, timers, tweens, state machines, events ----------
  function health(max, { invuln = 0.8 } = {}) {
    return {
      hp: max, max, inv: 0,
      hurt(n) { if (this.inv > 0 || this.hp <= 0) return false; this.hp = Math.max(0, this.hp - n); this.inv = invuln; return true; },
      heal(n) { this.hp = Math.min(this.max, this.hp + n); },
      update(dt) { this.inv = Math.max(0, this.inv - dt); },
      alive() { return this.hp > 0; },
      blinking() { return this.inv > 0 && Math.floor(this.inv * 20) % 2 === 0; },
    };
  }
  function knockback(b, fromX, fromY, power = 260) {
    const dx = b.x + (b.w || 0) / 2 - fromX;
    const dy = b.y + (b.h || 0) / 2 - fromY;
    const len = Math.hypot(dx, dy) || 1;
    b.vx = (dx / len) * power;
    b.vy = (dy / len) * power;
  }
  const timer = (seconds, autoReset = true) => ({
    t: 0,
    update(dt) { this.t += dt; if (this.t >= seconds) { this.t = autoReset ? this.t - seconds : seconds; return true; } return false; },
    reset() { this.t = 0; },
    frac() { return clamp(this.t / seconds, 0, 1); },
  });
  const ease = {
    linear: (t) => t,
    inQuad: (t) => t * t,
    outQuad: (t) => 1 - (1 - t) * (1 - t),
    inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
    outBounce: (t) => { const n = 7.5625; const d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; },
  };
  function tween(from, to, dur, fn = ease.outQuad) {
    return { t: 0, value: from, done: false, update(dt) { this.t = Math.min(dur, this.t + dt); this.value = from + (to - from) * fn(this.t / dur); this.done = this.t >= dur; return this.value; } };
  }
  // states: { name: { enter(ctx), update(ctx, dt), exit(ctx) } }
  function fsm(states, initial, ctx = {}) {
    const m = {
      name: initial, time: 0, ctx,
      go(next) { if (next === m.name) return; if (states[m.name] && states[m.name].exit) states[m.name].exit(ctx); m.name = next; m.time = 0; if (states[next] && states[next].enter) states[next].enter(ctx); },
      update(dt) { m.time += dt; if (states[m.name] && states[m.name].update) states[m.name].update(ctx, dt, m); },
    };
    if (states[initial] && states[initial].enter) states[initial].enter(ctx);
    return m;
  }
  function bus() {
    const handlers = {};
    return { on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }, emit(name, data) { (handlers[name] || []).forEach((fn) => fn(data)); } };
  }

  // ---------- Pathfinding, steering, perception ----------
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const path = {
    // A* over a tile map. passable(x, y) => bool. Returns [{x,y}...] including start and goal, or null.
    astar(map, from, to, passable = (x, y) => !tiles.isSolid(map, x, y)) {
      if (!passable(to.x, to.y)) return null;
      const key = (x, y) => y * map.w + x;
      const h = (x, y) => Math.abs(x - to.x) + Math.abs(y - to.y);
      const g = new Map([[key(from.x, from.y), 0]]);
      const prev = new Map();
      const open = [{ x: from.x, y: from.y, f: h(from.x, from.y) }];
      const closed = new Set();
      while (open.length) {
        let best = 0;
        for (let i = 1; i < open.length; i++) if (open[i].f < open[best].f) best = i;
        const cur = open.splice(best, 1)[0];
        const ck = key(cur.x, cur.y);
        if (closed.has(ck)) continue;
        closed.add(ck);
        if (cur.x === to.x && cur.y === to.y) {
          const out = [{ x: cur.x, y: cur.y }];
          for (let k = prev.get(ck); k !== undefined; k = prev.get(k)) out.unshift({ x: k % map.w, y: Math.floor(k / map.w) });
          return out;
        }
        for (const [dx, dy] of DIRS4) {
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h || !passable(nx, ny)) continue;
          const nk = key(nx, ny);
          const ng = g.get(ck) + 1;
          if (g.has(nk) && g.get(nk) <= ng) continue;
          g.set(nk, ng);
          prev.set(nk, ck);
          open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
        }
      }
      return null;
    },
    // Distance field from a goal; many enemies can share it. Unreachable cells are -1.
    flow(map, goal, passable = (x, y) => !tiles.isSolid(map, x, y)) {
      const d = new Array(map.w * map.h).fill(-1);
      d[goal.y * map.w + goal.x] = 0;
      const queue = [goal];
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        for (const [dx, dy] of DIRS4) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h || d[ny * map.w + nx] !== -1 || !passable(nx, ny)) continue;
          d[ny * map.w + nx] = d[c.y * map.w + c.x] + 1;
          queue.push({ x: nx, y: ny });
        }
      }
      return { w: map.w, h: map.h, d };
    },
    // Best neighbouring cell of a flow field (or the same cell when already at the goal / cut off).
    next(field, x, y) {
      let best = { x, y };
      let bestD = field.d[y * field.w + x];
      if (bestD < 0) return best;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= field.w || ny >= field.h) continue;
        const v = field.d[ny * field.w + nx];
        if (v >= 0 && v < bestD) { bestD = v; best = { x: nx, y: ny }; }
      }
      return best;
    },
  };
  const steer = {
    seek(from, to, speed) { const dx = to.x - from.x; const dy = to.y - from.y; const len = Math.hypot(dx, dy) || 1; return { x: (dx / len) * speed, y: (dy / len) * speed }; },
    flee(from, away, speed) { const v = steer.seek(away, from, speed); return v; },
    // Enemy that notices the target within range and with a clear line of sight. Returns true while alerted.
    sees(map, from, to, range) { return Math.hypot(to.x - from.x, to.y - from.y) <= range && tiles.lineClear(map, from, to); },
  };

  // ---------- Noise ----------
  function noise(seed = 1) {
    const hash = (x, y) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const smooth = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = smooth(x - xi);
      const fy = smooth(y - yi);
      const a = hash(xi, yi) * (1 - fx) + hash(xi + 1, yi) * fx;
      const b = hash(xi, yi + 1) * (1 - fx) + hash(xi + 1, yi + 1) * fx;
      return a * (1 - fy) + b * fy;
    };
  }

  // ---------- Procedural generation (all take a seeded rng with next/int/chance/pick) ----------
  function flood(map, start, passable) {
    const seen = new Set([start.y * map.w + start.x]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      for (const [dx, dy] of DIRS4) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h || seen.has(ny * map.w + nx) || !passable(nx, ny)) continue;
        seen.add(ny * map.w + nx);
        queue.push({ x: nx, y: ny });
      }
    }
    return seen;
  }
  const gen = {
    flood,
    // Rooms joined by L-shaped corridors. Every room is connected by construction. 1 = wall, 0 = floor.
    rooms(rng, w, h, { rooms: count = 8, min = 4, max = 9, ts = 32 } = {}) {
      const map = tiles.make(w, h, ts, (v) => v === 1, 1);
      const list = [];
      for (let tries = 0; tries < count * 30 && list.length < count; tries++) {
        const rw = rng.int(min, max);
        const rh = rng.int(min, max);
        const room = { x: rng.int(1, w - rw - 2), y: rng.int(1, h - rh - 2), w: rw, h: rh };
        if (list.some((o) => room.x < o.x + o.w + 1 && room.x + room.w + 1 > o.x && room.y < o.y + o.h + 1 && room.y + room.h + 1 > o.y)) continue;
        list.push(room);
      }
      const carve = (x, y) => tiles.set(map, x, y, 0);
      list.forEach((r) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y); });
      const center = (r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
      for (let i = 1; i < list.length; i++) {
        const a = center(list[i - 1]);
        const b = center(list[i]);
        for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, a.y);
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(b.x, y);
      }
      return { map, rooms: list, centers: list.map(center) };
    },
    // Cellular-automata caves; only the biggest open region is kept so the whole map is reachable.
    cave(rng, w, h, { fill = 0.45, passes = 4, ts = 32 } = {}) {
      const map = tiles.make(w, h, ts, (v) => v === 1, 1);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) map.cells[y * w + x] = rng.chance(fill) ? 1 : 0;
      for (let p = 0; p < passes; p++) {
        const next = map.cells.slice();
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            let walls = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles.isSolid(map, x + dx, y + dy)) walls++;
            next[y * w + x] = walls >= 5 ? 1 : 0;
          }
        }
        map.cells = next;
      }
      let best = new Set();
      const visited = new Set();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (map.cells[y * w + x] === 1 || visited.has(y * w + x)) continue;
          const region = flood(map, { x, y }, (nx, ny) => map.cells[ny * w + nx] === 0);
          region.forEach((k) => visited.add(k));
          if (region.size > best.size) best = region;
        }
      }
      for (let i = 0; i < map.cells.length; i++) if (!best.has(i)) map.cells[i] = 1;
      const open = [...best];
      const first = open.length ? open[0] : 0;
      return { map, start: { x: first % w, y: Math.floor(first / w) }, openCount: best.size };
    },
    // Perfect maze (recursive backtracker) on an odd-sized grid. Every open cell is reachable.
    maze(rng, w, h, ts = 32) {
      const W = w % 2 ? w : w + 1;
      const H = h % 2 ? h : h + 1;
      const map = tiles.make(W, H, ts, (v) => v === 1, 1);
      const stack = [{ x: 1, y: 1 }];
      tiles.set(map, 1, 1, 0);
      while (stack.length) {
        const c = stack[stack.length - 1];
        const options = rng.shuffle(DIRS4.map(([dx, dy]) => [dx * 2, dy * 2])).filter(([dx, dy]) => tiles.get(map, c.x + dx, c.y + dy) === 1);
        if (!options.length) { stack.pop(); continue; }
        const [dx, dy] = options[0];
        tiles.set(map, c.x + dx / 2, c.y + dy / 2, 0);
        tiles.set(map, c.x + dx, c.y + dy, 0);
        stack.push({ x: c.x + dx, y: c.y + dy });
      }
      return { map, start: { x: 1, y: 1 }, end: { x: W - 2, y: H - 2 } };
    },
    // Zelda-style dungeon graph on a cols x rows room grid: one locked door guards the goal and its key is always reachable first.
    dungeon(rng, cols = 4, rows = 3) {
      const id = (x, y) => y * cols + x;
      const start = { x: rng.int(0, cols - 1), y: rng.int(0, rows - 1) };
      const seen = new Set([id(start.x, start.y)]);
      const doors = [];
      const stack = [start];
      while (stack.length) {
        const c = stack[stack.length - 1];
        const next = rng.shuffle(DIRS4.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }))).filter((n) => n.x >= 0 && n.y >= 0 && n.x < cols && n.y < rows && !seen.has(id(n.x, n.y)));
        if (!next.length) { stack.pop(); continue; }
        seen.add(id(next[0].x, next[0].y));
        doors.push({ a: id(c.x, c.y), b: id(next[0].x, next[0].y), locked: false });
        stack.push(next[0]);
      }
      const adj = (skip) => { const m = new Map(); doors.forEach((d, i) => { if (i === skip) return; (m.get(d.a) || m.set(d.a, []).get(d.a)).push(d.b); (m.get(d.b) || m.set(d.b, []).get(d.b)).push(d.a); }); return m; };
      const bfs = (graph, from) => { const parent = new Map([[from, -1]]); const q = [from]; for (let i = 0; i < q.length; i++) for (const n of graph.get(q[i]) || []) if (!parent.has(n)) { parent.set(n, q[i]); q.push(n); } return { parent, order: q }; };
      const first = bfs(adj(-1), id(start.x, start.y));
      const goal = first.order[first.order.length - 1];
      const route = [];
      for (let n = goal; n !== -1; n = first.parent.get(n)) route.unshift(n);
      let lockedIndex = -1;
      if (route.length > 2) {
        const edgeAt = rng.int(1, route.length - 2);
        lockedIndex = doors.findIndex((d) => (d.a === route[edgeAt] && d.b === route[edgeAt + 1]) || (d.b === route[edgeAt] && d.a === route[edgeAt + 1]));
      }
      let keyRoom = -1;
      if (lockedIndex >= 0) {
        doors[lockedIndex].locked = true;
        const reach = bfs(adj(lockedIndex), id(start.x, start.y)).order.filter((r) => r !== id(start.x, start.y));
        keyRoom = reach.length ? rng.pick(reach) : id(start.x, start.y);
      }
      return { cols, rows, start: id(start.x, start.y), goal, doors, keyRoom, roomXY: (r) => ({ x: r % cols, y: Math.floor(r / cols) }) };
    },
    // Walks the dungeon the way a player would: collect the key, then open the locked door. True when the goal is reachable.
    dungeonSolvable(d) {
      const reach = (hasKey) => {
        const seen = new Set([d.start]);
        const q = [d.start];
        for (let i = 0; i < q.length; i++) for (const door of d.doors) {
          if (door.locked && !hasKey) continue;
          const other = door.a === q[i] ? door.b : door.b === q[i] ? door.a : -1;
          if (other >= 0 && !seen.has(other)) { seen.add(other); q.push(other); }
        }
        return seen;
      };
      const locked = d.doors.some((x) => x.locked);
      if (!locked) return reach(false).has(d.goal);
      return reach(false).has(d.keyRoom) && reach(true).has(d.goal) && !reach(false).has(d.goal);
    },
  };

  // ---------- Music ----------
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], pentatonic: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10] };
  const music = {
    // Deterministic song: a bass line on chord roots and a lead melody on the scale, 16 steps per bar. Notes are { step, midi, len }.
    compose(rng, { scale = "minor", bars = 4, root = 57, bpm = 110 } = {}) {
      const steps = SCALES[scale] || SCALES.minor;
      const degree = (d) => root + steps[((d % steps.length) + steps.length) % steps.length] + 12 * Math.floor(d / steps.length);
      const progression = [0, 5 % steps.length, 3 % steps.length, 4 % steps.length];
      const bass = [];
      const lead = [];
      for (let bar = 0; bar < bars; bar++) {
        const chord = progression[bar % progression.length];
        for (let s = 0; s < 16; s += 4) bass.push({ step: bar * 16 + s, midi: degree(chord) - 12, len: 4 });
        let d = chord + 2;
        for (let s = 0; s < 16; s += 2) {
          if (rng.chance(0.25)) continue;
          d = clamp(d + rng.pick([-2, -1, 0, 1, 2]), chord - 2, chord + 7);
          lead.push({ step: bar * 16 + s, midi: degree(d) + 12, len: rng.pick([1, 2, 2, 3]) });
        }
      }
      return { bpm, bars, steps: bars * 16, bass, lead };
    },
    mtof: (m) => 440 * Math.pow(2, (m - 69) / 12),
    // Looping playback through WebAudio, scheduled slightly ahead. Silent and harmless where audio is unavailable.
    play(song, { volume = 0.04 } = {}) {
      music.stop();
      const AC = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
      if (!AC || typeof setTimeout !== "function") return false;
      try {
        music.ctx = music.ctx || new AC();
        music.token = (music.token || 0) + 1;
        const token = music.token;
        const stepDur = 60 / song.bpm / 4;
        let nextTime = music.ctx.currentTime + 0.1;
        let step = 0;
        const tick = () => {
          if (token !== music.token) return;
          while (nextTime < music.ctx.currentTime + 0.4) {
            for (const [notes, type, gainMul] of [[song.bass, "triangle", 1.4], [song.lead, "square", 1]]) {
              for (const n of notes) {
                if (n.step !== step || music.muted) continue;
                const osc = music.ctx.createOscillator();
                const g = music.ctx.createGain();
                osc.type = type;
                osc.frequency.value = music.mtof(n.midi);
                g.gain.setValueAtTime(volume * gainMul, nextTime);
                g.gain.exponentialRampToValueAtTime(0.0001, nextTime + n.len * stepDur);
                osc.connect(g).connect(music.ctx.destination);
                osc.start(nextTime);
                osc.stop(nextTime + n.len * stepDur);
              }
            }
            nextTime += stepDur;
            step = (step + 1) % song.steps;
          }
          setTimeout(tick, 100);
        };
        tick();
        return true;
      } catch (error) {
        music.token++;
        return false;
      }
    },
    stop() { music.token = (music.token || 0) + 1; },
    muted: false,
  };

  // ---------- Dialogue (typewriter text box) ----------
  const dialogue = {
    lines: [], index: 0, shown: 0, active: false, onDone: null,
    open(lines, onDone) { this.lines = [].concat(lines); this.index = 0; this.shown = 0; this.active = true; this.onDone = onDone || null; },
    // Call every frame while active; advance = true when the player pressed the confirm key.
    update(dt, advance) {
      if (!this.active) return;
      const line = this.lines[this.index];
      if (this.shown < line.length) { this.shown = advance ? line.length : Math.min(line.length, this.shown + dt * 40); return; }
      if (advance) {
        this.index++;
        this.shown = 0;
        if (this.index >= this.lines.length) { this.active = false; if (this.onDone) this.onDone(); }
      }
    },
    draw(c, W, H, speaker) {
      if (!this.active) return;
      c.fillStyle = "rgba(10,10,30,0.88)";
      c.fillRect(16, H - 96, W - 32, 80);
      c.strokeStyle = "#fff";
      c.strokeRect(16.5, H - 95.5, W - 33, 79);
      c.fillStyle = "#fff";
      c.textAlign = "left";
      c.font = "bold 14px system-ui";
      if (speaker) { c.fillStyle = "#ffd36b"; c.fillText(speaker, 28, H - 74); c.fillStyle = "#fff"; }
      c.font = "15px system-ui";
      c.fillText(this.lines[this.index].slice(0, Math.floor(this.shown)), 28, H - 50);
    },
  };

  // ---------- Palettes and colour helpers ----------
  const palettes = {
    forest: ["#1b2a1f", "#2f5233", "#4c8c4a", "#a3c585", "#f2e8c9", "#8b5a2b"],
    dungeon: ["#0f0d17", "#26233a", "#4b4468", "#7b7399", "#c9c2e8", "#e0a458"],
    desert: ["#3b2a1a", "#a0622d", "#d89c56", "#f2d492", "#fff3d1", "#2a7f8a"],
    ocean: ["#06142e", "#0b3a73", "#1a73b5", "#5fb7e8", "#d8f3ff", "#ff7b54"],
    neon: ["#0a0014", "#2b0a5c", "#b300ff", "#00f0ff", "#fffb7d", "#ff2d6f"],
    snow: ["#16243a", "#4a6b8f", "#9ec0dd", "#e6f2fb", "#ffffff", "#d9534f"],
  };
  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => clamp(Math.round(v + 255 * amount), 0, 255);
    return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
  }

  return { tiles, platformer, topdown, health, knockback, timer, ease, tween, fsm, bus, path, steer, noise, gen, music, dialogue, palettes, shade, approach };
})();
