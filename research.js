const fs = require("node:fs");
const path = require("node:path");
const { isConfigured, getApiKey } = require("./settings");
const { withNotices } = require("./llm");
const { askJson, assertPublicUrl, hasStudied, knowledgeOutline, learnFromLinks } = require("./knowledge");
const { trackUrls } = require("./curriculum");

const DAY_MS = 86_400_000;
const FALLBACK_TOPICS = [
  "game feel and juice", "enemy AI behavior", "procedural level generation", "platformer physics", "top-down adventure design", "roguelike item systems",
  "collision detection algorithms", "game balance and economy", "puzzle level design", "boss fight design", "JavaScript canvas optimization", "GDScript best practices",
  "tilemap techniques", "pathfinding", "particle effects", "game UI design", "sound design for games", "state machines", "save systems", "turn-based combat design",
];

const stateFile = () => process.env.STUDIO_RESEARCH_PATH || path.join(__dirname, "data", "research.json");
const intervalMs = () => Number(process.env.STUDIO_RESEARCH_INTERVAL_MS) || 90_000;
const dailyCap = () => Number(process.env.STUDIO_RESEARCH_DAILY_PAGES) || 40;

let busy = 0;
let timer = null;
let failures = 0;
let running = false;
let yieldCheck = null;

function load() {
  const base = { enabled: true, queue: [], tried: [], topics: [], day: "", today: 0, pages: 0, lessons: 0, log: [], lastMessage: "Waiting for the first research round.", lastAt: "" };
  try { return { ...base, ...JSON.parse(fs.readFileSync(stateFile(), "utf8")) }; } catch { return base; }
}

function save(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(temp, file);
}

function note(state, message) {
  state.lastMessage = message;
  state.lastAt = new Date().toISOString();
  state.log = [...state.log, { at: state.lastAt, message }].slice(-40);
}

const markBusy = () => { busy++; };
const markIdle = () => { busy = Math.max(0, busy - 1); };

