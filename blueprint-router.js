// Blueprint route: instead of asking a small model to write thousands of lines of game code,
// ask it for a compact JSON spec and run that spec on the pre-tested blueprint runtime.
// HOWEVER:
// Complex projects must bypass the blueprint system and proceed to full generation.

const fs = require("node:fs");
const path = require("node:path");

const BLUEPRINT_SOURCE =
    fs.readFileSync(
        path.join(__dirname, "studio-blueprints.js"),
        "utf8"
    );

const TYPES = [
    "adventure",
    "platformer",
    "arena"
];

const PALETTES = {
    forest: ["#1b2a1f", "#2f5233", "#4c8c4a", "#a3c585", "#f2e8c9", "#8b5a2b"],
    dungeon: ["#0f0d17", "#26233a", "#4b4468", "#7b7399", "#c9c2e8", "#e0a458"],
    desert: ["#3b2a1a", "#a0622d", "#d89c56", "#f2d492", "#fff3d1", "#2a7f8a"],
    ocean: ["#06142e", "#0b3a73", "#1a73b5", "#5fb7e8", "#d8f3ff", "#ff7b54"],
    neon: ["#0a0014", "#2b0a5c", "#b300ff", "#00f0ff", "#fffb7d", "#ff2d6f"],
    snow: ["#16243a", "#4a6b8f", "#9ec0dd", "#e6f2fb", "#ffffff", "#d9534f"],
};

const COMPLEXITY_TERMS = [

    // RPG/MMO
    "mmo",
    "mmorpg",
    "rpg",
    "open world",
    "open-world",
    "sandbox",

    // Systems
    "inventory",
    "equipment",
    "quest",
    "quests",
    "dialogue",
    "npc",
    "merchant",
    "trading",
    "crafting",
    "gathering",
    "skill tree",
    "talent tree",
    "reputation",
    "faction",
    "guild",

    // Economy
    "economy",
    "auction house",
    "market",
    "currency",

    // Simulation
    "simulation",
    "life sim",
    "survival",
    "base building",
    "settlement",
    "colony",
    "city builder",

    // Inspiration titles
    "runescape",
    "fable",
    "skyrim",
    "elder scrolls",
    "world of warcraft",
    "wow",
    "zelda",
    "valheim",
    "stardew valley",
    "rimworld"
];
const CUSTOM_ONLY_TERMS = [
    "mmo", "mmorpg", "rpg", "open world", "open-world", "sandbox",
    "crafting", "quests", "dialogue", "economy", "factions",
    "simulation", "survival", "base building", "settlement", "colony",
];

function analyzeComplexity(input) {

    const text =
        JSON.stringify(input || {})
            .toLowerCase();

    const matches =
        COMPLEXITY_TERMS.filter(
            term => text.includes(term)
        );

    return {

        matches,

        complexity:
            matches.length >= 2
                ? "high"
                : "normal",

        blueprintAllowed:
            matches.length < 2 && !CUSTOM_ONLY_TERMS.some((term) => text.includes(term))
    };
}

const ROUTER_SYSTEM = `
You are an imaginative game designer for Traumatic Studios.

IMPORTANT:

Blueprints are only suitable for contained,
self-contained experiences that can reasonably
fit within a blueprint architecture.

The only implemented blueprints are "adventure", "platformer", and "arena".
Choose one only when it faithfully fits; otherwise return type "custom".

If the requested game suggests:

- MMO systems
- RPG systems
- inventory
- quests
- crafting
- economy
- factions
- dialogue trees
- open worlds
- simulations

then use:

{
  "type":"custom"
}

instead of forcing a blueprint.

You are not trying to fit every game into a template.

Return ONE JSON object only.

Always use rich, original flavor.

Never use generic placeholders.
`;

