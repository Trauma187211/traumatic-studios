process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const syncFs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DIR = path.join(__dirname, "studio-runtime");
const runtime = syncFs.readFileSync(path.join(DIR, "runtime.js"), "utf8");
const directorCode = syncFs.readFileSync(path.join(DIR, "director.js"), "utf8");

// Runs a game in this process so tests can teleport, press keys and read state.
function makeGame({ dimension, gameplay, modules = "" }) {
  const handlers = {};
  const on = (type, fn) => (handlers[type] = handlers[type] || []).push(fn);
  const ctx = new Proxy({}, { get: (t, k) => (k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} }) : k === "measureText" ? (s) => ({ width: String(s).length * 7 }) : () => {}), set: () => true });
  let raf = null;
  const canvas = { width: 800, height: 600, getContext: () => ctx, addEventListener: on, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  const sandbox = { document: { getElementById: () => canvas, addEventListener: on, body: { appendChild() {} } }, console, requestAnimationFrame: (fn) => { raf = fn; }, Date, Math, Object, Array, JSON };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const config = { title: "T", width: dimension === "3d" ? 960 : 800, height: dimension === "3d" ? 540 : 600, dimension, gameplay };
  vm.runInContext(`${runtime}\n${directorCode}\nGame.configure(${JSON.stringify(config)});\nGame.director("pre");\n(function () {\n${modules}\n})();\nGame.director();\nGame.boot();`, sandbox);
  let t = 1000;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { const cb = raf; raf = null; t += 16.7; cb(t); } };
  const key = (code, down) => (handlers[down ? "keydown" : "keyup"] || []).forEach((h) => h({ code, key: code, preventDefault() {} }));
  step(); key("Enter", true); key("Enter", false); step(); step();
  const { Game, Kit } = sandbox;
  const d = () => Game.data.zdirector;
  const teleport = (x, y) => { if (dimension === "3d") { Game.scene.cam.pos[0] = x; Game.scene.cam.pos[2] = y; } else { d().p.x = x; d().p.y = y; } };
  const where = (e) => (e.pos ? { x: e.pos[0], y: e.pos[2] } : { x: e.x, y: e.y });
  const press = (code) => { key(code, true); step(); key(code, false); };
  return { Game, Kit, step, key, press, d, teleport, where };
}

const DIMS = ["2d", "2.5d", "3d"];
const spec = (goal, threat = { type: "none" }, player = {}) => ({ goal, threat, player });

