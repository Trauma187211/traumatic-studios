const dns = require("node:dns").promises;
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { getModel } = require("./settings");
const { cleanReply, llmFetch } = require("./llm");

// Bound one fetched response for security and stability; accumulated lessons,
// sources, exams, and research history have no retention ceiling.
const MAX_PAGE_BYTES = Number(process.env.STUDIO_MAX_LEARNING_PAGE_BYTES) || 16_000_000;
const PAGE_TEXT_FOR_MODEL = 28_000;
const KNOWLEDGE_BUDGET_CHARS = 6_400;
const feedbackFile = () => `${journalFile()}.feedback.jsonl`;
let feedbackSignature = "";
let feedbackScores = new Map();

function rateSource(url) {
  if (url === "studio-seed" || url === "studio-feedback") return { score: 1, tier: "studio-curated" };
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { score: 0.35, tier: "unverified" }; }
  const primary = ["docs.godotengine.org", "docs.unity3d.com", "dev.epicgames.com", "developer.mozilla.org", "web.dev", "gameprogrammingpatterns.com", "redblobgames.com"];
  const curated = ["gamedeveloper.com", "gdcvault.com", "gdquest.com", "nngroup.com", "phaser.io"];
  const educational = ["edu"];
  if (primary.some((domain) => host === domain || host.endsWith(`.${domain}`))) return { score: 1, tier: "primary documentation" };
  if (curated.some((domain) => host === domain || host.endsWith(`.${domain}`))) return { score: 0.85, tier: "established specialist source" };
  if (host.endsWith(".edu") || educational.some((domain) => host.endsWith(`.${domain}`))) return { score: 0.85, tier: "educational source" };
  if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) return { score: 0.6, tier: "reference overview" };
  if (host === "dev.to" || host.endsWith(".dev.to") || host.includes("substack")) return { score: 0.5, tier: "community article" };
  return { score: 0.45, tier: "unrated public source" };
}

function feedbackWeights() {
  const file = feedbackFile();
  try {
    const stat = fs.statSync(file), signature = `${stat.size}:${stat.mtimeMs}`;
    if (signature === feedbackSignature) return feedbackScores;
    const next = new Map();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line);
        for (const id of event.lessonIds || []) next.set(id, (next.get(id) || 0) + (event.rating > 0 ? 1 : -1));
      } catch { /* ignore a torn tail */ }
    }
    feedbackSignature = signature; feedbackScores = next;
  } catch { feedbackSignature = ""; feedbackScores = new Map(); }
  return feedbackScores;
}

function recordBuildFeedback({ projectId, lessonIds = [], rating, comment = "", source = "player" }) {
  if (!/^game-\d+-[a-f0-9]{8}$/.test(String(projectId)) || ![-1, 1].includes(Number(rating))) throw new Error("Invalid project feedback.");
  const ids = [...new Set(lessonIds.filter((id) => typeof id === "string" && /^k-[\w-]+$/.test(id)))];
  if (!ids.length) throw new Error("This build has no recorded knowledge selections to rate.");
  if (source === "player" && hasPlayerFeedback(projectId)) throw new Error("Feedback has already been recorded for this build.");
  fs.mkdirSync(path.dirname(feedbackFile()), { recursive: true });
  const event = { at: new Date().toISOString(), projectId, lessonIds: ids, rating: Number(rating), comment: String(comment).slice(0, 500), source };
  fs.appendFileSync(feedbackFile(), `${JSON.stringify(event)}\n`, "utf8");
  feedbackSignature = "";
  return event;
}

function hasPlayerFeedback(projectId) {
  try { return fs.readFileSync(feedbackFile(), "utf8").split("\n").some((line) => { try { const event = JSON.parse(line); return event.projectId === projectId && event.source === "player"; } catch { return false; } }); }
  catch { return false; }
}

const knowledgeFile = () => process.env.STUDIO_KNOWLEDGE_PATH || path.join(__dirname, "data", "knowledge.json");
const journalFile = () => `${knowledgeFile()}.jsonl`;
let cachedStoreFile = "";
let cachedStoreSignature = "";
let cachedStore = null;
let cachedIndexItems = null;
let cachedIndex = null;

function emptyStore() { return { items: [], exams: [], seedVersion: 0, _byId: new Map() }; }