async function routeBlueprint(
    { chat, parseJson },
    brief,
    handoff,
    knowledge = ""
) {

    const complexityCheck =
        analyzeComplexity({
            brief,
            handoff,
            knowledge
        });

    if (!complexityCheck.blueprintAllowed) {
        return null;
    }

    let spec = null;

    if (
        typeof brief === "string" &&
        brief.trim().startsWith("{")
    ) {
        try {
            spec = parseJson(brief);
        } catch {
            spec = null;
        }
    }
    else if (
        typeof brief === "object" &&
        brief !== null
    ) {
        spec = brief;
    }

    if (!spec) {

        try {

            const reply =
                await chat(
                    [
                        {
                            role: "system",
                            content: ROUTER_SYSTEM
                        },
                        {
                            role: "user",
                            content:
`Game idea from the user:

${brief}

Team handoff notes:

${handoff}

${knowledge}

Return the JSON spec.`
                        }
                    ],
                    {
                        json: true,
                        temperature: 0.7,
                        maxTokens: 3000
                    }
                );

            spec = parseJson(reply);

        } catch {
            return null;
        }
    }

    if (!spec || typeof spec !== "object") {
        return null;
    }

    let specType =
        String(
            spec.type || ""
        ).toLowerCase();

    if (specType === "custom") {
        return null;
    }

    if (!TYPES.includes(specType)) {
        throw new Error(
            `Unknown blueprint type: ${spec.type}`
        );
    }

    return {
        type: specType,
        spec
    };
}

const CONTROLS = {
    adventure: [
        "Move: arrows / WASD",
        "Attack: Space / J"
    ],

    platformer: [
        "Run: arrows / A D",
        "Jump: Space / W / Up"
    ],

    arena: [
        "Move: arrows / WASD",
        "Auto-fire; choose upgrades with 1/2/3 or click"
    ],

    isometric_2_5d: [
        "Move: WASD / Arrow Keys",
        "Interact / Action: Space / E",
        "Rotate / View: Q / E"
    ],

    fps_3d: [
        "Move: WASD",
        "Look: Mouse / Arrow Keys",
        "Shoot / Action: Left Click / Space"
    ],

    puzzle: [
        "Select / Move: Mouse / Arrow Keys",
        "Confirm: Enter / Space"
    ],

    strategy: [
        "Command / Place: Mouse",
        "Speed / Menu: Space / Number keys"
    ],

    custom: [
        "Controls vary by custom game design"
    ]
};

function designFor(
    { type, spec },
    palettes
) {

    const themeKey =
        String(
            spec.theme || ""
        ).toLowerCase();

    const theme =
        palettes[themeKey]
        || palettes["neon"]
        || palettes["dungeon"];

    const accent =
        /^#[0-9a-f]{6}$/i.test(
            spec.accent || ""
        )
            ? spec.accent
            : theme[5];

    const title =
        typeof spec.title === "string"
            && spec.title.trim()
        ? spec.title.trim().slice(0, 40)
        : "Untitled Game";

    const perspective =
        spec.perspective
        || (
            type === "isometric_2_5d"
                ? "25d"
                : type === "fps_3d"
                ? "3d"
                : "2d"
        );

    return {
        title,

        genre:
            `${type} (${perspective})`,

        summary:
            typeof spec.tagline === "string"
                ? spec.tagline.slice(0, 120)
                : "",

        canvas: {
            width: 800,
            height: 560
        },

        palette: {
            bg: theme[0],
            panel: theme[1],
            accent,
            text: theme[4],
            danger: "#ff5d5d"
        },

        controls:
            CONTROLS[type]
            || CONTROLS.custom,

        mustNotBe: [],

        modules: [
            { name: "blueprint" },
            { name: "main" }
        ],

        tasks: [
            {
                title:
                    "Tune difficulty and pacing",
                owner:
                    "Game designer",
                description:
                    `Play through "${title}" and tune balance.`
            },
            {
                title:
                    "Add a signature mechanic",
                owner:
                    "Gameplay engineer",
                description:
                    "Create a unique feature that enhances the game's identity."
            },
            {
                title:
                    "Test edge cases and polish",
                owner:
                    "QA tester",
                description:
                    "Verify transitions, restart loops, and controls."
            }
        ]
    };
}

module.exports = {
    BLUEPRINT_SOURCE,
    ROUTER_SYSTEM,
    TYPES,
    PALETTES,
    designFor,
    routeBlueprint,
    analyzeComplexity
};
