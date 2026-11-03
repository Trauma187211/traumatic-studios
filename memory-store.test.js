const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readLearnings, saveLearnings } = require("./memory-store");

async function makeMemoryFile(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traumatic-memory-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "studio-memory.json");
}

test("keeps only the twelve newest unique reusable lessons", async (context) => {
  const memoryFile = await makeMemoryFile(context);

  for (let start = 0; start < 15; start += 3) {
    const lessons = Array.from(
      { length: 3 },
      (_, index) => `Reusable studio practice number ${String(start + index).padStart(2, "0")}.`,
    );
    await saveLearnings(lessons, memoryFile);
  }

  const saved = await readLearnings(memoryFile);
  assert.equal(saved.length, 12);
  const expectedNumbers = [12, 13, 14, 9, 10, 11, 6, 7, 8, 3, 4, 5];
  assert.deepEqual(
    saved.map(({ lesson }) => lesson),
    expectedNumbers.map((number) => `Reusable studio practice number ${String(number).padStart(2, "0")}.`),
  );
});

test("surfaces studio-memory corruption instead of treating it as empty memory", async (context) => {
  const memoryFile = await makeMemoryFile(context);
  await fs.writeFile(memoryFile, "{invalid", "utf8");

  await assert.rejects(readLearnings(memoryFile), /Studio memory contains invalid JSON/);
});
