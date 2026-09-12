import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) || process.env.PORT || 47931);
const token = "browser-token";
const sessionID = "browser-ui-smoke";
const state = {
  isRecording: false,
  startedAt: null,
  sessionID,
  eventCount: 0,
  calls: [],
};

const css = readFileSync(
  path.join(root, "mcp", "widget-assets", "status-panel", "panel.css"),
  "utf8",
);
const js = readFileSync(
  path.join(root, "mcp", "widget-assets", "status-panel", "panel.js"),
  "utf8",
);

function payload(extra = {}) {
  return {
    isRecording: state.isRecording,
    startedAt: state.startedAt,
    maxDurationSeconds: 60,
    sessionID,
    sessionDirectoryPath: `C:/Users/tester/AppData/Local/Codex/EventStream/sessions/${sessionID}`,
    eventsPath: `C:/Users/tester/AppData/Local/Codex/EventStream/sessions/${sessionID}/events.jsonl`,
    eventCount: state.eventCount,
    suppressedEventCount: 0,
    ...extra,
  };
}

function pageHtml() {
  const endpoint = `http://127.0.0.1:${port}/tool`;
  const setup = `
window.__sentMessages = [];
window.__serverToolCalls = [];
window.__RECORD_REPLAY_PANEL_CONTROL__ = { endpoint: ${JSON.stringify(endpoint)}, token: ${JSON.stringify(token)} };
window.openai = { toolResponseMetadata: { widgetData: { isRecording: false, maxDurationSeconds: 60 } } };
window.recordReplayMcp = {
  getBridgeState() { return { ready: true, connected: true, serverTools: true, message: true, error: "" }; },
  callServerTool(request) { window.__serverToolCalls.push(request); throw new Error("MCP proxy not enabled"); },
  sendUserMessage(request) { window.__sentMessages.push(request); return Promise.resolve({}); },
  notifyResize() {},
};
`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${css}</style>
    <script>${setup}</script>
  </head>
  <body>
    <main id="app" class="panel-shell" aria-live="polite"></main>
    <script>${js}</script>
  </body>
</html>`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type, x-record-replay-token");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml());
    return;
  }

  if (request.method === "GET" && request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(state));
    return;
  }

  if (request.method === "POST" && request.url === "/tool") {
    if (request.headers["x-record-replay-token"] !== token) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }

    const body = await readJson(request);
    state.calls.push(body);
    let result;

    if (body.name === "event_stream_start") {
      state.isRecording = true;
      state.startedAt = new Date().toISOString();
      state.eventCount = 1;
      result = payload();
    } else if (body.name === "event_stream_status") {
      if (state.isRecording) state.eventCount += 1;
      result = payload();
    } else if (body.name === "event_stream_stop") {
      state.isRecording = false;
      state.eventCount += 2;
      result = payload({
        generatedSkill: {
          installed: true,
          draft: true,
          skillName: "record-replay-browser-ui-smoke",
          skillPath: "C:/Users/tester/.codex/skills/record-replay-browser-ui-smoke/SKILL.md",
        },
        summarySource: "automatic-event-analysis",
        requiresWorkflowSummary: false,
        requiresCodexRefinement: true,
        reviewRecommended: true,
        nextAction: { tool: "event_stream_generate_skill", sessionID },
        codexRefinementContext: {
          instruction: "Review and regenerate.",
          sessionID,
          timeline: [{ type: "keyboard.keyDown", app: "Codex.exe", window: "Codex", key: "A" }],
        },
      });
    } else if (body.name === "event_stream_generate_skill") {
      result = payload({
        generatedSkill: {
          installed: true,
          skillName: "record-replay-browser-ui-smoke-final",
          skillPath: "C:/Users/tester/.codex/skills/record-replay-browser-ui-smoke-final/SKILL.md",
        },
        summarySource: "codex-summary",
        requiresWorkflowSummary: false,
        requiresCodexRefinement: false,
        reviewRecommended: false,
        requiresNewThread: true,
      });
    } else {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: `Unknown tool ${body.name}` }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/`, port }));
});
