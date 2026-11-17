const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MEMORY_FILE = path.join(__dirname, "data", "studio-memory.json");
let writeQueue = Promise.resolve();
let cachedMemoryFile = "";
let cachedMemorySignature = "";
let cachedMemory = null;

function getMemoryFile() {
  return process.env.STUDIO_MEMORY_PATH || DEFAULT_MEMORY_FILE;
}

async function readLearnings(memoryFile = getMemoryFile()) {
  const journal = `${memoryFile}.jsonl`;
  try {
    const stat = await fs.stat(journal);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (cachedMemoryFile === journal && cachedMemorySignature === signature && cachedMemory) return cachedMemory;
    const text = await fs.readFile(journal, "utf8");
    const learnings = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "lesson" && event.item && typeof event.item.lesson === "string") learnings.push(event.item);
      } catch { /* a torn last line is ignored; the legacy JSON remains recoverable */ }
    }
    learnings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    cachedMemoryFile = journal;
    cachedMemorySignature = signature;
    cachedMemory = learnings;
    return learnings;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let contents;
  try {
    contents = await fs.readFile(memoryFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  let data;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error("Studio memory contains invalid JSON.", { cause: error });
  }

  if (data === null || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.learnings)) {
    throw new Error("Studio memory has an unsupported or invalid format.");
  }

  for (const item of data.learnings) {
    if (
      typeof item.lesson !== "string"
      || item.lesson.length < 20
      || typeof item.createdAt !== "string"
    ) {
      throw new Error("Studio memory contains an invalid learning entry.");
    }
  }
  return data.learnings;
}

async function writeLearnings(learnings, memoryFile) {
  const existing = await readLearnings(memoryFile);
  const seen = new Set();
  const existingKeys = new Set(existing.map((item) => item.lesson.toLocaleLowerCase()));
  const additions = [...learnings].filter((item) => {
    const key = item.lesson.toLocaleLowerCase();
    if (seen.has(key) || existingKeys.has(key)) return false;
    seen.add(key);
    return true;
  });
  const journal = `${memoryFile}.jsonl`;
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  try { await fs.access(journal); } catch {
    const initial = existing.map((item) => JSON.stringify({ type: "lesson", item }));
    await fs.writeFile(journal, `${initial.join("\n")}${initial.length ? "\n" : ""}`, { encoding: "utf8", flag: "wx" });
  }
  if (additions.length) await fs.appendFile(journal, `${additions.map((item) => JSON.stringify({ type: "lesson", item })).join("\n")}\n`, "utf8");
  const combined = [...additions, ...existing].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const stat = await fs.stat(journal);
  cachedMemoryFile = journal;
  cachedMemorySignature = `${stat.size}:${stat.mtimeMs}`;
  cachedMemory = combined;
  return combined;
}

function saveLearnings(lessons, memoryFile = getMemoryFile()) {
  if (!Array.isArray(lessons)) return Promise.reject(new Error("Expected a list of reusable studio learnings."));
  for (const lesson of lessons) {
    if (
      typeof lesson !== "string"
      || lesson.trim().length < 20
    ) {
      return Promise.reject(new Error("A studio learning is outside the allowed length."));
    }
  }

  const entries = lessons.map((lesson) => ({
    lesson: lesson.trim(),
    createdAt: new Date().toISOString(),
  }));
  const save = writeQueue.then(
    () => writeLearnings(entries, memoryFile),
    () => writeLearnings(entries, memoryFile),
  );
  writeQueue = save.then(() => undefined, () => undefined);
  return save;
}

const MEMORY_STOP = new Set("a an and are as at be but by for from game games has have i in into is it its make me my of on or that the their this to want with you your will can should build create player players".split(" "));
function selectRelevantLearnings(learnings, brief, { limit = 12, budget = 3_000 } = {}) {
  const query = new Set(String(brief || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !MEMORY_STOP.has(word)));
  const ranked = learnings.map((item) => {
    const text = String(item.lesson || "").toLowerCase();
    const tokens = new Set(text.split(/[^a-z0-9]+/).filter((word) => word.length > 2));
    let score = 0;
    for (const word of query) if (tokens.has(word)) score += 1;
    return { item, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const selected = [];
  let used = 0;
  for (const { item } of ranked) {
    const line = `- ${item.lesson}`;
    if (used + line.length > budget) continue;
    selected.push(item);
    used += line.length;
    if (selected.length >= limit) break;
  }
  return selected;
}

module.exports = { getMemoryFile, readLearnings, saveLearnings, selectRelevantLearnings };
