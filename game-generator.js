/**
 * Traumatic Studios - Game Generator (browser engine: 2D, 2.5D and 3D).
 *
 * Pipeline: pick reference blueprints (inspiration only) -> design call -> one module per call
 * (syntax check + headless smoke test + retries) -> assemble with the fixed runtime -> validate -> save.
 * If the model cannot produce a working game, a guaranteed-playable fallback for the chosen dimension ships instead.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getModel } = require("./settings");
const llm = require("./llm");
const { validateProject, saveProject } = require("./project-builder");
const { pickReferences, formatReferences } = require("./design-references");
const { findNamedGames, extractTitles, formatNamedGames } = require("./named-games");
const { smokeRun, smokeRunSync } = require("./studio-runtime/smoke");

const RUNTIME_DIR = path.join(__dirname, "studio-runtime");
const readRuntime = (name) => fs.readFileSync(path.join(RUNTIME_DIR, name), "utf8");
const FORBIDDEN = /(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|WebSocket|\bimport\b|\beval\s*\()/i;
const OWNERS = ["Game designer", "Gameplay engineer", "QA tester", "Producer"];
const FALLBACKS = { "2d": "fallback-2d.js", "2.5d": "fallback-25d.js", "3d": "fallback-3d.js" };
const MAX_MODULES = 6;

/* ---------- small helpers ---------- */
function stripFences(text) {
  if (typeof text !== "string") return text;
  const fenced = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const attempts = [text.trim(), stripFences(text), (text.match(/\{[\s\S]*\}/) || [""])[0]];
  for (const attempt of attempts) {
    try { const value = JSON.parse(attempt); if (value && typeof value === "object") return value; } catch { /* try the next form */ }
  }
  return null;
}

/** Throws when the text is not a JSON object (task-patcher.js and blueprint-router.js expect that). */
function parseJson(text) {
  const value = tryParseJson(text);
  if (value === null) throw new Error("The model did not return valid JSON.");
  return value;
}

