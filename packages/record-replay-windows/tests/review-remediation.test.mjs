import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NativeActorClient } from '../mcp/actor-client.mjs';
import { createEventStreamServer } from '../mcp/server-core.mjs';

// Exercise tools/list + tools/call and the production actor client without
// launching a native process, renderer, browser, or sending actual OS input.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const feedback = { returnState: false, returnScreenshotPath: false };
const recorder = { start: async () => ({}), status: async () => ({}), stop: async () => ({}), close() {} };
const visualOff = { beforeAction: async () => {}, setControlHandler() {}, handleEvent() {}, status: () => ({ mode: 'off' }), close() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function memoryProcess(onRequest) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.finish = () => {
    if (proc.exitCode !== null) return;
    proc.exitCode = 0;
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('exit', 0, null);
  };
  proc.stdin = {
    write(line) {
      const message = JSON.parse(line);
      onRequest(message);
      queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: message.id, ok: true, result: { clicked: true } }) + '\n'));
      return true;
    },
    end() { queueMicrotask(proc.finish); },
  };
  return proc;
}

async function connectServer(actor, dir, visual = visualOff) {
  const server = createEventStreamServer({ actorClient: actor, recorderClient: recorder, visualController: visual, automationLockPath: path.join(dir, 'write.lock') });
  const client = new Client({ name: 'atria-regression-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server, client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() {
      server.closeRecorder();
      await client.close();
      await server.close();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

for (const mode of ['on', 'required']) {
  for (const lifecycle of ['first-start', 'renderer-reconnect', 'actor-restart']) {
    for (const control of ['pause', 'stop']) {
      test(`AR-1 ${mode}/${lifecycle}: ${control} during renderer wait prevents dispatch`, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atria-control-boundary-'));
        const visualGate = deferred();
        const enteredVisual = deferred();
        const writes = [];
        const controlPath = path.join(dir, 'control');
        const actor = new NativeActorClient({ controlPath, spawnActor: () => memoryProcess(message => writes.push({ method: message.method, state: fs.readFileSync(controlPath, 'utf8') })) });
        if (lifecycle !== 'first-start') actor.ensureStarted();
        if (lifecycle === 'actor-restart') actor.proc.finish();
        const fixture = await connectServer(actor, dir, {
          ...visualOff,
          beforeAction: async () => { enteredVisual.resolve(); await visualGate.promise; },
          status: () => ({ mode }),
        });
        let pending;
        t.after(async () => {
          await fixture.server.actionCoordinator.stop();
          visualGate.resolve();
          await pending?.catch(() => {});
          await fixture.close();
          fs.rmSync(dir, { recursive: true, force: true });
        });
        let settled = false;
        pending = fixture.call('computer_click', { x: 10, y: 20, expect: { hwnd: 101 }, ...feedback }).then(result => { settled = true; return result; });
        await enteredVisual.promise;
        const ack = (await fixture.call(`automation_${control}`)).structuredContent;
        assert.equal(ack.acknowledged, true);
        assert.equal(writes.length, 0);
        // Stop must cancel the old request even if resume arrives before the
        // renderer finishes. Pause may resume the same request exactly once.
        if (control === 'stop') await fixture.call('automation_resume');
        visualGate.resolve();
        await wait(40);
        assert.equal(writes.length, 0, 'no input request after acknowledged pause/stop');
        if (control === 'pause') {
          assert.equal(settled, false);
          assert.equal(fs.readFileSync(controlPath, 'utf8'), 'paused');
          await fixture.call('automation_resume');
          const result = await pending;
          assert.notEqual(result.isError, true);
          assert.deepEqual(writes, [{ method: 'click', state: 'running' }]);
        } else {
          assert.equal((await pending).isError, true);
          await fixture.call('computer_click', { x: 11, y: 21, expect: { hwnd: 101 }, ...feedback });
          assert.equal(writes.length, 1, 'only the explicitly new action may run after resume');
        }
      });
    }
  }
}

for (const state of ['paused', 'stopped']) {
  test(`AR-1 actor lazy startup and restart preserve ${state}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atria-actor-intent-'));
    const controlPath = path.join(dir, 'control');
    const actor = new NativeActorClient({ controlPath, spawnActor: () => memoryProcess(() => {}) });
    t.after(async () => { actor.close(); await wait(0); fs.rmSync(dir, { recursive: true, force: true }); });
    await actor[state === 'paused' ? 'pause' : 'stop']();
    actor.ensureStarted();
    assert.equal(fs.readFileSync(controlPath, 'utf8'), state);
    actor.proc.finish();
    actor.ensureStarted();
    assert.equal(fs.readFileSync(controlPath, 'utf8'), state);
  });
}

async function targetFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atria-mcp-target-'));
  const writes = [];
  const actor = {
    actorBootId: 'memory-actor', ensureStarted() {}, addEventListener: () => () => {}, close() {},
    uiSnapshot: async () => ({ window: { hwnd: 101, pid: 202, title: 'Fixture' }, elements: [
      { i: 1, type: 'Pane', name: 'First', cx: 10, cy: 20 },
      { i: 2, type: 'Pane', name: 'Second', cx: 30, cy: 40 },
    ] }),
  };
  for (const method of ['click', 'mouseMove', 'drag', 'scroll', 'typeText']) actor[method] = async params => { writes.push({ method, params }); return { status: 'succeeded' }; };
  const fixture = await connectServer(actor, dir);
  t.after(async () => { await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const oldId = (await fixture.call('ui_snapshot')).structuredContent.snapshotId;
  const currentId = (await fixture.call('ui_snapshot')).structuredContent.snapshotId;
  return { ...fixture, writes, oldId, currentId };
}

test('AR-2 MCP single and batch scroll reject invalid targets without input', async t => {
  const fixture = await targetFixture(t);
  const cases = [
    { elementIndex: 1, snapshotId: fixture.oldId },
    { elementIndex: 1 },
    { elementIndex: 999, snapshotId: fixture.currentId },
    { x: 10 },
    { y: 20 },
  ];
  for (const mode of ['single', 'batch']) {
    for (const target of cases) {
      const { snapshotId, ...step } = target;
      const result = mode === 'single'
        ? await fixture.call('computer_scroll', { ...target, ...feedback })
        : await fixture.call('computer_batch', { actions: [{ action: 'scroll', ...step }], ...(snapshotId === undefined ? {} : { snapshotId }), ...feedback });
      assert.equal(result.isError, true, `${mode}: ${JSON.stringify(target)}`);
      assert.equal(fixture.writes.length, 0);
    }
  }
});

test('AR-2 MCP valid scroll and explicit no-target scroll remain usable', async t => {
  const fixture = await targetFixture(t);
  const calls = [
    ['computer_scroll', { elementIndex: 1, snapshotId: fixture.currentId }],
    ['computer_scroll', { x: 12, y: 22 }],
    ['computer_scroll', {}],
    ['computer_batch', { actions: [{ action: 'scroll', elementIndex: 2 }], snapshotId: fixture.currentId }],
    ['computer_batch', { actions: [{ action: 'scroll' }], snapshotId: fixture.currentId }],
  ];
  for (const [name, args] of calls) assert.notEqual((await fixture.call(name, { ...args, ...feedback })).isError, true);
  assert.equal(fixture.writes.length, calls.length);
  assert.deepEqual(fixture.writes.map(w => [w.params.x ?? null, w.params.y ?? null]), [[10,20], [12,22], [null,null], [30,40], [null,null]]);
});

test('AR-3 MCP tools/list exposes snapshotId and valid drag/batch calls retain it', async t => {
  const fixture = await targetFixture(t);
  const tools = (await fixture.client.listTools()).tools;
  for (const name of ['computer_drag', 'computer_batch']) {
    assert.equal(tools.find(tool => tool.name === name).inputSchema.properties.snapshotId?.type, 'integer');
  }
  const drag = await fixture.call('computer_drag', { fromElementIndex: 1, toElementIndex: 2, snapshotId: fixture.currentId, ...feedback });
  assert.notEqual(drag.isError, true);
  const batch = await fixture.call('computer_batch', { actions: [{ action: 'click', elementIndex: 1 }, { action: 'move', elementIndex: 2 }], snapshotId: fixture.currentId, ...feedback });
  assert.equal(batch.structuredContent.completed, true);
  assert.deepEqual(fixture.writes.map(w => w.method), ['drag', 'click', 'mouseMove']);
  assert.deepEqual([fixture.writes[0].params.fromX, fixture.writes[0].params.toX], [10, 30]);
});

test('AR-3 MCP stale/missing drag and batch snapshots fail; coordinate inputs still work', async t => {
  const fixture = await targetFixture(t);
  for (const snapshotId of [fixture.oldId, undefined]) {
    const scope = snapshotId === undefined ? {} : { snapshotId };
    for (const [name, args] of [
      ['computer_drag', { fromElementIndex: 1, toElementIndex: 2 }],
      ['computer_batch', { actions: [{ action: 'click', elementIndex: 1 }] }],
    ]) assert.equal((await fixture.call(name, { ...args, ...scope, ...feedback })).isError, true);
  }
  assert.equal(fixture.writes.length, 0);
  for (const [name, args] of [
    ['computer_drag', { fromX: 10, fromY: 20, toX: 30, toY: 40 }],
    ['computer_batch', { actions: [{ action: 'click', x: 10, y: 20 }] }],
  ]) assert.notEqual((await fixture.call(name, { ...args, ...feedback })).isError, true);
  assert.equal(fixture.writes.length, 2);
});
