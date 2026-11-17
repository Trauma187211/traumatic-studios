Game.module("Backdrop", {
  init: function (g) {
    var i, d = g.data.backdrop = { clouds: [], trees: [] };
    for (i = 0; i < 14; i++) d.clouds.push({ x: g.rand() * g.w * 3.2, y: 40 + g.rand() * 120, w: 70 + g.rand() * 80 });
    for (i = 0; i < 24; i++) d.trees.push({ x: g.rand() * g.w * 3.2, h: 40 + g.rand() * 50 });
  },
  draw: function (g, ctx) {
    var d = g.data.backdrop, groundY = g.h - 70;
    d.clouds.forEach(function (c) { ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.fillRect(c.x, c.y, c.w, 18); ctx.fillRect(c.x + 14, c.y - 10, c.w * 0.6, 14); });
    d.trees.forEach(function (t) { ctx.fillStyle = "#1c2b2a"; ctx.fillRect(t.x, groundY - t.h, 8, t.h); ctx.beginPath(); ctx.arc(t.x + 4, groundY - t.h, 20, 0, 6.283); ctx.fill(); });
  }
});
