import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { NativeActorClient } from "../mcp/actor-client.mjs";

const root = path.resolve(import.meta.dirname, "..");
const overlayPath = process.env.ATRIA_OVERLAY_PATH || path.join(root, "native", "recorder", "target", "debug", "overlay.exe");
const actorPath = process.env.ATRIA_ACTOR_PATH || path.join(root, "native", "recorder", "target", "debug", "actor.exe");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await wait(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

if (!fs.existsSync(overlayPath)) throw new Error(`overlay binary not found: ${overlayPath}`);
if (!fs.existsSync(actorPath)) throw new Error(`actor binary not found: ${actorPath}`);

const actor = new NativeActorClient({ nativePath: actorPath });
const foregroundBefore = (await actor.windowList()).foreground;
const overlay = spawn(overlayPath, ["--stdio"], {
  cwd: path.dirname(overlayPath),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const overlayExit = once(overlay, "exit");
const messages = [];
let stderr = "";
readline.createInterface({ input: overlay.stdout }).on("line", (line) => {
  try { messages.push(JSON.parse(line)); } catch (_error) {}
});
overlay.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

try {
  const ready = await waitFor(() => messages.find((message) => message.type === "renderer-ready"), "renderer-ready");
  assert.equal(ready.schemaVersion, 1);
  assert.equal(ready.coordinateSpace, "desktop_physical");
  assert.ok(ready.virtualDesktop.width > 0 && ready.virtualDesktop.height > 0);

  const base = {
    schemaVersion: 1,
    bootId: "overlay-acceptance",
    sessionId: "visual-fixture",
    coordinateSpace: "desktop_physical",
    phase: "input_dispatched",
    outcome: { status: "dispatched" },
  };
  const cursor = await actor.cursor();
  const actions = [
    ["move", { x: cursor.x, y: cursor.y }],
    ["click", { x: cursor.x, y: cursor.y, clicks: 1, button: "left" }],
    ["click", { x: cursor.x, y: cursor.y, clicks: 2, button: "left" }],
    ["drag", { fromX: cursor.x - 20, fromY: cursor.y, toX: cursor.x + 20, toY: cursor.y }],
    ["scroll", { x: cursor.x, y: cursor.y, direction: "down", amount: 3 }],
    ["type", { textLength: 19 }],
    ["key", { keys: "ctrl+s" }],
    ["invoke", { hasLocator: true, uiaAction: "invoke" }],
  ];
  const sent = [];
  for (const [index, [action, target]] of actions.entries()) {
    const event = {
      ...base,
      operationId: `overlay-op-${index}`,
      sequence: index + 1,
      action,
      target,
      timestamp: new Date().toISOString(),
    };
    sent.push(event);
    overlay.stdin.write(`${JSON.stringify({ type: "action/event", event })}\n`, "utf8");
    await wait(30);
  }
  await waitFor(() => messages.filter((message) => message.type === "rendered").length >= actions.length, "all frame acknowledgements");
  const foregroundAfter = (await actor.windowList()).foreground;
  assert.equal(foregroundAfter.hwnd, foregroundBefore.hwnd);

  overlay.stdin.write(`${JSON.stringify({ type: "command", command: "status" })}\n`, "utf8");
  await waitFor(() => messages.find((message) => message.type === "status"), "status reply");
  const rendered = messages.filter((message) => message.type === "rendered");
  assert.deepEqual(rendered.slice(-actions.length).map((message) => message.operationId), sent.map((event) => event.operationId));
  const latencies = rendered.slice(-actions.length).map((message) => (
    Date.parse(message.renderedAt) - Date.parse(message.eventTimestamp)
  )).filter(Number.isFinite).sort((a, b) => a - b);

  overlay.stdin.write(`${JSON.stringify({ type: "command", command: "shutdown" })}\n`, "utf8");
  const [exitCode] = await overlayExit;
  assert.equal(exitCode, 0);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    overlayPath,
    overlayPid: ready.pid,
    foregroundPreserved: true,
    renderedCount: rendered.length,
    maxFrameAckMs: latencies.at(-1),
    pauseHotkeyRegistered: ready.hotkeys?.pause,
    stopHotkeyRegistered: ready.hotkeys?.stop,
    stderr: stderr.trim(),
  }, null, 2)}\n`);
} finally {
  actor.close();
  if (overlay.exitCode === null) {
    try { overlay.stdin.write(`${JSON.stringify({ type: "command", command: "shutdown" })}\n`); } catch (_error) {}
    await Promise.race([overlayExit, wait(1000)]);
    if (overlay.exitCode === null) overlay.kill();
  }
}

