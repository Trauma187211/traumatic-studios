process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGame, reviseGame, parseModules } = require("./game-generator");

const TASKS = [
  { title: "Add a second area", owner: "Game designer", description: "Design a second area with a new hazard." },
  { title: "Add a rare item", owner: "Gameplay engineer", description: "Add a rare item that changes the route." },
  { title: "Test every wall", owner: "QA tester", description: "Walk every wall and corner looking for clipping." },
];
const GAMEPLAY = { goal: { type: "collect", label: "lanterns", count: 5 }, threat: { type: "chasers", label: "stalker", count: 1, speed: "normal", sight: "long" }, player: { health: 3 } };
const DESIGN = JSON.stringify({ title: "Whispers", genre: "horror", dimension: "3d", pitch: "Gather the lanterns before the stalker finds you.", canvas: { width: 960, height: 540 }, gameplay: GAMEPLAY, modules: [{ name: "World", responsibility: "the hall" }], tasks: TASKS });
const WORLD = 'Game.module("World", { init: function (g) { g.scene.meshes.push(Kit.mesh.plane(40, 40, "#2a3442", "#222b36", 8)); g.world = { bounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 } }; } });';
const SNOWY = 'Game.module("World", { init: function (g) { g.scene.meshes.push(Kit.mesh.plane(40, 40, "#e8eef5", "#dfe7f0", 8)); g.scene.sky = ["#cfd8e3", "#9fb3c8"]; g.world = { bounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 } }; /* snow */ } });';
const FOG = 'Game.module("Fog", { init: function (g) { g.scene.fog = { near: 4, far: 20, color: "#445566" }; /* drifting fog */ } });';
const STUCK = 'Game.module("World", { update: function (g) { g.player = { x: 0, y: 1.6, z: 0 }; } });';

function withModel(context, respond) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  const calls = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const [system, prompt] = body.messages.map((m) => m.content);
    calls.push({ system, prompt });
    return { ok: true, json: async () => ({ choices: [{ message: { content: respond({ system, prompt, body }) } }] }) };
  };
  return calls;
}
async function setup(context, planner, moduleCode = () => WORLD) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "revise-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = withModel(context, ({ system, prompt, body }) => {
    if (system.includes("revising an existing game")) return typeof planner === "function" ? planner(prompt) : planner;
    if (body.response_format) return DESIGN;
    return moduleCode(prompt);
  });
  const original = await createGame("A haunted hall in 3D.", "handoff", { projectsDir: dir, emit: () => {} });
  calls.length = 0;
  const read = async (id) => fs.readFile(path.join(dir, id, "game.js"), "utf8");
  const config = (js) => JSON.parse(/Game\.configure\((\{.*\})\);/.exec(js)[1]);
  return { dir, original, calls, read, config };
}

