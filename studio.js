const API_URL = "https://api.openai.com/v1/chat/completions";
const { getApiKey, getModel } = require("./settings");
const { getMemoryFile, readLearnings, saveLearnings } = require("./memory-store");
const { createPrototype, readProjectSources } = require("./project-builder");

const agents = {
  producer: {
    name: "Producer",
    kickoff: "Turn the brief into a compact, achievable game concept and a prioritized build plan. Include the core player experience, a tiny first milestone, and assumptions. Keep it practical for a small indie team.",
    delivery: "Combine the team discussion into one actionable studio handoff. Include the game pitch, core loop, milestone checklist, key implementation notes, QA risks and the very next task. Resolve contradictions explicitly and keep scope small.",
  },
  designer: {
    name: "Game designer",
    work: "Design the moment-to-moment player experience. Propose a clear core loop, controls, progression, and one memorable mechanic. Keep the first playable version small and flag any assumptions.",
  },
  engineer: {
    name: "Gameplay engineer",
    work: "Propose a practical technical implementation for the first playable version. Recommend a simple architecture, identify the smallest build sequence, and call out technical risks. Avoid unnecessary systems.",
  },
  qa: {
    name: "QA tester",
    work: "Review the producer plan and both specialist proposals as a skeptical tester. Identify confusing requirements, likely bugs or edge cases, and propose a short, testable acceptance checklist. Keep scope appropriate for a prototype.",
  },
};

async function askModel(systemPrompt, userPrompt) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Model request failed (${response.status}): ${details.slice(0, 500)}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The model returned an empty response.");
  }
  return content.trim();
}

async function runAgent(id, stage, userPrompt, emit) {
  const agent = agents[id];
  emit({ type: "agent-started", agent: id, name: agent.name, stage });
  const content = await askModel(
    `You are the ${agent.name} in a small collaborative indie game studio. Be concise, specific, and useful to your teammates.`,
    userPrompt,
  );
  emit({ type: "agent-completed", agent: id, name: agent.name, stage, content });
  return content;
}

function emitTeamMessage(from, to, stage, content, emit) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const message = normalized.length > 520
    ? `${normalized.slice(0, 517).trimEnd()}...`
    : normalized;
  emit({ type: "team-message", from, to, stage, message });
}

async function runStudio(brief, emit, { memoryFile = getMemoryFile(), projectsDir } = {}) {
  const learnings = await readLearnings(memoryFile);
  const memoryContext = learnings.length
    ? `\n\nReusable studio learnings from previous projects:\n${learnings.map(({ lesson }) => `- ${lesson}`).join("\n")}`
    : "\n\nThere are no saved studio learnings yet. Be explicit about useful assumptions and risks.";
  emit({ type: "studio-started", model: getModel(), memoryCount: learnings.length });
  const kickoff = await runAgent(
    "producer",
    "kickoff",
    `Project brief:\n${brief}${memoryContext}\n\n${agents.producer.kickoff}`,
    emit,
  );

  emitTeamMessage("Producer", "Whole team", "Kickoff", kickoff, emit);
  const teamContext = `Project brief:\n${brief}${memoryContext}\n\nProducer's shared kickoff:\n${kickoff}`;
  const [design, engineering] = await Promise.all([
    runAgent("designer", "work", `${teamContext}\n\n${agents.designer.work}`, emit),
    runAgent("engineer", "work", `${teamContext}\n\n${agents.engineer.work}`, emit),
  ]);

  emitTeamMessage("Game designer", "QA tester + Producer", "Design proposal", design, emit);
  emitTeamMessage("Gameplay engineer", "QA tester + Producer", "Engineering proposal", engineering, emit);
  const teamDiscussion = `${teamContext}\n\nGame designer's proposal:\n${design}\n\nGameplay engineer's proposal:\n${engineering}`;
  const qa = await runAgent(
    "qa",
    "review",
    `${teamDiscussion}\n\n${agents.qa.work}`,
    emit,
  );

  emitTeamMessage("QA tester", "Producer + Whole team", "Plan review", qa, emit);
  const handoff = await runAgent(
    "producer",
    "handoff",
    `${teamDiscussion}\n\nQA review:\n${qa}\n\n${agents.producer.delivery}`,
    emit,
  );
  emit({ type: "agent-started", agent: "engineer", name: "Gameplay engineer", stage: "implementation" });
  const project = await createPrototype(brief, handoff, projectsDir ? { projectsDir } : undefined);
  emit({
    type: "agent-completed",
    agent: "engineer",
    name: "Gameplay engineer",
    stage: "implementation",
    content: `Saved a playable prototype and ${project.tasks.length} owned follow-up tasks.`,
  });
  emit({ type: "project-created", project });

  const projectSources = await readProjectSources(project.id, projectsDir);
  const implementationReview = await runAgent(
    "qa",
    "implementation-review",
    `Approved handoff:\n${handoff}\n\nGenerated playable prototype source:\nindex.html:\n${projectSources["index.html"]}\ngame.js:\n${projectSources["game.js"]}\ngame.css:\n${projectSources["game.css"]}\n\nCheck whether the core interaction is understandable and whether the implementation appears to meet the handoff. Return concise findings and manual play-test suggestions. Do not claim to have executed the game.`,
    emit,
  );
  emitTeamMessage("Producer", "Whole team", "Decision + handoff", handoff, emit);
  emitTeamMessage("QA tester", "Producer + Whole team", "Build review", implementationReview, emit);
  emit({ type: "phase-started", phase: "learning", message: "Saving reusable studio learnings…" });
  const learningResponse = await askModel(
    "You are the knowledge steward for Traumatic Studios. Return only a JSON object with a `learnings` array containing 1 to 3 concise, reusable lessons that will help future small game projects. Lessons must be broadly applicable process, design, engineering, or QA guidance. Do not include project-specific details, names, confidential information, or copied text.",
    `Team handoff:\n${handoff}\n\nQA review:\n${qa}\n\nImplementation review:\n${implementationReview}\n\nExtract only lessons worth carrying into future projects.`,
  );
  let learned;
  try {
    learned = JSON.parse(learningResponse).learnings;
  } catch (error) {
    throw new Error("The studio could not parse the learning summary.", { cause: error });
  }
  const savedLearnings = await saveLearnings(learned, memoryFile);
  emit({ type: "memory-updated", learnings: savedLearnings });
  emit({ type: "phase-completed", phase: "learning" });
  emit({ type: "studio-completed" });
}

module.exports = { runStudio };
