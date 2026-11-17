process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createGame, normalizeDesign, sanitizeModule, checkModule, detectDimension, fixKitNames, kitCatalog, fallbackRules } = require("./game-generator");
const { pickReferences, loadReferences } = require("./design-references");
const { smokeRun } = require("./studio-runtime/smoke");

const RUNTIME_DIR = path.join(__dirname, "studio-runtime");
const runtimeCode = syncFs.readFileSync(path.join(RUNTIME_DIR, "runtime.js"), "utf8");
const FORBIDDEN = /(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|WebSocket|\bimport\b|\beval\s*\()/i;

function withModel(context, respond) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  });
  const prompts = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    prompts.push(prompt);
    const content = respond(prompt, body);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return prompts;
}

const WORLD = 'Game.module("World", { init: function (g) { g.data.world = { tiles: [] }; for (var i = 0; i < 12; i++) g.data.world.tiles.push({ x: i * 40, y: 100 }); }, draw: function (g, ctx) { (g.data.world.tiles || []).forEach(function (t) { ctx.fillStyle = "#345"; ctx.fillRect(t.x, t.y, 30, 30); }); } });';
const PLAYER = 'Game.module("Player", { init: function (g) { g.data.player = { x: 100, y: 100 }; }, update: function (g, dt) { var a = g.axis(); g.data.player.x += a.x * 100 * dt; g.hud.push("Time " + Math.floor(g.time)); g.player = { x: g.data.player.x, y: 0 }; if (g.time > 5) g.end(true); if (g.data.player.x < -1000) g.end(false); }, draw: function (g, ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(g.data.player.x, g.data.player.y, 10, 10); } });';

function design(extra = {}) {
  return JSON.stringify({
    title: "Echo Vale", genre: "explorer", dimension: "3d", pitch: "Walk a haunted hall and gather lights.",
    canvas: { width: 960, height: 540 }, palette: { bg: "#0a0f1a", accent: "#ffcf5c" }, controls: ["WASD move", "Mouse look"],
    modules: [{ name: "World", responsibility: "the hall" }, { name: "Player", responsibility: "movement and goal" }],
    gameplay: { mode: "custom" },
    tasks: [
      { title: "Add a second hall", owner: "Game designer", description: "Design a second hall with a new hazard." },
      { title: "Add a lantern item", owner: "Gameplay engineer", description: "Add a lantern that widens the light radius." },
      { title: "Test wall collisions", owner: "QA tester", description: "Walk every wall and corner looking for clipping." },
    ],
    ...extra,
  });
}

test("runtime and every fallback are clean and play without errors in 2D, 2.5D and 3D", { timeout: 120_000 }, async () => {
  for (const [dimension, file] of [["2d", "fallback-2d.js"], ["2.5d", "fallback-25d.js"], ["3d", "fallback-3d.js"]]) {
    const module = syncFs.readFileSync(path.join(RUNTIME_DIR, file), "utf8");
    assert.ok(!FORBIDDEN.test(runtimeCode + module), `${file} contains a forbidden pattern`);
    const game = `${runtimeCode}\nGame.configure({"title":"T","width":800,"height":600});\n(function () {\n${module}\n})();\nGame.boot();`;
    const result = await smokeRun(game, { frames: 400, minCalls: 3, minPlayRatio: 0.1 });
    assert.ok(result.ok, `${dimension} fallback failed: ${result.errors.join("; ")}`);
  }
});

test("the smoke test catches blank games, thrown errors and infinite loops", { timeout: 60_000 }, async () => {
  const boot = (module) => `${runtimeCode}\nGame.configure({"title":"T"});\n${module}\nGame.boot();`;
  assert.equal((await smokeRun(boot(""), { frames: 120 })).ok, false);
  const thrown = await smokeRun(boot('Game.module("Bad", { update: function () { nothingHere.x = 1; } });'), { frames: 120, minCalls: 0 });
  assert.equal(thrown.ok, false);
  assert.match(thrown.errors[0], /Bad\.update/);
  assert.equal((await smokeRun(boot('Game.module("Spin", { update: function () { while (true) {} } });'), { frames: 60, minCalls: 0 })).ok, false);
});

