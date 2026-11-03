const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-knowledge-"));
process.env.STUDIO_KNOWLEDGE_PATH = path.join(tmp, "knowledge.json");
process.env.STUDIO_SETTINGS_PATH = path.join(tmp, "settings.json");

const { setApiKey } = require("./settings");
const { assertPublicUrl, htmlToText, isPrivateAddress, knowledgeReport, learnFromLinks, listKnowledge, relevantKnowledge, removeKnowledge } = require("./knowledge");
const { publicTracks, trackUrls } = require("./curriculum");

test("the built-in curriculum lists only public web addresses with no duplicates", () => {
  const urls = trackUrls();
  assert.ok(urls.length >= 50);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((url) => /^https:\/\//.test(url)));
  assert.deepEqual(trackUrls(["godot"]).every((url) => url.includes("docs.godotengine.org")), true);
  assert.ok(publicTracks().length >= 6);
});

test("refuses addresses that reach this computer or a private network", async () => {
  for (const bad of ["http://localhost:3000/", "http://127.0.0.1/", "http://10.0.0.5/x", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/", "https://user:pw@93.184.216.34/"]) {
    await assert.rejects(assertPublicUrl(bad), undefined, bad);
  }
  await assert.doesNotReject(assertPublicUrl("https://93.184.216.34/page"));
  assert.equal(isPrivateAddress("172.20.1.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});

test("turns a page into text, a title and links", () => {
  const html = `<html><head><title>Learn &amp; Make</title><script>var secret=1</script></head><body><nav>Menu</nav><h2>Jump feel</h2><p>Use coyote time.</p><ul><li>Buffer input</li></ul><a href="/course/platformer-basics">Platformer basics course</a><a href="#top">Top of page</a></body></html>`;
  const page = htmlToText(html, "https://93.184.216.34/list");
  assert.equal(page.title, "Learn & Make");
  assert.match(page.text, /# Jump feel/);
  assert.match(page.text, /- Buffer input/);
  assert.doesNotMatch(page.text, /secret|Menu/);
  assert.deepEqual(page.links, [{ url: "https://93.184.216.34/course/platformer-basics", text: "Platformer basics course" }]);
});

test("learns from a page and its followed link, recalls relevant lessons, and can forget them", async () => {
  await setApiKey({ apiKey: "sk-test-key-1234567890-abcdef", model: "gpt-4o" }, { verify: false });
  const filler = "Platformer movement and jump feel. ".repeat(20);
  const pages = {
    "https://93.184.216.34/list": `<title>Catalog</title><p>${filler}</p><a href="/course/platformer">Platformer basics course</a><a href="/about">About this website</a>`,
    "https://93.184.216.34/course/platformer": `<title>Platformer basics</title><h1>Syllabus</h1><p>${filler}</p>`,
  };
  const original = global.fetch;
  const modelCalls = [];
  global.fetch = async (target, options = {}) => {
    const url = String(target);
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      modelCalls.push(system.slice(0, 30));
      const reply = /decide which links/.test(system)
        ? { follow: [0] }
        : { title: "Lessons", lessons: [{ topic: "Coyote time", tags: ["platformer", "general"], lesson: "Allow jumping for about 100 ms after leaving a ledge so jumps feel forgiving." }, { topic: "Short", tags: [], lesson: "too short" }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
    }
    const html = pages[url];
    if (!html) return new Response("missing", { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const events = [];
    const summary = await learnFromLinks(["https://93.184.216.34/list"], { emit: (event) => events.push(event) });
    assert.equal(summary.pages, 2);
    assert.equal(summary.lessons, 1);
    assert.ok(events.some((event) => event.type === "learn-done" && event.total === 1));

    const items = listKnowledge();
    assert.equal(items.length, 1);
    assert.equal(items[0].topic, "Coyote time");

    assert.match(relevantKnowledge("a tight platformer with great jumping"), /Coyote time: Allow jumping/);
    assert.equal(relevantKnowledge("zzz qqq"), relevantKnowledge("zzz qqq"));
    assert.equal(removeKnowledge(items[0].id), true);
    assert.equal(relevantKnowledge("platformer"), "");
  } finally {
    global.fetch = original;
  }
});

test("drills the team, re-teaches missed questions and records the exam", async () => {
  await setApiKey({ apiKey: "sk-test-key-1234567890-abcdef", model: "gpt-4o" }, { verify: false });
  const original = global.fetch;
  let studentRuns = 0;
  global.fetch = async (target, options = {}) => {
    const url = String(target);
    if (url.endsWith("/chat/completions")) {
      const system = JSON.parse(options.body).messages[0].content;
      let reply;
      if (/studio librarian/.test(system)) reply = { title: "Tilemaps", lessons: [{ topic: "Tile size", tags: ["tilemap", "general"], lesson: "Use a consistent tile size such as 16 or 32 pixels so collision maps align with art." }] };
      else if (/exam setter/.test(system)) reply = { questions: [{ question: "How should the camera follow the player in a tilemap?", answer: "Lerp the camera toward the player each frame and clamp it to map bounds.", tags: ["camera", "tilemap"] }, { question: "What tile size keeps collision aligned?", answer: "A consistent tile size such as 16 or 32 pixels.", tags: ["tilemap"] }] };
      else if (/closed-book/.test(system)) { studentRuns++; reply = { answers: [{ id: 0, answer: "not covered" }, { id: 1, answer: "16 or 32 pixels" }] }; if (studentRuns === 2) reply.answers = [{ id: 0, answer: "Lerp the camera and clamp to map bounds." }]; }
      else reply = { results: JSON.parse(options.body).messages[1].content.includes("not covered") ? [{ id: 0, pass: false }, { id: 1, pass: true }] : [{ id: 0, pass: true }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
    }
    return new Response(`<title>Tilemaps</title><p>${"Tilemaps store level layout as a grid of tile ids. ".repeat(20)}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const events = [];
    const summary = await learnFromLinks(["https://93.184.216.34/tilemaps"], { follow: false, emit: (event) => events.push(event) });
    assert.equal(summary.asked, 2);
    assert.equal(summary.passedFinal, 2);
    assert.ok(events.some((event) => /Missed 1 of 2/.test(event.message || "")));
    assert.ok(listKnowledge().some((item) => item.reinforced && /Lerp the camera/.test(item.lesson)));
    const report = knowledgeReport();
    assert.equal(report.asked, 2);
    assert.equal(report.passed, 2);

    const again = [];
    await learnFromLinks(["https://93.184.216.34/tilemaps"], { follow: false, skipKnown: true, emit: (event) => again.push(event) });
    assert.ok(again.some((event) => /Already studied/.test(event.message || "")));
  } finally {
    global.fetch = original;
  }
});

test("reports pages it cannot read instead of failing the whole session", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "video/mp4" } });
  try {
    const summary = await learnFromLinks(["https://93.184.216.34/video", "http://127.0.0.1/admin"], { follow: false });
    assert.equal(summary.pages, 0);
    assert.equal(summary.skipped.length, 2);
    await assert.rejects(learnFromLinks([]), /at least one link/);
  } finally {
    global.fetch = original;
  }
});