function applyJournalLine(store, line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "lesson" && event.item && typeof event.item.id === "string") {
    const index = store._byId.get(event.item.id);
    if (index === undefined) {
      store._byId.set(event.item.id, store.items.length);
      store.items.push(event.item);
    } else store.items[index] = event.item;
  } else if (event.type === "forget") {
    const index = store._byId.get(event.id);
    if (index !== undefined) {
      store.items[index] = null;
      store._byId.delete(event.id);
    }
  } else if (event.type === "exam" && event.exam) {
    store.exams.push(event.exam);
  } else if (event.type === "seed-version") {
    store.seedVersion = Math.max(store.seedVersion, Number(event.version) || 0);
  }
}

function readStore() {
  const journal = journalFile();
  try {
    const stat = fs.statSync(journal);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (cachedStoreFile === journal && cachedStoreSignature === signature && cachedStore) return cachedStore;
    const store = emptyStore();
    const content = fs.readFileSync(journal, "utf8");
    for (const line of content.split("\n")) if (line) applyJournalLine(store, line);
    if (store.items.includes(null)) store.items = store.items.filter(Boolean);
    cachedStoreFile = journal;
    cachedStoreSignature = signature;
    cachedStore = store;
    cachedIndexItems = null;
    return store;
  } catch {
    try {
      const parsed = JSON.parse(fs.readFileSync(knowledgeFile(), "utf8"));
      return { items: Array.isArray(parsed.items) ? parsed.items : [], exams: Array.isArray(parsed.exams) ? parsed.exams : [], seedVersion: Number(parsed.seedVersion) || 0 };
    } catch { return emptyStore(); }
  }
}

function appendEvents(events) {
  if (!events.length) return;
  const file = journalFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    // Keep the existing JSON library as a recovery copy; migrate its contents
    // to the append-only journal without imposing a retention limit.
    let legacy = emptyStore();
    try {
      const parsed = JSON.parse(fs.readFileSync(knowledgeFile(), "utf8"));
      legacy = { items: Array.isArray(parsed.items) ? parsed.items : [], exams: Array.isArray(parsed.exams) ? parsed.exams : [], seedVersion: Number(parsed.seedVersion) || 0 };
    } catch { /* first run */ }
    const initial = [
      ...legacy.items.map((item) => ({ type: "lesson", item })),
      ...legacy.exams.map((exam) => ({ type: "exam", exam })),
      { type: "seed-version", version: legacy.seedVersion },
    ];
    fs.writeFileSync(file, initial.map((event) => JSON.stringify(event)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
  }
  // Check only the final byte on the normal path. If a prior write was torn,
  // scan backward in blocks to repair its incomplete record before appending.
  const fd = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) {
        let position = size;
        let found = 0;
        while (position > 0 && !found) {
          const length = Math.min(4096, position);
          position -= length;
          const block = Buffer.alloc(length);
          fs.readSync(fd, block, 0, length, position);
          const newline = block.lastIndexOf(10);
          if (newline >= 0) { position += newline + 1; found = 1; }
        }
        fs.ftruncateSync(fd, position);
      }
    }
  } finally { fs.closeSync(fd); }
  fs.appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  cachedStoreFile = "";
  cachedStoreSignature = "";
  cachedStore = null;
  cachedIndexItems = null;
}

const loadAll = () => readStore().items;