test("3D: box faces point outward, a cube ahead is drawn and a cube behind is not", () => {
  const context = vm.createContext({ console });
  vm.runInContext(runtimeCode, context);
  const { Kit } = context;
  const box = Kit.mesh.box(2, 2, 2, "#ffffff");
  box.faces.forEach((f) => {
    const [a, b, c] = f.map((i) => box.verts[i]);
    const n = Kit.v3.cross(Kit.v3.sub(b, a), Kit.v3.sub(c, a));
    const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1] + 0) / 3, (a[2] + b[2] + c[2]) / 3];
    assert.ok(Kit.v3.dot(n, centroid) > 0, "a face winds inward");
  });
  const fills = { count: 0 };
  const ctx = new Proxy({}, { get: (t, k) => (k === "fill" ? () => { fills.count++; } : () => {}), set: () => true });
  const head = Kit.camera3d({ pos: [0, 0, 5], yaw: 0 });
  box.pos = [0, 0, 0];
  assert.equal(Kit.render3d(ctx, head, [box], { width: 800, height: 600 }), 2, "seen head-on only the front face (2 triangles) is visible");
  const angled = Kit.camera3d({ pos: [3, 3, 5], yaw: Math.atan2(-3, 5), pitch: Math.atan2(-3, Math.sqrt(34)) });
  assert.equal(Kit.render3d(ctx, angled, [box], { width: 800, height: 600 }), 6, "seen from a corner three faces (6 triangles) are visible");
  box.pos = [0, 0, 20];
  assert.equal(Kit.render3d(ctx, head, [box], { width: 800, height: 600 }), 0, "a cube behind the camera is not drawn");
  const cam = head;
  box.pos = [0, 0, 0];
  const p = Kit.project3d(cam, [0, 0, 0], 800, 600);
  assert.ok(Math.abs(p.x - 400) < 1 && Math.abs(p.y - 300) < 1, "the point straight ahead projects to the screen centre");
  assert.equal(Kit.project3d(cam, [0, 0, 10], 800, 600), null);
});

test("reference blueprints match the brief, vary when the brief is vague, and accept custom cards", async (context) => {
  assert.ok(loadReferences().length >= 15);
  assert.ok(pickReferences("a spooky first-person maze").some((c) => c.id === "fps-explorer"));
  const seen = new Set();
  for (let i = 0; i < 12; i++) pickReferences("something fun").forEach((c) => seen.add(c.id));
  assert.ok(seen.size >= 8, "vague briefs should draw from many different cards");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "refs-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "mine.json"), JSON.stringify([{ id: "kaiju", name: "Kaiju smash", dimension: "3d", tags: ["kaiju"], pitch: "Stomp a city." }, { nope: true }]));
  await fs.writeFile(path.join(dir, "broken.json"), "{ not json");
  const cards = loadReferences(dir);
  assert.ok(cards.some((c) => c.id === "kaiju"));
  assert.ok(pickReferences("giant kaiju attack", { cards })[0].id === "kaiju");
});

