process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createGame, assemble, assessPlaytest } = require("./game-generator");
const { smokeRun } = require("./studio-runtime/smoke");

const RUNTIME_DIR = path.join(__dirname, "studio-runtime");
const runtimeCode = syncFs.readFileSync(path.join(RUNTIME_DIR, "runtime.js"), "utf8");
const boot = (modules, extra = "") => `${runtimeCode}\nGame.configure({"title":"T","width":800,"height":600${extra}});\n${modules}\nGame.boot();`;

function loadRuntime() {
  const context = vm.createContext({ console });
  vm.runInContext(runtimeCode, context);
  context.Game.configure({ width: 800, height: 600 });
  context.Game.rand = context.Kit.rng(5);
  return context;
}

function withModel(context, respond) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  const prompts = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    prompts.push(prompt);
    return { ok: true, json: async () => ({ choices: [{ message: { content: respond(prompt, body) } }] }) };
  };
  return prompts;
}

test("first-person controller walks, collides with solid meshes and stays in bounds", () => {
  const { Game, Kit } = loadRuntime();
  Game.scene = { cam: Kit.camera3d({ pos: [0, 1.6, 8] }), meshes: [] };
  const wall = Kit.mesh.box(4, 3, 1, "#ffffff");
  wall.pos = [0, 1.5, 3]; wall.solid = true;
  Game.scene.meshes.push(wall);
  Game.down = (code) => code === "KeyW";
  for (let i = 0; i < 120; i++) Kit.fp.update(Game, 0.05, { speed: 4, radius: 0.45 });
  assert.ok(Game.player.z > 3.9 && Game.player.z < 4.1, `stopped at the wall, got z=${Game.player.z}`);
  assert.equal(Game.player.y, 1.6);
  Game.scene = { cam: Kit.camera3d({ pos: [0, 1.6, 8] }), meshes: [] };
  for (let i = 0; i < 200; i++) Kit.fp.update(Game, 0.05, { speed: 5 });
  assert.equal(Game.player.z, -25, "the default bounds stop the player");
  Game.scene.cam.pos = [0, 1.6, 3]; // spawned inside a solid must not trap the player
  Game.scene.meshes.push(wall);
  Kit.fp.update(Game, 0.05, { speed: 4 });
  assert.notEqual(Game.player.z, 3);
});

test("pickups, chasers and the top-down mover behave in 3D and in 2D", () => {
  const { Game, Kit } = loadRuntime();
  Game.player = { x: 0, y: 1.6, z: 0 };
  const near = Kit.mesh.box(0.5, 0.5, 0.5, "#fff"); near.pos = [0.4, 1, 0.3];
  const far = Kit.mesh.box(0.5, 0.5, 0.5, "#fff"); far.pos = [9, 1, 9];
  Game.score = 0;
  assert.equal(Kit.pickups.collect(Game, [near, far], { radius: 1, value: 10 }), 1);
  assert.equal(near.collected, true); assert.equal(near.visible, false); assert.equal(Game.score, 10);
  assert.equal(Kit.pickups.collect(Game, [near, far], { radius: 1 }), 1, "a collected item is not collected twice");

  const stalker = Kit.mesh.pyramid(1, 2, 1, "#a23"); stalker.pos = [10, 1, 0];
  let caught = null, before = 10;
  for (let i = 0; i < 200 && !caught; i++) caught = Kit.chaser.update(Game, 0.1, stalker, { speed: 3, sight: 20, touch: 1 });
  assert.equal(caught, "caught");
  assert.ok(stalker.pos[0] < before, "it moved toward the player");

  const lost = Kit.mesh.pyramid(1, 2, 1, "#a23"); lost.pos = [30, 1, 30];
  Kit.chaser.update(Game, 0.5, lost, { speed: 3, sight: 5 });
  assert.ok(lost.pos[0] !== 30 || lost.pos[2] !== 30, "outside its sight it wanders");

  Game.player = { x: 0, y: 0 };
  const foe = { x: 100, y: 0 };
  assert.equal(Kit.chaser.update(Game, 1, foe, { speed: 60, sight: 500, touch: 5 }), null);
  assert.ok(foe.x < 100 && Math.abs(foe.y) < 1e-6);
  const p = { x: 5, y: 5 };
  Game.axis = () => ({ x: 1, y: 0 });
  Game.w = 800; Game.h = 600;
  Kit.mover.update(Game, 0.1, p, { speed: 100, iso: true, bounds: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 } });
  assert.ok(p.x > 5 && p.y < 5, "isometric mapping: screen-right is grid (+1,-1)");
  assert.deepEqual({ ...Game.player }, { x: p.x, y: p.y });
});

