const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeModule, stripModuleSyntax, distance } = require("./module-sanitizer");

const api = { Engine: { start: "function", rng: "function", fx: ["burst", "text"] }, Kit: { tiles: ["move", "solid"], timer: ["make"], palettes: ["forest"] } };

test("strips import, export and module.exports", () => {
  const out = stripModuleSyntax("import x from 'y';\nexport function a() {}\nexport const b = 1;\nmodule.exports = { a };\nexport default a;");
  assert.doesNotMatch(out, /\b(import|export|module\.exports)\b/);
  assert.match(out, /function a\(\)/);
  assert.match(out, /const b = 1/);
});

test("rewrites invented Kit names to the closest real ones", () => {
  const { code, changes } = sanitizeModule("const m = Kit.tilemap.move(a, 1);\nEngine.start({});", api);
  assert.match(code, /Kit\.tiles\.move/);
  assert.ok(changes.length > 0);
});

test("leaves valid code and assignments untouched", () => {
  const src = "Kit.custom = 5;\nEngine.fx.burst(1, 2);\nconst t = Kit.timer.make(3);";
  const { code, changes } = sanitizeModule(src, api);
  assert.equal(code, src);
  assert.deepEqual(changes, []);
});

test("distance is a Levenshtein distance", () => {
  assert.equal(distance("kitten", "sitting"), 3);
});
