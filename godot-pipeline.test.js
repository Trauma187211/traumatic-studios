process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { applyFilePatches, sanitizeGd, normalizeGodotDesign, modulePrompt, createGodotGame } = require("./godot-generator");
const { chat, parseJson, smokeTest } = require("./game-generator");

function withModel(context, respond) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  });
  const seen = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const [system, user] = body.messages.map((m) => m.content);
    seen.push({ system, user, body });
    return { ok: true, json: async () => ({ choices: [{ message: { content: respond(system, user, body) } }] }) };
  };
  return seen;
}

// A stand-in godot executable (shebang script), so the orchestration can be tested without Godot. Not for Windows.
async function fakeGodot(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-godot-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "godot");
  await fs.writeFile(file, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const dir = args[args.indexOf("--path") + 1];
if (args.includes("--import")) process.exit(0);
if (args.includes("--quit-after")) {
  const main = fs.readFileSync(path.join(dir, "scripts/main.gd"), "utf8");
  if (main.includes("hero.poss")) console.log('SCRIPT ERROR: Parse Error: Cannot find member "poss" in base "Hero".\\n          at: GDScript::reload (res://scripts/main.gd:9)');
  process.exit(0);
}
if (args.includes("--export-release")) {
  const out = args[args.indexOf("--export-release") + 2], od = path.dirname(out);
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(out, "<html></html>"); fs.writeFileSync(path.join(od, "index.wasm"), "w"); fs.writeFileSync(path.join(od, "index.pck"), "p");
}
`, { mode: 0o755 });
  return file;
}
const onUnix = process.platform !== "win32";

const DESIGN = (extra = {}) => JSON.stringify({
  title: "Lantern Vale", genre: "adventure", dimension: "2d", pitch: "Carry a lantern through a vale.", canvas: { width: 640, height: 480 },
  palette: { bg: "#101418", accent: "#ffb454" }, controls: ["Arrows move"],
  modules: [{ name: "main", responsibility: "game" }, { name: "hero", responsibility: "player" }],
  tasks: [
    { title: "Add a boss fight", owner: "Game designer", description: "Design the final boss pattern." },
    { title: "Add item pickups", owner: "Gameplay engineer", description: "Add hearts and keys to rooms." },
    { title: "Test room transitions", owner: "QA tester", description: "Walk every room edge in the dungeon." },
  ], ...extra,
});
const HERO = "class_name Hero\nextends RefCounted\nvar pos := Vector2(100, 100)\nfunc step(dir: Vector2, delta: float) -> void:\n\tpos += dir * 150.0 * delta\n";
const MAIN = (typo) => `extends Node2D\nvar hero := Hero.new()\nfunc _process(delta: float) -> void:\n\thero.step(Input.get_vector("move_left", "move_right", "move_up", "move_down"), delta)\n\tqueue_redraw()\nfunc _draw() -> void:\n\tdraw_circle(${typo ? "hero.poss" : "hero.pos"}, 10.0, Color.ORANGE)\n`;

test("exact-text patches apply only when the find text is unique", () => {
  const files = { "scripts/a.gd": "x y x", "scripts/b.gd": "hello" };
  assert.equal(applyFilePatches(files, [{ file: "scripts/a.gd", find: "x", replace: "z" }]), 0, "ambiguous find is skipped");
  assert.equal(applyFilePatches(files, [{ file: "res://scripts/b.gd", find: "hello", replace: "bye" }, { file: "scripts/none.gd", find: "q", replace: "r" }, { nope: 1 }]), 1);
  assert.equal(files["scripts/b.gd"], "bye");
  assert.equal(applyFilePatches(files, "not an array"), 0);
});

test("GDScript from the model is cleaned deterministically", () => {
  const raw = 'Sure! Here is the file:\n```gdscript\nextends Node\nvar snd = preload("res://audio/hit.wav")\nvar ok = preload("res://scripts/hero.gd")\nfunc _ready():\n\tvar f = FileAccess.open("x", FileAccess.READ)\n```';
  const code = sanitizeGd(raw, "main");
  assert.match(code, /^extends Node2D/, "main must extend the Node2D root");
  assert.match(code, /var snd = null/, "loads outside scripts, scenes and data are removed");
  assert.match(code, /preload\("res:\/\/scripts\/hero\.gd"\)/, "loads inside scripts are kept");
  assert.match(code, /\n\tpass # removed: unsafe API/, "unsafe API lines are neutralised with indentation kept");
  assert.ok(!/Sure!|```/.test(code));
  assert.equal(sanitizeGd("hello", "hero").startsWith("hello"), true);
  assert.equal(sanitizeGd("", "hero"), "");
});

test("Godot designs get snake_case modules, main last, and a 2d or 3d dimension", () => {
  const d = normalizeGodotDesign({ title: "T", dimension: "2.5d", modules: [{ name: "Main", responsibility: "scene" }, { name: "Enemy Spawner!", responsibility: "waves" }, { name: "studio", responsibility: "reserved" }, { name: "hero", responsibility: "player" }] }, "brief");
  assert.deepEqual(d.modules.map((m) => m.name), ["enemy_spawner", "hero", "main"]);
  assert.equal(d.dimension, "3d");
  assert.equal(normalizeGodotDesign(null, "a tiny garden").modules.at(-1).name, "main");
  assert.equal(normalizeGodotDesign({ dimension: "2d" }, "x").dimension, "2d");
});

