// Blueprint route: instead of asking a small model to write thousands of lines of game code, ask it for a compact JSON spec
// and run that spec on the pre-tested blueprint runtime (studio-blueprints.js).
const fs = require("node:fs");
const path = require("node:path");

const BLUEPRINT_SOURCE = fs.readFileSync(path.join(__dirname, "studio-blueprints.js"), "utf8");
const TYPES = ["adventure", "platformer", "arena", "isometric_2_5d", "fps_3d", "puzzle", "strategy", "custom"];

const ROUTER_SYSTEM = `You are an imaginative game designer for Traumatic Studios. Your task is to turn any game idea into a rich JSON game spec. 
CRITICAL RULE: The built-in templates are flexible architectural GUIDELINES and starting points, NOT strict limits. You are fully empowered to push beyond retro arcade styles into modern 2D, 2.5D (isometric/layered), and 3D-oriented concepts whenever the game idea calls for it.

Templates & Styles (use as baseline references, adapt freely):
- "adventure": top-down or exploratory action RPGs with rooms, keys, combat, items, and bosses (Zelda-style, dungeon crawlers, horror exploration). Can be styled in 2D or 2.5D depth.
- "platformer": side-view running, jumping, collectibles, hazards, and goals (Mario, Sonic, modern platforming). Can incorporate 2.5D parallax or depth layers.
- "arena": survival wave combat, auto-firing/upgrades, bosses (Vampire Survivors, horde survival, twin-stick action).
- "isometric_2_5d": 2.5D perspective games featuring depth sorting, isometric or oblique angles, tactical positioning, layered environments, and rich visual atmosphere.
- "fps_3d": First-person or 3D perspective exploration, immersive action, or atmospheric 3D rooms/arenas.
- "puzzle" / "strategy": Brain teasers, grid-based logic, resource management, or tactical placement games.
- "custom": Any unique genre, mechanic, or hybrid style that doesn't fit standard templates.

Reply with ONE JSON object only. Every template accepts: type, title (max 40 chars), tagline, theme (one of forest, dungeon, desert, ocean, neon, snow, cyberpunk, ethereal), accent (#rrggbb), hero, perspective ("2d", "25d", or "3d"), intro (3 to 5 short story lines), outro (2 short lines), seed (integer).
- adventure adds: floors (1-5), hearts (3-8), weapon ("sword","bow","wand","magic"), keyName, enemies (3-5 of {name, color, hp, speed, behavior}), boss {name, color, hp}, items (3-5 of {name, effect, color}).
- platformer adds: levels (1-6), lives (2-6), abilities (array), collectible, enemies (2-4).
- arena adds: waves (3-20), weapon, enemies, boss.
- isometric_2_5d / fps_3d adds: scope ("room","corridor","open_zone"), lighting ("dynamic","moody","bright"), objectives (array), enemies (3-5).
Example: {"type":"isometric_2_5d","title":"Neon Bastion","tagline":"Defend the grid from isometric angles.","theme":"cyberpunk","accent":"#00ffcc","perspective":"25d","hero":"Kira","intro":["The grid is failing.","Secure the terminal."],"outro":["Bastion secured."],"seed":1337}
Always use rich, original flavour. Never use generic placeholders.`;

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
  isometric_2_5d: ["Move: WASD / Arrow Keys", "Interact / Action: Space / E", "Rotate / View: Q / E"],
  fps_3d: ["Move: WASD", "Look: Mouse / Arrow Keys", "Shoot / Action: Left Click / Space"],
  puzzle: ["Select / Move: Mouse / Arrow Keys", "Confirm: Enter / Space"],
  strategy: ["Command / Place: Mouse", "Speed / Menu: Space / Number keys"],
  custom: ["Controls vary by game design"]
};

// A design object shaped like the freeform one, so the shell, tasks and saving code stay unchanged.
function designFor({ type, spec }, palettes) {
  const themeKey = String(spec.theme || "").toLowerCase();
  const theme = palettes[themeKey] || palettes["neon"] || palettes["dungeon"];
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent || "") ? spec.accent : theme[5];
  const title = typeof spec.title === "string" && spec.title.trim() ? spec.title.trim().slice(0, 40) : "Untitled Game";
  const perspective = spec.perspective || (type === "isometric_2_5d" ? "25d" : type === "fps_3d" ? "3d" : "2d");
  
  return {
    title,
    genre: `${type} (${perspective})`,
    summary: typeof spec.tagline === "string" ? spec.tagline.slice(0, 120) : "",
    canvas: { width: 800, height: 560 },
    palette: { bg: theme[0], panel: theme[1], accent, text: theme[4], danger: "#ff5d5d" },
    controls: CONTROLS[type] || CONTROLS.custom,
    mustNotBe: [],
    modules: [{ name: "blueprint" }, { name: "main" }],
    tasks: [
      { title: "Tune difficulty and pacing", owner: "Game designer", description: `Play through the core loop of "${title}" and adjust balance, spacing, and enemy parameters for optimal ${perspective} flow.` },
      { title: "Add a signature mechanic", owner: "Gameplay engineer", description: `Implement a distinct gameplay feature that enhances the ${perspective} perspective and genre style.` },
      { title: "Test edge cases and polish", owner: "QA tester", description: "Verify state transitions, restart loops, and input responsiveness across all game states." },
    ],
  };
}

module.exports = { BLUEPRINT_SOURCE, ROUTER_SYSTEM, TYPES, designFor, routeBlueprint };