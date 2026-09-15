#!/usr/bin/env node
/**
 * Atria Browser Bridge CLI — call the local bridge over HTTP from a skill.
 *
 *   node bridge.js <tool> [inline-json | @args-file.json]
 *   node bridge.js --health
 *   node bridge.js --start
 *
 * Why this exists instead of raw curl:
 *   - decodes screenshot images to a file on disk (the model can Read a path,
 *     not a base64 blob)
 *   - writes the full raw response to a file so large / non-ASCII output
 *     survives console encoding and truncation
 *   - auto-starts the bridge server when it is not running
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = process.env.ATRIA_BROWSER_HOST || '127.0.0.1';
const PORT = Number(process.env.ATRIA_BROWSER_PORT || 47652);
const bundledHome = path.resolve(__dirname, '..', '..', '..');
const cliPackagedHome = path.join(bundledHome, 'packages', 'browser-bridge');
const compatibilityHome = path.join(os.homedir(), 'Desktop', 'atria-browser-bridge-oss');
const HOME = process.env.ATRIA_BROWSER_BRIDGE_HOME || (
  fs.existsSync(path.join(bundledHome, 'mcp-server.js'))
    ? bundledHome
    : fs.existsSync(path.join(cliPackagedHome, 'mcp-server.js')) ? cliPackagedHome : compatibilityHome
);
const SERVER = path.join(HOME, 'mcp-server.js');
const TOKEN_FILE = process.env.ATRIA_BROWSER_AUTH_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Atria', 'browser-bridge.token');
const OUT_DIR = path.join(os.tmpdir(), 'atria-bridge');
const MAX_STDOUT = 30000;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const token = process.env.ATRIA_BROWSER_AUTH_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '');
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
          ...(token ? { 'X-Atria-Token': token } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf);
            if ((res.statusCode || 500) >= 400) {
              const error = new Error(`${parsed.code || `HTTP ${res.statusCode}`}: ${parsed.error || 'bridge request failed'}`);
              error.statusCode = res.statusCode;
              error.response = parsed;
              reject(error);
              return;
            }
            resolve(parsed);
          } catch (_) {
            reject(new Error(`non-JSON response (${res.statusCode}): ${buf.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  return request('GET', '/health');
}

async function start() {
  if (!fs.existsSync(SERVER)) {
    throw new Error(
      `bridge server not found at ${SERVER}. Set ATRIA_BROWSER_BRIDGE_HOME to the repo root.`,
    );
  }
  spawn(process.execPath, [SERVER, '--standalone'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      return await health();
    } catch (_) {
      /* keep waiting */
    }
  }
  throw new Error('bridge server did not come up within 5s');
}

async function pairedHealth() {
  try {
    const current = await health();
    if (current.authentication === 'paired') return current;
    throw new Error('browser bridge is running but this client does not have its pairing token');
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return start();
    throw error;
  }
}

async function pairingToken() {
  if (process.env.ATRIA_BROWSER_AUTH_TOKEN) return process.env.ATRIA_BROWSER_AUTH_TOKEN;
  if (!fs.existsSync(TOKEN_FILE)) await start();
  if (!fs.existsSync(TOKEN_FILE)) throw new Error(`pairing token was not created at ${TOKEN_FILE}`);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error(`invalid pairing token file: ${TOKEN_FILE}`);
  return token;
}

function parseArgs(raw) {
  if (!raw) return {};
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    // "Bad escaped character in JSON at position 286" is useless on its own.
    // Show the offending stretch, and name the usual cause: a regex escape like
    // \s or \d written straight into a JSON string, where it has to be \\s.
    const at = Number((error.message.match(/position (\d+)/) || [])[1]);
    if (!Number.isFinite(at)) throw error;
    const snippet = text.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, '\\n');
    const caret = ' '.repeat(Math.min(at, 40)) + '^';
    const stray = /\\[^"\\/bfnrtu]/.exec(text.slice(Math.max(0, at - 2), at + 2));
    throw new Error(
      `${error.message}\n  ...${snippet}...\n     ${caret}` +
        (stray ? `\n  Looks like a lone backslash escape (${stray[0]}). Inside a JSON string a regex escape must be doubled: \\\\s, \\\\d.` : '')
    );
  }
}

