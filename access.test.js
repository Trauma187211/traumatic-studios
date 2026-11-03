const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { server } = require("./server");
require("./settings").enableKeylessDefault();

// Simulates a tunnel: same loopback socket, but with the proxy headers a real tunnel adds.
function request(port, { method = "GET", path = "/api/status", headers = {}, body, remote = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path,
      headers: { ...(remote ? { "cf-connecting-ip": "203.0.113.7", "x-forwarded-proto": "https" } : {}), ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("remote visitors need the password and never inherit the owner's API key", async (context) => {
  const saved = { key: process.env.OPENAI_API_KEY, pass: process.env.STUDIO_ACCESS_PASSWORD, file: process.env.STUDIO_ACCESS_FILE };
  process.env.OPENAI_API_KEY = "owner-secret-key-0000000000";
  delete process.env.STUDIO_ACCESS_PASSWORD;
  process.env.STUDIO_ACCESS_FILE = "Z:\\does-not-exist\\none.txt";
  context.after(async () => {
    for (const [name, value] of [["OPENAI_API_KEY", saved.key], ["STUDIO_ACCESS_PASSWORD", saved.pass], ["STUDIO_ACCESS_FILE", saved.file]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const owner = await request(port, { remote: false });
  assert.equal(owner.status, 200);
  assert.equal(owner.json().keySource, "environment");

  // No password configured: remote access is refused outright.
  assert.equal((await request(port)).status, 503);

  process.env.STUDIO_ACCESS_PASSWORD = "correct horse battery";
  const page = await request(port, { path: "/" });
  assert.equal(page.status, 401);
  assert.match(page.text, /access password/);
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { method: "POST", path: "/api/run", body: { brief: "a long enough brief to pass" } })).status, 401);
  assert.equal((await request(port, { method: "POST", path: "/api/login", body: { password: "wrong" } })).status, 401);

  const login = await request(port, { method: "POST", path: "/api/login", body: { password: "correct horse battery" } });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const auth = { cookie: cookie.split(";")[0] };

  const visitor = (await request(port, { headers: auth })).json();
  assert.equal(visitor.visitor, true);
  assert.equal(visitor.keySource, "none");
  assert.equal(visitor.keyless, true);

  assert.equal((await request(port, { method: "POST", path: "/api/research", headers: auth, body: { enabled: false } })).status, 403);
  assert.equal((await request(port, { method: "DELETE", path: "/api/knowledge/abc", headers: auth })).status, 403);

  // A visitor clearing or setting their own connection leaves the owner's untouched.
  assert.equal((await request(port, { method: "DELETE", path: "/api/settings/key", headers: auth })).status, 200);
  const rejected = await request(port, { method: "POST", path: "/api/settings/key", headers: auth, body: { apiKey: "x".repeat(24), baseUrl: "http://127.0.0.1:11434/v1", model: "m" } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json().error, /public https/);
  assert.equal((await request(port, { remote: false })).json().keySource, "environment");
});

test("repeated wrong passwords are locked out", async (context) => {
  const saved = process.env.STUDIO_ACCESS_PASSWORD;
  process.env.STUDIO_ACCESS_PASSWORD = "another good password";
  context.after(async () => {
    if (saved === undefined) delete process.env.STUDIO_ACCESS_PASSWORD; else process.env.STUDIO_ACCESS_PASSWORD = saved;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const headers = { "cf-connecting-ip": "198.51.100.9" };
  let last;
  for (let i = 0; i < 6; i++) last = await request(port, { method: "POST", path: "/api/login", headers, body: { password: `nope${i}` } });
  assert.equal(last.status, 429);
  const right = await request(port, { method: "POST", path: "/api/login", headers, body: { password: "another good password" } });
  assert.equal(right.status, 429);
});
