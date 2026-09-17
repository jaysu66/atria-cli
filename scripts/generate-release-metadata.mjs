#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const components = JSON.parse(readFileSync(join(root, 'manifests', 'components.json'), 'utf8'));
const nodeRoot = join(root, 'packages', 'record-replay-windows');
const nodeLock = JSON.parse(readFileSync(join(nodeRoot, 'package-lock.json'), 'utf8'));
const cargoManifest = join(nodeRoot, 'native', 'recorder', 'Cargo.toml');
const check = process.argv.includes('--check');

const cargo = spawnSync('cargo', [
  'metadata', '--locked', '--format-version', '1', '--manifest-path', cargoManifest,
], { encoding: 'utf8', windowsHide: true });
if (cargo.status !== 0) {
  process.stderr.write(cargo.stderr || cargo.stdout || 'cargo metadata failed\n');
  process.exit(1);
}

const npmDependencies = Object.entries(nodeLock.packages)
  .filter(([path]) => path.includes('node_modules/'))
  .map(([path, metadata]) => ({
    ecosystem: 'npm',
    name: metadata.name || path.split('node_modules/').at(-1),
    version: metadata.version,
    license: metadata.license || null,
  }));
const cargoDependencies = JSON.parse(cargo.stdout).packages
  .filter((metadata) => metadata.source)
  .map((metadata) => ({
    ecosystem: 'cargo',
    name: metadata.name,
    version: metadata.version,
    license: metadata.license || null,
  }));

const dependencies = [...npmDependencies, ...cargoDependencies]
  .filter((item, index, values) => values.findIndex((other) =>
    other.ecosystem === item.ecosystem && other.name === item.name && other.version === item.version) === index)
  .sort((a, b) => `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(`${b.ecosystem}:${b.name}:${b.version}`));

const missing = dependencies.filter((item) => !item.name || !item.version || !item.license);
if (missing.length) {
  console.error(JSON.stringify({ error: 'dependency-license-missing', missing }, null, 2));
  process.exit(1);
}

const inventory = {
  schemaVersion: 1,
  project: packageJson.name,
  version: packageJson.version,
  generatedFrom: [
    'packages/record-replay-windows/package-lock.json',
    'packages/record-replay-windows/native/recorder/Cargo.lock',
  ],
  dependencyCount: dependencies.length,
  dependencies,
};

const spdxId = (item) => `SPDXRef-${item.ecosystem}-${item.name}-${item.version}`.replace(/[^A-Za-z0-9.-]/g, '-');
const spdxLicense = (value) => value
  .replaceAll('MIT/Apache-2.0', 'MIT OR Apache-2.0')
  .replaceAll('Apache-2.0/MIT', 'Apache-2.0 OR MIT');
const purlName = (item) => item.ecosystem === 'npm' && item.name.startsWith('@')
  ? `%40${item.name.slice(1)}`
  : encodeURIComponent(item.name);
const packages = [{
  SPDXID: 'SPDXRef-RootPackage',
  name: packageJson.name,
  versionInfo: packageJson.version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'Apache-2.0',
  licenseDeclared: 'Apache-2.0',
  copyrightText: 'Copyright 2026 Atria Project Authors',
}, ...dependencies.map((item) => ({
  SPDXID: spdxId(item),
  name: item.name,
  versionInfo: item.version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: spdxLicense(item.license),
  copyrightText: 'NOASSERTION',
  primaryPackagePurpose: 'LIBRARY',
  externalRefs: [{
    referenceCategory: 'PACKAGE-MANAGER',
    referenceType: 'purl',
    referenceLocator: `pkg:${item.ecosystem}/${purlName(item)}@${item.version}`,
  }],
}))];
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/jaysu66/atria-cli/sbom/${packageJson.version}`,
  creationInfo: {
    created: components.generatedAt,
    creators: ['Tool: atria-cli/scripts/generate-release-metadata.mjs'],
  },
  packages,
  relationships: dependencies.map((item) => ({
    spdxElementId: 'SPDXRef-RootPackage',
    relationshipType: 'DEPENDS_ON',
    relatedSpdxElement: spdxId(item),
  })),
};

const outputs = [
  ['manifests/dependency-licenses.json', inventory],
  ['manifests/sbom.spdx.json', sbom],
];
let changed = false;
for (const [relativePath, value] of outputs) {
  const path = join(root, relativePath);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    const current = readFileSync(path, 'utf8');
    if (current !== next) {
      console.error(`${relativePath} is stale; run npm run release:metadata`);
      changed = true;
    }
  } else {
    writeFileSync(path, next, 'utf8');
  }
}
if (changed) process.exit(1);
console.log(JSON.stringify({ ok: true, check, dependencyCount: dependencies.length, outputs: outputs.map(([path]) => path) }));
