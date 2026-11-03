const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getModel, usingKeylessDefault } = require("./settings");
const { cleanReply, llmFetch } = require("./llm");
const { validateProject, saveProject } = require("./project-builder");
const { relevantKnowledge } = require("./knowledge");
const { sanitizeModule } = require("./module-sanitizer");
const { BLUEPRINT_SOURCE, designFor, routeBlueprint } = require("./blueprint-router");

const ENGINE_SOURCE = `${fs.readFileSync(path.join(__dirname, "studio-engine.js"), "utf8")}\n${fs.readFileSync(path.join(__dirname, "studio-kit.js"), "utf8")}`;
const MAX_REPAIRS = 3;
const FORBIDDEN = /(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|WebSocket|\bimport\b|\beval\s*\(|localStorage|sessionStorage|new Function)/i;

async function chat(messages, { json = false, maxTokens = 12000, temperature = 0.6 } = {}) {
  const response = await llmFetch({
    body: JSON.stringify({
      model: getModel(),
      temperature,
      max_completion_tokens: maxTokens,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Game generation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const content = (await response.json()).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned an empty response.");
  return cleanReply(content);
}

// Models served through other providers often wrap JSON in fences or prose; take the outermost object.
function parseJson(text) {
  try { return JSON.parse(text); } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw error;
    return JSON.parse(text.slice(start, end + 1));
  }
}
const stripFences = (text) => text.replace(/^\s*```[a-z]*\s*\n/i, "").replace(/\n```\s*$/i, "").trim();

const DESIGN_SYSTEM = `You are the lead game designer and technical architect at Traumatic Studios. Any person can bring you any game idea, in any genre (arcade, adventure, RPG, roguelike, platformer, puzzle, strategy, tower defense, racing, card or board game, sim, rhythm, fighting, horror, sandbox, text-heavy, hybrids and invented genres). Your job is to turn the idea into a faithful, ambitious, genuinely playable 2D browser game design.
Rules:
- Fidelity first: the game must be the genre and fantasy the brief asks for. NEVER fall back to a generic catch/dodge/paddle game unless the brief asks for it. If the brief names a reference game, reproduce its core mechanics, structure and feel at a 2D canvas scale.
- Depth: the first build must contain a full game loop with progression, not a single mechanic. Plan real content: multiple levels/rooms/enemy types/items/upgrades as the genre demands, procedurally generated from a seed where hand-authoring is impractical.
- Everything is drawn with canvas 2D primitives (no external assets). Plan a distinct visual identity and original names, no stock cyan-on-navy default.
- Plan 4 to 8 code modules, each a section of one JavaScript file that share globals. The last module must be named "main" and must start the game with Engine.start({ reset, update, draw }).
Return only JSON: { title, genre, summary, canvas:{width,height} (width 480-960, height 360-720), palette:{bg,panel,accent,text,danger}, controls:[strings], coreVerbs:[strings], systems:[{name,description}], content:[strings describing concrete levels/enemies/items/etc], progression, winCondition, loseCondition, artDirection, mustNotBe:[strings describing the generic games this must not degrade into], modules:[{name,responsibility,exports}], tasks:[3 to 5 objects {title,owner,description}] }. Task owners must be exactly Game designer, Gameplay engineer, QA tester, or Producer; description 10-300 chars.`;

const ENGINE_DOC = `The file already defines a global \`Engine\` toolkit (do not redefine it) with: Engine.W/H/ctx/canvas; Engine.input.held('arrowleft','a')/pressed('space')/pointer{x,y,down,pressed,released} (keys are lowercase, space is 'space'); Engine.move() -> {x,y} from arrows/WASD; Engine.action() true when space/j/z/enter pressed; Engine.rng(seed) -> {next,range,int,chance,pick,shuffle}; Engine.hashString(text); Engine.sfx('blip'|'pickup'|'hit'|'jump'|'shoot'|'explode'|'powerup'|'lose'|'win' or {freq,dur,type,slide,vol}); Engine.fx.burst(x,y,{count,color,speed,life,size,gravity})/text(x,y,str,color)/shake(power,time)/draw(ctx); Engine.clamp/lerp/dist/angle; Engine.hit.rect/circle/point; Engine.camera.follow(target,bounds)/begin(ctx)/end(ctx); Engine.grid.make/get/set/path (BFS); Engine.ui.hud(text)/message(text)/text(ctx,str,x,y,{size,color,align})/banner(ctx,title,sub)/bar(...); Engine.start({reset,update(dt),draw(ctx)}) runs a fixed 60Hz loop and wires the Restart button and R key to reset(). Call Engine.fx.draw(ctx) at the end of draw. The page has canvas#game, #hud, #message and #restart already. Use these rather than rewriting them.

A second pre-tested global \`Kit\` is also already defined (do not redefine it); ASSEMBLE GAMES FROM IT instead of hand-writing physics, maps, AI or audio: Kit.tiles.fromRows(rows,tileSize,legend,solidFn)/make/get/set/solidAt/overlaps/move(map,body{x,y,w,h},dx,dy)->{x,y} blocked axes/lineClear/draw(ctx,map,{tileValue:color},camera,{w,h}) for tile maps with wall-sliding collision; Kit.platformer(body,{x,jumpPressed,jumpHeld},dt,map,opts) gives acceleration, gravity, coyote time, jump buffering and variable jump height (sets body.onGround; returns {jumped,landed,bumped}); Kit.topdown(body,{x,y},dt,map,{speed}) gives smooth 4/8-way movement with wall sliding and body.facing; Kit.health(max,{invuln}) -> {hp,hurt(n),heal(n),update(dt),alive(),blinking()}; Kit.knockback(body,fromX,fromY,power); Kit.timer(sec).update(dt) -> true when it fires; Kit.tween(from,to,dur,Kit.ease.outQuad).update(dt); Kit.fsm({state:{enter,update(ctx,dt),exit}},initial,ctx) with .go(name); Kit.bus() with on/emit; Kit.path.astar(map,from,to)/flow(map,goal)+next(field,x,y); Kit.steer.seek/flee/sees(map,from,to,range); Kit.noise(seed)(x,y); Kit.gen.rooms(rng,w,h,{rooms})/cave(rng,w,h)/maze(rng,w,h)/dungeon(rng,cols,rows) (rooms, caves and mazes are always connected; dungeon() returns rooms, doors with locked flags and a reachable keyRoom) where rng is Engine.rng(seed); Kit.music.compose(rng,{scale:'minor'|'major'|'pentatonic'|'dorian',bars,root,bpm}) then Kit.music.play(song)/stop() for background music; Kit.dialogue.open(lines,onDone)/update(dt,advancePressed)/draw(ctx,Engine.W,Engine.H,speaker) with .active; Kit.palettes.forest|dungeon|desert|ocean|neon|snow (arrays of hex colours) and Kit.shade(hex,amount). Write only the game-specific content (rules, entities, levels, art, balance) on top of Engine and Kit.`;

const CODE_RULES = `Code rules: plain browser JavaScript, no imports/modules, no network, no storage, no eval, no external URLs or assets. Module code shares one global scope, so use unique top-level names, prefix with the module name where collisions are likely, and only reference things defined in earlier modules or the declared exports of other modules. Write complete working code, never placeholders or TODOs. Handle every state (title/playing/paused/won/lost) and make restart reset all state. Give clear on-canvas feedback and instructions. Aim for game feel: call Engine.sfx(...) on key actions, Engine.fx.burst/text/shake on impacts and rewards, and prefer Engine.rng(seed) over Math.random().`;

function validateDesign(design) {
  if (!design || typeof design !== "object") throw new Error("The design is not an object.");
  if (typeof design.title !== "string" || !design.title.trim()) throw new Error("The design has no title.");
  if (!Array.isArray(design.modules) || design.modules.length < 2 || design.modules.length > 10) throw new Error("The design needs 2-10 modules.");
  for (const module of design.modules) {
    if (typeof module?.name !== "string" || !/^[a-z][a-z0-9_-]{1,30}$/i.test(module.name) || typeof module.responsibility !== "string") throw new Error("A design module is invalid.");
  }
  const mainIndex = design.modules.findIndex((module) => module.name.toLowerCase() === "main");
  if (mainIndex === -1) throw new Error("The design has no main module.");
  design.modules.push(...design.modules.splice(mainIndex, 1));
  const canvas = design.canvas || {};
  design.canvas = {
    width: Math.round(Math.min(960, Math.max(480, Number(canvas.width) || 800))),
    height: Math.round(Math.min(720, Math.max(360, Number(canvas.height) || 560))),
  };
  const color = (value, fallback) => (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);
  const palette = design.palette || {};
  design.palette = {
    bg: color(palette.bg, "#101418"), panel: color(palette.panel, "#1a2027"), accent: color(palette.accent, "#ffb454"),
    text: color(palette.text, "#e8eef5"), danger: color(palette.danger, "#ff5d5d"),
  };
  design.controls = Array.isArray(design.controls) ? design.controls.filter((c) => typeof c === "string").slice(0, 10) : [];
  return design;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildShell(design) {
  const { width, height } = design.canvas;
  const p = design.palette;
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(design.title)}</title>
    <link rel="stylesheet" href="./game.css">
  </head>
  <body>
    <main>
      <h1>${escapeHtml(design.title)}</h1>
      <p class="how">${escapeHtml(design.controls.join(" · ") || "See the in-game instructions.")}</p>
      <canvas id="game" width="${width}" height="${height}" aria-label="${escapeHtml(design.title)} game area" tabindex="0"></canvas>
      <p id="hud" role="status"></p>
      <p id="message" role="status"></p>
      <button id="restart" type="button">Restart (R)</button>
    </main>
    <script src="./game.js"></script>
  </body>
</html>
`;
  const gameCss = `body { margin: 0; background: ${p.bg}; color: ${p.text}; font: 15px system-ui, sans-serif; }
main { max-width: ${width + 40}px; margin: 0 auto; padding: 16px; text-align: center; }
h1 { margin: 4px 0; font-size: 24px; color: ${p.accent}; }
.how { margin: 0 0 10px; opacity: 0.75; }
canvas { width: 100%; max-width: ${width}px; background: ${p.panel}; border: 1px solid ${p.accent}55; border-radius: 8px; touch-action: none; outline: none; image-rendering: pixelated; }
#hud { font: 600 15px ui-monospace, monospace; margin: 8px 0 2px; }
#message { min-height: 20px; margin: 2px 0 10px; color: ${p.accent}; }
button { padding: 8px 18px; border: 0; border-radius: 6px; background: ${p.accent}; color: ${p.bg}; font-weight: 700; cursor: pointer; }
`;
  return { indexHtml, gameCss };
}

// Executes the assembled game against a permissive stub DOM for a number of frames to catch load-time and runtime crashes.
function smokeTest(gameJs, canvasSize, totalFrames = 360) {
  let drawLog = "";
  const DRAW_CALLS = new Set(["fillRect", "strokeRect", "fillText", "strokeText", "arc", "ellipse", "lineTo", "moveTo", "drawImage", "rect"]);
  const ctxStub = new Proxy(function () {}, {
    get: (_t, name) => {
      if (name === "measureText") return () => ({ width: 10 });
      if (name === "createLinearGradient" || name === "createRadialGradient") return () => ({ addColorStop() {} });
      if (name === "canvas") return canvasStub;
      if (DRAW_CALLS.has(name)) return (...args) => { drawLog += `${name}${args.join(",")};`; return ctxStub; };
      return ctxStub;
    },
    set: (_t, name, value) => { if (name === "fillStyle" || name === "strokeStyle") drawLog += `${name}=${String(value)};`; return true; },
    apply: () => ctxStub,
  });
  const element = () => ({ textContent: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, blur() {}, focus() {}, innerHTML: "" });
  const canvasStub = {
    ...element(), width: canvasSize.width, height: canvasSize.height,
    getContext: () => ctxStub,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvasSize.width, height: canvasSize.height }),
  };
  const listeners = {};
  const frames = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, Array, Object, Number, String, Map, Set, Proxy, Promise, Symbol, Uint8Array, Float32Array, Int32Array, Uint32Array,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    document: {
      getElementById: (id) => (id === "game" ? canvasStub : element()),
      querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(), addEventListener() {},
      body: element(),
    },
    AudioContext: undefined,
  };
  sandbox.window = Object.assign(sandbox, {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
  });
  const context = vm.createContext(sandbox);
  try {
    new vm.Script(gameJs, { filename: "game.js" }).runInContext(context, { timeout: 2000 });
    const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "a", "d", "w", "s", "j", "z", "e", "x", "r"];
    const signatures = new Set();
    for (let i = 0; i < totalFrames; i++) {
      const pending = frames.splice(0);
      if (pending.length === 0) throw new Error("The game never started its animation loop (Engine.start was not called or stopped).");
      if (i % 3 === 0) fire("keydown", { key: keys[(i / 3) % keys.length | 0], preventDefault() {} });
      if (i % 3 === 2) fire("keyup", { key: keys[((i - 2) / 3) % keys.length | 0], preventDefault() {} });
      if (i % 40 === 0) {
        fire("pointerdown", { clientX: (i * 7) % canvasSize.width, clientY: (i * 5) % canvasSize.height });
        fire("pointermove", { clientX: (i * 7) % canvasSize.width, clientY: (i * 5) % canvasSize.height });
      }
      drawLog = "";
      for (const fn of pending) fn((i + 1) * 17);
      signatures.add(drawLog);
    }
    if (signatures.size < 3) throw new Error("The screen barely changes while keys are pressed and time passes (a title screen that never starts, a frozen game state, or modules that do not share state). Make Space/Enter start the game and make the world animate and respond to input.");
    return null;
  } catch (error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${String(error.stack).split("\n").slice(1, 4).join("\n")}` : ""}`;
  }
}

function applyPatches(source, patches) {
  let result = source;
  let applied = 0;
  if (!Array.isArray(patches)) return { result, applied };
  for (const patch of patches) {
    if (typeof patch?.find !== "string" || typeof patch?.replace !== "string" || patch.find.length === 0) continue;
    const index = result.indexOf(patch.find);
    if (index === -1 || result.indexOf(patch.find, index + 1) !== -1) continue;
    result = result.slice(0, index) + patch.replace + result.slice(index + patch.find.length);
    applied++;
  }
  return { result, applied };
}

const assemble = (parts) => `${ENGINE_SOURCE}\n${parts.map(({ name, code }) => `\n/* ---- module: ${name} ---- */\n${code}`).join("\n")}\n`;

// Real Engine and Kit member names, read from the sources themselves so they can never drift from the code.
let apiCache = null;
function loadApi() {
  if (apiCache) return apiCache;
  try {
    const stub = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : stub), apply: () => stub, construct: () => stub, set: () => true });
    const sandbox = { document: stub, window: stub, navigator: stub, performance: { now: () => 0 }, requestAnimationFrame: () => 0, AudioContext: stub, localStorage: stub, addEventListener() {}, console: { log() {}, warn() {}, error() {} } };
    vm.runInNewContext(`${ENGINE_SOURCE}\nconst members = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === "object" ? Object.keys(v) : typeof v]));\nthis.api = { Engine: members(Engine), Kit: members(Kit), palettes: Kit.palettes };`, sandbox, { timeout: 2000 });
    apiCache = JSON.parse(JSON.stringify(sandbox.api));
  } catch { apiCache = {}; }
  return apiCache;
}

// A model that invented Kit.tilemap is told the true name (Kit.tiles) instead of guessing again.
function apiHint(problem) {
  if (!/\b(Kit|Engine)\b|undefined|not a function/.test(problem)) return "";
  const api = loadApi();
  if (!api.Kit) return "";
  const kit = Object.entries(api.Kit).map(([k, v]) => (Array.isArray(v) ? `Kit.${k}.{${v.join(",")}}` : `Kit.${k}`)).join("  ");
  return `\n\nThe ONLY names that exist: Engine.{${Object.keys(api.Engine).join(",")}}\n${kit}\nUse exactly these; never invent others.`;
}

// Deterministic fixes (ES-module syntax, invented API names) that cost no model call.
function sanitize(code, name, emit) {
  const { code: fixed, changes } = sanitizeModule(code, loadApi());
  if (changes.length) emit({ type: "log", level: "info", message: `Auto-fixed module ${name}: ${changes.slice(0, 4).join("; ")}.` });
  return fixed;
}
async function repair(design, brief, parts, problem) {
  problem += apiHint(problem);
  const game = assemble(parts).slice(ENGINE_SOURCE.length);
  const reply = await chat([
    { role: "system", content: `You fix bugs in a browser game with minimal exact-text patches. ${ENGINE_DOC} Return only JSON: { patches: [{ find, replace }] } where each find is an exact, unique substring of the current game code (not the engine).` },
    { role: "user", content: `Original brief:\n${brief}\n\nProblem to fix:\n${problem}\n\nCurrent game code:\n${game}` },
  ], { json: true, temperature: 0.2 });
  let patches = [];
  try { patches = parseJson(reply).patches || []; } catch { /* fall back to a module rewrite below */ }
  let total = 0;
  for (const part of parts) {
    const { result, applied } = applyPatches(part.code, patches);
    part.code = result;
    total += applied;
  }
  if (total === 0) total += await rewriteFaultyModule(brief, parts, problem);
  return total;
}

// Patches that match nothing change nothing, so rewrite the module that actually has the problem.
async function rewriteFaultyModule(brief, parts, problem) {
  const target = parts.find((part) => syntaxProblem(part.code) || codeProblems(part.code).length)
    || parts.find((part) => /Engine\.start\s*\(/.test(part.code))
    || parts[parts.length - 1];
  const others = parts.filter((part) => part !== target).map((part) => `/* ${part.name} */\n${part.code}`).join("\n\n");
  const code = stripFences(await chat([
    { role: "system", content: `You fix one module of a browser game. ${ENGINE_DOC}\n${CODE_RULES}\nReturn ONLY the complete corrected JavaScript for this module, no fences, no commentary.` },
    { role: "user", content: `Brief:\n${brief}\n\nProblem to fix:\n${problem}\n\nOther modules (do not repeat them):\n${others}\n\nModule "${target.name}" to rewrite:\n${target.code}` },
  ], { maxTokens: 16000, temperature: 0.2 }));
  if (!code.trim() || syntaxProblem(code)) return 0;
  target.code = code;
  return 1;
}

function syntaxProblem(code) {
  try { new vm.Script(code); return ""; } catch (error) { return error.message; }
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/.*$/gm, (m, lead) => (lead || "") + " ");

// Problems in one piece of game code that would break the build. Each message quotes the offending text so the model can fix it.
function codeProblems(code) {
  const problems = [];
  const hit = stripComments(code).match(new RegExp(FORBIDDEN.source, "gi"));
  if (hit) problems.push(`Remove prohibited code (network, storage, eval, imports or external URLs). Found: ${[...new Set(hit)].slice(0, 4).map((h) => JSON.stringify(h)).join(", ")}.`);
  const clean = stripComments(code);
  if (/\b(?:const|let|var|function|class)\s+(?:Engine|Kit)\b/.test(clean)) problems.push("Do not redefine Engine or Kit; they already exist as globals.");
  if (/\b(?:setInterval|setTimeout)\s*\(/.test(clean)) problems.push("Do not time gameplay with setTimeout/setInterval; count down in update(dt) (Kit.timer helps).");
  if (/\brequestAnimationFrame\s*\(/.test(clean)) problems.push("Do not run your own requestAnimationFrame loop; Engine.start already runs the loop.");
  return problems;
}

function checkQuality(gameJs) {
  const problems = codeProblems(gameJs.slice(ENGINE_SOURCE.length));
  if (!/Engine\.start\s*\(/.test(gameJs)) problems.push("The game must call Engine.start({ reset, update, draw }).");
  try { new vm.Script(gameJs); } catch (error) { problems.push(`Syntax error: ${error.message}`); }
  return problems;
}

// Style advice (sound, game feel, seeded randomness) is given to the model as guidance, not enforced, so a weak model is never failed over it.
function styleAdvice(code) {
  const advice = [];
  if (/\bMath\.random\s*\(/.test(code)) advice.push("prefer Engine.rng(seed) over Math.random()");
  if (!/Engine\.sfx\s*\(/.test(code)) advice.push("add Engine.sfx(...) on key actions");
  if (!/Engine\.fx\.(?:burst|text|shake)\s*\(/.test(code)) advice.push("add Engine.fx.burst/text/shake on impacts and rewards");
  return advice;
}

const useBlueprints = () => process.env.STUDIO_BLUEPRINTS === "always" || (process.env.STUDIO_BLUEPRINTS !== "off" && usingKeylessDefault());

// One small JSON answer from the model, run on pre-tested game code. Returns null to fall back to freeform generation.
async function tryBlueprint(brief, handoff, knowledge, emit) {
  try {
    emit({ type: "phase-started", phase: "build", message: "Choosing a pre-tested game blueprint for your idea…" });
    const routed = await routeBlueprint({ chat, parseJson }, brief, handoff, knowledge);
    if (!routed) {
      emit({ type: "log", level: "info", message: "Idea needs custom code; using the freeform builder." });
      return null;
    }
    const design = designFor(routed, loadApi().palettes || {});
    const parts = [{ name: "blueprint", code: BLUEPRINT_SOURCE }, { name: "main", code: `Blueprint.run(${JSON.stringify(routed.spec)});` }];
    const gameJs = assemble(parts);
    const runtime = smokeTest(gameJs, design.canvas);
    if (runtime) throw new Error(runtime);
    emit({ type: "log", level: "ok", message: `Built "${design.title}" on the ${routed.type} blueprint.` });
    const { indexHtml, gameCss } = buildShell(design);
    return { design, project: { indexHtml, gameJs, gameCss, tasks: design.tasks } };
  } catch (error) {
    emit({ type: "log", level: "warn", message: `Blueprint route failed (${String(error.message).slice(0, 100)}); using the freeform builder.` });
    return null;
  }
}

async function generateGame(brief, handoff, emit = () => {}) {
  const knowledge = relevantKnowledge(`${brief} ${handoff}`);
  if (knowledge) emit({ type: "log", level: "info", message: "Applying lessons the studio learned from its study sources." });
  if (useBlueprints()) {
    const built = await tryBlueprint(brief, handoff, knowledge, emit);
    if (built) return built;
  }
  let design;
  for (let attempt = 1; ; attempt++) {
    try {
      design = validateDesign(parseJson(await chat([
        { role: "system", content: DESIGN_SYSTEM },
        { role: "user", content: `Game idea from the user (the authority on what to build):\n${brief}\n\nTeam handoff notes (advisory):\n${handoff}${knowledge}\n\nProduce the design JSON.${attempt > 1 ? " Your previous answer was not valid design JSON; follow the schema exactly." : ""}` },
      ], { json: true, temperature: 0.8, maxTokens: 6000 })));
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      emit({ type: "log", level: "warn", message: `The design came back malformed (${error.message.slice(0, 80)}); asking again (${attempt + 1}/3).` });
    }
  }
  emit({ type: "phase-started", phase: "build", message: `Designed "${design.title}" (${design.genre}) in ${design.modules.length} modules.` });

  const parts = [];
  for (const module of design.modules) {
    emit({ type: "phase-started", phase: "build", message: `Building module: ${module.name}` });
    const startedAt = Date.now();
    const source = parts.map((part) => `/* ${part.name} */\n${part.code}`).join("\n\n");
    let code = stripFences(await chat([
      { role: "system", content: `You are a senior gameplay engineer writing one module of a larger single-file browser game. ${ENGINE_DOC}\n${CODE_RULES}\nReturn ONLY the JavaScript for this module, no markdown fences, no commentary.` },
      { role: "user", content: `Original brief:\n${brief}\n\nGame design:\n${JSON.stringify({ ...design, tasks: undefined })}\n\nModule to write now: "${module.name}" - ${module.responsibility}. Declared exports: ${JSON.stringify(module.exports || [])}.\nThe other modules, in order: ${design.modules.map((m) => `${m.name} (${m.responsibility}; exports ${JSON.stringify(m.exports || [])})`).join(" | ")}.\n\nModules already written (full source):\n${source || "(none yet)"}\n\nWrite a complete, substantial, polished implementation of this module${module.name.toLowerCase() === "main" ? ", including reset, update, draw and the Engine.start call" : ""}.${knowledge}` },
    ], { maxTokens: 16000, temperature: 0.5 }));
    code = sanitize(code, module.name, emit);
    // A module that does not even parse is rewritten at once, which is cheaper and safer than patching the assembled game.
    for (let attempt = 0; attempt < 2; attempt++) {
      const syntax = syntaxProblem(code) || codeProblems(code)[0] || "";
      if (!syntax) break;
      emit({ type: "log", level: "warn", message: `Module ${module.name} has a syntax error (${syntax}); asking for a corrected version.` });
      code = stripFences(await chat([
        { role: "system", content: `You repair JavaScript syntax errors. Return ONLY the complete corrected JavaScript, no fences, no commentary. Keep the behaviour unchanged.` },
        { role: "user", content: `Syntax error: ${syntax}\n\nCode:\n${code}` },
      ], { maxTokens: 16000, temperature: 0.2 }));
    }
    parts.push({ name: module.name, code });
    emit({ type: "log", level: "ok", message: `Wrote module ${module.name}: ${code.split("\n").length} lines in ${Math.round((Date.now() - startedAt) / 1000)}s.` });
  }

  let problem = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const gameJs = assemble(parts);
    const problems = checkQuality(gameJs);
    const runtime = problems.length ? null : smokeTest(gameJs, design.canvas);
    if (runtime) problems.push(`Runtime error while simulating play: ${runtime}`);
    if (!problems.length) { problem = null; break; }
    problem = problems.join("\n");
    if (attempt === MAX_REPAIRS) break;
    emit({ type: "phase-started", phase: "build", message: `Fixing issue (attempt ${attempt + 1}): ${problems[0].slice(0, 140)}` });
    await repair(design, brief, parts, problem);
    for (const part of parts) part.code = sanitize(part.code, part.name, emit);
  }
  if (problem) throw new Error(`The generated game still fails its checks: ${problem.slice(0, 300)}`);

  emit({ type: "phase-started", phase: "build", message: "Checking the build against your original idea…" });
  const review = parseJson(await chat([
    { role: "system", content: `You are a strict QA lead. Decide whether the game code faithfully implements the user's idea and is not a generic substitute. Return only JSON: { faithful: boolean, missing: [strings] }, naming concrete missing mechanics, systems or content. ${ENGINE_DOC}` },
    { role: "user", content: `Brief:\n${brief}\n\nDesign must-not-be list: ${JSON.stringify(design.mustNotBe || [])}\n\nGame code:\n${assemble(parts).slice(ENGINE_SOURCE.length)}` },
  ], { json: true, temperature: 0 }));
  if (review.faithful === false && Array.isArray(review.missing) && review.missing.length) {
    emit({ type: "phase-started", phase: "build", message: `Adding missing features: ${review.missing.slice(0, 3).join("; ").slice(0, 160)}` });
    const snapshot = parts.map((part) => ({ ...part }));
    try {
      await repair(design, brief, parts, `Implement these missing features faithfully without breaking existing play:\n- ${review.missing.join("\n- ")}`);
      const gameJs = assemble(parts);
      if (checkQuality(gameJs).length || smokeTest(gameJs, design.canvas)) parts.splice(0, parts.length, ...snapshot);
    } catch {
      parts.splice(0, parts.length, ...snapshot);
    }
  }

  const { indexHtml, gameCss } = buildShell(design);
  const advice = styleAdvice(assemble(parts).slice(ENGINE_SOURCE.length));
  if (advice.length) emit({ type: "log", level: "info", message: `Polish suggestions for a follow-up task: ${advice.join("; ")}.` });
  return { design, project: { indexHtml, gameJs: assemble(parts), gameCss, tasks: design.tasks } };
}

async function createGame(brief, handoff, { projectsDir, emit } = {}) {
  const { project } = await generateGame(brief, handoff, emit);
  const { files, tasks } = validateProject(project);
  return saveProject(files, tasks, projectsDir || path.join(__dirname, "projects"), "ai");
}

module.exports = { applyPatches, buildShell, chat, codeProblems, createGame, DESIGN_SYSTEM, generateGame, parseJson, smokeTest, stripFences, styleAdvice, validateDesign };
