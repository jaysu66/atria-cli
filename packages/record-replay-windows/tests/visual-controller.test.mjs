import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ActionCoordinator } from "../mcp/action-coordinator.mjs";
import { startVisualBroker } from "../mcp/visual-broker.mjs";
import { VisualController } from "../mcp/visual-controller.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(20);
  }
  throw new Error("Timed out waiting for visual fixture state.");
}

function rendererFixture({
  exitAfterEvent = false,
  hotkeys = { pause: true, stop: true },
  notReadySpawns = 0,
  failBeforeReadySpawns = 0,
  shutdownDelayMs = 0,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-visual-renderer-"));
  const script = path.join(dir, "renderer.mjs");
  const capturePath = path.join(dir, "capture.jsonl");
  let spawnCount = 0;
  let activeCount = 0;
  let maxActiveCount = 0;
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    if (process.argv[3] === 'fail-before-ready') {
      setTimeout(() => process.exit(23), 50);
    } else if (process.argv[3] !== 'never-ready') {
      console.log(JSON.stringify({
        type: 'renderer-ready', schemaVersion: 1, pid: process.pid,
        coordinateSpace: 'desktop_physical',
        hotkeys: ${JSON.stringify(hotkeys)},
        tray: { available: true, pause: true, stop: true },
      }));
    }
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const message = JSON.parse(line);
      fs.appendFileSync(process.argv[2], JSON.stringify(message) + '\\n');
      if (message.type === 'action/event') {
        console.log(JSON.stringify({ type: 'rendered', sessionId: message.event.sessionId, operationId: message.event.operationId, sequence: message.event.sequence, renderedAt: new Date().toISOString() }));
        if (${exitAfterEvent ? "true" : "false"}) process.exit(17);
      }
      if (message.command === 'emit-control') {
        console.log(JSON.stringify({ type: 'control', command: message.control || 'stop' }));
      }
      if (message.command === 'shutdown') setTimeout(() => process.exit(0), ${shutdownDelayMs});
    });
  `, "utf8");
  return {
    dir,
    script,
    capturePath,
    get spawnCount() { return spawnCount; },
    get activeCount() { return activeCount; },
    get maxActiveCount() { return maxActiveCount; },
    spawn: () => {
      spawnCount += 1;
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      const readiness = spawnCount <= failBeforeReadySpawns
        ? "fail-before-ready"
        : spawnCount <= failBeforeReadySpawns + notReadySpawns ? "never-ready" : "ready";
      const proc = spawn(process.execPath, [script, capturePath, readiness], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      proc.once("exit", () => { activeCount -= 1; });
      return proc;
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function outOfOrderCloseFixture({
  firstFailure = "error",
  closeDelayMs = 0,
  lateExitDelayMs = 100,
  secondReadyDelayMs = 250,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-visual-out-of-order-"));
  const script = path.join(dir, "fake-renderer.exe");
  fs.writeFileSync(script, "fixture", "utf8");
  const processes = [];
  let spawnCount = 0;
  let activeCount = 0;
  let maxActiveCount = 0;
  let oldExitEmitted = false;

  function spawnFake() {
    spawnCount += 1;
    const generation = spawnCount;
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.exitCode = null;
    let closed = false;
    let exited = false;
    const markInactive = () => {
      if (!closed) activeCount -= 1;
      closed = true;
      proc.stdout.end();
      proc.stderr.end();
    };
    const emitExit = (code = 0) => {
      if (exited) return;
      exited = true;
      proc.exitCode = code;
      proc.emit("exit", code, null);
    };
    const emitClose = (code = 0) => {
      if (closed) return;
      markInactive();
      proc.emit("close", code, null);
    };
    proc.kill = () => {
      proc.killed = true;
      emitExit(137);
      emitClose(137);
      return true;
    };
    proc.forceClose = () => {
      emitExit(0);
      emitClose(0);
    };
    proc.stdin.on("data", (chunk) => {
      if (!chunk.toString("utf8").includes('"command":"shutdown"')) return;
      if (generation === 1) {
        setTimeout(() => {
          emitClose(1);
          setTimeout(() => {
            oldExitEmitted = true;
            emitExit(1);
          }, lateExitDelayMs);
        }, closeDelayMs);
      } else {
        emitExit(0);
        emitClose(0);
      }
    });
    processes.push(proc);
    if (generation === 1) {
      if (firstFailure === "error") {
        setTimeout(() => proc.emit("error", Object.assign(new Error("fixture startup error"), { code: "EIO" })), 20);
      }
      // A timeout fixture deliberately emits neither ready nor an error.
    } else {
      const delay = generation === 2 ? secondReadyDelayMs : 0;
      setTimeout(() => {
        if (closed) return;
        proc.stdout.write(`${JSON.stringify({
          type: "renderer-ready",
          schemaVersion: 1,
          pid: `fake-${generation}`,
          hotkeys: { pause: true, stop: true },
          tray: { available: true, pause: true, stop: true },
        })}\n`);
      }, delay);
    }
    return proc;
  }

  return {
    dir,
    script,
    capturePath: path.join(dir, "unused.jsonl"),
    spawn: spawnFake,
    get spawnCount() { return spawnCount; },
    get activeCount() { return activeCount; },
    get maxActiveCount() { return maxActiveCount; },
    get oldExitEmitted() { return oldExitEmitted; },
    cleanup() {
      for (const proc of processes) proc.forceClose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function uniquePipe(dir) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\atria-visual-test-${process.pid}-${randomUUID()}`
    : path.join(dir, `visual-${randomUUID()}.sock`);
}

