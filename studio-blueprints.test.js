const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { smokeTest } = require("./game-generator");
const { headless } = require("./blueprint-harness");

const engine = fs.readFileSync(path.join(__dirname, "studio-engine.js"), "utf8");
const kit = fs.readFileSync(path.join(__dirname, "studio-kit.js"), "utf8");
const blueprint = fs.readFileSync(path.join(__dirname, "studio-blueprints.js"), "utf8");
const build = (spec) => `${engine}\n${kit}\n${blueprint}\nBlueprint.run(${JSON.stringify(spec)});\n`;
const canvas = { width: 800, height: 560 };

const SPECS = {
  adventure: { type: "adventure", title: "Ember Vault", theme: "desert", weapon: "bow", floors: 2, enemies: [{ name: "Scarab", behavior: "charger" }, { name: "Mummy", behavior: "chase", hp: 3 }, { name: "Archer", behavior: "shooter" }], boss: { name: "Pharaoh", hp: 10 }, intro: ["Find the key."] },
  platformer: { type: "platformer", title: "Cloud Hopper", theme: "ocean", levels: 3, abilities: ["doubleJump"], enemies: [{ name: "Crab", behavior: "walker" }] },
  arena: { type: "arena", title: "Void Siege", theme: "neon", waves: 6, weapon: "spread", boss: { name: "Hive Queen" } },
  messy: { type: "adventure", title: 42, theme: "nope", accent: "red", floors: "lots", hearts: -4, weapon: 7, enemies: "none", boss: null, items: [null, 3] },
};

for (const [name, spec] of Object.entries(SPECS)) {
  test(`blueprint ${name} survives 3000 frames of mixed input`, () => {
    assert.equal(smokeTest(build(spec), canvas, 3000), null);
  });
}

test("blueprint rejects an unknown type", () => {
  assert.match(smokeTest(build({ type: "nonsense" }), canvas) || "", /Unknown blueprint type/);
});

const COLS = 15;
const ROWS = 10;
const TS = Math.floor(Math.min(800 / COLS, (560 - 44) / ROWS));

test("adventure floors are connected and every enemy and pickup is reachable", () => {
  for (const seed of [3, 4, 5, 6, 7, 11, 12]) {
    const game = headless({ ...SPECS.adventure, seed });
    game.tap(" ");
    game.step(2);
    const kit = game.run("Kit");
    const g = game.state();
    assert.equal(kit.gen.dungeonSolvable(g.d), true, `seed ${seed} dungeon is solvable`);
    for (let id = 0; id < g.d.cols * g.d.rows; id++) {
      const rm = game.debug().room(id);
      const seen = kit.gen.flood(rm.map, { x: 7, y: 5 }, (x, y) => kit.tiles.get(rm.map, x, y) === 0);
      const at = (px, py) => seen.has(Math.floor(py / TS) * COLS + Math.floor(px / TS));
      for (const dir of Object.keys(rm.gaps)) {
        const cell = dir === "left" ? [1, 4] : dir === "right" ? [COLS - 2, 4] : dir === "up" ? [6, 1] : [6, ROWS - 2];
        assert.ok(seen.has(cell[1] * COLS + cell[0]), `seed ${seed} room ${id} ${dir} exit reachable`);
      }
      for (const e of rm.enemies) assert.ok(at(e.x + e.w / 2, e.y + e.h / 2), `seed ${seed} room ${id} enemy reachable`);
      for (const it of rm.pickups) assert.ok(at(it.x, it.y), `seed ${seed} room ${id} ${it.kind} reachable`);
    }
  }
});

