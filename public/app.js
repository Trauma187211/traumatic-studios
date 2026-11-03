const form = document.querySelector("#brief-form");
const briefInput = document.querySelector("#brief");
const charCount = document.querySelector("#char-count");
const startButton = document.querySelector("#start-button");
const workSection = document.querySelector("#work-section");
const activityItems = document.querySelector("#activity-items");
const runStatus = document.querySelector("#run-status");
const progressSummary = document.querySelector("#progress-summary");
const sprintProgress = document.querySelector("#sprint-progress");
const teamChatMessages = document.querySelector("#team-chat-messages");
const teamChatEmpty = document.querySelector("#team-chat-empty");
const errorMessage = document.querySelector("#error-message");
const connectionStatus = document.querySelector("#connection-status");
const memoryList = document.querySelector("#memory-list");
const memoryEmpty = document.querySelector("#memory-empty");
const memoryError = document.querySelector("#memory-error");
const projectsSection = document.querySelector("#projects-section");
const projectsEmpty = document.querySelector("#projects-empty");
const projectList = document.querySelector("#project-list");
const keyForm = document.querySelector("#key-form");
const keyInput = document.querySelector("#api-key");
const keyModel = document.querySelector("#api-model");
const keyRemember = document.querySelector("#api-remember");
const keySave = document.querySelector("#key-save");
const keyClear = document.querySelector("#key-clear");
const keyMessage = document.querySelector("#key-message");
const keyBadge = document.querySelector("#key-badge");
const providerSelect = document.querySelector("#api-provider");
const baseUrlRow = document.querySelector("#base-url-row");
const baseUrlInput = document.querySelector("#api-base-url");
const keyLabel = document.querySelector("#api-key-label");
let providerCatalog = {};
const settingsButton = document.querySelector("#settings-button");
const settingsSummary = document.querySelector("#settings-summary");
const keySection = document.querySelector("#key-section");
const keyClose = document.querySelector("#key-close");
const liveLog = document.querySelector("#live-log");
const liveNowText = document.querySelector("#live-now-text");
const liveNowTime = document.querySelector("#live-now-time");
let liveSince = Date.now();
let settingsOpen = false;
let firstStatusDone = false;
let connectedJustNow = false;

function setSettingsOpen(open) {
  settingsOpen = open;
  keySection.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  if (open) keySection.scrollIntoView({ behavior: "smooth", block: "center" });
}

settingsButton.addEventListener("click", () => setSettingsOpen(keySection.hidden));
keyClose.addEventListener("click", () => setSettingsOpen(false));

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Writes a timestamped line to the live log and makes it the "happening now" headline.
function logLine(message, level = "info") {
  if (!message) return;
  const last = liveLog.lastElementChild;
  if (last && last.dataset.message === message) return;
  const item = document.createElement("li");
  item.dataset.level = level;
  item.dataset.message = message;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  liveLog.append(item);
  liveLog.scrollTop = liveLog.scrollHeight;
  liveNowText.textContent = message;
  liveSince = Date.now();
}

setInterval(() => { liveNowTime.textContent = formatClock(Date.now() - liveSince); }, 1000);

function applyProvider() {
  const provider = providerCatalog[providerSelect.value];
  if (!provider) return;
  const custom = providerSelect.value === "custom";
  baseUrlRow.hidden = !custom;
  baseUrlInput.required = custom;
  keyInput.required = provider.keyRequired;
  keyLabel.textContent = provider.keyRequired ? "API KEY" : "API KEY (NOT NEEDED FOR THIS PROVIDER)";
  keyModel.placeholder = provider.model || "model name";
  keyModel.required = providerSelect.value !== "openai";
}

