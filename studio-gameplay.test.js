process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGame, normalizeGameplay, directorOwns } = require("./game-generator");
const { findNamedGames, extractTitles } = require("./named-games");

function withModel(context, respond) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  const prompts = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    prompts.push({ prompt, system: body.messages[0].content });
    return { ok: true, json: async () => ({ choices: [{ message: { content: respond(prompt, body, body.messages[0].content) } }] }) };
  };
  return prompts;
}
const tmp = async (context, name) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), name)); context.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const TASKS = [
  { title: "Add a second area", owner: "Game designer", description: "Design a second area with a new hazard." },
  { title: "Add a rare item", owner: "Gameplay engineer", description: "Add a rare item that changes the route." },
  { title: "Test every wall", owner: "QA tester", description: "Walk every wall and corner looking for clipping." },
];
const design = (extra = {}) => JSON.stringify({ title: "Whispers", genre: "horror", dimension: "3d", pitch: "Gather the lanterns before the stalker finds you.", canvas: { width: 960, height: 540 }, tasks: TASKS, ...extra });
const GAMEPLAY = { goal: { type: "collect", label: "lanterns", count: 5 }, threat: { type: "chasers", label: "stalker", count: 2, speed: "fast", sight: "long" }, player: { health: 4 } };
const WORLD = 'Game.module("World", { init: function (g) { g.scene.meshes.push(Kit.mesh.plane(40, 40, "#2a3442", "#222b36", 8)); g.world = { bounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 } }; } });';

test("the gameplay menu repairs whatever the designer wrote", () => {
  const g = normalizeGameplay({ goal: { type: "Gather the relics", label: "Ancient Relics!!", count: 99 }, threat: { type: "stalking monster", count: 0, speed: "warp", sight: "long" }, player: { shoots: "true", health: 12 } });
  assert.equal(g.mode, "director");
  assert.equal(g.goal.type, "collect"); assert.equal(g.goal.label, "ancient relics"); assert.equal(g.goal.count, 12);
  assert.equal(g.threat.type, "chasers"); assert.equal(g.threat.count, 1, "a chaser threat always has at least one enemy"); assert.equal(g.threat.speed, "normal");
  assert.equal(g.player.shoots, true); assert.equal(g.player.health, 5);
  assert.equal(normalizeGameplay({ goal: { type: "kill everything" } }).player.shoots, true, "a defeat goal always shoots");
  assert.equal(normalizeGameplay({ goal: { type: "survive" }, threat: { type: "none" } }).threat.type, "chasers", "surviving needs something to survive");
  assert.deepEqual(normalizeGameplay({ mode: "custom" }), { mode: "custom" });
  assert.equal(normalizeGameplay(null).goal.type, "collect", "no spec at all still gives a playable default");
  assert.equal(normalizeGameplay({}, { goal: { type: "keys", label: "keys", count: 3 }, threat: { type: "patrol", count: 2 } }).goal.type, "keys", "a reference supplies the defaults");
  for (const name of ["PlayerController", "EnemyAI", "LanternManager", "HUD", "RulesAndScoring", "EnemySpawner"]) assert.ok(directorOwns(name), name);
  for (const name of ["WorldGenerator", "Atmosphere", "Props", "AudioManager", "CourtyardDecor"]) assert.ok(!directorOwns(name), name);
});

test("named games are found, ranked by where they appear, and unknown titles are extracted", () => {
  assert.deepEqual(findNamedGames("a spooky Doom-style shooter, also like pac-man").map((g) => g.names[0]), ["doom", "pac-man"]);
  assert.equal(findNamedGames("a haunted hall in 3D").length, 0);
  assert.equal(findNamedGames("an isometric diablo like dungeon")[0].dimension, "2.5d");
  assert.deepEqual(extractTitles("something like Outer Wilds but smaller"), ["Outer Wilds"]);
  assert.deepEqual(extractTitles("inspired by \"Hollow Knight\" and pac-man"), ["Hollow Knight"], "known games are not looked up again");
  assert.deepEqual(extractTitles("a scary game in a forest"), []);
});

test("even when every module fails, a Director game ships: not an empty world, not the generic starter", { timeout: 120_000 }, async (context) => {
  const dir = await tmp(context, "dir-junk-");
  const prompts = withModel(context, (prompt, body) => (body.response_format ? design({ gameplay: GAMEPLAY, modules: [{ name: "World", responsibility: "the hall" }] }) : "I cannot help with that."));
  const events = [];
  const project = await createGame("A haunted hall in 3D.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.equal(project.fallback, false);
  assert.equal(project.gameplay.goal.count, 5);
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('Game.module = function') && js.includes('Game.director();'));
  assert.ok(js.includes('"type":"collect"') && js.includes('"label":"lanterns"'), "the designed goal is in the config");
  assert.ok(!js.includes("echoHall"), "the generic starter was not used");
  assert.ok(events.some((e) => /default arena/.test(e.message || "")));
  assert.ok(events.some((e) => /Playtest passed/.test(e.message || "")));
  const record = JSON.parse(await fs.readFile(path.join(dir, project.id, "studio-design.json"), "utf8"));
  assert.equal(record.design.gameplay.threat.count, 2);
  assert.ok(prompts.length <= 1 + 3 * 2 + 3, "no runaway retries");
});

