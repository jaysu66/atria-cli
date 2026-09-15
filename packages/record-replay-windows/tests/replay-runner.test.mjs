import assert from "node:assert/strict";
import test from "node:test";

import { clusterSuppressed, executeReplay, planReplay, vkToKey } from "../mcp/replay-runner.mjs";

function clickEvent({ ts, x, y, uia = null, app = "Notepad.exe", title = "Untitled - Notepad" }) {
  return {
    type: "mouse.click",
    timestamp: ts,
    application: { processName: app },
    window: { title },
    input: { x, y, button: "left" },
    target: { uia },
  };
}

function keyEvent({ ts, vkCode, keyName, app = "Notepad.exe", title = "Untitled - Notepad" }) {
  return {
    type: "keyboard.key",
    timestamp: ts,
    application: { processName: app },
    window: { title },
    input: { vkCode, keyName },
  };
}

test("vkToKey maps special keys and drops bare modifiers", () => {
  assert.equal(vkToKey(0x0d), "enter");
  assert.equal(vkToKey(0x09), "tab");
  assert.equal(vkToKey(0x74), "f5");
  assert.equal(vkToKey(0x11), null); // Ctrl alone = noise
  assert.equal(vkToKey(0xa0), null); // LShift
});

test("clusterSuppressed groups nearby keystrokes into one cluster", () => {
  const base = Date.parse("2026-07-04T10:00:00.000Z");
  const mk = (offsetMs) => ({
    type: "keyboard.key",
    timestamp: new Date(base + offsetMs).toISOString(),
  });
  const clusters = clusterSuppressed([mk(0), mk(300), mk(700), mk(5000), mk(5200)]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 3);
  assert.equal(clusters[1].count, 2);
});

test("planReplay orders clicks, keys, and inserts needs_agent for redacted typing", () => {
  const t = (s) => `2026-07-04T10:00:${String(s).padStart(2, "0")}.000Z`;
  const events = [
    clickEvent({ ts: t(1), x: 100, y: 200, uia: { name: "文本编辑器", automationId: "", className: "RichEditD2DPT", controlType: "Document" } }),
    keyEvent({ ts: t(10), vkCode: 0x0d, keyName: "Enter" }),
    { type: "mouse.wheel", timestamp: t(11), input: {} },
    keyEvent({ ts: t(12), vkCode: 0x11, keyName: "Ctrl" }), // bare modifier → silently dropped
    { type: "recorder.notice", timestamp: t(13) },
  ];
  const suppressed = [
    { type: "keyboard.key", timestamp: t(5) },
    { type: "keyboard.key", timestamp: t(6) },
  ];
  const plan = planReplay(events, suppressed);
  assert.deepEqual(
    plan.map((s) => s.kind),
    ["click", "needs_agent", "key", "needs_agent"],
  );
  assert.equal(plan[0].uia.name, "文本编辑器");
  assert.equal(plan[1].approxKeys, 2);
  assert.equal(plan[2].keys, "enter");
});

test("planReplay uses coordinates when uia target lacks name and automationId", () => {
  const plan = planReplay([
    clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 50, y: 60, uia: { name: "", automationId: "", className: "X", controlType: "Pane" } }),
  ]);
  assert.equal(plan[0].uia, null);
});

function mockActor(overrides = {}) {
  const calls = [];
  return {
    calls,
    windowFocus: async (p) => {
      calls.push(["windowFocus", p]);
      return { focused: true, foreground: { hwnd: 101, pid: 202, processName: "Notepad.exe", windowTitle: "Untitled - Notepad" } };
    },
    uiaFind: async (p) => {
      calls.push(["uiaFind", p]);
      return { count: 1, elements: [{ boundingRect: [10, 10, 30, 30] }] };
    },
    click: async (p) => {
      calls.push(["click", p]);
      return {};
    },
    key: async (p) => {
      calls.push(["key", p]);
      return {};
    },
    typeText: async (p) => {
      calls.push(["typeText", p]);
      return {};
    },
    scroll: async (p) => {
      calls.push(["scroll", p]);
      return {};
    },
    ...overrides,
  };
}

test("executeReplay prefers uia center over recorded coordinates", async () => {
  const actor = mockActor();
  const plan = planReplay([
    clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 999, y: 999, uia: { name: "保存", automationId: "SaveBtn", className: "", controlType: "Button" } }),
  ]);
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.failedCount, 0);
  assert.equal(outcome.results[0].method, "uia");
  const clickCall = actor.calls.find(([name]) => name === "click");
  assert.deepEqual({ x: clickCall[1].x, y: clickCall[1].y }, { x: 20, y: 20 });
});