function safeText(value, max = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f<>`$\\]/g, " ")
    .replace(/https?:\/\/\S*/gi, "")
    .replace(/\bimport\b/gi, "bring in")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (text, limit) => (String(text).length > limit ? `${String(text).slice(0, limit)}\n/* ...truncated... */` : String(text));
const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback);
const int = (value, min, max, fallback) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };

function detectDimension(text) {
  const t = String(text || "").toLowerCase();
  if (/\b3d\b|three[- ]dimensional|first[- ]person|third[- ]person|\bfps\b/.test(t)) return "3d";
  if (/isometric|2\.5d|2\.5 d|pseudo[- ]3d/.test(t)) return "2.5d";
  return null;
}

function apiText(dimension) {
  const sections = {};
  let current = null;
  for (const line of readRuntime("api.txt").split(/\r?\n/)) {
    const header = line.match(/^## (.+)$/);
    if (header) { current = header[1].trim().toLowerCase(); sections[current] = []; } else if (current) sections[current].push(line);
  }
  return `${(sections.common || []).join("\n")}\n\n${(sections[dimension] || sections["2d"] || []).join("\n")}`.trim();
}

/* ---------- the real Kit surface, so invented names are caught early ---------- */
let catalogCache = null;
function kitCatalog() {
  if (!catalogCache) {
    const context = vm.createContext({ console });
    vm.runInContext(readRuntime("runtime.js"), context);
    const kit = context.Kit;
    const sub = {};
    for (const ns of ["iso", "mesh", "v3"]) sub[ns] = new Set(Object.keys(kit[ns] || {}));
    const top = new Set(Object.keys(kit));
    const list = [...top].filter((n) => !sub[n]).map((n) => `Kit.${n}`).concat(Object.entries(sub).map(([ns, names]) => `Kit.${ns}.{${[...names].join(", ")}}`)).join(", ");
    catalogCache = { top, sub, list };
  }
  return catalogCache;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** Rewrites an invented Kit.name to the closest real one when exactly one real name is within two edits. */
function fixKitNames(code) {
  const { top } = kitCatalog();
  return String(code).replace(/\bKit\.([A-Za-z_]\w*)/g, (match, name) => {
    if (top.has(name)) return match;
    const near = [...top].map((real) => ({ real, d: distance(name.toLowerCase(), real.toLowerCase()) })).filter((c) => c.d <= 2).sort((a, b) => a.d - b.d);
    return near.length && (near.length === 1 || near[0].d < near[1].d) ? `Kit.${near[0].real}` : match;
  });
}

/* ---------- gameplay menu: what the Director can build ---------- */
const GOAL_WORDS = { collect: ["collect", "gather", "find", "pickup", "item"], keys: ["key", "unlock"], exit: ["exit", "reach", "escape", "portal", "door", "destination"], defeat: ["defeat", "kill", "destroy", "shoot", "slay", "hunt"], survive: ["survive", "endure", "hold", "last"], build: ["build", "construct", "place", "craft", "erect"] };
const THREAT_WORDS = { chasers: ["chaser", "chase", "follow", "stalk", "enemy", "enemies"], patrol: ["patrol", "guard", "wander"], hazards: ["hazard", "trap", "spike", "lava", "obstacle"], timer: ["timer", "time", "clock", "countdown"], none: ["none", "nothing"] };
const DEFAULT_GAMEPLAY = { goal: { type: "collect", label: "relics", count: 6 }, threat: { type: "chasers", label: "stalker", count: 1, speed: "normal", sight: "normal" }, player: { health: 3 } };
function pickType(value, words, fallback) {
  const v = String(value || "").toLowerCase();
  if (!v) return fallback;
  for (const [type, list] of Object.entries(words)) if (v === type || list.some((w) => v.includes(w))) return type;
  return fallback;
}
const pickOne = (value, options, fallback) => (options.includes(String(value || "").toLowerCase()) ? String(value).toLowerCase() : fallback);

/** Turns whatever the designer wrote into a spec the Director can run. { mode: "custom" } opts out of the Director. */
function normalizeGameplay(raw, fallback) {
  const g = raw && typeof raw === "object" ? raw : {};
  if (g.mode === "custom") return { mode: "custom" };
  const base = fallback && fallback.goal && fallback.threat ? fallback : DEFAULT_GAMEPLAY;
  const goalRaw = g.goal && typeof g.goal === "object" ? g.goal : {};
  const threatRaw = g.threat && typeof g.threat === "object" ? g.threat : {};
  const playerRaw = g.player && typeof g.player === "object" ? g.player : {};
  const label = (v, d) => safeText(v, 24).toLowerCase().replace(/[^a-z0-9 '\-]/g, "").trim() || d;
  const goal = { type: pickType(goalRaw.type, GOAL_WORDS, base.goal.type), label: label(goalRaw.label, base.goal.label || "relics"), count: int(goalRaw.count, 1, 12, base.goal.count || 6), seconds: int(goalRaw.seconds, 30, 300, base.goal.seconds || 90) };
  const threat = { type: pickType(threatRaw.type, THREAT_WORDS, base.threat.type), label: label(threatRaw.label, base.threat.label || "stalker"), count: int(threatRaw.count, 0, 4, base.threat.count === undefined ? 1 : base.threat.count),
    speed: pickOne(threatRaw.speed, ["slow", "normal", "fast"], base.threat.speed || "normal"), sight: pickOne(threatRaw.sight, ["short", "normal", "long"], base.threat.sight || "normal"), hp: int(threatRaw.hp, 1, 4, base.threat.hp || 2) };
  if ((threat.type === "chasers" || threat.type === "patrol") && threat.count < 1) threat.count = 1;
  if (threat.type === "timer") threat.seconds = int(threatRaw.seconds, 30, 600, base.threat.seconds || 120);
  if (goal.type === "survive" && threat.type === "none") { threat.type = "chasers"; threat.count = Math.max(1, threat.count); }
  const shoots = playerRaw.shoots !== undefined ? playerRaw.shoots === true || String(playerRaw.shoots).toLowerCase() === "true" : !!(base.player && base.player.shoots);
  const flag = (v, d) => (v !== undefined ? v === true || String(v).toLowerCase() === "true" : !!d);
  const builds = flag(playerRaw.builds, base.player && base.player.builds) || goal.type === "build";
  const jumps = flag(playerRaw.jumps, base.player && base.player.jumps) || builds;
  const view = String(g.view || base.view || "").toLowerCase() === "side" ? "side" : "free";
  return { mode: "director", view, goal, threat, player: { health: int(playerRaw.health, 1, 5, (base.player && base.player.health) || 3), shoots: shoots || goal.type === "defeat", jumps, builds } };
}

// The Director owns these jobs, so model modules with these names are not built in Director mode.
const DIRECTOR_OWNS = new Set(["player", "controller", "control", "controls", "enemy", "enemies", "ai", "pickup", "pickups", "collectible", "collectibles", "lantern", "lanterns", "rules", "rule", "hud", "score", "scoring", "goal", "goals", "win", "lose", "objective", "objectives", "health", "combat", "weapon", "weapons", "threat", "threats", "hazard", "hazards", "spawner"]);
const directorOwns = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some((t) => DIRECTOR_OWNS.has(t));
const WORLD_EXAMPLES = { "2d": "world-example-2d.js", "2.5d": "world-example-25d.js", "3d": "world-example-3d.js", side: "world-example-side.js" };
const worldExampleFor = (design) => WORLD_EXAMPLES[design.gameplay && design.gameplay.view === "side" ? "side" : design.dimension];

/* ---------- design ---------- */
const DEFAULT_PALETTES = {
  "2d": { bg: "#0b0f14", panel: "#18202a", accent: "#ffb454", text: "#f2f2f2", danger: "#ff5d5d" },
  "2.5d": { bg: "#0d1420", panel: "#1d2a3a", accent: "#7fd1ae", text: "#eef3f7", danger: "#ff6b6b" },
  "3d": { bg: "#0a0f1a", panel: "#1a2436", accent: "#ffcf5c", text: "#f4f6fa", danger: "#ff5d5d" },
};
const DEFAULT_MODULES = [
  { name: "World", responsibility: "level layout, map data and drawing the world" },
  { name: "Player", responsibility: "player movement, controls and drawing the player" },
  { name: "Threats", responsibility: "enemies or obstacles that create challenge" },
  { name: "Rules", responsibility: "goals, scoring, win and lose conditions and HUD lines" },
];
const DEFAULT_TASKS = [
  { title: "Add a title screen polish pass", owner: "Game designer", description: "Tune the title copy, controls list and first-minute pacing." },
  { title: "Add more content variety", owner: "Gameplay engineer", description: "Add one new enemy, obstacle or item type with its own behavior." },
  { title: "Play-test every input path", owner: "QA tester", description: "Test keyboard, mouse and restart paths and note anything confusing." },
];

function normalizeDesign(raw, brief = "", options = {}) {
  const d = raw && typeof raw === "object" ? raw : {};
  const dim = String(d.dimension || "").toLowerCase();
  const dimension = /2\.?5|iso/.test(dim) ? "2.5d" : /3/.test(dim) ? "3d" : "2d";
  const wide = dimension === "3d";
  const title = safeText(d.title, 48) || safeText(String(brief).split(/\s+/).slice(0, 5).join(" "), 40) || "Untitled Game";
  const names = new Set();
  const modules = (Array.isArray(d.modules) ? d.modules : []).map((m) => ({ name: safeText(m && m.name, 20).replace(/[^A-Za-z0-9]/g, ""), responsibility: safeText(m && m.responsibility, 160) }))
    .filter((m) => /^[A-Za-z][A-Za-z0-9]{1,19}$/.test(m.name) && m.responsibility && !names.has(m.name.toLowerCase()) && names.add(m.name.toLowerCase())).slice(0, MAX_MODULES);
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((t, i) => ({
    title: safeText(t && t.title, 100), owner: OWNERS.includes(t && t.owner) ? t.owner : OWNERS[i % 3], description: safeText(t && t.description, 300),
  })).filter((t) => t.title.length >= 3 && t.description.length >= 10).slice(0, 5);
  for (const fill of DEFAULT_TASKS) if (tasks.length < 3) tasks.push(fill);
  const palette = {};
  for (const [key, value] of Object.entries(DEFAULT_PALETTES[dimension])) palette[key] = hex(d.palette && d.palette[key], value);
  const gameplay = normalizeGameplay(d.gameplay, options.gameplay);
  if (gameplay.mode !== "custom") {
    if (gameplay.view === "side" && dimension !== "2d") gameplay.view = "free";            // the side-scroller is a 2D mode
    if (dimension !== "3d" && gameplay.player.builds) { gameplay.player.builds = false; if (gameplay.goal.type === "build") gameplay.goal.type = "collect"; }
  }
  return {
    title, dimension, genre: safeText(d.genre, 40) || "game", pitch: safeText(d.pitch, 240),
    width: int(d.canvas && d.canvas.width, 480, 1280, wide ? 960 : 800), height: int(d.canvas && d.canvas.height, 320, 800, wide ? 540 : 600),
    palette, controls: (Array.isArray(d.controls) ? d.controls : []).map((c) => safeText(c, 60)).filter(Boolean).slice(0, 6),
    gameplay,
    modules: modules.length >= (gameplay.mode === "custom" ? 2 : 1) ? modules : DEFAULT_MODULES.map((m) => ({ ...m })), tasks,
  };
}

async function chat(messages, { json = false, temperature = 0.5, maxTokens, timeoutMs = 240_000 } = {}) {
  const body = { model: getModel(), messages, temperature };
  if (json) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_tokens = maxTokens;
  const response = await llm.llmFetch({ body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Model request failed (${response.status}): ${String(details).slice(0, 300)}`);
  }
  const result = await response.json();
  const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned an empty response.");
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

