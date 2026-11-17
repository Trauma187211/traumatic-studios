const HIGH_COMPLEXITY_TERMS = [
    "mmo",
    "rpg",
    "open world",
    "sandbox",
    "crafting",
    "inventory",
    "dialogue",
    "quest",
    "economy",
    "faction",
    "guild",
    "survival",
    "base building",
    "city builder",
    "colony",
    "simulation",
    "runescape",
    "fable",
    "elder scrolls",
    "skyrim",
    "zelda"
];

function analyzeProject(brief) {

    const text = brief.toLowerCase();

    const matched =
        HIGH_COMPLEXITY_TERMS.filter(
            term => text.includes(term)
        );

    return {

        complexity:
            matched.length >= 2
                ? "high"
                : "normal",

        blueprintAllowed:
            matched.length === 0,

        systemsRequired: matched,

        confidence:
            matched.length
    };
}

module.exports = {
    analyzeProject
};