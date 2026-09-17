#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = {
  browser: resolve(process.env.ATRIA_BROWSER_SOURCE_DIR || join(root, '..', 'browser-bridge')),
  desktop: resolve(process.env.ATRIA_DESKTOP_SOURCE_DIR || join(root, '..', 'desktop-recording')),
  kit: resolve(process.env.ATRIA_DSH_KIT_SOURCE_DIR || join(root, '..', 'dsh-kit')),
};

function assertInsideRoot(target) {
  const resolved = resolve(target);
  if (resolved === root || !resolved.startsWith(root + sep)) {
    throw new Error(`refusing to modify path outside CLI root: ${resolved}`);
  }
  return resolved;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeHash(files) {
  const stable = files
    .map((entry) => `${entry.destination}\0${entry.sha256}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function tracked(repo) {
  return execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function walkFiles(base, current = base) {
  const out = [];
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, item.name);
    if (item.isSymbolicLink()) throw new Error(`symlink/junction is not allowed in a source snapshot: ${full}`);
    if (item.isDirectory()) out.push(...walkFiles(base, full));
    else if (item.isFile()) out.push(relative(base, full).replaceAll('\\', '/'));
  }
  return out;
}

const manifestFiles = [];
const sourceMeta = {};

function resetDestination(destination) {
  const safe = assertInsideRoot(destination);
  rmSync(safe, { recursive: true, force: true });
  mkdirSync(safe, { recursive: true });
}

function copySnapshot({ id, sourceRoot, destinationRoot, files, sourceCommit = null, sourcePrefix = '' }) {
  resetDestination(destinationRoot);
  const copied = [];
  for (const sourceRelative of files.sort()) {
    const normalized = sourceRelative.replaceAll('\\', '/');
    const from = resolve(sourceRoot, normalized);
    if (!from.startsWith(resolve(sourceRoot) + sep) || !existsSync(from) || !statSync(from).isFile()) {
      throw new Error(`invalid source file for ${id}: ${normalized}`);
    }
    const destinationRelative = sourcePrefix && normalized.startsWith(sourcePrefix)
      ? normalized.slice(sourcePrefix.length)
      : normalized;
    const to = assertInsideRoot(join(destinationRoot, destinationRelative));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    const entry = {
      destination: relative(root, to).replaceAll('\\', '/'),
      sha256: sha256File(to),
      source: id,
      sourceCommit,
      sourceRelativePath: normalized,
    };
    manifestFiles.push(entry);
    copied.push(entry);
  }
  return copied;
}

for (const [name, sourcePath] of Object.entries(sourceRoots)) {
  if (!existsSync(sourcePath)) throw new Error(`missing ${name} source: ${sourcePath}`);
}

const browserCommit = git(sourceRoots.browser, ['rev-parse', 'HEAD']);
const browserFiles = tracked(sourceRoots.browser)
  .filter((path) => !path.startsWith('.git/'));
const browserCopied = copySnapshot({
  id: 'browser-bridge',
  sourceRoot: sourceRoots.browser,
  destinationRoot: join(root, 'packages', 'browser-bridge'),
  files: browserFiles,
  sourceCommit: browserCommit,
});
const browserSkillFiles = tracked(sourceRoots.browser)
  .filter((path) => path.startsWith('skills/atria-browser-bridge/'));
copySnapshot({
  id: 'browser-bridge-skill',
  sourceRoot: sourceRoots.browser,
  destinationRoot: join(root, 'skills', 'atria-browser-bridge'),
  files: browserSkillFiles,
  sourceCommit: browserCommit,
  sourcePrefix: 'skills/atria-browser-bridge/',
});

const desktopCommit = git(sourceRoots.desktop, ['rev-parse', 'HEAD']);
const desktopPrefix = 'plugins/record-replay-windows/';
const desktopFiles = tracked(sourceRoots.desktop)
  .filter((path) => path.startsWith(desktopPrefix))
  .filter((path) => !['.exe', '.dll', '.node'].includes(extname(path).toLowerCase()));
const desktopCopied = copySnapshot({
  id: 'record-replay-windows',
  sourceRoot: sourceRoots.desktop,
  destinationRoot: join(root, 'packages', 'record-replay-windows'),
  files: desktopFiles,
  sourceCommit: desktopCommit,
  sourcePrefix: desktopPrefix,
});
const recordSkillFiles = desktopFiles.filter((path) => path.startsWith(`${desktopPrefix}skills/record-replay-windows/`));
copySnapshot({
  id: 'record-replay-windows-skill',
  sourceRoot: sourceRoots.desktop,
  destinationRoot: join(root, 'skills', 'record-replay-windows'),
  files: recordSkillFiles,
  sourceCommit: desktopCommit,
  sourcePrefix: `${desktopPrefix}skills/record-replay-windows/`,
});

for (const skill of ['atria-desktop', 'atria-recording']) {
  const skillRoot = join(sourceRoots.kit, 'skills', skill);
  copySnapshot({
    id: `${skill}-skill`,
    sourceRoot: skillRoot,
    destinationRoot: join(root, 'skills', skill),
    files: walkFiles(skillRoot),
  });
}

sourceMeta['browser-bridge'] = { sourceCommit: browserCommit, sourceTreeHash: treeHash(browserCopied), protocolVersion: 3 };
sourceMeta['record-replay-windows'] = { sourceCommit: desktopCommit, sourceTreeHash: treeHash(desktopCopied), protocolVersion: 2 };
sourceMeta['atria-desktop-skill'] = { sourceCommit: null, sourceTreeHash: treeHash(manifestFiles.filter((entry) => entry.source === 'atria-desktop-skill')), protocolVersion: 2 };
sourceMeta['atria-recording-skill'] = { sourceCommit: null, sourceTreeHash: treeHash(manifestFiles.filter((entry) => entry.source === 'atria-recording-skill')), protocolVersion: 2 };

const componentsPath = join(root, 'manifests', 'components.json');
const components = JSON.parse(readFileSync(componentsPath, 'utf8'));
components.schemaVersion = 2;
components.name = 'atria-cli-source-release-candidate';
components.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
components.generatedAt = new Date().toISOString();
for (const component of components.components) {
  if (sourceMeta[component.id]) Object.assign(component, sourceMeta[component.id]);
}
writeFileSync(componentsPath, JSON.stringify(components, null, 2) + '\n', 'utf8');

const sourceManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  policy: 'Only tracked Git files or the two declared non-Git Skill snapshots are synchronized. Native binaries are excluded.',
  sources: {
    'browser-bridge': { sourceOfTruth: 'Atria/02-CLI与通用能力/browser-bridge', sourceCommit: browserCommit },
    'record-replay-windows': { sourceOfTruth: 'Atria/02-CLI与通用能力/desktop-recording/plugins/record-replay-windows', sourceCommit: desktopCommit },
    'atria-desktop-skill': { sourceOfTruth: 'Atria/02-CLI与通用能力/dsh-kit/skills/atria-desktop', sourceCommit: null },
    'atria-recording-skill': { sourceOfTruth: 'Atria/02-CLI与通用能力/dsh-kit/skills/atria-recording', sourceCommit: null },
  },
  files: manifestFiles.sort((a, b) => a.destination.localeCompare(b.destination)),
};
writeFileSync(join(root, 'manifests', 'source-files.json'), JSON.stringify(sourceManifest, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  ok: true,
  browserCommit,
  desktopCommit,
  synchronizedFiles: manifestFiles.length,
  manifest: 'manifests/source-files.json',
}, null, 2));
