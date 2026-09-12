import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("status panel uses local control when server tool proxy is unavailable", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = makeElement("app");
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const storage = new Map();
  const fetchCalls = [];
  const fetchUrls = [];
  const stoppedPayload = {
    isRecording: false,
    requiresWorkflowSummary: false,
    sessionID: "s1",
    eventsPath: "events.jsonl",
    eventCount: 9,
    generatedSkill: {
      installed: true,
      draft: true,
      skillName: "record-replay-smoke",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-smoke/SKILL.md",
    },
    summarySource: "automatic-event-analysis",
    requiresCodexRefinement: true,
  };
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: { getElementById: (id) => elements.get(id) || null },
    window: {
      __RECORD_REPLAY_PANEL_CONTROL__: {
        endpoint: "http://127.0.0.1:47000/tool",
        endpoints: [
          "http://127.0.0.1:47000/tool",
          "http://127.0.0.1:47001/tool",
        ],
        token: "token",
      },
      openai: {
        toolResponseMetadata: {
          widgetData: {
            isRecording: true,
            sessionID: "s1",
            eventsPath: "events.jsonl",
            startedAt: new Date().toISOString(),
            maxDurationSeconds: 120,
          },
        },
      },
      localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      fetch: async (url, options) => {
        fetchUrls.push(String(url));
        if (String(url).includes(":47000/")) {
          throw new Error("connection refused");
        }
        fetchCalls.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: stoppedPayload }),
        };
      },
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: true,
          connected: true,
          serverTools: false,
          message: false,
          error: "",
        }),
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  const stopButton = elements.get("stopButton");
  assert.ok(stopButton);
  assert.equal(stopButton.disabled, false);
  await stopButton.listeners.mouseup({
    type: "mouseup",
    currentTarget: stopButton,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(fetchCalls[0]?.name, "event_stream_stop");
  assert.deepEqual(fetchUrls.slice(0, 2), [
    "http://127.0.0.1:47000/tool",
    "http://127.0.0.1:47001/tool",
  ]);
  assert.match(app.html, /Needs review/);
  assert.match(app.html, /record-replay-smoke/);
  assert.doesNotMatch(app.html, /Panel control bridge is unavailable/);
});

test("status panel unavailable controls still respond with a clear message", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = makeElement("app");
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        element.attrs = match[2];
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      addEventListener: () => {},
    },
    window: {
      openai: {
        toolResponseMetadata: {
          widgetData: { isRecording: false },
        },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: false,
          connected: false,
          serverTools: false,
          message: false,
          error: "",
        }),
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  const startButton = elements.get("startButton");
  assert.ok(startButton);
  assert.equal(startButton.disabled, false);
  assert.match(startButton.attrs, /data-control-unavailable="true"/);
  await startButton.listeners.click({
    type: "click",
    currentTarget: startButton,
    preventDefault: () => {},
    stopPropagation: () => {},
  });

  assert.match(app.html, /Panel control bridge is unavailable/);
});

