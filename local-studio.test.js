const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { runLocalStudio } = require("./local-studio");
const { listProjects } = require("./project-builder");
const { clearApiKey, getApiKey, setApiKey } = require("./settings");

test("local agents run the full sprint without an API key and save a playable project", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-studio-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [];
  await runLocalStudio("Dodge falling meteors as a tiny space courier", (event) => events.push(event), {
    projectsDir: path.join(directory, "projects"),
    memoryFile: path.join(directory, "memory.json"),
    delay: 0,
  });

  assert.equal(events.at(-1).type, "studio-completed");
  assert.ok(events.some((event) => event.type === "memory-updated"));
  const [project] = await listProjects(path.join(directory, "projects"));
  assert.equal(project.mode, "local");
  assert.equal(project.tasks.length, 4);
  const js = await fs.readFile(path.join(directory, "projects", project.id, "game.js"), "utf8");
  assert.match(js, /"mode":"dodge"/);
  new vm.Script(js);
});

test("bring-your-own key is stored per session and can be removed", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "settings-"));
  process.env.STUDIO_SETTINGS_PATH = path.join(directory, "settings.json");
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  context.after(async () => {
    clearApiKey();
    delete process.env.STUDIO_SETTINGS_PATH;
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const key = "sk-test-0123456789abcdefghij";
  const status = await setApiKey({ apiKey: key, model: "gpt-4o" }, { verify: false });
  assert.deepEqual(status, { configured: true, model: "gpt-4o", keySource: "session", keyless: false });
  assert.equal(getApiKey(), key);
  await assert.rejects(() => setApiKey({ apiKey: "bad key" }, { verify: false }), /API key/);
  await assert.rejects(() => fs.access(process.env.STUDIO_SETTINGS_PATH));

  await setApiKey({ apiKey: key, remember: true }, { verify: false });
  assert.match(await fs.readFile(process.env.STUDIO_SETTINGS_PATH, "utf8"), /sk-test/);
  assert.equal(clearApiKey().configured, false);
  await assert.rejects(() => fs.access(process.env.STUDIO_SETTINGS_PATH));
});
