const fs = require("node:fs");
const path = require("node:path");

function getRelevantLessons(briefText, maxLessons = 5) {
  try {
    const filePath = path.join(__dirname, "lessons.json");
    if (!fs.existsSync(filePath)) return [];
    
    const lessons = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const textLower = briefText.toLowerCase();

    // Score lessons based on keyword matches in the project brief
    const scored = lessons.map(lesson => {
      let score = 0;
      for (const keyword of lesson.keywords) {
        if (textLower.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      return { lesson, score };
    });

    // Sort by highest relevance score and take the top N
    scored.sort((a, b) => b.score - a.score);
    
    // Fallback: if no keywords match, grab the most recent or general studio standards
    const selected = scored.filter(s => s.score > 0).slice(0, maxLessons);
    if (selected.length === 0) {
      return lessons.slice(0, maxLessons).map(l => l.lesson);
    }

    return selected.map(s => s.lesson);
  } catch (error) {
    console.error("Failed to load lessons:", error);
    return [];
  }
}

module.exports = { getRelevantLessons };