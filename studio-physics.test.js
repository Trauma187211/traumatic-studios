process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const syncFs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DIR = path.join(__dirname, "studio-runtime");
const code = ["runtime.js", "director.js", "side.js"].map((f) => syncFs.readFileSync(path.join(DIR, f), "utf8")).join("\n");

function makeGame({ dimension, gameplay, modules = "", beforeStart }) {
  const handlers = {}, calls = { translate: [] };
  const on = (type, fn) => (handlers[type] = handlers[type] || []).push(fn);
  const ctx = new Proxy({}, { get: (t, k) => (k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} }) : k === "measureText" ? (s) => ({ width: String(s).length * 7 }) : k === "translate" ? (x, y) => calls.translate.push([x, y]) : () => {}), set: () => true });
  let raf = null;
  const canvas = { width: 800, height: 600, getContext: () => ctx, addEventListener: on, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  const sandbox = { document: { getElementById: () => canvas, addEventListener: on, body: { appendChild() {} } }, console, requestAnimationFrame: (fn) => { raf = fn; }, Date, Math, Object, Array, JSON };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const config = { title: "T", width: dimension === "3d" ? 960 : 800, height: dimension === "3d" ? 540 : 600, dimension, gameplay };
  vm.runInContext(`${code}\nGame.configure(${JSON.stringify(config)});\nGame.director("pre");\n(function () {\n${modules}\n})();\nGame.director();\nGame.boot();`, sandbox);
  let t = 1000;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { const cb = raf; raf = null; t += 16.7; cb(t); } };
  const key = (c, down) => (handlers[down ? "keydown" : "keyup"] || []).forEach((h) => h({ code: c, key: c, preventDefault() {} }));
  const { Game, Kit } = sandbox;
  step();
  if (beforeStart) beforeStart({ Game, Kit });
  if (beforeStart) { Game.start(); } else { key("Enter", true); key("Enter", false); }
  step(2);
  const press = (c) => { key(c, true); step(); key(c, false); };
  return { Game, Kit, step, key, press, calls, cam: () => Game.scene.cam, d: () => Game.data.zdirector, s: () => Game.data.zside };
}
const gp = (extra) => ({ goal: { type: "exit" }, threat: { type: "timer", seconds: 600 }, player: {}, ...extra });
const floorOnly = 'Game.module("Floor", { init: function (g) { g.scene.meshes.push(Kit.mesh.plane(60, 60, "#222222", "#333333", 4)); g.world = { bounds: { minX: -25, maxX: 25, minZ: -25, maxZ: 25 } }; } });';
const platform = (x, z, w, d, h) => `Game.module("Plat${Math.abs(Math.round(x * 10))}", { init: function (g) { var m = Kit.mesh.box(${w}, ${h}, ${d}, "#778899"); m.pos = [${x}, ${h / 2}, ${z}]; m.solid = true; g.scene.meshes.push(m); } });`;

/* ---------------- 3D: jumping and platforms ---------------- */
test("3D jump arc: about 1.7 units high, back on the floor, and gravity pulls you down", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp({ player: { jumps: true } }), modules: floorOnly });
  const { Game, step, key, cam } = game;
  let peak = 0;
  key("Space", true);
  for (let i = 0; i < 70; i++) { step(); peak = Math.max(peak, Game.player.feet); if (i > 5) key("Space", false); }
  assert.ok(peak > 1.4 && peak < 2.0, `peak ${peak}`);
  step(40);
  assert.ok(Game.player.feet < 0.01 && Game.player.grounded, "landed");
  cam().feet = 6; cam().vy = 0; step(60);
  assert.ok(Game.player.feet < 0.01, "falls to the floor");
  assert.equal(Math.round(cam().pos[1] * 10) / 10, 1.6);
});

test("3D platforms: a 1.2 high ledge blocks walking but can be jumped onto and stood on", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp({ player: { jumps: true } }), modules: floorOnly + platform(0, -6, 6, 6, 1.2) });
  const { Game, step, key, cam } = game;
  cam().pos = [0, 1.6, 1]; cam().yaw = 0;
  key("KeyW", true); step(90); key("KeyW", false);
  assert.ok(Game.player.z > -2.6, `walking into the ledge is blocked, z=${Game.player.z}`);
  key("KeyW", true); key("Space", true); step(30); key("Space", false); step(8); key("KeyW", false); step(30);
  assert.ok(Game.player.z < -3, `climbed on, z=${Game.player.z}`);
  assert.ok(Math.abs(Game.player.feet - 1.2) < 0.05 && Game.player.grounded, `standing on the ledge, feet=${Game.player.feet}`);
  key("KeyW", true); step(120); key("KeyW", false);
  assert.ok(Game.player.feet < 0.05, "walking off the far edge drops back to the floor");
});

