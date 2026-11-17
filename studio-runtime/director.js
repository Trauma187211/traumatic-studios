/* Traumatic Studios gameplay director. Plain browser JavaScript.
   Builds a complete game loop from Game.config.gameplay: a goal (collect, keys, exit, defeat, survive), a threat (chasers,
   patrol, hazards, timer), health, optional shooting, a compass, the HUD, and the win and lose conditions. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis, Game = root.Game, Kit = root.Kit;
  var TABLE = {
    "3d": { speed: { slow: 1.8, normal: 2.6, fast: 3.6 }, sight: { short: 8, normal: 14, long: 24 }, pickup: 1.3, touch: 1.0, gap: 3.5, enemyR: 0.9, range: 40, hazard: 1.6 },
    "2.5d": { speed: { slow: 0.8, normal: 1.3, fast: 1.9 }, sight: { short: 3.5, normal: 6, long: 10 }, pickup: 0.6, touch: 0.5, gap: 1.6, enemyR: 0.4, range: 6, hazard: 0.8 },
    "2d": { speed: { slow: 50, normal: 75, fast: 115 }, sight: { short: 160, normal: 320, long: 9999 }, pickup: 22, touch: 26, gap: 90, enemyR: 14, range: 420, hazard: 36 }
  };
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function px(e) { return e.pos ? e.pos[0] : e.x; }
  function py(e) { return e.pos ? e.pos[2] : e.y; }
  function num(v, lo, hi, fallback) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback; }
  function hex(a) { return "#" + [0, 1, 2].map(function (i) { return ("0" + Math.round(Math.max(0, Math.min(255, a[i]))).toString(16)).slice(-2); }).join(""); }

  function readSpec() {
    var s = Game.config.gameplay || {}, dim = TABLE[Game.config.dimension] ? Game.config.dimension : "2d", t = TABLE[dim];
    var goal = Object.assign({ type: "collect", label: "lanterns", count: 6, seconds: 90 }, s.goal || {});
    var threat = Object.assign({ type: "chasers", count: 1, speed: "normal", sight: "normal", label: "stalker", hp: 2 }, s.threat || {});
    var player = Object.assign({ health: 3, shoots: false }, s.player || {});
    if (["collect", "keys", "exit", "defeat", "survive", "build"].indexOf(goal.type) < 0) goal.type = "collect";
    if (["chasers", "patrol", "hazards", "timer", "none"].indexOf(threat.type) < 0) threat.type = "chasers";
    goal.count = num(goal.count, 1, 20, 6); goal.seconds = num(goal.seconds, 20, 600, 90);
    threat.count = num(threat.count, 0, 8, 1); threat.hp = num(threat.hp, 1, 6, 2);
    player.health = num(player.health, 1, 6, 3);
    if (goal.type === "defeat") player.shoots = true;
    player.builds = !!player.builds || goal.type === "build"; player.jumps = !!player.jumps || player.builds;
    return { dim: dim, t: t, goal: goal, threat: threat, player: player };
  }
  function boundsFor(dim, g) {
    g.world = g.world || {};
    if (!g.world.bounds) g.world.bounds = dim === "3d" ? { minX: -18, maxX: 18, minZ: -18, maxZ: 18 } : dim === "2.5d" ? { minX: 0.6, maxX: 7.4, minZ: 0.6, maxZ: 7.4 } : { minX: 40, maxX: g.w - 40, minZ: 40, maxZ: g.h - 40 };
    return g.world.bounds;
  }
  function inSolid(solids, x, y, m) {
    for (var i = 0; i < solids.length; i++) { var a = solids[i]; if (x > a.minX - m && x < a.maxX + m && y > a.minZ - m && y < a.maxZ + m) return true; }
    return false;
  }
  // Random free spots: away from the player start, from solids and from each other.
  function place(d, count, start, avoid) {
    var b = d.b, out = [], tries = 0, solids = d.dim === "3d" ? Kit.solids(Game) : [], taken = (avoid || []).slice();
    while (out.length < count && tries++ < 500) {
      var x = Kit.lerp(b.minX, b.maxX, Game.rand()), y = Kit.lerp(b.minZ, b.maxZ, Game.rand());
      if (Kit.dist(x, y, start.x, start.y) < d.t.gap * 1.6) continue;
      if (inSolid(solids, x, y, 0.8)) continue;
      if (taken.some(function (q) { return Kit.dist(x, y, q.x, q.y) < d.t.gap; })) continue;
      out.push({ x: x, y: y }); taken.push({ x: x, y: y });
    }
    while (out.length < count) out.push({ x: Kit.lerp(b.minX, b.maxX, Game.rand()), y: Kit.lerp(b.minZ, b.maxZ, Game.rand()) });
    return out;
  }
  // Surfaces the player can jump onto: solids with a reachable top.
  function platformTops(d) {
    return Kit.solids(Game).filter(function (a) { return a.maxY >= 0.6 && a.maxY <= 1.8 && a.maxX - a.minX >= 1.4 && a.maxZ - a.minZ >= 1.4; });
  }
  function make(d, kind, pt) {
    var pal = Game.config.palette, m;
    if (d.dim === "3d") {
      if (kind === "item") { m = Kit.mesh.sphere(0.35, pal.accent, 8); m.pos = [pt.x, pt.h || 1.1, pt.y]; m.glow = pal.accent; }
      else if (kind === "key") { m = Kit.mesh.box(0.4, 0.4, 0.4, "#ffd24a"); m.pos = [pt.x, pt.h || 1.1, pt.y]; m.glow = "#ffd24a"; }
      else if (kind === "exit") { m = Kit.mesh.box(1.8, 3, 0.5, "#aa3333"); m.pos = [pt.x, 1.5, pt.y]; m.glow = "#ff5555"; m.glowSize = 2; m.emissive = true; }
      else if (kind === "enemy") { m = Kit.mesh.pyramid(1.1, 2.2, 1.1, pal.danger); m.pos = [pt.x, 1.1, pt.y]; m.glow = pal.danger; m.glowSize = 1.4; }
      else { m = Kit.mesh.box(d.t.hazard * 2, 0.08, d.t.hazard * 2, pal.danger); m.pos = [pt.x, 0.06, pt.y]; m.emissive = true; }
      Game.scene.meshes.push(m);
    } else m = { x: pt.x, y: pt.y, r: d.t.enemyR };
    m.kind = kind;
    return m;
  }
  function arena(g, d) {
    var pal = g.config.palette, s = g.scene, i, m;
    s.meshes.push(Kit.mesh.plane(40, 40, hex(Kit.mix(pal.panel, "#ffffff", 0.08)), hex(Kit.mix(pal.panel, "#000000", 0.3)), 16));
    for (i = 0; i < 16; i++) {
      var x = (g.rand() - 0.5) * 34, z = (g.rand() - 0.5) * 34;
      if (Math.abs(x) < 5 && z > 4) continue;
      var h = 3 + g.rand() * 3;
      m = Kit.mesh.box(1.3 + g.rand(), h, 1.3 + g.rand(), hex(Kit.mix(pal.panel, "#8899aa", 0.35 + g.rand() * 0.2)));
      m.pos = [x, h / 2, z]; m.solid = true; s.meshes.push(m);
    }
    if (d.spec.player.jumps) for (i = 0; i < 7; i++) {
      var ph = 0.8 + g.rand() * 0.8, px2 = (g.rand() - 0.5) * 30, pz = (g.rand() - 0.5) * 28;
      if (Math.abs(px2) < 4 && pz > 6) continue;
      m = Kit.mesh.box(3 + g.rand() * 2, ph, 3 + g.rand() * 2, hex(Kit.mix(pal.panel, pal.accent, 0.25)));
      m.pos = [px2, ph / 2, pz]; m.solid = true; s.meshes.push(m);
    }
    s.cam.pos = [0, 1.6, 12];
  }

  function init(g) {
    var spec = readSpec(), dim = spec.dim, t = spec.t, b = boundsFor(dim, g), sp = spec;
    var d = g.data.zdirector = { spec: spec, dim: dim, t: t, b: b, elapsed: 0, inv: 0, flash: 0, cd: 0, cd2: 0, muzzle: 0, noticeCd: 0, wasNoticed: false,
      hp: spec.player.health, maxHp: spec.player.health, items: [], enemies: [], hazards: [], exit: null, face: { x: 0, y: -1 }, tracer: null, p: null,
      left: 0, defeated: 0, limit: 0, controlled: false };
    if (dim === "3d" && g.scene.meshes.length === 0) arena(g, d);
    if (dim === "2.5d") { if (Kit.iso.ox === 400 && Kit.iso.oy === 120) { Kit.iso.ox = g.w / 2; Kit.iso.oy = 100; } }
    var start;
    if (dim === "3d") {
      var cam = g.scene.cam, solids = Kit.solids(g);
      if (inSolid(solids, cam.pos[0], cam.pos[2], 0.6)) { cam.pos[0] = 0; cam.pos[2] = b.maxZ - 2; }
      start = { x: cam.pos[0], y: cam.pos[2] };
    } else {
      d.p = dim === "2.5d" ? { x: b.minX + 0.4, y: b.minZ + 0.4, r: 0.3 } : { x: g.w / 2, y: g.h / 2, r: 12 };
      start = { x: d.p.x, y: d.p.y };
    }
    var taken = [], n = sp.goal.count, pts, i;
    if (sp.goal.type === "collect" || sp.goal.type === "keys") {
      pts = place(d, n, start, taken); taken = taken.concat(pts);
      var tops = d.dim === "3d" && sp.player.jumps ? platformTops(d) : [];
      pts.forEach(function (pt) {
        if (tops.length && Game.rand() < 0.45) {
          var a = tops[Math.floor(Game.rand() * tops.length)];
          pt = { x: (a.minX + a.maxX) / 2 + (Game.rand() - 0.5) * (a.maxX - a.minX - 0.8), y: (a.minZ + a.maxZ) / 2 + (Game.rand() - 0.5) * (a.maxZ - a.minZ - 0.8), h: a.maxY + 1.1 };
        }
        d.items.push(make(d, sp.goal.type === "keys" ? "key" : "item", pt));
      });
      d.left = n;
    }
    d.blocks = {}; d.placed = 0; d.target = sp.goal.count * 3; d.blocksLeft = sp.player.builds ? (sp.goal.type === "build" ? d.target + 6 : 10) : 0;
    if (!Game.config._dirHints) {
      Game.config._dirHints = true;
      var hints = [];
      if (d.dim === "3d" && sp.player.jumps) hints.push("Space: jump");
      if (sp.player.shoots) hints.push(sp.player.jumps || sp.player.builds ? "Click or F: shoot" : "Space or click: shoot");
      if (sp.player.builds) hints.push("B (or click when not shooting): place a block, V: break a block");
      Game.config.controls = (Game.config.controls || []).concat(hints);
    }
    if (sp.goal.type === "exit" || sp.goal.type === "keys") {
      var far = place(d, 8, start, taken).sort(function (a, c) { return Kit.dist(c.x, c.y, start.x, start.y) - Kit.dist(a.x, a.y, start.x, start.y); })[0];
      d.exit = make(d, "exit", far); d.exit.locked = sp.goal.type === "keys"; taken.push(far);
      if (!d.exit.locked && d.dim === "3d") { d.exit.color = "#2fbf71"; d.exit.glow = "#3ddc84"; }
    }
    var foes = sp.goal.type === "defeat" ? Math.max(sp.goal.count, sp.threat.count) : (sp.threat.type === "chasers" || sp.threat.type === "patrol" ? sp.threat.count : 0);
    place(d, foes, start, taken).forEach(function (pt) { var e = make(d, "enemy", pt); e.hp = sp.threat.hp; e.maxHp = sp.threat.hp; d.enemies.push(e); taken.push(pt); });
    if (sp.threat.type === "hazards") place(d, Math.max(2, sp.threat.count * 2), start, taken).forEach(function (pt) { d.hazards.push(make(d, "hazard", pt)); });
    if (sp.threat.type === "timer" || sp.threat.type === "none" || sp.threat.type === "hazards") d.limit = sp.threat.seconds ? num(sp.threat.seconds, 30, 600, 120) : 60 + 20 * n;
    if (sp.goal.type !== "survive" && d.limit === 0 && sp.threat.type !== "chasers" && sp.threat.type !== "patrol") d.limit = 120;
    var intro = { collect: "Collect " + n + " " + sp.goal.label, keys: "Find " + n + " " + sp.goal.label + ", then reach the exit", exit: "Reach the exit", build: "Place " + d.target + " blocks (B) while you stay alive", defeat: "Defeat " + foes + " " + sp.threat.label + (foes > 1 ? "s" : "") + " (Space or click to shoot)", survive: "Survive for " + sp.goal.seconds + " seconds" }[sp.goal.type];
    g.say(intro, 4);
  }

  function hurt(g, d, why) {
    if (d.inv > 0 || g.mode !== "play") return;
    d.hp--; d.inv = 1.2; d.flash = 0.45; Kit.sfx("hit");
    if (d.hp <= 0) g.end(false, why || "You were caught!"); else g.say((why || "Hit!") + " " + d.hp + " left", 1.5);
  }
  function respawn(g, d, e) {
    var P = Kit.flat(g.player), at = place(d, 1, P, [])[0];
    if (e.pos) { e.pos[0] = at.x; e.pos[2] = at.y; e.visible = true; } else { e.x = at.x; e.y = at.y; }
    e.dead = false; e.hp = e.maxHp;
  }
  function shoot(g, d, P, aim) {
    var sp = d.spec, best = null, bestT = 1e9, solids = d.dim === "3d" ? Kit.solids(g) : [], cam = d.dim === "3d" ? g.scene.cam : null, f = cam ? Kit.camBasis(cam).f : null;
    d.cd = 0.28; d.muzzle = 0.08; Kit.sfx("shoot");
    d.enemies.forEach(function (e) {
      if (e.dead) return;
      var t, perp;
      if (d.dim === "3d") {
        var v = [e.pos[0] - cam.pos[0], e.pos[1] - cam.pos[1], e.pos[2] - cam.pos[2]];
        t = Kit.v3.dot(v, f); if (t < 0.5 || t > d.t.range) return;
        perp = Math.sqrt(Math.max(0, Kit.v3.dot(v, v) - t * t));
        if (perp > d.t.enemyR + 0.3) return;
        for (var k = 1; k < 10; k++) { var q = t * k / 10; if (inSolid(solids, cam.pos[0] + f[0] * q, cam.pos[2] + f[2] * q, 0)) return; }
      } else {
        var vx = px(e) - P.x, vy = py(e) - P.y; t = vx * aim.x + vy * aim.y; if (t < 0 || t > d.t.range) return;
        perp = Math.sqrt(Math.max(0, vx * vx + vy * vy - t * t));
        if (perp > d.t.enemyR + (d.dim === "2d" ? 10 : 0.2)) return;
      }
      if (t < bestT) { bestT = t; best = e; }
    });
    d.tracer = d.dim === "3d" ? null : { x: P.x + aim.x * Math.min(bestT, d.t.range), y: P.y + aim.y * Math.min(bestT, d.t.range), life: 0.08 };
    if (best) {
      best.hp--; best.flash = 0.2; Kit.sfx("hit");
      if (best.hp <= 0) {
        best.dead = true; best.visible = false; g.score += 50; d.defeated++;
        if (sp.goal.type !== "defeat") best.respawnAt = d.elapsed + 6;
        g.say(cap(sp.threat.label) + " down", 1.2);
      }
    }
  }
  function win(g, text) { g.end(true, text); }

  // ---- building: blocks are solid meshes on a one-unit grid; they stop you and the enemies
  function cellKey(x, y, z) { return x + "," + y + "," + z; }
  function cellSolid(d, c, solids) {
    if (d.blocks[cellKey(c.x, c.y, c.z)]) return true;
    var x = c.x + 0.5, y = c.y + 0.5, z = c.z + 0.5;
    for (var i = 0; i < solids.length; i++) { var a = solids[i]; if (x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ && y > a.minY && y < a.maxY) return true; }
    return false;
  }
  function aimCells(g, d) {
    var cam = g.scene.cam, f = Kit.camBasis(cam).f, solids = Kit.solids(g), prev = null;
    for (var t = 0.3; t < 6; t += 0.12) {
      var x = cam.pos[0] + f[0] * t, y = cam.pos[1] + f[1] * t, z = cam.pos[2] + f[2] * t, c = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
      if (y < 0 || cellSolid(d, c, solids)) return { hit: y < 0 ? null : c, empty: prev };
      prev = c;
    }
    return { hit: null, empty: null };
  }
  function overlapsBody(g, c) {
    var p = g.player, feet = p.feet || 0;
    if (c.y + 1 <= feet || c.y >= feet + 1.7) return false;
    var nx = Math.max(c.x, Math.min(p.x, c.x + 1)), nz = Math.max(c.z, Math.min(p.z, c.z + 1));
    return Kit.dist(p.x, p.z, nx, nz) < 0.5;
  }
  function placeBlock(g, d) {
    if (d.blocksLeft <= 0) { g.say("No blocks left: collect more", 1.2); return; }
    if (d.placed >= 120) { g.say("Block limit reached", 1.2); return; }
    var c = aimCells(g, d).empty;
    if (!c || c.y < 0 || overlapsBody(g, c)) return;
    var pal = g.config.palette, m = Kit.mesh.box(1, 1, 1, hex(Kit.mix(pal.panel, pal.accent, 0.3 + 0.12 * ((c.x + c.z) & 1))));
    m.pos = [c.x + 0.5, c.y + 0.5, c.z + 0.5]; m.solid = true; m.placed = true;
    g.scene.meshes.push(m); d.blocks[cellKey(c.x, c.y, c.z)] = m; d.blocksLeft--; d.placed++; Kit.sfx("click");
  }
  function breakBlock(g, d) {
    var c = aimCells(g, d).hit;
    if (!c) return;
    var k = cellKey(c.x, c.y, c.z), m = d.blocks[k];
    if (!m) return;
    var i = g.scene.meshes.indexOf(m);
    if (i >= 0) g.scene.meshes.splice(i, 1);
    delete d.blocks[k]; d.blocksLeft++; d.placed--; Kit.sfx("hit");
  }

  function update(g, dt) {
    var d = g.data.zdirector;
    if (!d) return;
    var sp = d.spec, t = d.t;
    d.elapsed += dt; d.inv = Math.max(0, d.inv - dt); d.flash = Math.max(0, d.flash - dt); d.cd = Math.max(0, d.cd - dt); d.muzzle = Math.max(0, d.muzzle - dt); d.noticeCd -= dt; d.cd2 -= dt;
    if (d.tracer && (d.tracer.life -= dt) <= 0) d.tracer = null;
    var a = g.axis();
    if (a.x || a.y) d.face = d.dim === "2.5d" ? { x: (a.x + a.y) * 0.7071, y: (a.y - a.x) * 0.7071 } : { x: a.x, y: a.y };
    if (g._playerWrites === 0) {
      if (d.dim === "3d") Kit.fp.update(g, dt, { speed: 5, jump: sp.player.jumps });
      else Kit.mover.update(g, dt, d.p, d.dim === "2.5d" ? { iso: true, speed: 2.2, bounds: d.b } : { speed: 190, bounds: d.b });
      d.controlled = true;
    }
    if (!g.player) return;
    var P = Kit.flat(g.player);

    // goal
    if (sp.goal.type === "collect" || sp.goal.type === "keys") {
      var left = Kit.pickups.collect(g, d.items, { radius: t.pickup, value: sp.goal.type === "keys" ? 25 : 10, say: false });
      if (left < d.left) {
        if (sp.player.builds) d.blocksLeft += 2 * (d.left - left);
        d.left = left;
        g.say(cap(sp.goal.label) + " " + (sp.goal.count - left) + " of " + sp.goal.count, 1.6);
        if (sp.goal.type === "keys" && left === 0) { d.exit.locked = false; if (d.dim === "3d") { d.exit.color = "#2fbf71"; d.exit.glow = "#3ddc84"; } g.say("The exit is open!", 2.5); Kit.sfx("win"); }
      }
      if (sp.goal.type === "collect" && left === 0) return win(g, "You found every one.");
    }
    if (d.exit && Kit.dist(P.x, P.y, px(d.exit), py(d.exit)) < t.pickup * 1.4) {
      if (!d.exit.locked) return win(g, "You made it out.");
      if (d.cd2 <= 0) { g.say("Find the " + sp.goal.label + " first", 1.6); d.cd2 = 2; }
    }
    if (sp.goal.type === "defeat" && d.enemies.every(function (e) { return e.dead; })) return win(g, "Every " + sp.threat.label + " is down.");
    if (sp.goal.type === "survive" && d.elapsed >= sp.goal.seconds) return win(g, "You survived.");
    if (sp.goal.type === "build" && d.placed >= d.target) return win(g, "Your build is complete.");

    // threat
    var ramp = 1 + Math.min(0.45, d.elapsed / 200), noticed = false;
    var speed = typeof sp.threat.speed === "number" ? sp.threat.speed : (t.speed[sp.threat.speed] || t.speed.normal);
    var sight = typeof sp.threat.sight === "number" ? sp.threat.sight : (t.sight[sp.threat.sight] || t.sight.normal);
    d.enemies.forEach(function (e) {
      if (e.dead) { if (e.respawnAt && d.elapsed >= e.respawnAt) { e.respawnAt = 0; respawn(g, d, e); } return; }
      if (e.flash) e.flash = Math.max(0, e.flash - dt);
      var res = Kit.chaser.update(g, dt, e, { speed: speed * ramp, sight: sight, touch: t.touch, bounds: d.b, radius: 0.5 });
      if (e.state && e.state.chasing) noticed = true;
      if (res === "caught") hurt(g, d, "The " + sp.threat.label + " got you!");
    });
    if (noticed && !d.wasNoticed && d.noticeCd <= 0) { g.say("The " + sp.threat.label + " noticed you!", 2); Kit.sfx("hit"); d.noticeCd = 8; }
    d.wasNoticed = noticed;
    d.hazards.forEach(function (h) { if (Kit.dist(P.x, P.y, px(h), py(h)) < t.hazard) hurt(g, d, "That burns!"); });
    if (d.limit && d.elapsed >= d.limit) return g.end(false, "Time ran out.");

    // shooting
    if (d.dim === "3d" && sp.player.builds) {
      if (g.pressed("KeyB") || (!sp.player.shoots && g.mouse.clicked)) placeBlock(g, d);
      if (g.pressed("KeyV")) breakBlock(g, d);
    }
    var fire = g.pressed("KeyF") || (!sp.player.jumps && g.pressed("Space")) || (!sp.player.builds && g.mouse.clicked);
    if (sp.player.shoots && d.cd <= 0 && fire) {
      var aim = d.face;
      if (d.dim === "2d" && g.mouse.clicked) { var mx = g.mouse.x - P.x, my = g.mouse.y - P.y, ml = Math.sqrt(mx * mx + my * my) || 1; aim = { x: mx / ml, y: my / ml }; }
      shoot(g, d, P, aim);
    }

    // HUD
    var alive = d.enemies.filter(function (e) { return !e.dead; }).length, goalLine = {
      collect: cap(sp.goal.label) + ": " + (sp.goal.count - d.left) + "/" + sp.goal.count,
      keys: cap(sp.goal.label) + ": " + (sp.goal.count - d.left) + "/" + sp.goal.count + (d.exit && d.exit.locked ? "" : "  (exit open)"),
      exit: "Reach the exit", build: "Blocks placed: " + d.placed + "/" + d.target, defeat: "Defeated: " + d.defeated + "/" + d.enemies.length, survive: "Survive: " + Math.max(0, Math.ceil(sp.goal.seconds - d.elapsed)) + "s"
    }[sp.goal.type];
    g.hud.push(goalLine, "Health: " + d.hp + "/" + d.maxHp);
    if (sp.player.builds) g.hud.push("Blocks in hand: " + d.blocksLeft);
    if (d.limit) g.hud.push("Time left: " + Math.max(0, Math.ceil(d.limit - d.elapsed)));
    if (alive && sp.goal.type !== "defeat" && sp.threat.type === "chasers" && d.elapsed > 30) g.hud.push("The " + sp.threat.label + " is getting faster");
  }

  function target(g, d) {
    var sp = d.spec, P = Kit.flat(g.player), list = [], label = sp.goal.label;
    if (sp.goal.type === "collect" || (sp.goal.type === "keys" && d.left > 0)) list = d.items.filter(function (i) { return !i.collected; });
    else if (d.exit) list = [d.exit], label = "exit";
    else if (sp.goal.type === "defeat") list = d.enemies.filter(function (e) { return !e.dead; }), label = sp.threat.label;
    list.sort(function (a, c) { return Kit.dist(P.x, P.y, px(a), py(a)) - Kit.dist(P.x, P.y, px(c), py(c)); });
    return list[0] ? { x: px(list[0]), y: py(list[0]), label: label, dist: Kit.dist(P.x, P.y, px(list[0]), py(list[0])) } : null;
  }
  function compass(g, ctx, d) {
    var tg = target(g, d);
    if (!tg) return;
    var P = Kit.flat(g.player), cam = g.scene.cam, f = Kit.flatForward(cam), r = Kit.flatRight(cam), rx = tg.x - P.x, ry = tg.y - P.y;
    var ang = Math.atan2(rx * r[0] + ry * r[2], rx * f[0] + ry * f[2]), cx = g.w / 2, cy = g.h - 56;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.fillStyle = g.config.palette.accent; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(10, 11); ctx.lineTo(0, 5); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill();
    ctx.restore();
    Kit.text(ctx, tg.label + "  " + Math.round(tg.dist) + "m", cx, cy + 22, { size: 14, align: "center", bold: false });
  }
  function dot2(ctx, x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill(); }
  function diamond(ctx, x, y, w, h, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); ctx.lineTo(x - w, y); ctx.closePath(); ctx.fill(); }

  function draw(g, ctx) {
    var d = g.data.zdirector;
    if (!d) return;
    var pal = g.config.palette, sp = d.spec, iso = d.dim === "2.5d";
    if (d.dim !== "3d") {
      var S = function (e, z) { return iso ? Kit.iso.toScreen(px(e), py(e), z || 0) : { x: e.x, y: e.y }; };
      d.hazards.forEach(function (h) { var s = S(h); if (iso) diamond(ctx, s.x, s.y, 32, 16, "rgba(255,60,60,0.45)"); else dot2(ctx, s.x, s.y, d.t.hazard, "rgba(255,60,60,0.35)"); });
      if (d.exit) { var s = S(d.exit, 4); if (iso) Kit.iso.block(ctx, Math.floor(d.exit.x), Math.floor(d.exit.y), 6, 30, d.exit.locked ? "#aa3333" : "#2fbf71"); else { ctx.fillStyle = d.exit.locked ? "#aa3333" : "#2fbf71"; ctx.fillRect(s.x - 16, s.y - 22, 32, 44); } }
      d.items.forEach(function (it) {
        if (it.collected) return;
        var s = S(it, 14 + Math.sin(g.time * 3) * 3), c = it.kind === "key" ? "#ffd24a" : pal.accent;
        dot2(ctx, s.x, s.y, iso ? 16 : 16, Kit.alpha(c, 0.25)); if (iso) diamond(ctx, s.x, s.y, 8, 12, c); else dot2(ctx, s.x, s.y, 8, c);
      });
      d.enemies.forEach(function (e) {
        if (e.dead) return;
        var s = S(e, 6); if (iso) { ctx.fillStyle = e.flash ? "#ffffff" : pal.danger; ctx.fillRect(s.x - 8, s.y - 26, 16, 22); } else dot2(ctx, s.x, s.y, e.r, e.flash ? "#ffffff" : pal.danger);
      });
      if (d.controlled) {
        var p = S(d.p, iso ? 6 : 0), blink = d.inv > 0 && Math.floor(g.time * 12) % 2;
        if (iso) { ctx.fillStyle = "#00000055"; ctx.beginPath(); ctx.ellipse(p.x, p.y, 14, 7, 0, 0, 6.283); ctx.fill(); ctx.fillStyle = blink ? "#ffffff55" : pal.text; ctx.fillRect(p.x - 7, p.y - 30, 14, 26); }
        else dot2(ctx, p.x, p.y, d.p.r, blink ? "#ffffff55" : pal.text);
      }
      if (d.tracer) { var from = S(d.controlled ? d.p : g.player, iso ? 14 : 0), to = S(d.tracer, iso ? 14 : 0); ctx.strokeStyle = "#ffe08a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    } else {
      if (g.player) compass(g, ctx, d);
      if (sp.player.shoots) { ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(g.w / 2 - 8, g.h / 2); ctx.lineTo(g.w / 2 + 8, g.h / 2); ctx.moveTo(g.w / 2, g.h / 2 - 8); ctx.lineTo(g.w / 2, g.h / 2 + 8); ctx.stroke(); }
      if (d.muzzle > 0) { ctx.fillStyle = "rgba(255,230,150,0.3)"; ctx.fillRect(0, 0, g.w, g.h); }
    }
    if (d.flash > 0) { ctx.fillStyle = "rgba(255,0,0," + Math.min(0.5, d.flash) + ")"; ctx.fillRect(0, 0, g.w, g.h); }
    if (d.hp === 1 && d.maxHp > 1 && g.mode === "play") { ctx.fillStyle = "rgba(160,0,0," + (0.08 + 0.06 * Math.sin(g.time * 6)) + ")"; ctx.fillRect(0, 0, g.w, g.h); }
  }

  Game.director = function (stage) {
    var gp = Game.config.gameplay;
    if (!gp || gp.mode === "custom" || gp.off) return;
    if (gp.view === "side" && Game.config.dimension === "2d" && Game.sideDirector) return Game.sideDirector(stage);
    if (stage === "pre") {
      if (Game.config.dimension === "2.5d" && gp.autoFloor) {
        Game.module("zFloor", {
          init: function (g) { Kit.iso.ox = g.w / 2; Kit.iso.oy = 100; },
          draw: function (g, ctx) {
            var pal = g.config.palette, k, gx, gy;
            for (k = 0; k < 16; k++) for (gx = 0; gx < 8; gx++) { gy = k - gx; if (gy < 0 || gy >= 8) continue; Kit.iso.block(ctx, gx, gy, 0, 6, (gx + gy) % 2 ? pal.panel : hex(Kit.mix(pal.panel, "#000000", 0.25))); }
          }
        });
      }
      return;
    }
    Game.module("zDirector", { init: init, update: update, draw: draw });
  };
})();
