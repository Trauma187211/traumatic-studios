const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function rngFactory(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (a, b) => Math.floor(a + next() * (b - a + 1)),
    chance: (p) => next() < p,
    pick: (l) => l[Math.floor(next() * l.length)],
    shuffle: (l) => { for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; },
  };
}

const source = fs.readFileSync(path.join(__dirname, "studio-kit.js"), "utf8");
const Kit = vm.runInNewContext(`${source}\nKit`, { Math, Map, Set, Array, Object, JSON, parseInt, setTimeout: () => 0 });
const rng = rngFactory;

test("tilemap collision stops bodies at walls without tunnelling", () => {
  const map = Kit.tiles.fromRows(["#####", "#...#", "#...#", "#####"], 32);
  const body = { x: 40, y: 40, w: 16, h: 16 };
  const hit = Kit.tiles.move(map, body, 500, 0);
  assert.equal(hit.x, 1);
  assert.equal(body.x, 4 * 32 - 16);
  Kit.tiles.move(map, body, 0, -900);
  assert.equal(body.y, 32);
  assert.equal(Kit.tiles.overlaps(map, body), false);
});

test("platformer lands, jumps with coyote time and buffering, and cuts short jumps", () => {
  const map = Kit.tiles.fromRows(["#####", "#...#", "#...#", "#...#", "#####"], 32);
  const b = { x: 40, y: 40, w: 16, h: 16 };
  for (let i = 0; i < 90; i++) Kit.platformer(b, { x: 0 }, 1 / 60, map);
  assert.equal(b.onGround, true);
  assert.equal(b.y + b.h, 4 * 32);
  const floorY = b.y;
  Kit.platformer(b, { x: 0, jumpPressed: true, jumpHeld: true }, 1 / 60, map);
  assert.ok(b.vy < 0, "jump started");
  let peakHeld = floorY;
  for (let i = 0; i < 40; i++) { Kit.platformer(b, { x: 0, jumpHeld: true }, 1 / 60, map); peakHeld = Math.min(peakHeld, b.y); }
  const c = { x: 40, y: floorY, w: 16, h: 16, onGround: true };
  let peakCut = floorY;
  Kit.platformer(c, { x: 0, jumpPressed: true, jumpHeld: true }, 1 / 60, map);
  for (let i = 0; i < 40; i++) { Kit.platformer(c, { x: 0, jumpHeld: false }, 1 / 60, map); peakCut = Math.min(peakCut, c.y); }
  assert.ok(peakCut > peakHeld, "releasing early gives a lower jump");
  // coyote: walk off nothing, but jump pressed just after leaving the ground still works
  const d = { x: 40, y: floorY, w: 16, h: 16, onGround: true };
  Kit.platformer(d, { x: 0 }, 1 / 60, map);
  d.onGround = false;
  const result = Kit.platformer(d, { x: 0, jumpPressed: true, jumpHeld: true }, 1 / 60, map);
  assert.equal(result.jumped, true);
});

test("top-down movement slides along walls and normalises diagonals", () => {
  const map = Kit.tiles.fromRows(["#######", "#.....#", "#.....#", "#######"], 32);
  const b = { x: 40, y: 40, w: 16, h: 16 };
  for (let i = 0; i < 60; i++) Kit.topdown(b, { x: 1, y: 1 }, 1 / 60, map, { speed: 100 });
  assert.equal(Kit.tiles.overlaps(map, b), false);
  const e = { x: 40, y: 40, w: 8, h: 8 };
  for (let i = 0; i < 10; i++) Kit.topdown(e, { x: 1, y: 1 }, 1 / 60, map, { speed: 100, accel: 1e6 });
  assert.ok(Math.abs(Math.hypot(e.vx, e.vy) - 100) < 1);
});