async function getJson(url) {
  await assertPublicUrl(url);
  const response = await fetch(url, { headers: { "User-Agent": "TraumaticStudiosResearch/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  return JSON.parse((await response.text()).slice(0, 1_500_000));
}

// Free, keyless, public sources that list articles by topic.
async function searchSources(topic) {
  const query = encodeURIComponent(topic.query);
  const tag = String(topic.tag || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  const jobs = [
    getJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${query}&limit=6&format=json`).then((data) => (data[1] || []).map((title, index) => ({ title, url: data[3]?.[index] }))),
    getJson(`https://hn.algolia.com/api/v1/search?query=${query}&tags=story&hitsPerPage=8`).then((data) => (data.hits || []).map((hit) => ({ title: hit.title, url: hit.url }))),
  ];
  if (tag) jobs.push(getJson(`https://dev.to/api/articles?per_page=8&top=60&tag=${tag}`).then((data) => (Array.isArray(data) ? data : []).map((item) => ({ title: item.title, url: item.url }))));
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((item) => item && typeof item.title === "string" && typeof item.url === "string" && /^https?:\/\//.test(item.url));
}

async function discover(state) {
  let topics;
  try {
    const result = await askJson(
      "You are the research director of a game-development studio's knowledge team. Given what the studio already knows, propose 3 specific topics worth researching next that would improve the quality of games it builds (design, game feel, genres, algorithms, engines, coding practice, debugging). Prefer gaps and fundamentals over trivia. Return only JSON: { \"topics\": [ { \"query\": a search phrase, \"tag\": one lowercase word such as gamedev, javascript, godot or gamedesign } ] }.",
      `Already known tags: ${knowledgeOutline() || "(nothing yet)"}\nRecently researched: ${state.topics.slice(-15).join("; ") || "(none)"}`,
      600,
    );
    topics = (Array.isArray(result.topics) ? result.topics : []).filter((item) => item && typeof item.query === "string").slice(0, 3);
  } catch {
    topics = [];
  }
  if (!topics.length) {
    const next = FALLBACK_TOPICS.find((topic) => !state.topics.includes(topic)) || FALLBACK_TOPICS[state.topics.length % FALLBACK_TOPICS.length];
    topics = [{ query: next, tag: "gamedev" }];
  }
  const topic = topics[0];
  state.topics = [...state.topics, topic.query].slice(-100);
  note(state, `Researching "${topic.query}"…`);
  const known = new Set([...state.tried, ...state.queue.map((item) => item.url)]);
  const candidates = (await searchSources(topic)).filter((item, index, all) => !known.has(item.url) && !hasStudied(item.url) && all.findIndex((other) => other.url === item.url) === index).slice(0, 24);
  if (!candidates.length) return 0;
  let picked = [];
  try {
    const result = await askJson(
      "You choose which web pages are worth reading to learn correct, concrete game-development or programming technique. Prefer documentation, tutorials, postmortems with technical detail and well-established references. Skip news, opinion, job posts, product announcements, videos and anything not teaching technique. Return only JSON: { \"pick\": [indices] } with at most 4 indices, best first.",
      `Topic: ${topic.query}\n\n${candidates.map((item, index) => `${index}: ${item.title} -> ${item.url}`).join("\n")}`,
      500,
    );
    picked = (Array.isArray(result.pick) ? result.pick : []).map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < candidates.length).slice(0, 4);
  } catch {
    picked = candidates.filter((item) => /wikipedia|docs\.|developer\.mozilla|gamedev|redblobgames|gameprogrammingpatterns/i.test(item.url)).slice(0, 3).map((item) => candidates.indexOf(item));
  }
  for (const index of picked) state.queue.push(candidates[index]);
  note(state, picked.length ? `Found ${picked.length} promising source${picked.length === 1 ? "" : "s"} on "${topic.query}".` : `Nothing worth reading found for "${topic.query}".`);
  return picked.length;
}

// One unit of research: study one page, either from the built-in curriculum or one the team discovered itself.
async function step() {
  const state = load();
  if (!state.enabled) return "paused";
  if (busy > 0) return "busy";
  if (!isConfigured()) return "no-ai";
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state.day = today; state.today = 0; }
  if (state.today >= dailyCap()) return "cap";

  const tried = new Set(state.tried);
  let url = trackUrls().find((candidate) => !tried.has(candidate) && !hasStudied(candidate));
  if (!url) {
    if (!state.queue.length) { await discover(state); save(state); }
    url = state.queue.shift()?.url;
    if (!url) { save(state); return "empty"; }
  }
  state.tried = [...state.tried, url].slice(-3000);
  save(state);
  if (busy > 0) return "busy";

  note(state, `Studying ${url}`);
  const summary = await withNotices(
    (message) => { note(state, message); },
    () => learnFromLinks([url], { follow: false, skipKnown: true, drill: Boolean(getApiKey()), emit: (event) => { if (event.type === "learn-log") note(state, event.message); } }),
  );
  const transient = !summary.pages && /model request failed|could not reach|timed out|fetch failed/i.test(summary.skipped[0] || "");
  if (transient) {
    state.tried = state.tried.filter((item) => item !== url);
    if (!trackUrls().includes(url)) state.queue.unshift({ url });
    note(state, "The AI provider is busy or unreachable right now. Will retry this page later.");
    save(state);
    throw new Error("the AI provider is busy");
  }
  state.today++;
  state.pages += summary.pages;
  state.lessons += summary.lessons;
  note(state, summary.pages ? `Learned ${summary.lessons} new lesson${summary.lessons === 1 ? "" : "s"} from ${url}.` : `Could not use ${url}: ${summary.skipped[0] || "nothing readable"}`);
  save(state);
  return summary.pages ? "studied" : "skipped";
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(run, delay);
  timer.unref?.();
}

async function run() {
  if (running) return;
  if (yieldCheck && !(await yieldCheck().catch(() => true))) return schedule(60_000);
  running = true;
  let delay = intervalMs();
  try {
    const result = await step();
    if (result === "studied" || result === "skipped") failures = 0;
    else if (result === "cap") delay = 30 * 60_000;
    else if (result === "empty") delay = Math.max(delay, 10 * 60_000);
    else delay = Math.min(delay, 60_000);
  } catch (error) {
    failures++;
    delay = Math.min(intervalMs() * 2 ** failures, 30 * 60_000);
    const state = load();
    if (!/AI provider is busy/.test(error.message)) note(state, `Research round failed (${String(error.message).slice(0, 120)}). Trying again later.`);
    save(state);
  } finally {
    running = false;
    schedule(delay);
  }
}

function start({ initialDelay = 20_000, shouldRun = null } = {}) {
  if (process.env.STUDIO_RESEARCH === "off") return false;
  yieldCheck = shouldRun;
  schedule(initialDelay);
  return true;
}

function stop() {
  clearTimeout(timer);
  timer = null;
}

function status() {
  const state = load();
  return { enabled: state.enabled, busy: busy > 0, today: state.today, dailyCap: dailyCap(), pages: state.pages, lessons: state.lessons, queued: state.queue.length, lastMessage: state.lastMessage, lastAt: state.lastAt, log: state.log.slice(-12), curriculumLeft: trackUrls().filter((url) => !state.tried.includes(url) && !hasStudied(url)).length };
}

function setEnabled(enabled) {
  const state = load();
  state.enabled = Boolean(enabled);
  note(state, state.enabled ? "Research division resumed." : "Research division paused.");
  save(state);
  return status();
}

module.exports = { discover, markBusy, markIdle, setEnabled, start, status, step, stop };
