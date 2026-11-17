/**
 * Well-known games the user may name in a brief ("like Pac-Man", "a Doom-style shooter").
 * Each entry maps the game's core loop onto what the Director can build, so the named game becomes a real reference.
 * Add entries freely: { names: [lowercase aliases], dimension, loop, signature: [what makes it itself], gameplay: {...}, note }.
 * Titles that are not here are described by the model instead (see describeUnknownGames in game-generator.js).
 */
const GAMES = [
  { names: ["pac-man", "pacman", "pac man"], dimension: "2d", loop: "eat every dot in a maze while four ghosts hunt you", signature: ["dots everywhere in a maze", "ghosts that chase", "a few power pellets that flip the chase"], gameplay: { goal: { type: "collect", label: "dots", count: 12 }, threat: { type: "chasers", label: "ghost", count: 4, speed: "normal", sight: "long" }, player: { health: 1 } } },
  { names: ["legend of zelda", "zelda"], dimension: "2d", loop: "explore a dungeon, find keys, open locked doors, reach the boss room", signature: ["keys and locked doors", "sword combat", "hearts as health", "rooms that guard secrets"], gameplay: { goal: { type: "keys", label: "keys", count: 3 }, threat: { type: "patrol", label: "guardian", count: 4, speed: "normal", sight: "short" }, player: { shoots: true, health: 5 } } },
  { names: ["diablo", "path of exile", "torchlight"], dimension: "2.5d", loop: "fight through hordes in an isometric dungeon for loot and power", signature: ["packs of enemies", "click-to-attack combat", "danger in every corner"], gameplay: { goal: { type: "defeat", label: "demons", count: 8 }, threat: { type: "chasers", label: "demon", count: 4, speed: "normal", sight: "normal" }, player: { shoots: true, health: 5 } } },
  { names: ["hades", "dead cells", "enter the gungeon"], dimension: "2.5d", loop: "clear rooms of enemies with fast, readable combat, then move on", signature: ["fast dodging", "waves in a room", "constant pressure"], gameplay: { goal: { type: "defeat", label: "shades", count: 8 }, threat: { type: "chasers", label: "shade", count: 4, speed: "fast", sight: "long" }, player: { shoots: true, health: 4 } } },
  { names: ["vampire survivors", "brotato", "survivor.io"], dimension: "2d", loop: "survive an ever-growing swarm until the timer runs out", signature: ["huge swarms", "constant movement", "survive until dawn"], gameplay: { goal: { type: "survive", seconds: 120 }, threat: { type: "chasers", label: "swarmer", count: 7, speed: "slow", sight: "long" }, player: { shoots: true, health: 5 } } },
  { names: ["doom", "quake", "duke nukem", "unreal tournament"], dimension: "3d", loop: "run and gun through arenas, killing every enemy", signature: ["fast movement", "hitscan shooting", "enemies rushing you", "a crosshair"], gameplay: { goal: { type: "defeat", label: "demons", count: 8 }, threat: { type: "chasers", label: "demon", count: 4, speed: "normal", sight: "long" }, player: { shoots: true, health: 5 } } },
  { names: ["counter-strike", "counter strike", "call of duty", "battlefield", "half-life", "half life"], dimension: "3d", loop: "first-person gunfights against enemy soldiers", signature: ["aim and shoot", "cover pillars", "enemies that hunt you"], gameplay: { goal: { type: "defeat", label: "soldiers", count: 6 }, threat: { type: "chasers", label: "soldier", count: 3, speed: "normal", sight: "long" }, player: { shoots: true, health: 4 } } },
  { names: ["slender man", "slenderman", "slender: the eight pages", "slender the eight pages"], dimension: "3d", loop: "gather eight pages in a dark forest while something silent stalks you", signature: ["darkness", "collect pages", "a stalker that closes in", "no weapons"], gameplay: { goal: { type: "collect", label: "pages", count: 8 }, threat: { type: "chasers", label: "stalker", count: 1, speed: "slow", sight: "long" }, player: { health: 1 } } },
  { names: ["amnesia", "outlast", "alien isolation", "resident evil", "silent hill"], dimension: "3d", loop: "creep through a hostile place, find what opens the way out, avoid what hunts you", signature: ["fear over combat", "keys and locked exits", "monsters that patrol"], gameplay: { goal: { type: "keys", label: "keys", count: 3 }, threat: { type: "patrol", label: "monster", count: 2, speed: "normal", sight: "normal" }, player: { health: 2 } } },
  { names: ["five nights at freddy's", "five nights at freddys", "fnaf"], dimension: "3d", loop: "survive the night against animatronics that close in", signature: ["a timer until dawn", "threats that approach steadily", "tension over action"], gameplay: { goal: { type: "survive", seconds: 120 }, threat: { type: "chasers", label: "animatronic", count: 3, speed: "slow", sight: "long" }, player: { health: 1 } } },
  { names: ["the backrooms", "backrooms"], dimension: "3d", loop: "wander an endless yellow maze looking for the exit while something follows", signature: ["a maze of identical rooms", "an exit to find", "an entity that hunts you"], gameplay: { goal: { type: "exit", label: "exit" }, threat: { type: "chasers", label: "entity", count: 1, speed: "normal", sight: "long" }, player: { health: 1 } } },
  { names: ["minecraft"], dimension: "3d", loop: "gather resources, build shelter out of blocks, and survive the night against monsters", signature: ["blocky world", "placing and breaking blocks", "monsters at night", "stacking blocks to climb"], gameplay: { goal: { type: "build", label: "blocks", count: 5 }, threat: { type: "chasers", label: "creeper", count: 3, speed: "normal", sight: "normal" }, player: { shoots: false, health: 5, jumps: true, builds: true } }, note: "no terrain generation or crafting; blocks are placed and broken one at a time" },
  { names: ["terraria", "starbound"], dimension: "2d", loop: "explore a scrolling world, fight what attacks you, collect what you find", signature: ["side-on exploration", "collecting", "enemies that patrol"], gameplay: { view: "side", goal: { type: "collect", label: "ore", count: 10 }, threat: { type: "patrol", label: "slime", count: 5, speed: "normal" }, player: { health: 4, jumps: true } } },
  { names: ["dark souls", "elden ring", "bloodborne"], dimension: "3d", loop: "cautious, punishing combat against few tough enemies", signature: ["few but dangerous enemies", "low health", "patient fights"], gameplay: { goal: { type: "defeat", label: "knights", count: 4 }, threat: { type: "chasers", label: "knight", count: 2, speed: "slow", sight: "normal", hp: 3 }, player: { shoots: true, health: 3 } } },
  { names: ["left 4 dead", "world war z", "dead rising", "zombies"], dimension: "3d", loop: "hold out against waves of zombies", signature: ["swarms", "survive until rescue", "shooting"], gameplay: { goal: { type: "survive", seconds: 100 }, threat: { type: "chasers", label: "zombie", count: 6, speed: "slow", sight: "long" }, player: { shoots: true, health: 4 } } },
  { names: ["super mario", "mario bros", "mario"], dimension: "2d", loop: "run and jump through a scrolling level, stomp walkers, grab coins, reach the flag", signature: ["coins", "stomping enemies from above", "pits to jump", "a flag at the end", "bright cheerful look"], gameplay: { view: "side", goal: { type: "collect", label: "coins", count: 10 }, threat: { type: "patrol", label: "goomba", count: 4, speed: "slow" }, player: { health: 3, jumps: true } } },
  { names: ["sonic the hedgehog", "sonic"], dimension: "2d", loop: "race through a scrolling level grabbing rings and dodging spikes", signature: ["rings", "speed", "spikes", "pits"], gameplay: { view: "side", goal: { type: "collect", label: "rings", count: 12 }, threat: { type: "hazards", count: 4 }, player: { health: 3, jumps: true } } },
  { names: ["donkey kong", "celeste", "super meat boy", "mega man", "castlevania", "metroid"], dimension: "2d", loop: "precise platforming through hazards to a goal", signature: ["jump timing", "hazards", "reach the end"], gameplay: { view: "side", goal: { type: "exit", label: "goal" }, threat: { type: "hazards", count: 5 }, player: { health: 2, jumps: true } } },
  { names: ["super mario 64", "mario 64", "banjo-kazooie", "spyro", "crash bandicoot", "ratchet and clank"], dimension: "3d", loop: "jump across platforms in a 3D playground collecting stars or gems", signature: ["jumping", "platforms at different heights", "collectibles", "light enemies"], gameplay: { goal: { type: "collect", label: "stars", count: 8 }, threat: { type: "patrol", label: "critter", count: 3, speed: "slow", sight: "short" }, player: { health: 3, jumps: true } } },
  { names: ["mirror's edge", "parkour", "obby", "roblox obby", "dying light"], dimension: "3d", loop: "run and jump across a course to the finish", signature: ["jumping across platforms", "a finish line", "hazards"], gameplay: { goal: { type: "exit", label: "finish" }, threat: { type: "hazards", count: 4 }, player: { health: 2, jumps: true } } },
  { names: ["frogger"], dimension: "2d", loop: "cross a dangerous road and river to the other side", signature: ["a goal on the far side", "hazards everywhere", "one life"], gameplay: { goal: { type: "exit", label: "far bank" }, threat: { type: "hazards", count: 5 }, player: { health: 1 } } },
  { names: ["asteroids", "space invaders", "galaga", "gradius"], dimension: "2d", loop: "shoot down everything that comes at your ship", signature: ["shoot everything", "fast enemies", "fixed arena"], gameplay: { goal: { type: "defeat", label: "invaders", count: 8 }, threat: { type: "chasers", label: "invader", count: 4, speed: "normal", sight: "long" }, player: { shoots: true, health: 3 } } },
  { names: ["hotline miami", "binding of isaac", "enter the gungeon", "nuclear throne"], dimension: "2d", loop: "top-down room clearing where everything kills you fast", signature: ["one-hit danger", "top-down shooting", "fast restarts"], gameplay: { goal: { type: "defeat", label: "thugs", count: 6 }, threat: { type: "chasers", label: "thug", count: 3, speed: "fast", sight: "long" }, player: { shoots: true, health: 2 } } },
  { names: ["metal gear", "splinter cell", "hitman", "thief"], dimension: "2d", loop: "slip past guards to reach the objective unseen", signature: ["guards with short sight", "staying out of reach", "reach the exit"], gameplay: { goal: { type: "exit", label: "exit" }, threat: { type: "patrol", label: "guard", count: 4, speed: "normal", sight: "short" }, player: { health: 1 } } },
  { names: ["stardew valley", "animal crossing", "harvest moon"], dimension: "2.5d", loop: "calm gathering and tending with a gentle clock", signature: ["relaxed pace", "collecting", "a day that ends"], gameplay: { goal: { type: "collect", label: "crops", count: 10 }, threat: { type: "timer", seconds: 150 }, player: { health: 3 } } },
  { names: ["among us"], dimension: "2.5d", loop: "finish tasks around a base while an impostor hunts the crew", signature: ["tasks to complete", "an impostor", "a small map"], gameplay: { goal: { type: "collect", label: "tasks", count: 6 }, threat: { type: "chasers", label: "impostor", count: 1, speed: "normal", sight: "normal" }, player: { health: 1 } } },
  { names: ["bomberman"], dimension: "2d", loop: "clear a grid of enemies and hazards", signature: ["grid arena", "hazards", "enemies"], gameplay: { goal: { type: "defeat", label: "balloons", count: 5 }, threat: { type: "chasers", label: "balloon", count: 4, speed: "slow", sight: "normal" }, player: { shoots: true, health: 2 } } },
  { names: ["tron"], dimension: "3d", loop: "survive against neon opponents in a glowing grid arena", signature: ["neon grid", "pursuers", "survive"], gameplay: { goal: { type: "survive", seconds: 90 }, threat: { type: "chasers", label: "program", count: 3, speed: "fast", sight: "long" }, player: { health: 2 } } },
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCHERS = GAMES.map((game) => ({ game, patterns: game.names.map((name) => new RegExp(`(?:^|[^a-z0-9])${escape(name)}(?:[^a-z0-9]|$)`, "i")) }));

/** Up to two known games mentioned in the text, in the order they appear. The longest matching name wins ("mario 64" beats "mario"). */
function findNamedGames(text, max = 2) {
  const lower = String(text || "").toLowerCase();
  const hits = [];
  for (const { game, patterns } of MATCHERS) {
    let best = null;
    patterns.forEach((pattern, i) => {
      const m = pattern.exec(lower);
      if (!m) return;
      const len = game.names[i].length, at = m.index + (/^[a-z0-9]/.test(m[0]) ? 0 : 1);
      if (!best || at < best.at || (at === best.at && len > best.len)) best = { at, len };
    });
    if (best) hits.push({ game, at: best.at, len: best.len });
  }
  hits.sort((a, b) => a.at - b.at || b.len - a.len);
  const kept = [];
  for (const h of hits) if (!kept.some((k) => h.at >= k.at && h.at + h.len <= k.at + k.len)) kept.push(h);   // drop a name that sits inside a longer one
  return kept.slice(0, max).map((h) => h.game);
}

/** Titles the user pointed at ("like X", "inspired by X", quoted names) that are not in the library. */
function extractTitles(brief) {
  const text = String(brief || "");
  const titles = [];
  const cue = /(?:like|similar to|inspired by|in the style of|clone of|based on|remake of|version of|reminiscent of)\s+(?:the\s+(?:game\s+)?)?["“]?([A-Z0-9][\w'’:!&\-.]*(?:\s+(?:of|the|and|for|[A-Z0-9])[\w'’:!&\-.]*){0,5})/g;
  for (const m of text.matchAll(cue)) titles.push(m[1].trim().replace(/[.,;:!]+$/, ""));
  for (const m of text.matchAll(/["“]([^"”]{3,40})["”]/g)) titles.push(m[1].trim());
  const known = (title) => findNamedGames(title, 1).length > 0;
  const generic = /^(a|an|the|this|that|it|my|your|some|game|games|dark|scary|horror|fun|retro|classic|3d|2d)$/i;
  return [...new Set(titles)].filter((t) => t.length >= 3 && !generic.test(t) && !known(t)).slice(0, 2);
}

function formatNamedGames(games, described = []) {
  const lines = games.map((g) => `- ${g.names[0]} (${g.dimension}): ${g.loop}. What makes it itself: ${g.signature.join("; ")}.${g.note ? ` Limit: ${g.note}.` : ""} Best Director fit: goal ${g.gameplay.goal.type}, threat ${g.gameplay.threat.type}${g.gameplay.player && g.gameplay.player.shoots ? ", player shoots" : ""}.`);
  for (const d of described) lines.push(`- ${d.title} (${d.dimension || "?"}): ${d.loop}. What makes it itself: ${(d.signature || []).join("; ")}.`);
  return lines.join("\n");
}

module.exports = { GAMES, findNamedGames, extractTitles, formatNamedGames };
