/* Traumatic Studios game runtime. Plain browser JavaScript. Defines the globals Game and Kit.
   Generated modules never redefine these; they only call Game.module(...) and use Kit helpers. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  var Kit = {};
  var Game = {
    config: { title: "Game", width: 800, height: 600, controls: [], palette: {} },
    mode: "title", score: 0, time: 0, dt: 0, frames: 0, w: 800, h: 600,
    data: {}, hud: [], errors: [],
    mouse: { x: 0, y: 0, dx: 0, dy: 0, down: false, clicked: false }
  };
  var mods = [], held = {}, tapped = {}, canvas = null, ctx = null, last = 0, modeTime = 0, banner = "", bannerTime = 0, current = "", playerValue = null;
  Game.playerBy = ""; Game.endInfo = null; Game.scene = null; Game.camera = null;
  // g.player is tracked so a playtest can tell which module publishes it.
  Game._playerWrites = 0;
  Object.defineProperty(Game, "player", { enumerable: true, get: function () { return playerValue; }, set: function (v) { playerValue = v; Game._playerWrites++; Game.playerBy = current || Game.playerBy; } });

  /* ---------- math and colour ---------- */
  Kit.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  Kit.lerp = function (a, b, t) { return a + (b - a) * t; };
  Kit.dist = function (ax, ay, bx, by) { return Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)); };
  Kit.overlap = function (a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; };
  Kit.circleHit = function (a, b) { return Kit.dist(a.x, a.y, b.x, b.y) < a.r + b.r; };
  Kit.rng = function (seed) {
    var s = (seed | 0) || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  };
  Kit.color = function (hex) {
    if (Array.isArray(hex)) return hex;
    var h = String(hex || "#888888").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0x888888;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  function byte(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  Kit.rgb = function (c) { return "rgb(" + byte(c[0]) + "," + byte(c[1]) + "," + byte(c[2]) + ")"; };
  Kit.alpha = function (hex, a) { var c = Kit.color(hex); return "rgba(" + byte(c[0]) + "," + byte(c[1]) + "," + byte(c[2]) + "," + a + ")"; };
  Kit.shade = function (hex, f) { var c = Kit.color(hex); return Kit.rgb([c[0] * f, c[1] * f, c[2] * f]); };
  Kit.mix = function (a, b, t) { var x = Kit.color(a), y = Kit.color(b); return [Kit.lerp(x[0], y[0], t), Kit.lerp(x[1], y[1], t), Kit.lerp(x[2], y[2], t)]; };

  /* ---------- 2D drawing helpers ---------- */
  Kit.text = function (c, str, x, y, o) {
    o = o || {};
    c.font = (o.bold === false ? "" : "bold ") + (o.size || 16) + "px system-ui, sans-serif";
    c.textAlign = o.align || "left";
    c.textBaseline = o.baseline || "top";
    c.fillStyle = o.color || (Game.config.palette && Game.config.palette.text) || "#ffffff";
    c.fillText(String(str), x, y);
  };
  Kit.bar = function (c, x, y, w, h, frac, color, back) {
    c.fillStyle = back || "rgba(255,255,255,0.15)"; c.fillRect(x, y, w, h);
    c.fillStyle = color || "#4ade80"; c.fillRect(x, y, w * Kit.clamp(frac, 0, 1), h);
  };
  Kit.sky = function (c, w, h, top, bottom) {
    var g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top || "#10203a"); g.addColorStop(1, bottom || "#4a6fa5");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  };

  /* ---------- grid pathfinding ---------- */
  // grid[y][x] truthy = wall. from/to are {x,y} cells. Returns the cells to walk through (start excluded), or [] when blocked.
  Kit.aStar = function (grid, from, to, maxNodes) {
    var rows = grid.length, cols = rows ? grid[0].length : 0;
    var sx = Math.round(from.x), sy = Math.round(from.y), gx = Math.round(to.x), gy = Math.round(to.y);
    function ok(x, y) { return x >= 0 && y >= 0 && x < cols && y < rows && !grid[y][x]; }
    function key(x, y) { return y * cols + x; }
    if (!ok(sx, sy) || !ok(gx, gy)) return [];
    var open = [{ x: sx, y: sy, g: 0, f: Math.abs(gx - sx) + Math.abs(gy - sy) }], best = {}, came = {}, closed = {}, nodes = 0, limit = maxNodes || 4000;
    best[key(sx, sy)] = 0;
    while (open.length && nodes++ < limit) {
      var bi = 0, i;
      for (i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      var cur = open.splice(bi, 1)[0], ck = key(cur.x, cur.y);
      if (closed[ck]) continue;
      closed[ck] = true;
      if (cur.x === gx && cur.y === gy) {
        var path = [], k = ck;
        while (k !== key(sx, sy)) { path.push({ x: k % cols, y: Math.floor(k / cols) }); k = came[k]; }
        return path.reverse();
      }
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = cur.x + d[0], ny = cur.y + d[1];
        if (!ok(nx, ny)) return;
        var g2 = cur.g + 1, nk = key(nx, ny);
        if (best[nk] === undefined || g2 < best[nk]) { best[nk] = g2; came[nk] = ck; open.push({ x: nx, y: ny, g: g2, f: g2 + Math.abs(gx - nx) + Math.abs(gy - ny) }); }
      });
    }
    return [];
  };
  Kit.findPath = Kit.aStar;
  // True when no wall cell lies on the straight line between two cells.
  Kit.lineOfSight = function (grid, x0, y0, x1, y1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy, guard = 0;
    while (guard++ < 10000) {
      if (!grid[y0] || grid[y0][x0] === undefined || grid[y0][x0]) return false;
      if (x0 === x1 && y0 === y1) return true;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return false;
  };

  /* ---------- procedural sound (no files) ---------- */
  var audio = null;
  var tones = { hit: [160, 0.12, "square"], pickup: [660, 0.1, "sine"], jump: [380, 0.12, "triangle"], shoot: [520, 0.07, "sawtooth"], click: [440, 0.05, "square"], win: [880, 0.4, "sine"], lose: [110, 0.45, "sawtooth"] };
  Kit.sfx = function (name) {
    try {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      if (!audio) audio = new AC();
      var t = tones[name] || tones.click, o = audio.createOscillator(), g = audio.createGain();
      o.type = t[2]; o.frequency.value = t[0]; g.gain.value = 0.05;
      o.connect(g); g.connect(audio.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t[1]); o.stop(audio.currentTime + t[1]);
    } catch (e) { /* sound is optional */ }
  };

  /* ---------- 2.5D isometric helpers ---------- */
  Kit.iso = {
    tw: 64, th: 32, ox: 400, oy: 120,
    toScreen: function (gx, gy, z) {
      return { x: Kit.iso.ox + (gx - gy) * Kit.iso.tw / 2, y: Kit.iso.oy + (gx + gy) * Kit.iso.th / 2 - (z || 0) };
    },
    poly: function (c, pts, fill) {
      c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.closePath(); c.fillStyle = fill; c.fill();
    },
    block: function (c, gx, gy, z, hpx, color) {
      var s = Kit.iso.toScreen, e = z + hpx;
      var A = s(gx, gy, e), B = s(gx + 1, gy, e), C = s(gx + 1, gy + 1, e), D = s(gx, gy + 1, e);
      var Bb = s(gx + 1, gy, z), Cb = s(gx + 1, gy + 1, z), Db = s(gx, gy + 1, z);
      if (hpx > 0) {
        Kit.iso.poly(c, [D, C, Cb, Db], Kit.shade(color, 0.7));
        Kit.iso.poly(c, [C, B, Bb, Cb], Kit.shade(color, 0.5));
      }
      Kit.iso.poly(c, [A, B, C, D], Kit.shade(color, 1));
    }
  };

  /* ---------- 3D helpers: software renderer on the 2D canvas ---------- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  Kit.v3 = { sub: sub, dot: dot, cross: cross, norm: norm };

  Kit.camera3d = function (o) {
    o = o || {};
    return { pos: o.pos || [0, 1.6, 6], yaw: o.yaw || 0, pitch: o.pitch || 0, fov: o.fov || 70 };
  };
  Kit.camBasis = function (cam) {
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var f = [sy * cp, sp, -cy * cp], r = [cy, 0, sy];
    return { f: f, r: r, u: cross(r, f) };
  };
  Kit.flatForward = function (cam) { return [Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)]; };
  Kit.flatRight = function (cam) { return [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)]; };
  Kit.project3d = function (cam, p, w, h) {
    var b = Kit.camBasis(cam), d = sub(p, cam.pos), z = dot(d, b.f);
    if (z < 0.1) return null;
    var focal = (h / 2) / Math.tan(cam.fov * Math.PI / 360);
    return { x: w / 2 + dot(d, b.r) / z * focal, y: h / 2 - dot(d, b.u) / z * focal, depth: z };
  };

  function orient(mesh) {
    mesh.faces.forEach(function (f) {
      var a = mesh.verts[f[0]], b = mesh.verts[f[1]], c = mesh.verts[f[2]];
      var n = cross(sub(b, a), sub(c, a));
      var m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      if (dot(n, m) < 0) { var t = f[1]; f[1] = f[2]; f[2] = t; }
    });
    return mesh;
  }
  function make(verts, faces, color) {
    return { verts: verts, faces: faces, color: color || "#cccccc", colors: null, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], double: false, visible: true };
  }
  Kit.mesh = {
    make: make,
    box: function (w, h, d, color) {
      var x = w / 2, y = h / 2, z = d / 2;
      return make([[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]],
        [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [7, 6, 2], [7, 2, 3], [0, 1, 5], [0, 5, 4]], color);
    },
    plane: function (w, d, colorA, colorB, tiles) {
      var n = Math.max(1, tiles || 8), verts = [], faces = [], colors = [], i, j;
      for (i = 0; i <= n; i++) for (j = 0; j <= n; j++) verts.push([-w / 2 + w * i / n, 0, -d / 2 + d * j / n]);
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) {
        var a = i * (n + 1) + j, b = a + 1, c = a + n + 2, e = a + n + 1;
        var col = (i + j) % 2 ? (colorB || colorA) : colorA;
        faces.push([a, b, c]); colors.push(col); faces.push([a, c, e]); colors.push(col);
      }
      var m = make(verts, faces, colorA); m.colors = colors; m.double = true; m.ground = true; return m;
    },
    pyramid: function (w, h, d, color) {
      var x = w / 2, y = h / 2, z = d / 2;
      return orient(make([[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, y, 0]],
        [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 2, 1], [0, 3, 2]], color));
    },
    sphere: function (r, color, seg) {
      var n = seg || 10, verts = [], faces = [], i, j;
      for (i = 0; i <= n; i++) for (j = 0; j < n * 2; j++) {
        var t = i * Math.PI / n, p = j * Math.PI / n;
        verts.push([r * Math.sin(t) * Math.cos(p), r * Math.cos(t), r * Math.sin(t) * Math.sin(p)]);
      }
      for (i = 0; i < n; i++) for (j = 0; j < n * 2; j++) {
        var j2 = (j + 1) % (n * 2), a = i * n * 2 + j, b = (i + 1) * n * 2 + j, c = (i + 1) * n * 2 + j2, d = i * n * 2 + j2;
        faces.push([a, b, c]); faces.push([a, c, d]);
      }
      return orient(make(verts, faces, color));
    }
  };

  function worldVerts(m) {
    var s = m.scale || [1, 1, 1], r = m.rot || [0, 0, 0], p = m.pos || [0, 0, 0];
    var cx = Math.cos(r[0]), sx = Math.sin(r[0]), cy = Math.cos(r[1]), sy = Math.sin(r[1]), cz = Math.cos(r[2]), sz = Math.sin(r[2]);
    return m.verts.map(function (v) {
      var x = v[0] * s[0], y = v[1] * s[1], z = v[2] * s[2];
      var x1 = x * cz - y * sz, y1 = x * sz + y * cz;
      var y2 = y1 * cx - z * sx, z2 = y1 * sx + z * cx;
      return [x1 * cy + z2 * sy + p[0], y2 + p[1], -x1 * sy + z2 * cy + p[2]];
    });
  }
  Kit.render3d = function (c, cam, meshes, o) {
    o = o || {};
    var w = o.width || Game.w, h = o.height || Game.h, near = 0.1;
    var light = norm(o.light || [0.4, 0.8, 0.5]), fogNear = o.fogNear || 18, fogFar = o.fogFar || 60, fogColor = o.fogColor || "#10203a";
    var torchR = o.torch === undefined ? 14 : o.torch, torchK = o.torchStrength === undefined ? 0.55 : o.torchStrength;
    var b = Kit.camBasis(cam), focal = (h / 2) / Math.tan(cam.fov * Math.PI / 360), out = [];
    meshes.forEach(function (m) {
      if (!m || m.visible === false) return;
      var wv = worldVerts(m);
      m.faces.forEach(function (f, fi) {
        var a = wv[f[0]], bb = wv[f[1]], cc = wv[f[2]], n = cross(sub(bb, a), sub(cc, a));
        var len = Math.sqrt(dot(n, n)); if (len < 1e-9) return;
        n = [n[0] / len, n[1] / len, n[2] / len];
        var facing = dot(n, sub(cam.pos, a));
        if (facing <= 0) { if (!m.double) return; n = [-n[0], -n[1], -n[2]]; }
        var poly = [a, bb, cc].map(function (p) { var d = sub(p, cam.pos); return [dot(d, b.r), dot(d, b.u), dot(d, b.f)]; });
        var clipped = [], i;
        for (i = 0; i < 3; i++) {
          var p = poly[i], q = poly[(i + 1) % 3], pin = p[2] >= near, qin = q[2] >= near;
          if (pin) clipped.push(p);
          if (pin !== qin) { var t = (near - p[2]) / (q[2] - p[2]); clipped.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, near]); }
        }
        if (clipped.length < 3) return;
        var depth = 0; clipped.forEach(function (p) { depth += p[2]; }); depth /= clipped.length;
        var bright = 0.35 + 0.65 * Math.max(0, dot(n, light));
        if (m.emissive) bright = 1.15; else if (torchR > 0) bright += torchK * Math.max(0, 1 - depth / torchR);
        var base = Kit.color((m.colors && m.colors[fi]) || m.color);
        var fog = Kit.clamp((depth - fogNear) / (fogFar - fogNear), 0, 1);
        var col = Kit.mix([base[0] * bright, base[1] * bright, base[2] * bright], fogColor, fog);
        out.push({ depth: depth, ground: m.ground !== undefined ? !!m.ground : false, color: Kit.rgb(col), pts: clipped.map(function (p) { return [w / 2 + p[0] / p[2] * focal, h / 2 - p[1] / p[2] * focal]; }) });
      });
    });
    out.sort(function (x, y) { if (x.ground !== y.ground) return x.ground ? -1 : 1; return y.depth - x.depth; });
    out.forEach(function (poly) {
      c.beginPath(); c.moveTo(poly.pts[0][0], poly.pts[0][1]);
      for (var i = 1; i < poly.pts.length; i++) c.lineTo(poly.pts[i][0], poly.pts[i][1]);
      c.closePath(); c.fillStyle = poly.color; c.strokeStyle = poly.color; c.lineWidth = 1; c.fill(); c.stroke();
    });
    Kit.render3d.stats = { polygons: out.length };
    return out.length;
  };


  /* ---------- tested building blocks (dimension-agnostic: z defined means 3D and the ground plane is x,z) ---------- */
  Kit.flat = function (p) { return p.z !== undefined ? { x: p.x, y: p.z } : { x: p.x, y: p.y }; };
  Kit.near = function (a, b, r) { var A = Kit.flat(a), B = Kit.flat(b); return Kit.dist(A.x, A.y, B.x, B.y) <= r; };
  // Footprints of every mesh flagged solid in g.scene.meshes (rotation is ignored).
  Kit.solids = function (g) {
    var out = [], list = (g.scene && g.scene.meshes) || [];
    list.forEach(function (m) {
      if (!m || !m.solid || m.visible === false || !m.verts) return;
      var s = m.scale || [1, 1, 1], p = m.pos || [0, 0, 0], minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
      m.verts.forEach(function (v) {
        var x = v[0] * s[0] + p[0], z = v[2] * s[2] + p[2], y = v[1] * s[1] + p[1];
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; if (y < minY) minY = y; if (y > maxY) maxY = y;
      });
      out.push({ minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, minY: minY, maxY: maxY });
    });
    return out;
  };
  function blockedBy(solids, x, z, r) {
    for (var i = 0; i < solids.length; i++) { var a = solids[i]; if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r) return true; }
    return false;
  }
  // With jumping, a solid only blocks walking when its top is above the step height and it overlaps the body.
  function blockedVert(solids, x, z, r, feet) {
    for (var i = 0; i < solids.length; i++) {
      var a = solids[i];
      if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r && a.maxY > feet + 0.55 && a.minY < feet + 1.7) return true;
    }
    return false;
  }
  // Height of the highest surface under (x, z) that the feet can stand on (the floor is 0).
  function groundAt(solids, x, z, r, feet) {
    var h = 0;
    for (var i = 0; i < solids.length; i++) {
      var a = solids[i];
      if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r && a.maxY <= feet + 0.56 && a.maxY > h) h = a.maxY;
    }
    return h;
  }
  Kit.groundAt = function (g, x, z, feet) { return groundAt(Kit.solids(g), x, z, 0.35, feet === undefined ? 99 : feet); };
  // First-person controller: WASD, arrow or Q/E turning, drag to look, collision with solid meshes, bounds. Publishes g.player.
  Kit.fp = {
    update: function (g, dt, o) {
      o = o || {};
      var cam = g.scene.cam, speed = o.speed || 5, turn = o.turn || 1.8, r = o.radius || 0.45;
      cam.yaw += ((g.down("ArrowRight") || g.down("KeyE") ? 1 : 0) - (g.down("ArrowLeft") || g.down("KeyQ") ? 1 : 0)) * turn * dt;
      if (g.mouse.down) { cam.yaw += g.mouse.dx * 0.006; cam.pitch = Kit.clamp(cam.pitch - g.mouse.dy * 0.004, -0.8, 0.8); }
      var f = Kit.flatForward(cam), rt = Kit.flatRight(cam);
      var fwd = (g.down("KeyW") || g.down("ArrowUp") ? 1 : 0) - (g.down("KeyS") || g.down("ArrowDown") ? 1 : 0);
      var side = (g.down("KeyD") ? 1 : 0) - (g.down("KeyA") ? 1 : 0);
      var b = (g.world && g.world.bounds) || o.bounds || { minX: -25, maxX: 25, minZ: -25, maxZ: 25 }, solids = Kit.solids(g);
      var nx = Kit.clamp(cam.pos[0] + (f[0] * fwd + rt[0] * side) * speed * dt, b.minX, b.maxX);
      var nz = Kit.clamp(cam.pos[2] + (f[2] * fwd + rt[2] * side) * speed * dt, b.minZ, b.maxZ);
      var feet = cam.feet === undefined ? 0 : cam.feet, jump = !!o.jump;
      var hit = jump ? function (x, z) { return blockedVert(solids, x, z, r, feet); } : function (x, z) { return blockedBy(solids, x, z, r); };
      var stuck = hit(cam.pos[0], cam.pos[2]);
      if (stuck || !hit(nx, cam.pos[2])) cam.pos[0] = nx;
      if (stuck || !hit(cam.pos[0], nz)) cam.pos[2] = nz;
      var grounded = true;
      if (jump) {
        var vy = cam.vy || 0, ground = groundAt(solids, cam.pos[0], cam.pos[2], r * 0.8, feet);
        grounded = feet <= ground + 0.001 && vy <= 0;
        if (grounded) { feet = ground; vy = 0; if (g.down(o.jumpKey || "Space")) { vy = o.jumpSpeed || 9; grounded = false; } }
        if (!grounded) { vy -= (o.gravity || 24) * dt; feet += vy * dt; if (feet <= ground && vy <= 0) { feet = ground; vy = 0; grounded = true; } }
        cam.feet = feet; cam.vy = vy;
        cam.pos[1] = feet + (o.height || 1.6);
      } else cam.pos[1] = o.height || 1.6;
      cam.grounded = grounded;
      g.player = { x: cam.pos[0], y: cam.pos[1], z: cam.pos[2], yaw: cam.yaw, feet: feet, grounded: grounded };
      return g.player;
    }
  };
  // Moves p {x,y} with g.axis() (o.iso for isometric grids), inside bounds {minX,maxX,minZ,maxZ} (Z bounds y). Publishes g.player.
  Kit.mover = {
    update: function (g, dt, p, o) {
      o = o || {};
      var a = g.axis(), sp = (o.speed || 150) * dt, dx = o.iso ? (a.x + a.y) * sp : a.x * sp, dy = o.iso ? (a.y - a.x) * sp : a.y * sp;
      var b = o.bounds || { minX: 0, maxX: g.w, minZ: 0, maxZ: g.h };
      var nx = Kit.clamp(p.x + dx, b.minX, b.maxX), ny = Kit.clamp(p.y + dy, b.minZ, b.maxZ);
      if (!o.blocked || !o.blocked(nx, p.y)) p.x = nx;
      if (!o.blocked || !o.blocked(p.x, ny)) p.y = ny;
      g.player = { x: p.x, y: p.y };
      return p;
    }
  };
  // items: meshes (with pos) or points {x,y}. Touched items get collected=true and visible=false. Returns how many are left.
  Kit.pickups = {
    collect: function (g, items, o) {
      o = o || {};
      var p = g.player, left = 0, got = 0;
      items.forEach(function (it) {
        if (it.collected) return;
        var pos = it.pos ? { x: it.pos[0], y: it.pos[1], z: it.pos[2] } : it;
        if (it.pos) { it.rot = it.rot || [0, 0, 0]; it.rot[1] += (o.spin === undefined ? 2 : o.spin) * (g.dt || 0); it.emissive = true; if (!it.glow) it.glow = it.color || "#ffcf5c"; }
        var level = !(p && p.feet !== undefined && it.pos) || Math.abs(p.feet + 0.85 - it.pos[1]) < 1.3;
        if (p && level && Kit.near(p, pos, o.radius || 1.1)) {
          it.collected = true; it.visible = false; got++; g.score += o.value || 10; Kit.sfx("pickup");
          if (o.onPick) o.onPick(it);
        } else left++;
      });
      if (got && o.say !== false) g.say("Collected " + (items.length - left) + " of " + items.length, 1.5);
      return left;
    }
  };
  // Enemy (a mesh with pos, or a point {x,y}) that wanders, chases g.player inside sight, slides along solids. Returns "caught" within touch.
  Kit.chaser = {
    update: function (g, dt, e, o) {
      o = o || {};
      var p = g.player;
      if (!p) return null;
      var is3 = !!e.pos, ex = is3 ? e.pos[0] : e.x, ey = is3 ? e.pos[2] : e.y, P = Kit.flat(p);
      var d = Kit.dist(ex, ey, P.x, P.y), sight = o.sight || 12, touch = o.touch || 0.9, chasing = d < sight;
      var st = e.state = e.state || { heading: g.rand() * 6.283, t: 0 };
      st.t -= dt;
      var dx, dy;
      if (chasing) { dx = (P.x - ex) / (d || 1); dy = (P.y - ey) / (d || 1); }
      else { if (st.t <= 0) { st.heading = g.rand() * 6.283; st.t = 1 + g.rand() * 2; } dx = Math.cos(st.heading); dy = Math.sin(st.heading); }
      var sp = (o.speed || 2.5) * (chasing ? 1 : 0.5) * dt, nx = ex + dx * sp, ny = ey + dy * sp;
      var b = o.bounds || (g.world && g.world.bounds);
      if (b) { nx = Kit.clamp(nx, b.minX, b.maxX); ny = Kit.clamp(ny, b.minZ, b.maxZ); }
      var solids = is3 ? Kit.solids(g) : [], r = o.radius || 0.5;
      var trapped = blockedBy(solids, ex, ey, r);
      if (trapped || !blockedBy(solids, nx, ey, r)) ex = nx; else st.t = 0;
      if (trapped || !blockedBy(solids, ex, ny, r)) ey = ny; else st.t = 0;
      if (is3) { e.pos[0] = ex; e.pos[2] = ey; } else { e.x = ex; e.y = ey; }
      st.chasing = chasing;
      return Kit.dist(ex, ey, P.x, P.y) <= touch ? "caught" : null;
    }
  };

  /* ---------- game core ---------- */
  Game.module = function (name, def) {
    var i;
    for (i = 0; i < mods.length; i++) if (mods[i].name === name) { mods[i] = { name: name, def: def || {}, errs: 0, off: false }; return def; }
    mods.push({ name: name, def: def || {}, errs: 0, off: false });
    return def;
  };
  function call(m, fn, arg) {
    if (m.off || typeof m.def[fn] !== "function") return;
    current = m.name;
    try { m.def[fn](Game, arg); } catch (e) {
      m.errs++;
      if (Game.errors.length < 50) Game.errors.push(m.name + "." + fn + ": " + ((e && e.message) || e));
      if (m.errs >= 5) m.off = true;
      if (typeof console !== "undefined" && console.error) console.error(m.name + "." + fn, e);
    } finally { current = ""; }
  }
  function newScene() {
    var bg = (Game.config.palette && Game.config.palette.bg) || "#0b0f14";
    return { cam: Kit.camera3d({ pos: [0, 1.6, 8] }), meshes: [], sky: [bg, "#3b5a86"], fog: { near: 15, far: 50, color: bg } };
  }
  function initAll() { Game.data = {}; Game.hud = []; Game.scene = newScene(); playerValue = null; Game.playerBy = ""; Game.endInfo = null; Game.endMessage = ""; Game.world = null; Game.camera = null; mods.forEach(function (m) { m.errs = 0; m.off = false; call(m, "init"); }); }

  Game.down = function (code) { return !!held[code]; };
  Game.pressed = function (code) { return !!tapped[code]; };
  Game.axis = function () {
    var x = (Game.down("ArrowRight") || Game.down("KeyD") ? 1 : 0) - (Game.down("ArrowLeft") || Game.down("KeyA") ? 1 : 0);
    var y = (Game.down("ArrowDown") || Game.down("KeyS") ? 1 : 0) - (Game.down("ArrowUp") || Game.down("KeyW") ? 1 : 0);
    var l = Math.sqrt(x * x + y * y) || 1;
    return { x: x / l * (x || y ? 1 : 0), y: y / l * (x || y ? 1 : 0) };
  };
  Game.action = function () {
    return Game.pressed("Space") || Game.pressed("Enter") || Game.pressed("KeyZ") || Game.pressed("KeyE") || Game.pressed("KeyJ") || Game.mouse.clicked;
  };
  Game.say = function (text, secs) { banner = String(text); bannerTime = secs || 2; };
  Game.start = function () {
    Game.rand = Kit.rng((Date.now() | 0) || 7);
    Game.score = 0; Game.time = 0; Game.mode = "play"; modeTime = 0;
    initAll();
  };
  Game.end = function (win, message) {
    if (Game.mode !== "play") return;
    Game.endMessage = message ? String(message) : "";
    Game.endInfo = { win: !!win, by: current || "runtime", time: Game.time };
    Game.mode = win ? "win" : "over"; modeTime = 0; Kit.sfx(win ? "win" : "lose");
  };
  Game.restart = Game.start;
  Game.configure = function (cfg) {
    Game.config = Object.assign({ title: "Game", width: 800, height: 600, controls: [], palette: {} }, cfg || {});
    Game.config.palette = Object.assign({ bg: "#0b0f14", panel: "#18202a", accent: "#ffb454", text: "#f2f2f2", danger: "#ff5d5d" }, Game.config.palette || {});
    Game.w = Game.config.width; Game.h = Game.config.height;
  };

  function step(dt) {
    modeTime += dt;
    var go = Game.pressed("Enter") || Game.action();
    if (Game.mode === "title") { if (go) Game.start(); return; }
    if (Game.mode === "paused") { if (Game.pressed("Escape") || Game.pressed("KeyP")) Game.mode = "play"; return; }
    if (Game.mode === "over" || Game.mode === "win") { if (modeTime > 0.5 && (go || Game.pressed("KeyR"))) Game.start(); return; }
    if (Game.pressed("Escape") || Game.pressed("KeyP")) { Game.mode = "paused"; return; }
    Game.time += dt; Game.dt = dt; Game.hud.length = 0; Game._playerWrites = 0;
    mods.forEach(function (m) { call(m, "update", dt); });
  }
  function wrap(text, n) {
    var words = String(text).split(" "), out = [], line = "";
    words.forEach(function (w) { if ((line + " " + w).trim().length > n) { out.push(line); line = w; } else line = (line + " " + w).trim(); });
    if (line) out.push(line);
    return out;
  }
  function overlay(title, lines) {
    var p = Game.config.palette;
    ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(0, 0, Game.w, Game.h);
    Kit.text(ctx, title, Game.w / 2, Game.h * 0.3, { size: 44, align: "center", color: p.accent });
    lines.forEach(function (l, i) { Kit.text(ctx, l, Game.w / 2, Game.h * 0.3 + 70 + i * 26, { size: 18, align: "center", bold: false }); });
  }
  function render() {
    var p = Game.config.palette;
    ctx.fillStyle = p.bg; ctx.fillRect(0, 0, Game.w, Game.h);
    var sc = Game.scene;
    if (sc && sc.meshes.length) {
      Kit.sky(ctx, Game.w, Game.h, sc.sky[0], sc.sky[1]);
      Kit.render3d(ctx, sc.cam, sc.meshes, { width: Game.w, height: Game.h, fogColor: sc.fog.color, fogNear: sc.fog.near, fogFar: sc.fog.far });
      var glows = 0;
      sc.meshes.forEach(function (m) {
        if (!m || !m.glow || m.visible === false || glows >= 40 || !m.pos) return;
        var q = Kit.project3d(sc.cam, m.pos, Game.w, Game.h);
        if (!q || q.depth > 45) return;
        glows++;
        var rad = Math.min(170, 110 * (m.glowSize || 1) / q.depth + 14), gr = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, rad);
        gr.addColorStop(0, Kit.alpha(m.glow, 0.5)); gr.addColorStop(1, Kit.alpha(m.glow, 0));
        ctx.fillStyle = gr; ctx.fillRect(q.x - rad, q.y - rad, rad * 2, rad * 2);
      });
    }
    // Text that modules draw in the HUD corner would overlap the runtime HUD, so it becomes a (deduplicated) HUD line instead.
    var realFill = ctx.fillText, captured = [];
    ctx.fillText = function (str, x, y) { if (x < 320 && y < 80) { captured.push(String(str)); return; } return realFill.apply(this, arguments); };
    var shifted = !!Game.camera;
    if (shifted) { ctx.save(); ctx.translate(-Game.camera.x, -(Game.camera.y || 0)); }
    try { mods.forEach(function (m) { call(m, "draw", ctx); }); } finally { delete ctx.fillText; if (shifted) ctx.restore(); }
    captured.forEach(function (line) { if (Game.hud.indexOf(line) < 0) Game.hud.push(line); });
    Game.hud.forEach(function (l, i) { Kit.text(ctx, l, 12, 10 + i * 22, { size: 18 }); });
    if (bannerTime > 0 && Game.mode === "play") Kit.text(ctx, banner, Game.w / 2, 18, { size: 22, align: "center", color: p.accent });
    if (Game.mode === "title") overlay(Game.config.title, (Game.config.pitch ? wrap(Game.config.pitch, 64).concat([""]) : []).concat(Game.config.controls || []).concat(["", "Press Enter or click to play"]));
    else if (Game.mode === "paused") overlay("Paused", ["Press P or Escape to resume"]);
    else if (Game.mode === "over") overlay("Game over", (Game.endMessage ? [Game.endMessage] : []).concat(["Score " + Game.score, "Press Enter or click to try again"]));
    else if (Game.mode === "win") overlay("You win!", (Game.endMessage ? [Game.endMessage] : []).concat(["Score " + Game.score, "Press Enter or click to play again"]));
  }
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0.001, ((now || 0) - (last || now || 0)) / 1000));
    last = now || 0; Game.frames++;
    if (bannerTime > 0) bannerTime -= dt;
    step(dt); render();
    tapped = {}; Game.mouse.clicked = false; Game.mouse.dx = 0; Game.mouse.dy = 0;
    root.requestAnimationFrame(frame);
  }
  function pointer(e, type) {
    var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: canvas.width, height: canvas.height };
    var x = ((e.clientX || 0) - r.left) * (canvas.width / (r.width || canvas.width));
    var y = ((e.clientY || 0) - r.top) * (canvas.height / (r.height || canvas.height));
    if (type === "move" && Game.mouse.down) { Game.mouse.dx += x - Game.mouse.x; Game.mouse.dy += y - Game.mouse.y; }
    Game.mouse.x = x; Game.mouse.y = y;
    if (type === "down") { Game.mouse.down = true; Game.mouse.clicked = true; }
    if (type === "up") Game.mouse.down = false;
  }
  Game.boot = function () {
    canvas = document.getElementById("game");
    if (!canvas) { canvas = document.createElement("canvas"); canvas.id = "game"; document.body.appendChild(canvas); }
    canvas.width = Game.w; canvas.height = Game.h;
    ctx = canvas.getContext("2d");
    document.addEventListener("keydown", function (e) {
      var c = e.code || e.key; if (!held[c]) tapped[c] = true; held[c] = true;
      if (/^(Arrow|Space)/.test(c) && e.preventDefault) e.preventDefault();
    });
    document.addEventListener("keyup", function (e) { held[e.code || e.key] = false; });
    canvas.addEventListener("pointerdown", function (e) { pointer(e, "down"); });
    canvas.addEventListener("pointermove", function (e) { pointer(e, "move"); });
    canvas.addEventListener("pointerup", function () { Game.mouse.down = false; });
    Game.rand = Kit.rng(12345);
    Game.mode = "title";
    initAll();
    root.requestAnimationFrame(frame);
  };
  Game._frame = frame;
  root.Game = Game; root.Kit = Kit;
})();