test("status panel click stops through local control and finalizes the generated skill", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = makeElement("app");
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const storage = new Map();
  const fetchCalls = [];
  const serverToolCalls = [];
  const sentMessages = [];
  const stoppedPayload = {
    isRecording: false,
    requiresWorkflowSummary: false,
    sessionID: "s2",
    eventsPath: "events.jsonl",
    eventCount: 12,
    generatedSkill: {
      installed: true,
      draft: true,
      skillName: "record-replay-draft",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-draft/SKILL.md",
    },
    summarySource: "automatic-event-analysis",
    requiresCodexRefinement: true,
    codexRefinementContext: {
      sessionID: "s2",
      instruction: "Review and regenerate.",
      automaticWorkflow: {
        title: "Panel Stop Smoke",
        summary: "Finalize a panel stop smoke recording.",
      },
    },
    nextAction: {
      tool: "event_stream_generate_skill",
      sessionID: "s2",
    },
  };
  const finalPayload = {
    isRecording: false,
    sessionID: "s2",
    eventsPath: "events.jsonl",
    eventCount: 12,
    generatedSkill: {
      installed: true,
      skillName: "record-replay-panel-stop-smoke",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-panel-stop-smoke/SKILL.md",
    },
    summarySource: "codex-summary",
    requiresCodexRefinement: false,
    requiresNewThread: true,
  };
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: { getElementById: (id) => elements.get(id) || null },
    window: {
      __RECORD_REPLAY_PANEL_CONTROL__: {
        endpoint: "http://127.0.0.1:47000/tool",
        token: "token",
      },
      openai: {
        toolResponseMetadata: {
          widgetData: {
            isRecording: true,
            sessionID: "s2",
            eventsPath: "events.jsonl",
            startedAt: new Date().toISOString(),
            maxDurationSeconds: 120,
          },
        },
      },
      localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push(body);
        const result = body.name === "event_stream_generate_skill" ? finalPayload : stoppedPayload;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result }),
        };
      },
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: true,
          connected: true,
          serverTools: true,
          message: true,
          error: "",
        }),
        callServerTool: async (request) => {
          serverToolCalls.push(request);
          throw new Error("MCP proxy not enabled");
        },
        sendUserMessage: async (request) => {
          sentMessages.push(request);
          return {};
        },
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  const stopButton = elements.get("stopButton");
  assert.ok(stopButton);
  assert.equal(stopButton.disabled, false);
  await stopButton.listeners.pointerup({
    type: "pointerup",
    currentTarget: stopButton,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  await stopButton.listeners.click({
    type: "click",
    currentTarget: stopButton,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(fetchCalls[0]?.name, "event_stream_stop");
  assert.equal(fetchCalls[1]?.name, "event_stream_generate_skill");
  assert.equal(fetchCalls[1]?.arguments.workflowName, "Panel Stop Smoke");
  assert.equal(fetchCalls.length, 2);
  assert.equal(serverToolCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  assert.match(app.html, /Skill ready/);
  assert.match(app.html, /Recording stopped\. Skill finalized\./);
  assert.match(app.html, /record-replay-panel-stop-smoke/);
  assert.doesNotMatch(app.html, /MCP proxy not enabled/);
});

test("status panel finalizes through local control without message capability", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = makeElement("app");
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const storage = new Map();
  const sentMessages = [];
  const stoppedPayload = {
    isRecording: false,
    sessionID: "s3",
    eventsPath: "events.jsonl",
    eventCount: 7,
    generatedSkill: {
      installed: true,
      draft: true,
      skillName: "record-replay-draft",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-draft/SKILL.md",
    },
    summarySource: "automatic-event-analysis",
    requiresWorkflowSummary: false,
    requiresCodexRefinement: true,
    nextAction: {
      tool: "event_stream_generate_skill",
      sessionID: "s3",
    },
  };
  const finalPayload = {
    isRecording: false,
    sessionID: "s3",
    eventsPath: "events.jsonl",
    eventCount: 7,
    generatedSkill: {
      installed: true,
      skillName: "record-replay-finalized",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-finalized/SKILL.md",
    },
    summarySource: "codex-summary",
    requiresCodexRefinement: false,
    requiresNewThread: true,
  };
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: { getElementById: (id) => elements.get(id) || null },
    window: {
      __RECORD_REPLAY_PANEL_CONTROL__: {
        endpoint: "http://127.0.0.1:47000/tool",
        token: "token",
      },
      openai: {
        toolResponseMetadata: {
          widgetData: {
            isRecording: true,
            sessionID: "s3",
            eventsPath: "events.jsonl",
            startedAt: new Date().toISOString(),
            maxDurationSeconds: 120,
          },
        },
      },
      localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        const result = body.name === "event_stream_generate_skill" ? finalPayload : stoppedPayload;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result }),
        };
      },
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: true,
          connected: true,
          serverTools: false,
          message: false,
          error: "",
        }),
        sendUserMessage: async (request) => {
          sentMessages.push(request);
          return {};
        },
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  const stopButton = elements.get("stopButton");
  assert.ok(stopButton);
  await stopButton.listeners.click();
  assert.equal(sentMessages.length, 0);
  assert.match(app.html, /Skill ready/);
  assert.match(app.html, /Recording stopped\. Skill finalized\./);
  assert.match(app.html, /record-replay-finalized/);
  assert.doesNotMatch(app.html, /Refinement request sent to Codex/);
});

