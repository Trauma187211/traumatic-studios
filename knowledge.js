const dns = require("node:dns").promises;
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { getModel } = require("./settings");
const { cleanReply, llmFetch } = require("./llm");

const MAX_ITEMS = 1500;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_URLS = 10;
const MAX_FOLLOWED = 12;
const PAGE_TEXT_FOR_MODEL = 28_000;
const KNOWLEDGE_BUDGET_CHARS = 4_800;
const MAX_CURRICULUM_PAGES = 70;

const knowledgeFile = () => process.env.STUDIO_KNOWLEDGE_PATH || path.join(__dirname, "data", "knowledge.json");

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(knowledgeFile(), "utf8"));
    return { items: Array.isArray(parsed.items) ? parsed.items : [], exams: Array.isArray(parsed.exams) ? parsed.exams : [], seedVersion: Number(parsed.seedVersion) || 0 };
  } catch {
    return { items: [], exams: [], seedVersion: 0 };
  }
}

function writeStore(store) {
  const file = knowledgeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 1), "utf8");
  fs.renameSync(temp, file);
}

const loadAll = () => readStore().items;
const saveAll = (items) => writeStore({ ...readStore(), items });

function recordExam(exam) {
  const store = readStore();
  store.exams = [...store.exams, { ...exam, at: new Date().toISOString() }].slice(-200);
  writeStore(store);
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

const DISTILL_SYSTEM = `You are the studio librarian for a game-development team that builds playable 2D games from any idea. You read one web page and turn it into durable, practical lessons the team can apply when designing and coding games.
Rules:
- Base every lesson on subjects the page actually covers (its course topics, syllabus items, tutorial steps, documentation sections). You may explain how those named techniques are done using well-established game-development practice, but never invent claims about the page or its author.
- Each lesson is concrete and actionable: a technique, formula, pattern, design rule, workflow step or pitfall, written so an engineer or designer could apply it directly. Prefer specifics (for example "buffer jump input for about 100 ms and allow jumping for about 100 ms after leaving a ledge") over generalities.
- Skip marketing, prices, reviews, instructor biographies, navigation and anything unrelated to making games.
- Tag each lesson with 2 to 5 lowercase keywords (genre, engine, topic) and put "general" among the tags when it applies to any game.
Return only JSON: { "title": short page title, "lessons": [ { "topic": 2-6 words, "tags": [strings], "lesson": 1-3 sentences } ] } with 3 to 10 lessons. If the page has nothing useful for making games, return an empty lessons array.`;

async function distill(page) {
  const result = await askJson(DISTILL_SYSTEM, `Page: ${page.title}\nAddress: ${page.url}\n\n${page.text.slice(0, PAGE_TEXT_FOR_MODEL)}`);
  const lessons = Array.isArray(result.lessons) ? result.lessons : [];
  return lessons
    .filter((item) => item && typeof item.lesson === "string" && item.lesson.trim().length >= 25)
    .slice(0, 10)
    .map((item) => ({
      topic: String(item.topic || "").trim().slice(0, 80),
      tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => String(tag).toLowerCase().trim().slice(0, 30)).filter(Boolean).slice(0, 6),
      lesson: item.lesson.trim().slice(0, 700),
    }));
}

async function chooseLinks(page) {
  const candidates = page.links.slice(0, 120);
  if (!candidates.length) return [];
  const result = await askJson(
    "You decide which links on a web page are worth reading to learn how to make games. Pick links that lead to substantive teaching content (course or tutorial descriptions, syllabi, documentation, articles) about game development. Skip navigation, account, pricing, advertising, social and unrelated-topic links. Return only JSON: { \"follow\": [indices] } with at most " + MAX_FOLLOWED + " indices, best first.",
    `Page: ${page.title}\n\n${candidates.map((link, index) => `${index}: ${link.text} -> ${link.url}`).join("\n")}`,
    800,
  );
  const picked = Array.isArray(result.follow) ? result.follow : [];
  return [...new Set(picked.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < candidates.length))]
    .slice(0, MAX_FOLLOWED)
    .map((index) => candidates[index]);
}

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const wordSet = (text) => new Set(normalize(text).split(" ").filter((word) => word.length > 3));
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= 0.6;
}

