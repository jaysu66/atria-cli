import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActionCoordinator, AutomationBusyError } from "../mcp/action-coordinator.mjs";

function fakeActor() {
  let sequence = 0;
  return {
    actorBootId: "actor-boot",
    createOperationId() {
      sequence += 1;
      return `actor-boot:${sequence}`;
    },
    waitForOperationSafety: async (operationId) => ({ operationId, safe: true, reason: "fixture_settled" }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("action coordinator emits the complete sanitized contract", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-events-"));
  const coordinator = new ActionCoordinator(fakeActor(), {
    lockPath: path.join(dir, "desktop.lock"),
    eventLogPath: path.join(dir, "actions.jsonl"),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const secret = "fixture-secret-must-not-appear";
  const result = await coordinator.run(
    "type",
    { text: secret, clearFirst: true, expect: { titleExact: secret } },
    async () => ({ typed: secret.length }),
    { sessionId: "s1", parentOperationId: "parent-1", stepIndex: 7 },
  );
  assert.equal(result.typed, secret.length);
  const events = coordinator.recentEvents();
  assert.deepEqual(events.map((event) => event.phase), ["prepare", "running", "input_dispatched"]);
  for (const event of events) {
    for (const key of ["schemaVersion", "bootId", "sessionId", "operationId", "sequence", "action", "phase", "target", "coordinateSpace", "timestamp", "outcome"]) {
      assert.ok(Object.hasOwn(event, key), `missing ${key}`);
    }
    assert.equal(event.parentOperationId, "parent-1");
    assert.equal(event.stepIndex, 7);
    assert.equal(event.target.textLength, secret.length);
  }
  const serialized = fs.readFileSync(path.join(dir, "actions.jsonl"), "utf8");
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("titleExact"), false);
});

test("independent coordinators never interleave a live desktop write lease", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-write-lock-"));
  const lockPath = path.join(dir, "desktop.lock");
  const first = new ActionCoordinator(fakeActor(), { lockPath });
  const second = new ActionCoordinator(fakeActor(), { lockPath });
  t.after(() => {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const holding = first.withWriteSession({ operationId: "first" }, async () => {
    entered();
    await gate;
  });
  await started;
  await assert.rejects(
    second.withWriteSession({ operationId: "second" }, async () => {}),
    (error) => error instanceof AutomationBusyError && error.code === "AUTOMATION_BUSY",
  );
  release();
  await holding;
  await second.withWriteSession({ operationId: "after-release" }, async () => {});
});

test("failure, timeout, and stop map to truthful terminal phases without idle activity", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-event-outcomes-"));
  const coordinator = new ActionCoordinator(fakeActor(), { lockPath: path.join(dir, "desktop.lock") });
  t.after(() => {
    coordinator.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(coordinator.status().eventCount, 0);

  for (const [code, expectedPhase] of [
    ["FOCUS_MISMATCH", "failed"],
    ["EXECUTION_TIMEOUT", "unknown"],
    ["ACTOR_EXITED", "unknown"],
    ["ACTION_STOPPED", "cancelled"],
  ]) {
    await assert.rejects(coordinator.run("click", { x: 1, y: 2 }, async () => {
      const error = new Error(code);
      error.code = code;
      throw error;
    }));
    assert.equal(coordinator.recentEvents(1)[0].phase, expectedPhase);
    await coordinator.resume();
  }
});

test("unknown actor outcome keeps the desktop lease until late safety confirmation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-unknown-lock-"));
  const lockPath = path.join(dir, "desktop.lock");
  let resolveSafety;
  const safety = new Promise((resolve) => { resolveSafety = resolve; });
  const actor = {
    ...fakeActor(),
    waitForOperationSafety: () => safety,
  };
  const first = new ActionCoordinator(actor, { lockPath });
  const second = new ActionCoordinator(fakeActor(), { lockPath });
  t.after(() => {
    resolveSafety?.({ safe: true });
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const operationId = "actor-boot:unknown-write";
  await assert.rejects(
    first.run("click", { x: 1, y: 2 }, async () => {
      const error = new Error("ACTOR_EXITED: outcome unknown");
      error.code = "ACTOR_EXITED";
      error.status = "unknown";
      error.operationId = operationId;
      throw error;
    }, { operationId }),
    (error) => error.status === "unknown",
  );

  await assert.rejects(
    second.withWriteSession({ operationId: "contender" }, async () => {}),
    (error) => error.code === "AUTOMATION_BUSY",
  );
  resolveSafety({ safe: true });
  for (let attempt = 0; attempt < 50 && fs.existsSync(lockPath); attempt += 1) await wait(10);
  assert.equal(fs.existsSync(lockPath), false);
  await second.withWriteSession({ operationId: "after-safe" }, async () => {});
});

test("composite child operation ids are stable for a parent step", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-child-id-"));
  const coordinator = new ActionCoordinator(fakeActor(), { lockPath: path.join(dir, "desktop.lock") });
  t.after(() => {
    coordinator.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const context = { parentOperationId: "client-parent", stepIndex: 4 };
  assert.equal(coordinator.operationIdForContext(context, "click"), coordinator.operationIdForContext(context, "click"));
  assert.notEqual(
    coordinator.operationIdForContext(context, "click"),
    coordinator.operationIdForContext({ ...context, stepIndex: 5 }, "click"),
  );
  assert.notEqual(coordinator.operationIdForContext(context, "click"), coordinator.operationIdForContext(context, "window_focus"));
});

test("a separate process receives busy while another process owns the desktop lease", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-cross-process-lock-"));
  const lockPath = path.join(dir, "desktop.lock");
  const childPath = path.join(dir, "holder.mjs");
  const moduleUrl = new URL("../mcp/action-coordinator.mjs", import.meta.url).href;
  fs.writeFileSync(childPath, `
    const { ActionCoordinator } = await import(process.argv[2]);
    const actor = { actorBootId: 'child', createOperationId: () => 'child:1' };
    const coordinator = new ActionCoordinator(actor, { lockPath: process.argv[3] });
    await coordinator.withWriteSession({ operationId: 'child:hold' }, async () => {
      process.stdout.write('ready\\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    coordinator.close();
  `, "utf8");
  const child = spawn(process.execPath, [childPath, moduleUrl, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child lock holder did not become ready")), 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await ready;

  const contender = new ActionCoordinator(fakeActor(), { lockPath });
  await assert.rejects(
    contender.withWriteSession({ operationId: "parent:contender" }, async () => {}),
    (error) => error.code === "AUTOMATION_BUSY" && error.owner?.pid === child.pid,
  );
  contender.close();
  await exited;
  const after = new ActionCoordinator(fakeActor(), { lockPath });
  await after.withWriteSession({ operationId: "parent:after" }, async () => {});
  after.close();
});
