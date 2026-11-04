# Traumatic Studios

A small studio of AI agents that turns a game brief into a playable game in your browser. It is built to work for free: no API key is needed, and anyone with an idea can use it, whatever the genre.

A producer scopes your brief, a designer and a gameplay engineer work from the same kickoff, QA reviews both proposals, and the producer writes a handoff. A game generator then builds a playable project from that handoff, checks it, repairs it, and lets you download it.

## Contents

- [Quick start](#quick-start)
- [Download for Windows](#download-for-windows)
- [How a game gets built](#how-a-game-gets-built)
- [Models and keys](#models-and-keys)
- [Sharing with friends](#sharing-with-friends)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Project layout](#project-layout)
- [Building releases](#building-releases)
- [Testing](#testing)
- [Known limits](#known-limits)
- [License](#license)

## Quick start

Requires Node.js 20 or newer. There are no npm dependencies.

```
npm start
```

Open http://localhost:3000, type a brief, and press run. The server listens on `127.0.0.1` only. Set `PORT` to change the port.

Press **Demo** (the `/api/demo-run` route) to see a full sprint without calling any model.

## Download for Windows

The [latest release](https://github.com/Trauma187211/traumatic-studios/releases/latest) is a zip that bundles the Node runtime, so nothing has to be installed first.

1. Extract the zip.
2. Run `START.bat`. The dashboard opens in your browser.
3. Optional: run `SETUP AI.bat` to install [Ollama](https://ollama.com) and a local model. Without it, the studio uses a slower free online model (Pollinations).

The zip ships with empty `data` and `projects` folders. No keys or settings are included. The build is unsigned, so Windows SmartScreen may warn you the first time.

## How a game gets built

1. **Sprint.** The producer, designer, engineer and QA agents discuss the brief. Progress messages stream to the dashboard.
2. **Handoff.** The producer writes a practical plan. Lessons from earlier sprints are carried into new briefs (`memory-store.js`).
3. **Generation.** `game-generator.js` picks a route:
   - **Blueprint route** (default for free, keyless models). A router (`blueprint-router.js`) reads the brief and chooses a proven, tested blueprint from `studio-blueprints.js`: *adventure* (Zelda-like), *platformer* or *arena*. The model fills in data such as the story, map, enemies and items rather than writing an engine. A blueprint game typically builds in about 20 seconds on a local 7B model, against 10 to 15 minutes for freeform.
   - **Freeform route.** For any other genre, or when blueprints are off, the model writes the game code itself on top of the shared engine and kit.
   - **Godot route.** `godot-generator.js` writes a Godot project and `godot-runner.js` checks and exports it to the web. This needs Godot installed (see `GODOT_PATH`).
4. **Safety nets.** Each module passes through `module-sanitizer.js`, which makes deterministic fixes to common small-model mistakes. Forbidden-code checks and a smoke test then run, and a repair loop retries failures.
5. **Result.** The game is saved under `projects/`. Download it from the dashboard as a zip containing the game and a README.

### The engine and kit

`studio-engine.js` is a browser toolkit that generated games use: game loop, input, audio, particles, camera, collision, grids and pathfinding. `studio-kit.js` adds higher-level pieces on top of it. Generated games load them, so a model only has to write game-specific logic.

### Learning

The studio can study free reading material in the background, so its notes improve over time.

- `curriculum.js` lists study tracks of public pages (Wikipedia, Game Programming Patterns, Godot and MDN docs, Red Blob Games).
- `knowledge.js` fetches and summarises them into lessons, and refuses private or local addresses.
- `research.js` and `research-daemon.js` run that study. The daemon works without the dashboard.
- `seed-knowledge.json` is the starting set of lessons.

To keep research running while the app is closed, use `install-background-research.bat` (and `remove-background-research.bat` to undo it). Research can be switched off from the dashboard.

## Models and keys

| Source | Cost | Notes |
| --- | --- | --- |
| Local Ollama (`qwen2.5-coder:7b` by default) | Free | Private and unlimited. Uses your CPU or GPU. A larger model such as `qwen2.5-coder:14b` gives better results. |
| Pollinations | Free | Used as a fallback. It allows about one request every 30 seconds. |
| Any OpenAI-compatible API | Your key | Add it under settings in the dashboard, or set `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`. |

Keys saved in the dashboard are stored in `data\` on your machine. That folder is git-ignored.

## Sharing with friends

There are two ways to share, and both keep your settings and keys private.

**Give them the download.** Friends run their own copy on their own PC. This is the simplest option, uses their CPU and not yours, and needs no hosting.

**Host a live copy.** A hosted copy runs on your PC and is reached over a tunnel, so it uses your CPU. Run `make-hosted.ps1` to build a hosted folder on your Desktop. Its `START HOSTED.bat` starts the server on port 3100 together with a Cloudflare quick tunnel (`cloudflared`).

Hosted mode (`STUDIO_HOSTED=1`) and the access gate in `access.js` provide the following:

- Every page and API route needs a password. A login page handles it.
- Five wrong attempts lock that client out for 10 minutes, and a global limit applies too.
- Sessions last 12 hours and live in memory. The cookie is `HttpOnly` and `SameSite=Strict`, and it is `Secure` when served over https.
- There is no owner in hosted mode. Nobody can change your settings, toggle research or delete knowledge.
- Your saved and environment keys are never exposed. Each visitor supplies their own key to use a stronger model. Their keys are kept in memory for their session only and are never written to disk. Visitors cannot point providers at localhost or private addresses.
- With no password configured, remote requests get a 503.

Set the password in `data\access-password.txt`, or with `STUDIO_ACCESS_PASSWORD`. A file change takes effect without a restart. Pick a long, unguessable password and do not commit it.

Quick tunnel links are random and temporary, and your PC must stay on. A permanent link needs a domain on Cloudflare.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Dashboard port. Default `3000`. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Use an OpenAI-compatible provider. |
| `OLLAMA_HOST` | Address of the Ollama server. |
| `STUDIO_OLLAMA` | Choose the local Ollama model. |
| `STUDIO_BLUEPRINTS` | `always` forces the blueprint route, `off` disables it. By default it is on for keyless models. |
| `GODOT_PATH` | Path to a Godot executable for the Godot route. |
| `STUDIO_SETTINGS_PATH` | Where settings are stored. |
| `STUDIO_HOSTED` | `1` turns on hosted mode (no owner). |
| `STUDIO_ACCESS_PASSWORD`, `STUDIO_ACCESS_FILE` | Password for remote access, or a file that holds it. |

## HTTP API

Used by the dashboard.

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Server and model status. |
| `POST /api/run` | Run a sprint and build a game from a brief. |
| `POST /api/demo-run` | Run a scripted sprint without a model. |
| `GET /api/projects` | List projects. |
| `GET /api/projects/:id/download` | Download a project as a zip. |
| `/api/projects/:id/tasks/:task` | Edit a task. |
| `POST /api/projects/:id/tasks/:task/run` | Run a task with the agents. |
| `GET /api/memory` | Lessons carried between sprints. |
| `/api/research` | Research status. Changing it is owner only. |
| `/api/knowledge` | Study notes. Deleting is owner only. |
| `POST /api/settings/models` | Choose models. |
| `POST` or `DELETE /api/settings/key` | Save or remove an API key. |

## Project layout

| Path | Role |
| --- | --- |
| `server.js` | HTTP server, routing and static files. |
| `access.js` | Password gate, sessions, rate limiting, hosted mode. |
| `settings.js` | Models and keys, with per-visitor settings. |
| `llm.js` | Model calls with retry and provider pooling. |
| `studio.js`, `local-studio.js`, `demo-studio.js` | Sprint orchestration (live, local and scripted). |
| `game-generator.js` | The browser-game pipeline. |
| `studio-blueprints.js`, `blueprint-router.js`, `blueprint-harness.js` | Blueprint games, routing and test harness. |
| `studio-engine.js`, `studio-kit.js` | Browser toolkit used by generated games. |
| `module-sanitizer.js` | Deterministic fixes for generated modules. |
| `godot-generator.js`, `godot-runner.js` | The Godot route. |
| `task-patcher.js` | Edits existing projects task by task. |
| `project-builder.js`, `project-zip.js` | Project files and the zip writer (no dependencies). |
| `memory-store.js` | Carried lessons. |
| `knowledge.js`, `curriculum.js`, `research.js`, `research-daemon.js`, `seed-knowledge.json` | Learning system. |
| `public/` | Dashboard (`index.html`, `app.js`, `styles.css`, `curl-import.js`). |
| `*.test.js` | Tests, next to the code they cover. |
| `make-release.ps1`, `make-hosted.ps1`, `build-desktop.ps1` | Packaging scripts. |

## Building releases

All scripts are PowerShell and build from the working tree.

- `make-release.ps1` writes `dist\Traumatic-Studios-Windows.zip`. It scans for secrets first, using your saved keys and passwords, and stops if it finds one.
- `make-hosted.ps1` builds the hosted folder on your Desktop.
- `build-desktop.ps1` builds the local desktop copy.

To publish, attach the zip to a GitHub release, for example with `gh release create`.

## Testing

```
npm test
```

This runs every `*.test.js` file with Node's built-in test runner. No network or model is needed, because tests mock `fetch`.

## Known limits

- Blueprints cover adventure, platformer and arena. Other genres use the freeform route, which is slower and less reliable on small models.
- Blueprint games are less bespoke than freeform output.
- Small local models struggle with long code. A larger Ollama model or your own API key helps a lot.
- The studio kit has not been shown to improve results with every model.
- Windows is the supported platform for the packaged release.

## License

MIT. See [LICENSE](LICENSE).
