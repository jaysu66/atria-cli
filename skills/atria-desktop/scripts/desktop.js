#!/usr/bin/env node
/**
 * Atria Desktop CLI - call the record-replay-windows MCP suite from any agent harness.
 *
 *   node desktop.js <tool> [@args-file.json]
 *   node desktop.js --health | --start | --stop | --tools
 *
 * Why a daemon instead of spawning the MCP server per call:
 *   Recording is stateful. event_stream_start arms recorder.exe and the session
 *   only survives while the MCP server process lives (server.mjs calls
 *   closeRecorder() on exit). A one-shot spawn per call would stop the recording
 *   the moment the call returns. So the first call starts a detached daemon that
 *   owns the MCP child over stdio and exposes it on 127.0.0.1:47653 -
 *   deliberately mirroring the browser bridge on 47652.
 *
 * Zero dependencies: node built-ins only.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = process.env.ATRIA_DESKTOP_HOST || '127.0.0.1';
const PORT = Number(process.env.ATRIA_DESKTOP_PORT || 47653);
const OUT_DIR = process.env.ATRIA_DESKTOP_OUT || path.join(os.tmpdir(), 'atria-desktop');
const MAX_STDOUT = 30000;
const DESKTOP_BRIDGE_PROTOCOL = 2;
const TOKEN_FILE = process.env.ATRIA_DESKTOP_AUTH_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Atria', 'desktop-bridge.token');

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function readClientToken() {
  const supplied = process.env.ATRIA_DESKTOP_AUTH_TOKEN;
  if (supplied) return supplied;
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function loadOrCreateDaemonToken() {
  const supplied = process.env.ATRIA_DESKTOP_AUTH_TOKEN;
  if (supplied !== undefined) {
    if (!validToken(supplied)) throw new Error('ATRIA_DESKTOP_AUTH_TOKEN must be at least 32 base64url characters.');
    return supplied;
  }
  const existing = readClientToken();
  if (existing) {
    if (!validToken(existing)) throw new Error('Invalid desktop bridge token file: ' + TOKEN_FILE);
    return existing;
  }
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return token;
}

function tokenMatches(expected, received) {
  if (!validToken(received)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(function (key) { return [key, stableValue(value[key])]; }));
  }
  return value;
}

function callFingerprint(tool, args) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({ tool: tool, args: args || {} }))).digest('hex');
}

function toolOutcome(result) {
  let payload = result && result.structuredContent;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    for (const item of (result && result.content) || []) {
      if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed;
          break;
        }
      } catch (_) {}
    }
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  const allowed = new Set(['succeeded', 'failed', 'partial', 'unknown', 'cancelled', 'needs_agent']);
  const status = allowed.has(payload.status) ? payload.status
    : allowed.has(payload.overallStatus) ? payload.overallStatus
      : result && result.isError ? 'failed' : 'succeeded';
  const last = Array.isArray(payload.results) ? payload.results[payload.results.length - 1] : null;
  return {
    status: status,
    code: payload.code || (last && last.code) || null,
    payload: payload,
  };
}

/** Locate the record-replay-windows suite. Override with ATRIA_DESKTOP_SUITE_DIR. */
function resolveSuiteDir() {
  const bundled = path.resolve(__dirname, '..', '..', '..', 'packages', 'record-replay-windows');
  const candidates = [
    process.env.ATRIA_DESKTOP_SUITE_DIR,
    process.env.AGENT_WORKBENCH_DESKTOP_AUTOMATION_DIR,
    bundled,
    path.join(os.homedir(), 'Desktop', 'codex-record-replay-computer-use-suite', 'plugins', 'record-replay-windows'),
    path.join(os.homedir(), 'codex-personal-marketplace', 'plugins', 'record-replay-windows'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'mcp', 'server.mjs'))) return dir;
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------- daemon ----