test("designs are repaired into something safe to build", () => {
  const d = normalizeDesign({ title: "My <b>import</b> game https://x.example", dimension: "Isometric", canvas: { width: 99999, height: 1 }, palette: { bg: "red", accent: "#112233" }, modules: [{ name: "a b!", responsibility: "x" }, { name: "Good", responsibility: "does things" }, { name: "Good", responsibility: "dupe" }, { name: "Next", responsibility: "more" }], tasks: [{ title: "ok title", owner: "Wizard", description: "long enough description" }] }, "brief words");
  assert.equal(d.dimension, "2.5d");
  assert.ok(!FORBIDDEN.test(d.title) && !/[<>]/.test(d.title));
  assert.ok(d.width <= 1280 && d.height >= 320);
  assert.equal(d.palette.accent, "#112233");
  assert.match(d.palette.bg, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(d.modules.map((m) => m.name), ["ab", "Good", "Next"], "names are cleaned to letters and digits and duplicates are dropped");
  assert.ok(d.tasks.length >= 3 && d.tasks.every((t) => ["Game designer", "Gameplay engineer", "QA tester", "Producer"].includes(t.owner)));
  assert.equal(normalizeDesign(null, "a tiny moon garden").dimension, "2d");
  assert.equal(detectDimension("a first-person horror game"), "3d");
  assert.equal(detectDimension("isometric farm"), "2.5d");
  assert.equal(detectDimension("a puzzle game"), null);
});

test("module checks reject redefined globals, forbidden features and bad syntax, and clean fenced replies", () => {
  assert.match(checkModule('const Game = { name: "mine" }; Game.module("A", { init: function () {} });'), /redefine/);
  assert.match(checkModule('Game.module("A", { init: function () { fetch("x"); } });'), /forbidden/);
  assert.match(checkModule('Game.module("A", { init: function () { var = ; } });'), /Syntax/);
  assert.match(checkModule("var x = 1; var y = 2; var z = 3; var w = 4; var q = 5;"), /Game\.module/);
  assert.equal(checkModule(WORLD), "");
  assert.equal(sanitizeModule("Here is your module:\n```js\nimport x from 'y';\n" + WORLD + "\n```"), WORLD);
});

test("builds a game from model output and saves a valid project", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-ok-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompts = withModel(context, (prompt, body) => {
    if (body.response_format) return design();
    if (prompt.includes('named "World"')) return "```js\n" + WORLD + "\n```";
    if (prompt.includes('named "Player"')) return PLAYER;
    return "unexpected";
  });
  const events = [];
  const project = await createGame("A haunted hall in first person.", "handoff text", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.match(project.id, /^game-\d+-[a-f0-9]{8}$/);
  assert.equal(project.dimension, "3d");
  assert.equal(project.title, "Echo Vale");
  assert.equal(project.fallback, false);
  assert.equal(prompts.length, 3, "one design call and one call per module");
  assert.match(prompts[0], /Reference blueprints \(inspiration only/);
  assert.match(prompts[1], /Kit\.render3d/, "the 3D API reached the module prompt");
  assert.match(prompts[2], /module World/, "later modules can read earlier ones");
  const saved = path.join(dir, project.id);
  const html = await fs.readFile(path.join(saved, "index.html"), "utf8");
  assert.match(html, /<title>Echo Vale<\/title>/);
  assert.match(html, /href="\.\/game\.css"/);
  assert.match(html, /src="\.\/game\.js"/);
  const js = await fs.readFile(path.join(saved, "game.js"), "utf8");
  assert.ok(js.includes('Game.module("World"') && js.includes('Game.module("Player"'));
  assert.ok(!FORBIDDEN.test(js));
  assert.ok(events.some((e) => /Wrote module World/.test(e.message || "")));
});

test("ships a playable starter in the chosen dimension when the model returns junk", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-junk-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompts = withModel(context, (prompt, body) => (body.response_format ? design({ dimension: "2.5d", title: "Crystal Yard" }) : "I cannot help with that."));
  const project = await createGame("An isometric crystal yard.", "handoff", { projectsDir: dir });
  assert.equal(project.fallback, true);
  assert.equal(project.dimension, "2.5d");
  assert.ok(prompts.length <= 1 + 3 * 2, "the circuit breaker stops after two failed modules");
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes("crystalCourt"));
  assert.match(project.id, /^game-\d+-[a-f0-9]{8}$/);
});

test("a design reply that is not JSON still produces a real game from the Director", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-nojson-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  withModel(context, () => "sorry, no");
  const project = await createGame("A tiny game about a moon garden.", "handoff", { projectsDir: dir });
  assert.equal(project.fallback, false, "no generic starter: the Director builds a game from default gameplay");
  assert.equal(project.dimension, "2d");
  assert.equal(project.gameplay.mode, "director");
  assert.ok(project.tasks.length >= 3);
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes("Game.director();"));
});


const PLAYER_WIN_ONLY = PLAYER.replace(" if (g.data.player.x < -1000) g.end(false);", "");
const RULES = 'Game.module("Rules", { update: function (g) { var p = g.player || {}; if (g.time > 4) g.end(true); if (g.time < -1) g.end(false); g.hud.push("x " + Math.round(p.x || 0)); } });';
const ENEMY = 'Game.module("Enemy", { init: function (g) { g.data.enemy = { x: 300, y: 100 }; }, update: function (g, dt) { var p = g.player || { x: 0, y: 0 }; g.data.enemy.x += (p.x - g.data.enemy.x) * dt; }, draw: function (g, ctx) { ctx.fillStyle = "#f00"; ctx.fillRect(g.data.enemy.x, g.data.enemy.y, 10, 10); } });';
const threeModules = () => design({ modules: [{ name: "World", responsibility: "the hall" }, { name: "Player", responsibility: "movement and goal" }, { name: "Enemy", responsibility: "chases the player" }] });