test("the shared 3D scene is drawn by the runtime, and the bot can tell who ended the game and who publishes the player", { timeout: 60_000 }, async () => {
  const scene = `Game.module("Hall", { init: function (g) { var b = Kit.mesh.box(2, 2, 2, "#ff0000"); b.pos = [0, 1, 0]; g.scene.meshes.push(b); } });`;
  const drawn = await smokeRun(boot(scene), { frames: 120, minCalls: 8, minPlayRatio: 0 });
  assert.ok(drawn.ok, `a module that only pushes meshes still draws: ${drawn.errors.join("; ")}`);

  const rules = `Game.module("Rules", { update: function (g) { g.end(false); } });`;
  const idle = await smokeRun(boot(rules), { frames: 60, idle: true, minCalls: 0, minPlayRatio: 0 });
  assert.equal(idle.endInfo.by, "Rules");
  assert.equal(idle.endInfo.win, false);

  const ctl = `Game.module("Ctl", { update: function (g, dt) { var a = g.axis(); g.data.x = (g.data.x || 0) + a.x * dt * 100; g.player = { x: g.data.x, y: 0 }; } });`;
  const active = await smokeRun(boot(ctl), { frames: 200, minCalls: 0, minPlayRatio: 0 });
  assert.equal(active.hasPlayer, true);
  assert.equal(active.playerBy, "Ctl");
  assert.ok(active.moved > 10, `moved ${active.moved}`);
});

test("playtest findings: instant endings, a missing player, no movement, and runs that cannot be judged", () => {
  const design = { dimension: "3d" };
  const modules = [{ name: "World" }, { name: "PlayerController" }];
  const fine = { mode: "play", hasPlayer: true, moved: 5, playerBy: "PlayerController", playFrames: 400 };
  assert.deepEqual(assessPlaytest(design, { active: fine, idle: { mode: "play", endInfo: null } }, modules), []);
  const instant = assessPlaytest(design, { active: fine, idle: { mode: "over", endInfo: { win: false, by: "Rules", time: 0.2 } } }, modules);
  assert.equal(instant[0].kind, "instant_end"); assert.equal(instant[0].blame, "Rules");
  const noPlayer = assessPlaytest(design, { active: { ...fine, hasPlayer: false }, idle: { mode: "play" } }, modules);
  assert.equal(noPlayer[0].kind, "no_player"); assert.equal(noPlayer[0].blame, "PlayerController");
  const still = assessPlaytest(design, { active: { ...fine, moved: 0.1 }, idle: { mode: "play" } }, modules);
  assert.equal(still[0].kind, "no_movement"); assert.equal(still[0].blame, "PlayerController");
  assert.equal(assessPlaytest({ dimension: "2d" }, { active: { ...fine, moved: 8 }, idle: { mode: "play" } }, modules)[0].kind, "no_movement", "2D needs 10 pixels");
  assert.deepEqual(assessPlaytest(design, { active: { mode: "timeout" }, idle: { mode: "play" } }, modules), []);
  const early = assessPlaytest(design, { active: { ...fine, hasPlayer: false, playFrames: 3, endInfo: { win: false, by: "Rules", time: 0.05 } }, idle: { mode: "play", endInfo: null } }, modules);
  assert.deepEqual(early.map((p) => p.kind), ["instant_end"], "an instant ending is reported once, without a false 'no player' finding");
  assert.deepEqual(assessPlaytest(design, { active: { ...fine, hasPlayer: false, playFrames: 20 }, idle: { mode: "play", endInfo: null } }, modules), [], "too little play to judge movement");
});

test("every starter game passes the playtest it enforces on the model", { timeout: 120_000 }, async () => {
  for (const [dimension, file] of [["2d", "fallback-2d.js"], ["2.5d", "fallback-25d.js"], ["3d", "fallback-3d.js"]]) {
    const design = { dimension, width: 800, height: 600 };
    const code = assemble({ title: "T", width: 800, height: 600, palette: {}, controls: [], dimension }, [{ name: "starter", code: syncFs.readFileSync(path.join(RUNTIME_DIR, file), "utf8") }]);
    const base = { width: 800, height: 600, minCalls: 0, minPlayRatio: 0 };
    const [active, idle] = await Promise.all([smokeRun(code, { ...base, frames: 480 }), smokeRun(code, { ...base, frames: 240, idle: true })]);
    assert.deepEqual(assessPlaytest(design, { active, idle }, [{ name: "starter" }]), [], `${dimension} starter: ${JSON.stringify({ moved: active.moved, end: idle.endInfo })}`);
  }
});

