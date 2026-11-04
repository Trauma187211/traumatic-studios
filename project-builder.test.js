const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createPrototype,
  executeAssignedTask,
  getProjectAssetPath,
  listProjects,
  updateTask,
  validateProject,
} = require("./project-builder");

function validProject() {
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

test("rejects project output with external or dynamically executed code", () => {
  const unsafe = validProject();
  unsafe.gameJs += '\nfetch("https://example.invalid");';
  assert.throws(() => validateProject(unsafe), /prohibited external or dynamic code feature/);

  const broken = validProject();
  broken.gameJs = "function (";
  assert.throws(() => validateProject(broken), /failed its syntax check/);

  const badOwner = validProject();
  badOwner.tasks[0].owner = "Shell";
  assert.throws(() => validateProject(badOwner), /Follow-up task 1 is invalid/);

  const inlineScript = validProject();
  inlineScript.indexHtml = inlineScript.indexHtml.replace(
    '<script src="./game.js"></script>',
    "<script>alert(1)</script>",
  );
  const repaired = validateProject(inlineScript);
  assert.match(repaired.files["index.html"], /<script src="\.\/game\.js"><\/script>/);
  assert.doesNotMatch(repaired.files["game.js"], /alert\(1\)/);

  const malformedShell = validProject();
  malformedShell.indexHtml = '<html><body><h1>Play</h1><script>const duplicate = true;</script>';
  const normalized = validateProject(malformedShell);
  assert.match(normalized.files["index.html"], /href="\.\/game\.css"/);
  assert.match(normalized.files["index.html"], /src="\.\/game\.js"/);
  assert.match(normalized.files["index.html"], /<\/head>[\s\S]*<body>/);
  assert.doesNotMatch(normalized.files["index.html"], /const duplicate/);

  const oversized = validProject();
  oversized.gameCss = "x".repeat(24_001);
  assert.throws(() => validateProject(oversized), /24 KB per-file limit/);
});

test("creates a playable project, serves only allowlisted files, and persists task status", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-project-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  let requestOptions;
  global.fetch = async (_url, options) => {
    requestOptions = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(validProject()) } }],
      }),
    };
  };

  const project = await createPrototype("A tiny button game.", "Build one interaction.", { projectsDir });
  assert.equal(project.mode, "ai");
  assert.equal(requestOptions.response_format.type, "json_object");
  assert.equal(project.tasks.length, 3);
  assert.match(project.previewUrl, new RegExp(`^/games/${project.id}/index\\.html$`));
  assert.equal(
    await fs.readFile(path.join(projectsDir, project.id, "game.js"), "utf8"),
    validProject().gameJs,
  );
  assert.ok(getProjectAssetPath(project.id, "index.html", projectsDir));
  assert.equal(getProjectAssetPath(project.id, "..", projectsDir), null);
  assert.equal(getProjectAssetPath("../outside", "index.html", projectsDir), null);

  const updated = await updateTask(project.id, "task-1", "done", projectsDir);
  assert.equal(updated.tasks[0].status, "done");
  assert.equal((await listProjects(projectsDir))[0].tasks[0].status, "done");
  await assert.rejects(updateTask(project.id, "task-1", "running", projectsDir), /status must be todo, in_progress, or done/);
});

