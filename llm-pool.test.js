const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.STUDIO_SETTINGS_PATH = require("node:path").join(require("node:os").tmpdir(), `pool-settings-${process.pid}.json`);
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

let ollamaMode = "busy";
const fakeOllama = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "gemma:latest" }, { name: "qwen2.5-coder:7b" }] }));
  req.resume();
  req.on("end", () => {
    if (ollamaMode === "busy") { res.statusCode = 503; return res.end("busy"); }
    res.end(JSON.stringify({ choices: [{ message: { content: "from ollama" } }] }));
  });
});

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => text, clone() { return this; } });

test("keyless mode prefers local Ollama, fails over to Pollinations, and uses Ollama when healthy", async (context) => {
  await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
  context.after(() => fakeOllama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${fakeOllama.address().port}`;
  const { enableKeylessDefault, refreshOllama, keylessPool } = require("./settings");
  const { llmFetch } = require("./llm");
  const realFetch = global.fetch;
  const hosted = [];
  global.fetch = async (url, options) => {
    if (String(url).includes("127.0.0.1")) return realFetch(url, options);
    hosted.push(String(url));
    return ok("from pollinations");
  };
  context.after(() => { global.fetch = realFetch; });

  enableKeylessDefault();
  await refreshOllama({ force: true });
  assert.equal(keylessPool()[0].model, "qwen2.5-coder:7b");

  ollamaMode = "busy";
  let response = await llmFetch({ body: JSON.stringify({ model: "x", messages: [] }) });
  assert.equal((await response.json()).choices[0].message.content, "from pollinations");
  assert.equal(hosted.length, 1);

  ollamaMode = "ok";
  response = await llmFetch({ body: JSON.stringify({ model: "x", messages: [] }) });
  assert.equal((await response.json()).choices[0].message.content, "from ollama");
  assert.equal(hosted.length, 1, "healthy Ollama never touches the hosted provider");
});

test("pool is Pollinations alone when Ollama is absent", async () => {
  const { refreshOllama, keylessPool } = require("./settings");
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("connection refused"); };
  try {
    await refreshOllama({ force: true });
    assert.equal(keylessPool().length, 1);
  } finally {
    global.fetch = realFetch;
  }
});
