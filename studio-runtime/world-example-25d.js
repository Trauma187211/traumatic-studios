Game.module("Courtyard", {
  init: function (g) {
    var i, d = g.data.courtyard = { posts: [] };
    Kit.iso.ox = g.w / 2; Kit.iso.oy = 100;
    g.world = { bounds: { minX: 0.6, maxX: 7.4, minZ: 0.6, maxZ: 7.4 } };
    for (i = 0; i < 8; i++) d.posts.push({ x: Math.floor(g.rand() * 8), y: Math.floor(g.rand() * 8) });
  },
  draw: function (g, ctx) {
    var pal = g.config.palette, k, gx, gy, d = g.data.courtyard;
    for (k = 0; k < 16; k++) for (gx = 0; gx < 8; gx++) {
      gy = k - gx; if (gy < 0 || gy >= 8) continue;
      Kit.iso.block(ctx, gx, gy, 0, 6, (gx + gy) % 2 ? pal.panel : "#2c3a4a");
      d.posts.forEach(function (p) { if (p.x === gx && p.y === gy) Kit.iso.block(ctx, gx, gy, 6, 14, "#5b6b7d"); });
    }
  }
});
