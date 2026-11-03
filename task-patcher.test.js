process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGodotGame } = require("./godot-generator");
const { findGodot } = require("./godot-runner");
const { executeAssignedTask, listProjects } = require("./project-builder");

const godot = findGodot();
const design = {
  title: "Task Vale", genre: "adventure", canvas: { width: 640, height: 480 },
  palette: { bg: "#101418", panel: "#1a2027", accent: "#ffb454", text: "#eee", danger: "#f33" },
  controls: ["Arrows"], modules: [{ name: "main", responsibility: "game" }, { name: "hero", responsibility: "player" }],
  tasks: [
    { title: "Add score counter", owner: "Gameplay engineer", description: "Count presses of the action key and show them." },
    { title: "Second task here", owner: "QA tester", description: "Check the second thing carefully." },
    { title: "Third task here", owner: "Producer", description: "Plan the third thing carefully." },
  ],
};
const main = `extends Node2D
var pos := Vector2(100, 100)
func _process(delta: float) -> void:
	pos += Input.get_vector("move_left", "move_right", "move_up", "move_down") * 100.0 * delta
	queue_redraw()
func _draw() -> void:
	draw_circle(pos, 10.0, Color.ORANGE)
`;

test("task bots patch a Godot project, re-verify and re-export it; QA rejection changes nothing", { skip: !godot, timeout: 300_000 }, async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gd-task-"));
  context.after(async () => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  });
  let approve = true;
  global.fetch = async (_url, options) => {
    const [system] = JSON.parse(options.body).messages.map((m) => m.content);
    let content;
    if (system.includes("lead game designer")) content = JSON.stringify(design);
    else if (system.includes("strict QA lead")) content = JSON.stringify({ faithful: true, missing: [] });
    else if (system.includes("independent QA reviewer")) content = JSON.stringify({ approved: approve, findings: approve ? "Looks right." : "Does not meet the task." });
    else if (system.includes("implementing one assigned task")) content = JSON.stringify({
      summary: "Added a score counter shown on screen.",
      patches: [
        { file: "scripts/main.gd", find: "var pos := Vector2(100, 100)", replace: "var pos := Vector2(100, 100)\nvar score := 0" },
        { file: "scripts/main.gd", find: "\tqueue_redraw()", replace: "\tif Input.is_action_just_pressed(\"action\"):\n\t\tscore += 1\n\tqueue_redraw()" },
      ],
    });
    else if (JSON.parse(options.body).messages[1].content.includes("Write scripts/hero.gd")) content = "class_name Hero\nextends RefCounted\n";
    else content = main;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const created = await createGodotGame("An adventure", "handoff", { projectsDir: directory, godot });
  const saved = path.join(directory, created.id);
  const scriptPath = path.join(saved, "godot", "scripts", "main.gd");
  const pckBefore = (await fs.stat(path.join(saved, "web", "index.pck"))).mtimeMs;

  approve = false;
  await assert.rejects(() => executeAssignedTask(created.id, "task-1", directory), /QA rejected/);
  assert.doesNotMatch(await fs.readFile(scriptPath, "utf8"), /score/);
  assert.equal((await listProjects(directory))[0].tasks[0].status, "todo");

  approve = true;
  const result = await executeAssignedTask(created.id, "task-1", directory);
  assert.match(result.summary, /score counter/);
  assert.match(await fs.readFile(scriptPath, "utf8"), /score \+= 1/);
  assert.ok((await fs.stat(path.join(saved, "web", "index.pck"))).mtimeMs > pckBefore, "web build was re-exported");
  assert.equal((await listProjects(directory))[0].tasks[0].status, "done");
  assert.deepEqual((await fs.readdir(saved)).filter((n) => n.startsWith("web.old")), []);
});
