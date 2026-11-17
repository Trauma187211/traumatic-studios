/**
 * Traumatic Studios - Godot generator (2D and 3D).
 *
 * design -> one GDScript file per module -> Godot's own headless check -> repair loop -> web export -> save.
 * Exports applyFilePatches and repairFiles for task-patcher.js, and createGodotGame for studio.js.
 */
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chat, parseJson, tryParseJson, normalizeDesign, safeText, clip } = require("./game-generator");
const { checkProject, exportWeb, writeProject } = require("./godot-runner");
const { validateProject, saveProject } = require("./project-builder");
const { pickReferences, formatReferences } = require("./design-references");

const MAX_REPAIRS = 4;
const MAX_MODULES = 7;
// Keep in sync with FORBIDDEN_GD in godot-runner.js.
const FORBIDDEN_GD = /\b(OS\.execute|OS\.shell_open|OS\.create_process|HTTPRequest|HTTPClient|TCPServer|StreamPeerTCP|WebSocketPeer|UDPServer|JavaScriptBridge|DirAccess|FileAccess|OS\.kill|ClassDB\.instantiate|Expression\.new|load_threaded)\b/;
const OUTSIDE_LOAD = /\b(?:preload|load)\(\s*["']res:\/\/(?!scripts\/|scenes\/|data\/)[^"']*["']\s*\)/g;

const dump = (files) => Object.entries(files).map(([name, code]) => `--- ${name} ---\n${code}`).join("\n\n");
const pascal = (name) => name.split("_").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");

/* ---------- patches (used by task-patcher.js too) ---------- */
/** Applies exact-text patches in place. Each find must be a unique substring. Returns how many applied. */
function applyFilePatches(files, patches) {
  let applied = 0;
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch || typeof patch.file !== "string" || typeof patch.find !== "string" || typeof patch.replace !== "string" || !patch.find) continue;
    const name = patch.file.replace(/^res:\/\//, "").replace(/^\/+/, "");
    const current = files[name];
    if (typeof current !== "string") continue;
    const first = current.indexOf(patch.find);
    if (first < 0 || current.indexOf(patch.find, first + 1) >= 0) continue;
    files[name] = current.slice(0, first) + patch.replace + current.slice(first + patch.find.length);
    applied++;
  }
  return applied;
}

