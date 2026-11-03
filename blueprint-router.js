// Blueprint route: instead of asking a small model to write thousands of lines of game code, ask it for a compact JSON spec
// and run that spec on the pre-tested blueprint runtime (studio-blueprints.js).
const fs = require("node:fs");
const path = require("node:path");

const BLUEPRINT_SOURCE = fs.readFileSync(path.join(__dirname, "studio-blueprints.js"), "utf8");
const TYPES = ["adventure", "platformer", "arena"];

const ROUTER_SYSTEM = `You are a game designer who turns any game idea into a JSON game spec for the studio's pre-built engine templates. Pick the template whose CORE PLAY best matches the idea, then fill in rich, original, specific flavour (names, story, enemies, items, colours) taken from the idea. Never use generic placeholder names.

Templates:
- "adventure": top-down exploration of connected rooms or screens with keys, locked doors, melee or ranged combat, enemies with distinct AI, hearts, a boss, several floors (Zelda, dungeon crawlers, action RPGs, roguelike dungeons, horror exploration, quest games).
- "platformer": side-view running and jumping through levels with coins, stompable enemies, spikes, pits, checkpoints and a goal flag (Mario, Sonic, Celeste and similar).
- "arena": survive escalating waves in one screen; automatic firing, XP gems, level-up upgrade choices, bosses (Vampire Survivors, bullet hell, twin-stick and space shooters, horde survival).
- "custom": ONLY when the core play is none of these (puzzle, card or board game, racing, rhythm, Snake/Pong/Breakout style classics, text game, strategy, simulation, tower defense).

Reply with ONE JSON object only. Every template accepts: type, title (max 40 chars), tagline, theme (one of forest, dungeon, desert, ocean, neon, snow), accent (#rrggbb), hero, intro (3 to 5 short story lines), outro (2 short lines), seed (integer).
- adventure adds: floors (1-5), hearts (3-8), weapon ("sword","bow" or "wand"), keyName, enemies (3-5 of {name, color, hp 1-6, speed 30-140, behavior one of "chase","wander","charger","shooter","patrol"}), boss {name, color, hp 8-40}, items (3-5 of {name, effect one of "heal","power","speed","shield", color}).
- platformer adds: levels (1-6), lives (2-6), abilities (e.g. ["doubleJump"]), collectible (e.g. "Star"), enemies (2-4 of {name, color, behavior one of "walker","flyer","jumper"}).
- arena adds: waves (3-20), weapon ("blaster","spread" or "nova"), enemies (3-5 of {name, color, behavior one of "drifter","zigzag","charger","shooter","splitter"}), boss {name, color}.
Example: {"type":"adventure","title":"Moonwell Depths","tagline":"Descend, steal the Moon Shard.","theme":"dungeon","accent":"#7fdbff","hero":"Ilsa","weapon":"sword","floors":3,"hearts":5,"keyName":"Moon Key","enemies":[{"name":"Glow Slime","color":"#58d68d","hp":2,"speed":50,"behavior":"wander"},{"name":"Bone Archer","color":"#d5d8dc","hp":2,"speed":45,"behavior":"shooter"}],"boss":{"name":"The Drowned King","color":"#2874a6","hp":18},"items":[{"name":"Tide Potion","effect":"heal","color":"#5dade2"}],"intro":["The well hums at midnight.","Something below is calling you."],"outro":["The shard glows in your hands."],"seed":4711}
If the idea does not fit a template return {"type":"custom"}.`;

// Returns { type, spec } for a template, or null when the idea needs freeform code.
async function routeBlueprint({ chat, parseJson }, brief, handoff, knowledge = "") {
  const reply = await chat([
    { role: "system", content: ROUTER_SYSTEM },
    { role: "user", content: `Game idea from the user (the authority on what to build):\n${brief}\n\nTeam handoff notes (advisory):\n${handoff}${knowledge}\n\nReturn the JSON spec.` },
  ], { json: true, temperature: 0.7, maxTokens: 3000 });
  const spec = parseJson(reply);
  if (!spec || typeof spec !== "object" || !TYPES.includes(String(spec.type || "").toLowerCase())) return null;
  spec.type = String(spec.type).toLowerCase();
  return { type: spec.type, spec };
}

const CONTROLS = {
  adventure: ["Move: arrows / WASD", "Attack: Space / J"],
  platformer: ["Run: arrows / A D", "Jump: Space / W / Up"],
  arena: ["Move: arrows / WASD", "Auto-fire; choose upgrades with 1/2/3 or click"],
};

// A design object shaped like the freeform one, so the shell, tasks and saving code stay unchanged.
function designFor({ type, spec }, palettes) {
  const theme = palettes[String(spec.theme || "").toLowerCase()] || palettes[type === "platformer" ? "forest" : type === "arena" ? "neon" : "dungeon"];
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent || "") ? spec.accent : theme[5];
  const title = typeof spec.title === "string" && spec.title.trim() ? spec.title.trim().slice(0, 40) : "Untitled Game";
  return {
    title,
    genre: type,
    summary: typeof spec.tagline === "string" ? spec.tagline.slice(0, 120) : "",
    canvas: { width: 800, height: 560 },
    palette: { bg: theme[0], panel: theme[1], accent, text: theme[4], danger: "#ff5d5d" },
    controls: CONTROLS[type],
    mustNotBe: [],
    modules: [{ name: "blueprint" }, { name: "main" }],
    tasks: [
      { title: "Tune difficulty and pacing", owner: "Game designer", description: "Play two full runs and adjust enemy hp, speed and spawn counts so the opening is fair and the ending is tense." },
      { title: "Add a signature mechanic", owner: "Gameplay engineer", description: `Add one mechanic unique to "${title}" on top of the ${type} template, using Engine and Kit.` },
      { title: "Test restart and edge cases", owner: "QA tester", description: "Check restart after winning and losing, pausing during dialogue, and keyboard plus pointer input." },
    ],
  };
}

module.exports = { BLUEPRINT_SOURCE, ROUTER_SYSTEM, TYPES, designFor, routeBlueprint };