const callModel = (system, user, options) => chat([{ role: "system", content: system }, { role: "user", content: user }], options);

/** Plays any generated game.js headlessly. Returns null when it survives, otherwise a short description of the crash. Synchronous. */
function smokeTest(gameJs, canvasSize = {}, framesOrOptions = 300) {
  const frames = typeof framesOrOptions === "number" ? framesOrOptions : Number(framesOrOptions && framesOrOptions.frames) || 300;
  const result = smokeRunSync(String(gameJs), {
    frames, width: Number(canvasSize && canvasSize.width) || 800, height: Number(canvasSize && canvasSize.height) || 600, minCalls: 0, minPlayRatio: 0,
  });
  return result.ok ? null : String(result.errors[0] || "The game failed its smoke test.");
}

async function designGame(brief, handoff, references, knowledge, forced, extra = {}) {
  const dimensionRule = forced
    ? `The brief asks for ${forced.toUpperCase()}; use "dimension": "${forced}".`
    : `Choose the dimension that best serves the idea: "2d", "2.5d" (isometric or pseudo-3D look) or "3d" (real perspective 3D). Use 2.5D or 3D when the idea benefits from space, exploration, racing or flight; do not default to 2D out of habit.${extra.dimensionHint ? ` The game the user referenced is ${extra.dimensionHint}; follow that unless the brief says otherwise.` : ""}`;
  const system = "You are the lead game designer at Traumatic Studios. Reply with one JSON object only, no markdown.";
  const user = [
    `Project brief:\n${brief}`,
    `Approved team handoff:\n${clip(handoff, 5000)}`,
    knowledge ? `Studio lessons:\n${clip(knowledge, 2500)}` : "",
    extra.referenceNote ? `The user referred to specific games. Reproduce their core loop and feel as far as the gameplay menu below allows (not their art or story):\n${extra.referenceNote}` : "",
    `Reference blueprints (inspiration only; combine, bend or ignore them, and never copy one wholesale):\n${formatReferences(references)}`,
    `Design a game that is faithful to the brief and not a generic catch-or-dodge arcade game. ${dimensionRule}`,
    "The runtime has a tested Director that builds the whole game loop from your \"gameplay\" spec: objectives placed in the world, enemies, health, shooting, a compass, the HUD, and the win and lose conditions. You design the goal, the threat and the world; do not design the player controller, pickups, enemies, rules or HUD as modules. Stay on the brief: do not add unrelated mechanics (such as puzzles) that it does not ask for.",
    'Return JSON with: "title" (string), "genre" (string), "dimension" ("2d"|"2.5d"|"3d"), "pitch" (one or two sentences that state what the player must do), "canvas" {"width","height"}, "palette" {"bg","panel","accent","text","danger"} as #rrggbb, "controls" (up to 6 short strings), "gameplay" {"view": "side" for a 2D side-scrolling platformer (gravity, jumping, pits, enemies you stomp; 2D only) or omit it, "goal": {"type": one of collect|keys|exit|defeat|survive|build (build = place blocks, 3D only), "label": what the player gathers or hunts in one or two words such as "lanterns", "count": 3 to 12, "seconds": 45 to 180 for survive}, "threat": {"type": one of chasers|patrol|hazards|timer|none, "label": the enemy name such as "stalker", "count": 1 to 4, "speed": slow|normal|fast, "sight": short|normal|long, "hp": 1 to 3}, "player": {"health": 1 to 5, "shoots": true or false, "jumps": true or false (3D jumping and platforms), "builds": true or false (3D: place and break blocks that are solid for you and the enemies)}} (set "mode": "custom" instead only if the idea truly needs mechanics this menu cannot express), "modules" (1 to 3 objects {"name": CamelCase letters only, "responsibility"} that build the WORLD only: environment, props, atmosphere or an extra feature; never the player, enemies, pickups, goals, rules or HUD), "tasks" (3 to 5 objects {"title","owner","description"} where owner is exactly one of Game designer, Gameplay engineer, QA tester, Producer).',
  ].filter(Boolean).join("\n\n");
  return normalizeDesign(tryParseJson(await callModel(system, user, { json: true, temperature: 0.8 })), brief, { gameplay: extra.gameplayHint });
}

/** Asks the model what a game it was named after is like; only titles the library does not know. */
async function describeUnknownGames(titles, log = () => {}) {
  const out = [];
  for (const title of titles) {
    try {
      const reply = tryParseJson(await chat([
        { role: "system", content: "You are a game historian helping a game designer. Reply with one JSON object only." },
        { role: "user", content: `The user wants a game like "${title}". If you do not know this game, return {"known": false}. Otherwise return {"known": true, "dimension": "2d"|"2.5d"|"3d", "loop": one sentence on its core loop, "signature": [three short things that make it itself], "gameplay": {"goal": {"type": "collect|keys|exit|defeat|survive", "label": "...", "count": 6}, "threat": {"type": "chasers|patrol|hazards|timer|none", "label": "...", "count": 2}, "player": {"shoots": true or false, "health": 3}}}.` },
      ], { json: true, temperature: 0.2, timeoutMs: 90_000 }));
      if (reply && reply.known === true && typeof reply.loop === "string") {
        out.push({ title: safeText(title, 40), dimension: /3/.test(String(reply.dimension)) ? "3d" : /2\.?5/.test(String(reply.dimension)) ? "2.5d" : "2d", loop: safeText(reply.loop, 240), signature: (Array.isArray(reply.signature) ? reply.signature : []).map((x) => safeText(x, 60)).filter(Boolean).slice(0, 4), gameplay: reply.gameplay && typeof reply.gameplay === "object" ? reply.gameplay : undefined });
        log(`Looked up "${title}" to use as a reference.`);
      } else log(`Did not recognise "${title}", so the brief is used as written.`);
    } catch { /* the lookup is optional */ }
  }
  return out;
}

