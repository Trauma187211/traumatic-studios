// Runs the research division without the dashboard, so the studio keeps learning while the app is closed.
// It steps aside whenever the dashboard server is running (the server researches by itself then).
const { enableKeylessDefault } = require("./settings");
const { installSeed } = require("./knowledge");
const research = require("./research");

const PORT = Number(process.env.PORT) || 3000;

async function serverIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/research`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startDaemon() {
  // Binding a local port makes a second copy exit immediately.
  const guard = require("node:net").createServer();
  guard.on("error", () => process.exit(0));
  guard.listen(Number(process.env.STUDIO_DAEMON_PORT) || 39817, "127.0.0.1", () => {
    enableKeylessDefault();
    installSeed();
    research.start({ initialDelay: 30_000, shouldRun: async () => !(await serverIsRunning()) });
  });
}

if (require.main === module) startDaemon();

module.exports = { serverIsRunning, startDaemon };
