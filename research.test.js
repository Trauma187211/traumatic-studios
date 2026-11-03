const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-research-"));
process.env.STUDIO_KNOWLEDGE_PATH = path.join(tmp, "knowledge.json");
process.env.STUDIO_SETTINGS_PATH = path.join(tmp, "settings.json");
process.env.STUDIO_RESEARCH_PATH = path.join(tmp, "research.json");
require("node:dns").promises.lookup = async () => [{ address: "93.184.216.34" }];

const settings = require("./settings");
const { installSeed, listKnowledge, relevantKnowledge } = require("./knowledge");
const research = require("./research");

const chatReply = (reply) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });

test("starter knowledge installs once and is used for a matching idea", () => {
  const added = installSeed();
  assert.ok(added >= 80, `installed ${added}`);
  assert.equal(installSeed(), 0);
  assert.ok(listKnowledge().every((item) => item.seeded));
  assert.match(relevantKnowledge("a snake game"), /Snake mechanics/);
  assert.match(relevantKnowledge("zelda style adventure with dungeons"), /Zelda-style|Room-based|Dungeon keys/);
});

test("the keyless default only applies when switched on and nothing else is set", () => {
  assert.equal(settings.isConfigured(), false);
  settings.enableKeylessDefault();
  assert.equal(settings.isConfigured(), true);
  assert.match(settings.getBaseUrl(), /pollinations/);
  assert.equal(settings.getPublicStatus().keyless, true);
});

test("research studies a curriculum page, yields to builds and respects the pause switch", async () => {
  const original = global.fetch;
  global.fetch = async (target, options = {}) => {
    if (String(target).endsWith("/chat/completions")) return chatReply({ title: "T", lessons: [{ topic: "Timing", tags: ["general"], lesson: "Run the simulation on a fixed time step with an accumulator for stable physics." }] });
    return new Response(`<title>Loop</title><p>${"The game loop processes input, updates the world and renders. ".repeat(20)}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    research.markBusy();
    assert.equal(await research.step(), "busy");
    research.markIdle();
    assert.equal(await research.step(), "studied");
    assert.equal(research.status().pages, 1);
    research.setEnabled(false);
    assert.equal(await research.step(), "paused");
    research.setEnabled(true);
  } finally {
    global.fetch = original;
  }
});

test("a provider outage does not burn the page; it is retried later", async () => {
  const original = global.fetch;
  global.fetch = async (target) => {
    if (String(target).endsWith("/chat/completions")) return new Response("busy", { status: 400 });
    return new Response(`<title>Loop</title><p>${"Spatial hashing buckets objects by grid cell. ".repeat(20)}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const before = JSON.parse(fs.readFileSync(process.env.STUDIO_RESEARCH_PATH, "utf8")).tried.length;
    await assert.rejects(research.step(), /busy/);
    const after = JSON.parse(fs.readFileSync(process.env.STUDIO_RESEARCH_PATH, "utf8"));
    assert.equal(after.tried.length, before);
  } finally {
    global.fetch = original;
  }
});

test("when nothing is left it researches new topics on its own and queues good sources", async () => {
  const original = global.fetch;
  global.fetch = async (target, options = {}) => {
    const url = String(target);
    if (url.endsWith("/chat/completions")) {
      const system = JSON.parse(options.body).messages[0].content;
      if (/research director/.test(system)) return chatReply({ topics: [{ query: "enemy steering behaviors", tag: "gamedev" }] });
      if (/choose which web pages/.test(system)) return chatReply({ pick: [0] });
      return chatReply({ title: "T", lessons: [] });
    }
    if (url.includes("wikipedia.org/w/api.php")) return new Response(JSON.stringify(["q", ["Steering behaviors"], [""], ["https://en.wikipedia.org/wiki/Steering_behaviors"]]), { status: 200 });
    if (url.includes("hn.algolia.com")) return new Response(JSON.stringify({ hits: [{ title: "Cool news", url: null }] }), { status: 200 });
    if (url.includes("dev.to/api")) return new Response("[]", { status: 200 });
    return new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const state = JSON.parse(fs.readFileSync(process.env.STUDIO_RESEARCH_PATH, "utf8"));
    state.tried = require("./curriculum").trackUrls();
    fs.writeFileSync(process.env.STUDIO_RESEARCH_PATH, JSON.stringify(state));
    await research.step();
    const after = JSON.parse(fs.readFileSync(process.env.STUDIO_RESEARCH_PATH, "utf8"));
    assert.ok(after.topics.includes("enemy steering behaviors"));
    assert.ok(after.tried.includes("https://en.wikipedia.org/wiki/Steering_behaviors"));
  } finally {
    global.fetch = original;
  }
});