/* ---------- modules ---------- */
function sanitizeModule(text) {
  let code = stripFences(String(text || "")).trim();
  code = code.replace(/^\s*import\s.*$/gm, "").replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");
  const lines = code.split("\n");
  const start = lines.findIndex((line) => /^\s*(?:Game\.|var |let |const |function |\/\/|\/\*|\(|\{|if |for )/.test(line));
  return (start > 0 ? lines.slice(start) : lines).join("\n").trim();
}

function checkModule(code) {
  if (!code || code.trim().length < 40) return "The module is empty or far too short.";
  if (Buffer.byteLength(code) > 30_000) return "The module is too long; keep it under 90 lines.";
  const bad = code.match(FORBIDDEN);
  if (bad) return `The module uses a forbidden feature (${bad[0].trim()}). No imports, network calls, URLs or eval.`;
  if (/\b(?:const|let|var|class|function)\s+(?:Game|Kit)\b/.test(code) || /(?:^|[;\n{(,])\s*(?:Game|Kit)\s*=[^=]/.test(code)) return "Do not redefine Game or Kit; they already exist as globals.";
  if (!/Game\.module\s*\(/.test(code)) return 'The module must register itself with Game.module("Name", { init, update, draw }).';
  const catalog = kitCatalog();
  for (const [, first, second] of code.matchAll(/\bKit\.([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g)) {
    if (!catalog.top.has(first)) return `Kit.${first} does not exist. Use only these Kit functions: ${catalog.list}.`;
    if (second && catalog.sub[first] && !catalog.sub[first].has(second)) return `Kit.${first}.${second} does not exist. Use only these Kit functions: ${catalog.list}.`;
  }
  try { new vm.Script(`(function () {\n${code}\n})();`, { filename: "module.js" }); } catch (error) { return `Syntax error: ${error.message}`; }
  return "";
}

function assemble(config, modules) {
  return [
    readRuntime("runtime.js"),
    readRuntime("director.js"),
    readRuntime("side.js"),
    `Game.configure(${JSON.stringify(config)});`,
    'Game.director("pre");',
    ...modules.map((m) => `/* module ${m.name} */\n(function () {\n${m.code}\n})();`),
    "Game.director();",
    "Game.boot();",
  ].join("\n");
}

const configOf = (design) => ({ title: design.title, width: design.width, height: design.height, palette: design.palette, controls: design.controls, genre: design.genre, pitch: design.pitch, dimension: design.dimension, gameplay: design.gameplay });

async function buildModule(spec, { design, done, example, knowledge, current = "", note = "", kind = "playtest" }) {
  const system = "You write one JavaScript module for the Traumatic Studios browser game runtime. Reply with JavaScript code only: no markdown fences, no explanations, no text before or after the code.";
  const overview = design.modules.map((m) => `- ${m.name}: ${m.responsibility}`).join("\n");
  const written = done.map((m) => `// module ${m.name}\n${clip(m.code, 2200)}`).join("\n\n");
  const user = [
    `Game: "${design.title}" (${design.genre}, ${design.dimension}). ${design.pitch}`,
    `Canvas ${design.width}x${design.height}. Controls: ${design.controls.join("; ") || "WASD or arrows, Space to act"}. Palette: ${JSON.stringify(design.palette)}.`,
    `All modules of this game, in the order they run and draw:\n${overview}`,
    design.gameplay && design.gameplay.mode !== "custom" ? `The runtime Director already provides, from this spec, the player controller, the objectives, the enemies, health, shooting, a compass, the HUD, and the win and lose conditions: ${JSON.stringify(design.gameplay)}. Do NOT write any of those. Your module builds the WORLD of this game and adds atmosphere, props or an extra feature that fits it. ${{ "side": "The level scrolls sideways and is about g.w * 3.2 pixels wide, with the ground line near y = g.h - 70. The Director draws the sky, hills, ground, platforms, enemies and everything playable. You add background decoration (clouds, trees, signs, torches) in draw using world coordinates between x = 0 and x = g.w * 3.2; keep it behind the action and do not draw platforms or enemies.", "3d": "Push meshes into g.scene.meshes (floor, walls, props; set mesh.solid = true on walls and pillars; if the player can jump, add low platforms 0.8 to 1.6 high and at least 2 wide that can be climbed), set g.world = { bounds: {...} } to the walkable area, optionally set g.scene.sky = [top, bottom] and g.scene.fog, and set g.scene.cam.pos to a good start. Leave open space: the Director scatters objectives and enemies in free space.", "2.5d": "Draw the environment in draw with Kit.iso (grid cells 0 to 8) and set g.world = { bounds: { minX: 0.6, maxX: 7.4, minZ: 0.6, maxZ: 7.4 } }. Keep it decorative; the Director places objectives and enemies.", "2d": "Draw the environment in draw (floor, walls, decoration) and keep it decorative with the middle clear; the Director places objectives and enemies." }[design.gameplay.view === "side" ? "side" : design.dimension] || ""}` : "",
    `Runtime API:\n${apiText(design.dimension)}\nThe complete list of Kit functions that exist: ${kitCatalog().list}.`,
    `Example of a complete working module (a different game; copy its structure, not its content):\n${example}`,
    written ? `Modules already written (read their g.data fields before using them):\n${written}` : "",
    knowledge ? `Studio lessons:\n${clip(knowledge, 1500)}` : "",
    `Write the module named "${spec.name}": ${spec.responsibility}. Other modules may not exist yet when yours is tested, so guard reads of other modules' g.data with || {}. Register it with Game.module("${spec.name}", { init, update, draw }).`,
    current && kind === "revision" ? `Current version of this module:\n${clip(current, 4000)}\n\nThe player asked for this change: ${note}\nRewrite the complete module with that change, keeping everything else working.` : "",
    current && kind !== "revision" ? `Your current version of this module has a problem found by an automated playtest:\n${clip(current, 4000)}\n\nPlaytest finding: ${note}\nRewrite the complete module so it passes.` : "",
  ].filter(Boolean).join("\n\n");
  let code = "", lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYour previous attempt:\n${clip(code, 6000)}\n\nIt failed this check: ${lastError}\nReturn the complete corrected module.`;
    let raw;
    try { raw = await callModel(system, prompt, { temperature: attempt ? 0.2 : 0.5 }); } catch (error) {
      lastError = error.message;
      if (/\(4\d\d\)/.test(error.message)) break;
      continue;
    }
    code = fixKitNames(sanitizeModule(raw));
    lastError = checkModule(code);
    if (!lastError) {
      const smoke = await smokeRun(assemble(configOf(design), [...done, { name: spec.name, code }]), { frames: 180, width: design.width, height: design.height, minCalls: 0, minPlayRatio: 0 });
      if (smoke.ok) return { code };
      lastError = `Running the game with this module failed: ${smoke.errors[0]}`;
    }
  }
  return { error: lastError };
}

/* ---------- the playtest bot ---------- */
const UNJUDGED = ["error", "exit", "timeout", "crashed"];
async function playtest(design, modules) {
  const code = assemble(configOf(design), modules);
  const run = (o) => smokeRun(code, { width: design.width, height: design.height, minCalls: 0, minPlayRatio: 0, ...o });
  let [active, idle] = await Promise.all([run({ frames: 360 }), run({ frames: 240, idle: true })]);
  // A busy machine can time a bot run out; try again on its own rather than quietly judging nothing.
  if (["error", "exit", "timeout"].includes(active.mode)) active = await run({ frames: 360, timeoutMs: 40_000 });
  if (["error", "exit", "timeout"].includes(idle.mode)) idle = await run({ frames: 240, idle: true, timeoutMs: 40_000 });
  return { active, idle };
}

/** Turns bot telemetry into findings, each blaming the module that caused it. */
function assessPlaytest(design, { active, idle }, modules) {
  if (!active || !idle || UNJUDGED.includes(active.mode) || UNJUDGED.includes(idle.mode)) return [];
  const guess = () => (modules.find((m) => /player|control|hero|avatar|character|camera/i.test(m.name)) || modules[0] || {}).name;
  const problems = [];
  const idleEnd = idle.endInfo, activeEnd = active.endInfo;
  if (idleEnd && idleEnd.time < 2) problems.push({ kind: "instant_end", blame: idleEnd.by, note: `With no input at all the game ended after ${Number(idleEnd.time).toFixed(1)} seconds: module "${idleEnd.by}" called g.end(${idleEnd.win}). A game must not end before the player has had time to act. Base endings on real conditions and give the player at least 20 seconds before any ending can trigger.` });
  else if (activeEnd && activeEnd.time < 2) problems.push({ kind: "instant_end", blame: activeEnd.by, note: `The game ended after ${Number(activeEnd.time).toFixed(1)} seconds of play: module "${activeEnd.by}" called g.end(${activeEnd.win}). The player must get at least 20 seconds before any ending can trigger.` });
  // Movement can only be judged when the bot actually got to play for a while (an instant ending explains everything else).
  if (!problems.length && active.playFrames >= 60) {
    const unit = design.dimension === "2d" ? "pixels" : "units";
    if (!active.hasPlayer) problems.push({ kind: "no_player", blame: guess(), note: "g.player was never set during play, so enemies and the rules cannot find the player. Publish the player's position every update (g.player = { x, y } in 2D or 2.5D, { x, y, z } in 3D), or use Kit.mover.update or Kit.fp.update, which do it for you." });
    else if (active.moved < (design.dimension === "2d" ? 10 : 0.5)) problems.push({ kind: "no_movement", blame: active.playerBy || guess(), note: `The bot held the movement keys for 8 seconds but the player moved only ${Number(active.moved).toFixed(2)} ${unit}. Movement must follow g.axis() (or use Kit.mover.update or Kit.fp.update) and must update g.player.` });
  }
  return problems;
}

/* ---------- continuing to work on a saved game ---------- */
/** Splits a saved game.js back into the model-written modules that assemble() put in it. */
function parseModules(gameJs) {
  const out = [];
  const pattern = /\/\* module ([A-Za-z0-9_]+) \*\/\n\(function \(\) \{\n([\s\S]*?)\n\}\)\(\);(?=\n\/\* module |\nGame\.director\(\);)/g;
  for (const m of String(gameJs).matchAll(pattern)) out.push({ name: m[1], code: m[2] });
  return out;
}

/**
 * Applies one instruction ("make the stalker faster", "make it snowy") to a saved game and saves the result as a NEW
 * version, so the previous one is still there. Resolves { changed:false, reply } when the instruction was a question.
 */
async function reviseGame(projectId, instruction, options = {}) {
  const { projectsDir = path.join(__dirname, "projects"), emit = () => {}, history = [] } = options || {};
  const log = (message, level = "info") => emit({ type: "log", level, message });
  const phase = (message) => emit({ type: "phase-started", phase: "build", message });
  if (!/^game-\d+-[a-f0-9]{8}$/.test(String(projectId))) throw new Error("Invalid project identifier.");
  const text = safeText(instruction, 600);
  if (text.length < 3) throw new Error("Tell me what you want to change.");
  const fsp = require("node:fs/promises");
  const root = path.join(projectsDir, projectId);
  let record, gameJs;
  try { record = JSON.parse(await fsp.readFile(path.join(root, "studio-design.json"), "utf8")); gameJs = await fsp.readFile(path.join(root, "game.js"), "utf8"); }
  catch { throw new Error("This game was made before revisions were supported, so it cannot be continued. Start a new project instead."); }
  const design = JSON.parse(JSON.stringify(record.design));
  const directorOn = design.gameplay && design.gameplay.mode !== "custom";
  const done = (record.fallback ? [] : parseModules(gameJs)).map((m) => ({ ...m, index: Math.max(0, design.modules.findIndex((x) => x.name === m.name)) }));
  for (const m of done) if (m.index === 0 && !design.modules.some((x) => x.name === m.name)) m.index = design.modules.length;
  const specs = new Map(design.modules.map((m) => [m.name.toLowerCase(), m]));
  const example = readRuntime(directorOn ? worldExampleFor(design) : FALLBACKS[design.dimension]);

  phase("Planning the change…");
  const plan = tryParseJson(await chat([
    { role: "system", content: "You are the lead game designer at Traumatic Studios revising an existing game for the player. Reply with one JSON object only, no markdown." },
    { role: "user", content: [
      `Game: "${design.title}" (${design.genre}, ${design.dimension}). ${design.pitch}`,
      `Current gameplay spec (the Director runs it): ${JSON.stringify(design.gameplay)}`,
      `Current modules: ${design.modules.map((m) => `${m.name} (${m.responsibility})`).join("; ") || "none"}.`,
      history.length ? `Earlier requests in this conversation:\n${history.slice(-6).map((h) => `- ${safeText(h, 200)}`).join("\n")}` : "",
      `The player says: "${text}"`,
      'Return JSON with: "action" ("change" or "answer": use "answer" only when the player asked a question or nothing needs to change), "reply" (one to three plain sentences telling the player what you changed or the answer), and for a change any of: "gameplay" (only the fields that change, same schema: goal {type collect|keys|exit|defeat|survive, label, count, seconds}, threat {type chasers|patrol|hazards|timer|none, label, count, speed slow|normal|fast, sight short|normal|long, hp}, player {health, shoots, jumps, builds}), "title", "pitch", "palette" {bg,panel,accent,text,danger as #rrggbb}, "modules" (0 to 2 objects {"name": CamelCase, "action": "rewrite" an existing module or "add" a new world module, "change": what to do}). Prefer "gameplay" for difficulty, enemies, goals, counts and speed; use "modules" for the look, setting and extra world features. Never create modules for the player, enemies, pickups, goals, rules or HUD.',
    ].filter(Boolean).join("\n\n") },
  ], { json: true, temperature: 0.4 }));
  if (!plan || (plan.action !== "change" && plan.action !== "answer")) throw new Error("I could not work out what to change. Try saying it differently.");
  const reply = safeText(plan.reply, 400) || "Done.";
  if (plan.action === "answer") { log(reply); return { changed: false, reply }; }

  // apply the plan to a copy of the design
  if (directorOn && plan.gameplay && typeof plan.gameplay === "object") {
    const old = design.gameplay, patch = plan.gameplay;
    design.gameplay = { ...normalizeGameplay({ goal: { ...old.goal, ...(patch.goal || {}) }, threat: { ...old.threat, ...(patch.threat || {}) }, player: { ...old.player, ...(patch.player || {}) } }, old), autoFloor: old.autoFloor };
    log("Updated the gameplay settings.");
  }
  if (typeof plan.title === "string" && safeText(plan.title, 48)) design.title = safeText(plan.title, 48);
  if (typeof plan.pitch === "string" && safeText(plan.pitch, 240)) design.pitch = safeText(plan.pitch, 240);
  if (plan.palette && typeof plan.palette === "object") for (const key of Object.keys(design.palette)) design.palette[key] = hex(plan.palette[key], design.palette[key]);

  for (const change of (Array.isArray(plan.modules) ? plan.modules : []).slice(0, 2)) {
    const name = safeText(change && change.name, 20).replace(/[^A-Za-z0-9]/g, "");
    const what = safeText(change && change.change, 300);
    if (!/^[A-Za-z][A-Za-z0-9]{1,19}$/.test(name) || !what) continue;
    if (directorOn && directorOwns(name)) { log(`The Director handles "${name}", so that part is changed through the gameplay settings instead.`, "warn"); continue; }
    const existing = done.find((m) => m.name.toLowerCase() === name.toLowerCase());
    const spec = (existing && specs.get(existing.name.toLowerCase())) || { name, responsibility: what };
    log(`${existing ? "Rewriting" : "Adding"} module ${existing ? existing.name : name}…`);
    const result = await buildModule(spec, { design, done: [...done].sort((a, b) => a.index - b.index).filter((m) => m !== existing), example, knowledge: "", current: existing ? existing.code : "", note: what, kind: "revision" });
    if (!result.code) { log(`Could not change module ${name} (${String(result.error).slice(0, 100)}); keeping it as it was.`, "warn"); continue; }
    if (existing) existing.code = result.code;
    else { done.push({ name, code: result.code, index: design.modules.length }); design.modules.push(spec); specs.set(name.toLowerCase(), spec); }
  }

  // the same playtest as a new build; a revision that breaks the game is never saved
  design.gameplay.autoFloor = directorOn ? done.length === 0 : undefined;
  const ordered = () => [...done].sort((a, b) => a.index - b.index);
  let problems = assessPlaytest(design, await playtest(design, ordered()), ordered());
  for (const problem of problems.slice(0, 2)) {
    const entry = done.find((m) => m.name === problem.blame);
    if (!entry) continue;
    log(`Playtest found: ${problem.note.slice(0, 140)}`, "warn");
    const result = await buildModule(specs.get(entry.name.toLowerCase()) || { name: entry.name, responsibility: "as already written" }, { design, done: ordered().filter((m) => m !== entry), example, knowledge: "", current: entry.code, note: problem.note });
    if (result.code) entry.code = result.code;
  }
  if (problems.length) problems = assessPlaytest(design, await playtest(design, ordered()), ordered());
  if (problems.length) {
    if (!directorOn) throw new Error("That change broke the game and could not be repaired, so the game was left as it was.");
    for (const problem of problems) { const i = done.findIndex((m) => m.name === problem.blame); if (i >= 0) { log(`Removed module ${problem.blame}: it broke the game.`, "warn"); done.splice(i, 1); } }
    design.gameplay.autoFloor = done.length === 0;
  }
  const newJs = assemble(configOf(design), ordered());
  const smoke = await smokeRun(newJs, { frames: 400, width: design.width, height: design.height, minCalls: 3, minPlayRatio: 0.1 });
  if (!smoke.ok) throw new Error(`That change did not pass the play test (${smoke.errors[0]}), so the game was left as it was.`);

  phase("Saving the new version…");
  const { files, tasks } = validateProject({ indexHtml: renderIndexHtml(design.title, design.width, design.height), gameJs: newJs, gameCss: renderCss(design), tasks: design.tasks });
  const saved = await saveProject(files, tasks, projectsDir, "ai");
  const revision = (record.revision || 1) + 1;
  await writeDesignRecord(path.join(projectsDir, saved.id), { version: 1, brief: record.brief, design, fallback: false, parentId: projectId, revision, instructions: [...(record.instructions || []), text].slice(-20) });
  log(reply);
  return { changed: true, reply, project: { ...saved, title: design.title, genre: design.genre, dimension: design.dimension, gameplay: design.gameplay, fallback: false, parentId: projectId, revision } };
}

/** Keeps the design next to the saved game so it can be revised later. Best effort: a failure never blocks a build. */
async function writeDesignRecord(projectDir, record) {
  try { await require("node:fs/promises").writeFile(path.join(projectDir, "studio-design.json"), JSON.stringify(record, null, 1), "utf8"); } catch { /* optional */ }
}

/** Last resort so every game can end: a countdown. Missing a win means surviving wins; missing a lose means time up loses. */
function fallbackRules(needWin, needLose) {
  const end = needWin && needLose ? "g.end(g.score > 0)" : needWin ? "g.end(true)" : "g.end(false)";
  return `Game.module("rulesTimer", {\n  update: function (g) {\n    var limit = 150;\n    g.hud.push("Time left: " + Math.max(0, Math.ceil(limit - g.time)));\n    if (g.time >= limit) { ${end}; }\n  }\n});`;
}

/* ---------- page and styles come from code, never from the model ---------- */
function renderIndexHtml(title, width, height) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<link rel="stylesheet" href="./game.css">\n</head>\n<body>\n<canvas id="game" width="${width}" height="${height}"></canvas>\n<script src="./game.js"></script>\n</body>\n</html>\n`;
}

function renderCss(design) {
  const p = design.palette;
  return `:root { --bg: ${p.bg}; --panel: ${p.panel}; --accent: ${p.accent}; --text: ${p.text}; --danger: ${p.danger}; }\nhtml, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }\nbody { display: flex; align-items: center; justify-content: center; overflow: hidden; }\ncanvas { width: min(100vw, calc(100vh * ${design.width} / ${design.height})); height: auto; background: var(--bg); touch-action: none; outline: none; }\n`;
}

/* ---------- main entry ---------- */
async function createGame(brief, handoff, options = {}) {
  const { projectsDir = path.join(__dirname, "projects"), emit = () => {} } = options || {};
  const log = (message, level = "info") => emit({ type: "log", level, message });
  const phase = (message) => emit({ type: "phase-started", phase: "build", message });
  let knowledge = "";
  try { knowledge = String(require("./knowledge").relevantKnowledge(brief) || ""); } catch { /* study notes are optional */ }

  phase("Choosing reference blueprints for your idea…");
  const forced = detectDimension(`${brief}\n${handoff}`);
  const references = pickReferences(`${brief}\n${handoff}`, { count: 3, dimension: forced });
  log(`Using references as inspiration only: ${references.map((r) => r.name).join(", ")}.`);

  const named = findNamedGames(`${brief}\n${handoff}`);
  const described = await describeUnknownGames(extractTitles(brief), log);
  if (named.length) log(`Using as references: ${named.map((g) => g.names[0]).join(", ")} (core loop and feel, not art or story).`);
  const dimensionHint = !forced && named.length ? named[0].dimension : "";

  phase("Designing the game…");
  const design = await designGame(brief, handoff, references, knowledge, forced, {
    referenceNote: named.length || described.length ? formatNamedGames(named, described) : "",
    gameplayHint: (named[0] && named[0].gameplay) || (described[0] && described[0].gameplay) || (references[0] && references[0].gameplay),
    dimensionHint,
  });
  const directorOn = design.gameplay.mode !== "custom";
  if (directorOn) {
    const dropped = design.modules.filter((m) => directorOwns(m.name)).map((m) => m.name);
    const kept = design.modules.filter((m) => !directorOwns(m.name));
    if (dropped.length) log(`The Director provides the player, goal, enemies, health, HUD and rules, so these modules are not needed: ${dropped.join(", ")}.`);
    design.modules = kept.length ? kept : [{ name: "World", responsibility: "the environment: floor, walls, props, lighting and mood for this game's setting" }];
    const gp = design.gameplay;
    log(`Designed "${design.title}" (${design.genre}, ${design.dimension}). Goal: ${gp.goal.type === "survive" ? `survive ${gp.goal.seconds}s` : `${gp.goal.type} ${gp.goal.type === "exit" ? "" : `${gp.goal.count} ${gp.goal.label}`}`.trim()}. Threat: ${gp.threat.type}${gp.threat.count ? ` x${gp.threat.count}` : ""}. ${design.modules.length} world module${design.modules.length === 1 ? "" : "s"}.`);
  } else log(`Designed "${design.title}" (${design.genre}, ${design.dimension}) with custom mechanics in ${design.modules.length} modules.`);

  const example = readRuntime(directorOn ? worldExampleFor(design) : FALLBACKS[design.dimension]);
  const done = [];
  const skipped = [];
  const inOrder = () => [...done].sort((a, b) => a.index - b.index);
  let failuresInARow = 0;
  for (const [index, spec] of design.modules.entries()) {
    if (failuresInARow >= 2) { log(`Skipping module ${spec.name}: the model keeps failing, so the safe fallback will be used.`, "warn"); continue; }
    log(`Building module: ${spec.name}`);
    const started = Date.now();
    const result = await buildModule(spec, { design, done: inOrder(), example, knowledge });
    if (result.code) {
      done.push({ name: spec.name, code: result.code, index });
      failuresInARow = 0;
      log(`Wrote module ${spec.name}: ${result.code.split("\n").length} lines in ${Math.round((Date.now() - started) / 1000)}s.`);
    } else {
      failuresInARow++;
      skipped.push({ spec, index, error: result.error });
      log(`Module ${spec.name} skipped (${String(result.error).slice(0, 120)}).`, "warn");
    }
  }

  // Second chance: skipped modules get one more try now that the other modules (and g.player) exist.
  if (done.length >= 1) {
    for (const item of skipped.slice(0, 2)) {
      log(`Second try for module ${item.spec.name}…`);
      const retry = await buildModule(item.spec, { design, done: inOrder(), example, knowledge });
      if (retry.code) { done.push({ name: item.spec.name, code: retry.code, index: item.index }); log(`Wrote module ${item.spec.name} on the second try.`); }
      else log(`Module ${item.spec.name} stays skipped (${String(retry.error).slice(0, 100)}).`, "warn");
    }
  }

  const specs = new Map(design.modules.map((m) => [m.name.toLowerCase(), m]));

  // A game needs stakes: both a win and a lose path must exist.
  const ensureEndings = async () => {
    if (done.length < 2) return;
    const endings = () => {
      const all = done.map((m) => m.code).join("\n");
      const dynamic = /\.end\s*\(\s*(?!true\b|false\b)[^)\s]/.test(all);
      return { win: dynamic || /\.end\s*\(\s*true\s*\)/.test(all), lose: dynamic || /\.end\s*\(\s*false\s*\)/.test(all) };
    };
    let have = endings();
    if (have.win && have.lose) return;
    const missing = [!have.win && "a win (g.end(true))", !have.lose && "a lose (g.end(false))"].filter(Boolean).join(" and ");
    log(`No ${missing} found in the modules; asking for a Rules module.`, "warn");
    const names = new Set(done.map((m) => m.name.toLowerCase()));
    const name = ["Rules", "GameRules", "RulesAndGoals"].find((n) => !names.has(n.toLowerCase())) || "RulesAndGoals2";
    const spec = { name, responsibility: `Owns the ending of the game. It must contain ${missing}: win when the player's goal is complete, lose when the player fails (health at zero, caught by a threat, or time runs out). Read the other modules' g.data fields and g.player; guard every read with || {}.` };
    specs.set(name.toLowerCase(), spec);
    const result = await buildModule(spec, { design, done: inOrder(), example, knowledge });
    if (result.code) { done.push({ name, code: result.code, index: design.modules.length }); log(`Wrote module ${name}.`); }
    have = endings();
    if (!have.win || !have.lose) {
      log("Still missing an ending, so a simple time limit was added (survive until the timer ends).", "warn");
      done.push({ name: "rulesTimer", code: fallbackRules(!have.win, !have.lose), index: design.modules.length + 1 });
    }
  };
  if (!directorOn) await ensureEndings();
  const syncFloor = () => { if (directorOn) design.gameplay.autoFloor = done.length === 0; };
  if (directorOn && done.length === 0) log("No world module was built, so the Director's default arena and floor are used.", "warn");

  // Playtest gate: a bot plays the build with no input and with random input. Findings go back to the module to blame.
  let needStarter = false;
  syncFloor();
  if (directorOn || done.length >= 2) {
    log("Play-testing the build with a bot (idle and random input)…");
    let runs = await playtest(design, inOrder());
    let problems = assessPlaytest(design, runs, inOrder());
    if (problems.length) {
      for (const problem of problems.slice(0, 2)) {
        log(`Playtest found: ${problem.note.slice(0, 150)}`, "warn");
        const entry = done.find((m) => m.name === problem.blame);
        if (!entry) continue;
        const spec = specs.get(entry.name.toLowerCase()) || { name: entry.name, responsibility: "as already written" };
        const result = await buildModule(spec, { design, done: inOrder().filter((m) => m.name !== entry.name), example, knowledge, current: entry.code, note: problem.note });
        if (result.code) { entry.code = result.code; log(`Rewrote module ${entry.name} after the playtest.`); }
      }
      runs = await playtest(design, inOrder());
      problems = assessPlaytest(design, runs, inOrder());
      if (directorOn && problems.length) {
        for (const problem of problems) {
          const i = done.findIndex((m) => m.name === problem.blame);
          if (i >= 0) { log(`Removed module ${problem.blame}: ${problem.kind === "instant_end" ? "it ends the game instantly" : "it breaks the player controls"}, so the Director takes over.`, "warn"); done.splice(i, 1); }
        }
        syncFloor();
        runs = await playtest(design, inOrder());
        problems = assessPlaytest(design, runs, inOrder());
        if (problems.length) { needStarter = true; log(`Even without the broken module the build fails the playtest (${problems[0].note.slice(0, 100)}).`, "warn"); }
      } else if (problems.some((p) => p.kind !== "instant_end")) {
        needStarter = true;
        log(`The build still fails the playtest (${problems[0].note.slice(0, 110)}).`, "warn");
      } else if (problems.length) {
        for (const problem of problems) { const i = done.findIndex((m) => m.name === problem.blame); if (i >= 0) { log(`Removed module ${problem.blame}: it ends the game instantly.`, "warn"); done.splice(i, 1); } }
        await ensureEndings();
      }
    }
    if (UNJUDGED.includes(runs.active.mode) || UNJUDGED.includes(runs.idle.mode)) log(`The playtest bot could not finish (${runs.active.mode}/${runs.idle.mode}); relying on the final check instead.`, "warn");
    else if (!needStarter && !problems.length) log(`Playtest passed: the bot moved ${Number(runs.active.moved || 0).toFixed(1)} ${design.dimension === "2d" ? "pixels" : "units"} in ${Number(runs.active.playFrames || 0)} frames, and an idle player ${runs.idle.endInfo ? `lasted ${Number(runs.idle.endInfo.time).toFixed(0)}s` : "was not ended by the game"}.`);
  }

  let gameJs = "";
  let usedFallback = false;
  syncFloor();
  if ((directorOn || done.length >= 2) && !needStarter) {
    gameJs = assemble(configOf(design), inOrder());
    const smoke = await smokeRun(gameJs, { frames: 400, width: design.width, height: design.height, minCalls: 3, minPlayRatio: 0.1 });
    if (!smoke.ok) { log(`The assembled game failed its play test (${smoke.errors[0]}).`, "warn"); gameJs = ""; }
  }
  if (!gameJs) {
    usedFallback = true;
    log(`Shipping the guaranteed-playable ${design.dimension.toUpperCase()} starter so the sprint still delivers.`, "warn");
    gameJs = assemble({ ...configOf(design), gameplay: undefined }, [{ name: "fallback", code: readRuntime(FALLBACKS[design.dimension]) }]);
  }

  phase("Validating and saving the build…");
  const { files, tasks } = validateProject({ indexHtml: renderIndexHtml(design.title, design.width, design.height), gameJs, gameCss: renderCss(design), tasks: design.tasks });
  const saved = await saveProject(files, tasks, projectsDir, "ai");
  await writeDesignRecord(path.join(projectsDir, saved.id), { version: 1, brief: clip(brief, 4000), design, fallback: usedFallback });
  return { ...saved, title: design.title, genre: design.genre, dimension: design.dimension, gameplay: design.gameplay, fallback: usedFallback };
}

module.exports = { createGame, chat, parseJson, tryParseJson, smokeTest, normalizeDesign, stripFences, sanitizeModule, checkModule, assemble, renderIndexHtml, renderCss, detectDimension, safeText, clip, kitCatalog, fixKitNames, fallbackRules, assessPlaytest, playtest, normalizeGameplay, directorOwns, describeUnknownGames, writeDesignRecord, reviseGame, parseModules, buildModule, configOf };