function runDaemon() {
  const suiteDir = resolveSuiteDir();
  if (!suiteDir) {
    console.error('FATAL: record-replay-windows suite not found. Set ATRIA_DESKTOP_SUITE_DIR.');
    process.exit(2);
  }
  const authToken = loadOrCreateDaemonToken();
  const bootId = crypto.randomUUID();
  const maxOperations = Number(process.env.ATRIA_DESKTOP_MAX_OPERATIONS || 256);
  const operations = new Map();

  const child = spawn(process.execPath, [path.join('mcp', 'server.mjs')], {
    cwd: suiteDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CODEX_SKILLS_ROOT: process.env.CODEX_SKILLS_ROOT || '' }),
    windowsHide: true,
  });

  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  let ready = false;
  let toolList = [];

  child.stdout.on('data', function (chunk) {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        clearTimeout(entry.retentionTimer);
        if (entry.timedOut) {
          try { entry.onLate(msg); } catch (_) {}
        } else {
          entry.resolve(msg);
        }
      }
    }
  });

  child.stderr.on('data', function (d) { process.stderr.write('[mcp] ' + d); });

  child.on('exit', function (code) {
    console.error('[daemon] MCP server exited: ' + code);
    process.exit(1);
  });

  function rpc(method, params, timeoutMs, options) {
    timeoutMs = timeoutMs || Number(process.env.ATRIA_DESKTOP_REQUEST_TIMEOUT_MS || 180000);
    options = options || {};
    return new Promise(function (resolve, reject) {
      const id = nextId++;
      const entry = {
        resolve: resolve,
        timer: null,
        retentionTimer: null,
        timedOut: false,
        onLate: typeof options.onLate === 'function' ? options.onLate : function () {},
      };
      const timer = setTimeout(function () {
        if (options.retainLateResult) {
          entry.timedOut = true;
          const retentionMs = Math.max(1000, Number(process.env.ATRIA_DESKTOP_LATE_RESULT_TTL_MS || 600000));
          entry.retentionTimer = setTimeout(function () { pending.delete(id); }, retentionMs);
          entry.retentionTimer.unref?.();
        } else {
          pending.delete(id);
        }
        reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      entry.timer = timer;
      pending.set(id, entry);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n');
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params }) + '\n');
  }

  async function initialize() {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'atria-desktop-cli', version: '1.0.0' },
    }, 30000);
    notify('notifications/initialized', {});
    const listed = await rpc('tools/list', {}, 30000);
    toolList = (listed.result && listed.result.tools) || [];
    ready = true;
    console.error('[daemon] ready, ' + toolList.length + ' tools');
  }

  function operationSummary(operation) {
    return {
      operationId: operation.id,
      bootId: bootId,
      tool: operation.tool,
      state: operation.state,
      createdAt: operation.createdAt,
      timedOutAt: operation.timedOutAt || null,
      settledAt: operation.settledAt || null,
      result: operation.result || null,
      error: operation.error || null,
    };
  }

  function runOperation(parsed) {
    const operationId = parsed.operationId || (bootId + ':' + crypto.randomUUID());
    if (typeof operationId !== 'string' || operationId.indexOf(bootId + ':') !== 0) {
      const error = new Error('operationId belongs to an expired desktop bridge boot; it will not be re-executed');
      error.code = 'BOOT_MISMATCH';
      throw error;
    }
    const fingerprint = callFingerprint(parsed.tool, parsed.args || {});
    const existing = operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error('the same operationId was reused with different arguments');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      if (existing.promise) return existing.promise;
      if (existing.result) return Promise.resolve(existing.result);
      const error = new Error('operation outcome is unknown; query it before deciding whether to retry');
      error.code = 'EXECUTION_UNKNOWN';
      error.operationId = operationId;
      throw error;
    }
    if (operations.size >= maxOperations) {
      const error = new Error('desktop operation capacity reached for this boot; refusing new work to preserve idempotency');
      error.code = 'CAPACITY_REACHED';
      throw error;
    }
    const operation = {
      id: operationId,
      tool: parsed.tool,
      fingerprint: fingerprint,
      state: 'dispatched',
      createdAt: new Date().toISOString(),
      timedOutAt: null,
      settledAt: null,
      result: null,
      error: null,
      promise: null,
    };
    operations.set(operationId, operation);
    function settleOperation(out) {
      operation.settledAt = new Date().toISOString();
      if (out.error) {
        operation.state = 'failed';
        operation.error = out.error.message || String(out.error);
        operation.result = { ok: false, operationId: operationId, status: 'failed', error: operation.error, raw: out };
      } else {
        const outcome = toolOutcome(out.result);
        operation.state = outcome.status;
        operation.error = out.result && out.result.isError
          ? (outcome.payload.error || outcome.payload.message || outcome.code || outcome.status)
          : null;
        operation.result = {
          ok: outcome.status === 'succeeded',
          operationId: operationId,
          status: outcome.status,
          ...(outcome.code ? { code: outcome.code } : {}),
          result: out.result,
        };
      }
      operation.promise = null;
      return operation.result;
    }
    operation.promise = rpc(
      'tools/call',
      { name: parsed.tool, arguments: parsed.args || {} },
      undefined,
      { retainLateResult: true, onLate: settleOperation }
    )
      .then(settleOperation)
      .catch(function (error) {
        if (operation.state === 'succeeded' || operation.state === 'failed') return operation.result;
        operation.state = 'unknown';
        operation.error = error.message;
        operation.timedOutAt = new Date().toISOString();
        operation.promise = null;
        operation.result = { ok: false, operationId: operationId, status: 'unknown', code: 'EXECUTION_UNKNOWN', error: error.message };
        return operation.result;
      });
    return operation.promise;
  }

  const server = http.createServer(function (req, res) {
    function send(code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    }
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return send(403, { ok: false, code: 'HOST_REJECTED', error: 'loopback Host required' });
    if (req.headers.origin) return send(403, { ok: false, code: 'ORIGIN_REJECTED', error: 'browser origins are not allowed on the desktop control bridge' });
    const authenticated = tokenMatches(authToken, req.headers['x-atria-token']);
    if (req.url === '/health') {
      return send(200, authenticated
        ? { ok: true, ready: ready, suiteDir: suiteDir, tools: toolList.length, pid: process.pid, bootId: bootId, protocolVersion: DESKTOP_BRIDGE_PROTOCOL, authentication: 'paired', operations: operations.size, maxOperations: maxOperations }
        : { ok: true, ready: ready, protocolVersion: DESKTOP_BRIDGE_PROTOCOL, bootId: bootId, authentication: 'required' });
    }
    if (!authenticated) return send(401, { ok: false, code: 'AUTH_REQUIRED', error: 'local desktop pairing credential required' });
    if (req.url === '/tools') {
      return send(200, {
        ok: true,
        tools: toolList.map(function (t) { return { name: t.name, description: t.description }; }),
      });
    }
    if (req.url === '/shutdown') {
      send(200, { ok: true });
      setTimeout(function () { try { child.kill(); } catch (_) {} process.exit(0); }, 50);
      return;
    }
    if (req.method === 'GET' && req.url.indexOf('/operations/') === 0) {
      const operationId = decodeURIComponent(req.url.slice('/operations/'.length));
      const operation = operations.get(operationId);
      return operation
        ? send(200, { ok: true, operation: operationSummary(operation) })
        : send(404, { ok: false, code: 'UNKNOWN_OR_EXPIRED', bootId: bootId, operationId: operationId });
    }
    if (req.method !== 'POST' || req.url !== '/call') {
      return send(404, { ok: false, error: 'not found' });
    }

    let body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', async function () {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return send(400, { ok: false, error: 'bad json' });
      }
      if (!ready) return send(503, { ok: false, error: 'daemon still initializing' });
      try {
        const out = await runOperation(parsed);
        return send(200, out);
      } catch (err) {
        return send(err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'BOOT_MISMATCH' ? 409 : 200, {
          ok: false,
          status: err.code === 'EXECUTION_UNKNOWN' ? 'unknown' : 'failed',
          code: err.code || 'CALL_FAILED',
          operationId: err.operationId || parsed.operationId || null,
          error: err.message,
        });
      }
    });
  });

  server.listen(PORT, HOST, async function () {
    console.error('[daemon] listening on ' + HOST + ':' + PORT + '  suite=' + suiteDir);
    try {
      await initialize();
    } catch (err) {
      console.error('[daemon] initialize failed: ' + err.message);
      process.exit(3);
    }
  });

  function bye() { try { child.kill(); } catch (_) {} process.exit(0); }
  process.once('SIGINT', bye);
  process.once('SIGTERM', bye);
}