function setupProviders(providers) {
  providerCatalog = providers;
  for (const [id, provider] of Object.entries(providers)) providerSelect.append(new Option(provider.label, id));
  providerSelect.addEventListener("change", applyProvider);
  applyProvider();
}
const stageLabels = { kickoff: "SHARED KICKOFF", work: "PARALLEL WORK", review: "TEAM REVIEW", handoff: "FINAL HANDOFF", implementation: "PLAYABLE BUILD", "implementation-review": "BUILD QA" };
const activeCards = new Map();
const projectNotices = new Map();
let modelConfigured = false;
const phaseForStage = {
  kickoff: "scope",
  work: "collaborate",
  review: "plan-review",
  handoff: "handoff",
  implementation: "build",
  "implementation-review": "build-review",
};
const expectedPhaseAgents = { scope: 1, collaborate: 2, "plan-review": 1, handoff: 1, build: 1, "build-review": 1, learning: 1 };
const completedPhaseAgents = new Map();
let elapsedTimer;

function updateElapsed() {
  for (const card of activeCards.values()) {
    if (!card.classList.contains("is-active")) continue;
    const elapsed = Math.floor((Date.now() - Number(card.dataset.startedAt)) / 1000);
    const seconds = String(elapsed % 60).padStart(2, "0");
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    card.querySelector(".activity-content").textContent = `Waiting for model response · ${minutes}:${seconds}`;
  }
}

function startElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function setPhaseState(phase, state) {
  const step = sprintProgress.querySelector(`[data-phase="${phase}"]`);
  if (step) step.dataset.state = state;
}

function startPhase(phase, message) {
  const step = sprintProgress.querySelector(`[data-phase="${phase}"]`);
  if (!step) return;
  sprintProgress.querySelectorAll("li[data-state='active']").forEach((active) => {
    if (active !== step) active.dataset.state = "done";
  });
  step.dataset.state = "active";
  const number = [...sprintProgress.children].indexOf(step) + 1;
  progressSummary.textContent = `Step ${number} of ${sprintProgress.children.length} · ${message || step.querySelector("strong").textContent}`;
}

function completePhase(phase) {
  const count = (completedPhaseAgents.get(phase) || 0) + 1;
  completedPhaseAgents.set(phase, count);
  if (count >= expectedPhaseAgents[phase]) {
    setPhaseState(phase, "done");
  }
}

briefInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  form.requestSubmit();
});

briefInput.addEventListener("input", () => {
  charCount.textContent = `${briefInput.value.length.toLocaleString()} / 5,000`;
});

async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    modelConfigured = status.configured;
    connectionStatus.textContent = status.configured
      ? `Live AI · ${status.model}`
      : "Local agents ready · no key needed";
    startButton.querySelector("span:first-child").textContent = "Bring the team together";
    startButton.title = status.configured
      ? "Run a live AI studio sprint"
      : "Run a sprint with the built-in local agents";
    keyBadge.textContent = status.configured
      ? `LIVE AI · ${status.keySource === "environment" ? "FROM ENVIRONMENT" : status.keySource === "saved" ? "SAVED KEY" : "THIS SESSION"}`
      : "LOCAL AGENTS ACTIVE";
    keyClear.hidden = !status.configured || status.keySource === "environment";
    settingsSummary.textContent = status.configured
      ? `${status.provider || "OpenAI"} · ${status.model}`
      : "Not connected · tap to set up";
    settingsButton.classList.toggle("is-connected", status.configured);
    keyClose.hidden = !status.configured;
    if (!firstStatusDone) {
      firstStatusDone = true;
      setSettingsOpen(!status.configured);
      if (!status.configured) keySection.scrollIntoView({ block: "nearest" });
    } else if (status.configured && settingsOpen && connectedJustNow) {
      setSettingsOpen(false);
    }
    connectedJustNow = false;
    if (status.configured && !keyModel.value) keyModel.placeholder = status.model;
    if (status.providers && !providerSelect.options.length) setupProviders(status.providers);
    await loadProjects();
  } catch {
    modelConfigured = false;
    connectionStatus.textContent = "Studio server unavailable";
    startButton.querySelector("span:first-child").textContent = "Studio unavailable";
    startButton.disabled = true;
  }
}

