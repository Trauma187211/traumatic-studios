Game.module("lanternHollow", {
  init: function (g) {
    var d = g.data.lanternhollow = { p: { x: g.w / 2, y: g.h / 2, r: 12 }, hp: 3, inv: 0, orbs: [], foes: [] };
    var i;
    for (i = 0; i < 8; i++) d.orbs.push({ x: 60 + g.rand() * (g.w - 120), y: 60 + g.rand() * (g.h - 120), r: 8 });
    for (i = 0; i < 4; i++) d.foes.push({ x: i % 2 ? 30 : g.w - 30, y: 40 + g.rand() * (g.h - 80), r: 14 });
  },
  update: function (g, dt) {
    var d = g.data.lanternhollow;
    Kit.mover.update(g, dt, d.p, { speed: 190, bounds: { minX: 12, maxX: g.w - 12, minZ: 12, maxZ: g.h - 12 } });
    d.inv = Math.max(0, d.inv - dt);
    var left = Kit.pickups.collect(g, d.orbs, { radius: 20, value: 10 });
    d.foes.forEach(function (f) {
      if (Kit.chaser.update(g, dt, f, { speed: 70, sight: 9999, touch: 26 }) === "caught" && d.inv <= 0) {
        d.hp--; d.inv = 1.2; Kit.sfx("hit");
        if (d.hp <= 0) g.end(false);
      }
    });
    if (left === 0) g.end(true);
    g.hud.push("Lanterns left: " + left, "Health: " + d.hp);
  },
  draw: function (g, ctx) {
    var d = g.data.lanternhollow, pal = g.config.palette;
    d.orbs.forEach(function (o) { if (o.collected) return; ctx.fillStyle = pal.accent; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 6.283); ctx.fill(); });
    d.foes.forEach(function (f) { ctx.fillStyle = "#3b2f4a"; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill(); });
    ctx.fillStyle = d.inv > 0 && Math.floor(g.time * 12) % 2 ? "#ffffff55" : pal.text;
    ctx.beginPath(); ctx.arc(d.p.x, d.p.y, d.p.r, 0, 6.283); ctx.fill();
  }
});
