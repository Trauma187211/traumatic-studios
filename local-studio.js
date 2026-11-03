const { saveLearnings, readLearnings, getMemoryFile } = require("./memory-store");
const path = require("node:path");
const { addTaskNote, listProjects, saveProject, validateProject } = require("./project-builder");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "about", "that", "who", "where", "game", "make", "build", "create", "want", "like", "is", "it", "its", "my", "me", "i"]);
const DODGE_WORDS = /\b(dodge|avoid|escape|survive|survival|flee|run away|evade|hazard|enemy|enemies|asteroid|meteor)\b/i;
const PALETTES = [
  { bg: "#0b1020", panel: "#141b33", player: "#69cfff", item: "#ffd166", danger: "#ff6b6b" },
  { bg: "#10140d", panel: "#1b2316", player: "#9be37a", item: "#ffe66d", danger: "#ff7a59" },
  { bg: "#170d1c", panel: "#26142e", player: "#ff8fd8", item: "#8ff0ff", danger: "#ffb35c" },
  { bg: "#0d1a1a", panel: "#142b2b", player: "#7affd9", item: "#ffd37a", danger: "#ff7a8a" },
];

function hash(text) {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return value;
}

function keywords(brief) {
  const words = brief.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
}

function titleFor(brief) {
  const words = keywords(brief).slice(0, 3);
  const title = (words.length ? words : ["studio", "prototype"]).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return title.slice(0, 40);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function planFor(brief) {
  const mode = DODGE_WORDS.test(brief) ? "dodge" : "collect";
  const palette = PALETTES[hash(brief) % PALETTES.length];
  const theme = keywords(brief)[0] || "star";
  return { mode, palette, theme, title: titleFor(brief) };
}

const GAME_JS = `const canvas = document.getElementById("game");
const context = canvas.getContext("2d");
const hud = document.getElementById("hud");
const message = document.getElementById("message");
const restartButton = document.getElementById("restart");
const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const GOAL = CONFIG.mode === "collect" ? 12 : 30;
const keys = { left: false, right: false };
let player, things, score, lives, elapsed, spawnTimer, state, lastTime;

function reset() {
  player = { x: WIDTH / 2 - 28, y: HEIGHT - 44, w: 56, h: 18, speed: 340 };
  things = [];
  score = 0;
  lives = 3;
  elapsed = 0;
  spawnTimer = 0;
  state = "playing";
  message.textContent = CONFIG.mode === "collect"
    ? "Catch " + GOAL + " " + CONFIG.theme + "s. Missing one costs a life."
    : "Survive " + GOAL + " seconds. Dodge the falling hazards.";
  restartButton.blur();
}

function spawn() {
  const size = 16 + Math.random() * 10;
  things.push({ x: Math.random() * (WIDTH - size), y: -size, size: size, speed: 110 + Math.random() * 80 + elapsed * 3 });
}

function loseLife() {
  lives -= 1;
  if (lives <= 0) {
    state = "lost";
    message.textContent = "Run over. Press Restart, R or Enter to try again.";
  }
}

function update(dt) {
  if (state !== "playing") return;
  elapsed += dt;
  const direction = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  player.x = Math.max(0, Math.min(WIDTH - player.w, player.x + direction * player.speed * dt));
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawn();
    spawnTimer = Math.max(0.35, 0.9 - elapsed * 0.01);
  }
  for (const thing of things) thing.y += thing.speed * dt;
  things = things.filter((thing) => {
    const hit = thing.y + thing.size >= player.y && thing.y <= player.y + player.h && thing.x + thing.size >= player.x && thing.x <= player.x + player.w;
    if (hit) {
      if (CONFIG.mode === "collect") score += 1;
      else loseLife();
      return false;
    }
    if (thing.y > HEIGHT) {
      if (CONFIG.mode === "collect") loseLife();
      return false;
    }
    return true;
  });
  if (CONFIG.mode === "dodge") score = Math.floor(elapsed);
  if (state === "playing" && score >= GOAL) {
    state = "won";
    message.textContent = "You win! Press Restart, R or Enter to play again.";
  }
}

function draw() {
  context.fillStyle = CONFIG.palette.bg;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = CONFIG.palette.player;
  context.fillRect(player.x, player.y, player.w, player.h);
  context.fillStyle = CONFIG.mode === "collect" ? CONFIG.palette.item : CONFIG.palette.danger;
  for (const thing of things) {
    context.beginPath();
    context.arc(thing.x + thing.size / 2, thing.y + thing.size / 2, thing.size / 2, 0, Math.PI * 2);
    context.fill();
  }
  hud.textContent = (CONFIG.mode === "collect" ? "Caught " : "Time ") + score + " / " + GOAL + "   Lives " + lives;
}

function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") keys.left = true;
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") keys.right = true;
  if (event.key.toLowerCase() === "r" || (state !== "playing" && event.key === "Enter")) reset();
  if (event.key.indexOf("Arrow") === 0) event.preventDefault();
});
window.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") keys.left = false;
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") keys.right = false;
});
canvas.addEventListener("pointermove", (event) => {
  const bounds = canvas.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
  player.x = Math.max(0, Math.min(WIDTH - player.w, x - player.w / 2));
});
restartButton.addEventListener("click", reset);

reset();
requestAnimationFrame(frame);
`;

function buildFiles(plan) {
  const config = JSON.stringify({ mode: plan.mode, theme: plan.theme.replace(/[^a-z'-]/g, ""), palette: plan.palette });
  const how = plan.mode === "collect"
    ? "Move with ← → or A / D (or drag the pointer). Catch the falling objects; missing one costs a life."
    : "Move with ← → or A / D (or drag the pointer). Dodge every falling hazard until the timer hits 30.";
  return {
    indexHtml: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(plan.title)}</title>
    <link rel="stylesheet" href="./game.css">
  </head>
  <body>
    <main>
      <h1>${escapeHtml(plan.title)}</h1>
      <p class="how">${escapeHtml(how)}</p>
      <canvas id="game" width="480" height="560" aria-label="Game area"></canvas>
      <p id="hud" role="status"></p>
      <p id="message" role="status"></p>
      <button id="restart" type="button">Restart (R)</button>
      <p class="notice">Built by the Traumatic Studios local agents · no AI key used</p>
    </main>
    <script src="./game.js"></script>
  </body>
</html>
`,
    gameJs: `const CONFIG = ${config};\n${GAME_JS}`,
    gameCss: `body { margin: 0; background: ${plan.palette.bg}; color: #e8eef5; font: 15px system-ui, sans-serif; }
main { max-width: 500px; margin: 0 auto; padding: 16px; text-align: center; }
h1 { margin: 4px 0; font-size: 22px; color: ${plan.palette.player}; }
.how { margin: 0 0 10px; color: #a9b8c6; }
canvas { width: 100%; max-width: 480px; background: ${plan.palette.panel}; border: 1px solid #2c3a4a; border-radius: 8px; touch-action: none; }
#hud { font: 600 16px ui-monospace, monospace; margin: 8px 0 2px; }
#message { min-height: 20px; margin: 2px 0 10px; color: ${plan.palette.item}; }
button { padding: 8px 18px; border: 0; border-radius: 6px; background: ${plan.palette.player}; color: #04101a; font-weight: 700; cursor: pointer; }
.notice { margin-top: 14px; font-size: 11px; color: #728c9c; }
`,
  };
}

function tasksFor(plan) {
  return [
    { title: "Tune the difficulty curve", owner: "Game designer", description: `Playtest the ${plan.mode === "collect" ? "fall speed and miss penalty" : "hazard speed and spawn rate"} so the first win feels fair.` },
    { title: "Add sound and hit feedback", owner: "Gameplay engineer", description: "Add screen flash or particles on each catch or hit so the player feels every result." },
    { title: "Test controls and restart", owner: "QA tester", description: "Check keyboard, pointer and restart paths including win and loss states." },
    { title: "Define the next milestone", owner: "Producer", description: "Pick the next feature that moves the prototype toward the original brief." },
  ];
}

const NOTES = {
  "Game designer": "Design pass: write down the target session length, list one change to pacing, and playtest three runs after adjusting. Record what felt unfair.",
  "Gameplay engineer": "Engineering pass: keep the change inside game.js, add it behind a small function, and re-check restart still resets all state.",
  "QA tester": "QA checklist: arrow keys and A/D move the player; pointer drag works; win, loss and Restart/R/Enter all behave; the window resizing keeps the canvas visible.",
  Producer: "Producer pass: choose one deliverable for the next sprint, define its acceptance check, and cut anything that does not serve the core loop.",
};

// Local agents cannot rewrite code, so they leave an owner-specific plan on the task for a human to carry out.
async function runLocalTask(projectId, taskId) {
  const project = (await listProjects()).find((candidate) => candidate.id === projectId);
  if (!project) throw Object.assign(new Error("Project not found."), { code: "ENOENT" });
  const task = project.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("Task not found.");
  const note = `${NOTES[task.owner] || NOTES.Producer} (Task: ${task.title})`;
  const updated = await addTaskNote(projectId, taskId, note);
  return { project: updated, summary: note, review: "Local agents added a working plan to the task. Tick it off when you have done it.", local: true };
}

async function runLocalStudio(brief, emit, { projectsDir, memoryFile = getMemoryFile(), delay = 200 } = {}) {
  const plan = planFor(brief);
  const learnings = await readLearnings(memoryFile);
  const step = async (agent, name, stage, content) => {
    emit({ type: "agent-started", agent, name, stage });
    if (delay > 0) await pause(delay);
    emit({ type: "agent-completed", agent, name, stage, content });
    return content;
  };
  const say = (from, to, stage, message) => emit({ type: "team-message", from, to, stage, message });
  const themeWord = plan.theme;

  emit({ type: "studio-started", model: "local agents", memoryCount: learnings.length });
  const kickoff = await step("producer", "Producer", "kickoff",
    `Concept: "${plan.title}" — NOTE: no API key is set, so the local agents can only build a one-screen ${plan.mode === "collect" ? "catching" : "survival"} placeholder. Add an API key to build the game you actually described with the full AI pipeline (design doc, modular build, auto-testing). Brief: "${brief.slice(0, 160)}". First milestone: one playable level with a win, a loss and a restart.${learnings.length ? ` Applying ${learnings.length} saved studio lesson(s).` : ""}`);
  say("Producer", "Whole team", "Kickoff", kickoff);

  const [design, engineering] = await Promise.all([
    step("designer", "Game designer", "work", plan.mode === "collect"
      ? `Core loop: move, catch falling ${themeWord}s, avoid missing. Win at 12 catches; three misses ends the run. Controls: arrows or A/D, or drag the pointer.`
      : `Core loop: move and dodge falling hazards. Survive 30 seconds to win; three hits ends the run. Difficulty ramps with time.`),
    step("engineer", "Gameplay engineer", "work", "Plan: one canvas, a delta-time loop, rectangle/circle collision, keyboard and pointer input, and one reset() that restores all state. No external files or network."),
  ]);
  say("Game designer", "QA tester + Producer", "Design proposal", design);
  say("Gameplay engineer", "QA tester + Producer", "Engineering proposal", engineering);

  const review = await step("qa", "QA tester", "review",
    "Acceptance checklist: both input methods work, score and lives update, win and loss states are reachable, restart fully resets, the page has no console errors.");
  say("QA tester", "Producer + Whole team", "Plan review", review);

  const handoff = await step("producer", "Producer", "handoff",
    `Decision: ship "${plan.title}" as the first playable. Follow-up tasks are on the board with owners.`);
  say("Producer", "Whole team", "Decision + handoff", handoff);

  emit({ type: "agent-started", agent: "engineer", name: "Gameplay engineer", stage: "implementation" });
  const files = buildFiles(plan);
  const { files: validFiles, tasks } = validateProject({ ...files, tasks: tasksFor(plan) });
  const project = await saveProject(validFiles, tasks, projectsDir || path.join(__dirname, "projects"), "local");
  if (delay > 0) await pause(delay);
  emit({ type: "agent-completed", agent: "engineer", name: "Gameplay engineer", stage: "implementation", content: `Saved a playable prototype and ${project.tasks.length} owned follow-up tasks.` });
  emit({ type: "project-created", project });

  const buildReview = await step("qa", "QA tester", "implementation-review",
    "Source review: input handling, win/loss states and restart are present. Please play it in the preview; this is a manual checklist, not an automated test.");
  say("QA tester", "Producer + Whole team", "Build review", buildReview);

  emit({ type: "phase-started", phase: "learning", message: "Saving reusable studio learnings…" });
  const saved = await saveLearnings([
    "Ship one small playable with a win, a loss and a restart before adding features.",
    "Give every follow-up task a single owner and a checkable outcome.",
  ], memoryFile);
  emit({ type: "memory-updated", learnings: saved });
  emit({ type: "phase-completed", phase: "learning" });
  emit({ type: "studio-completed" });
}

module.exports = { planFor, runLocalStudio, runLocalTask };
