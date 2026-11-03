const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_LEARNINGS = 12;
const MAX_LEARNING_LENGTH = 240;
const DEFAULT_MEMORY_FILE = path.join(__dirname, "data", "studio-memory.json");
let writeQueue = Promise.resolve();

function getMemoryFile() {
  return process.env.STUDIO_MEMORY_PATH || DEFAULT_MEMORY_FILE;
}

async function readLearnings(memoryFile = getMemoryFile()) {
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
      || item.lesson.length > MAX_LEARNING_LENGTH
      || typeof item.createdAt !== "string"
    ) {
      throw new Error("Studio memory contains an invalid learning entry.");
    }
  }
  return data.learnings.slice(0, MAX_LEARNINGS);
}

async function writeLearnings(learnings, memoryFile) {
  const existing = await readLearnings(memoryFile);
  const seen = new Set();
  const combined = [...learnings, ...existing].filter((item) => {
    const key = item.lesson.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_LEARNINGS);

  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  const temporaryFile = `${memoryFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify({ version: 1, learnings: combined }, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryFile, memoryFile);
  return combined;
}

function saveLearnings(lessons, memoryFile = getMemoryFile()) {
  if (!Array.isArray(lessons) || lessons.length < 1 || lessons.length > 3) {
    return Promise.reject(new Error("Expected between one and three studio learnings."));
  }
  for (const lesson of lessons) {
    if (
      typeof lesson !== "string"
      || lesson.trim().length < 20
      || lesson.trim().length > MAX_LEARNING_LENGTH
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

module.exports = { getMemoryFile, readLearnings, saveLearnings };
