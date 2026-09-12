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
    ["click", "needs_agent", "key", "skip"],
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
      return { focused: true, foreground: { processName: "Notepad.exe" } };
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
  assert.equal(resumed.completed, true);
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
