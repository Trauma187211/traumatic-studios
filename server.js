const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { runStudio } = require("./studio");
const { runDemoStudio } = require("./demo-studio");
const { runLocalStudio, runLocalTask } = require("./local-studio");
const { clearApiKey, enableKeylessDefault, getPublicStatus, isConfigured, listModels, PROVIDERS, runAsVisitor, setApiKey } = require("./settings");
const { authorize } = require("./access");
const { readLearnings } = require("./memory-store");
const { learnFromLinks, listKnowledge, knowledgeReport, removeKnowledge, installSeed } = require("./knowledge");
const research = require("./research");
const { publicTracks, trackUrls } = require("./curriculum");
const { withNotices } = require("./llm");
const { executeAssignedTask, getProjectAssetPath, getProjectWebAssetPath, listProjects, projectArchive, updateTask } = require("./project-builder");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};
const webContentTypes = {
  ...contentTypes,
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function beginEventStream(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  });
}

async function handle(request, response) {
  if (request.method === "GET" && request.url === "/api/projects") {
    try {
      sendJson(response, 200, { projects: await listProjects() });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  const downloadRoute = request.method === "GET" && request.url.split("?")[0].match(/^\/api\/projects\/([^/]+)\/download$/);
  if (downloadRoute) {
    let archive;
    try {
      archive = await projectArchive(downloadRoute[1]);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: error.code === "ENOENT" ? "Project not found." : error.message });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archive.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    try {
      for await (const chunk of archive.chunks) {
        if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
      }
      response.end();
    } catch {
      response.destroy();
    }
    return;
  }

  const taskRoute = request.url.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  const runTaskRoute = request.url.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/run$/);
  if (request.method === "POST" && runTaskRoute) {
    try {
      const result = isConfigured()
        ? await executeAssignedTask(runTaskRoute[1], runTaskRoute[2])
        : await runLocalTask(runTaskRoute[1], runTaskRoute[2]);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 400, { error: error.message });
    }
    return;
  }

  if (request.url === "/api/research") {
    if (request.method === "GET") {
      sendJson(response, 200, research.status());
      return;
    }
    if (request.method === "POST") {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: "Cross-origin requests cannot change the research division." });
        return;
      }
      try {
        const payload = await readJson(request);
        sendJson(response, 200, research.setEnabled(payload?.enabled !== false));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }
  }

  const knowledgeRoute = request.url.match(/^\/api\/knowledge(?:\/([\w-]{1,40}))?$/);
  if (knowledgeRoute) {
    const origin = request.headers.origin;
    if (request.method !== "GET" && origin && new URL(origin).host !== request.headers.host) {
      sendJson(response, 403, { error: "Cross-origin requests cannot change the studio's knowledge." });
      return;
    }
    if (request.method === "GET" && !knowledgeRoute[1]) {
      const items = listKnowledge();
      sendJson(response, 200, { total: items.length, report: knowledgeReport(), tracks: publicTracks(), items: items.slice(0, 200).map(({ id, topic, lesson, source, title }) => ({ id, topic, lesson, source, title })) });
      return;
    }
    if (request.method === "DELETE" && knowledgeRoute[1]) {
      sendJson(response, removeKnowledge(knowledgeRoute[1]) ? 200 : 404, { removed: knowledgeRoute[1] });
      return;
    }
    if (request.method === "POST" && !knowledgeRoute[1]) {
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!isConfigured()) {
        sendJson(response, 400, { error: "Connect an AI provider first (AI connection in the sidebar). The team needs a model to study pages." });
        return;
      }
      const curriculum = Array.isArray(payload?.tracks);
      const urls = curriculum
        ? trackUrls(payload.tracks.filter((value) => typeof value === "string"))
        : Array.isArray(payload?.urls) ? payload.urls.filter((value) => typeof value === "string") : [];
      const options = curriculum
        ? { follow: false, skipKnown: true, drill: payload?.drill !== false, max: 70 }
        : { follow: payload?.follow !== false, drill: payload?.drill !== false };
      beginEventStream(response);
      try {
        await withNotices((message, level) => sendEvent(response, { type: "learn-log", level, message }), () => learnFromLinks(urls, { ...options, emit: (event) => sendEvent(response, event) }));
      } catch (error) {
        sendEvent(response, { type: "error", message: error.message });
      }
      response.end();
      return;
    }
  }

  if (request.url === "/api/settings/models" && request.method === "POST") {
    try {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: "Cross-origin requests cannot list models." });
        return;
      }
      sendJson(response, 200, { models: await listModels((await readJson(request)) || {}) });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.url === "/api/settings/key" && (request.method === "POST" || request.method === "DELETE")) {
    try {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: "Cross-origin requests cannot change the API key." });
        return;
      }
      if (request.method === "DELETE") {
        sendJson(response, 200, clearApiKey());
        return;
      }
      const payload = await readJson(request);
      sendJson(response, 200, await setApiKey(payload || {}));
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "PUT" && taskRoute) {
    let payload;
    try {
      payload = await readJson(request);
      const project = await updateTask(taskRoute[1], taskRoute[2], payload.status);
      sendJson(response, 200, { project });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, /ENOENT/.test(error.code || "") ? 404 : 400, { error: error.message });
      }
    }
    return;
  }

  const webRoute = request.method === "GET" && request.url.split("?")[0].match(/^\/games\/([^/]+)\/web\/([\w.-]+)$/);
  if (webRoute) {
    const filePath = getProjectWebAssetPath(webRoute[1], webRoute[2]);
    const type = filePath && webContentTypes[path.extname(filePath).toLowerCase()];
    if (!type || !fs.existsSync(filePath)) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  const gameRoute = request.method === "GET" && request.url.match(/^\/games\/([^/]+)\/([^/]+)$/);
  if (gameRoute) {
    const filePath = getProjectAssetPath(gameRoute[1], gameRoute[2]);
    if (!filePath) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)],
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content);
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/memory") {
    try {
      sendJson(response, 200, { learnings: await readLearnings() });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && request.url === "/api/status") {
    sendJson(response, 200, {
      ...getPublicStatus(),
      providers: PROVIDERS,
      demoAvailable: true,
      localAvailable: true,
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/run") {
    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const brief = payload && typeof payload.brief === "string" ? payload.brief.trim() : "";
    if (brief.length < 10 || brief.length > 5_000) {
      sendJson(response, 400, { error: "The brief must be between 10 and 5,000 characters." });
      return;
    }

    beginEventStream(response);

    try {
      if (isConfigured()) await runStudio(brief, (event) => sendEvent(response, event));
      else await runLocalStudio(brief, (event) => sendEvent(response, event));
      response.end();
    } catch (error) {
      sendEvent(response, { type: "error", message: error.message });
      response.end();
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/demo-run") {
    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, 400, { error: error.message });
      return;
    }

    const brief = payload && typeof payload.brief === "string" ? payload.brief.trim() : "";
    if (brief.length < 10 || brief.length > 5_000) {
      sendJson(response, 400, { error: "The brief must be between 10 and 5,000 characters." });
      return;
    }

    beginEventStream(response);
    try {
      await runDemoStudio(brief, (event) => sendEvent(response, event));
      response.end();
    } catch (error) {
      sendEvent(response, { type: "error", message: error.message, demo: true });
      response.end();
    }
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

// Every request passes the access gate first. Remote visitors then run inside their own settings scope, never the owner's keys.
const server = http.createServer(async (request, response) => {
  try {
    const access = await authorize(request, response);
    if (!access) return;
    if (access.owner) await handle(request, response);
    else await runAsVisitor(access.store, () => handle(request, response));
  } catch (error) {
    if (!response.headersSent && !response.destroyed) sendJson(response, 500, { error: "Server error." });
    else response.end();
  }
});

if (require.main === module) {
  enableKeylessDefault();
  const seeded = installSeed();
  if (seeded) console.log(`Installed ${seeded} starter lessons.`);
  research.start();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Traumatic Studios is running at http://localhost:${PORT}`);
  });
}

module.exports = { server };