test("pathfinding finds routes around walls, reports blocked goals and checks line of sight", () => {
  const context = vm.createContext({ console });
  vm.runInContext(runtimeCode, context);
  const { Kit } = context;
  const grid = [[0, 0, 0, 0], [1, 1, 1, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 0, 0, 0]];
  const path = Kit.aStar(grid, { x: 0, y: 0 }, { x: 0, y: 4 });
  assert.equal(path.length, 10);
  assert.ok(path.every((c) => !grid[c.y][c.x]), "the path never crosses a wall");
  assert.equal(JSON.stringify(path.at(-1)), JSON.stringify({ x: 0, y: 4 }));
  assert.equal(Kit.aStar([[0, 1, 0]], { x: 0, y: 0 }, { x: 2, y: 0 }).length, 0);
  assert.equal(Kit.findPath, Kit.aStar);
  assert.equal(Kit.lineOfSight(grid, 0, 0, 3, 0), true);
  assert.equal(Kit.lineOfSight(grid, 0, 0, 0, 2), false);
});

test("invented Kit names: near misses are fixed, others are rejected with the list of real functions", () => {
  assert.equal(fixKitNames("Kit.clmap(1, 0, 2); Kit.aStar(a, b, c); Kit.zzzzzzz(1)"), "Kit.clamp(1, 0, 2); Kit.aStar(a, b, c); Kit.zzzzzzz(1)");
  const bad = checkModule('Game.module("E", { update: function (g) { Kit.pathfind(1, 2, 3); } });');
  assert.match(bad, /Kit\.pathfind does not exist/);
  assert.ok(bad.includes("Kit.aStar") && bad.includes("Kit.mesh.{"), "the real list is part of the message the model sees");
  assert.match(checkModule('Game.module("E", { update: function (g) { Kit.iso.nothing(); } });'), /Kit\.iso\.nothing does not exist/);
  assert.equal(checkModule('Game.module("E", { update: function (g) { Kit.aStar([[0]], { x: 0, y: 0 }, { x: 0, y: 0 }); Kit.mesh.box(1, 1, 1, "#fff"); } });'), "");
  assert.ok(kitCatalog().top.has("render3d"));
});

test("a game with no lose condition gets a Rules module", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-rules-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prompts = withModel(context, (prompt, body) => {
    if (body.response_format) return design();
    if (prompt.includes('named "World"')) return WORLD;
    if (prompt.includes('named "Player"')) return PLAYER_WIN_ONLY;
    if (prompt.includes('named "Rules"')) return RULES;
    return "unexpected";
  });
  const project = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: () => {} });
  assert.equal(prompts.length, 4, "design, two modules, and the Rules module");
  assert.match(prompts[3], /g\.end\(false\)/, "the prompt says exactly which ending is missing");
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('Game.module("Rules"'));
  assert.equal(project.fallback, false);
});

test("if the model cannot write the Rules module, a countdown guarantees the game can end", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-timer-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  withModel(context, (prompt, body) => {
    if (body.response_format) return design();
    if (prompt.includes('named "World"')) return WORLD;
    if (prompt.includes('named "Player"')) return PLAYER_WIN_ONLY;
    return "I cannot do that.";
  });
  const project = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: () => {} });
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('Game.module("rulesTimer"'));
  assert.match(fallbackRules(true, true), /g\.end\(g\.score > 0\)/);
  assert.match(fallbackRules(true, false), /g\.end\(true\)/);
  assert.match(fallbackRules(false, true), /g\.end\(false\)/);
});

test("a skipped module gets a second try once the other modules exist", { timeout: 120_000 }, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-second-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  let enemyCalls = 0;
  const events = [];
  withModel(context, (prompt, body) => {
    if (body.response_format) return threeModules();
    if (prompt.includes('named "World"')) return WORLD;
    if (prompt.includes('named "Player"')) return PLAYER;
    if (prompt.includes('named "Enemy"')) { enemyCalls++; return enemyCalls <= 3 ? "Kit.nope(); // not a module" : ENEMY; }
    return "unexpected";
  });
  const project = await createGame("A haunted hall with a stalker.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.equal(enemyCalls, 4, "three failed attempts, then one success on the second try");
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('Game.module("Enemy"'));
  assert.ok(js.indexOf('Game.module("Enemy"') > js.indexOf('Game.module("Player"'), "modules keep the designed order");
  assert.ok(events.some((e) => /second try/.test(e.message || "")));
});
