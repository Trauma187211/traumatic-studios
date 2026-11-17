/**
 * Traumatic Studios - Game Checks
 */

function codeProblems(code) {
  const problems = [];
  const codeStr = typeof code === "string" ? code : JSON.stringify(code || "");
  const cleanCode = codeStr.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  if (cleanCode.includes("eval(") || cleanCode.includes("Function(") || cleanCode.includes("innerHTML")) {
    problems.push({ type: "security", message: "Prohibited code usage detected." });
  }
  if (cleanCode.includes("while(true)") || cleanCode.includes("while (true)") || cleanCode.includes("setInterval") || cleanCode.includes("setTimeout")) {
    problems.push({ type: "performance", message: "Loop or timing misuse detected." });
  }
  return problems;
}

module.exports = {
  codeProblems,
};