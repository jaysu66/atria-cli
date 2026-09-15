import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'atria.mjs');
const helper = join(root, 'tests', 'fixtures', 'fake-desktop-helper.cjs');

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ATRIA_DESKTOP_HELPER: helper, ...extraEnv },
  });
}

test('version comes from package metadata', () => {
  assert.equal(run(['--version']).stdout.trim(), '0.2.0-private.4');
});

test('skills list reports all five bundled skills', () => {
  const result = run(['skills', 'list']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 5);
  assert.doesNotMatch(result.stdout, /^missing\t/m);
});

for (const [args, expected] of [
  [['visual', 'status'], { tool: 'visual_status', input: {} }],
  [['visual', 'enable'], { tool: 'visual_enable', input: { required: false } }],
  [['visual', 'enable', '--required'], { tool: 'visual_enable', input: { required: true } }],
  [['visual', 'disable'], { tool: 'visual_disable', input: {} }],
  [['automation', 'status'], { tool: 'automation_status', input: {} }],
  [['automation', 'status', 'op-1'], { tool: 'automation_status', input: { operationId: 'op-1' } }],
  [['automation', 'pause'], { tool: 'automation_pause', input: {} }],
  [['automation', 'resume'], { tool: 'automation_resume', input: {} }],
  [['automation', 'stop'], { tool: 'automation_stop', input: {} }],
]) {
  test(`routes ${args.join(' ')}`, () => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  });
}

test('invalid visual and automation forms fail before helper execution', () => {
  assert.equal(run(['visual', 'enable', '--surprise']).status, 2);
  assert.equal(run(['automation', 'pause', 'extra']).status, 2);
});

test('component doctor is independent and reports a concrete missing-runtime step', () => {
  const browser = run(['doctor', '--json', '--component', 'browser'], { ATRIA_BROWSER_PORT: '1', ATRIA_DESKTOP_PORT: '2' });
  const visual = run(['doctor', '--json', '--component', 'visual'], { ATRIA_BROWSER_PORT: '1', ATRIA_DESKTOP_PORT: '2' });
  const browserJson = JSON.parse(browser.stdout);
  const visualJson = JSON.parse(visual.stdout);
  assert.equal(browserJson.selectedComponent, 'browser');
  assert.equal(browserJson.components.browser.sourcePresent, true);
  assert.match(browserJson.components.browser.nextStep, /atria browser/);
  assert.equal(visualJson.selectedComponent, 'visual');
  assert.equal(visualJson.components.visual.ready, false);
  assert.match(visualJson.components.visual.nextStep, /optional visual component/);
});

test('CLI starts correctly from a different working directory', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { cwd: dirname(root), encoding: 'utf8' });
  assert.equal(output.trim(), '0.2.0-private.4');
});
