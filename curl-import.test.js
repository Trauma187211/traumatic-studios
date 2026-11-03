const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCurl } = require("./public/curl-import");

test("reads a Gemini native cURL quickstart", () => {
  const text = `curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" \\
  -H 'Content-Type: application/json' \\
  -H 'X-goog-api-key: AIzaSyExampleKey123456' \\
  -X POST -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`;
  assert.deepEqual(parseCurl(text), {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    key: "AIzaSyExampleKey123456",
    model: "gemini-flash-latest",
  });
});

test("reads an OpenAI-style cURL and ignores shell variables", () => {
  const text = `curl https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -d '{"model": "qwen/qwen3-coder:free"}'`;
  assert.deepEqual(parseCurl(text), { baseUrl: "https://openrouter.ai/api/v1", key: "", model: "qwen/qwen3-coder:free" });
});

test("reads a key from the query string and rejects text without an address", () => {
  assert.equal(parseCurl("curl 'https://example.com/v1/chat/completions?key=abc123XYZ'").key, "abc123XYZ");
  assert.throws(() => parseCurl("hello"), /No web address/);
});
