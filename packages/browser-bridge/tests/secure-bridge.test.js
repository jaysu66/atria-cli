const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'mcp-server.js');
const token = 'test_token_abcdefghijklmnopqrstuvwxyz0123456789';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, method, urlPath, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(options.auth === false ? {} : { 'X-Atria-Token': token }),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let parsed = null;
        if (text) parsed = JSON.parse(text);
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer() {
  const port = 49000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath, '--standalone'], {
    cwd: root,
    env: {
      ...process.env,
      ATRIA_BROWSER_PORT: String(port),
      ATRIA_BROWSER_AUTH_TOKEN: token,
      ATRIA_BROWSER_REQUEST_TIMEOUT_MS: '80',
      ATRIA_BROWSER_MAX_OPERATIONS: '8',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await request(port, 'GET', '/health');
      if (health.status === 200) return { port, child, health: health.body, stderr: () => stderr };
    } catch (_) {}
    await wait(30);
  }
  child.kill();
  throw new Error(`server failed to start: ${stderr}`);
}

function identity(clientId, protocol = 3) {
  return `clientId=${clientId}&version=0.3.0&protocol=${protocol}&sessionId=session-${clientId}`;
}

test('local bridge authenticates, binds one compatible client, and preserves unknown outcomes', async (t) => {
  const server = await startServer();
  t.after(() => server.child.kill());
  const { port } = server;
  const health = await request(port, 'GET', '/health');
  const bootId = health.body.bootId;
  assert.equal(health.body.authentication, 'paired');

  const unauthenticated = await request(port, 'POST', '/tools/call', { name: 'tabs_context', arguments: {} }, { auth: false });
  assert.equal(unauthenticated.status, 401);
  const badOrigin = await request(port, 'POST', '/tools/call', { name: 'tabs_context', arguments: {} }, { origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  const incompatible = await request(port, 'GET', `/extension/next?${identity('client-old', 2)}`);
  assert.equal(incompatible.status, 409);
  assert.equal(incompatible.body.code, 'PROTOCOL_MISMATCH');

  const next = request(port, 'GET', `/extension/next?${identity('client-a')}`);
  await wait(20);
  const operationId = `${bootId}:late-click`;
  const call = request(port, 'POST', '/tools/call', {
    name: 'computer',
    operationId,
    sessionId: 'host-a',
    arguments: { action: 'left_click', coordinate: [10, 20] },
  });
  const envelope = await next;
  assert.equal(envelope.status, 200);
  assert.equal(envelope.body.operationId, operationId);
  assert.deepEqual(envelope.body.args.coordinate, [10, 20]);

  const first = await call;
  assert.equal(first.body.ok, false);
  assert.equal(first.body.result.status, 'unknown');
  assert.equal(first.body.result.operationId, operationId);

  const forged = await request(port, 'POST', `/extension/result?${identity('client-b')}`, {
    id: operationId,
    operationId,
    clientId: 'client-b',
    result: { content: [] },
  });
  assert.equal(forged.status, 409);

  const late = await request(port, 'POST', `/extension/result?${identity('client-a')}`, {
    id: operationId,
    operationId,
    clientId: 'client-a',
    result: { content: [{ type: 'text', text: '{"clicked":1}' }] },
  });
  assert.equal(late.status, 200);
  const queried = await request(port, 'GET', `/operations/${encodeURIComponent(operationId)}`);
  assert.equal(queried.body.operation.state, 'succeeded');

  for (let index = 0; index < 100; index += 1) {
    const reused = await request(port, 'POST', '/tools/call', {
      name: 'computer',
      operationId,
      sessionId: 'host-a',
      arguments: { action: 'left_click', coordinate: [10, 20] },
    });
    assert.equal(reused.body.ok, true);
  }
  const conflict = await request(port, 'POST', '/tools/call', {
    name: 'computer',
    operationId,
    arguments: { action: 'left_click', coordinate: [11, 20] },
  });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.result.code, 'IDEMPOTENCY_CONFLICT');

  const queuedId = `${bootId}:never-dispatched`;
  const queued = await request(port, 'POST', '/tools/call', {
    name: 'computer', operationId: queuedId, arguments: { action: 'left_click', coordinate: [30, 40] },
  });
  assert.equal(queued.body.result.status, 'cancelled');
  const detailedHealth = await request(port, 'GET', '/health');
  assert.equal(detailedHealth.body.operations.queued, 0);
  assert.equal(detailedHealth.body.clients.length, 1);

  const stale = await request(port, 'POST', '/tools/call', {
    name: 'computer', operationId: `old-boot:click`, arguments: { action: 'left_click', coordinate: [1, 1] },
  });
  assert.equal(stale.body.result.code, 'BOOT_MISMATCH');
});