function addLessons(source, title, lessons) {
  const items = loadAll();
  const known = new Set(items.map((item) => normalize(item.lesson)));
  const sets = items.map((item) => wordSet(item.lesson));
  let added = 0;
  for (const lesson of lessons) {
    const key = normalize(lesson.lesson);
    if (known.has(key)) continue;
    const words = wordSet(lesson.lesson);
    if (!lesson.reinforced && sets.some((existing) => similar(existing, words))) continue;
    known.add(key);
    sets.push(words);
    items.push({ id: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, source, title, ...lesson, addedAt: new Date().toISOString() });
    added++;
  }
  saveAll(items.slice(-MAX_ITEMS));
  return added;
}

const SEED_VERSION = 1;

// Installs the lessons that ship with the studio so it starts out knowledgeable. Runs once per seed version.
function installSeed(file = path.join(__dirname, "seed-knowledge.json")) {
  const store = readStore();
  if (store.seedVersion >= SEED_VERSION) return 0;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return 0; }
  const lessons = (Array.isArray(seed) ? seed : []).filter((item) => item && typeof item.lesson === "string" && item.lesson.length >= 25)
    .map((item) => ({ topic: String(item.topic || "").slice(0, 80), tags: (item.tags || []).map((tag) => String(tag).toLowerCase()).slice(0, 6), lesson: item.lesson.slice(0, 700), seeded: true }));
  const added = addLessons("studio-seed", "Studio starter knowledge", lessons);
  writeStore({ ...readStore(), seedVersion: SEED_VERSION });
  return added;
}

const hasStudied = (url) => loadAll().some((item) => item.source === url);

// A short description of what the studio already knows, so research can aim at gaps.
function knowledgeOutline() {
  const counts = new Map();
  for (const item of loadAll()) for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([tag, count]) => `${tag} (${count})`).join(", ");
}

const QUIZ_SYSTEM = `You are the exam setter for a game-development studio. Read the page and write 4 practical exam questions that test whether an engineer could apply what the page teaches when building a game (how to implement a technique, which rule or formula to use, what pitfall to avoid). Questions must be answerable from the page's content, self-contained, and not about the page itself or its author.
Return only JSON: { "questions": [ { "question": string, "answer": a correct, concrete 1-3 sentence reference answer, "tags": 2-4 lowercase keywords } ] }.`;

const STUDENT_SYSTEM = `You are a game developer sitting a closed-book exam. You may use ONLY the studio notes provided; you have not seen the original source. Answer each question as specifically as the notes allow. If the notes do not cover a question, say "not covered" rather than guessing.
Return only JSON: { "answers": [ { "id": number, "answer": string } ] } with one entry per question.`;

const GRADER_SYSTEM = `You grade a game-development exam. For each question compare the student's answer with the reference answer. pass is true only if the student's answer contains the key technique, numbers or rule from the reference and nothing that contradicts it. "not covered" fails.
Return only JSON: { "results": [ { "id": number, "pass": boolean } ] } with one entry per question.`;

async function sitExam(questions) {
  const notes = new Map();
  for (const item of questions) for (const note of pickLessons(`${item.question} ${item.tags.join(" ")}`, 5)) notes.set(note.id, note);
  const studyNotes = [...notes.values()].slice(0, 24).map((note) => `- ${note.topic ? `${note.topic}: ` : ""}${note.lesson}`).join("\n") || "(no notes)";
  const numbered = questions.map((item, id) => `${id}: ${item.question}`).join("\n");
  const taken = await askJson(STUDENT_SYSTEM, `Studio notes:\n${studyNotes}\n\nQuestions:\n${numbered}`, 2500);
  const answers = new Map((Array.isArray(taken.answers) ? taken.answers : []).map((entry) => [Number(entry.id), String(entry.answer || "")]));
  const graded = await askJson(GRADER_SYSTEM, questions.map((item, id) => `Question ${id}: ${item.question}\nReference answer: ${item.answer}\nStudent answer: ${answers.get(id) || "(no answer)"}`).join("\n\n"), 1500);
  const passed = new Map((Array.isArray(graded.results) ? graded.results : []).map((entry) => [Number(entry.id), entry.pass === true]));
  return questions.map((_, id) => passed.get(id) === true);
}

