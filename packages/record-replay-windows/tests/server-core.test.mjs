import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEventStreamServer } from "../mcp/server-core.mjs";

test("event stream server registers the expected MCP tools", () => {
  const server = createEventStreamServer({
    recorderClient: {
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({}),
    },
  });
  const names = Object.keys(server._registeredTools).sort();
  assert.deepEqual(names, [
    "action_events_recent",
    "automation_pause",
    "automation_resume",
    "automation_status",
    "automation_stop",
    "computer_batch",
    "computer_click",
    "computer_drag",
    "computer_key",
    "computer_move",
    "computer_screenshot",
    "computer_scroll",
    "computer_type",
    "computer_window_focus",
    "computer_window_list",
    "event_stream_generate_skill",
    "event_stream_panel",
    "event_stream_start",
    "event_stream_status",
    "event_stream_stop",
    "replay_note_fix",
    "replay_run",
    "ui_find",
    "ui_invoke",
    "ui_set_value",
    "ui_snapshot",
    "ui_wait_for",
    "visual_disable",
    "visual_enable",
    "visual_status",
  ]);
  assert.equal(server._registeredTools.event_stream_start._meta["openai/widgetAccessible"], true);
});

test("20-step batch and replay share one sanitized action-event path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-s4-"));
  const sessionID = "twenty-step-replay";
  const sessionDir = path.join(root, sessionID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    Array.from({ length: 20 }, (_value, index) => JSON.stringify({
      type: "keyboard.key",
      timestamp: new Date(1700000000000 + index).toISOString(),
      input: { vkCode: 0x0d, keyName: "Enter" },
    })).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(sessionDir, "suppressed_events.jsonl"), "", "utf8");
  let operationSequence = 0;
  const actor = {
    actorBootId: "fake-boot",
    createOperationId: () => `fake-boot:${++operationSequence}`,
    addEventListener: () => () => {},
    uiSnapshot: async () => ({
      window: { hwnd: 101, pid: 202, title: "Fixture Window" },
      elements: [{ i: 0, type: "Button", name: "Fixture", cx: 10, cy: 10, enabled: true }],
    }),
    screenshot: async () => ({}),
    click: async () => ({ clicked: true }),
    mouseMove: async () => ({ moved: true }),
    typeText: async (params) => ({ typed: [...String(params.text || "")].length }),
    key: async () => ({ keys: true }),
    scroll: async () => ({ scrolled: true }),
    windowFocus: async () => ({ focused: true, foreground: { hwnd: 101, pid: 202, processName: "fixture.exe", windowTitle: "Fixture Window" } }),
    uiaFind: async () => ({ elements: [] }),
    uiaInvoke: async () => ({ invoked: true }),
    operationStatus: () => null,
    pause: async () => ({ acknowledged: true }),
    resume: async () => ({}),
    stop: async () => ({ acknowledged: true }),
    close: () => {},
  };
  const server = createEventStreamServer({
    actorClient: actor,
    automationLockPath: path.join(root, "desktop.lock"),
    recorderClient: {
      sessionRoot: root,
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({}),
    },
  });
  t.after(() => {
    server.closeRecorder();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await server._registeredTools.ui_snapshot.handler({});
  const secret = "fixture-secret-body";
  const batch = await server._registeredTools.computer_batch.handler({
    actions: Array.from({ length: 20 }, () => ({ action: "type", text: secret })),
    returnState: false,
    returnScreenshotPath: false,
  });
  assert.equal(batch.structuredContent.completed, true);
  assert.equal(batch.structuredContent.results.length, 20);

  const replay = await server._registeredTools.replay_run.handler({
    sessionID,
    stepDelayMs: 0,
  });
  assert.equal(replay.structuredContent.status, "succeeded");
  assert.equal(replay.structuredContent.succeededCount, 20);

  const events = server.actionCoordinator.recentEvents(1000);
  const batchEvents = events.filter((event) => event.parentOperationId === batch.structuredContent.operationId);
  const replayEvents = events.filter((event) => event.parentOperationId === replay.structuredContent.operationId);
  assert.equal(batchEvents.filter((event) => event.phase === "prepare").length, 20);
  assert.equal(batchEvents.filter((event) => event.phase === "input_dispatched").length, 20);
  assert.equal(replayEvents.filter((event) => event.phase === "prepare").length, 20);
  assert.equal(replayEvents.filter((event) => event.phase === "input_dispatched").length, 20);
  assert.equal(new Set(batchEvents.filter((event) => event.phase === "input_dispatched").map((event) => event.operationId)).size, 20);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("event stream stop auto-generates a skill when Codex did not provide a summary", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-session-"));
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-skills-"));
  const eventsPath = path.join(sessionDir, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({
      type: "keyboard.key",
      application: { processName: "WindowsTerminal.exe" },
      window: { title: "Test Terminal" },
      input: { keyName: "Enter" },
    }) + "\n",
    "utf8",
  );
  const server = createEventStreamServer({
    skillsRoot,
    recorderClient: {
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({
        isRecording: false,
        sessionID: "s1",
        eventsPath,
        metadataPath: path.join(sessionDir, "metadata.json"),
        sessionDirectoryPath: sessionDir,
        installSkillOnStop: true,
      }),
    },
  });
  const result = await server._registeredTools.event_stream_stop.handler({ installSkill: true });
  assert.equal(result.structuredContent.requiresWorkflowSummary, false);
  assert.equal(result.structuredContent.requiresCodexRefinement, true);
  assert.equal(result.structuredContent.summarySource, "automatic-event-analysis");
  assert.equal(result.structuredContent.reviewRecommended, true);
  assert.equal(result.structuredContent.generatedSkill.installed, true);
  assert.equal(result.structuredContent.generatedSkill.draft, true);
  assert.equal(result.structuredContent.nextAction.tool, "event_stream_generate_skill");
  assert.equal(result.structuredContent.codexRefinementContext.sessionID, "s1");
  assert.match(result.structuredContent.generatedSkill.skillName, /^record-replay-windowsterminal-/);
  assert.equal(fs.existsSync(result.structuredContent.generatedSkill.skillPath), true);
});

test("event stream stop uses MCP sampling to generate a semantic skill when available", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-session-"));
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-skills-"));
  const eventsPath = path.join(sessionDir, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    [
      {
        type: "mouse.click",
        application: { processName: "notepad.exe" },
        window: { title: "notes.txt - Notepad" },
        target: { uia: { name: "Edit" } },
      },
      {
        type: "keyboard.key",
        application: { processName: "notepad.exe" },
        window: { title: "notes.txt - Notepad" },
        input: { keyName: "Ctrl+S" },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  const samplingCalls = [];
  const server = createEventStreamServer({
    skillsRoot,
    createMessage: async (request) => {
      samplingCalls.push(request);
      return {
        role: "assistant",
        content: {
          type: "text",
          text: JSON.stringify({
            workflowName: "Notepad Save Notes",
            workflowSummary: "Replay editing a Notepad document and saving the notes file.",
          }),
        },
        model: "test-model",
      };
    },
    recorderClient: {
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({
        isRecording: false,
        sessionID: "s-sampling",
        eventsPath,
        metadataPath: path.join(sessionDir, "metadata.json"),
        sessionDirectoryPath: sessionDir,
        installSkillOnStop: true,
      }),
    },
  });
  const result = await server._registeredTools.event_stream_stop.handler({ installSkill: true });
  assert.equal(samplingCalls.length, 1);
  assert.match(samplingCalls[0].messages[0].content.text, /notepad\.exe/);
  assert.equal(result.structuredContent.requiresCodexRefinement, false);
  assert.equal(result.structuredContent.reviewRecommended, false);
  assert.equal(result.structuredContent.summarySource, "codex-sampling");
  assert.equal(result.structuredContent.workflowName, "Notepad Save Notes");
  assert.equal(
    result.structuredContent.workflowSummary,
    "Replay editing a Notepad document and saving the notes file.",
  );
  assert.equal(result.structuredContent.generatedSkill.draft, undefined);
  assert.match(result.structuredContent.generatedSkill.skillName, /^record-replay-notepad-save-notes-/);
  assert.equal(fs.existsSync(result.structuredContent.generatedSkill.skillPath), true);
  const markdown = fs.readFileSync(result.structuredContent.generatedSkill.skillPath, "utf8");
  assert.match(markdown, /# Notepad Save Notes/);
  assert.match(markdown, /Replay editing a Notepad document and saving the notes file\./);
});

test("event stream generate skill installs after Codex provides summary", async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-sessions-"));
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-skills-"));
  const sessionID = "20260620-test-session";
  const sessionDir = path.join(sessionRoot, sessionID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    JSON.stringify({
      type: "keyboard.key",
      application: { processName: "WindowsTerminal.exe" },
      window: { title: "Test Terminal" },
      input: { keyName: "Enter" },
    }) + "\n",
    "utf8",
  );
  const server = createEventStreamServer({
    skillsRoot,
    recorderClient: {
      sessionRoot,
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({}),
    },
  });
  const result = await server._registeredTools.event_stream_generate_skill.handler({
    sessionID,
    workflowName: "Terminal Command Test",
    workflowSummary: "Replay a terminal command test.",
  });
  assert.equal(result.structuredContent.generatedSkill.installed, true);
  assert.match(result.structuredContent.generatedSkill.skillName, /^record-replay-terminal-command-test-/);
  assert.equal(fs.existsSync(result.structuredContent.generatedSkill.skillPath), true);
});

test("event stream stop handles no active recording without skill generation", async () => {
  const server = createEventStreamServer({
    recorderClient: {
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({
        isRecording: false,
        endReason: "no_active_recording",
      }),
    },
  });
  const result = await server._registeredTools.event_stream_stop.handler({ installSkill: true });
  assert.equal(result.structuredContent.generatedSkill.installed, false);
  assert.equal(result.structuredContent.requiresNewThread, false);
});

test("event stream panel returns widget metadata for the interactive app", async () => {
  const status = { isRecording: false, eventCount: 0 };
  const server = createEventStreamServer({
    recorderClient: {
      start: async () => ({}),
      status: async () => status,
      stop: async () => ({}),
    },
  });
  const result = await server._registeredTools.event_stream_panel.handler({});
  assert.equal(result._meta["openai/outputTemplate"], "ui://widget/record-replay-windows-status-panel.html");
  assert.deepEqual(result._meta.widgetData, status);
});

test("panel control token is stable across server instances", async () => {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-panel-token-"));
  const tokenPath = path.join(tokenDir, "token");
  const makeRecorder = () => ({
    start: async () => ({}),
    status: async () => ({}),
    stop: async () => ({}),
  });
  const readPanelConfig = async (server) => {
    const resource = server._registeredResources["ui://widget/record-replay-windows-status-panel.html"];
    const result = await resource.readCallback(new URL("ui://widget/record-replay-windows-status-panel.html"));
    const html = result.contents[0].text;
    return JSON.parse(html.match(/window\.__RECORD_REPLAY_PANEL_CONTROL__=([^;]+);/)[1]);
  };

  const server1 = createEventStreamServer({
    enablePanelControlServer: true,
    panelControlPort: 48910,
    panelControlTokenPath: tokenPath,
    recorderClient: makeRecorder(),
  });
  const config1 = await readPanelConfig(server1);
  server1.closeRecorder();

  const server2 = createEventStreamServer({
    enablePanelControlServer: true,
    panelControlPort: 48911,
    panelControlTokenPath: tokenPath,
    recorderClient: makeRecorder(),
  });
  const config2 = await readPanelConfig(server2);
  server2.closeRecorder();

  assert.equal(config1.preferredDisplayMode, "fullscreen");
  assert.equal(config2.preferredDisplayMode, "fullscreen");
  assert.equal(config1.token, config2.token);
  assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), config1.token);
  assert.match(config1.endpoint, /127\.0\.0\.1:48910\/tool$/);
  assert.match(config2.endpoint, /127\.0\.0\.1:48911\/tool$/);
});

test("event stream server exposes recorder cleanup", () => {
  let closed = false;
  const server = createEventStreamServer({
    recorderClient: {
      start: async () => ({}),
      status: async () => ({}),
      stop: async () => ({}),
      close: () => {
        closed = true;
      },
    },
  });
  server.closeRecorder();
  assert.equal(closed, true);
});
