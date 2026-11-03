(function (root) {
  const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

  // Pulls the provider address, key and model out of a pasted cURL command.
  function parseCurl(text) {
    const source = String(text || "").replace(/\\\r?\n|\^\r?\n|`\r?\n/g, " ");
    const urlMatch = source.match(/https?:\/\/[^\s'"\\^`]+/);
    if (!urlMatch) throw new Error("No web address found. Paste the whole cURL command.");
    const url = new URL(urlMatch[0]);

    let key = "";
    const header = source.match(/(?:x-goog-api-key|api-key|authorization)\s*:\s*(?:bearer\s+)?([^\s'"\\]+)/i);
    if (header) key = header[1];
    if (!key && url.searchParams.get("key")) key = url.searchParams.get("key");
    if (/^\$|^%|^\{/.test(key)) key = "";

    let model = "";
    const inPath = url.pathname.match(/\/models\/([^/:?]+)/);
    const inBody = source.match(/"model"\s*:\s*"([^"]+)"/);
    if (inPath) model = inPath[1];
    else if (inBody) model = inBody[1];
    model = model.replace(/^models\//, "");

    let baseUrl;
    if (url.hostname === "generativelanguage.googleapis.com") {
      baseUrl = GEMINI_OPENAI_BASE;
    } else {
      const path = url.pathname.replace(/\/(chat\/completions|completions|responses|embeddings|models)(\/.*)?$/, "");
      baseUrl = (url.origin + path).replace(/\/+$/, "");
    }
    return { baseUrl, key, model };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseCurl };
  else root.parseCurl = parseCurl;
})(typeof window !== "undefined" ? window : globalThis);