test("A*, flow fields and line of sight agree with the map", () => {
  const map = Kit.tiles.fromRows(["#######", "#..#..#", "#..#..#", "#.....#", "#######"], 32);
  const p = Kit.path.astar(map, { x: 1, y: 1 }, { x: 5, y: 1 });
  assert.ok(p && p[0].x === 1 && p[p.length - 1].x === 5);
  assert.equal(p.length, 9);
  assert.equal(Kit.path.astar(map, { x: 1, y: 1 }, { x: 3, y: 1 }), null);
  const field = Kit.path.flow(map, { x: 5, y: 1 });
  let cell = { x: 1, y: 1 };
  for (let i = 0; i < 20 && field.d[cell.y * map.w + cell.x] > 0; i++) cell = Kit.path.next(field, cell.x, cell.y);
  assert.equal(`${cell.x},${cell.y}`, "5,1");
  assert.equal(Kit.steer.sees(map, { x: 48, y: 48 }, { x: 176, y: 48 }, 400), false);
  assert.equal(Kit.steer.sees(map, { x: 48, y: 112 }, { x: 176, y: 112 }, 400), true);
});

test("generated levels are always fully connected", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { map, centers } = Kit.gen.rooms(rng(seed), 48, 36, { rooms: 8 });
    const seen = Kit.gen.flood(map, centers[0], (x, y) => !Kit.tiles.isSolid(map, x, y));
    centers.forEach((c) => assert.ok(seen.has(c.y * map.w + c.x), `room reachable (seed ${seed})`));
    const cave = Kit.gen.cave(rng(seed), 48, 36);
    const open = cave.map.cells.filter((v) => v === 0).length;
    assert.equal(open, cave.openCount, "cave keeps a single region");
    const maze = Kit.gen.maze(rng(seed), 21, 15);
    const reach = Kit.gen.flood(maze.map, maze.start, (x, y) => !Kit.tiles.isSolid(maze.map, x, y));
    assert.equal(reach.size, maze.map.cells.filter((v) => v === 0).length);
    assert.ok(reach.has(maze.end.y * maze.map.w + maze.end.x));
  }
});

test("lock-and-key dungeons are always solvable and the key is found before the door", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const d = Kit.gen.dungeon(rng(seed), 4, 3);
    assert.equal(Kit.gen.dungeonSolvable(d), true, `seed ${seed}`);
    assert.equal(d.doors.length, 11, "spanning tree over 12 rooms");
  }
});

test("health i-frames, timers, tweens and state machines behave", () => {
  const hp = Kit.health(3, { invuln: 1 });
  assert.equal(hp.hurt(1), true);
  assert.equal(hp.hurt(1), false);
  hp.update(1.1);
  assert.equal(hp.hurt(5), true);
  assert.equal(hp.alive(), false);
  const t = Kit.timer(0.5);
  assert.equal(t.update(0.3), false);
  assert.equal(t.update(0.3), true);
  const tw = Kit.tween(0, 10, 1, Kit.ease.linear);
  tw.update(0.5);
  assert.equal(tw.value, 5);
  tw.update(1);
  assert.equal(tw.done, true);
  const log = [];
  const m = Kit.fsm({ a: { enter: () => log.push("a+"), exit: () => log.push("a-") }, b: { enter: () => log.push("b+") } }, "a");
  m.go("b");
  assert.equal(log.join(" "), "a+ a- b+");
});

test("music composition is deterministic and stays in range", () => {
  const a = Kit.music.compose(rng(5), { scale: "dorian", bars: 4 });
  const b = Kit.music.compose(rng(5), { scale: "dorian", bars: 4 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.lead.length > 10 && a.bass.length === 16);
  [...a.lead, ...a.bass].forEach((n) => assert.ok(n.midi > 20 && n.midi < 110 && n.step < a.steps));
  assert.equal(Kit.music.play(a), false, "no WebAudio here, and it does not throw");
});

test("dialogue types out and finishes", () => {
  const dialogue = Kit.dialogue;
  let done = false;
  dialogue.open(["Hello there.", "Bye."], () => { done = true; });
  dialogue.update(10, false);
  dialogue.update(0, true);
  dialogue.update(10, false);
  dialogue.update(0, true);
  assert.equal(done, true);
  assert.equal(dialogue.active, false);
});