function extractPdf(text) {
  if (typeof text !== 'string' || !text.includes('pdfBase64')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.pdfBase64 === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Pull image and PDF payloads out to disk; keep everything else as-is. */
function materialize(result, stamp) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const parts = [];
  content.forEach((block, i) => {
    if (block.type === 'image' && block.data) {
      const ext = (block.mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const file = path.join(OUT_DIR, `shot-${stamp}-${i}.${ext}`);
      fs.writeFileSync(file, Buffer.from(block.data, 'base64'));
      parts.push(`[image saved] ${file}`);
    } else if (block.type === 'text') {
      // save_as_pdf hands back base64 inside a JSON text block; same reasoning as
      // images — write it out and report the path instead of flooding the caller.
      const pdf = extractPdf(block.text);
      if (pdf) {
        const file = path.join(OUT_DIR, `page-${stamp}-${i}.pdf`);
        fs.writeFileSync(file, Buffer.from(pdf.pdfBase64, 'base64'));
        parts.push(`[pdf saved] ${file}${pdf.pageTitle ? ` (${pdf.pageTitle})` : ''}`);
      } else {
        parts.push(block.text);
      }
    } else {
      parts.push(JSON.stringify(block));
    }
  });
  return parts.join('\n');
}

async function main() {
  const [first, rawArgs] = process.argv.slice(2);
  if (!first) throw new Error('usage: node bridge.js <tool> [inline-json | @file.json]');

  if (first === '--health') {
    console.log(JSON.stringify(await health()));
    return;
  }
  if (first === '--start') {
    console.log(JSON.stringify(await start()));
    return;
  }
  if (first === '--pair') {
    process.stdout.write(`${await pairingToken()}\n`);
    process.stderr.write('Paste this local token into the Atria Browser Bridge extension popup. Do not share it.\n');
    return;
  }
  if (first === '--status') {
    const operationId = process.argv[3];
    if (!operationId) throw new Error('usage: node bridge.js --status <operationId>');
    console.log(JSON.stringify(await request('GET', `/operations/${encodeURIComponent(operationId)}`), null, 2));
    return;
  }

  const bridge = await pairedHealth();
  const sessionId = `cli:${process.pid}`;

  // `--js <file.js> [tabId]` sidesteps JSON escaping entirely: the script is read
  // as a file and the request is built here, so regex escapes like \s never have
  // to survive a hand-written JSON string.
  if (first === '--js') {
    const [, file, tabId] = process.argv.slice(2);
    if (!file) throw new Error('usage: node bridge.js --js <file.js> [tabId]');
    const code = fs.readFileSync(file, 'utf8');
    const jsBody = {
      name: 'javascript_tool',
      operationId: `${bridge.bootId}:${crypto.randomUUID()}`,
      sessionId,
      arguments: { text: code, ...(tabId ? { tabId: Number(tabId) } : {}) },
    };
    const jsResponse = await request('POST', '/tools/call', jsBody);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    process.stdout.write(`${materialize(jsResponse.result, `${process.pid}-js`)}\n`);
    return;
  }

  const parsedArgs = parseArgs(rawArgs);
  const body = {
    name: first,
    operationId: parsedArgs.operationId || `${bridge.bootId}:${crypto.randomUUID()}`,
    sessionId: parsedArgs.sessionId || sessionId,
    arguments: parsedArgs,
  };
  let response;
  try {
    response = await request('POST', '/tools/call', body);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      await start();
      response = await request('POST', '/tools/call', body);
    } else if (error.code === 'ECONNRESET') {
      // The request may have reached the bridge. Reuse the exact operationId;
      // the server either joins the in-flight call or returns its retained result.
      response = await request('POST', '/tools/call', body);
    } else {
      throw error;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const rawFile = path.join(OUT_DIR, `resp-${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(response, null, 2), 'utf8');

  // stdout carries the tool result and nothing else, so a caller can pipe it
  // straight into a JSON parser. Bridge metadata goes to stderr.
  const text = materialize(response.result, stamp);
  const truncated = text.length > MAX_STDOUT;
  process.stdout.write(`${truncated ? text.slice(0, MAX_STDOUT) : text}\n`);
  if (truncated) process.stderr.write(`[truncated] ${text.length} chars, showing ${MAX_STDOUT}\n`);
  if (response.ok === false) process.stderr.write('[isError] see raw response\n');
  process.stderr.write(`[raw] ${rawFile}\n`);
}

main().catch((error) => {
  console.error(`bridge error: ${error.message}`);
  process.exit(1);
});
