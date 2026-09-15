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

test("recording defaults to capturePolicy off", async () => {
  let startInput = null;
  const server = createEventStreamServer({
    recorderClient: {
      start: async (input) => {
        startInput = input;
        return { isRecording: true };
      },
      status: async () => ({}),
      stop: async () => ({}),
    },
  });
  await server._registeredTools.event_stream_start.handler({});
  assert.equal(startInput.capturePolicy, "off");
  assert.equal(startInput.redactText, true);
  server.closeRecorder();
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

test("parent operation ids deduplicate batch, replay, and composite type across 100 concurrent calls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-parent-idempotency-"));
  const sessionID = "one-step-replay";
  const sessionDir = path.join(root, sessionID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), JSON.stringify({
    type: "keyboard.key",
    timestamp: new Date().toISOString(),
    application: { processName: "fixture.exe", pid: 202 },
    window: { title: "Fixture Window", hwnd: 101 },
    input: { vkCode: 0x0d, keyName: "Enter" },
  }) + "\n", "utf8");
  fs.writeFileSync(path.join(sessionDir, "suppressed_events.jsonl"), "", "utf8");

  let operationSequence = 0;
  const counts = { click: 0, type: 0, key: 0, focus: 0 };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  const actor = {
    actorBootId: "fake-boot",
    createOperationId: () => `fake-boot:${++operationSequence}`,
    addEventListener: () => () => {},
    waitForOperationSafety: async (operationId) => ({ operationId, safe: true }),
    uiSnapshot: async () => ({
      window: { hwnd: 101, pid: 202, title: "Fixture Window" },
      elements: [{ i: 0, type: "Edit", name: "Fixture", automationId: "FixtureInput", cx: 10, cy: 10, enabled: true }],
    }),
    screenshot: async () => ({}),
    click: async () => { counts.click += 1; await pause(); return { clicked: true }; },
    mouseMove: async () => ({ moved: true }),
    typeText: async () => { counts.type += 1; await pause(); return { typed: true }; },
    key: async () => { counts.key += 1; await pause(); return { keys: true }; },
    scroll: async () => ({ scrolled: true }),
    windowFocus: async () => {
      counts.focus += 1;
      await pause();
      return { focused: true, foreground: { hwnd: 101, pid: 202, processName: "fixture.exe", windowTitle: "Fixture Window" } };
    },
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
  const serviceBootId = server.actionCoordinator.bootId;
  assert.notEqual(serviceBootId, actor.actorBootId);
  t.after(() => {
    server.closeRecorder();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const commonFeedback = { returnState: false, returnScreenshotPath: false };
  const batchInput = {
    operationId: `${serviceBootId}:parent-batch`,
    actions: [{ action: "type", text: "once" }],
    expect: { titleExact: "Fixture Window" },
    ...commonFeedback,
  };
  const batches = await Promise.all(Array.from({ length: 100 }, () => server._registeredTools.computer_batch.handler(batchInput)));
  assert.equal(counts.type, 1);
  assert.ok(batches.every((result) => result.structuredContent.operationId === batchInput.operationId));
  await server._registeredTools.computer_batch.handler(batchInput);
  assert.equal(counts.type, 1);
  await assert.rejects(
    server._registeredTools.computer_batch.handler({ ...batchInput, actions: [{ action: "type", text: "changed" }] }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  const batchStatus = await server._registeredTools.automation_status.handler({ operationId: batchInput.operationId });
  assert.equal(batchStatus.structuredContent.operation.state, "succeeded");

  const replayInput = { operationId: `${serviceBootId}:parent-replay`, sessionID, stepDelayMs: 0 };
  const replays = await Promise.all(Array.from({ length: 100 }, () => server._registeredTools.replay_run.handler(replayInput)));
  assert.equal(counts.focus, 1);
  assert.equal(counts.key, 1);
  assert.ok(replays.every((result) => result.structuredContent.operationId === replayInput.operationId));
  await assert.rejects(
    server._registeredTools.replay_run.handler({ ...replayInput, startIndex: 1 }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const snapshot = await server._registeredTools.ui_snapshot.handler({});
  const typeInput = {
    operationId: `${serviceBootId}:parent-composite-type`,
    text: "only once",
    elementIndex: 0,
    snapshotId: snapshot.structuredContent.snapshotId,
    ...commonFeedback,
  };
  const beforeComposite = { click: counts.click, type: counts.type };
  await Promise.all(Array.from({ length: 100 }, () => server._registeredTools.computer_type.handler(typeInput)));
  assert.equal(counts.click - beforeComposite.click, 1);
  assert.equal(counts.type - beforeComposite.type, 1);
  await assert.rejects(
    server._registeredTools.computer_type.handler({ ...typeInput, text: "changed" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("parent operations reject expired boot and mismatched session before dispatch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-parent-binding-"));
  const sessionID = "boot-bound-replay";
  const sessionDir = path.join(root, sessionID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), JSON.stringify({
    type: "keyboard.key",
    timestamp: new Date().toISOString(),
    application: { processName: "fixture.exe", pid: 202 },
    window: { title: "Fixture Window", hwnd: 101 },
    input: { vkCode: 0x0d, keyName: "Enter" },
  }) + "\n", "utf8");
  fs.writeFileSync(path.join(sessionDir, "suppressed_events.jsonl"), "", "utf8");

  const counts = { click: 0, type: 0, key: 0, focus: 0 };
  const actor = {
    actorBootId: "boot-one",
    ensureStarted: () => {},
    createOperationId() { return `${this.actorBootId}:generated`; },
    addEventListener: () => () => {},
    waitForOperationSafety: async (operationId) => ({ operationId, safe: true }),
    uiSnapshot: async () => ({
      window: { hwnd: 101, pid: 202, title: "Fixture Window" },
      elements: [{ i: 0, type: "Edit", name: "Fixture", cx: 10, cy: 10, enabled: true }],
    }),
    screenshot: async () => ({}),
    click: async () => { counts.click += 1; return { clicked: true }; },
    mouseMove: async () => ({ moved: true }),
    typeText: async () => { counts.type += 1; return { typed: true }; },
    key: async () => { counts.key += 1; return { keyed: true }; },
    scroll: async () => ({ scrolled: true }),
    windowFocus: async () => {
      counts.focus += 1;
      return { focused: true, foreground: { hwnd: 101, pid: 202, processName: "fixture.exe", windowTitle: "Fixture Window" } };
    },
    uiaFind: async () => ({ elements: [] }),
    uiaInvoke: async () => ({ invoked: true }),
    operationStatus: () => null,
    close: () => {},
  };
  const createServer = () => createEventStreamServer({
    actorClient: actor,
    automationLockPath: path.join(root, "desktop.lock"),
    recorderClient: { sessionRoot: root, start: async () => ({}), status: async () => ({}), stop: async () => ({}) },
  });
  const server = createServer();
  const serviceBootId = server.actionCoordinator.bootId;
  assert.notEqual(serviceBootId, actor.actorBootId);
  t.after(() => {
    server.closeRecorder();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const feedback = { returnState: false, returnScreenshotPath: false };

  const initialBatchInput = {
    sessionId: "session-a",
    actions: [{ action: "type", text: "once" }],
    expect: { titleExact: "Fixture Window" },
    ...feedback,
  };
  const initialBatch = await server._registeredTools.computer_batch.handler(initialBatchInput);
  const batchInput = {
    ...initialBatchInput,
    operationId: initialBatch.structuredContent.operationId,
  };
  assert.ok(batchInput.operationId.startsWith(`${serviceBootId}:`));
  assert.equal(batchInput.operationId.startsWith(`${actor.actorBootId}:`), false);
  assert.equal(counts.type, 1);

  const serialRetry = await server._registeredTools.computer_batch.handler(batchInput);
  assert.equal(serialRetry.structuredContent.operationId, batchInput.operationId);
  assert.equal(counts.type, 1);

  const retries = await Promise.all(Array.from(
    { length: 100 },
    () => server._registeredTools.computer_batch.handler(batchInput),
  ));
  assert.equal(counts.type, 1);
  assert.ok(retries.every((result) => result.structuredContent.operationId === batchInput.operationId));
  const currentStatus = await server._registeredTools.automation_status.handler({ operationId: batchInput.operationId });
  assert.equal(currentStatus.structuredContent.operation.state, "succeeded");
  await assert.rejects(
    server._registeredTools.computer_batch.handler({ ...batchInput, sessionId: "session-b" }),
    (error) => error.code === "SESSION_MISMATCH",
  );
  assert.equal(counts.type, 1);

  actor.actorBootId = "boot-two";
  await assert.rejects(
    server._registeredTools.computer_batch.handler(batchInput),
    (error) => error.code === "BOOT_MISMATCH" && error.status === "unknown",
  );
  assert.equal(counts.type, 1);
  const expiredStatus = await server._registeredTools.automation_status.handler({ operationId: batchInput.operationId });
  assert.equal(expiredStatus.structuredContent.operation.state, "unknown");
  assert.equal(expiredStatus.structuredContent.operation.error.code, "BOOT_MISMATCH");

  const snapshot = await server._registeredTools.ui_snapshot.handler({});
  const compositeInput = {
    operationId: `${serviceBootId}:composite`,
    text: "once",
    elementIndex: 0,
    snapshotId: snapshot.structuredContent.snapshotId,
    ...feedback,
  };
  await server._registeredTools.computer_type.handler(compositeInput);
  assert.deepEqual({ click: counts.click, type: counts.type }, { click: 1, type: 2 });
  actor.actorBootId = "boot-three";
  await assert.rejects(
    server._registeredTools.computer_type.handler(compositeInput),
    (error) => error.code === "BOOT_MISMATCH",
  );
  assert.deepEqual({ click: counts.click, type: counts.type }, { click: 1, type: 2 });

  const replayInput = { operationId: `${serviceBootId}:replay`, sessionID, stepDelayMs: 0 };
  await server._registeredTools.replay_run.handler(replayInput);
  assert.deepEqual({ focus: counts.focus, key: counts.key }, { focus: 1, key: 1 });
  actor.actorBootId = "boot-four";
  await assert.rejects(
    server._registeredTools.replay_run.handler(replayInput),
    (error) => error.code === "BOOT_MISMATCH",
  );
  assert.deepEqual({ focus: counts.focus, key: counts.key }, { focus: 1, key: 1 });

  const currentActorBootInput = {
    ...initialBatchInput,
    operationId: `${serviceBootId}:same-actor-new-service`,
  };
  await server._registeredTools.computer_batch.handler(currentActorBootInput);
  assert.equal(counts.type, 3);

  const replacementServer = createServer();
  assert.notEqual(replacementServer.actionCoordinator.bootId, serviceBootId);
  assert.equal(actor.actorBootId, "boot-four");
  await assert.rejects(
    replacementServer._registeredTools.computer_batch.handler(currentActorBootInput),
    (error) => error.code === "BOOT_MISMATCH" && error.status === "unknown",
  );
  assert.equal(counts.type, 3);
  replacementServer.closeRecorder();
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