test("Director mode builds only world modules and tells the model what the Director already does", { timeout: 120_000 }, async (context) => {
  const dir = await tmp(context, "dir-world-");
  const prompts = withModel(context, (prompt, body) => {
    if (body.response_format) return design({ gameplay: { ...GAMEPLAY, goal: { type: "defeat", label: "demons", count: 4 }, player: { shoots: true } }, modules: [{ name: "World", responsibility: "the hall" }, { name: "PlayerController", responsibility: "movement" }, { name: "EnemyAI", responsibility: "chasing" }, { name: "HUD", responsibility: "text" }] });
    return prompt.includes('named "World"') ? WORLD : "unexpected";
  });
  const events = [];
  const project = await createGame("A first-person shooter hall.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  const moduleCalls = prompts.filter((p) => /named "/.test(p.prompt));
  assert.equal(moduleCalls.length, 1, "only the World module was requested");
  assert.match(moduleCalls[0].prompt, /Director already provides/);
  assert.match(moduleCalls[0].prompt, /Do NOT write any of those/);
  assert.match(moduleCalls[0].prompt, /g\.scene\.meshes/);
  assert.ok(events.some((e) => /not needed: PlayerController, EnemyAI, HUD/.test(e.message || "")));
  assert.ok(events.some((e) => /Goal: defeat 4 demons/.test(e.message || "")));
  assert.equal(project.gameplay.player.shoots, true);
});

