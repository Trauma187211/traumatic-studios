const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { applyPatches, generateGame, smokeTest, validateDesign } = require("./game-generator");
const { createGame } = require("./game-generator");
const { readProjectSources } = require("./project-builder");

const design = {
  title: "Ember Keep",
  genre: "top-down action adventure",
  canvas: { width: 640, height: 480 },
  palette: { bg: "#111", panel: "#222", accent: "#fa0", text: "#eee", danger: "#f33" },
  controls: ["Arrows move", "Space swings sword"],
  modules: [
    { name: "main", responsibility: "loop" },
    { name: "world", responsibility: "rooms", exports: ["makeWorld"] },
  ],
  tasks: [
    { title: "Add a boss fight", owner: "Game designer", description: "Design the final boss pattern." },
    { title: "Add item pickups", owner: "Gameplay engineer", description: "Add hearts and keys to rooms." },
    { title: "Test room transitions", owner: "QA tester", description: "Walk every room edge in the dungeon." },
  ],
};

const worldCode = "function makeWorld(seed) { const r = Engine.rng(seed); return { x: r.int(1, 5), y: 2 }; }";
const mainCode = `let state;
Engine.start({
  reset() { state = { world: makeWorld(7), t: 0 }; },
  update(dt) { state.t += dt; const m = Engine.move(); state.world.x += m.x; if (Engine.action()) { Engine.sfx("hit"); Engine.fx.burst(10, 10); } },
  draw(ctx) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, Engine.W, Engine.H); ctx.fillStyle = "#fa0"; ctx.fillRect(state.world.x, state.world.y + state.t * 10, 8, 8); Engine.fx.draw(ctx); Engine.ui.hud("t " + state.t); },
});`;

function mockModel(context, { brokenMain = false } = {}) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  const seen = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const [system, user] = body.messages.map((message) => message.content);
    seen.push(user);
    let content;
    if (system.includes("lead game designer")) content = JSON.stringify(design);
    else if (system.includes("strict QA lead")) content = JSON.stringify({ faithful: true, missing: [] });
    else if (system.includes("exact-text patches")) content = JSON.stringify({ patches: [{ find: "state.worldd.x", replace: "state.world.x" }] });
    else if (user.includes('Module to write now: "world"')) content = `\`\`\`js\n${worldCode}\n\`\`\``;
    else content = brokenMain ? mainCode.replace("state.world.x +=", "state.worldd.x +=") : mainCode;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return seen;
}

test("builds a multi-module game from a design and passes the simulated-play smoke test", async (context) => {
  const seen = mockModel(context);
  const { project } = await generateGame("A Zelda-style dungeon crawler", "handoff");
  assert.match(project.gameJs, /const Engine = /);
  assert.match(project.gameJs, /function makeWorld/);
  assert.ok(seen.some((prompt) => prompt.includes("function makeWorld")), "later modules see earlier source");
  assert.equal(smokeTest(project.gameJs, { width: 640, height: 480 }), null);
  assert.match(project.indexHtml, /width="640" height="480"/);
});

test("blueprint route turns a small JSON spec into a passing game, or falls back when custom", async (context) => {
  const originalMode = process.env.STUDIO_BLUEPRINTS;
  process.env.STUDIO_BLUEPRINTS = "always";
  context.after(() => { if (originalMode === undefined) delete process.env.STUDIO_BLUEPRINTS; else process.env.STUDIO_BLUEPRINTS = originalMode; });
  const seen = mockModel(context);
  const realFetch = global.fetch;
  let routerReply = JSON.stringify({ type: "platformer", title: "Cloud Hopper", theme: "ocean", enemies: [{ name: "Gull", behavior: "flyer" }], seed: 5 });
  global.fetch = async (url, options) => {
    if (JSON.parse(options.body).messages[0].content.includes("JSON game spec")) return { ok: true, json: async () => ({ choices: [{ message: { content: routerReply } }] }) };
    return realFetch(url, options);
  };
  const built = await generateGame("A cloud-hopping platformer", "handoff");
  assert.equal(built.design.title, "Cloud Hopper");
  assert.match(built.project.gameJs, /Blueprint\.run\(/);
  assert.equal(built.project.tasks.length, 3);
  assert.equal(smokeTest(built.project.gameJs, { width: 800, height: 560 }), null);

  routerReply = JSON.stringify({ type: "custom" });
  const fallback = await generateGame("A sliding tile puzzle", "handoff");
  assert.match(fallback.project.gameJs, /function makeWorld/);
  assert.ok(seen.length > 0);
});

test("repairs a runtime crash with patches before saving", async (context) => {
  mockModel(context, { brokenMain: true });
  const events = [];
  const { project } = await generateGame("A dungeon crawler", "handoff", (event) => events.push(event));
  assert.equal(smokeTest(project.gameJs, { width: 640, height: 480 }), null);
  assert.ok(events.some((event) => /Fixing issue/.test(event.message || "")));
});

test("saves the generated game as a project with its follow-up tasks", async (context) => {
  mockModel(context);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "generator-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = await createGame("A dungeon crawler", "handoff", { projectsDir: directory });
  assert.equal(saved.tasks.length, 3);
  const sources = await readProjectSources(saved.id, directory);
  assert.match(sources["game.js"], /makeWorld/);
});

test("smoke test reports crashes and validates designs", () => {
  assert.match(smokeTest("throw new Error('boom');", { width: 100, height: 100 }), /boom/);
  assert.match(smokeTest("const a = 1;", { width: 100, height: 100 }), /never started/);
  assert.throws(() => validateDesign({ title: "x", modules: [{ name: "alpha", responsibility: "b" }, { name: "beta", responsibility: "d" }] }), /main module/);
  assert.deepEqual(applyPatches("abc abc", [{ find: "abc", replace: "x" }]), { result: "abc abc", applied: 0 });
  assert.equal(applyPatches("one two", [{ find: "two", replace: "2" }]).result, "one 2");
});
