// Access gate for sharing the studio through a tunnel. The owner on this PC (direct localhost, no proxy headers) is never asked
// for a password; everyone else needs the shared password and gets a private, in-memory AI connection of their own.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { newVisitorStore } = require("./settings");

const COOKIE = "studio_sid";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const MIN_PASSWORD = 8;

const sessions = new Map();
const failures = new Map();

function getPassword() {
  if (process.env.STUDIO_ACCESS_PASSWORD) return process.env.STUDIO_ACCESS_PASSWORD;
  try {
    return fs.readFileSync(process.env.STUDIO_ACCESS_FILE || path.join(__dirname, "data", "access-password.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"];

// Only a direct local connection counts as the owner. A tunnel connects from localhost too, so proxy headers and a non-local Host disqualify it.
// Hosted builds have no owner at all: even a local connection must sign in, and nothing owner-only is reachable.
const hosted = () => process.env.STUDIO_HOSTED === "1";

function isOwner(request) {
  if (hosted()) return false;
  const address = request.socket.remoteAddress || "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const host = String(request.headers.host || "");
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  return loopback && localHost && !PROXY_HEADERS.some((name) => request.headers[name] !== undefined);
}

function clientId(request) {
  return String(request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] || request.socket.remoteAddress || "?").split(",")[0].trim();
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function passwordMatches(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function locked(key) {
  const entry = failures.get(key);
  return Boolean(entry && entry.count >= MAX_FAILS && entry.until > Date.now());
}

function recordFailure(key) {
  const entry = failures.get(key);
  const next = entry && entry.until > Date.now() ? { count: entry.count + 1, until: entry.until } : { count: 1, until: Date.now() + LOCK_MS };
  failures.set(key, next);
}

function sessionFor(request) {
  const sid = parseCookies(request.headers.cookie)[COOKIE];
  const entry = sid && sessions.get(sid);
  if (!entry) return null;
  if (Date.now() - entry.created > SESSION_MS) {
    sessions.delete(sid);
    return null;
  }
  return { sid, entry };
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_048) request.destroy();
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    request.on("error", () => resolve({}));
  });
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Traumatic Studios</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12131a;color:#eee;font-family:system-ui,sans-serif}form{width:min(92vw,340px);display:grid;gap:12px}h1{font-size:1.3rem;margin:0}input,button{padding:12px;border-radius:8px;border:1px solid #444;font-size:1rem}input{background:#1c1e29;color:#eee}button{background:#e0a458;border:0;font-weight:600;cursor:pointer}#msg{color:#ff8a8a;min-height:1.2em;font-size:.9rem}</style></head>
<body><form id="f"><h1>Traumatic Studios</h1><p>Enter the access password you were given.</p><input id="p" type="password" autocomplete="current-password" autofocus placeholder="Password"><button>Enter</button><div id="msg" role="alert"></div></form>
<script>document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();const m=document.getElementById("msg");m.textContent="";const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});if(r.ok)location.reload();else m.textContent=(await r.json().catch(()=>({}))).error||"Could not sign in.";});</script></body></html>`;

async function handleLogin(request, response, password) {
  const key = clientId(request);
  if (locked(key) || locked("*")) {
    json(response, 429, { error: "Too many attempts. Try again in a few minutes." });
    return;
  }
  const origin = request.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === request.headers.host; } catch { /* invalid origin */ }
    if (!sameOrigin) {
      json(response, 403, { error: "Cross-origin sign-in is not allowed." });
      return;
    }
  }
  const body = await readBody(request);
  if (typeof body.password !== "string" || !passwordMatches(body.password, password)) {
    recordFailure(key);
    recordFailure("*");
    json(response, 401, { error: "Wrong password." });
    return;
  }
  failures.delete(key);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, { created: Date.now(), store: newVisitorStore() });
  const secure = String(request.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  json(response, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
}

// Resolves to { owner, store } when the request may continue, or null when this already answered it.
async function authorize(request, response) {
  if (isOwner(request)) return { owner: true, store: null };
  const password = getPassword();
  if (password.length < MIN_PASSWORD) {
    json(response, 503, { error: "Remote access is disabled: the owner has not set an access password (8+ characters)." });
    return null;
  }
  const pathname = request.url.split("?")[0];
  if (request.method === "POST" && pathname === "/api/login") {
    await handleLogin(request, response, password);
    return null;
  }
  const found = sessionFor(request);
  if (!found) {
    if (request.method === "GET" && !pathname.startsWith("/api/")) {
      response.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(LOGIN_PAGE);
    } else {
      json(response, 401, { error: "Sign in required." });
    }
    return null;
  }
  if (request.method === "POST" && pathname === "/api/logout") {
    sessions.delete(found.sid);
    json(response, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    return null;
  }
  // These change shared state on the owner's machine, so only the owner may use them.
  const ownerOnly = (request.method === "POST" && pathname === "/api/research") || (request.method === "DELETE" && pathname.startsWith("/api/knowledge")) || (hosted() && request.method === "POST" && pathname === "/api/knowledge");
  if (ownerOnly) {
    json(response, 403, { error: "Only the studio owner can do that." });
    return null;
  }
  return { owner: false, store: found.entry.store };
}

const resetLimits = () => failures.clear();

module.exports = { authorize, hosted, isOwner, resetLimits, getPassword, MIN_PASSWORD };