function recordExam(exam) {
  appendEvents([{ type: "exam", exam: { ...exam, at: new Date().toISOString() } }]);
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

// This server fetches addresses supplied by the user, so it must never reach into the local network.
async function assertPublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`"${String(value).slice(0, 80)}" is not a valid web address.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links can be studied.");
  if (url.username || url.password) throw new Error("Links with a username or password are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("That address points at this computer or a private network.");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`Could not find ${host}.`); });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error("That address points at this computer or a private network.");
  return url;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
const decodeEntities = (text) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);

// Reduces a web page to readable text plus the links it contains.
function htmlToText(html, baseUrl) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    let target;
    try { target = new URL(match[1], baseUrl); } catch { continue; }
    if (!/^https?:$/.test(target.protocol) || label.length < 8 || label.length > 140) continue;
    target.hash = "";
    if (seen.has(target.href)) continue;
    seen.add(target.href);
    links.push({ url: target.href, text: label });
  }
  const mainBlock = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<div[^>]+role=["']main["'][\s\S]*/i)?.[0];
  const body = mainBlock && mainBlock.length > 1500 ? mainBlock : html;
  const text = decodeEntities(body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|form|iframe|select|button)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h[1-6][^>]*>/gi, "\n\n# ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|section|article|h[1-6]|ul|ol|table)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}

async function readLimited(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_PAGE_BYTES) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchPage(value) {
  let url = await assertPublicUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "TraumaticStudiosLearner/1.0 (+local study tool)", Accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await assertPublicUrl(new URL(response.headers.get("location"), url).href);
      continue;
    }
    if (!response.ok) throw new Error(`${url.hostname} answered ${response.status}.`);
    const type = response.headers.get("content-type") || "";
    if (!/text\/|json|xml/i.test(type)) throw new Error("That link is not a readable text page (videos and files cannot be studied).");
    const body = await readLimited(response);
    const page = /html|xml/i.test(type) ? htmlToText(body, url.href) : { title: url.pathname.split("/").pop() || url.hostname, text: body.trim(), links: [] };
    return { url: url.href, ...page };
  }
  throw new Error("Too many redirects.");
}

function parseObject(text) {
  try { return JSON.parse(text); } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw error;
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function askJson(system, user, maxTokens = 3500) {
  const response = await llmFetch({
    body: JSON.stringify({
      model: getModel(),
      temperature: 0.2,
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new Error(`The model request failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const content = (await response.json()).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned an empty response.");
  return parseObject(cleanReply(content));
}

const DISTILL_SYSTEM = `You are the studio librarian for a game-development team that builds playable games in 2D, 2.5D, and 3D, for browser and Godot. You read one web page and turn it into durable, practical lessons the team can apply when designing, planning, and coding games.
Rules:
- Base every lesson on subjects the page actually covers (its course topics, syllabus items, tutorial steps, documentation sections). You may explain how those named techniques are done using well-established game-development practice, but never invent claims about the page or its author.
- Each lesson is concrete and actionable: a technique, formula, pattern, design rule, workflow step or pitfall, written so an engineer or designer could apply it directly. Prefer specifics (for example "buffer jump input for about 100 ms and allow jumping for about 100 ms after leaving a ledge") over generalities.
- First decide whether the page has substantive, transferable information about game design, game production, interactive systems, or technical game development. Generic AI advice, unrelated software or business advice, company trivia, and thin link/category pages are not game lessons: return relevant=false and no lessons for them.
- Skip marketing, prices, reviews, instructor biographies, navigation and anything unrelated to making games.
- Postmortems, case studies and articles about shipped or failed projects (including large AAA productions) ARE valuable: extract the root cause of each failure, the workaround or fix the team used, and the transferable rule, then restate it as a technique or pitfall that applies to small games and to build/tooling/engine-version problems. Never return an empty lessons array for such articles.
- Tag each lesson with 2 to 5 lowercase keywords (genre, engine, topic) and put "general" among the tags when it applies to any game.
Return only JSON: { "title": short page title, "relevant": boolean, "lessons": [ { "topic": 2-6 words, "tags": [strings], "lesson": 1-3 sentences } ] }. Extract every distinct, actionable lesson supported by the supplied passage without repeating the same idea. Use relevant=false and an empty lessons array when the passage is not substantive game-development learning material.`;

async function distill(page) {
  const passages = [];
  for (let offset = 0; offset < page.text.length; offset += PAGE_TEXT_FOR_MODEL) passages.push(page.text.slice(offset, offset + PAGE_TEXT_FOR_MODEL));
  const collected = [];
  for (let index = 0; index < passages.length; index++) {
    const result = await askJson(DISTILL_SYSTEM, `Page: ${page.title}\nAddress: ${page.url}\nPassage ${index + 1} of ${passages.length}:\n\n${passages[index]}`);
    if (result.relevant !== true) continue;
    const lessons = Array.isArray(result.lessons) ? result.lessons : [];
    collected.push(...lessons
      .filter((item) => item && typeof item.lesson === "string" && item.lesson.trim().length >= 25)
      .map((item) => ({
        topic: String(item.topic || "").trim(),
        tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => String(tag).toLowerCase().trim()).filter(Boolean),
        lesson: item.lesson.trim(),
      })));
  }
  return collected;
}

