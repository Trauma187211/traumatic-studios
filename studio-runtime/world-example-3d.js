Game.module("Hall", {
  init: function (g) {
    var s = g.scene, i, m;
    g.world = { bounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 } };
    s.cam.pos = [0, 1.6, 12];
    s.sky = ["#0a0f1a", "#2a3b5c"];
    s.meshes.push(Kit.mesh.plane(40, 40, "#2a3442", "#222b36", 16));
    for (i = 0; i < 12; i++) {
      m = Kit.mesh.box(1.4, 4, 1.4, "#6a7a8c");
      m.pos = [(g.rand() - 0.5) * 32, 2, (g.rand() - 0.5) * 24 - 2];
      m.solid = true;
      s.meshes.push(m);
    }
  }
});
