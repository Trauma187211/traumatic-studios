const test = require("node:test");
const assert = require("node:assert/strict");
const { listModels } = require("./settings");

test("lists, cleans and sorts models from a compatible provider", async () => {
  const original = global.fetch;
  let seen;
  global.fetch = async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify({ data: [{ id: "models/gemini-b" }, { id: "gemini-a" }, { id: "gemini-a" }, { id: "bad name!" }] }), { status: 200 });
  };
  try {
    const models = await listModels({ apiKey: "AIza-test-key-123456", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
    assert.deepEqual(models, ["gemini-a", "gemini-b"]);
    assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/openai/models");
    assert.ok(seen.options.headers.Authorization);
  } finally {
    global.fetch = original;
  }
});

test("rejects unsafe addresses, bad keys and providers without a model list", async () => {
  const original = global.fetch;
  try {
    await assert.rejects(listModels({ apiKey: "", baseUrl: "http://example.com/v1" }), /https/);
    await assert.rejects(listModels({ apiKey: "bad key", baseUrl: "" }), /API key/);
    global.fetch = async () => new Response("{}", { status: 404 });
    await assert.rejects(listModels({ apiKey: "", baseUrl: "https://example.com/v1" }), /does not offer a model list/);
    global.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(listModels({ apiKey: "", baseUrl: "https://example.com/v1" }), /rejected/);
  } finally {
    global.fetch = original;
  }
});