function renderMemory(learnings) {
  memoryList.replaceChildren();
  memoryEmpty.hidden = learnings.length > 0;
  for (const item of learnings) {
    const entry = document.createElement("li");
    entry.textContent = item.lesson;
    memoryList.append(entry);
  }
}

async function loadMemory() {
  try {
    const response = await fetch("/api/memory");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load studio memory.");
    renderMemory(result.learnings);
  } catch (error) {
    memoryEmpty.hidden = true;
    memoryError.textContent = `Studio memory unavailable: ${error.message}`;
    memoryError.hidden = false;
  }
}

function renderProjects(projects) {
  projectList.replaceChildren();
  projectsSection.hidden = false;
  projectsEmpty.hidden = projects.length > 0;
  const archive = projects.length > 1 ? document.createElement("details") : null;
  let archivedProjects;
  if (archive) {
    archive.className = "project-history";
    const summary = document.createElement("summary");
    summary.textContent = `OLDER BUILDS · ${projects.length - 1}`;
    archivedProjects = document.createElement("div");
    archivedProjects.className = "project-list project-archive-list";
    archive.append(summary, archivedProjects);
  }

  for (const [index, project] of projects.entries()) {
    const card = document.createElement("article");
    card.className = "project-card";

    const heading = document.createElement("div");
    heading.className = "project-card-heading";
    const title = document.createElement("h3");
    title.textContent = `${project.mode === "demo" ? "Offline demo build" : "Playable prototype"} · ${new Date(project.createdAt).toLocaleString()}`;
    const openLink = document.createElement("a");
    openLink.href = project.previewUrl;
    openLink.target = "_blank";
    openLink.rel = "noopener";
    openLink.textContent = "Open game ↗";
    const downloadLink = document.createElement("a");
    downloadLink.href = `/api/projects/${project.id}/download`;
    downloadLink.download = `${project.id}.zip`;
    downloadLink.textContent = "Download ⬇";
    downloadLink.title = "Download this game as a .zip (open index.html to play)";
    heading.append(title, openLink, downloadLink);
    if (projectNotices.has(project.id)) {
      const notice = document.createElement("p");
      notice.className = "project-notice";
      notice.textContent = projectNotices.get(project.id);
      heading.after(notice);
    }

    const preview = document.createElement("iframe");
    preview.className = "game-preview";
    preview.src = project.previewUrl;
    preview.title = "Sandboxed playable game prototype";
    preview.loading = "lazy";
    preview.setAttribute("sandbox", "allow-scripts");

    const taskHeading = document.createElement("h4");
    taskHeading.className = "task-heading";
    taskHeading.textContent = "NEXT TASKS";
    const tasks = document.createElement("ul");
    tasks.className = "project-tasks";
    for (const task of project.tasks) {
      const item = document.createElement("li");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "task-toggle";
      toggle.dataset.projectId = project.id;
      toggle.dataset.taskId = task.id;
      toggle.disabled = task.status === "in_progress";
      toggle.setAttribute("aria-pressed", String(task.status === "done"));
      toggle.setAttribute("aria-label", `${task.status === "done" ? "Reopen" : "Complete"} task: ${task.title}`);
      toggle.textContent = task.status === "done" ? "✓" : "";
      const details = document.createElement("span");
      details.className = task.status === "done" ? "task-done" : "";
      const taskTitle = document.createElement("strong");
      taskTitle.textContent = task.title;
      const taskDescription = document.createElement("small");
      taskDescription.textContent = `${task.owner} · ${task.description}`;
      details.append(taskTitle, taskDescription);
      if (task.notes) {
        const notes = document.createElement("small");
        notes.className = "task-notes";
        notes.textContent = `Local agent plan: ${task.notes}`;
        details.append(notes);
      }
      item.append(toggle, details);
      if (task.status !== "done") {
        const runButton = document.createElement("button");
        runButton.type = "button";
        runButton.className = "task-run";
        runButton.dataset.projectId = project.id;
        runButton.dataset.taskId = task.id;
        runButton.disabled = task.status === "in_progress";
        runButton.title = modelConfigured ? `Ask ${task.owner} to implement this task` : `Ask the local ${task.owner} agent for a working plan`;
        runButton.textContent = task.status === "in_progress"
          ? `${task.owner} working…`
          : modelConfigured ? `Ask ${task.owner}` : `Ask ${task.owner} (plan)`;
        item.append(runButton);
      }
      tasks.append(item);
    }
    card.append(heading, preview, taskHeading, tasks);
    (index === 0 ? projectList : archivedProjects).append(card);
  }
  if (archive) projectList.append(archive);
}