test("module prompts carry the right skeleton and class names", () => {
  const design = normalizeGodotDesign({ title: "T", dimension: "3d", modules: [{ name: "enemy_spawner", responsibility: "waves" }] }, "b");
  const spawner = modulePrompt(design, design.modules[0], null);
  assert.match(spawner, /Write scripts\/enemy_spawner\.gd/);
  assert.match(spawner, /class_name EnemySpawner/);
  const main = modulePrompt(design, design.modules.at(-1), { "scripts/enemy_spawner.gd": "class_name EnemySpawner" });
  assert.match(main, /look_at_from_position/);
  assert.match(main, /class_name EnemySpawner/);
});

test("compatibility exports: parseJson throws, chat sends messages through, smokeTest reports crashes", { timeout: 60_000 }, async (context) => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJson("no json here"), /valid JSON/);
  const seen = withModel(context, () => '{"ok":true}');
  assert.equal(await chat([{ role: "system", content: "s" }, { role: "user", content: "u" }], { json: true, maxTokens: 50 }), '{"ok":true}');
  assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  assert.equal(seen[0].body.max_tokens, 50);
  assert.equal(seen[0].user, "u");

  const generic = 'var c = document.getElementById("game"); var x = c.getContext("2d"); function f() { x.fillRect(0, 0, 10, 10); requestAnimationFrame(f); } requestAnimationFrame(f);';
  const direct = smokeTest(generic, { width: 800, height: 600 });
  assert.ok(!(direct instanceof Promise), "smokeTest is synchronous");
  assert.equal(direct, null);
  assert.match(smokeTest('throw new Error("Unknown blueprint type: nope");'), /Unknown blueprint type: nope/);
  assert.match(smokeTest('var n = 0; function f() { n++; if (n > 3) throw new Error("boom at frame 3"); requestAnimationFrame(f); } requestAnimationFrame(f);'), /boom at frame 3/);
  assert.match(smokeTest("while (true) {}", {}, 30), /./);
});

test("when patches do not apply, the offending file is rewritten instead", { skip: !onUnix, timeout: 60_000 }, async (context) => {
  const godot = await fakeGodot(context);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gd-rewrite-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seen = withModel(context, (system, user) => {
    if (system.includes("lead game designer")) return DESIGN();
    if (system.includes("strict QA lead")) return JSON.stringify({ faithful: false, missing: ["a boss fight"] });
    if (system.includes("exact-text patches")) return JSON.stringify({ patches: [{ file: "scripts/main.gd", find: "THIS TEXT IS NOT THERE", replace: "x" }] });
    if (system.includes("repair one GDScript file")) return "```gdscript\n" + MAIN(false) + "```";
    return user.includes("Write scripts/hero.gd") ? HERO : MAIN(true);
  });
  const events = [];
  const project = await createGodotGame("A lantern adventure", "handoff", { projectsDir: dir, emit: (e) => events.push(e), godot });
  assert.equal(project.mode, "godot");
  assert.equal(seen.filter((c) => c.system.includes("exact-text patches")).length, 1);
  assert.equal(seen.filter((c) => c.system.includes("repair one GDScript file")).length, 1);
  assert.ok(!events.some((e) => /no applicable/.test(e.message || "")));
  const main = await fs.readFile(path.join(dir, project.id, "godot", "scripts", "main.gd"), "utf8");
  assert.match(main, /hero\.pos,/);
  assert.ok(project.tasks.some((t) => /Close gap: a boss fight/.test(t.title)), "QA gaps become follow-up tasks");
});

test("a 3D build uses the 3D skeleton, exports the web build and saves a wrapper page", { skip: !onUnix, timeout: 60_000 }, async (context) => {
  const godot = await fakeGodot(context);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gd-3d-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seen = withModel(context, (system, user) => {
    if (system.includes("lead game designer")) return DESIGN({ title: "Echo Hall", dimension: "3d", canvas: { width: 960, height: 540 }, modules: [{ name: "main", responsibility: "the hall" }] });
    if (system.includes("strict QA lead")) return JSON.stringify({ faithful: true, missing: [] });
    return "extends Node2D\nvar world := Node3D.new()\nfunc _ready() -> void:\n\tadd_child(world)\n";
  });
  const project = await createGodotGame("A first-person haunted hall", "handoff", { projectsDir: dir, emit: () => {}, godot });
  assert.equal(project.dimension, "3d");
  assert.match(project.id, /^game-\d+-[a-f0-9]{8}$/);
  assert.ok(seen.some((c) => /look_at_from_position/.test(c.user)), "the 3D skeleton reached the main.gd prompt");
  const root = path.join(dir, project.id);
  for (const file of ["index.html", "game.js", "game.css", "web/index.html", "web/index.wasm", "web/index.pck", "godot/project.godot", "godot/scripts/main.gd"]) await fs.access(path.join(root, file));
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<iframe id="frame" src="\.\/web\/index\.html"/);
  assert.match(html, /href="\.\/game\.css"/);
  assert.match(html, /src="\.\/game\.js"/);
});

test("without Godot the generator fails fast so studio.js can use the browser engine", async () => {
  await assert.rejects(createGodotGame("x", "y", { godot: null }), /Godot was not found/);
});