// ---------------------------------------------------------------- client ----

function request(method, urlPath, payload) {
  return new Promise(function (resolve, reject) {
    const data = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const token = readClientToken();
    const headers = Object.assign(
      {},
      data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      token ? { 'X-Atria-Token': token } : {},
    );
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method: method, headers: headers },
      function (res) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (d) { body += d; });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(body);
            if ((res.statusCode || 500) >= 400) {
              const error = new Error((parsed.code ? parsed.code + ': ' : '') + (parsed.error || 'desktop bridge request failed'));
              error.statusCode = res.statusCode;
              error.response = parsed;
              reject(error);
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error('bad response: ' + body.slice(0, 200)));
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startDaemon() {
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs) {
  timeoutMs = timeoutMs || 25000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await request('GET', '/health');
      if (h && h.ready && h.authentication !== 'required') return h;
    } catch (_) {}
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  throw new Error('daemon did not become ready in ' + timeoutMs + 'ms');
}

async function ensureDaemon() {
  try {
    const h = await request('GET', '/health');
    if (h && h.ready && h.authentication !== 'required') return h;
    if (h && h.authentication === 'required') throw new Error('desktop bridge is running but this client does not have its local token');
    return await waitForDaemon();
  } catch (error) {
    if (error.message && error.message.indexOf('does not have its local token') >= 0) throw error;
    startDaemon();
    return await waitForDaemon();
  }
}

