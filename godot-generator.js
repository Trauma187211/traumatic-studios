const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chat, DESIGN_SYSTEM, parseJson, stripFences, validateDesign } = require("./game-generator");
const { checkProject, exportWeb, findGodot, writeProject } = require("./godot-runner");
const { saveProject, validateProject } = require("./project-builder");
const { relevantKnowledge } = require("./knowledge");

const MAX_REPAIRS = 4;

const GODOT_DESIGN_SYSTEM = DESIGN_SYSTEM
  .replace(/- Everything is drawn with canvas 2D primitives[^\n]*\n/, "- The game is built in Godot 4 with GDScript, 2D only, with no external assets: all visuals are drawn procedurally (_draw(), Polygon2D, Line2D, ColorRect, GPUParticles2D/CPUParticles2D, gradients, shaders) and all sound comes from the Studio autoload. Use real Godot systems where they fit: CharacterBody2D/RigidBody2D/Area2D physics and collisions, TileMapLayer or grid logic, AnimationPlayer/Tween, NavigationAgent2D or A*, Camera2D with smoothing and shake, CanvasLayer UI, shaders for juice. Plan a distinct visual identity and original names.\n")
  .replace(/- Plan 4 to 8 code modules[^\n]*\n/, "- Plan 4 to 8 GDScript modules. Each module is one file scripts/<name>.gd. Every module except \"main\" declares `class_name <PascalCaseName>`. The module named \"main\" is scripts/main.gd, extends Node2D, builds the scene tree in code and runs the game. Prefer small focused classes (player, enemy, world/level generator, ui, items, game state) that main wires together.\n")
  .replace("with Engine.start({ reset, update, draw })", "");

const GODOT_RULES = `Godot 4.7 GDScript rules:
- Typed GDScript with tabs for indentation. Scenes are built in code (add_child), do not write .tscn files.
- The game runs in a ${"${W}x${H}"} viewport. The autoload \`Studio\` provides: Studio.sfx("blip"|"pickup"|"hit"|"jump"|"shoot"|"explode"|"powerup"|"lose"|"win", volume). Input actions already exist: move_left, move_right, move_up, move_down (arrows/WASD), action (space/Z/J/enter), action2 (X/K/shift), pause (P/Esc), restart (R). Use Input.get_vector("move_left","move_right","move_up","move_down") and Input.is_action_just_pressed("action"). Mouse works too.
- Never use: OS.*, file or network APIs, HTTPRequest, JavaScriptBridge, load() of external paths. Only reference res://scripts/, res://scenes/ and res://data/ paths. No external assets: draw everything procedurally, use ThemeDB.fallback_font for text.
- Reference other modules by their class_name. Use only APIs that exist in Godot 4 (TileMapLayer not TileMap, CharacterBody2D.move_and_slide() with no arguments, signals via .connect(), await, @export, @onready). No Godot 3 syntax.
- Handle title / playing / paused / won / lost states, show on-screen instructions, restart on the restart action, and make the game substantial and polished. Complete working code only, no placeholders or TODOs.`;

const withSize = (rules, design) => rules.replace("${W}x${H}", `${design.canvas.width}x${design.canvas.height}`);
const className = (name) => name.replace(/(^|[-_ ])([a-z0-9])/gi, (_m, _s, c) => c.toUpperCase());

function stubFiles(design) {
  const p = design.palette;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return {
    indexHtml: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(design.title)}</title>
    <link rel="stylesheet" href="./game.css">
  </head>
  <body>
    <script src="./game.js"></script>
  </body>
</html>
`,
    gameJs: `// Godot Web export lives in ./web; this page only hosts it.\nconst frame = document.createElement("iframe");\nframe.src = "./web/index.html";\nframe.title = ${JSON.stringify(design.title)};\nframe.allow = "autoplay; fullscreen; gamepad";\ndocument.body.appendChild(frame);\nframe.addEventListener("load", () => frame.contentWindow && frame.contentWindow.focus());\nwindow.addEventListener("focus", () => frame.contentWindow && frame.contentWindow.focus());\n`,
    gameCss: `html, body { margin: 0; height: 100%; background: ${p.bg}; }\niframe { display: block; width: 100%; height: 100vh; border: 0; background: ${p.bg}; }\n`,
  };
}

