# Traumatic Studios — Game Studio

A small, local-first game-development studio prototype. A producer scopes a game brief, a designer and gameplay engineer work in parallel from the shared kickoff, QA reviews both proposals, and the producer turns the team discussion into a practical handoff. The team shares visible progress messages and carries reusable lessons from completed sprints into future briefs.

During a sprint, the dashboard shows the current step, active bot responses, elapsed wait time, and a separate team-chat transcript. Chat messages quote concise excerpts from the producer kickoff, specialist proposals, QA reviews, and producer handoff, with sender, recipient, and stage labels.

The dashboard uses the Traumatic Studios raven logo and a black, electric-blue, and steel visual theme. The logo asset lives at `public/traumatic-studios-logo.png`.

## Requirements

- Node.js 20 or newer
- An OpenAI API key is **optional**. Without one, built-in local agents run the whole studio.

## Run locally

```powershell
npm start
```

Then visit <http://localhost:3000> and enter a brief of at least 10 characters. With no key, the local agents run the full sprint: kickoff, design and engineering proposals, QA review, handoff, a playable game saved under `projects/`, four owned follow-up tasks, and saved studio learnings. On a task, **Ask [role]** adds an owner-specific working plan for you to carry out, since local agents do not rewrite code.

## Bring your own API key

Use the **Bring your own API key** section in the dashboard to switch the team to live AI. The key is verified with OpenAI before use, and an optional model name can be set. By default it is kept in memory for the current session only. Tick **Remember on this computer** to save it, unencrypted, to `data/settings.json` (override with `STUDIO_SETTINGS_PATH`). **Remove key** clears it. The `OPENAI_API_KEY` and `OPENAI_MODEL` environment variables still work as a fallback, and a key entered in the dashboard takes precedence. The key is sent only to OpenAI and never back to the browser; requests from other origins cannot change it.
## Free, keyless operation

With no API key the studio uses a pool of free providers and fails over between them instantly when one is rate-limited: a local **Ollama** model first (unlimited, runs on your PC; it prefers `studio-coder`, `qwen3-coder`, `qwen2.5-coder`, then others) and **Pollinations** second. Install Ollama and run `ollama pull qwen2.5-coder:7b` (a larger coder model is better if your hardware allows) for the best keyless results. If only Pollinations is available the studio runs in lean mode and skips the optional review and learnings calls. Set `STUDIO_OLLAMA=off` to ignore Ollama.

## Engine Kit

Every browser game is assembled on top of `studio-engine.js` (loop, input, audio, particles, camera) and `studio-kit.js`, a pre-tested library: tile maps with wall-sliding collision, platformer and top-down controllers (coyote time, jump buffering, variable jump), health and knockback, timers, tweens, state machines, A* and flow-field pathfinding, line of sight, noise, always-connected room/cave/maze generators, a lock-and-key dungeon generator with a verified solvable key order, a procedural music composer, a dialogue box and palettes. `studio-kit.test.js` covers it. Generated code is also linted for a few learned rules (seeded randomness, dt-based timing, sound and game-feel calls); violations go through the repair loop.

## Research while the app is closed

The server researches while it is running. To keep researching when the dashboard is closed, run `install-background-research.bat` once: it places a hidden launcher in your Startup folder (no admin needed) that runs `research-daemon.js` at sign-in. The daemon steps aside whenever the dashboard is open. Run `remove-background-research.bat` to undo. It only runs while the PC is on and you are signed in.

## Teach the studio

The **Teach the studio** panel makes the team study text sources and remember them. Start the built-in free curriculum (design theory, genre playbooks, game programming patterns, algorithms, browser game craft and the Godot docs) or paste your own links. For each page the team writes lessons, sits a closed-book exam on them, is re-taught anything it misses and is retested. Lessons are saved in `data/knowledge.json` and the most relevant ones are added to the planning, design and code prompts of every new game. Videos cannot be studied; only readable text pages.

## Windows desktop app

From this project folder, run `.\build-desktop.ps1` in PowerShell. It creates `Traumatic Studios.exe` and a `Traumatic Studios` shortcut on your Windows Desktop, packages the Node.js runtime and app files under `%USERPROFILE%\Desktop\Traumatic Studios`, and copies existing saved projects into that package. Open the shortcut to launch the dashboard in your browser. The app runs without a console window and shows a system-tray icon; right-click it and choose **Quit** to stop the server. The app folder is portable as a whole, and should not be separated from its `runtime`, `public`, or `projects` folders.

With a key, each sprint makes eight model requests: producer kickoff, two parallel specialist proposals, QA plan review, producer handoff, prototype implementation, QA source review, and a learning summary. Each task run makes up to two more (the bot's change and an independent QA review).
Studio memory is stored in `data/studio-memory.json` on this machine. Only short, reusable lessons are saved—not briefs or full model responses. Set `STUDIO_MEMORY_PATH` before starting the server to choose a different location. This is retrieval-based learning: future agents receive saved lessons as context; the model itself is not retrained. Project briefs are processed in memory and are not persisted. Local-agent sprints save fixed, generic lessons.

After the handoff, the engineer builds the game and saves it with owned follow-up tasks, shown with a sandboxed preview. With a key, **Ask [role]** has that bot change the game and an independent QA bot must approve it before it is saved; rejected changes leave the game untouched, and only one bot can change a project at a time.

### Build engines (with a key)
1. **Godot (preferred).** If Godot 4 is found (set `GODOT_PATH`, or it is auto-detected in Downloads, Desktop or Documents), the game is written as a real GDScript project, loaded and play-tested headless by Godot with random input, repaired from Godot's own errors, and exported to Web (`projects/<id>/web`; editable source in `projects/<id>/godot`). Web export templates for your Godot version must be installed. Generated GDScript that uses OS, file, network or shell APIs is rejected. Task bots patch the scripts, re-verify and re-export.
2. **Browser engine.** If Godot is missing or fails, a multi-module canvas game (up to 240 KB `game.js`, built on the `studio-engine.js` toolkit) is generated and smoke-tested in a stub DOM. Set `STUDIO_ENGINE=web` to force this.
3. **Compact prototype.** Final fallback: the original small single-shot game (24 KB per file).

Generated code is never executed in the server process (Godot runs as a separate headless process on your machine).
The UI binds only to `127.0.0.1` by default; set `PORT` to change the local port. Do not expose this development server to an untrusted network.

## Tests

```powershell
npm test
```

## Blueprints and module sanitizer (keyless builds)

When running on the free keyless models, the generator first asks the model for a small JSON spec and runs it on pre-tested templates in `studio-blueprints.js` (top-down adventure, platformer, arena survivor). Ideas that fit none of them (puzzle, cards, racing, classics, etc.) fall back to freeform module generation, where `module-sanitizer.js` deterministically strips `export` statements and fixes invented `Kit`/`Engine` names. Set `STUDIO_BLUEPRINTS=always` or `off` to override.

## Sharing with friends (password + own keys)

Run `cloudflared tunnel --url http://localhost:3000`. Visitors through the tunnel must sign in with the password in `data\access-password.txt` (or `STUDIO_ACCESS_PASSWORD`; 8+ characters; with none set, remote access is refused). You, on localhost, are never asked. Visitors get their own in-memory AI connection: your saved and environment keys are never used for them, and keys they enter are never written to disk. They can add their own key for stronger models. Only the owner can toggle research or delete knowledge.

Each project card has a **Download** button (a .zip with index.html, game.js, game.css and a README; Godot projects include web/ and godot/). Owner and signed-in friends can use it.