async function chooseLinks(page) {
  const candidates = page.links;
  const selected = [];
  // Review the complete extracted link set in small prompt batches to stay
  // inside model context limits without imposing a page-wide follow cap.
  for (let start = 0; start < candidates.length; start += 30) {
    const batch = candidates.slice(start, start + 30);
    const result = await askJson(
      "Select every link in this batch that leads to substantive learning material about making games (documentation, tutorials, syllabi, articles, detailed postmortems). Skip navigation, accounts, pricing, ads, social pages, videos without transcripts, and unrelated topics. Return JSON { \"follow\": [indices] }.",
      `Page: ${page.title}\n\n${batch.map((link, index) => `${index}: ${link.text} -> ${link.url}`).join("\n")}`,
      1200,
    );
    const picked = Array.isArray(result.follow) ? result.follow : [];
    for (const index of new Set(picked.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < batch.length))) selected.push(batch[index]);
  }
  return selected;
}

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function addLessons(source, title, lessons) {
  const items = loadAll();
  const known = new Map(items.map((item) => [normalize(item.lesson), item]));
  const events = [];
  let added = 0;
  for (const lesson of lessons) {
    const key = normalize(lesson.lesson);
    const existing = known.get(key);
    if (existing) {
      if (lesson.reinforced && !existing.reinforced) {
        const upgraded = { ...existing, reinforced: true, reinforcedAt: new Date().toISOString() };
        known.set(key, upgraded);
        events.push({ type: "lesson", item: upgraded });
      }
      continue;
    }
    const quality = rateSource(source);
    const item = { id: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, source, title, ...lesson, sourceQuality: quality.score, sourceTier: quality.tier, addedAt: new Date().toISOString() };
    known.set(key, item);
    events.push({ type: "lesson", item });
    added++;
  }
  appendEvents(events);
  return added;
}

const SEED_VERSION = 3;

// Installs the lessons that ship with the studio so it starts out knowledgeable. Runs once per seed version.
function installSeed(file = path.join(__dirname, "seed-knowledge.json")) {
  const store = readStore();
  if (store.seedVersion >= SEED_VERSION) return 0;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return 0; }
  const lessons = (Array.isArray(seed) ? seed : []).filter((item) => item && typeof item.lesson === "string" && item.lesson.length >= 25)
    .map((item) => ({ topic: String(item.topic || ""), tags: (item.tags || []).map((tag) => String(tag).toLowerCase()), lesson: item.lesson, seeded: true }));
  const added = addLessons("studio-seed", "Studio starter knowledge", lessons);
  appendEvents([{ type: "seed-version", version: SEED_VERSION }]);
  return added;
}

let sourceIndexItems = null;
let sourceIndex = null;
const hasStudied = (url) => {
  const items = loadAll();
  if (sourceIndexItems !== items) {
    sourceIndex = new Set(items.map((item) => item.source));
    sourceIndexItems = items;
  }
  return sourceIndex.has(url);
};

// A short description of what the studio already knows, so research can aim at gaps.
function knowledgeOutline() {
  const counts = new Map();
  for (const item of loadAll()) for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([tag, count]) => `${tag} (${count})`).join(", ");
}

const QUIZ_SYSTEM = `You are the exam setter for a game-development studio. Read the page and write practical exam questions that test whether an engineer could apply its techniques when building a game (implementation, rules, formulas, or pitfalls). Cover each distinct teachable point without redundant questions. Questions must be answerable from the page, self-contained, and not about the page or its author.
Return only JSON: { "questions": [ { "question": string, "answer": a correct, concrete 1-3 sentence reference answer, "tags": 2-4 lowercase keywords } ] }.`;

const STUDENT_SYSTEM = `You are a game developer sitting a closed-book exam. You may use ONLY the studio notes provided; you have not seen the original source. Answer each question as specifically as the notes allow. If the notes do not cover a question, say "not covered" rather than guessing.
Return only JSON: { "answers": [ { "id": number, "answer": string } ] } with one entry per question.`;

const GRADER_SYSTEM = `You grade a game-development exam. For each question compare the student's answer with the reference answer. pass is true only if the student's answer contains the key technique, numbers or rule from the reference and nothing that contradicts it. "not covered" fails.
Return only JSON: { "results": [ { "id": number, "pass": boolean } ] } with one entry per question.`;

