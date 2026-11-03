const { AsyncLocalStorage } = require("node:async_hooks");
const { DEFAULT_BASE_URL, getApiKey, getBaseUrl, keylessPool, refreshOllama, usingKeylessDefault } = require("./settings");

const RETRY_STATUSES = new Set([402, 429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noticeContext = new AsyncLocalStorage();

// Lets a running sprint hear about things that happen inside model calls (rate limits, retries).
const withNotices = (listener, fn) => noticeContext.run(listener, fn);
const notify = (message, level = "info") => noticeContext.getStore()?.(message, level);

function retryDelayMs(response, attempt) {
  const header = Number(response.headers?.get?.("retry-after"));
  const seconds = Number.isFinite(header) && header > 0 ? header : 5 * 2 ** attempt;
  return Math.min(seconds, 65) * 1000;
}

// Sends one OpenAI-style chat completion to the configured provider. Adapts the request to providers that
// differ from OpenAI (token parameter name, optional JSON mode) and waits out rate limits.
async function llmFetch({ body, timeoutMs = 180_000 }) {
  if (usingKeylessDefault()) return pooledFetch(body, timeoutMs);
  return singleFetch(getBaseUrl(), getApiKey(), JSON.parse(body), timeoutMs);
}

// Keyless mode: try each provider in the pool, moving on at once when one is rate-limited or down.
async function pooledFetch(body, timeoutMs) {
  await refreshOllama();
  const pool = keylessPool();
  let last;
  for (let round = 0; round < 3; round++) {
    for (const [index, provider] of pool.entries()) {
      const payload = { ...JSON.parse(body), model: provider.model };
      try {
        const response = await singleFetch(provider.baseUrl, "", payload, provider.local ? Math.max(timeoutMs, 1_800_000) : timeoutMs, { retries: pool.length > 1 ? 1 : MAX_ATTEMPTS, local: provider.local });
        if (response.ok || !(RETRY_STATUSES.has(response.status) || response.status === 500)) return response;
        last = response;
        notify(`${provider.name} answered ${response.status}; ${index + 1 < pool.length ? `switching to ${pool[index + 1].name}` : "no other provider left"}.`, "warn");
      } catch (error) {
        if (index + 1 === pool.length && round === 2 && !last) throw error;
        notify(`${provider.name} is unavailable (${String(error.message).slice(0, 80)}).`, "warn");
      }
    }
    if (round < 2) {
      const delay = 8_000 * (round + 1);
      notify(`Every free provider is busy. Waiting ${delay / 1000}s, then trying again (${round + 2}/3).`, "warn");
      await sleep(delay);
    }
  }
  if (last) return last;
  throw new Error("No free provider answered.");
}

// Node's built-in fetch gives up if response headers take over 5 minutes, which a large local model on CPU can exceed.
// Local providers therefore go through node:http, which has no such limit.
function httpFetch(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? require("node:https") : require("node:http");
    const request = transport.request(target, { method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, signal }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") responseHeaders.set(name, value);
        const status = res.statusCode || 500;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
      res.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function singleFetch(baseUrl, key, payload, timeoutMs, { retries = MAX_ATTEMPTS, local = false } = {}) {
  const isOpenAI = baseUrl === DEFAULT_BASE_URL;
  if (!isOpenAI && payload.max_completion_tokens !== undefined) {
    payload.max_tokens = payload.max_completion_tokens;
    delete payload.max_completion_tokens;
  }
  const headers = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  let response;
  for (let attempt = 0; attempt < retries; attempt++) {
    response = await (local ? httpFetch : fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    const detail = typeof response.clone === "function" ? await response.clone().text().catch(() => "") : "";
    if (response.status === 400 && payload.response_format && /response_format|json_object|json mode/i.test(detail)) {
      delete payload.response_format;
      attempt--;
      continue;
    }
    if (!RETRY_STATUSES.has(response.status) || attempt === retries - 1) return response;
    const delay = retryDelayMs(response, attempt);
    notify(`The provider answered ${response.status} (${response.status === 429 ? "rate limit" : "busy"}). Waiting ${Math.round(delay / 1000)}s, then retrying (${attempt + 2}/${retries}).`, "warn");
    await sleep(delay);
  }
  return response;
}

// Reasoning models (for example Qwen3) may prefix their answer with a <think> block.
const cleanReply = (text) => text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

module.exports = { cleanReply, llmFetch, notify, withNotices };