async function loadProjects() {
  try {
    const response = await fetch("/api/projects");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load projects.");
    renderProjects(result.projects);
  } catch (error) {
    errorMessage.textContent = `Could not load the studio project board: ${error.message}`;
    errorMessage.hidden = false;
  }
}

function addCard(event) {
  const card = document.createElement("article");
  card.className = "activity-item is-active";

  const meta = document.createElement("div");
  meta.className = "activity-meta";
  const agentName = document.createElement("span");
  agentName.textContent = event.name;
  const stage = document.createElement("span");
  stage.textContent = stageLabels[event.stage] || event.stage;
  meta.append(agentName, stage);

  const content = document.createElement("p");
  content.className = "activity-content";
  content.textContent = "Waiting for model response · 00:00";
  card.dataset.startedAt = String(Date.now());
  card.append(meta, content);
  activityItems.append(card);
  activeCards.set(`${event.agent}:${event.stage}`, card);
}

function addTeamMessage(event) {
  const message = document.createElement("article");
  message.className = "chat-message";

  const header = document.createElement("div");
  header.className = "chat-message-header";
  const sender = document.createElement("strong");
  sender.textContent = event.from;
  const stage = document.createElement("span");
  stage.textContent = event.stage || "Team update";
  header.append(sender, stage);

  const recipient = document.createElement("p");
  recipient.className = "chat-recipient";
  recipient.textContent = `TO ${event.to || "Whole team"}`;
  const content = document.createElement("p");
  content.className = "chat-message-content";
  content.textContent = event.message;
  message.append(header, recipient, content);
  teamChatMessages.append(message);
  teamChatEmpty.hidden = true;
}

function handleEvent(event) {
  if (event.type === "studio-started") {
    completedPhaseAgents.clear();
    liveLog.replaceChildren();
    logLine(`Sprint started with ${event.model}${event.memoryCount ? ` and ${event.memoryCount} saved lessons` : ""}.`);
  } else if (event.type === "log") {
    logLine(event.message, event.level);
  } else if (event.type === "phase-started") {
    startPhase(event.phase, event.message);
    if (event.phase !== "learning") logLine(event.message);
  } else if (event.type === "phase-completed") {
    setPhaseState(event.phase, "done");
  } else if (event.type === "agent-started") {
    const phase = phaseForStage[event.stage];
    if (phase) startPhase(phase, `${event.name} is working`);
    addCard(event);
    logLine(`${event.name} is working on ${event.stage.replace(/-/g, " ")}…`);
  } else if (event.type === "team-message") {
    addTeamMessage(event);
  } else if (event.type === "agent-completed") {
    logLine(`${event.name} finished ${event.stage.replace(/-/g, " ")}.`, "ok");
    const card = activeCards.get(`${event.agent}:${event.stage}`);
    if (card) {
      card.classList.remove("is-active");
      const elapsed = Math.floor((Date.now() - Number(card.dataset.startedAt)) / 1000);
      const seconds = String(elapsed % 60).padStart(2, "0");
      const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
      card.querySelector(".activity-content").textContent = `${event.content}\n\nResponse received in ${minutes}:${seconds}.`;
    }
    const phase = phaseForStage[event.stage];
    if (phase) completePhase(phase);
  } else if (event.type === "memory-updated") {
    renderMemory(event.learnings);
    memoryError.hidden = true;
  } else if (event.type === "project-created") {
    loadProjects();
  } else if (event.type === "studio-completed") {
    sprintProgress.querySelectorAll("li").forEach((step) => { step.dataset.state = "done"; });
    progressSummary.textContent = "All 7 sprint steps are complete. The team’s handoff and playable build are ready.";
    logLine("Sprint complete. Your playable build is saved below.", "ok");
    clearInterval(elapsedTimer);
    runStatus.textContent = "SPRINT COMPLETE";
    runStatus.classList.remove("is-running");
    startButton.disabled = false;
  } else if (event.type === "error") {
    clearInterval(elapsedTimer);
    progressSummary.textContent = "The sprint stopped before all steps were complete. Review the error below.";
    errorMessage.textContent = event.message;
    errorMessage.hidden = false;
    logLine(`Stopped: ${event.message}`, "error");
    runStatus.textContent = "NEEDS ATTENTION";
    runStatus.classList.remove("is-running");
    startButton.disabled = false;
  }
}