test("lets the task owner implement an assigned task and saves a validated update", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-task-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validProject()) } }] }),
  });

  const created = await createPrototype("A tiny button game.", "Add keyboard support.", { projectsDir });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Added keyboard input for the assigned feature.",
            gameJs: 'document.querySelector("#play").addEventListener("click", () => { document.body.dataset.played = "true"; });\ndocument.addEventListener("keydown", (event) => { if (event.key === "Enter") document.querySelector("#play").click(); });',
            gameCss: "body { background: #080c11; color: white; }",
          }),
        },
      }],
    }),
  });
  let implementationCalled = false;
  global.fetch = async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    if (messages[0].content.includes("independent QA reviewer")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ approved: true, findings: "Keyboard input is covered without removing mouse controls." }) } }],
        }),
      };
    }
    implementationCalled = true;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Added keyboard input for the assigned feature.",
              gameJs: 'document.querySelector("#play").addEventListener("click", () => { document.body.dataset.played = "true"; });\ndocument.addEventListener("keydown", (event) => { if (event.key === "Enter") document.querySelector("#play").click(); });',
              gameCss: "body { background: #080c11; color: white; }",
            }),
          },
        }],
      }),
    };
  };
  const result = await executeAssignedTask(created.id, "task-3", projectsDir);
  assert.equal(implementationCalled, true);
  assert.match(result.summary, /keyboard input/);
  assert.match(result.review, /Keyboard input is covered/);
  assert.equal(result.project.tasks[2].status, "done");
  assert.match(await fs.readFile(path.join(projectsDir, created.id, "game.js"), "utf8"), /keydown/);
  await assert.rejects(executeAssignedTask(created.id, "task-3", projectsDir), /Only a task marked todo/);
});

test("rejects unsafe bot task changes and leaves original source untouched", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-task-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validProject()) } }] }),
  });

  const created = await createPrototype("A tiny button game.", "Keep this safe.", { projectsDir });
  const originalSource = await fs.readFile(path.join(projectsDir, created.id, "game.js"), "utf8");
  global.fetch = async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const content = messages[0].content.includes("independent QA reviewer")
      ? JSON.stringify({ approved: true, findings: "Looks fine." })
      : JSON.stringify({
        summary: "Added an unsafe external network request.",
        gameJs: 'fetch("https://example.invalid");',
        gameCss: "body { color: white; }",
      });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  await assert.rejects(executeAssignedTask(created.id, "task-1", projectsDir), /prohibited external or dynamic code feature/);
  const project = (await listProjects(projectsDir))[0];
  assert.equal(project.tasks[0].status, "todo");
  assert.equal(await fs.readFile(path.join(projectsDir, created.id, "game.js"), "utf8"), originalSource);
});

test("does not save a syntactically valid change when QA rejects it", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-task-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validProject()) } }] }),
  });
  const created = await createPrototype("A tiny button game.", "Keep the game unchanged.", { projectsDir });
  const originalSource = await fs.readFile(path.join(projectsDir, created.id, "game.js"), "utf8");
  global.fetch = async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const content = messages[0].content.includes("independent QA reviewer")
      ? JSON.stringify({ approved: false, findings: "The proposed update does not implement the assigned feature." })
      : JSON.stringify({
        summary: "Renamed the button without implementing the task.",
        gameJs: 'document.querySelector("#play").textContent = "Start";',
        gameCss: validProject().gameCss,
      });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  await assert.rejects(
    executeAssignedTask(created.id, "task-1", projectsDir),
    /QA rejected the proposed change/,
  );
  assert.equal((await listProjects(projectsDir))[0].tasks[0].status, "todo");
  assert.equal(await fs.readFile(path.join(projectsDir, created.id, "game.js"), "utf8"), originalSource);
});

test("prevents two bots from editing the same project at the same time", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-task-test-"));
  const projectsDir = path.join(directory, "projects");
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validProject()) } }] }),
  });
  const created = await createPrototype("A tiny button game.", "Add a title.", { projectsDir });

  let releaseModel;
  let signalModelStarted;
  const modelStarted = new Promise((resolve) => { signalModelStarted = resolve; });
  const modelResponse = new Promise((resolve) => { releaseModel = resolve; });
  global.fetch = async (_url, options) => {
    signalModelStarted();
    const { messages } = JSON.parse(options.body);
    return messages[0].content.includes("independent QA reviewer") ? {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ approved: true, findings: "The code matches the task requirements." }) } }],
      }),
    } : modelResponse;
  };

  const firstRun = executeAssignedTask(created.id, "task-1", projectsDir);
  await modelStarted;
  await assert.rejects(executeAssignedTask(created.id, "task-2", projectsDir), /project is already being changed/);
  releaseModel({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Added a safe title update.",
            gameJs: validProject().gameJs,
            gameCss: validProject().gameCss,
          }),
        },
      }],
    }),
  });
  const result = await firstRun;
  assert.equal(result.project.tasks[0].status, "done");
});