test("3D without jumping keeps the old behaviour: solids block regardless of height and the eye height is fixed", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp(), modules: floorOnly + platform(0, -6, 6, 6, 0.3) });
  game.cam().pos = [0, 1.6, 1];
  game.key("KeyW", true); game.step(90); game.key("KeyW", false);
  assert.ok(game.Game.player.z > -2.6, "even a low block stops a player who cannot jump");
  game.key("Space", true); game.step(20); game.key("Space", false);
  assert.equal(game.Game.player.feet, 0);
});

test("items go on platforms when the player can jump, and are only reachable from the right height", () => {
  const modules = floorOnly + platform(0, -8, 6, 6, 1.4) + platform(8, 4, 6, 6, 1.0);
  const game = makeGame({ dimension: "3d", gameplay: gp({ goal: { type: "collect", label: "gems", count: 6 }, player: { jumps: true } }), modules, beforeStart: ({ Kit }) => { Kit.rng = () => () => 0.1; } });
  const { Game, step, cam, d } = game;
  assert.ok(Game.config.controls.includes("Space: jump"));
  const high = d().items.filter((m) => m.pos[1] > 2);
  assert.ok(high.length >= 1, "some gems sit on top of platforms");
  const gem = high[0];
  cam().pos[0] = gem.pos[0]; cam().pos[2] = gem.pos[2]; cam().feet = 0; cam().vy = 0; step(3);
  assert.notEqual(gem.collected, true, "from underneath the platform it cannot be grabbed");
  cam().feet = gem.pos[1] - 1.1; cam().vy = 0; step(2);
  assert.equal(gem.collected, true, "standing on the platform it can");
});

/* ---------------- 3D: building ---------------- */
test("building: place blocks on the ground, they are solid, breaking returns them, and enough blocks win", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp({ goal: { type: "build", count: 2 }, threat: { type: "none" } }), modules: floorOnly });
  const { Game, step, press, cam, d } = game;
  assert.equal(d().spec.player.builds, true); assert.equal(d().spec.player.jumps, true, "building implies jumping so you can climb");
  assert.equal(d().target, 6);
  assert.ok(Game.config.controls.some((c) => /place a block/.test(c)));
  const start = d().blocksLeft;
  cam().pos = [0, 1.6, 5]; cam().yaw = 0; cam().pitch = -0.6; step();
  press("KeyB");
  assert.equal(d().placed, 1); assert.equal(d().blocksLeft, start - 1);
  const block = Object.values(d().blocks)[0];
  assert.equal(block.solid, true);
  assert.ok(Game.scene.meshes.includes(block));
  assert.ok(Game.hud.some((l) => /Blocks placed: 1\/6/.test(l)));
  press("KeyV");
  assert.equal(d().placed, 0); assert.equal(d().blocksLeft, start);
  assert.ok(!Game.scene.meshes.includes(block));
  for (let i = 0; i < 6; i++) { cam().pos = [i * 1.6 - 4, 1.6, 5]; cam().pitch = -0.6; step(); press("KeyB"); }
  step(2);
  assert.equal(Game.mode, "win");
  assert.match(Game.endMessage, /build is complete/);
});

test("building: you cannot place a block inside yourself, out of thin air, or beyond your supply", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp({ goal: { type: "build", count: 1 }, threat: { type: "none" } }), modules: floorOnly });
  const { step, press, cam, d } = game;
  cam().pos = [0, 1.6, 5]; cam().pitch = 0; step(); press("KeyB");
  assert.equal(d().placed, 0, "looking at the horizon there is nothing to build on");
  cam().pitch = -1.45; step(); press("KeyB");
  assert.equal(d().placed, 0, "straight down is your own cell");
  d().blocksLeft = 0; cam().pitch = -0.6; step(); press("KeyB");
  assert.equal(d().placed, 0, "no blocks in hand");
});