// Quizzes the team closed-book on a page it just studied, re-teaches anything it failed, and retests once.
async function drillPage(page, emit) {
  const quiz = await askJson(QUIZ_SYSTEM, `Page: ${page.title}\n\n${page.text.slice(0, PAGE_TEXT_FOR_MODEL)}`, 2500);
  const questions = (Array.isArray(quiz.questions) ? quiz.questions : [])
    .filter((item) => item && typeof item.question === "string" && typeof item.answer === "string" && item.answer.trim().length >= 15)
    .slice(0, 5)
    .map((item) => ({ question: item.question.trim(), answer: item.answer.trim(), tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => String(tag).toLowerCase().trim()).filter(Boolean).slice(0, 4) }));
  if (!questions.length) return null;
  emit({ type: "learn-log", level: "info", message: `Drilling the team on "${page.title || page.url}": ${questions.length} closed-book questions…` });
  const first = await sitExam(questions);
  const failed = questions.filter((_, index) => !first[index]);
  let final = first.filter(Boolean).length;
  if (failed.length) {
    emit({ type: "learn-log", level: "warn", message: `Missed ${failed.length} of ${questions.length}. Re-teaching those points and testing again…` });
    addLessons(page.url, page.title, failed.map((item) => ({ topic: item.question.slice(0, 80), tags: item.tags, lesson: item.answer.slice(0, 700), reinforced: true })));
    const retake = await sitExam(failed);
    final += retake.filter(Boolean).length;
  }
  const result = { source: page.url, title: page.title, asked: questions.length, passedFirst: first.filter(Boolean).length, passedFinal: final };
  recordExam(result);
  emit({ type: "learn-log", level: final === questions.length ? "ok" : "warn", message: `Exam result for "${page.title || page.url}": ${result.passedFirst}/${result.asked} first try, ${final}/${result.asked} after re-teaching.` });
  return result;
}

// Reads the given links (and, when asked, the pages they point to), distills them into lessons and stores them.
async function learnFromLinks(urls, { follow = true, drill = true, skipKnown = false, max = MAX_URLS, emit = () => {} } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, Math.min(max, MAX_CURRICULUM_PAGES));
  if (!list.length) throw new Error("Paste at least one link.");
  const summary = { pages: 0, lessons: 0, skipped: [], asked: 0, passedFinal: 0 };

  const study = async (target, label) => {
    if (skipKnown && loadAll().some((item) => item.source === target)) {
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

const STOP_WORDS = new Set("a an and are as at be but by for from game games has have i in into is it its make me my of on or that the their this to want with you your will can should".split(" "));
const words = (text) => normalize(text).split(" ").filter((word) => word.length > 2 && !STOP_WORDS.has(word));

function pickLessons(text, limit) {
  const items = loadAll();
  if (!items.length) return [];
  const query = new Set(words(text));
  return items.map((item) => {
    const haystack = new Set(words(`${item.topic} ${item.tags.join(" ")} ${item.lesson}`));
    let score = 0;
    for (const word of query) if (haystack.has(word)) score += item.tags.includes(word) ? 3 : 1;
    if (item.tags.includes("general")) score += 0.75;
    if (item.reinforced) score += 0.5;
    return { item, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.item);
}

// Picks the lessons most relevant to a game idea, within a size budget, for use inside prompts.
function relevantKnowledge(text, { limit = 16 } = {}) {
  const lines = [];
  let used = 0;
  for (const item of pickLessons(text, limit)) {
    const line = `- ${item.topic ? `${item.topic}: ` : ""}${item.lesson}`;
    if (used + line.length > KNOWLEDGE_BUDGET_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? `\n\nStudio knowledge (lessons the team studied and was tested on; actually apply every one that fits this game in the design and the code, ignore the rest):\n${lines.join("\n")}` : "";
}

const listKnowledge = () => loadAll().slice().reverse();

function knowledgeReport() {
  const { items, exams } = readStore();
  const asked = exams.reduce((sum, exam) => sum + exam.asked, 0);
  const passed = exams.reduce((sum, exam) => sum + exam.passedFinal, 0);
  return { lessons: items.length, sources: new Set(items.map((item) => item.source)).size, exams: exams.length, asked, passed };
}

function removeKnowledge(id) {
  const items = loadAll();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return false;
  saveAll(next);
  return true;
}

module.exports = { askJson, assertPublicUrl, fetchPage, hasStudied, htmlToText, installSeed, isPrivateAddress, knowledgeOutline, knowledgeReport, learnFromLinks, listKnowledge, relevantKnowledge, removeKnowledge };