projectList.addEventListener("click", async (event) => {
  const button = event.target.closest(".task-toggle, .task-run");
  if (!button) return;
  button.disabled = true;
  try {
    const isRun = button.classList.contains("task-run");
    if (isRun) {
      const originalLabel = button.textContent;
      button.textContent = `${originalLabel.replace(/^Ask /, "")} working…`;
      const projectId = button.dataset.projectId;
      const taskId = button.dataset.taskId;
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/run`, {
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The assigned bot could not complete the task.");
      const owner = result.project.tasks.find((task) => task.id === taskId)?.owner || "Studio bot";
      projectNotices.set(projectId, `${owner}: ${result.summary} QA: ${result.review}`);
      await loadProjects();
      errorMessage.hidden = true;
      return;
    }
    const status = button.getAttribute("aria-pressed") === "true" ? "todo" : "done";
    const response = await fetch(`/api/projects/${encodeURIComponent(button.dataset.projectId)}/tasks/${encodeURIComponent(button.dataset.taskId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update the task.");
    await loadProjects();
  } catch (error) {
    errorMessage.textContent = `Could not complete task: ${error.message}`;
    errorMessage.hidden = false;
    button.disabled = false;
    if (button.classList.contains("task-run")) {
      button.textContent = button.textContent.replace(/ working…$/, "");
      if (!button.textContent.startsWith("Ask ")) button.textContent = `Ask ${button.textContent}`;
    }
  }
});

async function readEventStream(response, onEvent = handleEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const messages = buffer.split("\n\n");
    buffer = messages.pop();
    for (const message of messages) {
      const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) onEvent(JSON.parse(dataLine.slice(6)));
    }
    if (done) break;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  workSection.hidden = false;
  workSection.scrollIntoView({ behavior: "smooth", block: "start" });
  sprintProgress.querySelectorAll("li").forEach((step) => { delete step.dataset.state; });
  teamChatMessages.replaceChildren();
  teamChatEmpty.hidden = false;
  activityItems.replaceChildren();
  activeCards.clear();
  completedPhaseAgents.clear();
  errorMessage.hidden = true;
  errorMessage.textContent = "";
  runStatus.textContent = "TEAM IN SESSION";
  runStatus.classList.add("is-running");
  progressSummary.textContent = "Starting sprint…";
  startElapsedTimer();
  startButton.disabled = true;

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: briefInput.value }),
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Studio request failed (${response.status}).`);
    }
    await readEventStream(response);
    if (startButton.disabled) {
      throw new Error("The studio connection closed before the team finished.");
    }
  } catch (error) {
    clearInterval(elapsedTimer);
    progressSummary.textContent = "The sprint stopped before all steps were complete. Review the error below.";
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
    runStatus.textContent = "NEEDS ATTENTION";
    runStatus.classList.remove("is-running");
    startButton.disabled = false;
  }
});

const learnForm = document.querySelector("#learn-form");
const learnLinks = document.querySelector("#learn-links");
const learnFollow = document.querySelector("#learn-follow");
const learnButton = document.querySelector("#learn-button");
const learnLog = document.querySelector("#learn-log");
const learnCount = document.querySelector("#learn-count");
const learnList = document.querySelector("#learn-list");
const learnTracks = document.querySelector("#learn-tracks");
const learnDrill = document.querySelector("#learn-drill");
const curriculumButton = document.querySelector("#curriculum-button");

async function loadKnowledge() {
  try {
    const result = await (await fetch("/api/knowledge")).json();
    const report = result.report || {};
    learnCount.textContent = result.total
      ? `${result.total} LESSONS${report.asked ? ` · EXAM ${report.passed}/${report.asked}` : ""}`
      : "NOTHING STUDIED YET";
    if (!learnTracks.children.length && result.tracks) {
      learnTracks.replaceChildren(...result.tracks.map((track) => {
        const label = document.createElement("label");
        label.className = "key-remember";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = track.id;
        box.checked = true;
        label.append(box, ` ${track.title} (${track.pages} pages)`);
        return label;
      }));
    }
    learnList.replaceChildren(...result.items.map((item) => {
      const entry = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = `${item.topic ? `${item.topic}: ` : ""}${item.lesson}`;
      const source = document.createElement("a");
      source.href = item.source;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = item.title || item.source;
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "learn-forget";
      forget.dataset.id = item.id;
      forget.textContent = "Forget";
      entry.append(text, source, forget);
      return entry;
    }));
  } catch {
    learnCount.textContent = "UNAVAILABLE";
  }
}

learnList.addEventListener("click", async (event) => {
  const button = event.target.closest(".learn-forget");
  if (!button) return;
  await fetch(`/api/knowledge/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
  await loadKnowledge();
});