async function visualHarness(t, fixture = rendererFixture(), brokerOptions = {}) {
  const token = randomUUID().replaceAll("-", "").padEnd(64, "0");
  const pipePath = uniquePipe(fixture.dir);
  const broker = await startVisualBroker({
    pipePath,
    token,
    spawnRenderer: fixture.spawn,
    readyTimeoutMs: 10_000,
    idleExitMs: -1,
    ...brokerOptions,
  });
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.close();
    await broker.close();
    fixture.cleanup();
  });
  return {
    fixture,
    broker,
    controller(options = {}) {
      const controller = new VisualController({
        mode: "on",
        overlayPath: fixture.script,
        brokerPipePath: pipePath,
        brokerToken: token,
        launchBroker: false,
        readyTimeoutMs: 10_000,
        reconnectDelayMs: 20,
        ...options,
      });
      controllers.push(controller);
      return controller;
    },
  };
}

test("spawnRenderer compatibility starts an embedded broker without bypassing singleton IPC", async (t) => {
  const fixture = rendererFixture();
  const visual = new VisualController({
    mode: "on",
    overlayPath: fixture.script,
    brokerPipePath: uniquePipe(fixture.dir),
    brokerToken: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    spawnRenderer: fixture.spawn,
    readyTimeoutMs: 10_000,
    reconnectDelayMs: 20,
  });
  t.after(async () => {
    await visual.dispose();
    fixture.cleanup();
  });

  const state = await visual.beforeAction();
  assert.equal(state.ready, true);
  assert.equal(visual.status().brokerConnected, true);
  assert.equal(fixture.spawnCount, 1);
});

test("off mode starts nothing and two MCP controllers share one renderer", async (t) => {
  const harness = await visualHarness(t);
  const first = harness.controller({ mode: "off" });
  const second = harness.controller();
  const actor = { actorBootId: "visual-boot", createOperationId: () => "visual-boot:1" };
  const coordinator = new ActionCoordinator(actor, {
    visual: first,
    lockPath: path.join(harness.fixture.dir, "desktop.lock"),
  });
  t.after(() => coordinator.close());

  await coordinator.run("click", { x: 20, y: 30 }, async () => ({ clicked: true }));
  assert.equal(harness.fixture.spawnCount, 0);

  first.setMode("on");
  await Promise.all([first.beforeAction(), second.beforeAction()]);
  assert.equal(harness.fixture.spawnCount, 1);
  assert.equal(first.status().brokerPid, second.status().brokerPid);
  await coordinator.run("type", { text: "fixture-private-text" }, async () => ({ typed: 20 }));
  await waitFor(() => first.status().renderedCount >= 1);
  const capture = fs.readFileSync(harness.fixture.capturePath, "utf8");
  assert.equal(capture.includes("fixture-private-text"), false);
  assert.match(capture, /"textLength":20/);
});

