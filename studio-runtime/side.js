/* Traumatic Studios side-scroller director (2D platformer). Plain browser JavaScript.
   Gravity and jumping with coyote time, pits, stompable walkers, spikes, coins, keys, a flag, a scrolling camera. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis, Game = root.Game, Kit = root.Kit;
  var GRAV = 1900, JUMP = 700, SPEED = 230, PW = 24, PH = 36, SPD = { slow: 45, normal: 70, fast: 110 };
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function num(v, lo, hi, d) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  function hit(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  function readSpec() {
    var s = Game.config.gameplay || {}, goal = Object.assign({ type: "collect", label: "coins", count: 8 }, s.goal || {});
    var threat = Object.assign({ type: "patrol", label: "walker", count: 3, speed: "normal" }, s.threat || {});
    var player = Object.assign({ health: 3 }, s.player || {});
    if (["collect", "keys", "exit", "defeat"].indexOf(goal.type) < 0) goal.type = "exit";   // survive and build become "reach the flag"
    goal.count = num(goal.count, 1, 20, 8); threat.count = num(threat.count, 0, 8, 3); player.health = num(player.health, 1, 6, 3);
    return { goal: goal, threat: threat, player: player };
  }

  function level(g, sp) {
    var W = Math.round(g.w * 3.2), gy = g.h - 70, ground = [], plats = [], x = 0, first = true, i, k;
    while (x < W) {
      var segW = first ? 460 : 280 + g.rand() * 320, pit = 90 + g.rand() * 50;
      if (W - (x + segW + pit) < 500) { segW = W - x; pit = 0; }
      ground.push({ x: x, w: segW, y: gy, ground: true }); x += segW + pit; first = false;
    }
    for (i = 0; i < 8; i++) {
      var px = 260 + g.rand() * (W - 560), pl = { x: px, y: gy - (95 + g.rand() * 20), w: 100 + g.rand() * 70, h: 14 };
      plats.push(pl);
      if (i % 3 === 0) plats.push({ x: pl.x + 20 + g.rand() * 40, y: pl.y - 95, w: 90 + g.rand() * 50, h: 14 });
    }
    var surfaces = ground.concat(plats);
    function spot(minX, margin) {
      for (var t = 0; t < 60; t++) {
        var s2 = surfaces[Math.floor(g.rand() * surfaces.length)];
        if (s2.w < margin * 2 + 20) continue;
        var sx = s2.x + margin + g.rand() * (s2.w - margin * 2);
        if (sx > minX) return { x: sx, s: s2 };
      }
      return { x: ground[ground.length - 1].x + 120, s: ground[ground.length - 1] };
    }
    var d = { spec: sp, W: W, gy: gy, ground: ground, plats: plats, surfaces: surfaces, items: [], walkers: [], spikes: [], exit: null,
      p: { x: 80, y: gy - PH, w: PW, h: PH, vx: 0, vy: 0, grounded: false, coyote: 0, buf: 0, face: 1 }, elapsed: 0, inv: 0, flash: 0, hp: sp.player.health, maxHp: sp.player.health,
      left: 0, stomped: 0, cd: 0, checkpoint: { x: 80, y: gy - PH }, limit: sp.threat.type === "timer" ? num(sp.threat.seconds, 30, 600, 150) : 0 };
    if (sp.goal.type === "collect" || sp.goal.type === "keys") {
      for (i = 0; i < sp.goal.count; i++) { var sp1 = spot(300, 24); d.items.push({ x: sp1.x, y: sp1.s.y - 28, kind: sp.goal.type === "keys" ? "key" : "coin", collected: false }); }
      d.left = sp.goal.count;
    }
    var foes = sp.goal.type === "defeat" ? Math.max(sp.goal.count, sp.threat.count) : (sp.threat.type === "patrol" || sp.threat.type === "chasers" ? sp.threat.count : 0);
    var speed = typeof sp.threat.speed === "number" ? sp.threat.speed : (SPD[sp.threat.speed] || SPD.normal);
    for (i = 0; i < foes; i++) { var w1 = spot(420, 40); d.walkers.push({ x: w1.x, y: w1.s.y - 28, w: 28, h: 28, dir: g.rand() < 0.5 ? -1 : 1, speed: speed, s: w1.s, alive: true }); }
    if (sp.threat.type === "hazards") for (k = 0; k < Math.max(3, sp.threat.count * 2); k++) {
      for (var tries = 0; tries < 60; tries++) {
        var seg = ground[Math.floor(g.rand() * ground.length)], hx = seg.x + 40 + g.rand() * Math.max(0, seg.w - 120);
        if (seg.w > 130 && hx > 500) { d.spikes.push({ x: hx, y: seg.y - 14, w: 36, h: 14 }); break; }
      }
    }
    if (sp.goal.type === "exit" || sp.goal.type === "keys") d.exit = { x: W - 90, y: gy - 74, w: 26, h: 74, locked: sp.goal.type === "keys" };
    return d;
  }

  function hurt(g, d, why) {
    if (d.inv > 0 || g.mode !== "play") return;
    d.hp--; d.inv = 1.2; d.flash = 0.4; Kit.sfx("hit");
    if (d.hp <= 0) g.end(false, why || "You were knocked out."); else g.say((why || "Ouch!") + " " + d.hp + " left", 1.4);
  }

  function init(g) {
    var sp = readSpec(), d = g.data.zside = level(g, sp), hints = ["A / D or arrows: run", "Space, W or Up: jump (land on enemies to stomp them)"];
    if (!g.config._sideHints) { g.config._sideHints = true; g.config.controls = (g.config.controls || []).concat(hints); }
    g.player = { x: d.p.x + d.p.w / 2, y: d.p.y + d.p.h / 2 };
    g.camera = { x: 0, y: 0 };
    g.say({ collect: "Collect " + sp.goal.count + " " + sp.goal.label, keys: "Find " + sp.goal.count + " " + sp.goal.label + " and reach the flag", exit: "Reach the flag", defeat: "Stomp " + d.walkers.length + " " + sp.threat.label + "s" }[sp.goal.type], 4);
  }

  function update(g, dt) {
    var d = g.data.zside;
    if (!d) return;
    var sp = d.spec, p = d.p, a = g.axis(), i;
    d.elapsed += dt; d.inv = Math.max(0, d.inv - dt); d.flash = Math.max(0, d.flash - dt);
    p.vx += (a.x * SPEED - p.vx) * Math.min(1, 14 * dt);
    if (!a.x && Math.abs(p.vx) < 8) p.vx = 0;
    if (a.x) p.face = a.x > 0 ? 1 : -1;
    var want = g.pressed("Space") || g.pressed("ArrowUp") || g.pressed("KeyW"), held = g.down("Space") || g.down("ArrowUp") || g.down("KeyW");
    p.buf = want ? 0.12 : p.buf - dt; p.coyote = p.grounded ? 0.09 : p.coyote - dt;
    if (p.buf > 0 && p.coyote > 0) { p.vy = -JUMP; p.buf = 0; p.coyote = 0; p.grounded = false; Kit.sfx("jump"); }
    if (!held && p.vy < -240) p.vy = -240;
    p.vy = Math.min(p.vy + GRAV * dt, 1100);
    var prevBottom = p.y + p.h;
    p.x = Kit.clamp(p.x + p.vx * dt, 0, d.W - p.w); p.y += p.vy * dt;
    p.grounded = false;
    if (p.vy >= 0) for (i = 0; i < d.surfaces.length; i++) {
      var s = d.surfaces[i];
      if (p.x + p.w > s.x && p.x < s.x + s.w && prevBottom <= s.y + 2 && p.y + p.h >= s.y) {
        p.y = s.y - p.h; p.vy = 0; p.grounded = true;
        if (s.ground) d.checkpoint = { x: s.x + 40, y: s.y - p.h };
        break;
      }
    }
    if (p.y > g.h + 140) { hurt(g, d, "You fell!"); p.x = d.checkpoint.x; p.y = d.checkpoint.y; p.vx = 0; p.vy = 0; if (g.mode !== "play") return; }
    g.camera = { x: Kit.clamp(p.x - g.w * 0.4, 0, d.W - g.w), y: 0 };
    g.player = { x: p.x + p.w / 2, y: p.y + p.h / 2 };

    d.items.forEach(function (it) {
      if (it.collected || Kit.dist(g.player.x, g.player.y, it.x, it.y) > 26) return;
      it.collected = true; d.left--; g.score += it.kind === "key" ? 25 : 10; Kit.sfx("pickup");
      g.say(cap(sp.goal.label) + " " + (sp.goal.count - d.left) + " of " + sp.goal.count, 1.4);
      if (sp.goal.type === "keys" && d.left === 0) { d.exit.locked = false; g.say("The flag is unlocked!", 2.4); Kit.sfx("win"); }
    });
    d.walkers.forEach(function (e) {
      if (!e.alive) return;
      e.x += e.dir * e.speed * dt;
      if (e.x < e.s.x + 8) { e.x = e.s.x + 8; e.dir = 1; }
      if (e.x + e.w > e.s.x + e.s.w - 8) { e.x = e.s.x + e.s.w - 8 - e.w; e.dir = -1; }
      if (hit(p, e)) {
        if (p.vy > 60 && prevBottom <= e.y + 14) { e.alive = false; p.vy = -460; d.stomped++; g.score += 100; Kit.sfx("pickup"); g.say("Stomp!", 0.8); }
        else hurt(g, d, "Ouch!");
      }
    });
    d.spikes.forEach(function (sk) { if (hit(p, sk)) { hurt(g, d, "Spikes!"); p.vy = -380; } });
    if (d.exit && hit(p, d.exit)) { if (!d.exit.locked) return g.end(true, "You reached the flag."); if (d.cd <= 0) { g.say("Find the " + sp.goal.label + " first", 1.5); d.cd = 2; } }
    d.cd -= dt;
    if (sp.goal.type === "collect" && d.left === 0) return g.end(true, "You collected everything.");
    if (sp.goal.type === "defeat" && d.walkers.every(function (e) { return !e.alive; })) return g.end(true, "Every " + sp.threat.label + " is down.");
    if (d.limit && d.elapsed >= d.limit) return g.end(false, "Time ran out.");

    var line = { collect: cap(sp.goal.label) + ": " + (sp.goal.count - d.left) + "/" + sp.goal.count, keys: cap(sp.goal.label) + ": " + (sp.goal.count - d.left) + "/" + sp.goal.count, exit: "Reach the flag", defeat: "Stomped: " + d.stomped + "/" + d.walkers.length }[sp.goal.type];
    g.hud.push(line, "Health: " + d.hp + "/" + d.maxHp);
    if (d.limit) g.hud.push("Time left: " + Math.max(0, Math.ceil(d.limit - d.elapsed)));
  }

  function mixHex(a, b, t) { var m = Kit.mix(a, b, t); return "#" + [0, 1, 2].map(function (i) { return ("0" + Math.round(m[i]).toString(16)).slice(-2); }).join(""); }
  function draw(g, ctx) {
    var d = g.data.zside;
    if (!d) return;
    var pal = g.config.palette, cx = g.camera ? g.camera.x : 0, i;
    d.ground.forEach(function (s) { ctx.fillStyle = pal.panel; ctx.fillRect(s.x, s.y, s.w, g.h - s.y + 200); ctx.fillStyle = pal.accent; ctx.fillRect(s.x, s.y, s.w, 5); });
    d.plats.forEach(function (pl) { ctx.fillStyle = mixHex(pal.panel, "#ffffff", 0.18); ctx.fillRect(pl.x, pl.y, pl.w, pl.h); ctx.fillStyle = pal.accent; ctx.fillRect(pl.x, pl.y, pl.w, 4); });
    d.spikes.forEach(function (sk) { ctx.fillStyle = pal.danger; for (i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(sk.x + i * 12, sk.y + sk.h); ctx.lineTo(sk.x + i * 12 + 6, sk.y); ctx.lineTo(sk.x + i * 12 + 12, sk.y + sk.h); ctx.closePath(); ctx.fill(); } });
    if (d.exit) { var e = d.exit; ctx.fillStyle = "#cccccc"; ctx.fillRect(e.x, e.y, 4, e.h); ctx.fillStyle = e.locked ? "#aa3333" : "#2fbf71"; ctx.beginPath(); ctx.moveTo(e.x + 4, e.y); ctx.lineTo(e.x + 4 + 34, e.y + 14); ctx.lineTo(e.x + 4, e.y + 28); ctx.closePath(); ctx.fill(); }
    d.items.forEach(function (it) {
      if (it.collected) return;
      var yy = it.y + Math.sin(g.time * 4 + it.x) * 3, col = it.kind === "key" ? "#ffd24a" : pal.accent;
      ctx.fillStyle = Kit.alpha(col, 0.25); ctx.beginPath(); ctx.arc(it.x, yy, 17, 0, 6.283); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); if (it.kind === "key") ctx.rect(it.x - 7, yy - 7, 14, 14); else ctx.arc(it.x, yy, 9, 0, 6.283); ctx.fill();
    });
    d.walkers.forEach(function (w) {
      if (!w.alive) return;
      ctx.fillStyle = pal.danger; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(w.x + (w.dir > 0 ? 16 : 4), w.y + 7, 8, 8); ctx.fillStyle = "#111111"; ctx.fillRect(w.x + (w.dir > 0 ? 20 : 6), w.y + 10, 4, 4);
    });
    var p = d.p, blink = d.inv > 0 && Math.floor(g.time * 14) % 2;
    ctx.fillStyle = blink ? "#ffffff55" : pal.text; ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = pal.panel; ctx.fillRect(p.x + (p.face > 0 ? 14 : 4), p.y + 8, 6, 6);
    if (d.flash > 0) { ctx.fillStyle = "rgba(255,0,0," + Math.min(0.45, d.flash) + ")"; ctx.fillRect(cx, 0, g.w, g.h); }
  }

  Game.sideDirector = function (stage) {
    if (stage === "pre") {
      Game.module("zSideBack", { draw: function (g, ctx) {
        var cx = g.camera ? g.camera.x : 0, pal = g.config.palette, grd = ctx.createLinearGradient(0, 0, 0, g.h), i;
        grd.addColorStop(0, mixHex(pal.bg, "#000000", 0.2)); grd.addColorStop(1, mixHex(pal.bg, "#4a6fa5", 0.55));
        ctx.fillStyle = grd; ctx.fillRect(cx, 0, g.w, g.h);
        var off = (cx * 0.5) % 420;
        ctx.fillStyle = mixHex(pal.bg, pal.accent, 0.1);
        for (i = -1; i < 4; i++) { ctx.beginPath(); ctx.arc(cx - off + i * 420 + 210, g.h - 40, 150 + (i % 2) * 40, 0, 6.283); ctx.fill(); }
      } });
      return;
    }
    Game.module("zSide", { init: init, update: update, draw: draw });
  };
})();
