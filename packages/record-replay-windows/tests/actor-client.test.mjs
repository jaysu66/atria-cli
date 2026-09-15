import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { NativeActorClient } from "../mcp/actor-client.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(25);
  }
  throw new Error("Timed out waiting for fixture state.");
}

function fixtureActor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-actor-client-"));
  const script = path.join(dir, "actor.mjs");
  fs.writeFileSync(script, `
    import readline from 'node:readline';
    let count = 0;
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
      const message = JSON.parse(line);
      count += 1;
      if (message.method === 'expired') {
        console.log(JSON.stringify({ id: message.id, ok: false, error: 'REQUEST_EXPIRED: deadline elapsed' }));
        return;
      }
      if (message.method === 'exit_after_dispatch') {
        setTimeout(() => process.exit(23), 30);
        return;
      }
      if (message.method === 'delayed') await new Promise((resolve) => setTimeout(resolve, 120));
      console.log(JSON.stringify({ id: message.id, ok: true, result: { count, params: message.params } }));
    });
  `);
  return {
    dir,
    spawn: () => spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
  };
}

function fixtureControllableActor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-actor-control-"));
  const script = path.join(dir, "actor.mjs");
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
      const message = JSON.parse(line);
      console.log(JSON.stringify({ method: 'action/event', params: {
        schemaVersion: 1, bootId: message.params._atria.bootId,
        sessionId: message.params._atria.sessionId, operationId: message.id,
        sequence: 1, action: 'type', phase: 'running', target: { textLength: 200 },
        coordinateSpace: 'desktop_physical', timestamp: new Date().toISOString(), outcome: { status: 'running' }
      }}));
      let injected = 0;
      while (injected < 200) {
        const controlPath = message.params._atria.controlPath;
        let state = 'running';
        try { state = fs.readFileSync(controlPath, 'utf8').trim(); } catch {}
        if (state === 'paused') {
          fs.writeFileSync(controlPath + '.ack', JSON.stringify({ state, timestamp: new Date().toISOString() }));
          while (fs.readFileSync(controlPath, 'utf8').trim() === 'paused') await wait(10);
        }
        if (state === 'stopped') {
          fs.writeFileSync(controlPath + '.ack', JSON.stringify({ state, timestamp: new Date().toISOString() }));
          console.log(JSON.stringify({ method: 'action/event', params: {
            schemaVersion: 1, bootId: message.params._atria.bootId,
            sessionId: message.params._atria.sessionId, operationId: message.id,
            sequence: 2, action: 'type', phase: 'cancelled', target: { textLength: 200 },
            coordinateSpace: 'desktop_physical', timestamp: new Date().toISOString(), outcome: { status: 'cancelled', code: 'ACTION_STOPPED' }
          }}));
          console.log(JSON.stringify({ id: message.id, ok: false, error: 'ACTION_STOPPED: fixture stopped' }));
          return;
        }
        injected += 1;
        await wait(5);
      }
      console.log(JSON.stringify({ method: 'action/event', params: {
        schemaVersion: 1, bootId: message.params._atria.bootId,
        sessionId: message.params._atria.sessionId, operationId: message.id,
        sequence: 2, action: 'type', phase: 'input_dispatched', target: { textLength: 200 },
        coordinateSpace: 'desktop_physical', timestamp: new Date().toISOString(), outcome: { status: 'dispatched' }
      }}));
      console.log(JSON.stringify({ id: message.id, ok: true, result: { injected } }));
    });
  `);
  return {
    dir,
    spawn: () => spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
  };
}

function controlledFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdinWrites = [];
  proc.stdin = {
    write(value) {
      proc.stdinWrites.push(String(value));
      return true;
    },
    end() {},
  };
  proc.killed = false;
  proc.exitCode = null;
  proc.emitExit = (code = 0, signal = null) => {
    proc.exitCode = code;
    proc.stdout.end();
    proc.stderr.end();
    proc.emit("exit", code, signal);
  };
  proc.kill = () => {
    if (proc.exitCode === null) proc.emitExit(null, "SIGTERM");
    proc.killed = true;
    return true;
  };
  return proc;
}

test("native actor client deduplicates and retains a late result after timeout", async (t) => {
  const fixture = fixtureActor();
  const client = new NativeActorClient({ spawnActor: fixture.spawn, maxOperations: 4 });
  t.after(async () => {
    client.close();
    await wait(250);
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (_) {}
  });
  client.ensureStarted();

  const sameId = `${client.actorBootId}:same`;
  const calls = Array.from({ length: 100 }, () => client.request("click", { x: 10 }, 30000, { operationId: sameId }));
  const results = await Promise.all(calls);
  assert.equal(results[0].count, 1);
  assert.ok(results.every((result) => result.count === 1));
  assert.equal(Number.isFinite(results[0].params._atria.deadlineAtUnixMs), true);
  assert.ok(results[0].params._atria.deadlineAtUnixMs > Date.now() - 30_000);
  await assert.rejects(
    client.request("click", { x: 11 }, 1000, { operationId: sameId }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const delayedId = `${client.actorBootId}:delayed`;
  await assert.rejects(
    client.request("delayed", { value: 1 }, 20, { operationId: delayedId }),
    (error) => error.code === "EXECUTION_TIMEOUT" && error.status === "unknown",
  );
  assert.equal(client.operationStatus(delayedId).state, "unknown");
  let becameSafe = false;
  const safety = client.waitForOperationSafety(delayedId).then(() => { becameSafe = true; });
  await wait(25);
  assert.equal(becameSafe, false);
  await waitFor(() => client.operationStatus(delayedId)?.state === "succeeded");
  await safety;
  assert.equal(client.operationStatus(delayedId).safe, true);
  assert.equal(client.operationStatus(delayedId).safeReason, "native_response_received");
  assert.equal(client.operationStatus(delayedId).state, "succeeded");
  const recovered = await client.request("delayed", { value: 1 }, 20, { operationId: delayedId });
  assert.equal(recovered.count, 2);

  await assert.rejects(
    client.request("click", {}, 1000, { operationId: "expired-boot:one" }),
    (error) => error.code === "BOOT_MISMATCH",
  );

  const expiredId = `${client.actorBootId}:expired`;
  await assert.rejects(
    client.request("expired", {}, 1000, { operationId: expiredId }),
    (error) => error.code === "REQUEST_EXPIRED" && error.status === "cancelled",
  );
  assert.equal(client.operationStatus(expiredId).state, "cancelled");
});

test("actor process exit resolves operation safety while retaining unknown semantics", async (t) => {
  const fixture = fixtureActor();
  let spawnCount = 0;
  let stdinWriteCount = 0;
  const spawnActor = () => {
    spawnCount += 1;
    const proc = fixture.spawn();
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (...args) => {
      stdinWriteCount += 1;
      return originalWrite(...args);
    };
    return proc;
  };
  const client = new NativeActorClient({ spawnActor });
  t.after(async () => {
    client.close();
    await wait(100);
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (_) {}
  });
  client.ensureStarted();
  const firstBootId = client.actorBootId;
  const knownOperationId = `${firstBootId}:known`;
  const knownResult = await client.request("click", { x: 1 }, 1000, { operationId: knownOperationId });
  assert.equal(knownResult.count, 1);
  const operationId = `${client.actorBootId}:exit`;
  const request = client.request("exit_after_dispatch", {}, 1000, { operationId });
  await assert.rejects(request, (error) => error.code === "ACTOR_EXITED" && error.status === "unknown");
  const safe = await client.waitForOperationSafety(operationId);
  assert.equal(safe.reason, "actor_process_exited");
  assert.equal(client.operationStatus(operationId).state, "unknown");
  assert.equal(client.operationStatus(operationId).safe, true);

  const writesAfterExit = stdinWriteCount;
  await assert.rejects(
    client.request("exit_after_dispatch", {}, 1000, { operationId }),
    (error) => error.code === "ACTOR_EXITED" && error.status === "unknown",
  );
  assert.equal(spawnCount, 1);
  assert.equal(stdinWriteCount, writesAfterExit);
  await assert.rejects(
    client.request("exit_after_dispatch", { changed: true }, 1000, { operationId }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(spawnCount, 1);
  assert.equal(stdinWriteCount, writesAfterExit);

  const cachedKnownResult = await client.request("click", { x: 1 }, 1000, { operationId: knownOperationId });
  assert.deepEqual(cachedKnownResult, knownResult);
  assert.equal(spawnCount, 1);
  assert.equal(stdinWriteCount, writesAfterExit);

  const newOperationId = client.createOperationId();
  assert.equal(spawnCount, 2);
  assert.notEqual(client.actorBootId, firstBootId);
  assert.ok(newOperationId.startsWith(`${client.actorBootId}:`));
  assert.equal(client.operationStatus(operationId).state, "unknown");
});

test("a late exit callback from an old actor cannot clear the replacement actor pending request", async (t) => {
  const oldProc = controlledFakeProcess();
  const newProc = controlledFakeProcess();
  const spawned = [oldProc, newProc];
  let spawnIndex = 0;
  const client = new NativeActorClient({ spawnActor: () => spawned[spawnIndex++] });
  t.after(() => {
    if (oldProc.exitCode === null) oldProc.emitExit(0);
    if (newProc.exitCode === null) newProc.emitExit(0);
    client.close();
  });

  client.ensureStarted();
  const oldBootId = client.actorBootId;
  const oldOperationId = `${oldBootId}:pending`;
  const oldRequest = client.request("click", { x: 1 }, 1000, { operationId: oldOperationId });
  assert.equal(oldProc.stdinWrites.length, 1);

  // Mark the old process dead before delivering its exit event. A new request
  // can now start a replacement while the old exit callback is still queued.
  oldProc.exitCode = 23;
  client.ensureStarted();
  const newBootId = client.actorBootId;
  assert.notEqual(newBootId, oldBootId);
  assert.equal(client.proc, newProc);
  const newOperationId = `${newBootId}:pending`;
  const newRequest = client.request("click", { x: 2 }, 1000, { operationId: newOperationId });
  assert.equal(newProc.stdinWrites.length, 1);

  oldProc.emitExit(23);
  await assert.rejects(oldRequest, (error) => error.code === "ACTOR_EXITED" && error.operationId === oldOperationId);
  assert.equal(client.proc, newProc);
  assert.equal(client.operationStatus(newOperationId).state, "dispatched");
  assert.equal(client.pending.has(newOperationId), true);

  newProc.stdout.write(`${JSON.stringify({ id: newOperationId, ok: true, result: { clicked: true } })}\n`);
  assert.deepEqual(await newRequest, { clicked: true });
  assert.equal(client.operationStatus(newOperationId).state, "succeeded");
  assert.equal(client.pending.size, 0);
  newProc.emitExit(0);
});

test("native notifications do not consume the pending response and pause is acknowledged out of band", async (t) => {
  const fixture = fixtureControllableActor();
  const client = new NativeActorClient({ spawnActor: fixture.spawn });
  const events = [];
  let signalRunning;
  const runningEvent = new Promise((resolve) => { signalRunning = resolve; });
  client.addEventListener((event) => {
    events.push(event);
    if (event.phase === "running") signalRunning();
  });
  t.after(async () => {
    client.close();
    await wait(100);
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (_) {}
  });

  const running = client.request("type_text", { text: "x".repeat(200) }, 60000);
  const runningOutcome = running.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  await runningEvent;
  const paused = await client.pause();
  assert.equal(paused.acknowledged, true);
  const acknowledgementLatencyMs = Date.parse(paused.acknowledgedAt) - Date.parse(paused.requestedAt);
  assert.ok(acknowledgementLatencyMs >= 0 && acknowledgementLatencyMs < 500);
  const eventCountAtAck = events.length;
  await wait(80);
  assert.equal(events.length, eventCountAtAck);
  const stopped = await client.stop();
  assert.equal(stopped.acknowledged, true);
  const outcome = await runningOutcome;
  assert.equal(outcome.error?.code, "ACTION_STOPPED");
  assert.equal(outcome.error?.status, "cancelled");
  assert.deepEqual(events.map((event) => event.phase), ["running", "cancelled"]);
});