async function sitExam(questions) {
  const notes = new Map();
  for (const item of questions) for (const note of pickLessons(`${item.question} ${item.tags.join(" ")}`, 12)) notes.set(note.id, note);
  const studyNotes = [...notes.values()].map((note) => `- ${note.topic ? `${note.topic}: ` : ""}${note.lesson}`).join("\n") || "(no notes)";
  const numbered = questions.map((item, id) => `${id}: ${item.question}`).join("\n");
  const taken = await askJson(STUDENT_SYSTEM, `Studio notes:\n${studyNotes}\n\nQuestions:\n${numbered}`, 2500);
  const answers = new Map((Array.isArray(taken.answers) ? taken.answers : []).map((entry) => [Number(entry.id), String(entry.answer || "")]));
  const graded = await askJson(GRADER_SYSTEM, questions.map((item, id) => `Question ${id}: ${item.question}\nReference answer: ${item.answer}\nStudent answer: ${answers.get(id) || "(no answer)"}`).join("\n\n"), 1500);
  const passed = new Map((Array.isArray(graded.results) ? graded.results : []).map((entry) => [Number(entry.id), entry.pass === true]));
  return questions.map((_, id) => passed.get(id) === true);
}

// Quizzes the team closed-book on a page it just studied, re-teaches anything it failed, and retests once.
async function drillPage(page, emit) {
  const quiz = await askJson(QUIZ_SYSTEM, `Page: ${page.title}\n\n${page.text}`, 5000);
  const questions = (Array.isArray(quiz.questions) ? quiz.questions : [])
    .filter((item) => item && typeof item.question === "string" && typeof item.answer === "string" && item.answer.trim().length >= 15)
    .map((item) => ({ question: item.question.trim(), answer: item.answer.trim(), tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => String(tag).toLowerCase().trim()).filter(Boolean).slice(0, 4) }));
  if (!questions.length) return null;
  emit({ type: "learn-log", level: "info", message: `Drilling the team on "${page.title || page.url}": ${questions.length} closed-book questions…` });
  const first = await sitExam(questions);
  const failed = questions.filter((_, index) => !first[index]);
  let final = first.filter(Boolean).length;
  if (failed.length) {
    emit({ type: "learn-log", level: "warn", message: `Missed ${failed.length} of ${questions.length}. Re-teaching those points and testing again…` });
    addLessons(page.url, page.title, failed.map((item) => ({ topic: item.question, tags: item.tags, lesson: item.answer, reinforced: true })));
    const retake = await sitExam(failed);
    final += retake.filter(Boolean).length;
  }
  const result = { source: page.url, title: page.title, asked: questions.length, passedFirst: first.filter(Boolean).length, passedFinal: final };
  recordExam(result);
  emit({ type: "learn-log", level: final === questions.length ? "ok" : "warn", message: `Exam result for "${page.title || page.url}": ${result.passedFirst}/${result.asked} first try, ${final}/${result.asked} after re-teaching.` });
  return result;
}

