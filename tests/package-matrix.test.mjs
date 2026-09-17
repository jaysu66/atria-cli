import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function baseStage() {
  const stage = mkdtempSync(join(tmpdir(), 'atria-package-matrix-'));
  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(join(sourceRoot, 'bin', 'atria.mjs'), join(stage, 'bin', 'atria.mjs'));
  cpSync(join(sourceRoot, 'package.json'), join(stage, 'package.json'));
  mkdirSync(join(stage, 'skills'), { recursive: true });
  return stage;
}

function addBrowser(stage) {
  mkdirSync(join(stage, 'packages', 'browser-bridge', 'extension'), { recursive: true });
  cpSync(join(sourceRoot, 'packages', 'browser-bridge', 'mcp-server.js'), join(stage, 'packages', 'browser-bridge', 'mcp-server.js'));
  cpSync(join(sourceRoot, 'packages', 'browser-bridge', 'extension', 'manifest.json'), join(stage, 'packages', 'browser-bridge', 'extension', 'manifest.json'));
}

function addDesktop(stage, visual = false) {
  mkdirSync(join(stage, 'packages', 'record-replay-windows', 'mcp'), { recursive: true });
  mkdirSync(join(stage, 'packages', 'record-replay-windows', 'node_modules'), { recursive: true });
  mkdirSync(join(stage, 'packages', 'record-replay-windows', 'bin'), { recursive: true });
  cpSync(join(sourceRoot, 'packages', 'record-replay-windows', 'mcp', 'server.mjs'), join(stage, 'packages', 'record-replay-windows', 'mcp', 'server.mjs'));
  writeFileSync(join(stage, 'packages', 'record-replay-windows', 'bin', 'actor.exe'), 'candidate-presence-fixture');
  writeFileSync(join(stage, 'packages', 'record-replay-windows', 'bin', 'recorder.exe'), 'candidate-presence-fixture');
  if (visual) writeFileSync(join(stage, 'packages', 'record-replay-windows', 'bin', 'overlay.exe'), 'candidate-presence-fixture');
}

function doctor(stage, component) {
  const args = [join(stage, 'bin', 'atria.mjs'), 'doctor', '--json'];
  if (component) args.push('--component', component);
  const result = spawnSync(process.execPath, args, {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ATRIA_BROWSER_PORT: '1', ATRIA_DESKTOP_PORT: '2' },
  });
  return { result, json: JSON.parse(result.stdout) };
}

test('browser-only layout self-checks independently and gives a pairing/start step', () => {
  const stage = baseStage();
  try {
    addBrowser(stage);
    const { result, json } = doctor(stage, 'browser');
    assert.equal(result.status, 2);
    assert.equal(json.components.browser.sourcePresent, true);
    assert.equal(json.components.desktop.sourcePresent, false);
    assert.match(json.components.browser.nextStep, /atria browser/);
  } finally { rmSync(stage, { recursive: true, force: true }); }
});

test('desktop plus visual layout reports both selected components ready', () => {
  const stage = baseStage();
  try {
    addDesktop(stage, true);
    assert.equal(doctor(stage, 'desktop').json.components.desktop.ready, true);
    assert.equal(doctor(stage, 'visual').json.components.visual.ready, true);
  } finally { rmSync(stage, { recursive: true, force: true }); }
});

test('full three-part layout reports source and native presence without requiring a maintainer cwd', () => {
  const stage = baseStage();
  try {
    addBrowser(stage);
    addDesktop(stage, true);
    const { result, json } = doctor(stage);
    assert.equal(result.status, 0);
    assert.equal(json.sourceReady, true);
    assert.equal(json.runtimeReady, true);
    assert.equal(json.components.visual.ready, true);
  } finally { rmSync(stage, { recursive: true, force: true }); }
});
