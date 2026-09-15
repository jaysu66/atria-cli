import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActionCoordinator } from "../mcp/action-coordinator.mjs";
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

function rendererFixture({ exitAfterEvent = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-visual-renderer-"));
  const script = path.join(dir, "renderer.mjs");
  const capturePath = path.join(dir, "capture.jsonl");
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    console.log(JSON.stringify({ type: 'renderer-ready', schemaVersion: 1, pid: process.pid, coordinateSpace: 'desktop_physical' }));
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const message = JSON.parse(line);
      fs.appendFileSync(process.argv[2], JSON.stringify(message) + '\\n');
      if (message.type === 'action/event') {
        console.log(JSON.stringify({ type: 'rendered', operationId: message.event.operationId, sequence: message.event.sequence, renderedAt: new Date().toISOString() }));
        if (${exitAfterEvent ? "true" : "false"}) process.exit(17);
      }
      if (message.command === 'shutdown') process.exit(0);
    });
  `, "utf8");
  return {
    dir,
    capturePath,
    spawn: () => spawn(process.execPath, [script, capturePath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
  };
}

test("visual off mode starts no helper and enabled mode receives sanitized events", async (t) => {
  const fixture = rendererFixture();
  let spawnCount = 0;
  const visual = new VisualController({
    mode: "off",
    spawnRenderer: () => {
      spawnCount += 1;
      return fixture.spawn();
    },
  });
  const actor = {
    actorBootId: "visual-boot",
    createOperationId: () => "visual-boot:1",
  };
  const coordinator = new ActionCoordinator(actor, {
    visual,
    lockPath: path.join(fixture.dir, "desktop.lock"),
  });
  t.after(() => {
    coordinator.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  await coordinator.run("click", { x: 20, y: 30 }, async () => ({ clicked: true }));
  assert.equal(spawnCount, 0);
  assert.equal(visual.status().renderedCount, 0);

  visual.setMode("on");
  await coordinator.run("type", { text: "fixture-private-text" }, async () => ({ typed: 20 }));
  await waitFor(() => visual.status().renderedCount >= 1);
  assert.equal(spawnCount, 1);
  assert.equal(visual.status().ready, true);
  const capture = fs.readFileSync(fixture.capturePath, "utf8");
  assert.equal(capture.includes("fixture-private-text"), false);
  assert.match(capture, /"textLength":20/);
});

test("required mode blocks the next write after renderer disconnect", async (t) => {
  const fixture = rendererFixture({ exitAfterEvent: true });
  const visual = new VisualController({ mode: "required", spawnRenderer: fixture.spawn });
  let operation = 0;
  const coordinator = new ActionCoordinator({
    actorBootId: "required-boot",
    createOperationId: () => `required-boot:${++operation}`,
  }, {
    visual,
    lockPath: path.join(fixture.dir, "desktop.lock"),
  });
  t.after(() => {
    coordinator.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

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

