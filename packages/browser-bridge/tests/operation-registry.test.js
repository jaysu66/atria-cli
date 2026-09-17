const assert = require('node:assert/strict');
const test = require('node:test');

const { BridgeOperationError, OperationRegistry } = require('../lib/operation-registry');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('queued operations expire without dispatch', async () => {
  const registry = new OperationRegistry({ bootId: 'boot-a', maxOperations: 10 });
  const submitted = registry.submit({ operationId: 'boot-a:one', tool: 'click', args: { x: 1 }, timeoutMs: 15 });
  const result = await submitted.promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.operationId, 'boot-a:one');
  assert.equal(registry.take('client-a'), null);
  assert.equal(registry.describe('boot-a:one').state, 'cancelled');
});

test('dispatched timeout becomes queryable unknown and accepts a late owner result once', async () => {
  const registry = new OperationRegistry({ bootId: 'boot-a', maxOperations: 10 });
  const submitted = registry.submit({ operationId: 'boot-a:late', tool: 'click', args: { x: 2 }, timeoutMs: 15 });
  const envelope = registry.take('client-a');
  assert.equal(envelope.operationId, 'boot-a:late');
  const first = await submitted.promise;
  assert.equal(first.status, 'unknown');

  const lateResult = { content: [{ type: 'text', text: '{"clicked":1}' }] };
  registry.complete({ operationId: 'boot-a:late', clientId: 'client-a', result: lateResult });
  assert.equal(registry.describe('boot-a:late').state, 'succeeded');

  const reused = registry.submit({ operationId: 'boot-a:late', tool: 'click', args: { x: 2 }, timeoutMs: 15 });
  assert.equal(reused.reused, true);
  assert.deepEqual(await reused.promise, lateResult);
  assert.equal(registry.take('client-a'), null);
});

test('same operation id joins 100 callers but rejects changed arguments', async () => {
  const registry = new OperationRegistry({ bootId: 'boot-a', maxOperations: 10 });
  const calls = Array.from({ length: 100 }, () =>
    registry.submit({ operationId: 'boot-a:same', tool: 'click', args: { x: 3 }, timeoutMs: 1000 }),
  );
  assert.equal(registry.snapshot().retained, 1);
  assert.equal(registry.snapshot().queued, 1);
  assert.equal(registry.take('client-a').operationId, 'boot-a:same');
  registry.complete({ operationId: 'boot-a:same', clientId: 'client-a', result: { content: [] } });
  await Promise.all(calls.map((call) => call.promise));

  assert.throws(
    () => registry.submit({ operationId: 'boot-a:same', tool: 'click', args: { x: 4 }, timeoutMs: 1000 }),
    (error) => error instanceof BridgeOperationError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('owner, boot and bounded-capacity rules are enforced', async () => {
  const registry = new OperationRegistry({ bootId: 'boot-a', maxOperations: 1 });
  const submitted = registry.submit({ operationId: 'boot-a:one', tool: 'click', args: {}, timeoutMs: 1000 });
  registry.take('client-a');
  assert.throws(
    () => registry.complete({ operationId: 'boot-a:one', clientId: 'client-b', result: { content: [] } }),
    (error) => error.code === 'RESULT_OWNER_MISMATCH',
  );
  assert.throws(
    () => registry.submit({ operationId: 'boot-a:two', tool: 'click', args: {}, timeoutMs: 1000 }),
    (error) => error.code === 'CAPACITY_REACHED',
  );
  assert.throws(
    () => registry.submit({ operationId: 'old-boot:one', tool: 'click', args: {}, timeoutMs: 1000 }),
    (error) => error.code === 'BOOT_MISMATCH',
  );
  registry.complete({ operationId: 'boot-a:one', clientId: 'client-a', result: { content: [] } });
  await submitted.promise;
  await wait(1);
});