const sourceDump = (files) => Object.entries(files).map(([name, code]) => `--- ${name} ---\n${code}`).join("\n\n");

function applyFilePatches(files, patches) {
  let applied = 0;
  for (const patch of Array.isArray(patches) ? patches : []) {
    const name = patch?.file;
    if (typeof name !== "string" || !(name in files) || typeof patch.find !== "string" || typeof patch.replace !== "string" || !patch.find) continue;
    const index = files[name].indexOf(patch.find);
    if (index === -1 || files[name].indexOf(patch.find, index + 1) !== -1) continue;
    files[name] = files[name].slice(0, index) + patch.replace + files[name].slice(index + patch.find.length);
    applied++;
  }
  return applied;
}

async function repairFiles(brief, design, files, problem) {
  const reply = await chat([
    { role: "system", content: `You fix bugs in a Godot 4.7 GDScript game with minimal exact-text patches. ${withSize(GODOT_RULES, design)}\nReturn only JSON: { patches: [{ file, find, replace }] }, where file is one of the existing file paths and find is an exact, unique substring of that file's current content. Fix every listed error, including the same mistake in other places.` },
    { role: "user", content: `Brief:\n${brief}\n\nGodot reported:\n${problem}\n\nCurrent files:\n${sourceDump(files)}` },
  ], { json: true, temperature: 0.2 });
  return applyFilePatches(files, parseJson(reply).patches);
}

