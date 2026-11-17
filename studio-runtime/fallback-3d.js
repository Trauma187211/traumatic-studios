Game.module("echoHall", {
  init: function (g) {
    var pal = g.config.palette, s = g.scene, i, m, gems = [];
    g.world = { bounds: { minX: -19, maxX: 19, minZ: -19, maxZ: 19 } };
    s.cam.pos = [0, 1.6, 8];
    s.meshes.push(Kit.mesh.plane(40, 40, "#2a3442", "#222b36", 16));
    for (i = 0; i < 10; i++) {
      m = Kit.mesh.box(1.2, 4, 1.2, "#6a7a8c");
      m.pos = [(i % 2 ? 1 : -1) * (4 + g.rand() * 10), 2, -2 - (i * 1.8)];
      m.solid = true;
      s.meshes.push(m);
    }
    for (i = 0; i < 6; i++) {
      m = Kit.mesh.box(0.6, 0.6, 0.6, pal.accent);
      m.pos = [(g.rand() - 0.5) * 30, 1.2, 4 - g.rand() * 24];
      gems.push(m); s.meshes.push(m);
    }
    g.data.echohall = { gems: gems };
  },
  update: function (g, dt) {
    Kit.fp.update(g, dt, { speed: 5 });
    var left = Kit.pickups.collect(g, g.data.echohall.gems, { radius: 1.2, value: 25 });
    g.hud.push("Lanterns left: " + left);
    if (left === 0) g.end(true);
  }
});
Game.module("stalker", {
  init: function (g) {
    var m = Kit.mesh.pyramid(1, 2, 1, "#aa2233");
    m.pos = [9, 1, -10];
    g.scene.meshes.push(m);
    g.data.stalker = { mesh: m };
  },
  update: function (g, dt) {
    if (Kit.chaser.update(g, dt, g.data.stalker.mesh, { speed: 2.6, sight: 14, touch: 1 }) === "caught") { Kit.sfx("hit"); g.end(false); }
  }
});
