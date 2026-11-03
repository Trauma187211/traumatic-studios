const { getModel, keylessPool, usingKeylessDefault } = require("./settings");
const { cleanReply, llmFetch, withNotices } = require("./llm");
const { getMemoryFile, readLearnings, saveLearnings } = require("./memory-store");
const { createPrototype, readProjectSources } = require("./project-builder");
const { createGame } = require("./game-generator");
const { createGodotGame } = require("./godot-generator");
const { findGodot } = require("./godot-runner");
const { relevantKnowledge } = require("./knowledge");
const { markBusy, markIdle } = require("./research");
const path = require("node:path");

const agents = {
  producer: {
    name: "Producer",
    kickoff: "Turn the brief into an ambitious, faithful game concept in the exact genre the user asked for (never substitute a generic catch/dodge game; if they name a reference game, plan its core mechanics and structure). Include the core player experience, the content and systems needed for a full playable loop with progression, and assumptions.",
    delivery: "Combine the team discussion into one actionable studio handoff. Include the game pitch, core loop, milestone checklist, key implementation notes, QA risks and the very next task. Resolve contradictions explicitly and keep scope small.",
  },
  designer: {
    name: "Game designer",
    work: "Design the moment-to-moment player experience. Propose the genre-true core loop, controls, progression, content (levels/enemies/items/etc.) and memorable mechanics that make it feel like the game the user described. Flag any assumptions.",
  },
  engineer: {
    name: "Gameplay engineer",
    work: "Propose a practical technical implementation for the first playable version. Recommend a modular architecture for a single-file canvas game (state machine, entities, world/level generation, AI, UI, audio), a build sequence, and technical risks.",
  },
  qa: {
    name: "QA tester",
    work: "Review the producer plan and both specialist proposals as a skeptical tester. Identify confusing requirements, likely bugs or edge cases, and propose a short, testable acceptance checklist. Keep scope appropriate for a prototype.",
  },
};

async function askModel(systemPrompt, userPrompt) {
  const response = await llmFetch({
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
  return cleanReply(content);
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

async function runSprint(brief, emit, { memoryFile = getMemoryFile(), projectsDir } = {}) {
  const learnings = await readLearnings(memoryFile);
  const studied = relevantKnowledge(brief);
  const memoryContext = (learnings.length
    ? `\n\nReusable studio learnings from previous projects:\n${learnings.map(({ lesson }) => `- ${lesson}`).join("\n")}`
    : "\n\nThere are no saved studio learnings yet. Be explicit about useful assumptions and risks.") + studied;
  emit({ type: "studio-started", model: getModel(), memoryCount: learnings.length });
  if (studied) emit({ type: "log", level: "info", message: "The team is applying lessons it learned from study sources." });
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
  let project;
  const godot = process.env.STUDIO_ENGINE === "web" ? null : findGodot();
  const buildOptions = { projectsDir, emit };
  if (godot) {
    emit({ type: "phase-started", phase: "build", message: `Godot found (${path.basename(path.dirname(godot))}); building a real Godot project.` });
    try {
      project = await createGodotGame(brief, handoff, { ...buildOptions, godot });
    } catch (error) {
      emit({ type: "phase-started", phase: "build", message: `Godot build failed (${error.message.slice(0, 140)}); trying the browser engine.` });
    }
  }
  if (!project) {
    try {
      project = await createGame(brief, handoff, buildOptions);
    } catch (error) {
      emit({ type: "phase-started", phase: "build", message: `Full build pipeline failed (${error.message.slice(0, 120)}); falling back to a compact prototype.` });
      project = await createPrototype(brief, handoff, projectsDir ? { projectsDir } : undefined);
    }
  }
  emit({
    type: "agent-completed",
    agent: "engineer",
    name: "Gameplay engineer",
    stage: "implementation",
    content: `Saved a playable prototype and ${project.tasks.length} owned follow-up tasks.`,
  });
  emit({ type: "project-created", project });

  const projectSources = await readProjectSources(project.id, projectsDir);
  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}\n/* …truncated for review… */` : text);
  let implementationReview = "The AI review was skipped to save calls on the rate-limited free provider. Play-test the build manually.";
  const lean = usingKeylessDefault() && !keylessPool()[0].local;
  if (lean) {
    emit({ type: "log", level: "info", message: "Lean mode: skipping the extra review and learnings calls because only the rate-limited free provider is available." });
  } else {
    try {
      implementationReview = await runAgent(
        "qa",
        "implementation-review",
        `Approved handoff:\n${handoff}\n\nGenerated playable prototype source (a Godot build keeps its scripts in the godot folder; the files below are its web wrapper):\nindex.html:\n${clip(projectSources["index.html"], 6000)}\ngame.js:\n${clip(projectSources["game.js"], 40000)}\ngame.css:\n${clip(projectSources["game.css"], 6000)}\n\nCheck whether the core interaction is understandable and whether the implementation appears to meet the handoff. Return concise findings and manual play-test suggestions. Do not claim to have executed the game.`,
        emit,
      );
    } catch (error) {
      implementationReview = `The automated build review could not run (${error.message.slice(0, 160)}). Play-test the build manually.`;
      emit({ type: "agent-completed", agent: "qa", name: "QA tester", stage: "implementation-review", content: implementationReview });
      emit({ type: "log", level: "warn", message: "The final QA review failed, but your game is saved and playable." });
    }
  }
  emitTeamMessage("Producer", "Whole team", "Decision + handoff", handoff, emit);
  emitTeamMessage("QA tester", "Producer + Whole team", "Build review", implementationReview, emit);
  emit({ type: "phase-started", phase: "learning", message: "Saving reusable studio learnings…" });
  let savedLearnings = learnings;
  if (!lean) {
    try {
      const learningResponse = await askModel(
        "You are the knowledge steward for Traumatic Studios. Return only a JSON object with a `learnings` array containing 1 to 3 concise, reusable lessons that will help future small game projects. Lessons must be broadly applicable process, design, engineering, or QA guidance. Do not include project-specific details, names, confidential information, or copied text.",
        `Team handoff:\n${handoff}\n\nQA review:\n${qa}\n\nImplementation review:\n${implementationReview}\n\nExtract only lessons worth carrying into future projects.`,
      );
      const jsonText = learningResponse.match(/\{[\s\S]*\}/)?.[0] || learningResponse;
      savedLearnings = await saveLearnings(JSON.parse(jsonText).learnings, memoryFile);
    } catch (error) {
      emit({ type: "log", level: "warn", message: `Skipped saving learnings (${error.message.slice(0, 120)}). The game is unaffected.` });
    }
  }
  emit({ type: "memory-updated", learnings: savedLearnings });
  emit({ type: "phase-completed", phase: "learning" });
  emit({ type: "studio-completed" });
}

const runStudio = async (brief, emit, options) => {
  markBusy();
  try {
    await withNotices((message, level) => emit({ type: "log", level, message }), () => runSprint(brief, emit, options));
  } finally {
    markIdle();
  }
};

module.exports = { runStudio };