test("executeReplay falls back to coordinates when uia find fails", async () => {
  const actor = mockActor({
    uiaFind: async () => ({ count: 0, elements: [] }),
  });
  const plan = planReplay([
    clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 111, y: 222, uia: { name: "保存", automationId: "", className: "", controlType: "Button" } }),
  ]);
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.results[0].method, "coords");
  const clickCall = actor.calls.find(([name]) => name === "click");
  assert.deepEqual({ x: clickCall[1].x, y: clickCall[1].y }, { x: 111, y: 222 });
});

test("executeReplay never coordinate-fallbacks after a UIA-resolved click was dispatched", async (t) => {
  for (const [code, status] of [
    ["EXECUTION_TIMEOUT", "unknown"],
    ["ACTOR_EXITED", "unknown"],
    ["PARTIAL_INPUT", "unknown"],
  ]) {
    await t.test(code, async () => {
      const clickCalls = [];
      const actor = mockActor({
        click: async (params) => {
          clickCalls.push(params);
          const error = new Error(`${code}: outcome not final`);
          error.code = code;
          error.status = status;
          error.operationId = `actor-boot:${code}`;
          throw error;
        },
      });
      const plan = planReplay([
        clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 999, y: 999, uia: { name: "保存", automationId: "SaveBtn", className: "", controlType: "Button" } }),
      ]);
      const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
      assert.equal(clickCalls.length, 1);
      assert.deepEqual({ x: clickCalls[0].x, y: clickCalls[0].y }, { x: 20, y: 20 });
      assert.equal(outcome.completed, false);
      assert.equal(outcome.status, "unknown");
      assert.equal(outcome.failedCount, 0);
      assert.equal(outcome.unknownCount, 1);
      assert.equal(outcome.results[0].code, code);
      assert.equal(outcome.results[0].operationId, `actor-boot:${code}`);
    });
  }
});

test("executeReplay preserves cancellation semantics and counters", async () => {
  const actor = mockActor({
    key: async () => {
      const error = new Error("REQUEST_EXPIRED: queued write expired before execution");
      error.code = "REQUEST_EXPIRED";
      error.status = "cancelled";
      error.operationId = "actor-boot:expired";
      throw error;
    },
  });
  const outcome = await executeReplay(actor, [{ kind: "key", keys: "enter" }], { stepDelayMs: 0 });
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.cancelledCount, 1);
  assert.equal(outcome.failedCount, 0);
  assert.equal(outcome.results[0].code, "REQUEST_EXPIRED");
  assert.equal(outcome.results[0].operationId, "actor-boot:expired");
});

test("executeReplay never continues automatically after an unknown outcome", async () => {
  let keyCalls = 0;
  const actor = mockActor({
    key: async () => {
      keyCalls += 1;
      const error = new Error("ACTOR_EXITED: outcome unknown");
      error.code = "ACTOR_EXITED";
      error.status = "unknown";
      error.operationId = "actor-boot:unknown";
      throw error;
    },
  });
  const outcome = await executeReplay(actor, [
    { kind: "key", keys: "enter" },
    { kind: "key", keys: "tab" },
  ], { stepDelayMs: 0, stopOnFailure: false });
  assert.equal(keyCalls, 1);
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.stoppedAt, 0);
  assert.equal(outcome.nextIndex, 0);
});

test("recorded Unicode text including a surrogate pair and newline replays exactly", async () => {
  const text = "你好 Atria 😀\n第二行";
  const plan = planReplay([{
    type: "keyboard.text",
    timestamp: "2026-07-04T10:00:01.000Z",
    application: { processName: "Notepad.exe", pid: 202 },
    window: { title: "Untitled - Notepad", hwnd: 101 },
    input: { text, utf16Length: text.length, source: "vk_packet" },
  }]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "type");
  assert.equal(plan[0].text, text);

  const actor = mockActor();
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.status, "succeeded");
  const typeCall = actor.calls.find(([name]) => name === "typeText");
  assert.equal(typeCall[1].text, text);
  assert.deepEqual(
    { hwnd: typeCall[1].expect.hwnd, pid: typeCall[1].expect.pid, titleExact: typeCall[1].expect.titleExact },
    { hwnd: 101, pid: 202, titleExact: "Untitled - Notepad" },
  );
});

test("executeReplay stops at needs_agent and resumes with startIndex", async () => {
  const actor = mockActor();
  const t = (s) => `2026-07-04T10:00:${String(s).padStart(2, "0")}.000Z`;
  const plan = planReplay(
    [
      clickEvent({ ts: t(1), x: 10, y: 10 }),
      keyEvent({ ts: t(20), vkCode: 0x0d, keyName: "Enter" }),
    ],
    [{ type: "keyboard.key", timestamp: t(5) }],
  );
  assert.deepEqual(plan.map((s) => s.kind), ["click", "needs_agent", "key"]);
  const first = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(first.completed, false);
  assert.equal(first.stoppedAt, 1);
  assert.equal(first.needsAgent.reason, "typed_text_redacted");
  const resumed = await executeReplay(actor, plan, { stepDelayMs: 0, startIndex: 2 });
  assert.equal(resumed.completed, false);
  assert.equal(resumed.rangeCompleted, true);
  assert.equal(resumed.overallStatus, "partial");
  assert.equal(resumed.results[0].kind, "key");
});