test("building: collecting gives blocks, and a block you stand next to can be climbed with a jump", () => {
  const game = makeGame({ dimension: "3d", gameplay: gp({ goal: { type: "collect", label: "ore", count: 3 }, threat: { type: "timer", seconds: 600 }, player: { builds: true } }), modules: floorOnly });
  const { Game, step, key, cam, d } = game;
  const before = d().blocksLeft, item = d().items[0];
  cam().pos[0] = item.pos[0]; cam().pos[2] = item.pos[2]; step(2);
  assert.equal(d().blocksLeft, before + 2);
  Game.scene.meshes.push(Object.assign(Game.Kit ? {} : {}, (() => { const m = game.Kit.mesh.box(2, 1, 2, "#889"); m.pos = [30, 0.5, 30]; m.solid = true; return m; })()));
  const step1 = game.Kit.mesh.box(2, 1, 2, "#889"); step1.pos = [0, 0.5, -3]; step1.solid = true; Game.scene.meshes.push(step1);
  cam().pos = [0, 1.6, 1]; cam().yaw = 0; cam().feet = 0; step();
  key("KeyW", true); key("Space", true); step(30); key("Space", false); step(6); key("KeyW", false); step(30);
  assert.ok(Math.abs(Game.player.feet - 1) < 0.05, `stood on the one-block step, feet=${Game.player.feet}`);
});

test("enemies trapped inside a freshly placed block can walk out", () => {
  const { Game, Kit } = makeGame({ dimension: "3d", gameplay: gp(), modules: floorOnly });
  const wall = Kit.mesh.box(4, 3, 4, "#889"); wall.pos = [0, 1.5, 0]; wall.solid = true; Game.scene.meshes.push(wall);
  Game.player = { x: 10, y: 1.6, z: 0 };
  const foe = Kit.mesh.pyramid(1, 2, 1, "#a23"); foe.pos = [0.5, 1, 0];
  for (let i = 0; i < 80; i++) Kit.chaser.update(Game, 0.1, foe, { speed: 3, sight: 30, touch: 0.1 });
  assert.ok(foe.pos[0] > 2.6, `escaped to x=${foe.pos[0]}`);
});

/* ---------------- 2D side-scroller ---------------- */
const side = (extra = {}) => ({ view: "side", goal: { type: "collect", label: "coins", count: 4 }, threat: { type: "patrol", count: 2, speed: "slow" }, player: { health: 3, jumps: true }, ...extra });
const walkers = (game) => game.s().walkers;

test("side-scroller: gravity lands you on the ground, a held jump reaches about 129px, a tap is a short hop", () => {
  const game = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "none" } }) });
  const { step, key, press, s } = game, p = s().p;
  p.y = s().gy - 300; p.vy = 0; step(80);
  assert.ok(p.grounded && Math.abs(p.y - (s().gy - p.h)) < 0.5, "landed on the ground");
  let apex = 0, top = p.y;
  key("Space", true);
  for (let i = 0; i < 60; i++) { step(); apex = Math.max(apex, top - p.y); }
  key("Space", false); step(40);
  assert.ok(apex > 105 && apex < 140, `held jump apex ${apex}`);
  let hop = 0; press("Space");
  for (let i = 0; i < 60; i++) { step(); hop = Math.max(hop, top - p.y); }
  assert.ok(hop > 20 && hop < 75, `tap hop ${hop}`);
});

test("side-scroller: a jump pressed just after running off a ledge still works (coyote time)", () => {
  const game = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "none" } }) });
  const { step, key, press, s } = game, p = s().p, seg = s().ground[0];
  p.x = seg.x + seg.w - 40; p.y = seg.y - p.h; step(2);
  key("KeyD", true);
  let guard = 0; while (p.grounded && guard++ < 200) step();
  key("KeyD", false);
  assert.equal(p.grounded, false);
  press("Space");
  assert.ok(p.vy < -300, `jumped in the air, vy=${p.vy}`);
});

test("side-scroller: falling into a pit costs a heart and puts you back on solid ground", () => {
  const game = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "none" } }) });
  const { Game, step, s } = game, p = s().p, a = s().ground[0], b = s().ground[1];
  p.x = (a.x + a.w + b.x) / 2 - p.w / 2; p.y = a.y - p.h - 4; step(2);
  step(120);
  assert.equal(s().hp, 2);
  assert.equal(Game.mode, "play");
  assert.ok(p.y < s().gy && p.x < a.x + a.w, "respawned on the last safe ground");
});

