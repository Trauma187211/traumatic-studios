const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { crc32 } = require("./project-zip");
const { createDemoPrototype, projectArchive } = require("./project-builder");

async function collect(chunks) {
  const parts = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

// Reads the archive back through the central directory, the way real unzip tools do, verifying sizes and CRCs.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory present");
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50);
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressed = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, size, `${name} size`);
    assert.equal(crc32(data), crc, `${name} crc`);
    files[name] = data;
    pos += 46 + nameLength;
  }
  return files;
}

test("a project downloads as a valid zip with every file intact, including nested folders", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { id } = await createDemoPrototype({ projectsDir: dir });
  const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256));
  await fs.mkdir(path.join(dir, id, "web"));
  await fs.writeFile(path.join(dir, id, "web", "index.pck"), binary);
  await fs.writeFile(path.join(dir, id, "web", "ünï.txt"), "héllo");

  const archive = await projectArchive(id, dir);
  assert.equal(archive.filename, `${id}.zip`);
  const files = readZip(await collect(archive.chunks));

  for (const name of ["index.html", "game.js", "game.css"]) {
    assert.deepEqual(files[name], await fs.readFile(path.join(dir, id, name)), name);
  }
  assert.deepEqual(files["web/index.pck"], binary);
  assert.equal(files["web/ünï.txt"].toString(), "héllo");
  assert.match(files["README.txt"].toString(), /index\.html/);
  assert.equal(files["project.json"], undefined);
});

test("download rejects unknown or malicious project ids", async () => {
  for (const bad of ["../etc", "game-1-zzzzzzzz", "game-1-abcdef12"]) {
    await assert.rejects(projectArchive(bad), { code: "ENOENT" });
  }
});
