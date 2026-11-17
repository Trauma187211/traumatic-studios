/* Runs one generated game headlessly inside a fresh vm context, then reports back to the parent. */
const vm = require("node:vm");

const PRELUDE = `
var __handlers = {}, __raf = null, __stats = { calls: 0 };
function __on(type, fn) { (__handlers[type] = __handlers[type] || []).push(fn); }
var __fn = function () { __stats.calls++; };
var __gradient = { addColorStop: function () {} };
var __makeGradient = function () { __stats.calls++; return __gradient; };
var __measure = function (s) { return { width: String(s).length * 7 }; };
var __ctx = new Proxy({}, {
  get: function (t, k) {
    if (k in t) return t[k];
    if (k === "createLinearGradient" || k === "createRadialGradient") return __makeGradient;
    if (k === "measureText") return __measure;
    return __fn;
  },
  set: function (t, k, v) { t[k] = v; return true; }
});
var __canvas = { width: __W, height: __H, style: {}, getContext: function () { return __ctx; }, addEventListener: __on,
  getBoundingClientRect: function () { return { left: 0, top: 0, width: __W, height: __H }; } };
var window = globalThis;
var console = { error: function () {}, log: function () {}, warn: function () {}, info: function () {} };
var __now = 0;
var document = { getElementById: function () { return __canvas; }, querySelector: function () { return __canvas; }, createElement: function () { return __canvas; },
  body: { appendChild: function () {}, style: {} }, documentElement: { style: {} }, addEventListener: __on, removeEventListener: function () {}, readyState: "complete", title: "" };
globalThis.addEventListener = __on; globalThis.removeEventListener = function () {};
globalThis.requestAnimationFrame = function (cb) { __raf = cb; return 1; };
globalThis.cancelAnimationFrame = function () {};
globalThis.setTimeout = function () { return 1; }; globalThis.clearTimeout = function () {};
globalThis.setInterval = function () { return 1; }; globalThis.clearInterval = function () {};
globalThis.performance = { now: function () { return __now; } };
globalThis.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.navigator = { userAgent: "smoke", getGamepads: function () { return []; } };
globalThis.innerWidth = __W; globalThis.innerHeight = __H; globalThis.devicePixelRatio = 1;
globalThis.Image = function () { this.width = 1; this.height = 1; };
globalThis.Audio = function () { this.play = function () {}; this.pause = function () {}; };
`;

const DRIVE = `
(function () {
  function fire(type, ev) { (__handlers[type] || []).forEach(function (h) { h(ev); }); }
  function key(code, down) { fire(down ? "keydown" : "keyup", { code: code, key: code, preventDefault: function () {} }); }
  var t = 1000, playCalls = 0, playFrames = 0, held = [], errors = [], hasGame = typeof Game !== "undefined" && !!Game && Array.isArray(Game.errors), i;
  var moved = 0, lastPos = null, seenPlayer = false, hudMax = 0, firstPos = null;
  var combos = [["KeyW"], ["KeyD"], ["KeyS"], ["KeyA"], ["ArrowLeft"], ["ArrowRight"], ["KeyW", "Space"], ["ArrowUp", "KeyD"]];
  for (i = 0; i < __FRAMES; i++) {
    if (!__raf) break;
    if (i === 2) { key("Enter", true); key("Enter", false); }
    if (!__IDLE && i > 4 && i % 20 === 5) {
      held.forEach(function (c) { key(c, false); });
      held = combos[Math.floor(i / 20) % combos.length];
      held.forEach(function (c) { key(c, true); });
      if (i % 40 === 5) { fire("pointerdown", { clientX: 200, clientY: 200 }); fire("pointermove", { clientX: 260, clientY: 215 }); fire("pointerup", {}); }
    }
    var before = __stats.calls, cb = __raf; __raf = null; t += 16.7; __now = t;
    try { cb(t); } catch (e) { errors.push(String((e && e.message) || e)); if (errors.length >= 3) break; }
    if (!hasGame || Game.mode === "play") { playCalls += __stats.calls - before; playFrames++; }
    if (hasGame && Game.mode === "play") {
      if (Game.hud && Game.hud.length > hudMax) hudMax = Game.hud.length;
      var pl = Game.player;
      if (pl && typeof pl.x === "number") {
        seenPlayer = true;
        var cx = pl.x, cy = pl.z !== undefined ? pl.z : pl.y;
        if (lastPos) moved += Math.sqrt((cx - lastPos[0]) * (cx - lastPos[0]) + (cy - lastPos[1]) * (cy - lastPos[1]));
        lastPos = [cx, cy];
      }
    }
  }
  if (hasGame) errors = errors.concat(Game.errors.slice(0, 5));
  return JSON.stringify({ errors: errors.slice(0, 5), mode: hasGame ? Game.mode : "unknown", frames: i, playFrames: playFrames, callsPerPlayFrame: playFrames ? playCalls / playFrames : 0,
    moved: moved, hasPlayer: seenPlayer, playerBy: hasGame ? Game.playerBy : "", endInfo: hasGame ? Game.endInfo : null, hudMax: hudMax, score: hasGame ? Game.score : 0 });
})();
`;

function runGame(msg) {
  let result;
  try {
    const context = vm.createContext(Object.create(null));
    const head = `var __W = ${Number(msg.width) || 800}, __H = ${Number(msg.height) || 600}, __FRAMES = ${Number(msg.frames) || 300}, __IDLE = ${msg.idle ? "true" : "false"};` + PRELUDE;
    vm.runInContext(head, context, { timeout: 2000 });
    vm.runInContext(String(msg.code), context, { timeout: 3000, filename: "game.js" });
    result = JSON.parse(vm.runInContext(DRIVE, context, { timeout: Math.max(10000, Number(msg.frames || 300) * 30) }));
  } catch (error) {
    const message = String(error && error.message || error);
    // a harness timeout is not the game's fault, so it is reported as a timeout (and retried), not as a crash
    result = { errors: [`Smoke test crashed: ${message.slice(0, 200)}`], mode: /timed out/i.test(message) ? "timeout" : "crashed", frames: 0, playFrames: 0, callsPerPlayFrame: 0 };
  }
  return result;
}

if (process.argv.includes("--stdin")) {
  // Synchronous mode: the parent used spawnSync and sends the job on stdin.
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => {
    let msg = {};
    try { msg = JSON.parse(data); } catch { /* an empty job reports a crash below */ }
    process.stdout.write(JSON.stringify(runGame(msg)));
  });
} else {
  process.on("message", (msg) => { process.send(runGame(msg), () => process.exit(0)); });
}
