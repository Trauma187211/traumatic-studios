const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const KEY_PATTERN = /^[\x21-\x7e]{20,300}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;

// Any OpenAI-compatible chat endpoint works. Model names are suggestions only; providers rename them often.
const PROVIDERS = {
  openai: { label: "OpenAI", baseUrl: DEFAULT_BASE_URL, keyRequired: true, model: "gpt-4o-mini" },
  openrouter: { label: "OpenRouter (Qwen and other open models, free tier available)", baseUrl: "https://openrouter.ai/api/v1", keyRequired: true, model: "qwen/qwen3-coder:free" },
  qwen: { label: "Alibaba Qwen (DashScope)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyRequired: true, model: "qwen3-coder-plus" },
  gemini: { label: "Google Gemini (free key from AI Studio)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyRequired: true, model: "gemini-flash-latest" },
  groq: { label: "Groq (free tier available)", baseUrl: "https://api.groq.com/openai/v1", keyRequired: true, model: "" },
  ollama: { label: "Ollama (your own machine, no key)", baseUrl: "http://localhost:11434/v1", keyRequired: false, model: "qwen2.5-coder:7b" },
  pollinations: { label: "Pollinations (no key, heavily rate-limited)", baseUrl: "https://text.pollinations.ai/openai", keyRequired: false, model: "openai" },
  custom: { label: "Custom OpenAI-compatible endpoint", baseUrl: "", keyRequired: false, model: "" },
};

// Remote visitors run inside their own store: they never see the owner's saved or environment keys, and nothing they enter is written to disk.
const visitors = new AsyncLocalStorage();
const newVisitorStore = () => ({ session: { apiKey: "", model: "", baseUrl: "", remembered: false } });
const runAsVisitor = (store, fn) => visitors.run(store, fn);
const emptySession = () => ({ apiKey: "", model: "", baseUrl: "", remembered: false });
let ownerSession = emptySession();
const current = () => visitors.getStore()?.session || ownerSession;
const isVisitor = () => Boolean(visitors.getStore());
let loaded = false;
let keylessDefault = false;

// When on and nothing else is configured, the studio uses a keyless hosted model instead of the fixed offline templates.
function enableKeylessDefault() {
  keylessDefault = true;
}

function usingKeylessDefault() {
  loadRemembered();
  const session = current();
  if (isVisitor()) return keylessDefault && !session.apiKey && !session.baseUrl;
  return keylessDefault && !session.apiKey && !session.baseUrl && !process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL;
}

const OLLAMA_URL = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_PREFERENCE = [/^studio-coder/, /qwen3-coder/, /qwen2\.5-coder:(32|14)b/, /qwen2\.5-coder/, /deepseek-coder-v2/, /qwen3/, /llama3/, /gemma/];
let ollamaModel = "";
let ollamaCheckedAt = 0;

// Finds a local Ollama model (unlimited, no key). Cached so every call does not probe the port.
async function refreshOllama({ force = false } = {}) {
  if (process.env.STUDIO_OLLAMA === "off") return "";
  if (!force && Date.now() - ollamaCheckedAt < 60_000) return ollamaModel;
  ollamaCheckedAt = Date.now();
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const names = response.ok ? ((await response.json()).models || []).map((m) => m.name).filter((n) => MODEL_PATTERN.test(n) && !/embed|vision|llava/i.test(n)) : [];
    ollamaModel = "";
    for (const rule of OLLAMA_PREFERENCE) {
      const match = names.find((n) => rule.test(n));
      if (match) { ollamaModel = match; break; }
    }
  } catch {
    ollamaModel = "";
  }
  return ollamaModel;
}

// Ordered providers used when no key is configured: local Ollama first, then the hosted keyless service.
function keylessPool() {
  const pool = [];
  if (ollamaModel) pool.push({ name: "Ollama (local)", baseUrl: `${OLLAMA_URL}/v1`, model: ollamaModel, local: true });
  pool.push({ name: "Pollinations", baseUrl: PROVIDERS.pollinations.baseUrl, model: process.env.OPENAI_MODEL || PROVIDERS.pollinations.model, local: false });
  return pool;
}

function getSettingsFile() {
  return process.env.STUDIO_SETTINGS_PATH || path.join(__dirname, "data", "settings.json");
}

function loadRemembered() {
  if (loaded || isVisitor()) return;
  loaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsFile(), "utf8"));
    const apiKey = typeof data.apiKey === "string" && KEY_PATTERN.test(data.apiKey) ? data.apiKey : "";
    const baseUrl = typeof data.baseUrl === "string" ? safeBaseUrl(data.baseUrl) : "";
    if (apiKey || baseUrl) {
      ownerSession = {
        apiKey,
        baseUrl,
        model: typeof data.model === "string" && MODEL_PATTERN.test(data.model) ? data.model : "",
        remembered: true,
      };
    }
  } catch {
    // No saved settings, or an unreadable file: fall back to environment/local agents.
  }
}

function safeBaseUrl(value) {
  try { return validateBaseUrl(value); } catch { return ""; }
}