// Reads the given links (and, when asked, the pages they point to), distills them into lessons and stores them.
async function learnFromLinks(urls, { follow = true, drill = true, skipKnown = false, emit = () => {} } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((value) => String(value).trim()).filter(Boolean))];
  if (!list.length) throw new Error("Paste at least one link.");
  const summary = { pages: 0, lessons: 0, skipped: [], asked: 0, passedFinal: 0 };

  const studied = new Set(loadAll().map((item) => item.source));
  const visited = new Set();
  const study = async (target, label) => {
    if (visited.has(target)) return null;
    visited.add(target);
    if (skipKnown && studied.has(target)) {
      emit({ type: "learn-log", level: "info", message: `Already studied ${label || target}; moving on.` });
      return null;
    }
    emit({ type: "learn-log", level: "info", message: `Reading ${label || target}…` });
    try {
      const page = await fetchPage(target);
      if (page.text.length < 200) throw new Error("the page has almost no readable text (it may need JavaScript or a login)");
      emit({ type: "learn-log", level: "info", message: `Studying "${page.title || page.url}" (${Math.round(page.text.length / 1000)}k characters)…` });
      const lessons = await distill(page);
      const added = addLessons(page.url, page.title, lessons);
      studied.add(page.url);
      summary.pages++;
      summary.lessons += added;
      emit({ type: "learn-log", level: added ? "ok" : "info", message: added ? `Learned ${added} new lesson${added === 1 ? "" : "s"} from "${page.title || page.url}".` : `Nothing new to learn from "${page.title || page.url}".` });
      if (drill && lessons.length) {
        try {
          const exam = await drillPage(page, emit);
          if (exam) { summary.asked += exam.asked; summary.passedFinal += exam.passedFinal; }
        } catch (error) {
          emit({ type: "learn-log", level: "warn", message: `Skipped the exam for this page: ${error.message.slice(0, 120)}` });
        }
      }
      return page;
    } catch (error) {
      summary.skipped.push(`${label || target}: ${error.message}`);
      emit({ type: "learn-log", level: "warn", message: `Skipped ${label || target}: ${error.message.slice(0, 160)}` });
      return null;
    }
  };

  for (const target of list) {
    const page = await study(target);
    if (!page || !follow) continue;
    let links = [];
    try { links = await chooseLinks(page); } catch (error) { emit({ type: "learn-log", level: "warn", message: `Could not pick follow-up links: ${error.message.slice(0, 120)}` }); }
    if (links.length) emit({ type: "learn-log", level: "info", message: `Following ${links.length} linked page${links.length === 1 ? "" : "s"} that look worth studying.` });
    for (const link of links) await study(link.url, link.text);
  }
  emit({ type: "learn-done", ...summary, total: loadAll().length });
  return summary;
}

const STOP_WORDS = new Set("a an and are as at be but by for from game games has have i in into is it its make me my of on or that the their this to want with you your will can should build create based inspired include featuring playable please user player".split(" "));
const words = (text) => normalize(text).split(" ").filter((word) => word.length > 2 && !STOP_WORDS.has(word));

const QUERY_ALIASES = {
  openworld: "open world exploration traversal landmarks routes ecology streaming",
  open: "exploration traversal landmarks routes world",
  world: "worldbuilding exploration landmarks routes ecology",
  survival: "survival crafting gathering hunger shelter weather resources ecology",
  crafting: "crafting recipes resources inventory economy progression",
  dungeon: "dungeon rooms gates keys shortcuts encounter pacing procedural",
  rpg: "rpg roleplaying quests dialogue progression inventory stats economy",
  quest: "quest narrative objectives branching npc state consequences",
  story: "narrative quest dialogue characters worldbuilding",
  "3d": "3d camera perspective navigation level design performance",
  camera: "camera 3d perspective framing follow exploration",
  multiplayer: "multiplayer networking replication synchronization authority",
};

function expandedWords(text) {
  const result = new Set(words(text));
  for (const word of [...result]) for (const alias of words(QUERY_ALIASES[word] || "")) result.add(alias);
  return result;
}

function knowledgeIndex(items) {
  if (cachedIndexItems === items && cachedIndex) return cachedIndex;
  const postings = new Map();
  items.forEach((item, index) => {
    const document = new Set(words(`${item.topic || ""} ${(item.tags || []).join(" ")} ${item.lesson || ""}`));
    for (const word of document) {
      if (!postings.has(word)) postings.set(word, []);
      postings.get(word).push(index);
    }
  });
  cachedIndexItems = items;
  cachedIndex = { postings };
  return cachedIndex;
}

