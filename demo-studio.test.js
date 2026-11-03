const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { runDemoStudio } = require("./demo-studio");
const { readProjectSources, validateProject } = require("./project-builder");

test("runs a labeled no-key demo sprint and writes a playable sample without model requests", async (context) => {
  const originalFetch = global.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-demo-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });
  global.fetch = async () => {
    throw new Error("Offline demo must not make model requests.");
  };

  const events = [];
  await runDemoStudio(
    "A tiny game about stars and moon gardens.",
    (event) => events.push(event),
    { projectsDir, delay: 0 },
  );

  assert.equal(events[0].type, "studio-started");
  assert.equal(events[0].demo, true);
  assert.ok(events.every((event) => event.demo || ["phase-started", "phase-completed", "studio-completed"].includes(event.type)));
  assert.ok(events.some((event) => event.type === "team-message" && event.stage.includes("DEMO")));
  assert.ok(events.some((event) => event.type === "studio-completed" && event.demo));

  const created = events.find((event) => event.type === "project-created").project;
  assert.equal(created.mode, "demo");
  const sources = await readProjectSources(created.id, projectsDir);
  const validated = validateProject({
    indexHtml: sources["index.html"],
    gameJs: sources["game.js"],
    gameCss: sources["game.css"],
    tasks: created.tasks,
  });
  assert.match(validated.files["game.js"], /requestAnimationFrame/);
  assert.match(validated.files["game.js"], /keys\.add\(event\.key\.toLowerCase\(\)\)/);
  assert.match(validated.files["game.js"], /keys\.has\("arrowleft"\)/);
  assert.match(validated.files["game.js"], /keys\.has\("arrowright"\)/);
  assert.match(validated.files["game.js"], /scoreLabel\.textContent = "STARS 0 \/ " \+ stars\.length/);
  assert.match(validated.files["game.js"], /STAR MISSED! PRESS RESTART TO TRY AGAIN/);
  assert.match(validated.files["index.html"], /Offline demo/);
  assert.equal(created.tasks.length, 3);

  const listeners = new Map();
  let nextFrame;
  let drawnMessage = "";
  let playerX;
  let drawnStars = [];
  const scoreLabel = { textContent: "" };
  const restartButton = { addEventListener: (type, callback) => listeners.set(`restart:${type}`, callback) };
  const canvasContext = {
    clearRect() { drawnMessage = ""; drawnStars = []; },
    fillRect(x, y, width) { if (y === 326 && width === 54) playerX = x + width / 2; },
    beginPath() {},
    arc(x, y, radius) { if (radius === 5) drawnStars.push({ x, y }); },
    fill() {},
    fillText(message) { drawnMessage = message; },
  };
  const canvas = {
    width: 640,
    height: 360,
    getContext: () => canvasContext,
  };
  const elements = { "#game": canvas, "#score": scoreLabel, "#restart": restartButton };
  const document = {
    querySelector: (selector) => elements[selector],
    addEventListener: (type, callback) => listeners.set(type, callback),
  };

  vm.runInNewContext(validated.files["game.js"], {
    document,
    requestAnimationFrame: (callback) => { nextFrame = callback; return 1; },
    cancelAnimationFrame() {},
  });
  for (let frame = 0; frame < 500 && !drawnMessage.startsWith("STAR MISSED!"); frame += 1) {
    const advance = nextFrame;
    assert.equal(typeof advance, "function");
    nextFrame = undefined;
    advance();
  }
  assert.match(drawnMessage, /^STAR MISSED!/);
  listeners.get("restart:click")();
  assert.equal(scoreLabel.textContent, "STARS 0 / 8");
  assert.equal(drawnMessage, "");

  let heldKey;
  for (let frame = 0; frame < 600 && scoreLabel.textContent !== "STARS 8 / 8"; frame += 1) {
    const target = drawnStars.reduce((lowest, star) => star.y > lowest.y ? star : lowest, drawnStars[0]);
    assert.ok(target, "the game should keep drawing a star until the win state");
    const nextKey = target.x - playerX > 3 ? "d" : target.x - playerX < -3 ? "a" : null;
    if (heldKey !== nextKey) {
      if (heldKey) listeners.get("keyup")({ key: heldKey });
      if (nextKey) listeners.get("keydown")({ key: nextKey });
      heldKey = nextKey;
    }
    const advance = nextFrame;
    assert.equal(typeof advance, "function");
    nextFrame = undefined;
    advance();
  }
  assert.equal(scoreLabel.textContent, "STARS 8 / 8");
  assert.match(drawnMessage, /^SALVAGED!/);
});
