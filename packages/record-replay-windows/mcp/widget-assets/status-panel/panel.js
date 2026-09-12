(function () {
  "use strict";

  const app = document.getElementById("app");
  const STATUS_STORAGE_KEY = "recordReplayLatestStatus:v2";
  const progressMessages = {
    event_stream_start: "Starting recording...",
    event_stream_stop: "Stopping recording...",
    event_stream_status: "Refreshing status...",
    event_stream_refine: "Asking Codex to refine...",
    event_stream_generate_skill: "Finalizing skill...",
  };
  const state = {
    status: hydrate(readToolOutput() || readSharedStatus()),
    sharedUpdatedAt: 0,
    busy: false,
    refreshing: false,
    action: "",
    message: "",
    error: "",
    lastStopResult: null,
    lastControlEvent: { key: "", time: 0 },
    bridgeState: readBridgeState(),
  };

  let renderTimer = null;
  let pollTimer = null;
  let globalControlsBound = false;

  window.addEventListener("openai:set_globals", (event) => {
    mergeOpenAiGlobals(event.detail?.globals);
    const output = readToolOutput();
    if (output && Object.keys(output).length) {
      updateStatus(output);
    }
    render();
  });

  window.addEventListener("recordReplayMcp:bridge-state", (event) => {
    state.bridgeState = event.detail || readBridgeState();
    if (state.bridgeState?.serverTools === false && isProxyUnavailable(state.error)) {
      state.error = "";
      state.message = controlUnavailableMessage();
    }
    render();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== STATUS_STORAGE_KEY) return;
    const shared = readSharedStatusRecord();
    if (shared?.status) {
      updateStatus(shared.status, { persist: false, updatedAt: shared.updatedAt });
      render();
    }
  });

  function readToolOutput() {
    const openai = window.openai || {};
    const metadata = openai.toolResponseMetadata || {};
    return metadata.widgetData || normalizeToolPayload(openai.toolOutput) || null;
  }

  function mergeOpenAiGlobals(globals) {
    if (globals && typeof globals === "object") {
      window.openai = Object.assign(window.openai || {}, globals);
    }
  }

  function normalizeToolPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    if (payload._meta?.widgetData) return payload._meta.widgetData;
    if (payload.structuredContent && (payload.content || payload._meta || payload.isError !== undefined)) {
      return payload.structuredContent;
    }
    return payload;
  }

  function hydrate(value) {
    if (!value || typeof value !== "object") {
      return { isRecording: false };
    }
    return value;
  }

  function updateStatus(value, options = {}) {
    const status = hydrate(value);
    state.status = status;
    if (status.isRecording) {
      state.lastStopResult = null;
    } else if (status.generatedSkill || status.requiresWorkflowSummary || status.requiresCodexRefinement) {
      state.lastStopResult = status;
    }
    const updatedAt = options.updatedAt || Date.now();
    state.sharedUpdatedAt = Math.max(state.sharedUpdatedAt || 0, updatedAt);
    if (options.persist !== false) writeSharedStatus(status, updatedAt);
  }

  function readSharedStatus() {
    return readSharedStatusRecord()?.status || null;
  }

  function readSharedStatusRecord() {
    try {
      const raw = window.localStorage?.getItem(STATUS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function writeSharedStatus(status, updatedAt) {
    try {
      window.localStorage?.setItem(STATUS_STORAGE_KEY, JSON.stringify({ status, updatedAt }));
    } catch (_error) {
    }
  }

  function useNewerSharedStatus() {
    const shared = readSharedStatusRecord();
    if (!shared?.status || !shared.updatedAt) return;
    if (shared.updatedAt > (state.sharedUpdatedAt || 0)) {
      updateStatus(shared.status, { persist: false, updatedAt: shared.updatedAt });
    }
  }

  function render() {
    useNewerSharedStatus();
    const status = state.status || {};
    const recording = Boolean(status.isRecording);
    const liveElapsed = recording ? elapsedSeconds(status.startedAt) : 0;
    const maxDuration = Number(status.maxDurationSeconds || 0);
    const expired = recording && maxDuration > 0 && liveElapsed >= maxDuration;
    const elapsed = recording && maxDuration > 0 ? Math.min(liveElapsed, maxDuration) : liveElapsed;
    const generatedSkill = state.lastStopResult?.generatedSkill || status.generatedSkill;
    const needsSummary = Boolean(status.requiresWorkflowSummary || state.lastStopResult?.requiresWorkflowSummary);
    const needsRefinement = Boolean(status.requiresCodexRefinement || state.lastStopResult?.requiresCodexRefinement || generatedSkill?.draft);
    const controlsAvailable = canCallServerTools() || canCallLocalControl() || canRequestCodexAction();
    const statusText = state.busy
      ? "Working"
      : expired
        ? "Timed out"
        : recording
          ? "Recording"
          : needsSummary
            ? "Stopped"
            : generatedSkill?.installed
              ? needsRefinement ? "Needs review" : "Skill ready"
              : "Idle";
    const message = state.error || state.message || bridgeMessage() || defaultMessage(status, generatedSkill, expired);
    const startLabel = state.busy && state.action === "event_stream_start" ? "Starting..." : "Start";
    const stopLabel = state.busy && state.action === "event_stream_stop" ? "Stopping..." : "Stop";
    const refreshLabel = state.busy && state.action === "event_stream_status" ? "Refreshing..." : "Refresh";

    app.innerHTML = [
      '<section class="top-row" aria-busy="' + (state.busy ? "true" : "false") + '">',
      '<div class="title-group">',
      '<h1 class="title">Record & Replay</h1>',
      '<p class="subtitle">' + text(recording ? "Windows workflow capture is active." : "Windows workflow capture is ready.") + '</p>',
      '</div>',
      '<div class="status-pill ' + (recording ? "recording" : "") + (expired ? " expired" : "") + '">',
      '<span class="status-dot"></span>',
      '<span>' + text(statusText) + '</span>',
      '</div>',
      '</section>',
      '<section class="metric-row">',
      metric("Elapsed", formatDuration(elapsed), "timer"),
      metric("Events", String(status.eventCount ?? 0)),
      metric("Suppressed", String(status.suppressedEventCount ?? 0)),
      '</section>',
      '<section class="button-row">',
      recording
        ? '<button id="stopButton" class="danger-button" type="button" data-control-action="stop"' + disabledAttr(controlsAvailable) + '>' + text(stopLabel) + '</button>'
        : '<button id="startButton" class="primary-button" type="button" data-control-action="start"' + disabledAttr(controlsAvailable) + '>' + text(startLabel) + '</button>',
      needsRefinement
        ? '<button id="refineButton" class="secondary-button" type="button" data-control-action="refine"' + disabledAttr(canRequestCodexAction()) + '>' + text(state.busy && state.action === "event_stream_refine" ? "Refining..." : "Refine") + '</button>'
        : "",
      '<button id="refreshButton" class="secondary-button" type="button" data-control-action="refresh"' + disabledAttr(controlsAvailable) + '>' + text(refreshLabel) + '</button>',
      '</section>',
      '<p class="message ' + (state.error ? "error" : "") + '">' + text(message) + '</p>',
      renderPaths(status, generatedSkill),
    ].join("");

    bindEvents();
    scheduleTimers();
    notifyResize();
  }

  function metric(label, value, className) {
    return [
      '<div class="metric">',
      '<p class="metric-label">' + text(label) + '</p>',
      '<p class="metric-value ' + (className || "") + '">' + text(value) + '</p>',
      '</div>',
    ].join("");
  }

  function renderPaths(status, generatedSkill) {
    const rows = [];
    if (status.sessionDirectoryPath) rows.push(pathRow("Session", status.sessionDirectoryPath));
    if (status.eventsPath) rows.push(pathRow("Events", status.eventsPath));
    if (generatedSkill?.skillName) rows.push(pathRow("Skill", generatedSkill.skillName));
    if (generatedSkill?.skillPath) rows.push(pathRow("Skill path", generatedSkill.skillPath));
    if (!rows.length) return "";
    return '<section class="path-list">' + rows.join("") + '</section>';
  }

  function pathRow(label, value) {
    return [
      '<div class="path-row">',
      '<span class="path-label">' + text(label) + '</span>',
      '<span class="path-value" title="' + attr(value) + '">' + text(value) + '</span>',
      '</div>',
    ].join("");
  }

  function bindEvents() {
    bindGlobalControls();
    const startButton = document.getElementById("startButton");
    const stopButton = document.getElementById("stopButton");
    const refineButton = document.getElementById("refineButton");
    const refreshButton = document.getElementById("refreshButton");
    if (startButton) bindControl(startButton, "start", startRecording);
    if (stopButton) bindControl(stopButton, "stop", stopRecording);
    if (refineButton) bindControl(refineButton, "refine", requestRefinement);
    if (refreshButton) bindControl(refreshButton, "refresh", refreshStatus);
  }

  function bindGlobalControls() {
    if (globalControlsBound || typeof document.addEventListener !== "function") return;
    globalControlsBound = true;
    const listener = (event) => {
      const control = controlFromEvent(event);
      if (!control) return;
      return runControlAction(control.key, control.handler, controlEvent(event, control.element));
    };
    for (const type of ["click", "pointerup", "mouseup", "touchend", "keydown"]) {
      document.addEventListener(type, listener, true);
    }
  }

  function bindControl(element, key, handler) {
    const listener = (event) => runControlAction(key, handler, event);
    for (const type of ["click", "pointerup", "mouseup", "touchend", "keydown"]) {
      element.addEventListener(type, listener);
    }
  }

  function controlFromEvent(event) {
    const button = buttonFromEvent(event);
    if (!button || button.disabled) return null;
    const action = button.getAttribute?.("data-control-action") || controlActionForButton(button);
    const handler = controlHandler(action);
    if (!handler) return null;
    return { element: button, key: action, handler };
  }

  function buttonFromEvent(event) {
    const direct = closestControlButton(event?.target);
    if (direct) return direct;
    if (event?.type === "keydown") return null;
    const point = pointFromEvent(event);
    if (!point) return null;
    const hit = typeof document.elementFromPoint === "function"
      ? closestControlButton(document.elementFromPoint(point.x, point.y))
      : null;
    if (hit) return hit;
    return nearestControlButton(point.x, point.y);
  }

  function closestControlButton(target) {
    if (!target) return null;
    if (typeof target.closest === "function") {
      return target.closest("#startButton,#stopButton,#refineButton,#refreshButton");
    }
    const id = target.id || "";
    if (["startButton", "stopButton", "refineButton", "refreshButton"].includes(id)) {
      return target;
    }
    return null;
  }

  function nearestControlButton(x, y) {
    if (typeof document.querySelectorAll !== "function") return null;
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const buttons = document.querySelectorAll("#startButton,#stopButton,#refineButton,#refreshButton");
    for (const button of buttons) {
      if (button.disabled || typeof button.getBoundingClientRect !== "function") continue;
      const rect = button.getBoundingClientRect();
      const pad = 10;
      if (x < rect.left - pad || x > rect.right + pad || y < rect.top - pad || y > rect.bottom + pad) continue;
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = button;
        bestDistance = distance;
      }
    }
    return best;
  }

  function pointFromEvent(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0];
    const x = Number(touch?.clientX ?? event?.clientX);
    const y = Number(touch?.clientY ?? event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function controlActionForButton(button) {
    if (button?.id === "startButton") return "start";
    if (button?.id === "stopButton") return "stop";
    if (button?.id === "refineButton") return "refine";
    if (button?.id === "refreshButton") return "refresh";
    return "";
  }

  function controlHandler(action) {
    if (action === "start") return startRecording;
    if (action === "stop") return stopRecording;
    if (action === "refine") return requestRefinement;
    if (action === "refresh") return refreshStatus;
    return null;
  }

  function controlEvent(event, element) {
    return {
      type: event?.type,
      key: event?.key,
      code: event?.code,
      currentTarget: element,
      preventDefault: () => event?.preventDefault?.(),
      stopPropagation: () => event?.stopPropagation?.(),
    };
  }

  function runControlAction(key, handler, event) {
    if (event?.type === "keydown") {
      const pressed = event.key || event.code || "";
      if (!["Enter", " ", "Space", "Spacebar"].includes(pressed)) return undefined;
    }
    if (event?.currentTarget?.disabled || state.busy) {
      event?.preventDefault?.();
      return undefined;
    }
    const now = Date.now();
    if (state.lastControlEvent?.key === key && now - state.lastControlEvent.time < 500) {
      event?.preventDefault?.();
      return undefined;
    }
    state.lastControlEvent = { key, time: now };
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return handler();
  }

  async function startRecording() {
    await callTool("event_stream_start", {}, "Recording started.");
  }

  async function stopRecording() {
    await callTool("event_stream_stop", { installSkill: true }, "Recording stopped. Skill generated.");
  }

  async function refreshStatus(options = {}) {
    await callTool("event_stream_status", {}, "Status refreshed.", {
      passive: true,
      silent: Boolean(options.silent),
    });
  }

  async function requestRefinement() {
    const status = state.lastStopResult || state.status || {};
    state.busy = true;
    state.action = "event_stream_refine";
    state.error = "";
    state.message = progressMessages.event_stream_refine;
    render();
    await yieldToPaint();
    try {
      await requestCodexAction("event_stream_stop", {}, status);
      state.message = "Refinement request sent to Codex.";
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      state.action = "";
      state.bridgeState = readBridgeState();
      render();
    }
  }

  async function callTool(name, args, successMessage, options = {}) {
    const passive = Boolean(options.passive || name === "event_stream_status");
    if (passive) {
      if (state.refreshing) return;
      state.refreshing = true;
      if (!options.silent) {
        state.action = name;
        state.error = "";
        state.message = progressMessages[name] || "Refreshing...";
        render();
        await yieldToPaint();
      }
    } else {
      state.busy = true;
      state.action = name;
      state.error = "";
      state.message = progressMessages[name] || "Working...";
      render();
      await yieldToPaint();
    }

    try {
      let payload = await callAvailableControlTool(name, args || {});
      const api = window.recordReplayMcp;
      if (!payload && api && typeof api.sendUserMessage === "function" && canRequestCodexAction()) {
        await requestCodexAction(name, args || {});
        state.message = "Request sent to Codex.";
        return;
      }
      if (!payload) {
        state.message = controlUnavailableMessage();
        return;
      }
      if (
        passive &&
        name === "event_stream_status" &&
        payload.isRecording &&
        state.status?.isRecording === false &&
        state.lastStopResult?.sessionID === payload.sessionID
      ) {
        return;
      }
      updateStatus(payload);
      if (name === "event_stream_stop" && (payload.requiresWorkflowSummary || payload.requiresCodexRefinement)) {
        const finalized = await finalizeStoppedRecording(payload);
        if (finalized) {
          updateStatus(finalized);
          state.message = "Recording stopped. Skill finalized.";
        } else if (canRequestCodexAction()) {
          try {
            await requestCodexAction(name, args || {}, payload);
            state.message = "Recording stopped. Refinement request sent to Codex.";
          } catch (_error) {
            state.message = "Draft skill generated. Ask Codex to refine the skill name and summary.";
          }
        } else {
          state.message = "Recording stopped. Draft skill needs Codex refinement.";
        }
      } else {
        if (!passive || !options.silent) state.message = successMessage || "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isProxyUnavailable(message)) {
        state.bridgeState = Object.assign({}, state.bridgeState || {}, { serverTools: false, error: "" });
        if (!options.silent) state.message = controlUnavailableMessage();
        state.error = "";
      } else {
        if (!options.silent) state.error = message;
      }
    } finally {
      if (passive) {
        state.refreshing = false;
        if (state.action === name) state.action = "";
      } else {
        state.busy = false;
        state.action = "";
      }
      state.bridgeState = readBridgeState();
      if (!(passive && options.silent && state.status?.isRecording && updateRecordingMetrics())) {
        render();
      }
    }
  }

  async function callAvailableControlTool(name, args) {
    const api = window.recordReplayMcp;
    const errors = [];
    if (canCallLocalControl()) {
      try {
        return await callLocalControlTool(name, args || {});
      } catch (error) {
        errors.push(error);
      }
    }
    if (api && typeof api.callServerTool === "function" && canCallServerTools()) {
      try {
        const result = await api.callServerTool({ name, arguments: args || {} });
        return normalizeToolPayload(result) || {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isProxyUnavailable(message)) {
          state.bridgeState = Object.assign({}, state.bridgeState || {}, { serverTools: false, error: "" });
        }
        errors.push(error);
      }
    }
    if (errors.length) throw errors[errors.length - 1];
    return null;
  }

  async function finalizeStoppedRecording(status) {
    const args = workflowGenerationArgs(status);
    if (!args) return null;
    state.message = progressMessages.event_stream_generate_skill;
    render();
    await yieldToPaint();
    try {
      return await callAvailableControlTool("event_stream_generate_skill", args);
    } catch (_error) {
      return null;
    }
  }

  function workflowGenerationArgs(status) {
    const workflow =
      status?.codexRefinementContext?.automaticWorkflow ||
      status?.generatedSkill?.workflow ||
      {};
    const sessionID =
      status?.codexRefinementContext?.sessionID ||
      status?.nextAction?.sessionID ||
      status?.sessionID ||
      "";
    const workflowName = limitText(
      workflow.title ||
      status?.workflowName ||
      titleFromSkillName(status?.generatedSkill?.skillName) ||
      "Recorded Windows Workflow",
      80,
    );
    const workflowSummary = limitText(
      workflow.summary ||
      status?.workflowSummary ||
      "Replay the recorded Windows desktop workflow.",
      600,
    );
    if (!sessionID || !workflowName || !workflowSummary) return null;
    return { sessionID, workflowName, workflowSummary };
  }

  function titleFromSkillName(skillName) {
    const value = String(skillName || "")
      .replace(/^record-replay-/, "")
      .replace(/-\d{8}t\d{6}z(?:-\d+)?$/, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return value ? value.replace(/\b\w/g, (char) => char.toUpperCase()) : "";
  }

  function limitText(value, maxLength) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
  }

  function scheduleTimers() {
    if (!renderTimer) {
      renderTimer = setInterval(() => {
        useNewerSharedStatus();
        if (state.status?.isRecording) updateLiveElapsed();
      }, 1000);
    }
    const canRefresh = canCallServerTools() || canCallLocalControl();
    if (state.status?.isRecording && canRefresh && !pollTimer) {
      pollTimer = setInterval(() => {
        if (!state.busy && state.status?.isRecording && (canCallServerTools() || canCallLocalControl())) {
          refreshStatus({ silent: true });
        }
      }, 2500);
    }
    if ((!state.status?.isRecording || !(canCallServerTools() || canCallLocalControl())) && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function updateLiveElapsed() {
    const status = state.status || {};
    if (!status.isRecording) return;
    const maxDuration = Number(status.maxDurationSeconds || 0);
    const liveElapsed = elapsedSeconds(status.startedAt);
    const expired = maxDuration > 0 && liveElapsed >= maxDuration;
    const elapsed = maxDuration > 0 ? Math.min(liveElapsed, maxDuration) : liveElapsed;
    const timer = typeof app.querySelector === "function" ? app.querySelector(".metric-value.timer") : null;
    if (timer) {
      timer.textContent = formatDuration(elapsed);
    } else {
      render();
    }
    if (expired) render();
  }

  function updateRecordingMetrics() {
    if (typeof app.querySelectorAll !== "function") return false;
    const status = state.status || {};
    const values = app.querySelectorAll(".metric-value");
    if (!values || values.length < 3) return false;
    const maxDuration = Number(status.maxDurationSeconds || 0);
    const liveElapsed = elapsedSeconds(status.startedAt);
    const expired = status.isRecording && maxDuration > 0 && liveElapsed >= maxDuration;
    if (expired) return false;
    const elapsed = maxDuration > 0 ? Math.min(liveElapsed, maxDuration) : liveElapsed;
    values[0].textContent = formatDuration(elapsed);
    values[1].textContent = String(status.eventCount ?? 0);
    values[2].textContent = String(status.suppressedEventCount ?? 0);
    return true;
  }

  function defaultMessage(status, generatedSkill, expired) {
    if (expired) return "Recording reached its time limit; refresh status from Codex.";
    if (status.isRecording) return "Capture is running.";
    if (status.requiresWorkflowSummary) return "Recording stopped. Ask Codex to regenerate the skill with a better summary if needed.";
    if (status.requiresCodexRefinement || generatedSkill?.draft) return "Draft skill generated. Codex must refine the name and summary before this skill is final.";
    if (generatedSkill?.installed) return generatedSkill.activationNote || "Start a new Codex thread to use the generated skill.";
    return "Ready.";
  }

  async function requestCodexAction(name, args, statusOverride) {
    const api = window.recordReplayMcp;
    if (!api || typeof api.sendUserMessage !== "function") {
      throw new Error("Host message bridge unavailable.");
    }
    const status = statusOverride || state.status || {};
    const textMessage = codexActionMessage(name, args, status);
    const context = [
      "Record & Replay Windows panel action",
      "",
      `Requested tool: ${name}`,
      `Recording active: ${Boolean(status.isRecording)}`,
      status.sessionID ? `Session: ${status.sessionID}` : "",
      status.eventsPath ? `Events path: ${status.eventsPath}` : "",
      "",
      "If stopping, stop the recording first, summarize the workflow from the session/events, then generate the skill with a semantic workflowName and workflowSummary.",
    ].filter(Boolean).join("\n");
    await api.sendUserMessage({
      text: textMessage,
      context,
      structuredContent: {
        recordReplayAction: {
          tool: name,
          arguments: args || {},
          status,
        },
      },
    });
  }

  function codexActionMessage(name, args, status) {
    if (name === "event_stream_stop") {
      if (status.requiresCodexRefinement) {
        return [
          "The Record & Replay Windows plugin generated a draft skill from event analysis.",
          "Review the returned codexRefinementContext and draft SKILL.md, then call event_stream_generate_skill with the same sessionID and a better workflowName/workflowSummary.",
          status.sessionID ? `SessionID: ${status.sessionID}` : "",
        ].filter(Boolean).join(" ");
      }
      if (status.requiresWorkflowSummary) {
        return [
          "The Record & Replay Windows recording has been stopped.",
          "Inspect the returned session/events, then call event_stream_generate_skill with sessionID, workflowName, and workflowSummary if a better skill name or summary is needed.",
          status.sessionID ? `SessionID: ${status.sessionID}` : "",
        ].filter(Boolean).join(" ");
      }
      return [
        "Stop the current Record & Replay Windows recording.",
        "Use event_stream_stop to stop it, then summarize what was recorded before generating a skill.",
        "If event_stream_stop returns requiresWorkflowSummary, inspect the returned session/events and call event_stream_generate_skill with sessionID, workflowName, and workflowSummary.",
        status.sessionID ? `SessionID: ${status.sessionID}` : "",
      ].filter(Boolean).join(" ");
    }
    if (name === "event_stream_start") {
      return "Start a Record & Replay Windows recording with sensible defaults and show the status panel.";
    }
    if (name === "event_stream_status") {
      return "Refresh the current Record & Replay Windows recording status.";
    }
    return `Run Record & Replay Windows action ${name} with arguments ${JSON.stringify(args || {})}.`;
  }

  function readBridgeState() {
    const api = window.recordReplayMcp;
    if (api && typeof api.getBridgeState === "function") {
      try {
        return api.getBridgeState();
      } catch (_error) {
      }
    }
    return api?.bridgeState || {};
  }

  function canCallServerTools() {
    const bridge = state.bridgeState || readBridgeState() || {};
    if (bridge.serverTools === false) return false;
    if (isProxyUnavailable(bridge.error)) return false;
    return true;
  }

  function localControlConfig() {
    const config = window.__RECORD_REPLAY_PANEL_CONTROL__;
    return config && typeof config === "object" ? config : null;
  }

  function canCallLocalControl() {
    const config = localControlConfig();
    return Boolean(localControlEndpoints(config).length && config?.token && typeof window.fetch === "function");
  }

  async function callLocalControlTool(name, args) {
    const config = localControlConfig();
    const endpoints = localControlEndpoints(config);
    if (!endpoints.length || !config?.token) throw new Error("Local panel control is unavailable.");
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const endpoint of endpoints) {
        try {
          const response = await window.fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-record-replay-token": config.token,
            },
            body: JSON.stringify({ name, arguments: args || {} }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch (_error) {
          }
          if (!response.ok || body?.ok === false) {
            throw new Error(body?.error || `Local panel control failed with HTTP ${response.status}.`);
          }
          return normalizeToolPayload(body?.result) || {};
        } catch (error) {
          lastError = error;
        }
      }
      await delay(250 * (attempt + 1));
    }
    throw lastError || new Error("Local panel control is unavailable.");
  }

  function localControlEndpoints(config) {
    const raw = Array.isArray(config?.endpoints) ? config.endpoints : [config?.endpoint];
    return raw
      .map((endpoint) => String(endpoint || "").trim())
      .filter(Boolean);
  }

  function canRequestCodexAction() {
    const bridge = state.bridgeState || readBridgeState() || {};
    if (bridge.error && !isProxyUnavailable(bridge.error)) return false;
    if (bridge.message === false) return false;
    const api = window.recordReplayMcp;
    return Boolean(api && typeof api.sendUserMessage === "function");
  }

  function bridgeMessage() {
    const bridge = state.bridgeState || {};
    if (canCallLocalControl()) return "";
    if (bridge.serverTools === false || isProxyUnavailable(bridge.error)) return controlUnavailableMessage();
    if (bridge.error) return bridge.error;
    return "";
  }

  function controlUnavailableMessage() {
    return "Panel control bridge is unavailable. Ask Codex to start, refresh, or stop.";
  }

  function isProxyUnavailable(message) {
    return /MCP proxy not enabled|server tool calls are not available|Host bridge unavailable/i.test(String(message || ""));
  }

  function isExpiredStatus(status) {
    if (!status?.isRecording) return false;
    const maxDuration = Number(status.maxDurationSeconds || 0);
    return maxDuration > 0 && elapsedSeconds(status.startedAt) >= maxDuration;
  }

  function elapsedSeconds(startedAt) {
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start)) return 0;
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
  }

  function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const two = (value) => String(value).padStart(2, "0");
    return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
  }

  function disabledAttr(controlsAvailable) {
    if (state.busy) return " disabled";
    if (!controlsAvailable) return ' title="Ask Codex to start, refresh, or stop" data-control-unavailable="true"';
    return "";
  }

  function yieldToPaint() {
    return new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function notifyResize() {
    const api = window.recordReplayMcp;
    if (api && typeof api.notifyResize === "function") {
      api.notifyResize();
    }
  }

  function text(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function attr(value) {
    return text(value).replace(/"/g, "&quot;");
  }

  render();
})();
