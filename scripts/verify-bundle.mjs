#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.ATRIA_VERIFY_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'README.md', 'LICENSE-STATUS.md', 'SECURITY.md', 'package.json', 'bin/atria.mjs',
  'manifests/components.json', 'manifests/source-files.json',
  'packages/browser-bridge/mcp-server.js',
  'packages/browser-bridge/extension/content/visual-indicator.js',
  'packages/record-replay-windows/mcp/server.mjs',
  'packages/record-replay-windows/mcp/action-coordinator.mjs',
  'packages/record-replay-windows/mcp/visual-controller.mjs',
  'packages/record-replay-windows/native/recorder/src/bin/overlay.rs',
  'skills/atria-cli-overview/SKILL.md', 'skills/atria-cli-overview/README.md',
  'skills/atria-browser-bridge/SKILL.md', 'skills/atria-browser-bridge/README.md',
  'skills/atria-desktop/SKILL.md', 'skills/atria-desktop/README.md',
  'skills/atria-recording/SKILL.md', 'skills/atria-recording/README.md',
  'skills/record-replay-windows/SKILL.md', 'skills/record-replay-windows/README.md',
];
const forbiddenDirectoryNames = new Set([
  '.git', '.codex', 'node_modules', 'target', 'coverage', '.next', 'dist',
  'build', 'tmp', 'temp', 'logs', 'recordings', 'eventstream',
  'knowledge-base', 'knowledge', 'memory', 'memories',
]);
const forbiddenFilePatterns = [
  /^\.env(?:\.|$)/i,
  /(?:^|[-_.])cookie(?:s)?(?:[-_.]|$)/i,
  /(?:^|[-_.])credential(?:s)?(?:[-_.]|$)/i,
  /(?:^|[-_.])session[-_.]?index(?:[-_.]|$)/i,
  /(?:^|[-_.])event(?:s)?\.jsonl$/i,
  /\.(?:exe|dll|node|pdb|log|har|pem|pfx|key)$/i,
];
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2']);
const secretPatterns = [
  ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/i],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['bearer-value', /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i],
  ['cookie-header', /\bCookie\s*:\s*[^\s"'<>]{12,}/i],
  ['embedded-secret', /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i],
];
const absoluteMaintainerPath = /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!<user>|USERNAME|USER|name\b)[^\\/\s"'<>]+|[\\/]+Users[\\/]+(?!<user>|USERNAME|USER|name\b)[^\\/\s"'<>]+)/i;

const posix = (path) => path.replaceAll('\\', '/');
function allFiles(current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (current === root && entry.name === '.git') continue;
    if (entry.isSymbolicLink()) files.push({ path: full, symlink: true });
    else if (entry.isDirectory()) files.push(...allFiles(full));
    else if (entry.isFile()) files.push({ path: full, symlink: false });
  }
  return files;
}
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lineFor = (text, index) => text.slice(0, index).split(/\r?\n/).length;

const missing = required.filter((file) => !existsSync(join(root, file)));
const findings = [];
let files = [];
try { files = allFiles(); }
catch (error) { findings.push({ path: '.', line: null, rule: 'walk-error', detail: error.message }); }

for (const item of files) {
  const relativePath = posix(relative(root, item.path));
  const segments = relativePath.toLowerCase().split('/');
  if (item.symlink) {
    findings.push({ path: relativePath, line: null, rule: 'symlink-or-junction', detail: 'release files must be regular files' });
    continue;
  }
  if (segments.slice(0, -1).some((segment) => forbiddenDirectoryNames.has(segment))) {
    findings.push({ path: relativePath, line: null, rule: 'forbidden-directory', detail: 'runtime, history, knowledge, recording, or build output directory' });
  }
  if (forbiddenFilePatterns.some((pattern) => pattern.test(segments.at(-1)))) {
    findings.push({ path: relativePath, line: null, rule: 'forbidden-file', detail: 'credential, recording, log, or compiled native output' });
  }
  if (binaryExtensions.has(extname(relativePath).toLowerCase())) continue;
  const buffer = readFileSync(item.path);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  const absoluteMatch = absoluteMaintainerPath.exec(text);
  const explicitTestUser = absoluteMatch && /[\\/]Users[\\/](?:tester|testuser|example)(?:[\\/]|$)/i.test(absoluteMatch[0]);
  if (absoluteMatch && !explicitTestUser) findings.push({ path: relativePath, line: lineFor(text, absoluteMatch.index), rule: 'absolute-user-path', detail: 'maintainer-specific user path' });
  if (relativePath === 'scripts/verify-bundle.mjs') continue;
  for (const [rule, pattern] of secretPatterns) {
    const match = pattern.exec(text);
    if (match) findings.push({ path: relativePath, line: lineFor(text, match.index), rule, detail: 'secret-like value; value intentionally omitted' });
  }
}

const manifestPath = join(root, 'manifests', 'source-files.json');
let sourceManifest = null;
if (existsSync(manifestPath)) {
  try {
    sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const entry of sourceManifest.files || []) {
      const path = resolve(root, entry.destination);
      if (path === root || !path.startsWith(root + sep) || !existsSync(path)) {
        findings.push({ path: entry.destination, line: null, rule: 'source-manifest-missing', detail: 'declared synchronized file is absent' });
      } else if (hash(path) !== entry.sha256) {
        findings.push({ path: entry.destination, line: null, rule: 'source-hash-mismatch', detail: 'file differs from synchronized source manifest' });
      }
    }
    const declared = new Set((sourceManifest.files || []).map((entry) => entry.destination));
    const synchronizedRoots = [
      'packages/browser-bridge/', 'packages/record-replay-windows/',
      'skills/atria-browser-bridge/', 'skills/atria-desktop/',
      'skills/atria-recording/', 'skills/record-replay-windows/',
    ];
    for (const item of files) {
      const relativePath = posix(relative(root, item.path));
      if (!item.symlink && synchronizedRoots.some((prefix) => relativePath.startsWith(prefix)) && !declared.has(relativePath)) {
        findings.push({ path: relativePath, line: null, rule: 'source-manifest-extra', detail: 'file is in synchronized package roots but has no source declaration' });
      }
    }
  } catch (error) {
    findings.push({ path: 'manifests/source-files.json', line: null, rule: 'source-manifest-invalid', detail: error.message });
  }
}

const result = {
  ok: missing.length === 0 && findings.length === 0,
  root,
  scannedFiles: files.length,
  declaredSourceFiles: sourceManifest?.files?.length ?? 0,
  missing,
  findings,
  workspaceMetadataExcluded: ['.git'],
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