test("side-scroller: landing on a walker stomps it and bounces; touching it from the side hurts", () => {
  const game = makeGame({ dimension: "2d", gameplay: side() });
  const { Game, step, s } = game, p = s().p, e = walkers(game)[0];
  e.speed = 0; e.x = 200; e.y = s().gy - e.h; e.s = s().ground[0];
  p.x = 200; p.y = e.y - p.h - 20; p.vy = 350; Game.score = 0; step(6);
  assert.equal(e.alive, false); assert.equal(Game.score, 100); assert.ok(p.vy < 0, "bounced");
  const f = walkers(game)[1]; f.speed = 0; f.x = 230; f.y = s().gy - f.h; f.s = s().ground[0]; step(60);
  p.x = 232; p.y = s().gy - p.h; p.vy = 0; p.vx = 0; s().inv = 0; const hp = s().hp; step(2);
  assert.equal(s().hp, hp - 1);
});

test("side-scroller: coins win, keys unlock the flag, the flag wins, stomping everything wins", () => {
  const coins = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "none" } }) });
  for (const it of coins.s().items) { coins.s().p.x = it.x - 12; coins.s().p.y = it.y - 18; coins.s().p.vy = 0; coins.step(2); }
  coins.step(2);
  assert.equal(coins.Game.mode, "win"); assert.match(coins.Game.endMessage, /collected everything/);

  const keys = makeGame({ dimension: "2d", gameplay: side({ goal: { type: "keys", label: "keys", count: 2 }, threat: { type: "none" } }) });
  const flag = keys.s().exit;
  keys.s().p.x = flag.x - 10; keys.s().p.y = flag.y; keys.step(3);
  assert.equal(keys.Game.mode, "play", "a locked flag does not win");
  for (const it of keys.s().items) { keys.s().p.x = it.x - 12; keys.s().p.y = it.y - 18; keys.s().p.vy = 0; keys.step(2); }
  assert.equal(keys.s().exit.locked, false);
  keys.s().p.x = flag.x - 10; keys.s().p.y = flag.y; keys.step(3);
  assert.equal(keys.Game.mode, "win");

  const exit = makeGame({ dimension: "2d", gameplay: side({ goal: { type: "survive", seconds: 60 }, threat: { type: "none" } }) });
  assert.equal(exit.s().spec.goal.type, "exit", "a survive goal becomes reach-the-flag in side view");
  exit.s().p.x = exit.s().exit.x - 10; exit.s().p.y = exit.s().exit.y; exit.step(3);
  assert.equal(exit.Game.mode, "win");

  const defeat = makeGame({ dimension: "2d", gameplay: side({ goal: { type: "defeat", count: 2 }, threat: { type: "patrol", count: 2, speed: "slow" } }) });
  for (let guard = 0; guard < 200 && defeat.Game.mode === "play"; guard++) {
    const e = walkers(defeat).find((w) => w.alive); if (!e) break;
    const p = defeat.s().p; e.speed = 0; p.x = e.x; p.y = e.y - p.h - 2; p.vy = 300; defeat.s().inv = 5; defeat.step(1);
  }
  defeat.step(2);
  assert.equal(defeat.Game.mode, "win"); assert.match(defeat.Game.endMessage, /is down/);
});

test("side-scroller: spikes hurt, running out of hearts loses, a timer loses, and the camera follows the player", () => {
  const game = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "hazards", count: 3 }, player: { health: 1, jumps: true } }) });
  const { Game, step, s } = game, p = s().p;
  assert.equal(Game.camera.x, 0);
  assert.ok(s().spikes.length >= 3);
  p.x = 1500; p.y = s().gy - p.h - 200; step(40);
  assert.ok(Game.camera.x > 1000 && Game.camera.x <= s().W - Game.w, `camera x ${Game.camera.x}`);
  const sk = s().spikes[0]; p.x = sk.x; p.y = sk.y - p.h + 6; p.vy = 0; s().inv = 0; step(2);
  assert.equal(Game.mode, "over"); assert.ok(Game.endMessage.length > 0);
  const timed = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "timer", seconds: 60 } }) });
  timed.s().elapsed = timed.s().limit; timed.step(2);
  assert.equal(timed.Game.mode, "over"); assert.match(timed.Game.endMessage, /Time ran out/);
});

test("side-scroller: world modules draw in scrolled coordinates, and the title screen lists the controls", () => {
  const decor = 'Game.module("Decor", { draw: function (g, ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(100, 100, 10, 10); } });';
  const game = makeGame({ dimension: "2d", gameplay: side({ threat: { type: "none" } }), modules: decor });
  game.s().p.x = 1200; game.step(40);
  assert.ok(game.calls.translate.some(([x]) => x < -500), "module drawing is shifted by the camera");
  assert.ok(game.Game.config.controls.some((c) => /jump/.test(c)));
  assert.deepEqual([...game.Game.errors], []);
});