test("client reconnect keeps the singleton and renderer controls follow the current owner", async (t) => {
  const harness = await visualHarness(t);
  const first = harness.controller({ clientId: "first-client" });
  const second = harness.controller({ clientId: "second-client" });
  const firstControls = [];
  const secondControls = [];
  first.setControlHandler((command) => firstControls.push(command));
  second.setControlHandler((command) => secondControls.push(command));
  await Promise.all([first.beforeAction(), second.beforeAction()]);

  first.handleEvent({ schemaVersion: 1, operationId: "first-op", sequence: 1, action: "move" });
  await waitFor(() => harness.broker.ownerClientId === "first-client");
  harness.broker.writeRenderer({ type: "command", command: "emit-control", control: "stop" });
  await waitFor(() => firstControls.length === 1);
  assert.deepEqual(firstControls, ["stop"]);
  assert.deepEqual(secondControls, []);

  harness.broker.disconnectClient("first-client");
  await waitFor(() => harness.broker.clientCount === 2 && first.status().ready);
  assert.equal(harness.fixture.spawnCount, 1);

  second.handleEvent({ schemaVersion: 1, operationId: "second-op", sequence: 1, action: "move" });
  await waitFor(() => harness.broker.ownerClientId === "second-client");
  harness.broker.writeRenderer({ type: "command", command: "emit-control", control: "toggle_pause" });
  await waitFor(() => secondControls.length === 1);
  assert.deepEqual(secondControls, ["toggle_pause"]);
  assert.deepEqual(firstControls, ["stop"]);
});

test("last controller disconnect releases the renderer", async (t) => {
  const harness = await visualHarness(t);
  const first = harness.controller();
  const second = harness.controller();
  await Promise.all([first.beforeAction(), second.beforeAction()]);
  assert.equal(harness.fixture.spawnCount, 1);

  first.close();
  await waitFor(() => harness.broker.clientCount === 1);
  assert.ok(harness.broker.rendererProcess);
  second.close();
  await waitFor(() => harness.broker.clientCount === 0);
  await waitFor(() => fs.existsSync(harness.fixture.capturePath)
    && fs.readFileSync(harness.fixture.capturePath, "utf8").includes('"command":"shutdown"'));
  assert.equal(harness.broker.rendererProcess, null);
});

test("last-client fast reconnect waits for renderer shutdown before replacement", async (t) => {
  const harness = await visualHarness(t);
  const visual = harness.controller({ clientId: "fast-reconnect" });
  await visual.beforeAction();
  assert.equal(harness.fixture.spawnCount, 1);

  harness.broker.disconnectClient("fast-reconnect");
  await waitFor(() => harness.fixture.spawnCount === 2 && visual.status().ready);
  assert.equal(harness.fixture.maxActiveCount, 1);
});

test("renderer ready timeout waits for failed child exit before immediate retry", async (t) => {
  const fixture = outOfOrderCloseFixture({
    firstFailure: "timeout",
    closeDelayMs: 150,
    lateExitDelayMs: 0,
    secondReadyDelayMs: 0,
  });
  const harness = await visualHarness(t, fixture, { readyTimeoutMs: 50 });
  const first = harness.controller({ clientId: "timeout-client" });
  const failedState = await first.beforeAction();
  assert.equal(failedState.ready, false);
  assert.equal(first.status().error?.code, "VISUAL_READY_TIMEOUT");
  first.close();

  const retry = harness.controller({ clientId: "retry-client" });
  const retryState = await retry.beforeAction();
  assert.equal(retryState.ready, true);
  assert.equal(fixture.spawnCount, 2);
  assert.equal(fixture.maxActiveCount, 1);
});

