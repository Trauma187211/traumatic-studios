const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const SOURCE = `${read("studio-engine.js")}\n${read("studio-kit.js")}\n${read("studio-blueprints.js")}\n`;

// Runs a blueprint game headlessly so a test (or bot) can press keys, step frames and read the game state.
function headless(spec, size = { width: 800, height: 560 }) {
  const ctxStub = new Proxy(function () {}, {
    get: (_t, name) => (name === "measureText" ? () => ({ width: 10 }) : name === "createLinearGradient" || name === "createRadialGradient" ? () => ({ addColorStop() {} }) : ctxStub),
    set: () => true,
    apply: () => ctxStub,
  });
  const element = () => ({ textContent: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, blur() {}, focus() {}, innerHTML: "" });
  const canvasStub = { ...element(), width: size.width, height: size.height, getContext: () => ctxStub, getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height }) };
  const listeners = {};
  const frames = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, Array, Object, Number, String, Map, Set, Proxy, Promise, Symbol, Uint8Array, Float32Array, Int32Array, Uint32Array,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    document: { getElementById: (id) => (id === "game" ? canvasStub : element()), querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(), addEventListener() {}, body: element() },
    AudioContext: undefined,
  };
  sandbox.window = Object.assign(sandbox, { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 });
  const context = vm.createContext(sandbox);
  new vm.Script(`${SOURCE}\nBlueprint.run(${JSON.stringify(spec)});`).runInContext(context, { timeout: 5000 });
  const fire = (type, key) => (listeners[type] || []).forEach((fn) => fn({ key, preventDefault() {} }));
  const down = new Set();
  let clock = 0;
  return {
    run: (code) => vm.runInContext(code, context),
    state: () => vm.runInContext("Blueprint.debug.state()", context),
    debug: () => vm.runInContext("Blueprint.debug", context),
    hold(keys) {
      for (const k of [...down]) if (!keys.includes(k)) { fire("keyup", k); down.delete(k); }
      for (const k of keys) if (!down.has(k)) { fire("keydown", k); down.add(k); }
    },
    tap(key) { fire("keydown", key); fire("keyup", key); },
    step(count = 1) { for (let i = 0; i < count; i++) { clock += 17; const pending = frames.splice(0); for (const fn of pending) fn(clock); } },
  };
}

module.exports = { headless };
