Game.module("Yard", {
  init: function (g) {
    var i, d = g.data.yard = { stones: [] };
    for (i = 0; i < 10; i++) d.stones.push({ x: 60 + g.rand() * (g.w - 120), y: 60 + g.rand() * (g.h - 120), r: 6 + g.rand() * 10 });
  },
  draw: function (g, ctx) {
    var pal = g.config.palette;
    ctx.fillStyle = pal.panel; ctx.fillRect(16, 16, g.w - 32, g.h - 32);
    g.data.yard.stones.forEach(function (st) { ctx.fillStyle = "#44546a"; ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 6.283); ctx.fill(); });
  }
});
