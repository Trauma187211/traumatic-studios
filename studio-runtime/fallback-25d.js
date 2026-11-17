Game.module("crystalCourt", {
  init: function (g) {
    Kit.iso.ox = g.w / 2; Kit.iso.oy = 90;
    var d = g.data.crystalcourt = { n: 8, p: { x: 1.5, y: 1.5 }, walls: [], gems: [], foe: { x: 6.5, y: 6.5 } };
    var i, x, y;
    for (i = 0; i < 9; i++) { x = 1 + Math.floor(g.rand() * 6); y = 1 + Math.floor(g.rand() * 6); if (x + y > 3 && x + y < 12) d.walls.push({ x: x, y: y }); }
    for (i = 0; i < 6; i++) d.gems.push({ x: 1.5 + Math.floor(g.rand() * 6), y: 1.5 + Math.floor(g.rand() * 6) });
  },
  update: function (g, dt) {
    var d = g.data.crystalcourt, b = { minX: 0.3, maxX: 7.7, minZ: 0.3, maxZ: 7.7 };
    var hit = function (x, y) { return d.walls.some(function (w) { return x > w.x && x < w.x + 1 && y > w.y && y < w.y + 1; }); };
    Kit.mover.update(g, dt, d.p, { iso: true, speed: 2.2, bounds: b, blocked: hit });
    var left = Kit.pickups.collect(g, d.gems, { radius: 0.6, value: 25 });
    if (Kit.chaser.update(g, dt, d.foe, { speed: 1.3, sight: 7, touch: 0.5, bounds: b }) === "caught") { Kit.sfx("hit"); g.end(false); }
    if (left === 0) g.end(true);
    g.hud.push("Crystals left: " + left);
  },
  draw: function (g, ctx) {
    var d = g.data.crystalcourt, pal = g.config.palette, gx, gy, k, ts = Kit.iso.toScreen;
    for (k = 0; k < d.n * 2; k++) for (gx = 0; gx < d.n; gx++) {
      gy = k - gx; if (gy < 0 || gy >= d.n) continue;
      Kit.iso.block(ctx, gx, gy, 0, 6, (gx + gy) % 2 ? pal.panel : "#2c3a4a");
      d.walls.forEach(function (w) { if (w.x === gx && w.y === gy) Kit.iso.block(ctx, gx, gy, 6, 34, "#5b6b7d"); });
      d.gems.forEach(function (gem) {
        if (!gem.collected && Math.floor(gem.x) === gx && Math.floor(gem.y) === gy) {
          var s = ts(gem.x, gem.y, 18 + Math.sin(g.time * 3) * 4);
          ctx.fillStyle = pal.accent; ctx.beginPath(); ctx.moveTo(s.x, s.y - 12); ctx.lineTo(s.x + 8, s.y); ctx.lineTo(s.x, s.y + 12); ctx.lineTo(s.x - 8, s.y); ctx.closePath(); ctx.fill();
        }
      });
      if (Math.floor(d.foe.x) === gx && Math.floor(d.foe.y) === gy) {
        var f = ts(d.foe.x, d.foe.y, 6); ctx.fillStyle = "#aa2233"; ctx.fillRect(f.x - 8, f.y - 26, 16, 22);
      }
      if (Math.floor(d.p.x) === gx && Math.floor(d.p.y) === gy) {
        var q = ts(d.p.x, d.p.y, 6);
        ctx.fillStyle = "#00000055"; ctx.beginPath(); ctx.ellipse(q.x, q.y, 14, 7, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = pal.text; ctx.fillRect(q.x - 7, q.y - 30, 14, 26);
      }
    }
  }
});