function getApiKey() {
  loadRemembered();
  if (isVisitor()) return current().apiKey;
  return current().apiKey || process.env.OPENAI_API_KEY || "";
}

function getBaseUrl() {
  loadRemembered();
  if (usingKeylessDefault()) return keylessPool()[0].baseUrl;
  const session = current();
  return (session.baseUrl || (isVisitor() ? "" : process.env.OPENAI_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getModel() {
  loadRemembered();
  if (usingKeylessDefault()) return keylessPool()[0].model;
  return current().model || (isVisitor() ? "" : process.env.OPENAI_MODEL) || DEFAULT_MODEL;
}

// Live AI is on when a key exists, a custom (keyless) provider has been chosen, or the keyless default is active.
function isConfigured() {
  loadRemembered();
  return Boolean(getApiKey()) || Boolean(current().baseUrl) || usingKeylessDefault();
}

function getPublicStatus() {
  loadRemembered();
  const session = current();
  const source = session.apiKey || session.baseUrl ? (session.remembered ? "saved" : "session") : !isVisitor() && process.env.OPENAI_API_KEY ? "environment" : "none";
  const status = { configured: isConfigured(), model: getModel(), keySource: source, keyless: usingKeylessDefault() };
  if (isVisitor()) status.visitor = true;
  const baseUrl = getBaseUrl();
  if (baseUrl !== DEFAULT_BASE_URL) status.provider = new URL(baseUrl).host;
  return status;
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

function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("The provider address is not a valid URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (isVisitor() && (local || /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(url.hostname) || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal"))) throw new Error("Remote visitors can only use public https providers.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The provider address must not contain credentials, a query or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The provider address must use https (http is only allowed for localhost).");
  return url.toString().replace(/\/+$/, "");
}

// Confirms the key is accepted by the provider before it is used for a sprint.
async function verifyKey(apiKey, baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach the AI provider to verify the key. Check the address and your connection.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The provider rejected this API key.");
  }
  // Many compatible providers have no /models listing; only treat real failures as errors.
  if (!response.ok && response.status !== 404 && response.status !== 405) {
    throw new Error(`The provider could not verify the key (status ${response.status}).`);
  }
}

// Asks the provider which models it currently offers so the user can pick instead of typing.
async function listModels({ apiKey, baseUrl } = {}) {
  const custom = typeof baseUrl === "string" && baseUrl.trim() !== "" && baseUrl.trim().replace(/\/+$/, "") !== DEFAULT_BASE_URL;
  const base = custom ? validateBaseUrl(baseUrl) : DEFAULT_BASE_URL;
  const hasKey = typeof apiKey === "string" && apiKey.trim() !== "";
  const key = hasKey || !custom ? validateKey(apiKey) : "";
  let response;
  try {
    response = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach the AI provider. Check the address and your connection.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("The provider rejected this API key.");
  if (!response.ok) throw new Error(`This provider does not offer a model list (status ${response.status}). Type the model name instead.`);
  const data = await response.json().catch(() => ({}));
  const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const ids = items
    .map((item) => String(typeof item === "string" ? item : item.id || item.name || "").replace(/^models\//, ""))
    .filter((id) => MODEL_PATTERN.test(id));
  return [...new Set(ids)].sort().slice(0, 300);
}

async function setApiKey({ apiKey, model, remember = false, baseUrl }, { verify = true } = {}) {
  const custom = typeof baseUrl === "string" && baseUrl.trim() !== "" && baseUrl.trim().replace(/\/+$/, "") !== DEFAULT_BASE_URL;
  const chosenBase = custom ? validateBaseUrl(baseUrl) : "";
  const hasKey = typeof apiKey === "string" && apiKey.trim() !== "";
  const key = hasKey || !custom ? validateKey(apiKey) : "";
  const chosenModel = validateModel(model);
  if (custom && !chosenModel) throw new Error("Enter the model name this provider should use.");
  if (verify) await verifyKey(key, chosenBase || DEFAULT_BASE_URL);
  const store = visitors.getStore();
  if (store) {
    store.session = { apiKey: key, model: chosenModel, baseUrl: chosenBase, remembered: false };
    return getPublicStatus();
  }
  ownerSession = { apiKey: key, model: chosenModel, baseUrl: chosenBase, remembered: Boolean(remember) };
  loaded = true;
  const file = getSettingsFile();
  if (remember) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ apiKey: key, model: chosenModel, baseUrl: chosenBase }), { encoding: "utf8", mode: 0o600 });
  } else {
    fs.rmSync(file, { force: true });
  }
  return getPublicStatus();
}

function clearApiKey() {
  const store = visitors.getStore();
  if (store) {
    store.session = emptySession();
    return getPublicStatus();
  }
  ownerSession = emptySession();
  loaded = true;
  fs.rmSync(getSettingsFile(), { force: true });
  return getPublicStatus();
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_MODEL, PROVIDERS, clearApiKey, enableKeylessDefault, getApiKey, getBaseUrl, getModel, getPublicStatus, isConfigured, keylessPool, listModels, newVisitorStore, refreshOllama, runAsVisitor, setApiKey, usingKeylessDefault, validateBaseUrl };
