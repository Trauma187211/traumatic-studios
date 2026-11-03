const { createDemoPrototype } = require("./project-builder");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runDemoStudio(brief, emit, { projectsDir, delay = 250 } = {}) {
  const step = async (agent, name, stage, content) => {
    emit({ type: "agent-started", agent, name, stage, demo: true });
    if (delay > 0) await pause(delay);
    emit({ type: "agent-completed", agent, name, stage, content, demo: true });
    return content;
  };

  emit({ type: "studio-started", model: "offline demo", demo: true, memoryCount: 0 });
  const kickoff = await step(
    "producer",
    "Producer",
    "kickoff",
    `DEMO PLAN: Build a compact collecting game inspired by this brief: "${brief.slice(0, 180)}". Keep one screen, one movement mechanic, and a restart button.`,
  );
  emit({
    type: "team-message",
    from: "Producer",
    to: "Whole team",
    stage: "Kickoff · DEMO",
    message: kickoff,
    demo: true,
  });

  const [design, engineering] = await Promise.all([
    step("designer", "Game designer", "work", "DEMO DESIGN: Catch eight falling stars. Move left and right with arrow keys or A/D; keep the controls readable and make restart obvious."),
    step("engineer", "Gameplay engineer", "work", "DEMO ENGINEERING: Use one canvas, a short animation loop, simple collision checks, keyboard movement, and a reset function. No external files or services."),
  ]);
  emit({
    type: "team-message",
    from: "Game designer",
    to: "QA tester + Producer",
    stage: "Design proposal · DEMO",
    message: design,
    demo: true,
  });
  emit({
    type: "team-message",
    from: "Gameplay engineer",
    to: "QA tester + Producer",
    stage: "Engineering proposal · DEMO",
    message: engineering,
    demo: true,
  });

  const review = await step(
    "qa",
    "QA tester",
    "review",
    "DEMO QA: Check that arrow keys and A/D both move the catcher, the score updates on a catch, a missed star ends the run with clear feedback, and restart resets it. The preview is sandboxed; this demo does not claim automated playtesting.",
  );
  emit({
    type: "team-message",
    from: "QA tester",
    to: "Producer + Whole team",
    stage: "Plan review · DEMO",
    message: review,
    demo: true,
  });

  const handoff = await step(
    "producer",
    "Producer",
    "handoff",
    "DEMO HANDOFF: The first playable is Starlight Salvage: catch eight stars, use keyboard movement, show a clear score, and allow restart. Follow-up tasks are assigned on the board.",
  );
  emit({
    type: "team-message",
    from: "Producer",
    to: "Whole team",
    stage: "Decision + handoff · DEMO",
    message: handoff,
    demo: true,
  });

  emit({ type: "agent-started", agent: "engineer", name: "Gameplay engineer", stage: "implementation", demo: true });
  const project = await createDemoPrototype(projectsDir ? { projectsDir } : undefined);
  if (delay > 0) await pause(delay);
  emit({
    type: "agent-completed",
    agent: "engineer",
    name: "Gameplay engineer",
    stage: "implementation",
    content: "DEMO BUILD: Saved a local playable canvas game and three sample follow-up tasks. No AI generated this demo project.",
    demo: true,
  });
  emit({ type: "project-created", project, demo: true });

  await step(
    "qa",
    "QA tester",
    "implementation-review",
    "DEMO SOURCE REVIEW: The starter includes keyboard movement, score updates, missed-star feedback, and restart. Please try those controls in the preview; this is a manual checklist, not an automated test result.",
  );
  emit({
    type: "team-message",
    from: "QA tester",
    to: "Producer + Whole team",
    stage: "Build review · DEMO",
    message: "DEMO REVIEW: Starter controls, missed-star feedback, and restart are present. Please manually verify play in the preview.",
    demo: true,
  });
  emit({ type: "phase-started", phase: "learning", message: "Demo complete · shared studio memory was not changed." });
  if (delay > 0) await pause(delay);
  emit({ type: "phase-completed", phase: "learning" });
  emit({ type: "studio-completed", demo: true });
}

module.exports = { runDemoStudio };
