const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_HEADER = 'x-atria-token';

function defaultTokenPath() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'Atria', 'browser-bridge.token');
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function loadOrCreateToken(options = {}) {
  const supplied = options.token || process.env.ATRIA_BROWSER_AUTH_TOKEN;
  if (supplied !== undefined) {
    if (!validToken(supplied)) throw new Error('ATRIA_BROWSER_AUTH_TOKEN must be at least 32 base64url characters.');
    return { token: supplied, source: 'environment', path: null };
  }

  const tokenPath = options.tokenPath || process.env.ATRIA_BROWSER_AUTH_FILE || defaultTokenPath();
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!validToken(token)) throw new Error(`Invalid browser bridge token file: ${tokenPath}`);
    return { token, source: 'file', path: tokenPath };
  }

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { token, source: 'generated-file', path: tokenPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const racedToken = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!validToken(racedToken)) throw new Error(`Invalid browser bridge token file: ${tokenPath}`);
    return { token: racedToken, source: 'file', path: tokenPath };
  }
}

function tokenMatches(expected, received) {
  if (!validToken(received)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestToken(req) {
  const value = req.headers[TOKEN_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

function websocketToken(req) {
  const raw = String(req.headers['sec-websocket-protocol'] || '');
  const protocols = raw.split(',').map((value) => value.trim());
  const entry = protocols.find((value) => value.startsWith('atria-token.'));
  return entry ? entry.slice('atria-token.'.length) : '';
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(origin));
}

function allowedHost(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

module.exports = {
  TOKEN_HEADER,
  allowedHost,
  allowedOrigin,
  defaultTokenPath,
  loadOrCreateToken,
  requestToken,
  tokenMatches,
  validToken,
  websocketToken,
};
