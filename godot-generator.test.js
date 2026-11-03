process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGodotGame, applyFilePatches } = require("./godot-generator");
const { findGodot, writeProject, extractErrors } = require("./godot-runner");
const { getProjectWebAssetPath } = require("./project-builder");

const godot = findGodot();

const design = {
  title: "Lantern Vale",
  genre: "top-down adventure",
  canvas: { width: 640, height: 480 },
  palette: { bg: "#101418", panel: "#1a2027", accent: "#ffb454", text: "#eee", danger: "#f33" },
  controls: ["Arrows move", "Space acts"],
  modules: [{ name: "main", responsibility: "game" }, { name: "hero", responsibility: "player" }],
  tasks: [
    { title: "Add a boss fight", owner: "Game designer", description: "Design the final boss pattern." },
    { title: "Add item pickups", owner: "Gameplay engineer", description: "Add hearts and keys to rooms." },
    { title: "Test room transitions", owner: "QA tester", description: "Walk every room edge in the dungeon." },
  ],
};
const hero = `class_name Hero
extends RefCounted
var pos := Vector2(100, 100)
func step(dir: Vector2, delta: float) -> void:
	pos += dir * 150.0 * delta
`;
const main = (typo) => `extends Node2D
var hero := Hero.new()
func _process(delta: float) -> void:
	hero.step(Input.get_vector("move_left", "move_right", "move_up", "move_down"), delta)
	if Input.is_action_just_pressed("action"):
		Studio.sfx("pickup")
	queue_redraw()
func _draw() -> void:
	draw_circle(${typo ? "hero.poss" : "hero.pos"}, 10.0, Color.ORANGE)
`;

test("rejects unsafe GDScript and bad paths before Godot sees them", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gd-safe-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const problems = await writeProject(dir, { title: "T", width: 100, height: 100 }, {
    "scripts/main.gd": "extends Node2D\nfunc _ready():\n\tOS.execute('cmd', [])\n",
    "../evil.gd": "x",
  });
  assert.ok(problems.some((p) => /prohibited API/.test(p)));
  assert.ok(problems.some((p) => /Rejected file path/.test(p)));
  assert.deepEqual(extractErrors("Godot Engine v4\nSCRIPT ERROR: Parse Error: bad\n          at: GDScript::reload (res://scripts/main.gd:6)\n"), ["SCRIPT ERROR: Parse Error: bad | at: GDScript::reload (res://scripts/main.gd:6)"]);
  assert.equal(applyFilePatches({ "a.gd": "x y" }, [{ file: "a.gd", find: "y", replace: "z" }]), 1);
  assert.equal(getProjectWebAssetPath("game-1-abcdef12", "../x.js"), null);
});

test("builds, repairs from Godot's own errors, exports and saves a Godot project", { skip: !godot, timeout: 300_000 }, async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gd-e2e-"));
  context.after(async () => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repairs = [];
  global.fetch = async (_url, options) => {
    const [system, user] = JSON.parse(options.body).messages.map((m) => m.content);
    let content;
    if (system.includes("lead game designer")) content = JSON.stringify(design);
    else if (system.includes("strict QA lead")) content = JSON.stringify({ faithful: true, missing: [] });
    else if (system.includes("exact-text patches")) {
      repairs.push(user);
      content = JSON.stringify({ patches: [{ file: "scripts/main.gd", find: "hero.poss", replace: "hero.pos" }] });
    } else if (user.includes("Write scripts/hero.gd")) content = hero;
    else content = main(true);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const events = [];
  const project = await createGodotGame("A lantern adventure", "handoff", { projectsDir: directory, emit: (e) => events.push(e), godot });
  assert.equal(project.mode, "godot");
  assert.ok(repairs.length >= 1 && /poss/.test(repairs[0]), "Godot's error reached the repair prompt");
  const saved = path.join(directory, project.id);
  for (const file of ["index.html", "game.js", "game.css", "web/index.html", "web/index.wasm", "web/index.pck", "godot/project.godot", "godot/scripts/main.gd"]) {
    await fs.access(path.join(saved, file));
  }
  assert.match(await fs.readFile(path.join(saved, "godot", "scripts", "main.gd"), "utf8"), /hero\.pos,/);
  assert.ok(events.some((e) => /repairing/.test(e.message || "")));
});
