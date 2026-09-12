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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = process.env.ATRIA_DESKTOP_HOST || '127.0.0.1';
const PORT = Number(process.env.ATRIA_DESKTOP_PORT || 47653);
const OUT_DIR = process.env.ATRIA_DESKTOP_OUT || path.join(os.tmpdir(), 'atria-desktop');
const MAX_STDOUT = 30000;

/** Locate the record-replay-windows suite. Override with ATRIA_DESKTOP_SUITE_DIR. */
function resolveSuiteDir() {
  const candidates = [
    process.env.ATRIA_DESKTOP_SUITE_DIR,
    process.env.AGENT_WORKBENCH_DESKTOP_AUTOMATION_DIR,
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
        entry.resolve(msg);
      }
    }
  });

  child.stderr.on('data', function (d) { process.stderr.write('[mcp] ' + d); });

  child.on('exit', function (code) {
    console.error('[daemon] MCP server exited: ' + code);
    process.exit(1);
  });

  function rpc(method, params, timeoutMs) {
    timeoutMs = timeoutMs || 180000;
    return new Promise(function (resolve, reject) {
      const id = nextId++;
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve, timer: timer });
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

  const server = http.createServer(function (req, res) {
    function send(code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    }
    if (req.url === '/health') {
      return send(200, { ok: true, ready: ready, suiteDir: suiteDir, tools: toolList.length, pid: process.pid });
    }
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
        const out = await rpc('tools/call', { name: parsed.tool, arguments: parsed.args || {} });
        if (out.error) {
          return send(200, { ok: false, error: out.error.message || String(out.error), raw: out });
        }
        return send(200, { ok: true, result: out.result });
      } catch (err) {
        return send(200, { ok: false, error: err.message });
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
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
      : {};
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method: method, headers: headers },
      function (res) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (d) { body += d; });
        res.on('end', function () {
          try {
            resolve(JSON.parse(body));
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
      if (h && h.ready) return h;
    } catch (_) {}
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  throw new Error('daemon did not become ready in ' + timeoutMs + 'ms');
}

async function ensureDaemon() {
  try {
    const h = await request('GET', '/health');
    if (h && h.ready) return h;
    return await waitForDaemon();
  } catch (_) {
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

  await ensureDaemon();
  const out = await request('POST', '/call', { tool: tool, args: args });
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
