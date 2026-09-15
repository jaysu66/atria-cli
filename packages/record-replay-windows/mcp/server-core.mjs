import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { pluginPath } from "./plugin-path.mjs";
import { defaultSessionRoot, NativeRecorderClient } from "./native-client.mjs";
import { NativeActorClient } from "./actor-client.mjs";
import { ActionCoordinator } from "./action-coordinator.mjs";
import { VisualController } from "./visual-controller.mjs";
import { executeReplay, planReplay, readJsonlFile } from "./replay-runner.mjs";
import { analyzeWorkflow, installGeneratedSkill, readJsonl } from "./skill-generator.mjs";
import { inlineWidget, readText, registerWidgetResource } from "./widget-resource.mjs";

const manifest = JSON.parse(readFileSync(pluginPath(".codex-plugin", "plugin.json"), "utf8"));
const STATUS_PANEL_URI = "ui://widget/record-replay-windows-status-panel.html";
const DEFAULT_PANEL_CONTROL_PORT = 47874;
const PANEL_CONTROL_PORT_COUNT = 6;
const MAX_EVENTS_FOR_SAMPLING = 60;

function asToolResult(result, { widget = false, isError = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
    ...(widget
      ? {
          _meta: {
            "openai/outputTemplate": STATUS_PANEL_URI,
            "openai/widgetAccessible": true,
            widgetData: result,
          },
        }
      : {}),
  };
}

function widgetMeta({ invoking, invoked, visibility = ["model", "app"] }) {
  return {
    ui: {
      resourceUri: STATUS_PANEL_URI,
      visibility,
    },
    "openai/outputTemplate": STATUS_PANEL_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function countJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean).length;
}

