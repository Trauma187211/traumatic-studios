const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODEL = "gpt-4o-mini";
const KEY_PATTERN = /^[\x21-\x7e]{20,300}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;

let session = { apiKey: "", model: "", remembered: false };
let loaded = false;

function getSettingsFile() {
  return process.env.STUDIO_SETTINGS_PATH || path.join(__dirname, "data", "settings.json");
}

function loadRemembered() {
  if (loaded) return;
  loaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsFile(), "utf8"));
    if (typeof data.apiKey === "string" && KEY_PATTERN.test(data.apiKey)) {
      session = {
        apiKey: data.apiKey,
        model: typeof data.model === "string" && MODEL_PATTERN.test(data.model) ? data.model : "",
        remembered: true,
      };
    }
  } catch {
    // No saved settings, or an unreadable file: fall back to environment/local agents.
  }
}

function getApiKey() {
  loadRemembered();
  return session.apiKey || process.env.OPENAI_API_KEY || "";
}

function getModel() {
  loadRemembered();
  return session.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function getPublicStatus() {
  loadRemembered();
  const source = session.apiKey ? (session.remembered ? "saved" : "session") : process.env.OPENAI_API_KEY ? "environment" : "none";
  return { configured: Boolean(getApiKey()), model: getModel(), keySource: source };
}

function validateKey(apiKey) {
  if (typeof apiKey !== "string" || !KEY_PATTERN.test(apiKey.trim())) {
    throw new Error("That does not look like an API key. Paste the full key without spaces.");
  }
  return apiKey.trim();
}

function validateModel(model) {
  if (model === undefined || model === null || model === "") return "";
  if (typeof model !== "string" || !MODEL_PATTERN.test(model.trim())) {
    throw new Error("Model names may only contain letters, numbers and . _ : / -");
  }
  return model.trim();
}

// Confirms the key is accepted by the provider before it is used for a sprint.
async function verifyKey(apiKey) {
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach the AI provider to verify the key. Check your internet connection.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The provider rejected this API key.");
  }
  if (!response.ok) {
    throw new Error(`The provider could not verify the key (status ${response.status}).`);
  }
}

async function setApiKey({ apiKey, model, remember = false }, { verify = true } = {}) {
  const key = validateKey(apiKey);
  const chosenModel = validateModel(model);
  if (verify) await verifyKey(key);
  session = { apiKey: key, model: chosenModel, remembered: Boolean(remember) };
  loaded = true;
  const file = getSettingsFile();
  if (remember) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ apiKey: key, model: chosenModel }), { encoding: "utf8", mode: 0o600 });
  } else {
    fs.rmSync(file, { force: true });
  }
  return getPublicStatus();
}

function clearApiKey() {
  session = { apiKey: "", model: "", remembered: false };
  loaded = true;
  fs.rmSync(getSettingsFile(), { force: true });
  return getPublicStatus();
}

module.exports = { DEFAULT_MODEL, clearApiKey, getApiKey, getModel, getPublicStatus, setApiKey };
