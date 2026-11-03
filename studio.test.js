process.env.STUDIO_ENGINE = "web";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runStudio } = require("./studio");
const { readLearnings } = require("./memory-store");

function prototypeResponse() {
  return {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="./game.css"></head><body><button id="play">Play</button><script src="./game.js"></script></body></html>',
    gameJs: 'document.querySelector("#play").addEventListener("click", () => { document.body.dataset.played = "true"; });',
    gameCss: "body { background: #080c11; color: white; }",
    tasks: [
      { title: "Add a title screen", owner: "Game designer", description: "Define the title screen copy and button flow." },
      { title: "Add a sound toggle", owner: "Gameplay engineer", description: "Add a user-controlled sound on and off switch." },
      { title: "Check keyboard controls", owner: "QA tester", description: "Verify the game is playable without a mouse." },
    ],
  };
}

test("runs the shared kickoff, parallel specialists, QA review, and producer handoff", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  const memoryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-studio-test-"));
  const memoryFile = path.join(memoryDirectory, "studio-memory.json");
  const projectsDir = path.join(memoryDirectory, "projects");
  context.after(() => fs.rm(memoryDirectory, { recursive: true, force: true }));

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    calls.push(prompt);
    const content = body.response_format
      ? JSON.stringify(prototypeResponse())
      : prompt.includes("Extract only lessons")
        ? JSON.stringify({ learnings: ["Keep the first playable milestone small and testable."] })
        : `Reply ${calls.length}`;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
  context.after(() => { global.fetch = originalFetch; });

  const events = [];
  await runStudio("A tiny game about a moon garden.", (event) => events.push(event), { memoryFile, projectsDir });

  assert.equal(calls.length, 11);
  assert.match(calls[1], /Producer's shared kickoff:\nReply 1/);
  assert.match(calls[2], /Producer's shared kickoff:\nReply 1/);
  assert.ok(calls[3].includes("Game designer's proposal:\nReply"));
  assert.ok(calls[3].includes("Gameplay engineer's proposal:\nReply"));
  assert.ok(calls[4].includes("QA review:\nReply"));
  assert.ok(events.some((event) => event.type === "studio-completed"));
  const teamMessages = events.filter((event) => event.type === "team-message");
  assert.deepEqual(teamMessages.map(({ stage }) => stage), [
    "Kickoff",
    "Design proposal",
    "Engineering proposal",
    "Plan review",
    "Decision + handoff",
    "Build review",
  ]);
  assert.equal(teamMessages[0].from, "Producer");
  assert.equal(teamMessages[1].to, "QA tester + Producer");
  assert.match(teamMessages[1].message, /Reply/);
  assert.ok(teamMessages.every(({ message }) => message.length <= 520));
  assert.deepEqual((await readLearnings(memoryFile)).map(({ lesson }) => lesson), [
    "Keep the first playable milestone small and testable.",
  ]);

  const startedSpecialists = events
    .filter((event) => event.type === "agent-started" && event.stage === "work")
    .map((event) => event.agent);
  assert.deepEqual(startedSpecialists, ["designer", "engineer"]);
});

test("carries specialist disagreements through QA into the playable handoff", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-collaboration-test-"));
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const prompts = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    prompts.push(prompt);

    const content = body.response_format
      ? JSON.stringify(prototypeResponse())
      : prompt.includes("Extract only lessons")
        ? JSON.stringify({ learnings: ["Resolve control disagreements before implementation."] })
        : prompt.includes("QA review:")
          ? "Handoff decision: support both pointer and keyboard controls; QA must test each input path."
        : prompt.includes("Game designer's proposal:")
          ? "QA finding: the proposed pointer-only and keyboard-only controls conflict. Support both and test each."
          : prompt.includes("Review the producer plan")
            ? "Game designer: pointer controls only. Gameplay engineer: keyboard controls only."
            : prompt.includes("Design the moment-to-moment")
              ? "Use pointer controls only."
              : prompt.includes("Propose a practical technical implementation")
                ? "Use keyboard controls only."
                : "Plan a small prototype and make assumptions explicit.";

    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };

  const events = [];
  await runStudio(
    "A puzzle game that should work with both mouse and keyboard.",
    (event) => events.push(event),
    {
      memoryFile: path.join(directory, "studio-memory.json"),
      projectsDir: path.join(directory, "projects"),
    },
  );

  const qaPrompt = prompts.find((prompt) => prompt.includes("Game designer's proposal:"));
  assert.match(qaPrompt, /Game designer's proposal:\nUse pointer controls only\./);
  assert.match(qaPrompt, /Gameplay engineer's proposal:\nUse keyboard controls only\./);

  const handoffPrompt = prompts.find((prompt) => prompt.includes("QA review:"));
  assert.match(handoffPrompt, /QA finding: the proposed pointer-only and keyboard-only controls conflict/);
  assert.match(handoffPrompt, /Resolve contradictions explicitly/);

  const implementationPrompt = prompts.find((prompt) => prompt.includes("Approved handoff:"));
  assert.match(implementationPrompt, /support both pointer and keyboard controls/);
  assert.ok(events.some((event) =>
    event.type === "team-message"
    && event.stage === "Decision + handoff"
    && /support both pointer and keyboard controls/.test(event.message),
  ));
  assert.ok(events.some((event) => event.type === "studio-completed"));
});

test("shares saved studio learning with agents on the next sprint", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const memoryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-studio-test-"));
  const memoryFile = path.join(memoryDirectory, "studio-memory.json");
  const projectsDir = path.join(memoryDirectory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(memoryDirectory, { recursive: true, force: true });
  });

  const { saveLearnings } = require("./memory-store");
  await saveLearnings(["Keep each prototype milestone small and testable."], memoryFile);
  const prompts = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    prompts.push(prompt);
    const content = body.response_format
      ? JSON.stringify(prototypeResponse())
      : prompt.includes("Extract only lessons")
        ? JSON.stringify({ learnings: ["Write acceptance criteria before implementing new gameplay systems."] })
        : `Reply ${prompts.length}`;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  await runStudio("A small game about a clockwork forest.", () => {}, { memoryFile, projectsDir });

  assert.match(prompts[0], /Keep each prototype milestone small and testable/);
  assert.match(prompts[1], /Keep each prototype milestone small and testable/);
});

test("surfaces model errors instead of returning a successful empty result", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "Invalid API key",
  });
  context.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  await assert.rejects(
    runStudio("A tiny game about a moon garden.", () => {}),
    /Model request failed \(401\)/,
  );
});