test("adventure can be played through: key, locked door, boss, stairs, victory", () => {
  const game = headless({ ...SPECS.adventure, seed: 5 });
  game.tap(" ");
  game.step(2);
  for (let i = 0; i < 6; i++) { game.tap(" "); game.step(40); }
  assert.equal(game.run("Kit.dialogue.active"), false, "the intro dialogue can be dismissed");
  const dbg = game.debug();
  const place = (x, y) => { const p = game.state().p; p.x = x - p.w / 2; p.y = y - p.h / 2; };
  const killBoss = () => {
    dbg.enterRoom(game.state().d.goal);
    const g = game.state();
    const boss = g.room.enemies.find((e) => e.boss);
    assert.ok(boss, "the goal room holds the boss");
    for (let f = 0; f < 6000 && g.room.enemies.length; f++) {
      g.p.health.hp = g.p.health.max;
      const target = g.room.enemies[0];
      g.p.x = target.x - g.p.w - 4;
      g.p.y = target.y + target.h / 2 - g.p.h / 2;
      g.p.facing = { x: 1, y: 0 };
      if (f % 25 === 0) game.tap(" ");
      game.step(1);
    }
    assert.equal(g.room.enemies.length, 0, "the boss can be defeated");
    const portal = g.room.pickups.find((it) => it.kind === "portal");
    assert.ok(portal, "defeating the boss opens the stairs");
    place(portal.x, portal.y);
    game.step(2);
  };
  let g = game.state();
  dbg.enterRoom(g.d.keyRoom);
  const key = g.room.pickups.find((it) => it.kind === "key");
  place(key.x, key.y);
  game.step(2);
  assert.equal(g.keys, 1, "the key is collected");
  const doorIndex = g.d.doors.findIndex((d) => d.locked);
  dbg.enterRoom(g.d.doors[doorIndex].a);
  const [cx, cy] = g.room.locks[0].cells[0];
  const p = g.p;
  p.x = cx === 0 ? TS : cx === COLS - 1 ? (COLS - 1) * TS - p.w : cx * TS + 4;
  p.y = cy === 0 ? TS : cy === ROWS - 1 ? (ROWS - 1) * TS - p.h : cy * TS + 4;
  game.step(2);
  assert.ok(g.unlocked.has(doorIndex), "the locked door opens with the key");
  killBoss();
  g = game.state();
  assert.equal(g.floor, 2, "the stairs lead to the next floor");
  killBoss();
  assert.equal(game.state().mode, "won");
});

test("platformer bot clears all levels on a seed and arena bot survives to the boss", () => {
  const plat = headless({ ...SPECS.platformer, seed: 3, enemies: [{ name: "c", behavior: "walker" }] });
  plat.tap(" ");
  plat.step(2);
  const kit = plat.run("Kit");
  for (let f = 0; f < 60 * 240 && plat.state().mode === "play"; f++) {
    const g = plat.state();
    const p = g.p;
    const map = g.lv.map;
    const col = Math.floor((p.x + p.w) / 32);
    const feet = Math.floor((p.y + p.h - 1) / 32);
    const solid = (c, r) => kit.tiles.isSolid(map, c, r);
    const edge = (p.x + p.w) % 32 > 20;
    const wantJump = p.onGround && (solid(col + 1, feet) || solid(col + 1, feet - 1) || (!solid(col + 1, feet + 1) && !solid(col + 2, feet + 1) && edge) || (kit.tiles.get(map, col + 1, feet) === 3 && edge) || g.lv.enemies.some((e) => e.alive && e.x > p.x && e.x - p.x < 90 && Math.abs(e.y - p.y) < 60));
    plat.hold(wantJump || (!p.onGround && p.vy < 0) ? ["ArrowRight", " "] : ["ArrowRight"]);
    plat.step(1);
  }
  assert.equal(plat.state().mode, "won", "the platformer levels can be completed");

  const arena = headless({ ...SPECS.arena, seed: 1 });
  arena.tap(" ");
  arena.step(2);
  let picks = 0;
  for (let f = 0; f < 60 * 240 && arena.state().mode === "play"; f++) {
    const g = arena.state();
    if (g.choosing) { arena.hold([]); arena.tap(" "); picks++; arena.step(1); continue; }
    const p = g.p;
    let near = null;
    let best = 1e9;
    for (const e of g.enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < best) { best = d; near = e; } }
    const keys = [];
    const goal = near && best < 140 ? { x: p.x * 2 - near.x, y: p.y * 2 - near.y } : g.gems[0] || { x: 400, y: 280 };
    if (goal.x > p.x + 8) keys.push("ArrowRight"); else if (goal.x < p.x - 8) keys.push("ArrowLeft");
    if (goal.y > p.y + 8) keys.push("ArrowDown"); else if (goal.y < p.y - 8) keys.push("ArrowUp");
    arena.hold(keys);
    arena.step(1);
  }
  assert.ok(picks >= 3, "level-up upgrades are offered and chosen");
  assert.ok(arena.state().wave >= 5, "the waves progress up to the boss");
});