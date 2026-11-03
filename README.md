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
## Windows desktop app

From this project folder, run `.\build-desktop.ps1` in PowerShell. It creates `Traumatic Studios.exe` and a `Traumatic Studios` shortcut on your Windows Desktop, packages the Node.js runtime and app files under `%USERPROFILE%\Desktop\Traumatic Studios`, and copies existing saved projects into that package. Open the shortcut to launch the dashboard in your browser. The app runs without a console window and shows a system-tray icon; right-click it and choose **Quit** to stop the server. The app folder is portable as a whole, and should not be separated from its `runtime`, `public`, or `projects` folders.

With a key, each sprint makes eight model requests: producer kickoff, two parallel specialist proposals, QA plan review, producer handoff, prototype implementation, QA source review, and a learning summary. Each task run makes up to two more (the bot's change and an independent QA review).
Studio memory is stored in `data/studio-memory.json` on this machine. Only short, reusable lessons are saved—not briefs or full model responses. Set `STUDIO_MEMORY_PATH` before starting the server to choose a different location. This is retrieval-based learning: future agents receive saved lessons as context; the model itself is not retrained. Project briefs are processed in memory and are not persisted. Local-agent sprints save fixed, generic lessons.

After the handoff, the engineer saves a playable browser prototype and owned follow-up tasks, shown with a sandboxed preview. With a key, **Ask [role]** has that bot change the game and an independent QA bot must approve it before it is saved; rejected changes leave the game untouched, and only one bot can change a project at a time. Generated code is limited to `index.html`, `game.js`, and `game.css` (24 KB per file, 48 KB total), syntax-checked and never executed on the server.
The UI binds only to `127.0.0.1` by default; set `PORT` to change the local port. Do not expose this development server to an untrusted network.

## Tests

```powershell
npm test
```