test("renderer startup exit permits immediate retry without renderer overlap", async (t) => {
  const fixture = rendererFixture({ failBeforeReadySpawns: 1 });
  const harness = await visualHarness(t, fixture, { readyTimeoutMs: 10_000 });
  const first = harness.controller({ clientId: "failed-start-client" });
  const failedState = await first.beforeAction();
  assert.equal(failedState.ready, false);
  assert.equal(first.status().error?.code, "VISUAL_START_FAILED");
  first.close();

  const retry = harness.controller({ clientId: "failed-start-retry" });
  const retryState = await retry.beforeAction();
  assert.equal(retryState.ready, true);
  assert.equal(fixture.spawnCount, 2);
  assert.equal(fixture.maxActiveCount, 1);
});

test("late exit from a closed old renderer cannot clear the new start generation", async (t) => {
  const fixture = outOfOrderCloseFixture();
  const harness = await visualHarness(t, fixture, { readyTimeoutMs: 500 });
  const first = harness.controller({ clientId: "out-of-order-first" });
  const failedState = await first.beforeAction();
  assert.equal(failedState.ready, false);
  assert.equal(first.status().error?.code, "VISUAL_START_FAILED");
  first.close();

  const second = harness.controller({ clientId: "out-of-order-second" });
  const secondReady = second.beforeAction();
  await waitFor(() => fixture.spawnCount === 2);
  await waitFor(() => fixture.oldExitEmitted);

  const third = harness.controller({ clientId: "out-of-order-third" });
  const [secondState, thirdState] = await Promise.all([secondReady, third.beforeAction()]);
  assert.equal(secondState.ready, true);
  assert.equal(thirdState.ready, true);
  assert.equal(fixture.spawnCount, 2);
  assert.equal(fixture.maxActiveCount, 1);
});

test("required mode blocks the next write after shared renderer disconnect", async (t) => {
  const harness = await visualHarness(t, rendererFixture({ exitAfterEvent: true }));
  const visual = harness.controller({ mode: "required" });
  let operation = 0;
  const coordinator = new ActionCoordinator({
    actorBootId: "required-boot",
    createOperationId: () => `required-boot:${++operation}`,
  }, {
    visual,
    lockPath: path.join(harness.fixture.dir, "desktop.lock"),
  });
  t.after(() => coordinator.close());

  await coordinator.run("click", { x: 1, y: 2 }, async () => ({ clicked: true }));
  await waitFor(() => visual.status().error?.code === "VISUAL_DISCONNECTED");
  let invoked = false;
  await assert.rejects(
    coordinator.run("click", { x: 3, y: 4 }, async () => {
      invoked = true;
      return { clicked: true };
    }),
    (error) => error.code === "VISUAL_DISCONNECTED",
  );
  assert.equal(invoked, false);
});

test("hotkey registration failure is visible degradation and fails required readiness", async (t) => {
  const harness = await visualHarness(t, rendererFixture({ hotkeys: { pause: false, stop: true } }));
  const ordinary = harness.controller({ mode: "on" });
  const state = await ordinary.beforeAction();
  assert.equal(state.ready, false);
  assert.equal(state.usable, true);
  assert.equal(ordinary.status().degraded, true);
  assert.ok(ordinary.status().issues.includes("PAUSE_HOTKEY_UNAVAILABLE"));

  const required = harness.controller({ mode: "required" });
  await assert.rejects(required.beforeAction(), (error) => error.code === "VISUAL_CONTROL_DEGRADED");
  assert.equal(required.status().error?.code, "VISUAL_CONTROL_DEGRADED");
  assert.equal(required.status().brokerConnected, true);
});