for (const dimension of DIMS) {
  test(`${dimension}: collecting everything wins, with objectives placed and a HUD`, () => {
    const game = makeGame({ dimension, gameplay: spec({ type: "collect", label: "lanterns", count: 4 }, { type: "timer", seconds: 300 }) });
    const { Game, d, step, teleport, where } = game;
    assert.equal(d().items.length, 4);
    assert.ok(Game.hud.some((l) => /Lanterns: 0\/4/.test(l)), `HUD: ${JSON.stringify(Game.hud)}`);
    for (const item of d().items) { const at = where(item); teleport(at.x, at.y); step(2); }
    assert.equal(Game.mode, "win");
    assert.ok(Game.score >= 40);
    assert.match(Game.endMessage, /found every one/);
  });

  test(`${dimension}: keys unlock the exit, and the exit only wins once it is open`, () => {
    const game = makeGame({ dimension, gameplay: spec({ type: "keys", label: "keys", count: 2 }, { type: "timer", seconds: 300 }) });
    const { Game, d, step, teleport, where } = game;
    const exit = where(d().exit);
    teleport(exit.x, exit.y); step(2);
    assert.equal(Game.mode, "play", "a locked exit does not win");
    assert.equal(d().exit.locked, true);
    for (const item of d().items) { const at = where(item); teleport(at.x, at.y); step(2); }
    assert.equal(d().exit.locked, false);
    teleport(exit.x, exit.y); step(2);
    assert.equal(Game.mode, "win");
    assert.match(Game.endMessage, /made it out/);
  });

  test(`${dimension}: surviving the timer wins, running out of time loses`, () => {
    const survive = makeGame({ dimension, gameplay: spec({ type: "survive", seconds: 40 }, { type: "none" }) });
    survive.d().elapsed = 39.99; survive.step(2);
    assert.equal(survive.Game.mode, "win");
    const hurry = makeGame({ dimension, gameplay: spec({ type: "exit" }, { type: "timer", seconds: 60 }) });
    assert.ok(hurry.Game.hud.some((l) => /Time left: \d+/.test(l)));
    hurry.d().elapsed = hurry.d().limit; hurry.step(2);
    assert.equal(hurry.Game.mode, "over");
    assert.match(hurry.Game.endMessage, /Time ran out/);
  });

  test(`${dimension}: a chaser that reaches you costs health and eventually ends the game`, () => {
    const game = makeGame({ dimension, gameplay: spec({ type: "collect", count: 3 }, { type: "chasers", count: 1, speed: "fast", sight: "long" }, { health: 2 }) });
    const { Game, d, step, teleport, where } = game;
    assert.equal(d().enemies.length, 1);
    const hit = () => { const p = Game.player; teleport(where(d().enemies[0]).x, where(d().enemies[0]).y); step(2); d().inv = 0; return p; };
    hit(); assert.equal(d().hp, 1);
    assert.equal(Game.mode, "play");
    hit(); step(2);
    assert.equal(Game.mode, "over");
    assert.match(Game.endMessage, /got you/);
  });

  test(`${dimension}: hazards hurt, and defeating every enemy by shooting wins`, () => {
    const hazard = makeGame({ dimension, gameplay: spec({ type: "exit" }, { type: "hazards", count: 2 }, { health: 1 }) });
    assert.ok(hazard.d().hazards.length >= 2);
    const spot = hazard.where(hazard.d().hazards[0]);
    hazard.teleport(spot.x, spot.y); hazard.step(2);
    assert.equal(hazard.Game.mode, "over");

    const floorOnly = 'Game.module("Floor", { init: function (g) { g.scene.meshes.push(Kit.mesh.plane(40, 40, "#222222", "#333333", 4)); } });';
    const game = makeGame({ dimension, gameplay: spec({ type: "defeat", count: 2 }, { type: "chasers", count: 2, speed: "slow", sight: "short", hp: 1 }), modules: dimension === "3d" ? floorOnly : "" });
    const { Game, d, step, teleport, where, press, key } = game;
    assert.equal(d().spec.player.shoots, true, "a defeat goal always lets the player shoot");
    for (let guard = 0; guard < 400 && Game.mode === "play"; guard++) {
      d().hp = 9;
      const foe = d().enemies.find((e) => !e.dead);
      if (!foe) break;
      const at = where(foe);
      if (dimension === "3d") {
        const room = at.y + 4 <= 16;                // stand on whichever side of the enemy has room
        teleport(at.x, room ? at.y + 4 : at.y - 4);
        Game.scene.cam.yaw = room ? 0 : Math.PI; Game.scene.cam.pitch = 0;
      } else {
        const left = dimension === "2d" ? at.x - 80 >= 60 : at.x - 2 >= 0.8;
        teleport(left ? at.x - (dimension === "2d" ? 80 : 2) : at.x + (dimension === "2d" ? 80 : 2), at.y);
        d().face = { x: left ? 1 : -1, y: 0 };
      }
      step(1);
      if (guard % 6 === 0) press("Space");
    }
    step(2);
    assert.equal(Game.mode, "win", `shot them all: ${JSON.stringify(d().enemies.map((e) => e.dead))}`);
    assert.match(Game.endMessage, /is down/);
  });
}

test("an empty 3D world gets an arena, and the compass and crosshair draw without errors", () => {
  const game = makeGame({ dimension: "3d", gameplay: spec({ type: "collect", count: 3 }, { type: "chasers" }, { shoots: true }) });
  assert.ok(game.Game.scene.meshes.length > 10, "floor, pillars, objectives and enemies exist");
  assert.ok(game.Kit.solids(game.Game).length >= 5, "the pillars are solid");
  game.step(60);
  assert.deepEqual([...game.Game.errors], []);
});

test("a module that drives the player keeps control; the Director does not fight it", () => {
  const driver = `Game.module("Own", { update: function (g, dt) { g.data.own = g.data.own || { x: 400, y: 300 }; g.data.own.x += g.axis().x * 100 * dt; g.player = { x: g.data.own.x, y: g.data.own.y }; } });`;
  const game = makeGame({ dimension: "2d", gameplay: spec({ type: "collect", count: 2 }, { type: "timer", seconds: 300 }), modules: driver });
  game.step(3);
  assert.equal(game.d().controlled, false);
  assert.equal(game.Game.playerBy, "Own");
  const at = game.where(game.d().items[0]);
  game.Game.data.own.x = at.x; game.Game.data.own.y = at.y; game.step(2);
  assert.equal(game.d().items[0].collected, true, "pickups follow the module's player");
});

test("2.5D draws an automatic floor only when asked", () => {
  const floors = (autoFloor) => {
    const game = makeGame({ dimension: "2.5d", gameplay: { ...spec({ type: "exit" }), autoFloor } });
    game.step(2);
    return game.Game.errors.length;
  };
  assert.equal(floors(true), 0);
  assert.equal(floors(false), 0);
});
