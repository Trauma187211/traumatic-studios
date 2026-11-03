// Deterministic repairs for the mistakes small models make most often, applied before any model call is spent on them:
// ES-module syntax in a plain script, and invented Engine/Kit names (Kit.tilemap -> Kit.tiles).
const ALIASES = {
  Kit: {
    tilemap: "tiles", tilemaps: "tiles", tile: "tiles", tiling: "tiles", map: "tiles", maps: "tiles", grid: "tiles",
    generate: "gen", generator: "gen", procgen: "gen", dungeongen: "gen", pathfinding: "path", pathfind: "path", astar: "path",
    ai: "steer", steering: "steer", audio: "music", sound: "music", song: "music", statemachine: "fsm", states: "fsm", state: "fsm",
    events: "bus", eventbus: "bus", emitter: "bus", dialog: "dialogue", talk: "dialogue", physics: "platformer", movement: "topdown",
    hp: "health", life: "health", palette: "palettes", colors: "palettes", colours: "palettes", easing: "ease", random: "noise",
  },
  Engine: {
    collision: "hit", collisions: "hit", collide: "hit", random: "rng", rand: "rng", keys: "input", keyboard: "input", key: "input",
    audio: "sfx", sound: "sfx", particles: "fx", effects: "fx", context: "ctx", width: "W", height: "H", gui: "ui", cam: "camera",
  },
};

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

function closest(name, options, aliases = {}) {
  if (options.includes(name)) return name;
  const lower = name.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === lower);
  if (exact) return exact;
  if (aliases[lower] && options.includes(aliases[lower])) return aliases[lower];
  let best = null;
  let bestDistance = Math.max(1, Math.floor(name.length / 4)) + 1;
  for (const option of options) {
    const d = distance(lower, option.toLowerCase());
    if (d < bestDistance) { best = option; bestDistance = d; }
  }
  return best;
}

// Strips import/export so a module stays a plain script. Returns the cleaned code.
function stripModuleSyntax(code) {
  return code
    .replace(/^[ \t]*import\s+[^;\n]*?from\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*export\s+default\s+(?=(?:async\s+)?(?:function|class)\b)/gm, "")
    .replace(/^[ \t]*export\s+default\s+[\w$]+\s*;?[ \t]*$/gm, "")
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*["'][^"']*["'])?;?[ \t]*$/gm, "")
    .replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, "$1")
    .replace(/^[ \t]*module\.exports\s*=\s*\{[\s\S]*?\}[ \t]*;?[ \t]*$/gm, "")
    .replace(/^[ \t]*module\.exports\s*=\s*[^;\n{]*;?[ \t]*$/gm, "");
}

function sanitizeModule(code, api) {
  const changes = [];
  let out = stripModuleSyntax(code);
  if (out !== code) changes.push("removed import/export statements");
  if (!api || !api.Engine) return { code: out, changes };
  const pattern = /(?<![\w$.])(Kit|Engine)\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?(\s*=(?!=))?/g;
  out = out.replace(pattern, (whole, ns, first, second, assign) => {
    if (assign) return whole;
    const members = api[ns];
    if (!members) return whole;
    const fixedFirst = closest(first, Object.keys(members), ALIASES[ns]);
    if (!fixedFirst) return whole;
    let fixedSecond = second;
    const inner = members[fixedFirst];
    if (second && Array.isArray(inner)) {
      const match = closest(second, inner);
      if (match) fixedSecond = match;
    }
    if (fixedFirst !== first) changes.push(`${ns}.${first} -> ${ns}.${fixedFirst}`);
    else if (fixedSecond !== second) changes.push(`${ns}.${first}.${second} -> ${ns}.${first}.${fixedSecond}`);
    return `${ns}.${fixedFirst}${fixedSecond ? `.${fixedSecond}` : ""}${assign || ""}`;
  });
  return { code: out, changes: [...new Set(changes)] };
}

module.exports = { closest, distance, sanitizeModule, stripModuleSyntax };