const DESIGN = (modules) => JSON.stringify({
  title: "Echo Vale", genre: "explorer", dimension: "3d", pitch: "Walk a haunted hall and gather lights.", canvas: { width: 960, height: 540 }, controls: ["WASD move"],
  gameplay: { mode: "custom" },
  modules: modules.map((name) => ({ name, responsibility: `the ${name} part` })),
  tasks: [
    { title: "Add a second hall", owner: "Game designer", description: "Design a second hall with a new hazard." },
    { title: "Add a lantern item", owner: "Gameplay engineer", description: "Add a lantern that widens the light radius." },
    { title: "Test wall collisions", owner: "QA tester", description: "Walk every wall and corner looking for clipping." },
  ],
});
const WORLD = 'Game.module("World", { init: function (g) { var b = Kit.mesh.box(2, 2, 2, "#345"); b.pos = [0, 1, 0]; g.scene.meshes.push(b); g.data.world = { n: 1 }; } });';
const PLAYER = 'Game.module("Player", { init: function (g) { g.data.player = { x: 0, y: 0 }; }, update: function (g, dt) { var a = g.axis(); g.data.player.x += a.x * 100 * dt; g.player = { x: g.data.player.x, y: 0 }; if (g.time > 5) g.end(true); if (g.data.player.x < -1000) g.end(false); }, draw: function (g, ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(g.data.player.x, 0, 10, 10); } });';
const PLAYER_SILENT = PLAYER.replace(" g.player = { x: g.data.player.x, y: 0 };", "");
const RULES_INSTANT = 'Game.module("Rules", { update: function (g) { g.end(false); } });';
const RULES_GOOD = 'Game.module("Rules", { update: function (g) { if (g.time > 4) g.end(true); if (g.time < -1) g.end(false); } });';

test("a module that ends the game instantly is sent back with the finding and fixed", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-instant-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompts = withModel(context, (prompt, body) => {
    if (body.response_format) return DESIGN(["World", "Player", "Rules"]);
    if (prompt.includes('named "World"')) return WORLD;
    if (prompt.includes('named "Player"')) return PLAYER;
    if (prompt.includes('named "Rules"')) return prompt.includes("Playtest finding") ? RULES_GOOD : RULES_INSTANT;
    return "unexpected";
  });
  const events = [];
  const project = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  const repair = prompts.find((p) => p.includes("Playtest finding"));
  assert.ok(repair, "the Rules module was sent back");
  assert.match(repair, /ended after 0\.\d seconds: module "Rules"/);
  assert.ok(repair.includes("function (g) { g.end(false); } });"), "the broken code travels with the finding");
  assert.equal(prompts.length, 5, "design, three modules, one repair");
  assert.equal(project.fallback, false);
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes("g.time > 4") && !js.includes("function (g) { g.end(false); } });"));
  assert.ok(events.some((e) => /Playtest passed/.test(e.message || "")));
});

test("a player that never publishes g.player is repaired once; if that fails the starter ships", { timeout: 180_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-player-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  let silentOnly = false;
  const prompts = withModel(context, (prompt, body) => {
    if (body.response_format) return DESIGN(["World", "Player"]);
    if (prompt.includes('named "World"')) return WORLD;
    if (prompt.includes('named "Player"')) return silentOnly || !prompt.includes("Playtest finding") ? PLAYER_SILENT : PLAYER;
    return "unexpected";
  });
  const fixed = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: () => {} });
  assert.equal(fixed.fallback, false);
  assert.equal(prompts.length, 4, "design, two modules, one repair");
  assert.match(prompts[3], /g\.player was never set/);
  assert.ok((await fs.readFile(path.join(dir, fixed.id, "game.js"), "utf8")).includes("g.player = {"));

  silentOnly = true;
  const events = [];
  const starter = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.equal(starter.fallback, true);
  assert.ok((await fs.readFile(path.join(dir, starter.id, "game.js"), "utf8")).includes("echoHall"), "the 3D starter shipped");
  assert.ok(events.some((e) => /still fails the playtest/.test(e.message || "")));
});

// Plays a game in this process with a recording canvas, so drawing can be inspected.
function playInProcess(modules, { frames = 30 } = {}) {
  const log = { texts: [], radial: 0 };
  let fillStyle = "#000";
  const target = {};
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "fillStyle") return fillStyle;
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      if (k === "createRadialGradient") return () => { log.radial++; return { addColorStop() {} }; };
      if (k === "measureText") return (s) => ({ width: String(s).length * 7 });
      if (k === "fillText") return (s, x, y) => log.texts.push({ s: String(s), x, y });
      return () => {};
    },
    set(t, k, v) { if (k === "fillStyle") fillStyle = v; else t[k] = v; return true; },
    deleteProperty(t, k) { delete t[k]; return true; },
  });
  const handlers = {};
  const on = (type, fn) => (handlers[type] = handlers[type] || []).push(fn);
  let raf = null;
  const canvas = { width: 800, height: 600, getContext: () => ctx, addEventListener: on, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  const sandbox = { document: { getElementById: () => canvas, addEventListener: on, body: { appendChild() {} } }, console, requestAnimationFrame: (fn) => { raf = fn; }, Date, Math, Object, Array, JSON };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(boot(modules), sandbox);
  let t = 1000;
  const step = () => { const cb = raf; raf = null; t += 16.7; cb(t); };
  step();
  (handlers.keydown || []).forEach((h) => h({ code: "Enter", key: "Enter", preventDefault() {} }));
  for (let i = 0; i < frames; i++) step();
  log.texts.length = 0;
  step();
  return { Game: sandbox.Game, log };
}

