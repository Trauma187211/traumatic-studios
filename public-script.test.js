const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("the browser script parses, so the page controls keep working", () => {
  const source = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(source, { filename: "app.js" }));
  assert.match(source, /fetch\("\/api\/status"\)/);
});
