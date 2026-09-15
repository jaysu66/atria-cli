#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const candidateRoot = resolve(process.env.ATRIA_CANDIDATE_ROOT || '');
const nativeRelease = resolve(process.env.ATRIA_NATIVE_RELEASE_DIR || '');
if (!process.env.ATRIA_CANDIDATE_ROOT) throw new Error('ATRIA_CANDIDATE_ROOT is required');
if (!process.env.ATRIA_NATIVE_RELEASE_DIR) throw new Error('ATRIA_NATIVE_RELEASE_DIR is required');

function assertChild(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (resolvedChild === resolvedParent || !resolvedChild.startsWith(resolvedParent + sep)) {
    throw new Error(`unsafe candidate path: ${resolvedChild}`);
  }
  return resolvedChild;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function trackedFiles() {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((path) => !['.exe', '.dll', '.node', '.pdb'].includes(extname(path).toLowerCase()));
}

function listFiles(base, current = base) {
  const out = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(base, full));
    else if (entry.isFile()) out.push(relative(base, full).replaceAll('\\', '/'));
  }
  return out.sort();
}

function treeManifest(base) {
  const files = listFiles(base).map((path) => {
    const full = join(base, path);
    return { path, size: statSync(full).size, sha256: hashFile(full) };
  });
  const treeSha256 = createHash('sha256')
    .update(files.map((file) => `${file.path}\0${file.sha256}`).join('\n'))
    .digest('hex');
  return { treeSha256, files };
}

mkdirSync(candidateRoot, { recursive: true });
const sourceDir = assertChild(candidateRoot, join(candidateRoot, `atria-cli-${version}-source`));
const nativeDir = assertChild(candidateRoot, join(candidateRoot, `atria-windows-native-${version}`));
for (const target of [sourceDir, nativeDir]) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

const dirty = git(['status', '--porcelain']);
if (dirty) throw new Error('CLI worktree must be committed and clean before building a candidate');
const cliCommit = git(['rev-parse', 'HEAD']);
for (const relativePath of trackedFiles()) {
  const from = resolve(root, relativePath);
  const to = assertChild(sourceDir, join(sourceDir, relativePath));
  if (!from.startsWith(root + sep) || !existsSync(from)) throw new Error(`missing tracked file: ${relativePath}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const verify = spawnSync(process.execPath, [join(sourceDir, 'scripts', 'verify-bundle.mjs')], {
  cwd: sourceDir,
  encoding: 'utf8',
  env: { ...process.env, ATRIA_VERIFY_ROOT: sourceDir },
});
if (verify.status !== 0) {
  process.stderr.write(verify.stdout || '');
  process.stderr.write(verify.stderr || '');
  throw new Error(`source candidate verification failed with exit ${verify.status}`);
}

const components = JSON.parse(readFileSync(join(sourceDir, 'manifests', 'components.json'), 'utf8'));
const nativeArtifacts = [];
for (const name of ['actor.exe', 'recorder.exe', 'overlay.exe']) {
  const from = resolve(nativeRelease, name);
  if (!from.startsWith(nativeRelease + sep) || !existsSync(from)) throw new Error(`missing fresh native artifact: ${name}`);
  const to = join(nativeDir, name);
  copyFileSync(from, to);
  nativeArtifacts.push({ name, size: statSync(to).size, sha256: hashFile(to) });
}

const desktopComponent = components.components.find((component) => component.id === 'record-replay-windows');
const nativeManifest = {
  schemaVersion: 1,
  status: 'PRIVATE REVIEW ONLY - NOT FOR REDISTRIBUTION',
  version,
  cliCommit,
  sourceCommit: desktopComponent?.sourceCommit || null,
  protocolVersion: desktopComponent?.protocolVersion ?? null,
  sourcePath: 'packages/record-replay-windows/native/recorder',
  artifacts: nativeArtifacts,
};
writeFileSync(join(nativeDir, 'native-manifest.json'), JSON.stringify(nativeManifest, null, 2) + '\n', 'utf8');
writeFileSync(join(nativeDir, 'README.md'), `# Atria Windows native private candidate\n\nPRIVATE REVIEW ONLY. NOT FOR REDISTRIBUTION.\n\nThis directory contains actor.exe, recorder.exe and the optional standalone overlay.exe built from source commit \`${nativeManifest.sourceCommit}\`. Verify every SHA-256 in \`native-manifest.json\` before copying these files into \`packages/record-replay-windows/bin\`.\n\nUpdate all three binaries together with the matching source/Skill candidate. For rollback, stop active operations, restore the previous three verified binaries and matching source, then confirm the CLI version and protocol. Do not remove user recordings, pairing tokens or configuration. Redistribution licensing, dependency notices and clean-machine provenance remain unapproved.\n`, 'utf8');
writeFileSync(join(nativeDir, 'LICENSE-STATUS.md'), 'Native redistribution licensing and third-party notices are not yet approved. Keep this candidate private and do not publish or redistribute it.\n', 'utf8');

const sourceTree = treeManifest(sourceDir);
const nativeTree = treeManifest(nativeDir);
const artifacts = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: 'PRIVATE REVIEW ONLY',
  version,
  cliCommit,
  sourceCandidate: { directory: relative(candidateRoot, sourceDir).replaceAll('\\', '/'), ...sourceTree },
  nativeCandidate: { directory: relative(candidateRoot, nativeDir).replaceAll('\\', '/'), ...nativeTree },
  sourceCommits: Object.fromEntries(components.components.map((component) => [component.id, component.sourceCommit ?? null])),
  verification: JSON.parse(verify.stdout),
};
writeFileSync(join(candidateRoot, 'artifacts.json'), JSON.stringify(artifacts, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, sourceDir, nativeDir, artifacts: join(candidateRoot, 'artifacts.json'), sourceTreeHash: sourceTree.treeSha256, nativeTreeHash: nativeTree.treeSha256 }, null, 2));