test("text that modules draw in the HUD corner becomes one deduplicated HUD line", () => {
  const modules = `Game.module("A", {
    update: function (g) { g.hud.push("Score: 0"); },
    draw: function (g, ctx) { Kit.text(ctx, "Score: 0", 10, 10); ctx.fillText("Lanterns: 0", 12, 38); Kit.text(ctx, "Lanterns: 0", 10, 50); Kit.text(ctx, "Centre prompt", 400, 300); }
  });`;
  const { Game, log } = playInProcess(modules);
  assert.deepEqual([...Game.hud], ["Score: 0", "Lanterns: 0"]);
  const drawn = (text) => log.texts.filter((t) => t.s === text);
  assert.equal(drawn("Score: 0").length, 1, "one copy on screen, not two stacked");
  assert.equal(drawn("Lanterns: 0").length, 1);
  assert.equal(drawn("Centre prompt").length, 1, "text elsewhere is left alone");
  assert.equal(drawn("Centre prompt")[0].x, 400);
});

test("a torch lights what is near the player and lanterns glow", () => {
  const { Kit } = loadRuntime();
  const brightness = (mesh) => {
    const colors = [];
    let style = "";
    const ctx = new Proxy({}, { get: (t, k) => (k === "fill" ? () => colors.push(style) : () => {}), set: (t, k, v) => { if (k === "fillStyle") style = v; return true; } });
    Kit.render3d(ctx, Kit.camera3d({ pos: [0, 0, 5], yaw: 0 }), [mesh], { width: 800, height: 600 });
    return Number(/rgb\((\d+)/.exec(colors[0])[1]);
  };
  const box = (z, extra = {}) => Object.assign(Kit.mesh.box(2, 2, 2, "#505050"), { pos: [0, 0, z] }, extra);
  const near = brightness(box(0)), far = brightness(box(-9)), glowing = brightness(box(-9, { emissive: true }));
  assert.ok(near > far, `near ${near} should be brighter than far ${far}`);
  assert.ok(glowing > far, "emissive meshes ignore the dark");
  assert.equal(Kit.rgb([300, -5, 10]), "rgb(255,0,10)", "colours are clamped");

  const { Game } = loadRuntime();
  Game.player = { x: 0, y: 1.6, z: 0 };
  const lantern = Object.assign(Kit.mesh.sphere(0.3, "#ffcf5c", 6), { pos: [20, 1, 20] });
  Kit.pickups.collect(Game, [lantern], { radius: 1 });
  assert.equal(lantern.emissive, true);
  assert.equal(lantern.glow, "#ffcf5c");

  const glowModule = (visible) => `Game.module("L", { init: function (g) { var m = Kit.mesh.sphere(0.4, "#ffcf5c", 6); m.pos = [0, 1.2, 0]; m.glow = "#ffcf5c"; m.visible = ${visible}; g.scene.meshes.push(m, Kit.mesh.box(1, 1, 1, "#445")); } });`;
  assert.ok(playInProcess(glowModule(true)).log.radial > 0, "a visible glowing mesh draws a halo");
  assert.equal(playInProcess(glowModule(false)).log.radial, 0, "a hidden one does not");
});

test("ground planes are always drawn before the things standing on them", () => {
  const { Kit } = loadRuntime();
  const fills = [];
  let style = "";
  const ctx = new Proxy({}, { get: (target, k) => (k === "fill" ? () => fills.push(style) : () => {}), set: (target, k, v) => { if (k === "fillStyle") style = v; return true; } });
  const floor = Kit.mesh.plane(40, 40, "#202020", "#282828", 4);
  const pillar = Kit.mesh.box(2, 6, 2, "#c0c0c0");
  pillar.pos = [0, 3, -6]; // its faces are farther away than the nearest floor tiles
  Kit.render3d(ctx, Kit.camera3d({ pos: [0, 1.6, 8], yaw: 0 }), [pillar, floor], { width: 800, height: 600, torch: 0 });
  const isPillar = (c) => Number(/rgb\((\d+)/.exec(c)[1]) > 120;
  const firstPillar = fills.findIndex(isPillar);
  assert.ok(firstPillar > 0, "the pillar is drawn");
  assert.ok(fills.slice(firstPillar).every(isPillar), "no floor polygon is drawn after the pillar has started");
});