function saveArtifacts(result, tool) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const notes = [];
  const rawPath = path.join(OUT_DIR, tool + '-' + stamp + '.json');
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');

  const blocks = (result && result.content) || [];
  const texts = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    } else if (b.type === 'image' && b.data) {
      const ext = String(b.mimeType || 'image/png').split('/')[1] || 'png';
      const imgPath = path.join(OUT_DIR, tool + '-' + stamp + '.' + ext);
      fs.writeFileSync(imgPath, Buffer.from(b.data, 'base64'));
      notes.push('[image saved] ' + imgPath);
    }
  }
  let text = texts.join('\n');
  if (text.length > MAX_STDOUT) {
    text = text.slice(0, MAX_STDOUT) + '\n... [truncated, full output in raw file]';
  }
  return { text: text, notes: notes, rawPath: rawPath };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--daemon') return runDaemon();

  if (argv[0] === '--start') {
    console.log(JSON.stringify(await ensureDaemon(), null, 2));
    return;
  }
  if (argv[0] === '--health') {
    try {
      console.log(JSON.stringify(await request('GET', '/health'), null, 2));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, running: false, error: e.message }));
    }
    return;
  }
  if (argv[0] === '--stop') {
    try {
      await request('GET', '/shutdown');
      console.log('stopped');
    } catch (e) {
      console.log('not running');
    }
    return;
  }
  if (argv[0] === '--tools') {
    await ensureDaemon();
    const t = await request('GET', '/tools');
    for (const tool of t.tools) {
      console.log(tool.name + '  --  ' + String(tool.description || '').split('\n')[0]);
    }
    return;
  }
  if (argv[0] === '--status') {
    const operationId = argv[1];
    if (!operationId) throw new Error('usage: node desktop.js --status <operationId>');
    console.log(JSON.stringify(await request('GET', '/operations/' + encodeURIComponent(operationId)), null, 2));
    return;
  }

  const tool = argv[0];
  if (!tool) {
    console.error('usage: node desktop.js <tool> [@args.json] | --health | --start | --stop | --tools');
    process.exit(1);
  }

  let args = {};
  const spec = argv[1];
  if (spec) {
    args = spec.charAt(0) === '@'
      ? JSON.parse(fs.readFileSync(spec.slice(1), 'utf8'))
      : JSON.parse(spec);
  }

  const daemon = await ensureDaemon();
  const operationId = args.operationId || (daemon.bootId ? daemon.bootId + ':' + crypto.randomUUID() : undefined);
  const out = await request('POST', '/call', { tool: tool, args: args, operationId: operationId });
  if (!out.ok) {
    console.error('ERROR: ' + out.error);
    process.exit(1);
  }
  const saved = saveArtifacts(out.result, tool);
  if (saved.text) console.log(saved.text);
  for (const n of saved.notes) console.log(n);
  console.log('[raw] ' + saved.rawPath);
}

main().catch(function (err) {
  console.error('ERROR: ' + err.message);
  process.exit(1);
});