function addLearnLine(message, level = "info") {
  const item = document.createElement("li");
  item.dataset.level = level;
  item.textContent = message;
  learnLog.append(item);
  learnLog.scrollTop = learnLog.scrollHeight;
}

async function runLearning(payload) {
  learnButton.disabled = true;
  curriculumButton.disabled = true;
  learnLog.replaceChildren();
  learnLog.hidden = false;
  try {
    const response = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, drill: learnDrill.checked }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Could not start studying.");
    await readEventStream(response, (item) => {
      if (item.type === "learn-log") addLearnLine(item.message, item.level);
      else if (item.type === "learn-done") addLearnLine(`Finished: studied ${item.pages} page${item.pages === 1 ? "" : "s"}, ${item.lessons} new lesson${item.lessons === 1 ? "" : "s"}${item.asked ? `, exam score ${item.passedFinal}/${item.asked}` : ""}. The team now has ${item.total} lessons and will apply them to new games.`, "ok");
      else if (item.type === "error") addLearnLine(item.message, "error");
    });
  } catch (error) {
    addLearnLine(error.message, "error");
  } finally {
    learnButton.disabled = false;
    curriculumButton.disabled = false;
    await loadKnowledge();
  }
}

curriculumButton.addEventListener("click", () => {
  const tracks = [...learnTracks.querySelectorAll("input:checked")].map((box) => box.value);
  if (!tracks.length) { addLearnLine("Pick at least one track.", "warn"); learnLog.hidden = false; return; }
  runLearning({ tracks });
});

learnForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const urls = learnLinks.value.split(/\s+/).map((value) => value.trim()).filter(Boolean);
  runLearning({ urls, follow: learnFollow.checked });
});

