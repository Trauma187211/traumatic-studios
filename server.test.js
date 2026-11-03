const test = require("node:test");
const assert = require("node:assert/strict");
const { server } = require("./server");

test("reports demo availability and rejects malformed or out-of-range sprint briefs", async (context) => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  context.after(async () => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const statusResponse = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    configured: false,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    keySource: "none",
    demoAvailable: true,
    localAvailable: true,
  });

  const badBriefs = [
    { brief: "short" },
    { brief: "x".repeat(2_001) },
    { brief: 42 },
    null,
  ];
  for (const brief of badBriefs) {
    const response = await fetch(`${baseUrl}/api/demo-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brief),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /brief must be between 10 and 2,000 characters/);
  }

  const malformedResponse = await fetch(`${baseUrl}/api/demo-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformedResponse.status, 400);
  assert.match((await malformedResponse.json()).error, /valid JSON/);

  const liveResponse = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "short" }),
  });
  assert.equal(liveResponse.status, 400);

  const badKey = await fetch(`${baseUrl}/api/settings/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "not a key" }),
  });
  assert.equal(badKey.status, 400);
  assert.match((await badKey.json()).error, /does not look like an API key/);

  const crossOrigin = await fetch(`${baseUrl}/api/settings/key`, {
    method: "DELETE",
    headers: { Origin: "http://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
});