test("status panel stop is not blocked by an in-flight refresh", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    disabled: false,
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = makeElement("app");
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const fetchCalls = [];
  let isRecording = true;
  let releaseStatus;
  const stoppedPayload = {
    isRecording: false,
    sessionID: "s4",
    eventsPath: "events.jsonl",
    eventCount: 5,
    generatedSkill: {
      installed: true,
      draft: true,
      skillName: "record-replay-refresh-race",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-refresh-race/SKILL.md",
    },
    summarySource: "automatic-event-analysis",
    requiresWorkflowSummary: false,
    requiresCodexRefinement: true,
  };
  const finalPayload = {
    isRecording: false,
    sessionID: "s4",
    eventsPath: "events.jsonl",
    eventCount: 5,
    generatedSkill: {
      installed: true,
      skillName: "record-replay-refresh-race-final",
      skillPath: "C:/Users/tester/.codex/skills/record-replay-refresh-race-final/SKILL.md",
    },
    summarySource: "codex-summary",
    requiresCodexRefinement: false,
    requiresNewThread: true,
  };
  const event = (type, currentTarget) => ({
    type,
    currentTarget,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: { getElementById: (id) => elements.get(id) || null },
    window: {
      __RECORD_REPLAY_PANEL_CONTROL__: {
        endpoint: "http://127.0.0.1:47000/tool",
        token: "token",
      },
      openai: {
        toolResponseMetadata: {
          widgetData: {
            isRecording: true,
            sessionID: "s4",
            eventsPath: "events.jsonl",
            startedAt: new Date().toISOString(),
            maxDurationSeconds: 120,
          },
        },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push(body);
        if (body.name === "event_stream_status") {
          return new Promise((resolve) => {
            releaseStatus = () => resolve({
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                result: { isRecording, sessionID: "s4", eventsPath: "events.jsonl", eventCount: 5 },
              }),
            });
          });
        }
        if (body.name === "event_stream_stop") {
          isRecording = false;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: stoppedPayload }),
          };
        }
        if (body.name === "event_stream_generate_skill") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: finalPayload }),
          };
        }
        throw new Error(`Unexpected tool ${body.name}`);
      },
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: true,
          connected: true,
          serverTools: false,
          message: false,
          error: "",
        }),
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  const refreshButton = elements.get("refreshButton");
  const refreshPromise = refreshButton.listeners.click(event("click", refreshButton));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopButton = elements.get("stopButton");
  await stopButton.listeners.click(event("click", stopButton));

  assert.deepEqual(fetchCalls.map((call) => call.name), [
    "event_stream_status",
    "event_stream_stop",
    "event_stream_generate_skill",
  ]);
  assert.match(app.html, /Skill ready/);
  assert.match(app.html, /record-replay-refresh-race-final/);

  releaseStatus();
  await refreshPromise;
});

test("status panel global click fallback resolves a root-targeted start button hit", async () => {
  const panelSource = fs.readFileSync(
    new URL("../mcp/widget-assets/status-panel/panel.js", import.meta.url),
    "utf8",
  );
  const elements = new Map();
  const globalListeners = {};
  const makeElement = (id, attrs = "") => ({
    id,
    attrs,
    disabled: false,
    listeners: {},
    rect: { left: 0, top: 0, right: 0, bottom: 0 },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    getAttribute(name) {
      const match = this.attrs.match(new RegExp(`${name}="([^"]+)"`));
      return match?.[1] || "";
    },
    closest(selector) {
      return selector.includes(`#${this.id}`) ? this : null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
  });
  const app = makeElement("app");
  app.closest = () => null;
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      this.html = html;
      elements.clear();
      elements.set("app", app);
      for (const match of html.matchAll(/<button id="([^"]+)"([^>]*)>/g)) {
        const element = makeElement(match[1], match[2]);
        element.disabled = /\sdisabled(?:\s|>|$)/.test(match[2]);
        element.rect = {
          startButton: { left: 10, top: 10, right: 78, bottom: 44 },
          refreshButton: { left: 90, top: 10, right: 170, bottom: 44 },
        }[match[1]] || { left: 0, top: 0, right: 0, bottom: 0 };
        elements.set(match[1], element);
      }
    },
    get() {
      return this.html || "";
    },
  });
  elements.set("app", app);

  const fetchCalls = [];
  const startedPayload = {
    isRecording: true,
    sessionID: "s-root-click",
    sessionDirectoryPath: "C:/Users/tester/AppData/Local/Codex/EventStream/sessions/s-root-click",
    eventsPath: "events.jsonl",
    eventCount: 0,
    startedAt: new Date().toISOString(),
    maxDurationSeconds: 120,
  };
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    String,
    Math,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      addEventListener: (type, listener) => {
        globalListeners[type] = listener;
      },
      elementFromPoint: () => app,
      querySelectorAll: () => [
        elements.get("startButton"),
        elements.get("refreshButton"),
      ].filter(Boolean),
    },
    window: {
      __RECORD_REPLAY_PANEL_CONTROL__: {
        endpoint: "http://127.0.0.1:47000/tool",
        token: "token",
      },
      openai: {
        toolResponseMetadata: {
          widgetData: { isRecording: false },
        },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      fetch: async (_url, options) => {
        fetchCalls.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: startedPayload }),
        };
      },
      recordReplayMcp: {
        getBridgeState: () => ({
          ready: true,
          connected: true,
          serverTools: false,
          message: false,
          error: "",
        }),
        notifyResize: () => {},
      },
    },
  };
  context.globalThis = context.window;
  vm.runInNewContext(panelSource, context, { filename: "panel.js" });

  assert.equal(typeof globalListeners.mouseup, "function");
  await globalListeners.mouseup({
    type: "mouseup",
    target: app,
    clientX: 24,
    clientY: 25,
    preventDefault: () => {},
    stopPropagation: () => {},
  });

  assert.equal(fetchCalls[0]?.name, "event_stream_start");
  assert.match(app.html, /Recording/);
  assert.match(app.html, /s-root-click/);
});