const researchState = document.querySelector("#research-state");
const researchLast = document.querySelector("#research-last");
const researchToggle = document.querySelector("#research-toggle");
let researchEnabled = true;

async function refreshResearch() {
  try {
    const info = await (await fetch("/api/research")).json();
    researchEnabled = info.enabled;
    researchState.textContent = !info.enabled ? "PAUSED" : info.busy ? "YIELDING TO A BUILD" : "WORKING IN THE BACKGROUND";
    researchLast.textContent = `${info.pages} pages studied, ${info.lessons} lessons gained, ${info.today}/${info.dailyCap} today, ${info.queued} queued, ${info.curriculumLeft} curriculum pages left. Latest: ${info.lastMessage}`;
    researchToggle.textContent = info.enabled ? "Pause research" : "Resume research";
  } catch {
    researchState.textContent = "UNAVAILABLE";
  }
}

researchToggle.addEventListener("click", async () => {
  await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !researchEnabled }) });
  await refreshResearch();
});

checkStatus();
loadMemory();
loadKnowledge();
refreshResearch();
setInterval(() => { refreshResearch(); loadKnowledge(); }, 15000);

function showKeyMessage(text, isError) {
  keyMessage.textContent = text;
  keyMessage.classList.toggle("is-error", isError);
  keyMessage.hidden = false;
}

document.querySelector("#curl-fill").addEventListener("click", () => {
  const box = document.querySelector("#curl-text");
  try {
    const found = window.parseCurl(box.value);
    const preset = Object.entries(providerCatalog).find(([id, p]) => id !== "custom" && p.baseUrl === found.baseUrl);
    providerSelect.value = preset ? preset[0] : "custom";
    applyProvider();
    if (!preset) baseUrlInput.value = found.baseUrl;
    if (found.key) keyInput.value = found.key;
    if (found.model) keyModel.value = found.model;
    box.value = "";
    const missing = [!found.key && "API key", !found.model && "model"].filter(Boolean);
    showKeyMessage(`Filled in from cURL (${preset ? preset[1].label.split(" (")[0] : found.baseUrl}).${missing.length ? ` Still needed: ${missing.join(" and ")}.` : " Click Verify & use key."}`, false);
  } catch (error) {
    showKeyMessage(error.message, true);
  }
});

function currentBaseUrl() {
  return providerSelect.value === "custom" ? baseUrlInput.value : (providerCatalog[providerSelect.value] || {}).baseUrl;
}

document.querySelector("#models-load").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showKeyMessage("Asking the provider for its models…", false);
  try {
    const response = await fetch("/api/settings/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: keyInput.value, baseUrl: currentBaseUrl() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load models.");
    const list = document.querySelector("#api-model-list");
    list.replaceChildren(...result.models.map((id) => new Option(id)));
    keyModel.value = "";
    keyModel.focus();
    showKeyMessage(`${result.models.length} models loaded. Click the model field to pick one.`, false);
  } catch (error) {
    showKeyMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  keySave.disabled = true;
  showKeyMessage("Verifying key with the provider…", false);
  try {
    const response = await fetch("/api/settings/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: keyInput.value,
        model: keyModel.value,
        remember: keyRemember.checked,
        baseUrl: providerSelect.value === "custom" ? baseUrlInput.value : (providerCatalog[providerSelect.value] || {}).baseUrl,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save the key.");
    keyInput.value = "";
    showKeyMessage(`Key verified. The team now uses live AI (${result.model}).`, false);
    connectedJustNow = true;
    await checkStatus();
  } catch (error) {
    showKeyMessage(error.message, true);
  } finally {
    keySave.disabled = false;
  }
});

keyClear.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/settings/key", { method: "DELETE" });
    if (!response.ok) throw new Error("Could not remove the key.");
    showKeyMessage("Key removed. The team is back on local agents.", false);
    await checkStatus();
  } catch (error) {
    showKeyMessage(error.message, true);
  }
});
