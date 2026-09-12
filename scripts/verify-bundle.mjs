import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'README.md',
  'LICENSE-STATUS.md',
  'SECURITY.md',
  'package.json',
  'bin/atria.mjs',
  'manifests/components.json',
  'packages/browser-bridge/mcp-server.js',
  'packages/record-replay-windows/mcp/server.mjs',
  'skills/atria-browser-bridge/SKILL.md',
  'skills/atria-desktop/SKILL.md',
  'skills/atria-recording/SKILL.md'
];

const missing = required.filter((relative) => !existsSync(join(root, relative)));
const secretLike = [];
const forbiddenSegments = [/\\node_modules(\\|$)/i, /\\target(\\|$)/i, /\.env($|\.)/i, /cookie/i, /token/i, /secret/i];
for (const relative of required) {
  const path = join(root, relative);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  if (/Bearer\s+[A-Za-z0-9._-]+|-----BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY-----/i.test(text)) secretLike.push(relative);
  if (forbiddenSegments.some((pattern) => pattern.test(path))) secretLike.push(relative);
}

const result = { ok: missing.length === 0 && secretLike.length === 0, missing, secretLike };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
