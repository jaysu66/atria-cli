import { createEventStreamServer } from "./server-core.mjs";

const server = createEventStreamServer({
  enablePanelControlServer: true,
  panelControlServeOnly: true,
  panelControlKeepAlive: true,
});

function shutdown(exitCode = 0) {
  try {
    server.closeRecorder?.();
  } finally {
    process.exit(exitCode);
  }
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