async function generateGodotGame(brief, handoff, { emit = () => {}, godot, workRoot } = {}) {
  const knowledge = relevantKnowledge(`${brief} ${handoff}`);
  if (knowledge) emit({ type: "log", level: "info", message: "Applying lessons the studio learned from its study sources." });
  const design = validateDesign(parseJson(await chat([
    { role: "system", content: GODOT_DESIGN_SYSTEM },
    { role: "user", content: `Game idea from the user (the authority on what to build):\n${brief}\n\nTeam handoff notes (advisory):\n${handoff}${knowledge}\n\nProduce the design JSON.` },
  ], { json: true, temperature: 0.8, maxTokens: 6000 })));
  emit({ type: "phase-started", phase: "build", message: `Designed "${design.title}" (${design.genre}) as a Godot project with ${design.modules.length} scripts.` });

  const files = {};
  const rules = withSize(GODOT_RULES, design);
  for (const module of design.modules) {
    const isMain = module.name.toLowerCase() === "main";
    const file = `scripts/${isMain ? "main" : module.name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}.gd`;
    emit({ type: "phase-started", phase: "build", message: `Writing ${file}` });
    const startedAt = Date.now();
    const code = stripFences(await chat([
      { role: "system", content: `You are a senior Godot engineer writing one script of a larger 2D game.\n${rules}\nReturn ONLY the GDScript for this file, no markdown fences, no commentary.` },
      { role: "user", content: `Original brief:\n${brief}\n\nGame design:\n${JSON.stringify({ ...design, tasks: undefined })}\n\nWrite ${file} now: ${module.responsibility}. ${isMain ? "It extends Node2D, has no class_name, and creates and runs the game." : `It must declare class_name ${className(module.name)}.`} Declared exports: ${JSON.stringify(module.exports || [])}.\nAll files in order: ${design.modules.map((m) => `${m.name} (${m.responsibility}; exports ${JSON.stringify(m.exports || [])})`).join(" | ")}.\n\nFiles already written:\n${sourceDump(files) || "(none yet)"}\n\nWrite a complete, substantial, polished implementation.${knowledge}` },
    ], { maxTokens: 16000, temperature: 0.5 }));
    files[file] = code;
    emit({ type: "log", level: "ok", message: `Wrote ${file}: ${code.split("\n").length} lines in ${Math.round((Date.now() - startedAt) / 1000)}s.` });
  }

  const root = workRoot || await fsp.mkdtemp(path.join(os.tmpdir(), "studio-godot-"));
  const projectDir = path.join(root, "project");
  const meta = { title: design.title, width: design.canvas.width, height: design.canvas.height };
  let problem = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const rejected = await writeProject(projectDir, meta, files);
    emit({ type: "log", level: "info", message: attempt === 0 ? "Running the project in headless Godot to look for errors…" : `Re-checking in Godot after repair ${attempt}…` });
    const errors = rejected.length ? rejected : await checkProject(godot, projectDir);
    if (!errors.length) { problem = null; break; }
    problem = errors.slice(0, 12).join("\n");
    if (attempt === MAX_REPAIRS) break;
    emit({ type: "phase-started", phase: "build", message: `Godot found ${errors.length} problem(s); repairing (attempt ${attempt + 1}): ${errors[0].slice(0, 120)}` });
    if (!(await repairFiles(brief, design, files, problem))) emit({ type: "phase-started", phase: "build", message: "Repair produced no applicable patches; retrying." });
  }
  if (problem) throw new Error(`Godot still reports errors after repairs: ${problem.slice(0, 300)}`);

  emit({ type: "phase-started", phase: "build", message: "Checking the build against your original idea…" });
  const review = parseJson(await chat([
    { role: "system", content: "You are a strict QA lead. Decide whether the Godot game code faithfully implements the user's idea rather than a generic substitute. Return only JSON: { faithful: boolean, missing: [strings] } naming concrete missing mechanics, systems or content." },
    { role: "user", content: `Brief:\n${brief}\n\nMust-not-be list: ${JSON.stringify(design.mustNotBe || [])}\n\nCode:\n${sourceDump(files)}` },
  ], { json: true, temperature: 0 }));
  if (review.faithful === false && Array.isArray(review.missing) && review.missing.length) {
    emit({ type: "phase-started", phase: "build", message: `Adding missing features: ${review.missing.slice(0, 3).join("; ").slice(0, 160)}` });
    const snapshot = { ...files };
    try {
      await repairFiles(brief, design, files, `Implement these missing features faithfully without breaking existing play:\n- ${review.missing.join("\n- ")}`);
      const rejected = await writeProject(projectDir, meta, files);
      if (rejected.length || (await checkProject(godot, projectDir)).length) throw new Error("regression");
    } catch {
      Object.keys(files).forEach((name) => delete files[name]);
      Object.assign(files, snapshot);
      await writeProject(projectDir, meta, files);
    }
  }

  emit({ type: "phase-started", phase: "build", message: "Exporting the Godot build to the web…" });
  const webDir = path.join(root, "web");
  await exportWeb(godot, projectDir, webDir);
  return { design, root, projectDir, webDir, tasks: design.tasks };
}

async function createGodotGame(brief, handoff, { projectsDir, emit, godot = findGodot() } = {}) {
  if (!godot) throw new Error("Godot was not found. Set GODOT_PATH to the Godot executable.");
  const generated = await generateGodotGame(brief, handoff, { emit, godot });
  try {
    const stub = stubFiles(generated.design);
    const { files, tasks } = validateProject({ ...stub, tasks: generated.tasks });
    const project = await saveProject(files, tasks, projectsDir || path.join(__dirname, "projects"), "godot");
    const target = path.join(projectsDir || path.join(__dirname, "projects"), project.id);
    await fsp.cp(generated.webDir, path.join(target, "web"), { recursive: true });
    await fsp.cp(generated.projectDir, path.join(target, "godot"), { recursive: true, filter: (source) => !source.includes(`${path.sep}.godot`) });
    return project;
  } finally {
    await fsp.rm(generated.root, { recursive: true, force: true });
  }
}

module.exports = { applyFilePatches, createGodotGame, generateGodotGame, repairFiles, stubFiles };
