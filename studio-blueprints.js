// Blueprints: complete, pre-tested games driven by a small JSON spec. A weak model only fills in the spec
// (names, colours, enemies, items, story, tuning); the runtime below does the hard part. Needs Engine and Kit.
const Blueprint = (() => {
  const W = Engine.W;
  const H = Engine.H;
  const str = (v, d, n = 60) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : d);
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const hex = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : d);
  const list = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object").slice(0, max) : []);
  const lines = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 90)).slice(0, max) : []);
  const pick = (v, options, d) => { const s = typeof v === "string" ? v.toLowerCase().trim() : ""; return options.includes(s) ? s : d; };
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const center = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
  let debug = null;
  const FOE_COLORS = ["#c0392b", "#8e44ad", "#2980b9", "#d35400", "#16a085", "#7f8c8d"];

  function skin(spec) {
    const theme = pick(spec.theme, Object.keys(Kit.palettes), "dungeon");
    const p = Kit.palettes[theme];
    return { bg: p[0], floor: p[1], wall: p[2], light: p[3], text: p[4], accent: hex(spec.accent, p[5]), danger: "#ff5d5d" };
  }

  function common(spec, raw, fallbackTitle) {
    spec.title = str(raw.title, fallbackTitle, 40);
    spec.tagline = str(raw.tagline || raw.summary, "", 100);
    spec.theme = raw.theme;
    spec.accent = raw.accent;
    spec.seed = Math.floor(num(raw.seed, 1, 99999, Engine.hashString(spec.title) % 99999 + 1));
    spec.hero = str(raw.hero || raw.playerName, "Hero", 20);
    spec.intro = lines(raw.intro, 6);
    spec.outro = lines(raw.outro, 4);
    return spec;
  }

  function titleScreen(c, spec, sk, t, controls) {
    c.fillStyle = sk.bg;
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < 46; i++) {
      const x = (i * 97 + t * 18 * (1 + (i % 3))) % W;
      const y = (i * 53 + Math.sin(t + i) * 12 + H) % H;
      c.fillStyle = Kit.shade(sk.accent, -0.35 + (i % 4) * 0.08);
      c.fillRect(x, y, 2 + (i % 3), 2 + (i % 3));
    }
    Engine.ui.text(c, spec.title, W / 2, H * 0.3, { size: 42, align: "center", color: sk.accent });
    if (spec.tagline) Engine.ui.text(c, spec.tagline, W / 2, H * 0.3 + 34, { size: 16, align: "center", color: sk.text, bold: false });
    controls.forEach((line, i) => Engine.ui.text(c, line, W / 2, H * 0.5 + i * 24, { size: 15, align: "center", color: sk.light, bold: false }));
    if (Math.floor(t * 2) % 2 === 0) Engine.ui.text(c, "Press SPACE to start", W / 2, H * 0.86, { size: 20, align: "center", color: sk.text });
  }

  function heart(c, x, y, s, color) {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x, y + s * 0.35);
    c.bezierCurveTo(x, y - s * 0.1, x + s * 0.5, y - s * 0.1, x + s * 0.5, y + s * 0.3);
    c.bezierCurveTo(x + s * 0.5, y - s * 0.1, x + s, y - s * 0.1, x + s, y + s * 0.35);
    c.bezierCurveTo(x + s, y + s * 0.7, x + s * 0.5, y + s * 0.85, x + s * 0.5, y + s);
    c.bezierCurveTo(x + s * 0.5, y + s * 0.85, x, y + s * 0.7, x, y + s * 0.35);
    c.fill();
  }

  function startMusic(spec, mood) {
    try {
      const song = Kit.music.compose(Engine.rng(spec.seed), { scale: mood, bars: 4, bpm: 96 + (spec.seed % 40) });
      Kit.music.play(song);
    } catch (error) { /* audio is optional */ }
  }

  // ---------------------------------------------------------------- adventure
  const BEHAVIORS = ["chase", "wander", "charger", "shooter", "patrol"];
  function adventure(raw) {
    const spec = common({}, raw, "Lost Catacombs");
    spec.floors = Math.round(num(raw.floors, 1, 5, 3));
    spec.hearts = Math.round(num(raw.hearts, 3, 8, 5));
    spec.weapon = pick(raw.weapon, ["sword", "bow", "wand"], "sword");
    spec.keyName = str(raw.keyName, "Key", 16);
    spec.enemies = list(raw.enemies, 6).map((e, i) => ({
      name: str(e.name, `Foe ${i + 1}`, 18), color: hex(e.color, FOE_COLORS[i % 6]), hp: Math.round(num(e.hp, 1, 6, 2)),
      speed: num(e.speed, 30, 140, 60), behavior: pick(e.behavior, BEHAVIORS, BEHAVIORS[i % 5]),
    }));
    if (!spec.enemies.length) spec.enemies = BEHAVIORS.slice(0, 4).map((b, i) => ({ name: `Foe ${i + 1}`, color: FOE_COLORS[i], hp: 2, speed: 60, behavior: b }));
    const boss = raw.boss && typeof raw.boss === "object" ? raw.boss : {};
    spec.boss = { name: str(boss.name, "Guardian", 24), color: hex(boss.color, "#b03060"), hp: Math.round(num(boss.hp, 8, 40, 16)) };
    const effects = ["heal", "power", "speed", "shield"];
    spec.items = list(raw.items, 6).map((it, i) => ({ name: str(it.name, `Relic ${i + 1}`, 20), effect: pick(it.effect, effects, effects[i % 4]), color: hex(it.color, "#ffd36b") }));
    if (!spec.items.length) spec.items = [{ name: "Potion", effect: "heal", color: "#ff6b81" }, { name: "Power Gem", effect: "power", color: "#7bed9f" }, { name: "Swift Boots", effect: "speed", color: "#70a1ff" }];
    const sk = skin(spec);
    const COLS = 15;
    const ROWS = 10;
    const ts = Math.floor(Math.min(W / COLS, (H - 44) / ROWS));
    const ox = Math.floor((W - COLS * ts) / 2);
    const oy = 44 + Math.floor((H - 44 - ROWS * ts) / 2);
    const rng = Engine.rng(spec.seed + 99);
    let g;

    function reset() {
      g = { mode: "title", t: 0, floor: 0, score: 0, coins: 0, keys: 0, power: 0, speedMul: 1, kills: 0, shake: 0, fade: 0, hint: "", hintT: 0, proj: [], atk: null, cool: 0 };
      g.p = { x: 0, y: 0, w: ts * 0.5, h: ts * 0.5, vx: 0, vy: 0, facing: { x: 0, y: 1 }, health: Kit.health(spec.hearts, { invuln: 1 }) };
      Kit.music.stop();
    }

    function begin() {
      g.mode = "play";
      newFloor(1);
      startMusic(spec, "minor");
      if (spec.intro.length) Kit.dialogue.open(spec.intro, () => {});
    }

    function newFloor(n) {
      const r = Engine.rng(spec.seed + n * 977);
      let d;
      for (let i = 0; i < 25; i++) { d = Kit.gen.dungeon(r, Math.min(5, 3 + (n >= 2 ? 1 : 0) + (n >= 4 ? 1 : 0)), n >= 3 ? 4 : 3); if (Kit.gen.dungeonSolvable(d)) break; }
      Object.assign(g, { floor: n, d, rooms: {}, unlocked: new Set(), visited: new Set(), keys: 0, bossDown: false });
      g.p.health.hp = Math.min(g.p.health.max, g.p.health.hp + 2);
      enterRoom(d.start);
      g.p.x = COLS * ts / 2 - g.p.w / 2;
      g.p.y = ROWS * ts / 2 - g.p.h / 2;
      announce(`Floor ${n}`);
    }

    const announce = (text) => { g.hint = text; g.hintT = 2.2; };

    function makeEnemy(kind, x, y, boss) {
      const size = boss ? ts * 1.5 : ts * 0.62;
      const scale = 1 + (g.floor - 1) * (boss ? 0.4 : 0.5);
      const hp = Math.max(1, Math.round((boss ? spec.boss.hp : kind.hp) * scale));
      return { x: x - size / 2, y: y - size / 2, w: size, h: size, hp, max: hp, speed: boss ? 55 : kind.speed, color: boss ? spec.boss.color : kind.color, name: boss ? spec.boss.name : kind.name, behavior: boss ? "boss" : kind.behavior, boss, t: 0, s: "idle", flash: 0, stun: 0, kx: 0, ky: 0, dir: rng.chance(0.5) ? 1 : -1, shoot: 1 + rng.next() * 1.5, lock: { x: 0, y: 0 } };
    }

    function room(id) {
      if (g.rooms[id]) return g.rooms[id];
      const r = Engine.rng(spec.seed + g.floor * 977 + id * 31 + 7);
      const map = Kit.tiles.make(COLS, ROWS, ts, (v) => v === 1 || v === 2, 0);
      for (let x = 0; x < COLS; x++) { Kit.tiles.set(map, x, 0, 1); Kit.tiles.set(map, x, ROWS - 1, 1); }
      for (let y = 0; y < ROWS; y++) { Kit.tiles.set(map, 0, y, 1); Kit.tiles.set(map, COLS - 1, y, 1); }
      const me = g.d.roomXY(id);
      const gaps = {};
      const locks = [];
      g.d.doors.forEach((door, i) => {
        if (door.a !== id && door.b !== id) return;
        const other = door.a === id ? door.b : door.a;
        const o = g.d.roomXY(other);
        const dx = o.x - me.x;
        const dy = o.y - me.y;
        const cells = dx === 1 ? [[COLS - 1, 4], [COLS - 1, 5]] : dx === -1 ? [[0, 4], [0, 5]] : dy === 1 ? [[6, ROWS - 1], [7, ROWS - 1]] : [[6, 0], [7, 0]];
        gaps[dx === 1 ? "right" : dx === -1 ? "left" : dy === 1 ? "down" : "up"] = { other, door: i };
        const locked = door.locked && !g.unlocked.has(i);
        cells.forEach(([x, y]) => Kit.tiles.set(map, x, y, locked ? 2 : 0));
        if (locked) locks.push({ door: i, cells });
      });
      for (const [bx, by] of [[2, 2], [10, 2], [2, 6], [10, 6]]) {
        if (id === g.d.start || !r.chance(0.5)) continue;
        for (let y = by; y < by + 2; y++) for (let x = bx; x < bx + 2; x++) Kit.tiles.set(map, x, y, 1);
      }
      const rm = { id, map, gaps, locks, enemies: [], pickups: [] };
      const free = () => { for (let i = 0; i < 40; i++) { const x = r.int(2, COLS - 3) * ts + ts / 2; const y = r.int(2, ROWS - 3) * ts + ts / 2; if (!Kit.tiles.solidAt(map, x, y)) return { x, y }; } return { x: COLS * ts / 2, y: ROWS * ts / 2 }; };
      if (id === g.d.goal) {
        rm.enemies.push(makeEnemy(null, COLS * ts / 2, ROWS * ts / 2 - ts, true));
      } else if (id !== g.d.start) {
        const count = r.int(1, 2 + Math.min(3, g.floor));
        for (let i = 0; i < count; i++) { const at = free(); rm.enemies.push(makeEnemy(r.pick(spec.enemies), at.x, at.y, false)); }
        if (r.chance(0.3)) rm.pickups.push({ ...free(), kind: "heart" });
        if (r.chance(0.25)) rm.pickups.push({ ...free(), kind: "item", item: r.pick(spec.items) });
        for (let i = r.int(0, 3); i > 0; i--) rm.pickups.push({ ...free(), kind: "coin" });
      }
      if (id === g.d.keyRoom) { const at = free(); rm.pickups.push({ ...at, kind: "key" }); }
      g.rooms[id] = rm;
      return rm;
    }

    function enterRoom(id) {
      g.room = room(id);
      g.visited.add(id);
      g.proj = [];
      g.fade = 0.25;
    }

    const OPPOSITE = { left: "right", right: "left", up: "down", down: "up" };
    function go(dir) {
      enterRoom(g.room.gaps[dir].other);
      const p = g.p;
      if (dir === "left") p.x = (COLS - 1) * ts + (ts - p.w) / 2;
      if (dir === "right") p.x = (ts - p.w) / 2;
      if (dir === "left" || dir === "right") p.y = ROWS * ts / 2 - p.h / 2;
      if (dir === "up") p.y = (ROWS - 1) * ts + (ts - p.h) / 2;
      if (dir === "down") p.y = (ts - p.h) / 2;
      if (dir === "up" || dir === "down") p.x = 7 * ts - p.w / 2;
      p.vx = 0;
      p.vy = 0;
    }

    function hurtPlayer(dmg, fx, fy) {
      const p = g.p;
      if (!p.health.hurt(dmg)) return;
      Kit.knockback(p, fx, fy, 320);
      Engine.sfx("hit");
      Engine.fx.shake(6, 0.2);
      Engine.fx.burst(p.x + p.w / 2, p.y + p.h / 2, { count: 14, color: sk.danger, speed: 120, life: 0.4 });
      if (!p.health.alive()) { g.mode = "over"; Engine.sfx("lose"); Kit.music.stop(); }
    }

    function damageEnemy(rm, e, n, fromX, fromY) {
      e.hp -= n;
      e.flash = 0.15;
      e.stun = 0.18;
      const k = { x: e.x, y: e.y, w: e.w, h: e.h, vx: 0, vy: 0 };
      Kit.knockback(k, fromX, fromY, e.boss ? 60 : 260);
      e.kx = k.vx;
      e.ky = k.vy;
      Engine.sfx("hit");
      Engine.fx.text(e.x + e.w / 2, e.y, `-${n}`, "#fff");
      Engine.fx.burst(e.x + e.w / 2, e.y + e.h / 2, { count: 8, color: e.color, speed: 100, life: 0.3 });
      if (e.hp > 0) return;
      rm.enemies.splice(rm.enemies.indexOf(e), 1);
      g.kills++;
      g.score += e.boss ? 500 : 25;
      Engine.sfx("explode");
      Engine.fx.burst(e.x + e.w / 2, e.y + e.h / 2, { count: e.boss ? 60 : 20, color: e.color, speed: 180, life: 0.7 });
      Engine.fx.shake(e.boss ? 12 : 4, 0.25);
      const at = { x: e.x + e.w / 2, y: e.y + e.h / 2 };
      if (e.boss) {
        g.bossDown = true;
        rm.pickups.push({ ...at, kind: "portal" });
        if (spec.outro.length) Kit.dialogue.open(spec.outro, () => {});
      } else if (rng.chance(0.3)) rm.pickups.push({ ...at, kind: rng.chance(0.5) ? "heart" : "coin" });
    }

    function shootAt(from, to, speed, dmg, friendly, color) {
      const a = Math.atan2(to.y - from.y, to.x - from.x);
      g.proj.push({ x: from.x, y: from.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 5, dmg, friendly, life: 2.5, color });
    }

    function updateEnemy(rm, e, dt) {
      e.flash = Math.max(0, e.flash - dt);
      e.t += dt;
      const p = g.p;
      const ec = center(e);
      const pc = center(p);
      const dist = Math.hypot(pc.x - ec.x, pc.y - ec.y);
      const sees = Kit.steer.sees(rm.map, ec, pc, ts * 6);
      let v = { x: 0, y: 0 };
      if (e.stun > 0) {
        e.stun -= dt;
        v = { x: e.kx, y: e.ky };
        e.kx *= 0.92;
        e.ky *= 0.92;
      } else if (e.behavior === "chase" || e.behavior === "boss") {
        v = sees || e.boss ? Kit.steer.seek(ec, pc, e.speed * (e.boss && e.hp < e.max / 2 ? 1.5 : 1)) : wander(e);
        if (e.boss) {
          e.shoot -= dt;
          if (e.shoot <= 0) {
            e.shoot = e.hp < e.max / 2 ? 1.4 : 2.4;
            const n = e.hp < e.max / 2 ? 12 : 8;
            for (let i = 0; i < n; i++) shootAt(ec, { x: ec.x + Math.cos((i / n) * Math.PI * 2 + e.t), y: ec.y + Math.sin((i / n) * Math.PI * 2 + e.t) }, ts * 3.2, 1, false, "#ff9f43");
            Engine.sfx("shoot");
          }
        }
      } else if (e.behavior === "charger") {
        if (e.s === "idle") { v = wander(e); if (sees && dist < ts * 6) { e.s = "wind"; e.t = 0; e.lock = Kit.steer.seek(ec, pc, 1); } }
        else if (e.s === "wind") { if (e.t > 0.6) { e.s = "dash"; e.t = 0; } }
        else if (e.s === "dash") { v = { x: e.lock.x * e.speed * 4, y: e.lock.y * e.speed * 4 }; if (e.t > 0.45) { e.s = "rest"; e.t = 0; } }
        else if (e.t > 0.9) { e.s = "idle"; e.t = 0; }
      } else if (e.behavior === "shooter") {
        v = dist < ts * 3 ? Kit.steer.flee(ec, pc, e.speed) : dist > ts * 5.5 ? Kit.steer.seek(ec, pc, e.speed * 0.7) : { x: 0, y: 0 };
        e.shoot -= dt;
        if (e.shoot <= 0 && sees) { e.shoot = 1.7; shootAt(ec, pc, ts * 4.5, 1, false, e.color); Engine.sfx("shoot"); }
      } else if (e.behavior === "patrol") {
        v = { x: e.dir * e.speed, y: 0 };
      } else {
        v = wander(e);
      }
      const hit = Kit.tiles.move(rm.map, e, v.x * dt, v.y * dt);
      if (hit.x) { e.dir = -e.dir; e.wx = -(e.wx || 1); }
      if (hit.y) e.wy = -(e.wy || 1);
      if (overlap(e, p)) hurtPlayer(e.boss ? 2 : 1, ec.x, ec.y);
    }

    function wander(e) {
      if (!e.turn || e.t > e.turn) {
        e.turn = e.t + 0.8 + rng.next() * 1.2;
        const a = rng.next() * Math.PI * 2;
        e.wx = Math.cos(a);
        e.wy = Math.sin(a);
      }
      return { x: e.wx * e.speed * 0.6, y: e.wy * e.speed * 0.6 };
    }

    function pickup(rm, it) {
      rm.pickups.splice(rm.pickups.indexOf(it), 1);
      Engine.sfx("pickup");
      const p = g.p;
      if (it.kind === "heart") { p.health.heal(2); announce("Health restored"); }
      else if (it.kind === "coin") { g.coins++; g.score += 10; }
      else if (it.kind === "key") { g.keys++; announce(`Got the ${spec.keyName}!`); Engine.sfx("powerup"); }
      else if (it.kind === "item") {
        announce(`${it.item.name}!`);
        Engine.sfx("powerup");
        if (it.item.effect === "heal") p.health.heal(p.health.max);
        else if (it.item.effect === "power") g.power++;
        else if (it.item.effect === "speed") g.speedMul *= 1.15;
        else { p.health.max++; p.health.heal(2); }
      } else if (it.kind === "portal") {
        if (g.floor >= spec.floors) { g.mode = "won"; Engine.sfx("win"); Kit.music.stop(); } else { newFloor(g.floor + 1); Engine.sfx("powerup"); }
      }
      Engine.fx.burst(it.x, it.y, { count: 10, color: "#ffd36b", speed: 90, life: 0.4 });
    }

    function unlockNear(rm) {
      const p = g.p;
      const probe = { x: p.x - 6, y: p.y - 6, w: p.w + 12, h: p.h + 12 };
      for (const lock of rm.locks) {
        if (g.unlocked.has(lock.door) || !lock.cells.some(([x, y]) => overlap(probe, { x: x * ts, y: y * ts, w: ts, h: ts }))) continue;
        if (g.keys <= 0) { announce(`Locked. Find the ${spec.keyName}.`); continue; }
        g.keys--;
        g.unlocked.add(lock.door);
        for (const built of Object.values(g.rooms)) for (const l of built.locks) if (l.door === lock.door) l.cells.forEach(([x, y]) => Kit.tiles.set(built.map, x, y, 0));
        Engine.sfx("powerup");
        announce("Door unlocked!");
      }
    }

    function update(dt) {
      g.t += dt;
      if (g.mode === "title") { if (Engine.action()) begin(); return; }
      if (g.mode === "over" || g.mode === "won") { if (Engine.action()) { reset(); begin(); } return; }
      if (Kit.dialogue.active) { Kit.dialogue.update(dt, Engine.action()); return; }
      g.hintT = Math.max(0, g.hintT - dt);
      g.fade = Math.max(0, g.fade - dt);
      g.cool = Math.max(0, g.cool - dt);
      const p = g.p;
      const rm = g.room;
      p.health.update(dt);
      const m = Engine.move();
      Kit.topdown(p, m, dt, rm.map, { speed: ts * 4 * g.speedMul });
      if (Engine.action() && g.cool <= 0) {
        g.cool = spec.weapon === "sword" ? 0.32 : 0.4;
        Engine.sfx("shoot");
        const pc = center(p);
        if (spec.weapon === "sword") g.atk = { t: 0.16, hit: new Set(), dir: { ...p.facing } };
        else shootAt(pc, { x: pc.x + p.facing.x, y: pc.y + p.facing.y }, ts * 8, 1 + g.power, true, sk.accent);
      }
      if (g.atk) {
        g.atk.t -= dt;
        const d = g.atk.dir;
        const pc = center(p);
        const box = { x: pc.x + d.x * ts * 0.7 - ts * 0.45, y: pc.y + d.y * ts * 0.7 - ts * 0.45, w: ts * 0.9, h: ts * 0.9 };
        g.atk.box = box;
        for (const e of rm.enemies.slice()) if (!g.atk.hit.has(e) && overlap(box, e)) { g.atk.hit.add(e); damageEnemy(rm, e, 1 + g.power, pc.x, pc.y); }
        if (g.atk.t <= 0) g.atk = null;
      }
      for (const e of rm.enemies.slice()) updateEnemy(rm, e, dt);
      for (const b of g.proj.slice()) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        const dead = b.life <= 0 || Kit.tiles.solidAt(rm.map, b.x, b.y);
        const box = { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 };
        let used = dead;
        if (!used && b.friendly) for (const e of rm.enemies.slice()) if (overlap(box, e)) { damageEnemy(rm, e, b.dmg, b.x - b.vx, b.y - b.vy); used = true; break; }
        if (!used && !b.friendly && overlap(box, p)) { hurtPlayer(b.dmg, b.x - b.vx, b.y - b.vy); used = true; }
        if (used) g.proj.splice(g.proj.indexOf(b), 1);
      }
      for (const it of rm.pickups.slice()) if (Math.hypot(it.x - (p.x + p.w / 2), it.y - (p.y + p.h / 2)) < ts * 0.6) pickup(rm, it);
      unlockNear(rm);
      for (const [dir, edge] of [["left", p.x <= 1 && m.x < 0], ["right", p.x + p.w >= COLS * ts - 1 && m.x > 0], ["up", p.y <= 1 && m.y < 0], ["down", p.y + p.h >= ROWS * ts - 1 && m.y > 0]]) {
        if (edge && rm.gaps[dir]) { go(dir); break; }
      }
    }

    function drawEnemy(c, e) {
      c.fillStyle = e.flash > 0 ? "#fff" : e.color;
      c.fillRect(e.x, e.y + e.h * 0.15, e.w, e.h * 0.85);
      c.beginPath();
      c.arc(e.x + e.w / 2, e.y + e.h * 0.3, e.w / 2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = e.s === "wind" ? "#ffeb3b" : "#fff";
      c.fillRect(e.x + e.w * 0.25, e.y + e.h * 0.25, e.w * 0.18, e.h * 0.18);
      c.fillRect(e.x + e.w * 0.58, e.y + e.h * 0.25, e.w * 0.18, e.h * 0.18);
      if (e.boss) Engine.ui.bar(c, e.x - 6, e.y - 12, e.w + 12, 6, e.hp / e.max, sk.danger);
    }

    function draw(c) {
      if (g.mode === "title") { titleScreen(c, spec, sk, g.t, ["Arrows / WASD: move", "Space / J: attack", `Find the ${spec.keyName}, open the locked door, defeat the ${spec.boss.name}`]); return; }
      c.fillStyle = sk.bg;
      c.fillRect(0, 0, W, H);
      const rm = g.room;
      c.save();
      c.translate(ox, oy);
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const v = Kit.tiles.get(rm.map, x, y);
          c.fillStyle = v === 2 ? "#d4a017" : v === 1 ? sk.wall : (x + y) % 2 ? sk.floor : Kit.shade(sk.floor, 0.03);
          c.fillRect(x * ts, y * ts, ts, ts);
          if (v === 1) { c.fillStyle = Kit.shade(sk.wall, 0.12); c.fillRect(x * ts, y * ts, ts, 4); }
        }
      }
      for (const it of rm.pickups) {
        const bob = Math.sin(g.t * 4 + it.x) * 2;
        if (it.kind === "heart") heart(c, it.x - 8, it.y - 8 + bob, 16, "#ff4d6d");
        else if (it.kind === "coin") { c.fillStyle = "#ffd700"; c.beginPath(); c.arc(it.x, it.y + bob, 6, 0, Math.PI * 2); c.fill(); }
        else if (it.kind === "key") { c.fillStyle = "#ffd700"; c.beginPath(); c.arc(it.x - 4, it.y + bob, 7, 0, Math.PI * 2); c.fill(); c.fillRect(it.x, it.y - 2 + bob, 12, 4); }
        else if (it.kind === "portal") { c.strokeStyle = sk.accent; c.lineWidth = 4; c.beginPath(); c.arc(it.x, it.y, 14 + Math.sin(g.t * 5) * 3, 0, Math.PI * 2); c.stroke(); }
        else { c.fillStyle = it.item.color; c.fillRect(it.x - 8, it.y - 8 + bob, 16, 16); c.strokeStyle = "#fff"; c.strokeRect(it.x - 8, it.y - 8 + bob, 16, 16); }
      }
      rm.enemies.forEach((e) => drawEnemy(c, e));
      const p = g.p;
      if (!p.health.blinking()) {
        c.fillStyle = sk.accent;
        c.fillRect(p.x, p.y + p.h * 0.3, p.w, p.h * 0.7);
        c.fillStyle = "#f2d6b3";
        c.beginPath();
        c.arc(p.x + p.w / 2, p.y + p.h * 0.28, p.w * 0.38, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#222";
        c.fillRect(p.x + p.w * 0.5 + p.facing.x * 4 - 2, p.y + p.h * 0.25 + p.facing.y * 3, 4, 4);
      }
      if (g.atk && g.atk.box) { c.fillStyle = "rgba(255,255,255,0.75)"; c.fillRect(g.atk.box.x, g.atk.box.y, g.atk.box.w, g.atk.box.h); }
      for (const b of g.proj) { c.fillStyle = b.color; c.beginPath(); c.arc(b.x, b.y, b.r, 0, Math.PI * 2); c.fill(); }
      Engine.fx.draw(c);
      c.restore();
      c.fillStyle = sk.floor;
      c.fillRect(0, 0, W, 40);
      for (let i = 0; i < p.health.max; i++) heart(c, 10 + i * 22, 10, 18, i < p.health.hp ? "#ff4d6d" : "#3a2a30");
      Engine.ui.text(c, `${spec.keyName}s ${g.keys}   Coins ${g.coins}   Score ${g.score}   Floor ${g.floor}/${spec.floors}`, W - 12, 26, { size: 14, align: "right", color: sk.text });
      for (const id of g.visited) { const xy = g.d.roomXY(id); c.fillStyle = id === g.room.id ? sk.accent : sk.light; c.fillRect(W / 2 - 30 + xy.x * 9, 8 + xy.y * 7, 7, 5); }
      if (g.hintT > 0) Engine.ui.text(c, g.hint, W / 2, H - 14, { size: 16, align: "center", color: sk.accent });
      if (g.fade > 0) { c.fillStyle = `rgba(0,0,0,${g.fade * 3})`; c.fillRect(0, 0, W, H); }
      Kit.dialogue.draw(c, W, H, spec.hero);
      if (g.mode === "over") Engine.ui.banner(c, "You have fallen", `Score ${g.score}. Press SPACE to try again`);
      if (g.mode === "won") Engine.ui.banner(c, "Victory!", `${spec.title} complete. Score ${g.score}. Press SPACE to play again`);
    }

    debug = { state: () => g, room, enterRoom, hurtPlayer };
    reset();
    Engine.start({ reset, update, draw });
  }

  // --------------------------------------------------------------- platformer
  function platformer(raw) {
    const spec = common({}, raw, "Sky Runner");
    spec.levels = Math.round(num(raw.levels, 1, 6, 3));
    spec.lives = Math.round(num(raw.lives || raw.hearts, 2, 6, 3));
    spec.doubleJump = /double/i.test(JSON.stringify(raw.abilities || "")) || raw.doubleJump === true;
    spec.collectible = str(raw.collectible, "Coin", 16);
    const kinds = ["walker", "flyer", "jumper"];
    spec.enemies = list(raw.enemies, 4).map((e, i) => ({ name: str(e.name, `Critter ${i + 1}`, 18), color: hex(e.color, FOE_COLORS[i % 6]), kind: pick(e.behavior || e.kind, kinds, kinds[i % 3]) }));
    if (!spec.enemies.length) spec.enemies = kinds.map((k, i) => ({ name: `Critter ${i + 1}`, color: FOE_COLORS[i], kind: k }));
    const sk = skin({ theme: raw.theme || "forest", accent: raw.accent });
    const TS = 32;
    const rows = Math.floor(H / TS);
    const GR = rows - 3;
    let g;

    function reset() {
      g = { mode: "title", t: 0, level: 0, score: 0, coins: 0, cam: 0, jumps: 0 };
      g.p = { x: 0, y: 0, w: 22, h: 28, vx: 0, vy: 0, onGround: false, face: 1, health: Kit.health(spec.lives, { invuln: 1.2 }) };
      Kit.music.stop();
    }

    function build(n) {
      const r = Engine.rng(spec.seed + n * 541);
      const width = 70 + n * 16;
      const map = Kit.tiles.make(width, rows + 6, TS, (v) => v === 1, 0);
      const level = { map, width, enemies: [], coins: [], cps: [], flag: { x: (width - 4) * TS, y: (GR - 3) * TS } };
      const ground = (x0, x1, top = GR) => { for (let x = x0; x < x1 && x < width; x++) for (let y = top; y < rows + 6; y++) Kit.tiles.set(map, x, y, 1); };
      const coinLine = (x0, count, y) => { for (let i = 0; i < count; i++) level.coins.push({ x: (x0 + i) * TS + TS / 2, y, got: false }); };
      const foe = (x, y, k) => { const kind = spec.enemies.find((e) => e.kind === k) || r.pick(spec.enemies); level.enemies.push({ x, y, w: 24, h: 24, vx: -40, vy: 0, kind: k, color: kind.color, name: kind.name, base: y, t: r.next() * 6, alive: true, hopT: 1 }); };
      ground(0, 9);
      let x = 9;
      let lastCp = 0;
      while (x < width - 12) {
        const pickKind = r.int(0, 5);
        if (pickKind === 0 || pickKind === 5) {
          const len = r.int(5, 9);
          ground(x, x + len);
          if (len >= 6 && x - lastCp > 22) { level.cps.push({ x: (x + 1) * TS, y: (GR - 1) * TS - 30 }); lastCp = x; }
          if (n > 1 || r.chance(0.6)) foe((x + (len >> 1)) * TS, (GR - 1) * TS - 24, pickKind === 5 ? "flyer" : "walker");
          coinLine(x + 1, 3, (GR - 1) * TS - 20);
          x += len;
        } else if (pickKind === 1) {
          const gap = r.int(2, n > 2 ? 3 : 2);
          coinLine(x, gap, (GR - 3) * TS);
          x += gap;
          ground(x, x + 4);
          x += 4;
        } else if (pickKind === 2) {
          const steps = [[1, 2], [2, r.int(2, 3)], [1, 2]];
          for (const [raise, w] of steps) { ground(x, x + w, GR - raise); coinLine(x, w, (GR - raise - 1) * TS - 6); x += w; }
          ground(x, x + 3);
          x += 3;
        } else if (pickKind === 3) {
          const len = r.int(3, 5);
          ground(x, x + len + 2);
          for (let i = 0; i < len; i++) Kit.tiles.set(map, x + 1 + i, GR - 2, 1);
          coinLine(x + 1, len, (GR - 3) * TS - 8);
          if (r.chance(0.5)) foe((x + 2) * TS, (GR - 3) * TS - 24, "walker");
          x += len + 2;
        } else {
          const len = 6;
          ground(x, x + len);
          for (let i = 0; i < r.int(1, 2); i++) Kit.tiles.set(map, x + 2 + i, GR - 1, 3);
          if (n > 2) foe((x + 5) * TS, (GR - 1) * TS - 24, "jumper");
          x += len;
        }
      }
      ground(x, width);
      level.cps.unshift({ x: 2 * TS, y: (GR - 1) * TS - 30 });
      level.spawn = level.cps[0];
      return level;
    }

    function begin() {
      g.mode = "play";
      loadLevel(1);
      startMusic(spec, "major");
      if (spec.intro.length) Kit.dialogue.open(spec.intro, () => {});
    }

    function loadLevel(n) {
      g.level = n;
      g.lv = build(n);
      g.cp = g.lv.spawn;
      g.p.x = g.cp.x;
      g.p.y = g.cp.y;
      g.p.vx = 0;
      g.p.vy = 0;
      g.fade = 1;
    }

    function respawn() { g.p.x = g.cp.x; g.p.y = g.cp.y; g.p.vx = 0; g.p.vy = 0; }

    function hurt(fromX) {
      const p = g.p;
      if (!p.health.hurt(1)) return;
      Engine.sfx("hit");
      Engine.fx.shake(5, 0.2);
      p.vx = p.x < fromX ? -220 : 220;
      p.vy = -240;
      if (!p.health.alive()) { g.mode = "over"; Engine.sfx("lose"); Kit.music.stop(); }
    }

    function update(dt) {
      g.t += dt;
      if (g.mode === "title") { if (Engine.action()) begin(); return; }
      if (g.mode === "over" || g.mode === "won") { if (Engine.action()) { reset(); begin(); } return; }
      if (Kit.dialogue.active) { Kit.dialogue.update(dt, Engine.action()); return; }
      g.fade = Math.max(0, (g.fade || 0) - dt);
      const p = g.p;
      const lv = g.lv;
      p.health.update(dt);
      const x = Engine.input.axis(["arrowleft", "a"], ["arrowright", "d"]);
      const press = Engine.input.pressed("space", "arrowup", "w", "z", "j");
      const held = Engine.input.held("space", "arrowup", "w", "z", "j");
      if (x) p.face = x;
      const wasGround = p.onGround;
      const res = Kit.platformer(p, { x, jumpPressed: press, jumpHeld: held }, dt, lv.map, { speed: 185, jump: 540, gravity: 1500 });
      if (p.onGround) g.jumps = 0;
      if (res.jumped) { Engine.sfx("jump"); g.jumps = 1; }
      else if (press && spec.doubleJump && !p.onGround && !wasGround && g.jumps === 1 && p.coyote <= 0) { p.vy = -470; g.jumps = 2; Engine.sfx("jump"); Engine.fx.burst(p.x + 11, p.y + 28, { count: 8, color: sk.light, speed: 60, life: 0.3 }); }
      if (res.landed) Engine.fx.burst(p.x + 11, p.y + 28, { count: 4, color: sk.light, speed: 40, life: 0.2 });
      const pc = Math.floor((p.x + p.w / 2) / TS);
      for (const cp of lv.cps) if (cp.x / TS <= pc && cp.x > g.cp.x) { g.cp = cp; Engine.fx.text(p.x, p.y - 10, "Checkpoint", sk.accent); }
      if (p.y > rows * TS + 60) { hurt(p.x); if (g.mode === "play") respawn(); }
      const body = { x: p.x, y: p.y, w: p.w, h: p.h };
      const core = { x: body.x + 5, y: body.y + 10, w: body.w - 10, h: body.h - 10 };
      for (let ty = Math.floor(core.y / TS); ty <= Math.floor((core.y + core.h - 1) / TS); ty++) for (let tx = Math.floor(core.x / TS); tx <= Math.floor((core.x + core.w - 1) / TS); tx++) if (Kit.tiles.get(lv.map, tx, ty) === 3) hurt(tx * TS);
      for (const co of lv.coins) if (!co.got && Math.hypot(co.x - (p.x + 11), co.y - (p.y + 14)) < 20) { co.got = true; g.coins++; g.score += 10; Engine.sfx("pickup"); if (g.coins % 25 === 0) { p.health.max++; p.health.heal(1); Engine.fx.text(p.x, p.y - 12, "Extra heart!", "#ff6b81"); } }
      for (const e of lv.enemies) {
        if (!e.alive) continue;
        e.t += dt;
        if (e.kind === "flyer") { e.x += e.vx * dt; e.y = e.base + Math.sin(e.t * 3) * 22; if (Math.floor(e.t / 2.5) % 2) e.vx = Math.abs(e.vx); else e.vx = -Math.abs(e.vx); }
        else {
          e.vy += 900 * dt;
          if (e.kind === "jumper") { e.hopT -= dt; if (e.hopT <= 0 && e.vy === 0) { e.vy = -330; e.vx = p.x < e.x ? -70 : 70; e.hopT = 1.3; } }
          const hit = Kit.tiles.move(lv.map, e, e.vx * dt, e.vy * dt);
          if (hit.y) e.vy = 0;
          const ahead = e.x + (e.vx > 0 ? e.w + 2 : -2);
          if (e.kind === "walker" && (hit.x || (hit.y > 0 && !Kit.tiles.solidAt(lv.map, ahead, e.y + e.h + 4)))) e.vx = -e.vx;
          if (e.y > rows * TS + 80) e.alive = false;
        }
        if (!overlap(body, e)) continue;
        if (p.vy > 60 && p.y + p.h - 8 < e.y + e.h / 2) {
          e.alive = false;
          p.vy = held ? -420 : -300;
          g.score += 50;
          Engine.sfx("hit");
          Engine.fx.burst(e.x + 12, e.y + 12, { count: 12, color: e.color, speed: 120, life: 0.4 });
        } else hurt(e.x);
      }
      g.cam = Engine.clamp(p.x + p.w / 2 - W / 2, 0, lv.width * TS - W);
      if (p.x + p.w > lv.flag.x) {
        g.score += 200;
        Engine.sfx("win");
        if (g.level >= spec.levels) { g.mode = "won"; Kit.music.stop(); } else { loadLevel(g.level + 1); Engine.fx.text(W / 2, 80, `Level ${g.level}`, sk.accent); }
      }
    }

    function draw(c) {
      if (g.mode === "title") { titleScreen(c, spec, sk, g.t, ["Arrows / A D: run", "Space / W / Up: jump (hold to jump higher)" + (spec.doubleJump ? ", press again to double jump" : ""), "Stomp enemies from above. Reach the flag."]); return; }
      const sky = c.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, Kit.shade(sk.bg, 0.05));
      sky.addColorStop(1, sk.floor);
      c.fillStyle = sky;
      c.fillRect(0, 0, W, H);
      for (let layer = 1; layer <= 2; layer++) {
        c.fillStyle = Kit.shade(sk.wall, -0.25 + layer * 0.08);
        for (let x = -40; x < W + 40; x += 20) {
          const wx = x + g.cam * (0.15 * layer);
          const hgt = 40 + layer * 25 + Math.sin(Math.floor(wx / 20) * 0.7 + layer) * 28;
          c.fillRect(x - ((g.cam * 0.15 * layer) % 20), H - 90 - hgt + layer * 20, 20, hgt + 100);
        }
      }
      const lv = g.lv;
      c.save();
      c.translate(-Math.floor(g.cam), 0);
      const x0 = Math.max(0, Math.floor(g.cam / TS));
      const x1 = Math.min(lv.width - 1, Math.floor((g.cam + W) / TS));
      for (let y = 0; y < rows; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = Kit.tiles.get(lv.map, x, y);
          if (v === 1) {
            c.fillStyle = sk.wall;
            c.fillRect(x * TS, y * TS, TS, TS);
            if (Kit.tiles.get(lv.map, x, y - 1) !== 1) { c.fillStyle = sk.accent; c.fillRect(x * TS, y * TS, TS, 6); }
            else { c.fillStyle = Kit.shade(sk.wall, -0.08); c.fillRect(x * TS + 2, y * TS + 2, TS - 4, TS - 4); }
          } else if (v === 3) {
            c.fillStyle = "#e8e8e8";
            c.beginPath();
            c.moveTo(x * TS, (y + 1) * TS);
            c.lineTo(x * TS + TS / 2, y * TS + 4);
            c.lineTo((x + 1) * TS, (y + 1) * TS);
            c.fill();
          }
        }
      }
      for (const co of lv.coins) if (!co.got && co.x > g.cam - 20 && co.x < g.cam + W + 20) { c.fillStyle = "#ffd700"; c.beginPath(); c.ellipse(co.x, co.y, 3 + Math.abs(Math.cos(g.t * 4 + co.x)) * 5, 8, 0, 0, Math.PI * 2); c.fill(); }
      c.fillStyle = "#ccc";
      c.fillRect(lv.flag.x, lv.flag.y, 4, TS * 3);
      c.fillStyle = sk.accent;
      c.beginPath();
      c.moveTo(lv.flag.x + 4, lv.flag.y);
      c.lineTo(lv.flag.x + 38, lv.flag.y + 14);
      c.lineTo(lv.flag.x + 4, lv.flag.y + 28);
      c.fill();
      for (const cp of lv.cps) { c.fillStyle = cp.x <= g.cp.x ? sk.accent : sk.light; c.fillRect(cp.x, cp.y + 14, 3, 16); }
      for (const e of lv.enemies) {
        if (!e.alive) continue;
        c.fillStyle = e.color;
        c.fillRect(e.x, e.y + 4, e.w, e.h - 4);
        c.beginPath();
        c.arc(e.x + 12, e.y + 8, 12, Math.PI, 0);
        c.fill();
        c.fillStyle = "#fff";
        c.fillRect(e.x + 5, e.y + 8, 5, 5);
        c.fillRect(e.x + 14, e.y + 8, 5, 5);
      }
      const p = g.p;
      if (!p.health.blinking()) {
        c.fillStyle = sk.accent;
        c.fillRect(p.x, p.y + 8, p.w, p.h - 8);
        c.fillStyle = "#f2d6b3";
        c.fillRect(p.x + 2, p.y, p.w - 4, 12);
        c.fillStyle = "#222";
        c.fillRect(p.x + (p.face > 0 ? 13 : 5), p.y + 4, 4, 4);
      }
      Engine.fx.draw(c);
      c.restore();
      for (let i = 0; i < p.health.max; i++) heart(c, 10 + i * 22, 10, 18, i < p.health.hp ? "#ff4d6d" : "#3a2a30");
      Engine.ui.text(c, `${spec.collectible}s ${g.coins}   Score ${g.score}   Level ${g.level}/${spec.levels}`, W - 12, 26, { size: 14, align: "right", color: sk.text });
      Kit.dialogue.draw(c, W, H, spec.hero);
      if (g.fade > 0) { c.fillStyle = `rgba(0,0,0,${g.fade})`; c.fillRect(0, 0, W, H); }
      if (g.mode === "over") Engine.ui.banner(c, "Game over", `Score ${g.score}. Press SPACE to try again`);
      if (g.mode === "won") Engine.ui.banner(c, "You made it!", `${spec.title} complete. Score ${g.score}. Press SPACE to play again`);
    }

    debug = { state: () => g };
    reset();
    Engine.start({ reset, update, draw });
  }

  // -------------------------------------------------------------------- arena
  const ARENA_KINDS = ["drifter", "zigzag", "charger", "shooter", "splitter"];
  function arena(raw) {
    const spec = common({}, raw, "Last Stand");
    spec.waves = Math.round(num(raw.waves, 3, 20, 10));
    spec.weapon = pick(raw.weapon, ["blaster", "spread", "nova"], "blaster");
    spec.enemies = list(raw.enemies, 5).map((e, i) => ({ name: str(e.name, `Swarm ${i + 1}`, 18), color: hex(e.color, FOE_COLORS[i % 6]), kind: pick(e.behavior || e.kind, ARENA_KINDS, ARENA_KINDS[i % 5]) }));
    if (!spec.enemies.length) spec.enemies = ARENA_KINDS.map((k, i) => ({ name: `Swarm ${i + 1}`, color: FOE_COLORS[i], kind: k }));
    const boss = raw.boss && typeof raw.boss === "object" ? raw.boss : {};
    spec.boss = { name: str(boss.name, "Overlord", 24), color: hex(boss.color, "#b03060") };
    const sk = skin({ theme: raw.theme || "neon", accent: raw.accent });
    const UPGRADES = [
      { name: "Rapid Fire", desc: "+25% fire rate", apply: (p) => { p.rate *= 0.78; } },
      { name: "Heavy Rounds", desc: "+1 damage", apply: (p) => { p.dmg++; } },
      { name: "Multishot", desc: "+1 projectile", apply: (p) => { p.shots = Math.min(6, p.shots + 1); } },
      { name: "Piercing", desc: "Shots pass through +1 enemy", apply: (p) => { p.pierce++; } },
      { name: "Swift Boots", desc: "+15% move speed", apply: (p) => { p.speed *= 1.15; } },
      { name: "Vitality", desc: "+2 max HP and heal", apply: (p) => { p.max += 2; p.hp = Math.min(p.max, p.hp + 2); } },
      { name: "Magnet", desc: "Pull gems from farther", apply: (p) => { p.magnet += 60; } },
      { name: "Nova", desc: "Burst of shots every few seconds", apply: (p) => { p.nova = (p.nova || 0) + 1; } },
      { name: "Aegis", desc: "Absorb a hit every 8s", apply: (p) => { p.aegis = true; } },
    ];
    const rng = Engine.rng(spec.seed + 7);
    let g;

    function reset() {
      g = { mode: "title", t: 0, wave: 0, score: 0, kills: 0, enemies: [], bullets: [], ebullets: [], gems: [], spawnLeft: 0, spawnT: 0, breakT: 1.5, choosing: null, choice: 0, novaT: 4, aegisT: 0, shield: false, bossWave: false };
      g.p = { x: W / 2, y: H / 2, r: 11, hp: 6, max: 6, speed: 200, rate: spec.weapon === "spread" ? 0.4 : 0.3, dmg: 1, shots: spec.weapon === "spread" ? 3 : 1, pierce: 0, magnet: 70, xp: 0, lvl: 1, need: 5, cd: 0, inv: 0, nova: spec.weapon === "nova" ? 1 : 0, aegis: false };
      Kit.music.stop();
    }

    function begin() {
      g.mode = "play";
      startMusic(spec, "dorian");
      if (spec.intro.length) Kit.dialogue.open(spec.intro, () => {});
    }

    function spawnEdge() {
      const side = rng.int(0, 3);
      return side === 0 ? { x: -20, y: rng.range(0, H) } : side === 1 ? { x: W + 20, y: rng.range(0, H) } : side === 2 ? { x: rng.range(0, W), y: -20 } : { x: rng.range(0, W), y: H + 20 };
    }

    function makeEnemy(def, boss, at) {
      const scale = 1 + g.wave * 0.14;
      const base = { drifter: [2, 55, 11], zigzag: [2, 80, 10], charger: [3, 70, 12], shooter: [3, 50, 11], splitter: [4, 55, 15] }[boss ? "drifter" : def.kind];
      const hp = boss ? Math.round(40 * (1 + g.wave * 0.12)) : Math.max(1, Math.round(base[0] * scale));
      return { x: at.x, y: at.y, r: boss ? 34 : base[2], hp, max: hp, speed: boss ? 45 : base[1] * (1 + g.wave * 0.02), kind: boss ? "boss" : def.kind, color: boss ? spec.boss.color : def.color, name: boss ? spec.boss.name : def.name, t: rng.next() * 6, flash: 0, s: "idle", shoot: 1.5, lock: { x: 0, y: 0 }, small: false };
    }

    function nextWave() {
      g.wave++;
      g.bossWave = g.wave % 5 === 0 || g.wave === spec.waves;
      g.spawnLeft = g.bossWave ? 6 + g.wave : 7 + g.wave * 3;
      g.spawnT = 0;
      Engine.fx.text(W / 2, H / 2, g.bossWave ? `BOSS: ${spec.boss.name}` : `Wave ${g.wave}`, sk.accent);
      Engine.sfx(g.bossWave ? "explode" : "blip");
      if (g.bossWave) g.enemies.push(makeEnemy(null, true, { x: W / 2, y: -40 }));
    }

    function hurtPlayer(n) {
      const p = g.p;
      if (p.inv > 0) return;
      if (g.shield) { g.shield = false; p.inv = 0.6; Engine.fx.burst(p.x, p.y, { count: 16, color: "#7fdbff", speed: 140, life: 0.4 }); Engine.sfx("blip"); return; }
      p.hp -= n;
      p.inv = 1;
      Engine.sfx("hit");
      Engine.fx.shake(6, 0.2);
      Engine.fx.burst(p.x, p.y, { count: 16, color: sk.danger, speed: 140, life: 0.4 });
      if (p.hp <= 0) { g.mode = "over"; Engine.sfx("lose"); Kit.music.stop(); }
    }

    function killEnemy(e) {
      g.enemies.splice(g.enemies.indexOf(e), 1);
      g.kills++;
      g.score += e.kind === "boss" ? 500 : 10 * g.wave;
      Engine.sfx("explode");
      Engine.fx.burst(e.x, e.y, { count: e.kind === "boss" ? 50 : 14, color: e.color, speed: 160, life: 0.6 });
      for (let i = 0; i < (e.kind === "boss" ? 12 : 1); i++) g.gems.push({ x: e.x + rng.range(-12, 12), y: e.y + rng.range(-12, 12), v: e.kind === "boss" ? 3 : 1 });
      if (e.kind === "splitter" && !e.small) for (let i = 0; i < 2; i++) { const s = makeEnemy({ kind: "drifter", color: e.color, name: e.name }, false, { x: e.x + (i ? 12 : -12), y: e.y }); s.r = 8; s.hp = s.max = 1; s.small = true; g.enemies.push(s); }
    }

    function fire(from, a, dmg) {
      g.bullets.push({ x: from.x, y: from.y, vx: Math.cos(a) * 520, vy: Math.sin(a) * 520, dmg, left: g.p.pierce, hit: new Set(), life: 1.2 });
    }

    function openChoices() {
      const pool = UPGRADES.slice();
      g.choosing = [];
      for (let i = 0; i < 3; i++) g.choosing.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
      g.choice = 0;
      Engine.sfx("powerup");
    }

    function choose(i) {
      g.choosing[i].apply(g.p);
      Engine.fx.text(g.p.x, g.p.y - 20, g.choosing[i].name, sk.accent);
      g.choosing = null;
    }

    function update(dt) {
      g.t += dt;
      if (g.mode === "title") { if (Engine.action()) begin(); return; }
      if (g.mode === "over" || g.mode === "won") { if (Engine.action()) { reset(); begin(); } return; }
      if (Kit.dialogue.active) { Kit.dialogue.update(dt, Engine.action()); return; }
      if (g.choosing) {
        if (Engine.input.pressed("arrowleft", "a")) g.choice = (g.choice + 2) % 3;
        if (Engine.input.pressed("arrowright", "d")) g.choice = (g.choice + 1) % 3;
        for (let i = 0; i < 3; i++) if (Engine.input.pressed(String(i + 1))) choose(i);
        if (g.choosing && Engine.action()) choose(g.choice);
        if (g.choosing && Engine.input.pointer.pressed) { const i = Math.floor(Engine.input.pointer.x / (W / 3)); if (i >= 0 && i < 3) choose(i); }
        return;
      }
      const p = g.p;
      p.inv = Math.max(0, p.inv - dt);
      const m = Engine.move();
      const len = Math.hypot(m.x, m.y) || 1;
      p.x = Engine.clamp(p.x + (m.x / Math.max(1, len)) * p.speed * dt, p.r, W - p.r);
      p.y = Engine.clamp(p.y + (m.y / Math.max(1, len)) * p.speed * dt, p.r, H - p.r);
      if (p.aegis && !g.shield) { g.aegisT += dt; if (g.aegisT >= 8) { g.shield = true; g.aegisT = 0; } }
      if (g.spawnLeft > 0) {
        g.spawnT -= dt;
        if (g.spawnT <= 0) {
          g.spawnT = Math.max(0.25, 0.8 - g.wave * 0.03);
          const maxKind = Math.min(spec.enemies.length - 1, Math.floor(g.wave / 2));
          g.enemies.push(makeEnemy(spec.enemies[rng.int(0, maxKind)], false, spawnEdge()));
          g.spawnLeft--;
        }
      } else if (!g.enemies.length) {
        g.breakT -= dt;
        if (g.breakT <= 0) {
          if (g.wave >= spec.waves) { g.mode = "won"; Engine.sfx("win"); Kit.music.stop(); return; }
          g.breakT = 1.5;
          nextWave();
        }
      }
      let target = null;
      let best = 1e9;
      for (const e of g.enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < best) { best = d; target = e; } }
      p.cd -= dt;
      if (target && p.cd <= 0) {
        p.cd = p.rate;
        const aim = Engine.input.pointer.down ? Math.atan2(Engine.input.pointer.y - p.y, Engine.input.pointer.x - p.x) : Math.atan2(target.y - p.y, target.x - p.x);
        for (let i = 0; i < p.shots; i++) fire(p, aim + (i - (p.shots - 1) / 2) * 0.16, p.dmg);
        Engine.sfx("shoot");
      }
      if (p.nova) { g.novaT -= dt; if (g.novaT <= 0) { g.novaT = 4.5 - Math.min(2, p.nova * 0.5); const n = 8 + p.nova * 4; for (let i = 0; i < n; i++) fire(p, (i / n) * Math.PI * 2, p.dmg); Engine.fx.burst(p.x, p.y, { count: 20, color: sk.accent, speed: 200, life: 0.4 }); } }
      for (const b of g.bullets.slice()) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        let dead = b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20;
        if (!dead) for (const e of g.enemies.slice()) {
          if (b.hit.has(e) || Math.hypot(e.x - b.x, e.y - b.y) > e.r + 4) continue;
          b.hit.add(e);
          e.hp -= b.dmg;
          e.flash = 0.1;
          Engine.fx.burst(b.x, b.y, { count: 3, color: e.color, speed: 70, life: 0.2 });
          if (e.hp <= 0) killEnemy(e);
          if (b.left-- <= 0) { dead = true; break; }
        }
        if (dead) g.bullets.splice(g.bullets.indexOf(b), 1);
      }
      for (const e of g.enemies.slice()) {
        e.t += dt;
        e.flash = Math.max(0, e.flash - dt);
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        let vx = Math.cos(a) * e.speed;
        let vy = Math.sin(a) * e.speed;
        if (e.kind === "zigzag") { const w = Math.sin(e.t * 5) * e.speed; vx += Math.cos(a + Math.PI / 2) * w; vy += Math.sin(a + Math.PI / 2) * w; }
        else if (e.kind === "charger") {
          if (e.s === "idle" && e.t > 1.6) { e.s = "wind"; e.t = 0; e.lock = { x: Math.cos(a), y: Math.sin(a) }; }
          if (e.s === "wind") { vx = vy = 0; if (e.t > 0.5) { e.s = "dash"; e.t = 0; } }
          else if (e.s === "dash") { vx = e.lock.x * e.speed * 5; vy = e.lock.y * e.speed * 5; if (e.t > 0.5) { e.s = "idle"; e.t = 0; } }
        } else if (e.kind === "shooter") {
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (d < 190) { vx = -vx; vy = -vy; } else if (d < 260) { vx = vy = 0; }
          e.shoot -= dt;
          if (e.shoot <= 0) { e.shoot = 1.8; g.ebullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 190, vy: Math.sin(a) * 190, life: 4 }); }
        } else if (e.kind === "boss") {
          e.shoot -= dt;
          if (e.shoot <= 0) {
            e.shoot = e.hp < e.max / 2 ? 1.3 : 2;
            const n = e.hp < e.max / 2 ? 18 : 12;
            for (let i = 0; i < n; i++) g.ebullets.push({ x: e.x, y: e.y, vx: Math.cos((i / n) * Math.PI * 2 + e.t) * 150, vy: Math.sin((i / n) * Math.PI * 2 + e.t) * 150, life: 5 });
            Engine.sfx("shoot");
          }
        }
        e.x += vx * dt;
        e.y += vy * dt;
        if (Math.hypot(p.x - e.x, p.y - e.y) < p.r + e.r) hurtPlayer(e.kind === "boss" ? 2 : 1);
      }
      for (const b of g.ebullets.slice()) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (Math.hypot(p.x - b.x, p.y - b.y) < p.r + 4) { hurtPlayer(1); b.life = 0; }
        if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) g.ebullets.splice(g.ebullets.indexOf(b), 1);
      }
      for (const gem of g.gems.slice()) {
        const d = Math.hypot(p.x - gem.x, p.y - gem.y);
        if (d < p.magnet) { gem.x += ((p.x - gem.x) / (d || 1)) * 260 * dt; gem.y += ((p.y - gem.y) / (d || 1)) * 260 * dt; }
        if (d < p.r + 6) {
          g.gems.splice(g.gems.indexOf(gem), 1);
          p.xp += gem.v;
          Engine.sfx("pickup");
          if (p.xp >= p.need) { p.xp -= p.need; p.lvl++; p.need += 3; openChoices(); }
        }
      }
    }

    function draw(c) {
      if (g.mode === "title") { titleScreen(c, spec, sk, g.t, ["Arrows / WASD: move. You fire automatically at the nearest foe", "Collect gems, level up, pick upgrades (1/2/3, arrows + Space, or click)", `Survive ${spec.waves} waves and defeat ${spec.boss.name}`]); return; }
      c.fillStyle = sk.bg;
      c.fillRect(0, 0, W, H);
      c.strokeStyle = Kit.shade(sk.bg, 0.07);
      c.lineWidth = 1;
      for (let x = 0; x < W; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = 0; y < H; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
      for (const gem of g.gems) { c.fillStyle = sk.accent; c.fillRect(gem.x - 3, gem.y - 3 + Math.sin(g.t * 6 + gem.x) * 1.5, 6, 6); }
      for (const e of g.enemies) {
        c.fillStyle = e.flash > 0 ? "#fff" : e.color;
        c.beginPath();
        c.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = e.s === "wind" ? "#ffeb3b" : "#111";
        c.fillRect(e.x - e.r * 0.45, e.y - e.r * 0.2, e.r * 0.3, e.r * 0.3);
        c.fillRect(e.x + e.r * 0.15, e.y - e.r * 0.2, e.r * 0.3, e.r * 0.3);
        if (e.kind === "boss") Engine.ui.bar(c, e.x - 40, e.y - e.r - 14, 80, 6, e.hp / e.max, sk.danger);
      }
      c.fillStyle = "#ff9f43";
      for (const b of g.ebullets) { c.beginPath(); c.arc(b.x, b.y, 4, 0, Math.PI * 2); c.fill(); }
      c.fillStyle = sk.light;
      for (const b of g.bullets) c.fillRect(b.x - 3, b.y - 3, 6, 6);
      const p = g.p;
      if (p.inv <= 0 || Math.floor(p.inv * 20) % 2) {
        c.fillStyle = sk.accent;
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = sk.bg;
        c.fillRect(p.x - 4, p.y - 3, 3, 3);
        c.fillRect(p.x + 2, p.y - 3, 3, 3);
        if (g.shield) { c.strokeStyle = "#7fdbff"; c.lineWidth = 2; c.beginPath(); c.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2); c.stroke(); }
      }
      Engine.fx.draw(c);
      Engine.ui.bar(c, 10, 10, 160, 12, p.hp / p.max, sk.danger);
      Engine.ui.bar(c, 10, 26, 160, 8, p.xp / p.need, sk.accent);
      Engine.ui.text(c, `Lv ${p.lvl}   Wave ${Math.min(g.wave, spec.waves)}/${spec.waves}   Score ${g.score}`, W - 12, 22, { size: 14, align: "right", color: sk.text });
      Kit.dialogue.draw(c, W, H, spec.hero);
      if (g.choosing) {
        c.fillStyle = "rgba(0,0,0,0.75)";
        c.fillRect(0, 0, W, H);
        Engine.ui.text(c, "Level up! Choose an upgrade", W / 2, 70, { size: 24, align: "center", color: sk.accent });
        g.choosing.forEach((u, i) => {
          const x = 40 + i * ((W - 80) / 3);
          const w = (W - 80) / 3 - 16;
          c.fillStyle = i === g.choice ? Kit.shade(sk.wall, 0.1) : sk.floor;
          c.fillRect(x, 120, w, 200);
          c.strokeStyle = i === g.choice ? sk.accent : sk.light;
          c.lineWidth = 3;
          c.strokeRect(x, 120, w, 200);
          Engine.ui.text(c, `${i + 1}. ${u.name}`, x + w / 2, 170, { size: 18, align: "center", color: sk.text });
          Engine.ui.text(c, u.desc, x + w / 2, 210, { size: 13, align: "center", color: sk.light, bold: false });
        });
      }
      if (g.mode === "over") Engine.ui.banner(c, "Overrun", `Wave ${g.wave}, score ${g.score}. Press SPACE to try again`);
      if (g.mode === "won") Engine.ui.banner(c, "Victory!", `${spec.title} complete. Score ${g.score}. Press SPACE to play again`);
    }

    debug = { state: () => g };
    reset();
    Engine.start({ reset, update, draw });
  }

  const builders = { adventure, platformer, arena };
  return { types: Object.keys(builders), get debug() { return debug; }, run(spec) { const build = builders[spec && spec.type]; if (!build) throw new Error(`Unknown blueprint type: ${spec && spec.type}`); return build(spec); } };
})();