test("a gameplay change becomes a new version and the old one is untouched", { timeout: 120_000 }, async (context) => {
  const { dir, original, calls, read, config } = await setup(context, JSON.stringify({ action: "change", reply: "The stalker is faster and there are three more lanterns.", gameplay: { threat: { speed: "fast" }, goal: { count: 8 } } }));
  const before = await read(original.id);
  const events = [];
  const result = await reviseGame(original.id, "make the stalker faster and add three more lanterns", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.equal(result.changed, true);
  assert.notEqual(result.project.id, original.id);
  assert.equal(result.project.parentId, original.id);
  assert.equal(result.project.revision, 2);
  assert.match(result.reply, /three more lanterns/);
  const cfg = config(await read(result.project.id));
  assert.equal(cfg.gameplay.goal.count, 8); assert.equal(cfg.gameplay.threat.speed, "fast");
  assert.equal(cfg.gameplay.goal.label, "lanterns", "unchanged fields are kept");
  assert.equal(await read(original.id), before, "the previous version is exactly as it was");
  assert.equal(calls.length, 1, "a pure gameplay change costs one planning call");
  assert.ok(events.some((e) => /Updated the gameplay settings/.test(e.message || "")));
});

test("a look-and-setting change rewrites only the module it concerns, with the current code in the prompt", { timeout: 120_000 }, async (context) => {
  const { dir, original, calls, read } = await setup(context, JSON.stringify({ action: "change", reply: "It is snowing now.", modules: [{ name: "World", action: "rewrite", change: "make it snowy and bright" }] }),
    (prompt) => (prompt.includes("The player asked for this change") ? SNOWY : WORLD));
  const result = await reviseGame(original.id, "make it snowy", { projectsDir: dir, emit: () => {} });
  const js = await read(result.project.id);
  assert.ok(js.includes("/* snow */") && !js.includes('"#2a3442"'));
  const rewrite = calls.find((c) => /named "World"/.test(c.prompt));
  assert.ok(rewrite.prompt.includes('"#2a3442"'), "the current module is sent along");
  assert.match(rewrite.prompt, /The player asked for this change: make it snowy and bright/);
  assert.deepEqual(parseModules(js).map((m) => m.name), ["World"]);
});

test("a new world module can be added; modules the Director owns are refused", { timeout: 120_000 }, async (context) => {
  const { dir, original, read } = await setup(context, JSON.stringify({ action: "change", reply: "Added fog.", modules: [{ name: "Fog", action: "add", change: "add drifting fog" }, { name: "PlayerController", action: "add", change: "faster player" }] }),
    (prompt) => (/named "Fog"/.test(prompt) ? FOG : WORLD));
  const events = [];
  const result = await reviseGame(original.id, "add fog and run faster", { projectsDir: dir, emit: (e) => events.push(e) });
  const js = await read(result.project.id);
  assert.deepEqual(parseModules(js).map((m) => m.name), ["World", "Fog"]);
  assert.ok(events.some((e) => /Director handles "PlayerController"/.test(e.message || "")));
  const record = JSON.parse(await fs.readFile(path.join(dir, result.project.id, "studio-design.json"), "utf8"));
  assert.deepEqual(record.design.modules.map((m) => m.name), ["World", "Fog"]);
});

test("a question is answered without creating a new version", { timeout: 120_000 }, async (context) => {
  const { dir, original } = await setup(context, JSON.stringify({ action: "answer", reply: "The stalker wanders until it sees you, then it hunts you." }));
  const before = (await fs.readdir(dir)).length;
  const result = await reviseGame(original.id, "what does the stalker do?", { projectsDir: dir, emit: () => {} });
  assert.equal(result.changed, false);
  assert.match(result.reply, /wanders/);
  assert.equal((await fs.readdir(dir)).length, before, "nothing was saved");
});

test("revisions chain, remember what was asked, and the conversation history reaches the planner", { timeout: 180_000 }, async (context) => {
  const { dir, original, calls, read } = await setup(context, (prompt) => JSON.stringify({ action: "change", reply: "Done.", gameplay: { threat: { count: /two/.test(prompt) ? 3 : 2 } } }));
  const first = await reviseGame(original.id, "add another stalker", { projectsDir: dir, emit: () => {}, history: [] });
  const second = await reviseGame(first.project.id, "now make it two more", { projectsDir: dir, emit: () => {}, history: ["add another stalker"] });
  assert.equal(second.project.revision, 3);
  assert.equal(second.project.parentId, first.project.id);
  const record = JSON.parse(await fs.readFile(path.join(dir, second.project.id, "studio-design.json"), "utf8"));
  assert.deepEqual(record.instructions, ["add another stalker", "now make it two more"]);
  assert.match(calls.at(-1).prompt, /Earlier requests in this conversation:\n- add another stalker/);
  assert.equal(JSON.parse(/Game\.configure\((\{.*\})\);/.exec(await read(second.project.id))[1]).gameplay.threat.count, 3);
});

test("a revision that breaks the controls is repaired or the broken module is dropped, never shipped", { timeout: 180_000 }, async (context) => {
  const { dir, original, read } = await setup(context, JSON.stringify({ action: "change", reply: "Rewrote the hall.", modules: [{ name: "World", action: "rewrite", change: "rebuild the hall" }] }),
    (prompt) => (prompt.includes("The player asked for this change") || prompt.includes("Playtest finding") ? STUCK : WORLD));
  const events = [];
  const result = await reviseGame(original.id, "rebuild the hall", { projectsDir: dir, emit: (e) => events.push(e) });
  assert.ok(events.some((e) => /Removed module World: it broke the game/.test(e.message || "")));
  assert.deepEqual(parseModules(await read(result.project.id)), [], "the Director's own arena is used instead");
});

test("bad requests fail with a plain message", { timeout: 60_000 }, async (context) => {
  const { dir, original } = await setup(context, "this is not json at all");
  await assert.rejects(reviseGame("not-a-project", "x y z", { projectsDir: dir }), /Invalid project identifier/);
  await assert.rejects(reviseGame("game-1-abcdef12", "make it harder", { projectsDir: dir }), /made before revisions were supported/);
  await assert.rejects(reviseGame(original.id, "  ", { projectsDir: dir }), /Tell me what you want to change/);
  await assert.rejects(reviseGame(original.id, "make it harder", { projectsDir: dir }), /could not work out what to change/);
});
