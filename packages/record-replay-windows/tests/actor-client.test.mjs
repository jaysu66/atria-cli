import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  await waitFor(() => client.operationStatus(delayedId)?.state === "succeeded");
  assert.equal(client.operationStatus(delayedId).state, "succeeded");
  const recovered = await client.request("delayed", { value: 1 }, 20, { operationId: delayedId });
  assert.equal(recovered.count, 2);

  await assert.rejects(
    client.request("click", {}, 1000, { operationId: "expired-boot:one" }),
    (error) => error.code === "BOOT_MISMATCH",
  );
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