function pickLessons(text, limit) {
  const items = loadAll();
  if (!items.length) return [];
  const query = expandedWords(text);
  const { postings } = knowledgeIndex(items);
  const bucketFor = (item) => {
    const tags = (item.tags || []).map((tag) => tag.toLowerCase());
    if (tags.some((tag) => /engine|godot|javascript|web|performance|architecture|algorithm|physics|render|camera|3d/.test(tag))) return "engineering";
    if (tags.some((tag) => /production|scope|qa|testing|debug|workflow|postmortem/.test(tag))) return "production";
    if (tags.some((tag) => /art|audio|animation|ui|accessibility/.test(tag))) return "presentation";
    if (tags.some((tag) => /general|design|gamedev/.test(tag))) return "design";
    return tags.find((tag) => tag !== "general") || "other";
  };
  const scores = new Map();
  for (const word of query) {
    const matches = postings.get(word) || [];
    const idf = Math.log(1 + (items.length + 1) / (1 + matches.length));
    for (const index of matches) {
      const item = items[index];
      scores.set(index, (scores.get(index) || 0) + (item.tags?.includes(word) ? 2.7 : 1) * idf);
    }
  }
  const ranked = [...scores.entries()].map(([index, score]) => {
    const item = items[index];
    score *= 0.8 + 0.4 * (Number.isFinite(item.sourceQuality) ? item.sourceQuality : rateSource(item.source).score);
    if (item.reinforced) score += 0.35;
    score += Math.max(-3, Math.min(3, (feedbackWeights().get(item.id) || 0) * 0.35));
    return { item, score, bucket: bucketFor(item) };
  }).sort((a, b) => b.score - a.score);
  // Keep the best directly relevant lesson from several disciplines before
  // filling remaining slots by score; this avoids one dense topic drowning
  // out engineering, production, or presentation guidance.
  const selected = [], counts = new Map();
  for (const entry of ranked) {
    if ((counts.get(entry.bucket) || 0) >= 4) continue;
    selected.push(entry.item);
    counts.set(entry.bucket, (counts.get(entry.bucket) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

// Picks the lessons most relevant to a game idea, within a size budget, for use inside prompts.
function relevantKnowledge(text, { limit = 22 } = {}) {
  const lines = [];
  let used = 0;
  for (const item of pickLessons(text, limit)) {
    const line = `- ${item.topic ? `${item.topic}: ` : ""}${item.lesson}`;
    if (used + line.length > KNOWLEDGE_BUDGET_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? `\n\nRetrieved studio knowledge (use as adaptable techniques, not as a fixed game template; apply only what supports this brief):\n${lines.join("\n")}` : "";
}

function retrieveKnowledge(text, { limit = 22 } = {}) {
  const query = expandedWords(text);
  return pickLessons(text, limit).map((item) => ({
    id: item.id, topic: item.topic || "", lesson: item.lesson,
    source: item.source, title: item.title || "", sourceTier: item.sourceTier || rateSource(item.source).tier,
    sourceQuality: Number.isFinite(item.sourceQuality) ? item.sourceQuality : rateSource(item.source).score,
    reason: `Matched terms: ${(words(`${item.topic || ""} ${(item.tags || []).join(" ")} ${item.lesson}`).filter((word) => query.has(word)).slice(0, 6).join(", ")) || "general design and engineering relevance"}.`,
    feedback: feedbackWeights().get(item.id) || 0,
  }));
}

const listKnowledge = () => loadAll().slice().reverse();

function listKnowledgePage({ offset = 0, limit = 50, query = "" } = {}) {
  const items = loadAll();
  const term = String(query || "").trim().toLowerCase();
  const matches = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (term && !`${item.topic || ""} ${item.lesson || ""} ${item.title || ""} ${(item.tags || []).join(" ")}`.toLowerCase().includes(term)) continue;
    matches.push(item);
  }
  return { total: matches.length, items: matches.slice(offset, offset + limit) };
}

function knowledgeReport() {
  const { items, exams } = readStore();
  const asked = exams.reduce((sum, exam) => sum + exam.asked, 0);
  const passed = exams.reduce((sum, exam) => sum + exam.passedFinal, 0);
  const sourceTiers = {};
  for (const item of items) {
    const tier = item.sourceTier || rateSource(item.source).tier;
    sourceTiers[tier] = (sourceTiers[tier] || 0) + 1;
  }
  return { lessons: items.length, sources: new Set(items.map((item) => item.source)).size, exams: exams.length, asked, passed, sourceTiers };
}

function removeKnowledge(id) {
  const items = loadAll();
  if (!items.some((item) => item.id === id)) return false;
  appendEvents([{ type: "forget", id }]);
  return true;
}

module.exports = { askJson, assertPublicUrl, fetchPage, hasStudied, htmlToText, installSeed, isPrivateAddress, knowledgeOutline, knowledgeReport, learnFromLinks, listKnowledge, listKnowledgePage, relevantKnowledge, retrieveKnowledge, recordBuildFeedback, hasPlayerFeedback, removeKnowledge, rateSource };