test("executeReplay stops on failure by default and enforces focus", async () => {
  const actor = mockActor({
    windowFocus: async () => ({ focused: false, foreground: { processName: "wrong.exe" } }),
  });
  const plan = planReplay([clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 1, y: 1 })]);
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(actor.calls.some(([name]) => name === "click"), false);
});

test("focus unknown or cancelled preserves structure and never tries another selector", async (t) => {
  for (const [code, status] of [
    ["ACTOR_EXITED", "unknown"],
    ["REQUEST_EXPIRED", "cancelled"],
  ]) {
    await t.test(code, async () => {
      let focusCalls = 0;
      let clickCalls = 0;
      const operationId = `actor-boot:focus-${status}`;
      const actor = mockActor({
        windowFocus: async () => {
          focusCalls += 1;
          const error = new Error(`${code}: focus outcome unresolved`);
          error.code = code;
          error.status = status;
          error.operationId = operationId;
          throw error;
        },
        click: async () => { clickCalls += 1; },
      });
      const plan = [
        ...planReplay([clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 1, y: 1 })]),
        { kind: "key", keys: "tab", processName: "Notepad.exe", windowTitle: "Untitled - Notepad" },
      ];
      const outcome = await executeReplay(actor, plan, { stepDelayMs: 0, stopOnFailure: false });
      assert.equal(focusCalls, 1);
      assert.equal(clickCalls, 0);
      assert.equal(outcome.status, status);
      assert.equal(outcome.stoppedAt, 0);
      assert.equal(outcome.results[0].method, "focus_execution_unresolved");
      assert.equal(outcome.results[0].status, status);
      assert.equal(outcome.results[0].code, code);
      assert.equal(outcome.results[0].operationId, operationId);
    });
  }
});

test("a deterministic focus selector miss may fall back to the next selector", async () => {
  const focusCalls = [];
  const actor = mockActor({
    windowFocus: async (params) => {
      focusCalls.push(params);
      if (params.title) {
        const error = new Error("FOCUS_NOT_FOUND: title did not match");
        error.code = "FOCUS_NOT_FOUND";
        error.status = "failed";
        throw error;
      }
      return { focused: true, foreground: { hwnd: 101, pid: 202, processName: "Notepad.exe", windowTitle: "Untitled - Notepad" } };
    },
  });
  const plan = planReplay([clickEvent({ ts: "2026-07-04T10:00:01.000Z", x: 1, y: 1 })]);
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.status, "succeeded");
  assert.equal(focusCalls.length, 2);
  assert.equal(Boolean(focusCalls[0].title), true);
  assert.equal(focusCalls[1].processName, "Notepad.exe");
  assert.equal(actor.calls.some(([name]) => name === "click"), true);
});

test("unmapped VK_PACKET becomes needs_agent instead of a successful skip", async () => {
  const events = Array.from({ length: 15 }, (_, index) => keyEvent({
    ts: `2026-07-04T10:00:${String(index + 1).padStart(2, "0")}.000Z`,
    vkCode: 231,
    keyName: "VK_231",
  }));
  const plan = planReplay(events);
  assert.equal(plan.length, 15);
  assert.equal(plan.every((step) => step.kind === "needs_agent"), true);

  const actor = mockActor();
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.status, "needs_agent");
  assert.equal(outcome.completed, false);
  assert.equal(outcome.needsAgentCount, 1);
  assert.equal(actor.calls.length, 0);
});

test("continuing after a failure never reports the run as completed", async () => {
  let keyCalls = 0;
  const actor = mockActor({
    key: async () => {
      keyCalls += 1;
      if (keyCalls === 1) throw new Error("injected failure");
    },
  });
  const plan = [
    { kind: "key", keys: "enter" },
    { kind: "key", keys: "tab" },
  ];
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0, stopOnFailure: false });
  assert.equal(keyCalls, 2);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.executionFinished, true);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.failedCount, 1);
  assert.equal(outcome.succeededCount, 1);
});

test("wheel direction is replayed when present and escalated when absent", async () => {
  const timestamp = "2026-07-04T10:00:01.000Z";
  const plan = planReplay([
    { type: "mouse.wheel", timestamp, input: { x: 30, y: 40, wheelDelta: -240 } },
    { type: "mouse.wheel", timestamp, input: { x: 30, y: 40 } },
  ]);
  assert.deepEqual(plan.map((step) => step.kind), ["scroll", "needs_agent"]);
  assert.equal(plan[0].direction, "down");
  assert.equal(plan[0].amount, 2);

  const actor = mockActor();
  const outcome = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(outcome.status, "needs_agent");
  assert.equal(actor.calls.some(([name]) => name === "scroll"), true);
});
