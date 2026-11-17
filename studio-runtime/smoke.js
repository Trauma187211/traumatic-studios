const { fork, spawnSync } = require("node:child_process");
const path = require("node:path");

const CHILD = path.join(__dirname, "smoke-child.js");
const childEnv = () => ({ PATH: process.env.PATH || "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
const skipped = () => String(process.env.STUDIO_SMOKE || "").toLowerCase() === "off";

function judge(r, { frames, minCalls, minPlayRatio }) {
  const errors = [...(r.errors || [])];
  if (!errors.length && r.mode === "title") errors.push("The game never left the title screen after pressing Enter.");
  if (!errors.length && r.playFrames < frames * minPlayRatio) errors.push("The game stopped running soon after starting.");
  if (!errors.length && minCalls > 0 && r.callsPerPlayFrame < minCalls) errors.push("The game draws almost nothing while playing (it looks blank).");
  return { ...r, ok: errors.length === 0, errors };
}

function options(o = {}) {
  const frames = o.frames || 300;
  return { frames, width: o.width || 800, height: o.height || 600, timeoutMs: o.timeoutMs || Math.max(20000, frames * 12), minCalls: o.minCalls === undefined ? 4 : o.minCalls, minPlayRatio: o.minPlayRatio === undefined ? 0.25 : o.minPlayRatio };
}

/** Plays a generated game.js headlessly in an isolated child process. Never throws; resolves { ok, errors, ... }. */
function smokeRun(gameJs, o = {}) {
  const opt = options(o);
  if (skipped()) return Promise.resolve({ ok: true, errors: [], mode: "skipped" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve(result); } };
    const child = fork(CHILD, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: childEnv(), execArgv: [], windowsHide: true });
    const timer = setTimeout(() => done({ ok: false, errors: ["The game hung or ran too slowly in the smoke test."], mode: "timeout" }), opt.timeoutMs);
    child.on("message", (r) => done(judge(r, opt)));
    child.on("error", (e) => done({ ok: false, errors: [`Smoke test could not start: ${e.message}`], mode: "error" }));
    child.on("exit", () => done({ ok: false, errors: ["Smoke test exited without a result."], mode: "exit" }));
    child.send({ code: gameJs, frames: opt.frames, width: opt.width, height: opt.height, idle: !!o.idle });
  });
}

/** Same test, synchronous (blocks until done). Used by smokeTest(), which callers expect to return immediately. */
function smokeRunSync(gameJs, o = {}) {
  const opt = options(o);
  if (skipped()) return { ok: true, errors: [], mode: "skipped" };
  const run = spawnSync(process.execPath, [CHILD, "--stdin"], {
    input: JSON.stringify({ code: gameJs, frames: opt.frames, width: opt.width, height: opt.height, idle: !!o.idle }),
    encoding: "utf8", timeout: opt.timeoutMs, env: childEnv(), windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  if (run.error) return { ok: false, errors: [run.error.code === "ETIMEDOUT" ? "The game hung or ran too slowly in the smoke test." : `Smoke test could not start: ${run.error.message}`], mode: "error" };
  try { return judge(JSON.parse(run.stdout), opt); } catch { return { ok: false, errors: ["Smoke test exited without a result."], mode: "exit" }; }
}

module.exports = { smokeRun, smokeRunSync };