/* ---------- deterministic clean-up of model output ---------- */
function sanitizeGd(text, name) {
  let code = String(text || "");
  const fenced = code.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
  if (fenced) code = fenced[1];
  code = code.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const lines = code.split("\n");
  const start = lines.findIndex((line) => /^(?:class_name|extends|@tool|@icon|@export|@onready|#|var |const |signal |func |enum |static )/.test(line));
  if (start > 0) code = lines.slice(start).join("\n");
  code = code.replace(OUTSIDE_LOAD, "null");
  code = code.split("\n").map((line) => (FORBIDDEN_GD.test(line) ? `${line.match(/^\s*/)[0]}pass # removed: unsafe API` : line)).join("\n");
  if (name === "main") {
    if (!/^\s*extends\s/m.test(code)) code = `extends Node2D\n${code}`;
    code = code.replace(/^(\s*extends\s+)(?!Node2D\b)\w+/m, "$1Node2D"); // main.tscn's root is a Node2D
  }
  return code.trim() ? `${code.trim()}\n` : "";
}

async function rewriteOffendingFile(title, files, problem) {
  const named = String(problem).match(/res:\/\/(scripts\/[a-z0-9_]+\.gd)/i);
  const file = named && files[named[1]] !== undefined ? named[1] : "scripts/main.gd";
  if (files[file] === undefined) return 0;
  const reply = await chat([
    { role: "system", content: "You repair one GDScript file for Godot 4. Reply with the complete corrected file as GDScript only, no markdown and no explanation. Do not load external files." },
    { role: "user", content: `Game: ${title}\nFile: ${file}\nProblems Godot reported:\n${problem}\n\nCurrent content:\n${files[file]}\n\nOther files, for reference only:\n${dump(Object.fromEntries(Object.entries(files).filter(([n]) => n !== file)))}` },
  ], { temperature: 0.2 });
  const fixed = sanitizeGd(reply, path.basename(file, ".gd"));
  if (!fixed || fixed === files[file]) return 0;
  files[file] = fixed;
  return 1;
}

/** Asks for exact-text patches; if none apply, rewrites the file Godot complained about. Returns how many changes landed. */
async function repairFiles(title, design, files, problem) {
  let applied = 0;
  try {
    const reply = await chat([
      { role: "system", content: 'You fix Godot 4 GDScript projects. Reply with JSON only, using exact-text patches: { "patches": [{ "file": "scripts/x.gd", "find": "<exact unique substring of the current file>", "replace": "<fixed text>" }] }. Make the smallest change that resolves the reported problems. Never load external files.' },
      { role: "user", content: `Game: ${title}\nProblems reported by Godot:\n${problem}\n\nCurrent files:\n${dump(files)}\n\nReturn the patches JSON.` },
    ], { json: true, temperature: 0.2 });
    const parsed = tryParseJson(reply);
    applied = parsed ? applyFilePatches(files, parsed.patches) : 0;
  } catch { applied = 0; }
  if (applied === 0) { try { applied = await rewriteOffendingFile(title, files, problem); } catch { applied = 0; } }
  return applied;
}

/* ---------- design ---------- */
function normalizeGodotDesign(raw, brief) {
  const base = normalizeDesign(raw, brief);
  const source = raw && typeof raw === "object" && Array.isArray(raw.modules) ? raw.modules : [];
  const seen = new Set();
  let modules = source.map((m) => ({
    name: safeText(m && m.name, 24).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""),
    responsibility: safeText(m && m.responsibility, 160) || "supporting logic",
  })).filter((m) => /^[a-z][a-z0-9_]{1,23}$/.test(m.name) && m.name !== "studio" && !seen.has(m.name) && seen.add(m.name));
  modules = modules.filter((m) => m.name !== "main").slice(0, MAX_MODULES - 1);
  const main = (source.find((m) => m && String(m.name).toLowerCase() === "main") || {}).responsibility;
  modules.push({ name: "main", responsibility: safeText(main, 160) || "scene setup, the game loop, HUD, and the win and lose rules" });
  return { ...base, dimension: base.dimension === "2d" ? "2d" : "3d", modules };
}

const SKELETON_2D = `extends Node2D

var player_pos := Vector2(400, 280)
var score := 0
var game_over := false

func _process(delta: float) -> void:
	if game_over:
		if Input.is_action_just_pressed("restart") or Input.is_action_just_pressed("action"):
			get_tree().reload_current_scene()
		return
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	player_pos += dir * 200.0 * delta
	queue_redraw()

func _draw() -> void:
	draw_circle(player_pos, 12.0, Color.ORANGE)
	draw_string(ThemeDB.fallback_font, Vector2(12, 24), "Score %d" % score)`;

const SKELETON_3D = `extends Node2D
# The root is a Node2D (fixed by the studio). 3D content lives under a Node3D child; 2D drawing here is the HUD.

var world := Node3D.new()
var cam := Camera3D.new()
var player := MeshInstance3D.new()
var score := 0

func _ready() -> void:
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	world.add_child(sun)
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color("#10203a")
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.6, 0.6, 0.7)
	var we := WorldEnvironment.new()
	we.environment = env
	world.add_child(we)
	world.add_child(cam)
	cam.current = true
	cam.look_at_from_position(Vector3(0, 6, 10), Vector3.ZERO)
	player = make_box(Vector3(1, 1, 1), Color.ORANGE, Vector3.ZERO)

func make_box(size: Vector3, color: Color, pos: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mesh.material = mat
	mi.mesh = mesh
	mi.position = pos
	world.add_child(mi)
	return mi

func _process(delta: float) -> void:
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	player.position += Vector3(dir.x, 0, dir.y) * 5.0 * delta
	queue_redraw()

func _draw() -> void:
	draw_string(ThemeDB.fallback_font, Vector2(12, 24), "Score %d" % score)`;

async function designGame(brief, handoff, references, knowledge) {
  const system = "You are the lead game designer at Traumatic Studios, designing a game that will be built in Godot 4 with GDScript. Reply with one JSON object only, no markdown.";
  const user = [
    `Project brief:\n${brief}`,
    `Approved team handoff:\n${clip(handoff, 5000)}`,
    knowledge ? `Studio lessons:\n${clip(knowledge, 2500)}` : "",
    `Reference blueprints (inspiration only; combine, bend or ignore them, and never copy one wholesale):\n${formatReferences(references)}`,
    'Choose "2d" or "3d" for the idea (use "3d" for first-person, third-person, flight, racing, or when the brief asks for 3D or isometric 2.5D). Do not default to a generic arcade game.',
    'Before coding, turn the brief into 4-8 concrete acceptance checks. Return them as "acceptance" (strings) alongside: "title", "genre", "dimension" ("2d"|"3d"), "pitch", "canvas" {"width","height"}, "palette" {"bg","panel","accent","text","danger"} as #rrggbb, "controls" (up to 6 short strings), "modules" (3 to 6 objects {"name": lowercase_snake_case, "responsibility"} for supporting logic classes, plus one final module named "main" for scene setup, the loop, HUD and win/lose rules), "tasks" (3 to 5 objects {"title","owner","description"}, owner exactly one of Game designer, Gameplay engineer, QA tester, Producer).',
  ].filter(Boolean).join("\n\n");
  return normalizeGodotDesign(tryParseJson(await chat([{ role: "system", content: system }, { role: "user", content: user }], { json: true, temperature: 0.8 })), brief);
}

function modulePrompt(design, spec, written) {
  const isMain = spec.name === "main";
  const cls = pascal(spec.name);
  const rules = [
    "Godot 4 GDScript only: @export and @onready annotations, CharacterBody2D/3D with move_and_slide() (no arguments), signal.connect(callable).",
    "Never load files: no load() or preload() except scripts under res://scripts/. No images, fonts or sound files. Draw with _draw() (draw_rect, draw_circle, draw_string) or with primitive meshes (BoxMesh, SphereMesh, CylinderMesh, PlaneMesh, CapsuleMesh) and StandardMaterial3D colors.",
    'Sound: Studio.sfx("pickup") with kinds blip, pickup, hit, jump, shoot, explode, powerup, lose, win. Input: only the actions move_left, move_right, move_up, move_down, action, action2, pause, restart.',
    "No OS, DirAccess, FileAccess, HTTPRequest or networking APIs. Keep the game crash-proof: it is play-tested headless with random input for about 15 seconds.",
    design.dimension === "3d" ? "For 3D prefer plain position updates and distance checks over physics bodies; keep meshes under about 200." : "Keep entities simple: positions, sizes and distance or rectangle checks.",
  ].join("\n- ");
  const header = isMain
    ? `scripts/main.gd must start with "extends Node2D". It builds the whole game in _ready, runs the loop, draws the HUD, handles win and lose (restart with the action or restart input), and uses the other modules through their class names.\n\n${design.dimension === "3d" ? "3D skeleton (adapt it)" : "2D skeleton (adapt it)"}:\n${design.dimension === "3d" ? SKELETON_3D : SKELETON_2D}`
    : `scripts/${spec.name}.gd must start with "class_name ${cls}" and then "extends RefCounted" (or Node, Node2D or Node3D if it must live in the scene). It is a logic class that main.gd creates with ${cls}.new() and calls through functions that take explicit parameters. Keep it under 120 lines.`;
  return [
    `Game: "${design.title}" (${design.genre}, ${design.dimension}). ${design.pitch}`,
    `Controls: ${design.controls.join("; ") || "move with WASD or arrows, action with Space"}. Canvas ${design.width}x${design.height}.`,
    `All modules:\n${design.modules.map((m) => `- scripts/${m.name}.gd${m.name === "main" ? "" : ` (class ${pascal(m.name)})`}: ${m.responsibility}`).join("\n")}`,
    `Rules:\n- ${rules}`,
    written ? `Files already written (use their class names and functions exactly):\n${dump(written)}` : "",
    `Write scripts/${spec.name}.gd. ${header}`,
    "Reply with the GDScript file only.",
  ].filter(Boolean).join("\n\n");
}

/* ---------- web wrapper pages (the Godot export itself lives in web/) ---------- */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wrapperHtml = (design) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(design.title)}</title>\n<link rel="stylesheet" href="./game.css">\n</head>\n<body>\n<iframe id="frame" src="./web/index.html" title="${escapeHtml(design.title)}" allow="autoplay; fullscreen; gamepad"></iframe>\n<script src="./game.js"></script>\n</body>\n</html>\n`;
const wrapperJs = 'var frame = document.getElementById("frame");\nif (frame) {\n  frame.addEventListener("load", function () { try { frame.contentWindow.focus(); } catch (e) { /* cross-frame focus is optional */ } });\n  frame.focus();\n}\n';
const wrapperCss = (design) => `html, body { margin: 0; height: 100%; background: ${design.palette.bg}; }\nbody { display: flex; align-items: center; justify-content: center; overflow: hidden; }\niframe { border: 0; width: min(100vw, calc(100vh * ${design.width} / ${design.height})); height: min(100vh, calc(100vw * ${design.height} / ${design.width})); background: ${design.palette.bg}; }\n`;

/* ---------- main entry ---------- */
async function createGodotGame(brief, handoff, options = {}) {
  const { projectsDir = path.join(__dirname, "projects"), emit = () => {}, godot } = options || {};
  if (!godot) throw new Error("Godot was not found. Set GODOT_PATH to the Godot executable.");
  const log = (message, level = "info") => emit({ type: "log", level, message });
  const phase = (message) => emit({ type: "phase-started", phase: "build", message });
  let knowledge = "";
  let knowledgeUsed = [];
  try { const library = require("./knowledge"); knowledgeUsed = library.retrieveKnowledge(`${brief}\n${handoff}`); knowledge = String(library.relevantKnowledge(`${brief}\n${handoff}`) || ""); } catch { /* study notes are optional */ }

  const references = pickReferences(`${brief}\n${handoff}`, { count: 3 });
  log(`Using references as inspiration only: ${references.map((r) => r.name).join(", ")}.`);
  const design = await designGame(brief, handoff, references, knowledge);
  log(`Designed "${design.title}" (${design.genre}, ${design.dimension}) as a Godot project with ${design.modules.length} scripts.`);

  const files = {};
  const system = "You write GDScript for Godot 4 for Traumatic Studios. Reply with GDScript code only: no markdown fences and no explanations.";
  const order = [...design.modules.filter((m) => m.name !== "main"), ...design.modules.filter((m) => m.name === "main")];
  for (const spec of order) {
    const file = `scripts/${spec.name}.gd`;
    log(`Writing ${file}`);
    const started = Date.now();
    const reply = await chat([{ role: "system", content: system }, { role: "user", content: modulePrompt(design, spec, { ...files }) }], { temperature: 0.4 });
    files[file] = sanitizeGd(reply, spec.name);
    log(`Wrote ${file}: ${files[file].split("\n").length} lines in ${Math.round((Date.now() - started) / 1000)}s.`);
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "studio-godot-"));
  try {
    const projectDir = path.join(work, "project");
    const meta = { title: design.title, width: design.width, height: design.height };
    log("Running the project in headless Godot to look for errors…");
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const rejected = await writeProject(projectDir, meta, files);
      const errors = rejected.length ? rejected : await checkProject(godot, projectDir);
      if (!errors.length) break;
      if (attempt === MAX_REPAIRS) throw new Error(`Godot still reports errors after repairs: ${errors.slice(0, 3).join(" ; ")}`.slice(0, 500));
      phase(`Godot found ${errors.length} problem(s); repairing (attempt ${attempt + 1}): ${errors[0].slice(0, 140)}`);
      const applied = await repairFiles(design.title, design, files, errors.slice(0, 12).join("\n"));
      if (!applied) log("Repair produced no applicable changes; retrying.", "warn");
    }

    const tasks = [...design.tasks];
    let buildFaithful = null;
    try {
      const review = tryParseJson(await chat([
        { role: "system", content: 'You are a strict QA lead at Traumatic Studios. Compare the brief with the delivered scripts. Return only JSON: { "faithful": boolean, "missing": [short strings] }. Do not claim to have run anything.' },
        { role: "user", content: `Brief:\n${brief}\n\nAcceptance checks:\n${(design.acceptance || []).join("; ")}\n\nScripts:\n${clip(dump(files), 14000)}` },
      ], { json: true, temperature: 0 }));
      buildFaithful = review?.faithful === true;
      const missing = review && Array.isArray(review.missing) ? review.missing.map((m) => safeText(m, 90)).filter(Boolean) : [];
      if (review && review.faithful === false && missing.length) {
        log(`QA says the build is missing: ${missing.slice(0, 3).join("; ")}.`, "warn");
        if (tasks.length < 5) tasks.push({ title: `Close gap: ${missing[0]}`.slice(0, 100), owner: "Gameplay engineer", description: `QA found this missing from the first build: ${missing.slice(0, 3).join("; ")}.`.slice(0, 300) });
      }
    } catch { /* the fidelity review is advisory */ }

    phase("Exporting the Godot build for the web…");
    const outDir = path.join(work, "web");
    await exportWeb(godot, projectDir, outDir);

    const validated = validateProject({ indexHtml: wrapperHtml(design), gameJs: wrapperJs, gameCss: wrapperCss(design), tasks });
    const saved = await saveProject(validated.files, validated.tasks, projectsDir, "godot");
    const root = path.join(projectsDir, saved.id);
    try {
      await fs.cp(outDir, path.join(root, "web"), { recursive: true });
      await fs.cp(projectDir, path.join(root, "godot"), { recursive: true, filter: (source) => !/[\\/]\.godot([\\/]|$)/.test(source) });
      await fs.writeFile(path.join(root, "studio-design.json"), JSON.stringify({ version: 1, brief: clip(brief, 4000), design, fallback: false, knowledgeUsed: knowledgeUsed.map(({ id, topic, source, title, sourceTier, sourceQuality, reason }) => ({ id, topic, source, title, sourceTier, sourceQuality, reason })) }, null, 1), "utf8");
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    try { if (knowledgeUsed.length) require("./knowledge").recordBuildFeedback({ projectId: saved.id, lessonIds: knowledgeUsed.map((item) => item.id), rating: buildFaithful === false ? -1 : 1, source: "automated-godot-validation" }); } catch { /* advisory only */ }
    return { ...saved, title: design.title, genre: design.genre, dimension: design.dimension, engine: "godot" };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

module.exports = { applyFilePatches, repairFiles, createGodotGame, sanitizeGd, normalizeGodotDesign, modulePrompt };
