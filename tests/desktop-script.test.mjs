import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { failureMessage } = createRequire(import.meta.url)(join(root, 'skills', 'atria-desktop', 'scripts', 'desktop.js'));

test('failureMessage reports a tool error carried in the result payload', () => {
  const out = {
    ok: false,
    status: 'failed',
    code: 'SNAPSHOT_REQUIRED',
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'SNAPSHOT_REQUIRED', message: 'snapshotId is required with elementIndex' }) }],
    },
  };
  assert.equal(failureMessage(out), 'SNAPSHOT_REQUIRED failed: snapshotId is required with elementIndex');
});

test('failureMessage prefers the daemon-level error string', () => {
  assert.equal(failureMessage({ ok: false, error: 'daemon still initializing' }), 'daemon still initializing');
});

test('failureMessage falls back to raw text and never prints undefined', () => {
  const rawText = failureMessage({ ok: false, status: 'failed', result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
  assert.equal(rawText, 'failed: boom');
  assert.equal(failureMessage({ ok: false }), 'tool call failed (no error detail returned)');
});
