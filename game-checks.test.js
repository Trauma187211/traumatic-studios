const assert = require("node:assert/strict");
const test = require("node:test");
const { codeProblems, styleAdvice } = require("./game-generator");

test("prohibited-code check names the offending text and ignores comments", () => {
  assert.equal(codeProblems("// see https://example.com\n/* import x */\nlet a = 1;").length, 0);
  const problems = codeProblems('fetch("/x"); const u = "http://a.b";');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /fetch\(/);
  assert.match(problems[0], /http:\/\//);
});

test("blocking checks cover loop and timing misuse; style is only advice", () => {
  assert.equal(codeProblems("setTimeout(f, 10);").length, 1);
  assert.equal(codeProblems("function loop(){ requestAnimationFrame(loop); }").length, 1);
  assert.equal(codeProblems("const Engine = {};").length, 1);
  assert.equal(codeProblems("let x = Math.random();").length, 0);
  assert.equal(styleAdvice("let x = Math.random();").length, 3);
  assert.equal(styleAdvice("Engine.sfx('hit'); Engine.fx.burst(1,2); Engine.rng(1);").length, 0);
});
