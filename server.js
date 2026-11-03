const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { runStudio } = require("./studio");
const { runDemoStudio } = require("./demo-studio");
const { runLocalStudio, runLocalTask } = require("./local-studio");
const { clearApiKey, getApiKey, getPublicStatus, setApiKey } = require("./settings");
const { readLearnings } = require("./memory-store");
const { executeAssignedTask, getProjectAssetPath, listProjects, updateTask } = require("./project-builder");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
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
      if (body.length > 16_384) {
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
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/projects") {
    try {
      sendJson(response, 200, { projects: await listProjects() });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  const taskRoute = request.url.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  const runTaskRoute = request.url.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/run$/);
  if (request.method === "POST" && runTaskRoute) {
    try {
      const result = getApiKey()
        ? await executeAssignedTask(runTaskRoute[1], runTaskRoute[2])
        : await runLocalTask(runTaskRoute[1], runTaskRoute[2]);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 400, { error: error.message });
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
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
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
    if (brief.length < 10 || brief.length > 2_000) {
      sendJson(response, 400, { error: "The brief must be between 10 and 2,000 characters." });
      return;
    }

    beginEventStream(response);

    try {
      if (getApiKey()) await runStudio(brief, (event) => sendEvent(response, event));
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
    if (brief.length < 10 || brief.length > 2_000) {
      sendJson(response, 400, { error: "The brief must be between 10 and 2,000 characters." });
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
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Traumatic Studios is running at http://localhost:${PORT}`);
  });
}

module.exports = { server };