function latestSessionID(sessionRoot) {
  if (!fs.existsSync(sessionRoot)) return "";
  return fs
    .readdirSync(sessionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(sessionRoot, entry.name);
      return { sessionID: entry.name, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.sessionID || "";
}

function sessionFromID(recorder, sessionID) {
  const sessionRoot = recorder.sessionRoot || defaultSessionRoot();
  const id = sessionID || latestSessionID(sessionRoot);
  if (!id) return null;
  if (id !== path.basename(id)) throw new Error("Invalid sessionID.");
  const sessionDirectoryPath = path.join(sessionRoot, id);
  const eventsPath = path.join(sessionDirectoryPath, "events.jsonl");
  const metadataPath = path.join(sessionDirectoryPath, "metadata.json");
  const suppressedEventsPath = path.join(sessionDirectoryPath, "suppressed_events.jsonl");
  return {
    sessionID: id,
    sessionDirectoryPath,
    capturesDirectoryPath: path.join(sessionDirectoryPath, "captures"),
    eventsPath,
    metadataPath,
    suppressedEventsPath,
    eventCount: countJsonl(eventsPath),
    suppressedEventCount: countJsonl(suppressedEventsPath),
    isRecording: false,
  };
}

function generateSkillForSession(recorder, input, options = {}) {
  const session = sessionFromID(recorder, input.sessionID);
  if (!session || !fs.existsSync(session.eventsPath)) {
    return {
      session,
      skill: {
        installed: false,
        activationNote: "No completed recording event stream was available, so no skill was generated.",
      },
    };
  }
  return {
    session,
    skill: installGeneratedSkill(session, {
      workflowName: input.workflowName,
      workflowSummary: input.workflowSummary,
      skillsRoot: options.skillsRoot,
      replaceSessionSkills: Boolean(input.replaceSessionSkills),
    }),
  };
}

function eventApp(event) {
  return event.application?.processName || event.application?.name || "unknown";
}

function eventWindow(event) {
  return event.window?.title || event.application?.windowTitle || "";
}

function eventTarget(event) {
  return event.target?.uia?.name || event.target?.uia?.automationId || event.target?.uia?.controlType || "";
}

function codexRefinementContext(stopped, skill) {
  const events = readJsonl(stopped.eventsPath);
  const workflow = analyzeWorkflow(events, stopped);
  const appCounts = new Map();
  const keyNames = [];
  const timeline = [];
  for (const event of events) {
    const app = eventApp(event);
    if (app) appCounts.set(app, (appCounts.get(app) || 0) + 1);
    if (event.type?.startsWith("keyboard.") && event.input?.keyName && keyNames.length < 20) {
      keyNames.push(event.input.keyName);
    }
    if (timeline.length < 30 && !event.type?.startsWith("recorder.")) {
      timeline.push({
        type: event.type,
        app,
        window: eventWindow(event),
        target: eventTarget(event),
        key: event.input?.keyName || "",
      });
    }
  }
  return {
    instruction:
      "Review this draft skill and event summary. Then call event_stream_generate_skill with a concise semantic workflowName and workflowSummary that describe what the user actually recorded. Use the user's primary language when it is clear. Make workflowName action-only: keep the reusable action, omit app/window/location context such as 'in Atria Chat' unless it is essential to the action.",
    sessionID: stopped.sessionID,
    eventsPath: stopped.eventsPath,
    draftSkillName: skill.skillName,
    draftSkillPath: skill.skillPath,
    automaticWorkflow: workflow,
    appCounts: [...appCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([app, count]) => ({ app, count }))
      .slice(0, 8),
    keyNames,
    timeline,
    nextAction: {
      tool: "event_stream_generate_skill",
      requiredArguments: ["sessionID", "workflowName", "workflowSummary"],
      sessionID: stopped.sessionID,
    },
  };
}

function singleLine(value, fallback = "") {
  return String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function clippedLine(value, maxLength, fallback = "") {
  const text = singleLine(value, fallback);
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function timelineForSampling(events) {
  return events
    .filter((event) => !event.type?.startsWith("recorder."))
    .slice(0, MAX_EVENTS_FOR_SAMPLING)
    .map((event, index) => ({
      index: index + 1,
      type: event.type || "",
      app: eventApp(event),
      window: eventWindow(event),
      target: eventTarget(event),
      key: event.input?.keyName || "",
      redacted: Boolean(event.redaction?.redacted),
    }));
}

function workflowSamplingPrompt(stopped, events) {
  const automatic = analyzeWorkflow(events, stopped);
  return [
    "Name and summarize a recorded Windows desktop workflow from UI events.",
    "Return only JSON with exactly two string fields: workflowName and workflowSummary.",
    "workflowName: concise action-only name, no timestamp, no session id, omit app/window/location context such as 'in Atria Chat' unless essential.",
    "Use the user's primary language when it is clear from the request or workflow; if the user primarily uses Chinese, workflowName and workflowSummary should be Chinese.",
    "workflowSummary: one concise sentence describing what the user actually did and the final purpose, in the same language as workflowName.",
    "Do not invent sensitive values, passwords, tokens, or content that is not visible in the events.",
    "",
    `Automatic guess: ${automatic.title}`,
    `Automatic summary: ${automatic.summary}`,
    `Session: ${stopped.sessionID || ""}`,
    "",
    "Events:",
    JSON.stringify(timelineForSampling(events), null, 2),
  ].join("\n");
}

function parseWorkflowSamplingText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*({[\s\S]*?})\s*```/i);
  const body = fenced?.[1] || raw.match(/{[\s\S]*}/)?.[0] || raw;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_error) {
    return null;
  }
  const workflowName = clippedLine(parsed.workflowName || parsed.name, 80);
  const workflowSummary = clippedLine(parsed.workflowSummary || parsed.summary, 600);
  if (!workflowName || !workflowSummary) return null;
  return { workflowName, workflowSummary };
}

async function summarizeWorkflowWithSampling(server, stopped, options = {}) {
  if (options.disableWorkflowSampling) return { ok: false, error: "Workflow sampling disabled." };
  if (!stopped?.eventsPath || !fs.existsSync(stopped.eventsPath)) {
    return { ok: false, error: "No events file available for workflow sampling." };
  }
  const createMessage = options.createMessage || server?.server?.createMessage?.bind(server.server);
  if (typeof createMessage !== "function") {
    return { ok: false, error: "MCP sampling is unavailable." };
  }
  const events = readJsonl(stopped.eventsPath);
  try {
    const response = await createMessage({
      systemPrompt:
        "You summarize recorded desktop workflows for reusable Codex skills. Return strict JSON only.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: workflowSamplingPrompt(stopped, events),
          },
        },
      ],
      maxTokens: 400,
    }, {
      timeout: options.workflowSamplingTimeoutMs || 20000,
    });
    const text = response?.content?.type === "text" ? response.content.text : "";
    const workflow = parseWorkflowSamplingText(text);
    if (!workflow) return { ok: false, error: "Workflow sampling returned unusable JSON." };
    return {
      ok: true,
      ...workflow,
      raw: text,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function generatedSkillResult(stopped, skill, summarySource, options = {}) {
  const requiresCodexRefinement = summarySource === "automatic-event-analysis";
  const generatedSkill = requiresCodexRefinement
    ? {
        ...skill,
        draft: true,
        activationNote:
          "Draft skill generated from event analysis. Codex should review the session and regenerate it with a better workflow name and summary.",
      }
    : skill;
  return {
    ...stopped,
    generatedSkill,
    requiresWorkflowSummary: false,
    requiresCodexRefinement,
    summarySource,
    reviewRecommended: requiresCodexRefinement,
    workflowName: options.workflowName || skill.workflow?.title,
    workflowSummary: options.workflowSummary || skill.workflow?.summary,
    workflowSamplingError: options.workflowSamplingError,
    nextAction: requiresCodexRefinement
      ? {
          tool: "event_stream_generate_skill",
          requiredArguments: ["sessionID", "workflowName", "workflowSummary"],
          sessionID: stopped.sessionID,
          eventsPath: stopped.eventsPath,
          draftSkillPath: skill.skillPath,
        }
      : undefined,
    codexRefinementContext: requiresCodexRefinement
      ? codexRefinementContext(stopped, generatedSkill)
      : undefined,
    requiresNewThread: Boolean(skill.installed) && !requiresCodexRefinement,
  };
}

function panelControlRoot() {
  return path.dirname(defaultSessionRoot());
}

function panelControlTokenPath(options = {}) {
  const versionKey = manifest.version.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return options.panelControlTokenPath ||
    process.env.RECORD_REPLAY_PANEL_TOKEN_PATH ||
    path.join(panelControlRoot(), `panel-control-token-${versionKey}`);
}

function panelControlToken(options = {}) {
  const configured = options.panelControlToken || process.env.RECORD_REPLAY_PANEL_TOKEN;
  if (configured) return String(configured);
  const tokenPath = panelControlTokenPath(options);
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (_error) {
  }
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, "utf8");
  return token;
}

function panelControlPorts(options = {}) {
  const base = Number(options.panelControlPort || process.env.RECORD_REPLAY_PANEL_PORT || DEFAULT_PANEL_CONTROL_PORT);
  if (options.panelControlPort) return [base];
  const count = Math.max(1, Number(options.panelControlPortCount || process.env.RECORD_REPLAY_PANEL_PORT_COUNT || PANEL_CONTROL_PORT_COUNT));
  return Array.from({ length: count }, (_value, index) => base + index);
}

function panelControlDescriptor(options = {}) {
  const token = panelControlToken(options);
  const ports = panelControlPorts(options);
  const origins = ports.map((port) => `http://127.0.0.1:${port}`);
  const endpoints = origins.map((origin) => `${origin}/tool`);
  return {
    endpoint: endpoints[0],
    endpoints,
    origin: origins[0],
    origins,
    port: ports[0],
    ports,
    token,
    close: () => {},
  };
}

function panelControlStatePath(options = {}) {
  const versionKey = manifest.version.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return options.panelControlStatePath ||
    process.env.RECORD_REPLAY_PANEL_STATE_PATH ||
    path.join(panelControlRoot(), `panel-control-helper-${versionKey}.json`);
}

function readPanelControlState(options = {}) {
  try {
    return JSON.parse(fs.readFileSync(panelControlStatePath(options), "utf8"));
  } catch (_error) {
    return null;
  }
}

function writePanelControlState(descriptor, options = {}) {
  try {
    fs.mkdirSync(path.dirname(panelControlStatePath(options)), { recursive: true });
    fs.writeFileSync(
      panelControlStatePath(options),
      JSON.stringify({
        pid: process.pid,
        name: manifest.name,
        version: manifest.version,
        port: descriptor.port,
        endpoint: descriptor.endpoint,
        tokenPath: panelControlTokenPath(options),
        updatedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
  } catch (_error) {
  }
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0 || value === process.pid) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function ensurePanelControlHelper(options = {}) {
  const descriptor = panelControlDescriptor(options);
  const state = readPanelControlState(options);
  if (
    state?.version === manifest.version &&
    descriptor.endpoints.includes(state.endpoint) &&
    state.tokenPath === panelControlTokenPath(options) &&
    isProcessAlive(state.pid)
  ) {
    return descriptor;
  }

  const scriptPath = pluginPath("mcp", "panel-control-server.mjs");
  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: pluginPath(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        RECORD_REPLAY_PANEL_TOKEN: descriptor.token,
        RECORD_REPLAY_PANEL_PORT: String(descriptor.port),
        RECORD_REPLAY_PANEL_PORT_COUNT: String(descriptor.ports.length),
        RECORD_REPLAY_PANEL_TOKEN_PATH: panelControlTokenPath(options),
        RECORD_REPLAY_PANEL_STATE_PATH: panelControlStatePath(options),
        RECORD_REPLAY_PANEL_HELPER: "1",
      },
    });
    child.unref();
  } catch (error) {
    console.error(`[record-replay-windows] failed to start panel control helper: ${error instanceof Error ? error.message : String(error)}`);
  }
  return descriptor;
}

function startPanelControlServer(toolHandler, options = {}) {
  if (options.disablePanelControlServer) return null;
  const descriptor = panelControlDescriptor(options);
  let activeServer = null;

  const createServer = () => http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, x-record-replay-token, access-control-request-private-network",
    );
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Access-Control-Max-Age", "600");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: manifest.name, version: manifest.version }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/tool") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (request.headers["x-record-replay-token"] !== descriptor.token) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body ? JSON.parse(body) : {};
      const result = await toolHandler(String(payload.name || ""), payload.arguments || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  const listen = (index) => {
    const port = descriptor.ports[index];
    const origin = `http://127.0.0.1:${port}`;
    const controlServer = createServer();
    activeServer = controlServer;
    controlServer.once("listening", () => {
      descriptor.port = port;
      descriptor.origin = origin;
      descriptor.endpoint = `${origin}/tool`;
      if (options.panelControlHelperState !== false) writePanelControlState(descriptor, options);
    });
    controlServer.once("error", (error) => {
      if (error?.code === "EADDRINUSE" && index + 1 < descriptor.ports.length) {
        controlServer.close();
        listen(index + 1);
        return;
      }
      console.error(`[record-replay-windows] panel control server failed on ${origin}: ${error instanceof Error ? error.message : String(error)}`);
    });
    controlServer.listen(port, "127.0.0.1");
    if (!options.panelControlKeepAlive) controlServer.unref?.();
  };

  listen(0);
  return {
    ...descriptor,
    close: () => activeServer?.close(),
  };
}

function registerStatusPanelResource(server, { panelControl } = {}) {
  const html = inlineWidget({
    html: readText(pluginPath("mcp", "widget-assets", "status-panel", "panel.html")),
    css: readText(pluginPath("mcp", "widget-assets", "status-panel", "panel.css")),
    js: readText(pluginPath("mcp", "widget-assets", "status-panel", "panel.js")),
    config: panelControl
      ? {
          endpoint: panelControl.endpoint,
          endpoints: panelControl.endpoints || [panelControl.endpoint],
          preferredDisplayMode: "fullscreen",
          token: panelControl.token,
          version: manifest.version,
        }
      : null,
  });
  registerWidgetResource(server, {
    name: "record-replay-windows-status-panel",
    uri: STATUS_PANEL_URI,
    title: "Record & Replay Status Panel",
    description: "Interactive recording controls with elapsed time, event counts, and stop action.",
    html,
    prefersBorder: false,
    csp: {
      connectDomains: panelControl ? (panelControl.origins || [panelControl.origin]) : [],
      resourceDomains: [],
    },
  });
}

function pruneLiveShots(dir, keep = 50) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch (_) {}
}

export function createEventStreamServer(options = {}) {
  const recorder = options.recorderClient || new NativeRecorderClient(options);
  let latestResult = null;
  let server = null;
  const remember = (result) => {
    if (result && typeof result === "object") latestResult = result;
    return result;
  };
  const startRecording = async (input = {}) => remember(await recorder.start({
    maxDurationSeconds: input.maxDurationSeconds ?? 1800,
    capturePolicy: input.capturePolicy ?? "key_events",
    installSkillOnStop: input.installSkillOnStop ?? true,
    redactText: input.redactText ?? true,
    excludeApps: input.excludeApps ?? [],
  }));
  const getStatus = async (input = {}) => {
    const status = await recorder.status(input);
    if (status?.isRecording || status?.sessionID || input.sessionID) return remember(status);
    if (latestResult && latestResult.isRecording === false) return latestResult;
    return status;
  };
  const stopRecording = async (input = {}) => {
    const stopped = await recorder.stop({ installSkill: false });
    const wantsSkill = input.installSkill ?? stopped.installSkillOnStop ?? true;
    const hasWorkflowSummary = Boolean(input.workflowName && input.workflowSummary);
    let sampledWorkflow = null;
    let workflowSamplingError = "";
    let skill = {
      installed: false,
      activationNote: "Skill generation was disabled for this stop call.",
    };
    if (wantsSkill) {
      if (stopped.eventsPath && fs.existsSync(stopped.eventsPath)) {
        if (!hasWorkflowSummary) {
          sampledWorkflow = await summarizeWorkflowWithSampling(server, stopped, options);
        }
        if (sampledWorkflow?.ok) {
          skill = installGeneratedSkill(stopped, {
            workflowName: sampledWorkflow.workflowName,
            workflowSummary: sampledWorkflow.workflowSummary,
            skillsRoot: options.skillsRoot,
            replaceSessionSkills: true,
          });
          return remember(generatedSkillResult(
            stopped,
            skill,
            "codex-sampling",
            {
              workflowName: sampledWorkflow.workflowName,
              workflowSummary: sampledWorkflow.workflowSummary,
            },
          ));
        }
        workflowSamplingError = sampledWorkflow?.error || "";
        skill = installGeneratedSkill(stopped, {
          workflowName: input.workflowName,
          workflowSummary: input.workflowSummary,
          skillsRoot: options.skillsRoot,
          replaceSessionSkills: hasWorkflowSummary,
        });
        return remember(generatedSkillResult(
          stopped,
          skill,
          hasWorkflowSummary ? "codex-summary" : "automatic-event-analysis",
          { workflowSamplingError },
        ));
      }
      skill = {
        installed: false,
        activationNote: "No completed recording event stream was available, so no skill was generated.",
      };
    }
    return remember({
      ...stopped,
      generatedSkill: skill,
      requiresWorkflowSummary: false,
      requiresNewThread: Boolean(skill.installed),
    });
  };
  const generateSkill = async (input = {}) => {
    const { session, skill } = generateSkillForSession(recorder, {
      ...input,
      replaceSessionSkills: true,
    }, {
      skillsRoot: options.skillsRoot,
    });
    return remember({
      ...(session || {}),
      generatedSkill: skill,
      requiresWorkflowSummary: false,
      requiresCodexRefinement: false,
      reviewRecommended: false,
      summarySource: "codex-summary",
      workflowName: input.workflowName,
      workflowSummary: input.workflowSummary,
      requiresNewThread: Boolean(skill.installed),
    });
  };
  const handlePanelTool = async (name, input = {}) => {
    if (name === "event_stream_start") return startRecording(input);
    if (name === "event_stream_status") return getStatus(input);
    if (name === "event_stream_stop") return stopRecording(input);
    if (name === "event_stream_generate_skill") return generateSkill(input);
    throw new Error(`Unknown panel tool: ${name}`);
  };
  server = new McpServer(
    {
      name: "event-stream",
      version: manifest.version,
    },
    {
      instructions:
        "Record Windows desktop workflows into semantic events.jsonl files. Use event_stream_start before the user demonstrates a workflow, event_stream_status to inspect progress, and event_stream_stop to stop recording. If event_stream_stop returns requiresCodexRefinement, review the returned event summary and immediately call event_stream_generate_skill with a better workflowName/workflowSummary before reporting completion.",
    },
  );
  const shouldStartPanelControl = !options.recorderClient || options.enablePanelControlServer || options.panelControlPort;
  const shouldServeInlinePanelControl = options.panelControlServeOnly || options.recorderClient || options.panelControlInline;
  const panelControl = shouldStartPanelControl
    ? shouldServeInlinePanelControl
      ? startPanelControlServer(handlePanelTool, options)
      : ensurePanelControlHelper(options)
    : null;
  const actor = options.actorClient || new NativeActorClient(options);
  const visualController = options.visualController || new VisualController({
    mode: options.visualMode,
    overlayPath: options.overlayPath,
    spawnRenderer: options.spawnRenderer,
    readyTimeoutMs: options.visualReadyTimeoutMs,
  });
  const actionCoordinator = options.actionCoordinator || new ActionCoordinator(actor, {
    lockPath: options.automationLockPath,
    eventLogPath: options.actionEventLogPath,
    maxEvents: options.maxActionEvents,
    visual: visualController,
  });
  visualController.setControlHandler(async (command) => {
    if (command === "stop") return actionCoordinator.stop();
    if (command === "toggle_pause") {
      return actionCoordinator.controlState === "paused"
        ? actionCoordinator.resume()
        : actionCoordinator.pause();
    }
    return null;
  });
  const writeMethods = {
    click: "click",
    move: "mouseMove",
    drag: "drag",
    scroll: "scroll",
    type: "typeText",
    key: "key",
    window_focus: "windowFocus",
    invoke: "uiaInvoke",
    set_value: "uiaInvoke",
  };

  async function runWrite(action, params = {}, context = {}) {
    const method = writeMethods[action];
    if (!method || typeof actor[method] !== "function") throw new Error(`Unsupported actor action: ${action}`);
    return actionCoordinator.run(action, params, ({ operationId, sessionId, parentOperationId, stepIndex }) => actor[method]({
      ...params,
      operationId,
      sessionId,
      ...(parentOperationId ? { parentOperationId } : {}),
      ...(Number.isInteger(stepIndex) ? { stepIndex } : {}),
    }), context);
  }

  function actionContext(input = {}, extra = {}) {
    return {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...extra,
    };
  }
  // ---- batch-M a11y-first 交互循环(学 Windows-MCP/orca) ----
  // lastState:最近一次 ui_snapshot(元素编号→坐标由引擎解析,模型不碰坐标);
  // 索引短命:UI 变化后旧编号作废,动作默认返回新状态供下一步使用。
  let lastState = null;
  let snapshotSeq = 0;
  const liveDir = path.join(path.dirname(defaultSessionRoot()), "actor-live");

  async function takeState(params = {}) {
    const snap = await actor.uiSnapshot({ maxElements: 60, ...params });
    snapshotSeq += 1;
    lastState = {
      snapshotId: snapshotSeq,
      window: snap.window,
      truncated: Boolean(snap.truncated),
      elements: (snap.elements || []).map((el) => ({
        i: el.i,
        type: el.type,
        name: el.name,
        automationId: el.automationId || undefined,
        cx: el.cx,
        cy: el.cy,
        ...(el.enabled === false ? { enabled: false } : {}),
      })),
    };
    return lastState;
  }

  // elementIndex → 物理坐标(引擎解析,模型只挑编号)。
  function resolveTarget(input = {}) {
    if (Number.isInteger(input.elementIndex)) {
      if (!lastState) throw new Error("No ui_snapshot yet — call ui_snapshot first, then use elementIndex from it.");
      if (!Number.isInteger(input.snapshotId)) {
        throw new Error(`snapshotId is required with elementIndex (current ${lastState.snapshotId}) so stale indexes cannot click a changed UI.`);
      }
      if (input.snapshotId !== lastState.snapshotId) {
        throw new Error(`Stale snapshotId ${input.snapshotId} (current ${lastState.snapshotId}) — element indexes go stale after UI changes; take a fresh ui_snapshot.`);
      }
      const el = lastState.elements.find((e) => e.i === input.elementIndex);
      if (!el) throw new Error(`elementIndex ${input.elementIndex} not in current snapshot (0..${lastState.elements.length - 1}) — take a fresh ui_snapshot.`);
      return { x: el.cx, y: el.cy, element: el, window: lastState.window };
    }
    if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
      return { x: Math.round(input.x), y: Math.round(input.y), element: null, window: lastState?.window || null };
    }
    throw new Error("Pass elementIndex (from ui_snapshot) or x/y coordinates.");
  }

  function boundExpect(input = {}, target = null) {
    const explicit = input.expect || {};
    const window = target?.window || lastState?.window || null;
    if (!window?.hwnd && !explicit.hwnd && !explicit.processName && !explicit.titleContains && !explicit.titleExact) {
      throw new Error("TARGET_SCOPE_REQUIRED: take ui_snapshot first or pass expect; unscoped writes are refused.");
    }
    return {
      ...explicit,
      ...(window?.hwnd ? { hwnd: window.hwnd } : {}),
      ...(window?.pid ? { pid: window.pid } : {}),
      ...(window?.title ? { titleExact: window.title } : {}),
    };
  }

  // 动作后回传新状态(文本,token 便宜,弱视觉模型可用)+ 截图文件路径(前端渲染用,不进模型上下文)。
  async function afterAction(input = {}) {
    const wantState = input.returnState !== false;
    const wantShot = input.returnScreenshotPath !== false;
    await new Promise((r) => setTimeout(r, 180)); // 等 UI 稳定
    const out = {};
    if (wantState) {
      try { out.state = await takeState(); } catch (_) {}
    }
    if (wantShot) {
      try {
        const shot = await actor.screenshot({ outputDir: liveDir, maxWidth: 1024 });
        out.screenshotPath = shot?.path || null;
        // 前端标注用:缩放图尺寸+物理尺寸(物理坐标×width/physicalWidth=图上坐标)。
        out.screenshotMeta = shot ? { width: shot.width, height: shot.height, physicalWidth: shot.physicalWidth, physicalHeight: shot.physicalHeight } : null;
        pruneLiveShots(liveDir, 50);
      } catch (_) {}
    }
    return out;
  }

  server.closeRecorder = () => {
    if (typeof recorder.close === "function") recorder.close();
    actionCoordinator.close();
    if (typeof actor.close === "function") actor.close();
    panelControl?.close?.();
  };
  server.actionCoordinator = actionCoordinator;
  server.visualController = visualController;

  registerStatusPanelResource(server, { panelControl });

  registerAppTool(
    server,
    "event_stream_start",
    {
      title: "Start Event Stream Recording",
      description: "Start recording a Windows desktop workflow. All parameters are optional and a status panel is rendered.",
      inputSchema: {
        maxDurationSeconds: z.number().int().positive().max(7200).optional(),
        capturePolicy: z.enum(["key_events", "off"]).optional(),
        installSkillOnStop: z.boolean().optional(),
        redactText: z.boolean().optional(),
        excludeApps: z.array(z.string()).optional(),
      },
      _meta: widgetMeta({
        invoking: "Starting Windows workflow recording...",
        invoked: "Recording started",
      }),
    },
    async (input = {}) => asToolResult(await startRecording(input), { widget: true }),
  );

  registerAppTool(
    server,
    "event_stream_status",
    {
      title: "Get Event Stream Status",
      description: "Get current or latest Record & Replay Windows session status.",
      inputSchema: {
        sessionID: z.string().optional(),
      },
      _meta: widgetMeta({
        invoking: "Refreshing recording status...",
        invoked: "Recording status ready",
      }),
    },
    async (input = {}) => asToolResult(await getStatus(input), { widget: true }),
  );

  registerAppTool(
    server,
    "event_stream_stop",
    {
      title: "Stop Event Stream Recording",
      description:
        "Stop recording and install a Codex skill. If workflowName/workflowSummary are omitted, the server tries Codex sampling for a semantic name and summary before falling back to a refinement-required draft.",
      inputSchema: {
        installSkill: z.boolean().optional(),
        workflowName: z.string().trim().min(1).max(80).optional(),
        workflowSummary: z.string().trim().min(1).max(600).optional(),
      },
      _meta: widgetMeta({
        invoking: "Stopping recording...",
        invoked: "Recording stopped",
      }),
    },
    async (input = {}) => asToolResult(await stopRecording(input), { widget: true }),
  );

  registerAppTool(
    server,
    "event_stream_generate_skill",
    {
      title: "Generate Skill From Event Stream",
      description:
        "Generate and install a Codex skill from a completed Record & Replay Windows session after Codex has summarized the workflow.",
      inputSchema: {
        sessionID: z.string().trim().min(1).optional(),
        workflowName: z.string().trim().min(1).max(80),
        workflowSummary: z.string().trim().min(1).max(600),
      },
      _meta: widgetMeta({
        invoking: "Generating workflow skill...",
        invoked: "Workflow skill generated",
      }),
    },
    async (input = {}) => asToolResult(await generateSkill(input), { widget: true }),
  );

  registerAppTool(
    server,
    "event_stream_panel",
    {
      title: "Open Record & Replay Panel",
      description: "Open the interactive Record & Replay Windows panel with elapsed time and Start/Stop controls.",
      _meta: widgetMeta({
        invoking: "Opening Record & Replay panel...",
        invoked: "Record & Replay panel ready",
      }),
    },
    async () => asToolResult(await getStatus({}), { widget: true }),
  );

  // ---- batch-I:自有执行引擎(actor.exe)工具组,替代 bundled computer-use runtime ----
  const expectShape = z
    .object({
      processName: z.string().optional(),
      titleContains: z.string().optional(),
      titleExact: z.string().optional(),
      hwnd: z.number().int().optional(),
      pid: z.number().int().positive().optional(),
    })
    .optional()
    .describe("焦点硬校验:前台窗口不匹配则拒绝执行(FOCUS_MISMATCH)");
  const locatorShape = {
    name: z.string().optional().describe("UIA 元素名(contains 匹配)"),
    automationId: z.string().optional(),
    className: z.string().optional(),
    controlType: z.string().optional().describe("如 button/edit/document/menuitem"),
    nameMatch: z.enum(["contains", "exact"]).optional().describe("name defaults to contains; use exact to reject similar labels"),
    scopeHwnd: z.number().int().optional(),
    scopeTitle: z.string().optional().describe("按窗口标题限定查找范围"),
    timeoutMs: z.number().int().positive().max(20000).optional(),
  };

  server.registerTool(
    "computer_screenshot",
    {
      description:
        "Capture the screen, scaled for models (default maxWidth 1280). Returns the image inline (vision models see it directly) plus scale info: physical = image_coord * scale. Prefer ui_snapshot for locating elements; use this for visual confirmation.",
      inputSchema: {
        outputDir: z.string().optional(),
        maxWidth: z.number().int().min(0).max(3840).optional(),
        inlineImage: z.boolean().optional().describe("Default true: include the image in the response"),
      },
    },
    async (input = {}) => {
      const shot = await actor.screenshot({ outputDir: input.outputDir, maxWidth: input.maxWidth });
      const result = asToolResult(shot);
      if (input.inlineImage !== false && shot?.path && fs.existsSync(shot.path)) {
        try {
          const data = fs.readFileSync(shot.path).toString("base64");
          result.content.push({ type: "image", data, mimeType: "image/png" });
        } catch (_) {}
      }
      return result;
    },
  );

  const targetShape = {
    elementIndex: z.number().int().optional().describe("Element index from the latest ui_snapshot (preferred — engine resolves coordinates)"),
    snapshotId: z.number().int().optional().describe("Optional staleness guard: snapshotId the index came from"),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
  };
  const feedbackShape = {
    returnState: z.boolean().optional().describe("Default true: response includes a fresh ui_snapshot for the next step"),
    returnScreenshotPath: z.boolean().optional(),
  };
  const operationShape = {
    operationId: z.string().min(3).max(200).optional().describe("Stable id returned by a prior attempt; reuse only with identical arguments"),
    sessionId: z.string().min(1).max(120).optional(),
  };

  server.registerTool(
    "computer_click",
    {
      description:
        "Click a UI element. Preferred: pass elementIndex from ui_snapshot (engine resolves exact coordinates — works with any model). Or pass x/y. Mouse moves smoothly (visible). Response includes fresh UI state.",
      inputSchema: {
        ...targetShape,
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().min(1).max(3).optional().describe("1=single 2=double 3=triple"),
        expect: expectShape,
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      const target = resolveTarget(input);
      const result = await runWrite("click", { x: target.x, y: target.y, button: input.button, clicks: input.clicks, expect: boundExpect(input, target) }, actionContext(input));
      return asToolResult({ ...result, targetElement: target.element || undefined, ...(await afterAction(input)) });
    },
  );

  server.registerTool(
    "computer_move",
    {
      description: "Move the mouse smoothly to an element or coordinates (visible glide, no click).",
      inputSchema: { ...targetShape, durationMs: z.number().int().min(0).max(2000).optional(), ...operationShape },
    },
    async (input = {}) => {
      const target = resolveTarget(input);
      return asToolResult(await runWrite("move", { x: target.x, y: target.y, durationMs: input.durationMs, expect: boundExpect(input, target) }, actionContext(input)));
    },
  );

  server.registerTool(
    "computer_drag",
    {
      description: "Drag from one point/element to another (smooth, real drag events). Response includes fresh UI state.",
      inputSchema: {
        fromElementIndex: z.number().int().optional(),
        fromX: z.number().int().optional(),
        fromY: z.number().int().optional(),
        toElementIndex: z.number().int().optional(),
        toX: z.number().int().optional(),
        toY: z.number().int().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        durationMs: z.number().int().min(100).max(3000).optional(),
        expect: expectShape,
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      const from = resolveTarget({ elementIndex: input.fromElementIndex, x: input.fromX, y: input.fromY, snapshotId: input.snapshotId });
      const to = resolveTarget({ elementIndex: input.toElementIndex, x: input.toX, y: input.toY, snapshotId: input.snapshotId });
      const result = await runWrite("drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, button: input.button, durationMs: input.durationMs, expect: boundExpect(input, from) }, actionContext(input));
      return asToolResult({ ...result, ...(await afterAction(input)) });
    },
  );

  server.registerTool(
    "computer_scroll",
    {
      description: "Scroll the mouse wheel at an element/coordinates (or current position). Response includes fresh UI state.",
      inputSchema: {
        ...targetShape,
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().int().min(1).max(20).optional().describe("wheel notches, default 3"),
        expect: expectShape,
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      let at = {};
      try { const t = resolveTarget(input); at = { x: t.x, y: t.y, window: t.window }; } catch (_) { /* 无目标=当前位置 */ }
      const result = await runWrite("scroll", { ...at, direction: input.direction, amount: input.amount, expect: boundExpect(input, at.window ? at : null) }, actionContext(input));
      return asToolResult({ ...result, ...(await afterAction(input)) });
    },
  );

  server.registerTool(
    "computer_type",
    {
      description:
        "Type text (CJK supported, \\n = Enter). Pass elementIndex to click the field first; clearFirst=true replaces existing content (Ctrl+A). Prefer ui_set_value for fields that support it (verified write). Response includes fresh UI state.",
      inputSchema: {
        text: z.string(),
        elementIndex: z.number().int().optional(),
        snapshotId: z.number().int().optional(),
        clearFirst: z.boolean().optional(),
        expect: expectShape,
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      if (Number.isInteger(input.elementIndex)) {
        const target = resolveTarget(input);
        const parentOperationId = input.operationId || actionCoordinator.newOperationId();
        const sessionId = input.sessionId;
        const result = await actionCoordinator.withWriteSession({ operationId: parentOperationId, sessionId }, async () => {
          await runWrite("click", { x: target.x, y: target.y, expect: boundExpect(input, target) }, {
            lockHeld: true,
            parentOperationId,
            stepIndex: 0,
            sessionId,
          });
          await new Promise((r) => setTimeout(r, 120));
          return runWrite("type", { text: input.text, clearFirst: input.clearFirst, expect: boundExpect(input) }, {
            lockHeld: true,
            parentOperationId,
            stepIndex: 1,
            sessionId,
          });
        });
        return asToolResult({ ...result, parentOperationId, ...(await afterAction(input)) });
      }
      const result = await runWrite("type", { text: input.text, clearFirst: input.clearFirst, expect: boundExpect(input) }, actionContext(input));
      return asToolResult({ ...result, ...(await afterAction(input)) });
    },
  );

  server.registerTool(
    "ui_set_value",
    {
      description:
        "Set a text field's value via UIA ValuePattern with verified write (reads back the value). Most reliable way to fill inputs. Locate by elementIndex (from ui_snapshot) or by name/automationId.",
      inputSchema: {
        elementIndex: z.number().int().optional(),
        snapshotId: z.number().int().optional(),
        name: z.string().optional(),
        automationId: z.string().optional(),
        scopeTitle: z.string().optional(),
        value: z.string(),
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      let locator = { name: input.name, automationId: input.automationId, scopeTitle: input.scopeTitle };
      if (Number.isInteger(input.elementIndex)) {
        const target = resolveTarget(input);
        locator = {
          name: target.element?.name || undefined,
          automationId: target.element?.automationId || undefined,
          scopeHwnd: target.window?.hwnd || undefined,
          nameMatch: target.element?.automationId ? undefined : "exact",
        };
      }
      const result = await runWrite("set_value", { ...locator, action: "set_value", value: input.value, timeoutMs: 3000 }, actionContext(input));
      return asToolResult({ ...result, ...(await afterAction(input)) }, { isError: result?.status === "failed" });
    },
  );

  server.registerTool(
    "ui_snapshot",
    {
      description:
        "PRIMARY perception tool: list all interactive elements of the foreground (or named) window as numbered text — type/name/coordinates come from the OS accessibility tree, so ANY model can act precisely without vision. Then act with computer_click{elementIndex}. Indexes go stale after UI changes; actions return fresh state automatically.",
      inputSchema: {
        scopeTitle: z.string().optional(),
        scopeHwnd: z.number().int().optional(),
        maxElements: z.number().int().min(10).max(300).optional(),
        includeAll: z.boolean().optional().describe("Include non-interactive elements too"),
      },
    },
    async (input = {}) => asToolResult(await takeState(input)),
  );

  server.registerTool(
    "ui_wait_for",
    {
      description:
        "Wait (poll inside one call) until a UI element appears — by name/automationId/controlType, optionally scoped to a window. Kills the look-click-look round trips after navigation or dialogs.",
      inputSchema: {
        name: z.string().optional(),
        automationId: z.string().optional(),
        controlType: z.string().optional(),
        scopeTitle: z.string().optional(),
        timeoutMs: z.number().int().min(200).max(60000).optional(),
        intervalMs: z.number().int().min(100).max(5000).optional(),
      },
    },
    async (input = {}) => asToolResult(await actor.uiWaitFor(input)),
  );

  server.registerTool(
    "computer_batch",
    {
      description:
        "Run several deterministic actions in ONE call (click/type/key/scroll/move/wait). Stops on first error; returns fresh state once at the end. Element indexes inside a batch refer to the snapshot taken BEFORE the batch — if an action changes the UI, use coordinates or keyboard-only follow-ups.",
      inputSchema: {
        actions: z.array(z.object({
          action: z.enum(["click", "type", "key", "scroll", "move", "wait"]),
          elementIndex: z.number().int().optional(),
          x: z.number().int().optional(),
          y: z.number().int().optional(),
          button: z.enum(["left", "right", "middle"]).optional(),
          clicks: z.number().int().min(1).max(3).optional(),
          text: z.string().optional(),
          clearFirst: z.boolean().optional(),
          keys: z.string().optional(),
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          amount: z.number().int().optional(),
          ms: z.number().int().min(50).max(10000).optional(),
        })).min(1).max(50),
        expect: expectShape,
        ...feedbackShape,
        ...operationShape,
      },
    },
    async (input = {}) => {
      const results = [];
      const parentOperationId = input.operationId || actionCoordinator.newOperationId();
      const sessionId = input.sessionId;
      const outcome = await actionCoordinator.withWriteSession({ operationId: parentOperationId, sessionId }, async () => {
        for (const [idx, step] of (input.actions || []).entries()) {
          try {
            await actionCoordinator.waitUntilRunnable();
            const context = { lockHeld: true, parentOperationId, stepIndex: idx, sessionId };
            if (step.action === "wait") {
              await new Promise((r) => setTimeout(r, step.ms || 500));
              results.push({ idx, action: "wait", ok: true });
            } else if (step.action === "click") {
              const t = resolveTarget({ ...step, snapshotId: input.snapshotId });
              const actionResult = await runWrite("click", { x: t.x, y: t.y, button: step.button, clicks: step.clicks, expect: boundExpect(input, t) }, context);
              results.push({ idx, action: "click", ok: true, operationId: actionResult.operationId, at: { x: t.x, y: t.y } });
            } else if (step.action === "move") {
              const t = resolveTarget({ ...step, snapshotId: input.snapshotId });
              const actionResult = await runWrite("move", { x: t.x, y: t.y, expect: boundExpect(input, t) }, context);
              results.push({ idx, action: "move", ok: true, operationId: actionResult.operationId });
            } else if (step.action === "type") {
              const actionResult = await runWrite("type", { text: step.text || "", clearFirst: step.clearFirst, expect: boundExpect(input) }, context);
              results.push({ idx, action: "type", ok: true, operationId: actionResult.operationId });
            } else if (step.action === "key") {
              const actionResult = await runWrite("key", { keys: step.keys || "", expect: boundExpect(input) }, context);
              results.push({ idx, action: "key", ok: true, operationId: actionResult.operationId });
            } else if (step.action === "scroll") {
              let at = {};
              try { const t = resolveTarget({ ...step, snapshotId: input.snapshotId }); at = { x: t.x, y: t.y, window: t.window }; } catch (_) {}
              const actionResult = await runWrite("scroll", { x: at.x, y: at.y, direction: step.direction, amount: step.amount, expect: boundExpect(input, at.window ? at : null) }, context);
              results.push({ idx, action: "scroll", ok: true, operationId: actionResult.operationId });
            }
            await new Promise((r) => setTimeout(r, 120));
          } catch (error) {
            results.push({ idx, action: step.action, ok: false, code: error.code || "ACTION_FAILED" });
            return { completed: false, stoppedAt: idx, results };
          }
        }
        return { completed: true, results };
      });
      return asToolResult({ ...outcome, operationId: parentOperationId, ...(await afterAction(input)) }, { isError: !outcome.completed });
    },
  );

  server.registerTool(
    "computer_key",
    {
      description:
        "Press a key or combo, e.g. \"enter\", \"ctrl+s\", \"alt+f4\". Pass expect to hard-verify the foreground window first.",
      inputSchema: { keys: z.string(), expect: expectShape, ...operationShape },
    },
    async (input = {}) => asToolResult(await runWrite("key", { keys: input.keys, expect: boundExpect(input) }, actionContext(input))),
  );

  server.registerTool(
    "computer_window_list",
    {
      description: "List visible top-level windows (hwnd/title/pid/processName) and the current foreground window.",
      inputSchema: {},
    },
    async () => asToolResult(await actor.windowList()),
  );

  server.registerTool(
    "computer_window_focus",
    {
      description:
        "Bring a window to the foreground by hwnd, title substring, or processName substring. Returns whether focus actually landed.",
      inputSchema: {
        hwnd: z.number().int().optional(),
        title: z.string().optional(),
        processName: z.string().optional(),
        ...operationShape,
      },
    },
    async (input = {}) => asToolResult(await runWrite("window_focus", {
      hwnd: input.hwnd,
      title: input.title,
      processName: input.processName,
    }, actionContext(input))),
  );

  server.registerTool(
    "ui_find",
    {
      description:
        "Find UI Automation elements by name/automationId/controlType within a window scope. Returns elements with current boundingRect.",
      inputSchema: { ...locatorShape, maxResults: z.number().int().positive().max(50).optional() },
    },
    async (input = {}) => asToolResult(await actor.uiaFind(input)),
  );

  server.registerTool(
    "ui_invoke",
    {
      description:
        "Deterministically act on a UIA element (no mouse): action=invoke/click/focus/set_value(+value). Prefer this over coordinates when the element is findable.",
      inputSchema: {
        ...locatorShape,
        action: z.enum(["invoke", "click", "focus", "set_value"]).optional(),
        value: z.string().optional(),
        ...operationShape,
      },
    },
    async (input = {}) => {
      const action = input.action === "set_value" ? "set_value" : "invoke";
      const { operationId: _operationId, sessionId: _sessionId, ...params } = input;
      const result = await runWrite(action, params, actionContext(input));
      return asToolResult(result, { isError: result?.status === "failed" });
    },
  );

  server.registerTool(
    "automation_status",
    {
      description: "Read the local Windows automation state, write-session owner, last action event, and an optional native operation result.",
      inputSchema: {
        operationId: z.string().optional(),
      },
    },
    async (input = {}) => asToolResult({
      ...actionCoordinator.status(),
      operation: input.operationId && typeof actor.operationStatus === "function"
        ? actor.operationStatus(input.operationId)
        : null,
    }),
  );

  server.registerTool(
    "automation_pause",
    {
      description: "Pause the active interruptible Windows action through an out-of-band control file. Returns whether native acknowledged within 500ms.",
      inputSchema: {},
    },
    async () => asToolResult(await actionCoordinator.pause()),
  );

  server.registerTool(
    "automation_resume",
    {
      description: "Resume a paused local Windows action.",
      inputSchema: {},
    },
    async () => asToolResult(await actionCoordinator.resume()),
  );

  server.registerTool(
    "automation_stop",
    {
      description: "Stop the active local Windows action and prevent later batch or replay steps from starting.",
      inputSchema: {},
    },
    async () => asToolResult(await actionCoordinator.stop()),
  );

  server.registerTool(
    "action_events_recent",
    {
      description: "Return recent sanitized action lifecycle events. Text bodies, clipboard data, cookies, keys, and full window titles are excluded.",
      inputSchema: { limit: z.number().int().min(1).max(1000).optional() },
    },
    async (input = {}) => asToolResult({ events: actionCoordinator.recentEvents(input.limit) }),
  );

  server.registerTool(
    "visual_status",
    {
      description: "Read the independent Windows visual renderer mode, readiness, process identity and last measured frame acknowledgement.",
      inputSchema: {},
    },
    async () => asToolResult(visualController.status()),
  );

  server.registerTool(
    "visual_enable",
    {
      description: "Enable the local action overlay. required=true blocks the next write unless renderer-ready is confirmed.",
      inputSchema: { required: z.boolean().optional() },
    },
    async (input = {}) => {
      visualController.setMode(input.required ? "required" : "on");
      const readiness = await visualController.beforeAction();
      return asToolResult({ ...visualController.status(), readiness }, { isError: input.required && !readiness.ready });
    },
  );

  server.registerTool(
    "visual_disable",
    {
      description: "Disable and stop the local action overlay. Automation remains available without visualization.",
      inputSchema: {},
    },
    async () => asToolResult(visualController.setMode("off")),
  );

  server.registerTool(
    "replay_run",
    {
      description:
        "Deterministically replay a recorded session: UIA-first clicks with coordinate fallback, special keys re-sent. Redacted typed text cannot be replayed deterministically — the run stops with needsAgent so you can computer_type the equivalent text (per the skill's Steps) and resume with startIndex. Use dryRun to inspect the plan first.",
      inputSchema: {
        sessionID: z.string().optional().describe("EventStream session id; omit to use the latest session"),
        dryRun: z.boolean().optional(),
        startIndex: z.number().int().min(0).optional(),
        stepDelayMs: z.number().int().min(0).max(5000).optional(),
        stopOnFailure: z.boolean().optional(),
        captureDir: z.string().optional().describe("If set, save a keyframe PNG after each executed step (audit trail)"),
        ...operationShape,
      },
    },
    async (input = {}) => {
      const session = sessionFromID(recorder, input.sessionID);
      if (!session || !fs.existsSync(session.eventsPath)) {
        throw new Error(`No recorded session found${input.sessionID ? ` for ${input.sessionID}` : ""}.`);
      }
      const events = readJsonlFile(session.eventsPath);
      const suppressed = readJsonlFile(session.suppressedEventsPath);
      const plan = planReplay(events, suppressed);
      if (input.dryRun) {
        const needsAgentCount = plan.filter((step) => step.kind === "needs_agent").length;
        const skippedCount = plan.filter((step) => step.kind === "skip").length;
        return asToolResult({
          sessionID: session.sessionID,
          dryRun: true,
          status: needsAgentCount > 0 ? "needs_agent" : skippedCount > 0 ? "partial" : "ready",
          planLength: plan.length,
          startIndex: Math.max(0, Number(input.startIndex || 0)),
          needsAgentCount,
          skippedCount,
          plan,
        });
      }
      const parentOperationId = input.operationId || actionCoordinator.newOperationId();
      const sessionId = input.sessionId || session.sessionID;
      const replayActor = {
        uiaFind: (params) => actor.uiaFind(params),
        screenshot: (params) => actor.screenshot(params),
      };
      for (const [method, action] of [
        ["windowFocus", "window_focus"],
        ["click", "click"],
        ["key", "key"],
        ["typeText", "type"],
        ["scroll", "scroll"],
      ]) {
        replayActor[method] = (params = {}) => {
          const { _actionStepIndex, ...cleanParams } = params;
          return runWrite(action, cleanParams, {
            lockHeld: true,
            parentOperationId,
            stepIndex: Number.isInteger(_actionStepIndex) ? _actionStepIndex : undefined,
            sessionId,
          });
        };
      }
      const outcome = await actionCoordinator.withWriteSession({ operationId: parentOperationId, sessionId }, () => executeReplay(replayActor, plan, input));
      const result = { sessionID: session.sessionID, planLength: plan.length, operationId: parentOperationId, ...outcome };
      const isError = ["failed", "partial", "unknown", "cancelled"].includes(outcome.status);
      return asToolResult(result, { isError });
    },
  );

  server.registerTool(
    "replay_note_fix",
    {
      description:
        "Append a fix note to a generated skill's SKILL.md (## Fix Log). Call after visually completing a step that deterministic replay failed on, so future replays prefer the corrected path.",
      inputSchema: {
        skillName: z.string().describe("Skill directory name under the skills root"),
        stepIndex: z.number().int().min(0).optional(),
        fixNote: z.string().min(1).max(2000).describe("What changed and how the step was completed"),
      },
    },
    async (input = {}) => {
      const skillsRoot = options.skillsRoot || path.join(os.homedir(), ".codex", "skills");
      const safeName = path.basename(String(input.skillName || ""));
      const skillPath = path.join(skillsRoot, safeName, "SKILL.md");
      if (!safeName || !fs.existsSync(skillPath)) {
        throw new Error(`skill not found: ${safeName}`);
      }
      let body = fs.readFileSync(skillPath, "utf8");
      if (!body.includes("\n## Fix Log")) {
        body = `${body.trimEnd()}\n\n## Fix Log\n`;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const stepLabel = Number.isInteger(input.stepIndex) ? ` (step ${input.stepIndex})` : "";
      body = `${body.trimEnd()}\n- ${stamp}${stepLabel}: ${String(input.fixNote).replace(/\s+/g, " ").trim()}\n`;
      fs.writeFileSync(skillPath, body, "utf8");
      return asToolResult({ ok: true, skillName: safeName, skillPath });
    },
  );

  return server;
}