test("a named game steers the design and supplies the gameplay when the designer gives none", { timeout: 120_000 }, async (context) => {
  const dir = await tmp(context, "dir-named-");
  const prompts = withModel(context, (prompt, body) => (body.response_format ? design({ modules: [{ name: "World", responsibility: "arena" }] }) : WORLD));
  const events = [];
  const project = await createGame("A spooky Doom-style shooter in a haunted manor", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  const designPrompt = prompts[0].prompt;
  assert.match(designPrompt, /The user referred to specific games/);
  assert.match(designPrompt, /doom \(3d\): run and gun/);
  assert.match(designPrompt, /Best Director fit: goal defeat/);
  assert.equal(project.gameplay.goal.type, "defeat", "doom's loop became the gameplay");
  assert.equal(project.gameplay.player.shoots, true);
  assert.ok(events.some((e) => /Using as references: doom/.test(e.message || "")));
});

test("a title the library does not know is looked up with the model and used as a reference", { timeout: 120_000 }, async (context) => {
  const dir = await tmp(context, "dir-unknown-");
  const prompts = withModel(context, (prompt, body, system) => {
    if (system.includes("game historian")) return JSON.stringify({ known: true, dimension: "3d", loop: "explore a tiny solar system and learn why time loops", signature: ["time loop", "small planets", "curiosity"], gameplay: { goal: { type: "exit", label: "answer" }, threat: { type: "timer", seconds: 90 }, player: { health: 1 } } });
    return body.response_format ? design({ modules: [{ name: "World", responsibility: "planets" }] }) : WORLD;
  });
  const events = [];
  const project = await createGame("Make something like Outer Wilds but tiny", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.equal(prompts.filter((p) => p.system.includes("game historian")).length, 1);
  assert.match(prompts.find((p) => /lead game designer/.test(p.system)).prompt, /Outer Wilds \(3d\): explore a tiny solar system/);
  assert.equal(project.gameplay.goal.type, "exit");
  assert.ok(events.some((e) => /Looked up "Outer Wilds"/.test(e.message || "")));
});

test("a world module that breaks the controls is repaired once, then removed so the Director takes over", { timeout: 180_000 }, async (context) => {
  const dir = await tmp(context, "dir-gate-");
  const STUCK = 'Game.module("World", { update: function (g) { g.player = { x: 0, y: 1.6, z: 0 }; } });';
  const prompts = withModel(context, (prompt, body) => (body.response_format ? design({ gameplay: GAMEPLAY, modules: [{ name: "World", responsibility: "the hall" }] }) : STUCK));
  const events = [];
  const project = await createGame("A haunted hall.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.ok(prompts.some((p) => /Playtest finding/.test(p.prompt)), "the finding went back to the module");
  assert.ok(events.some((e) => /Removed module World: it breaks the player controls/.test(e.message || "")));
  assert.equal(project.fallback, false);
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(!js.includes("/* module World */"), "the broken module is gone");
});

test("2.5D with no world module gets the automatic floor", { timeout: 120_000 }, async (context) => {
  const dir = await tmp(context, "dir-floor-");
  withModel(context, (prompt, body) => (body.response_format ? design({ dimension: "2.5d", gameplay: GAMEPLAY, modules: [{ name: "Courtyard", responsibility: "tiles" }] }) : "nope"));
  const project = await createGame("An isometric garden.", "handoff", { projectsDir: dir, emit: () => {} });
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('"autoFloor":true'));
  assert.equal(project.dimension, "2.5d");
});

/* ---------------- jumping, building and the side-scroller through the generator ---------------- */
const { normalizeDesign } = require("./game-generator");

test("the menu knows jumping, building and the side-scroller, and refuses combinations that cannot work", () => {
  const side = normalizeGameplay({ view: "side", goal: { type: "collect" }, player: { jumps: "true" } });
  assert.equal(side.view, "side"); assert.equal(side.player.jumps, true);
  const build = normalizeGameplay({ goal: { type: "construct a shelter", count: 3 } });
  assert.equal(build.goal.type, "build"); assert.equal(build.player.builds, true, "a build goal turns building on"); assert.equal(build.player.jumps, true, "building implies jumping");
  assert.equal(normalizeGameplay({ player: { builds: true } }).player.jumps, true);
  assert.equal(normalizeGameplay({ view: "diagonal" }).view, "free");

  assert.equal(normalizeDesign({ dimension: "3d", gameplay: { view: "side" } }, "x").gameplay.view, "free", "the side-scroller is 2D only");
  const flat = normalizeDesign({ dimension: "2d", gameplay: { goal: { type: "build" }, player: { builds: true } } }, "x").gameplay;
  assert.equal(flat.player.builds, false, "building is 3D only"); assert.equal(flat.goal.type, "collect");
  assert.equal(normalizeDesign({ dimension: "3d", gameplay: { goal: { type: "build" } } }, "x").gameplay.goal.type, "build");
  assert.equal(normalizeDesign({ dimension: "2d", gameplay: { view: "side" } }, "x").gameplay.view, "side");
});

test("the named games now use the real mechanics instead of approximations", () => {
  const mario = findNamedGames("a mario game with a dragon")[0];
  assert.equal(mario.gameplay.view, "side"); assert.equal(mario.gameplay.player.jumps, true); assert.ok(!mario.note, "no 'not supported' caveat");
  const mine = findNamedGames("a minecraft style survival game")[0];
  assert.equal(mine.gameplay.player.builds, true); assert.equal(mine.gameplay.goal.type, "build"); assert.equal(mine.dimension, "3d");
  assert.equal(findNamedGames("terraria")[0].gameplay.view, "side");
  assert.equal(findNamedGames("a roblox obby")[0].gameplay.player.jumps, true);
  assert.equal(findNamedGames("like mario 64")[0].dimension, "3d");
});

test("a side-scroller is built end to end: the config says so, the model is told the level scrolls, and it passes the playtest", { timeout: 180_000 }, async (context) => {
  const dir = await tmp(context, "dir-side-");
  const prompts = withModel(context, (prompt, body) => (body.response_format
    ? design({ dimension: "2d", canvas: { width: 800, height: 600 }, gameplay: { view: "side", goal: { type: "collect", label: "coins", count: 6 }, threat: { type: "patrol", label: "slime", count: 3, speed: "slow" }, player: { health: 3, jumps: true } }, modules: [{ name: "Backdrop", responsibility: "clouds and trees" }] })
    : 'Game.module("Backdrop", { draw: function (g, ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(300, 80, 80, 16); } });'));
  const events = [];
  const project = await createGame("A Mario-like platformer about a knight collecting coins.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('"view":"side"') && js.includes('"jumps":true'));
  assert.ok(js.includes("Game.sideDirector = function"));
  const moduleCall = prompts.find((p) => /named "Backdrop"/.test(p.prompt));
  assert.match(moduleCall.prompt, /level scrolls sideways/);
  assert.match(moduleCall.prompt, /Game\.module\("Backdrop"/, "the side-view world example was used");
  assert.equal(project.fallback, false);
  assert.ok(events.some((e) => /Playtest passed: the bot moved/.test(e.message || "")), events.map((e) => e.message).filter(Boolean).slice(-4).join(" | "));
  assert.ok(events.some((e) => /Using as references: super mario/.test(e.message || "")));
});

test("a block-building game is built end to end and the world module is told to make climbable platforms", { timeout: 180_000 }, async (context) => {
  const dir = await tmp(context, "dir-build-");
  const prompts = withModel(context, (prompt, body) => (body.response_format
    ? design({ gameplay: { goal: { type: "build", label: "blocks", count: 4 }, threat: { type: "chasers", label: "creeper", count: 2, speed: "normal", sight: "normal" }, player: { health: 4 } }, modules: [{ name: "World", responsibility: "terrain" }] })
    : WORLD));
  const events = [];
  const project = await createGame("A block building survival game in 3D.", "handoff", { projectsDir: dir, emit: (e) => events.push(e) });
  const js = await fs.readFile(path.join(dir, project.id, "game.js"), "utf8");
  assert.ok(js.includes('"builds":true') && js.includes('"jumps":true') && js.includes('"type":"build"'));
  assert.match(prompts.find((p) => /named "World"/.test(p.prompt)).prompt, /low platforms 0\.8 to 1\.6 high/);
  assert.ok(events.some((e) => /Goal: build 4 blocks/.test(e.message || "")));
  assert.ok(events.some((e) => /Playtest passed/.test(e.message || "")));
  assert.equal(project.fallback, false);
});
