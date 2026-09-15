import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeActorClient } from "../mcp/actor-client.mjs";
import { NativeRecorderClient } from "../mcp/native-client.mjs";
import { executeReplay, planReplay, readJsonlFile } from "../mcp/replay-runner.mjs";

const root = path.resolve(import.meta.dirname, '..');
const actorPath = process.env.ATRIA_ACTOR_PATH || path.join(root, 'native', 'recorder', 'target', 'release', 'actor.exe');
const recorderPath = process.env.ATRIA_RECORDER_PATH || path.join(root, 'native', 'recorder', 'target', 'release', 'recorder.exe');
const fixturePath = path.join(import.meta.dirname, 'windows-input-fixture.ps1');
const runId = `run-${Date.now()}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atria-s3-acceptance-'));
const statePath = path.join(tempDir, 'state.json');
const readyPath = path.join(tempDir, 'ready.json');
const sessionsRoot = path.join(tempDir, 'sessions');
const expectedText = '你好 Atria 😀\n第二行';
const fakeSecret = 'FAKE_SECRET_123!';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (_) {}
    await wait(75);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function state() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function normalizedText(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function exactExpect(window) {
  return {
    hwnd: window.hwnd,
    pid: window.pid,
    processName: window.processName,
    titleExact: window.title,
  };
}

function element(snapshot, name) {
  const match = (snapshot.elements || []).find((item) => item.name === name || item.automationId === name);
  if (!match) throw new Error(`Fixture element not found: ${name}`);
  return match;
}

if (!fs.existsSync(actorPath) || !fs.existsSync(recorderPath)) {
  throw new Error('Compiled actor.exe and recorder.exe are required. Run cargo build first or set ATRIA_ACTOR_PATH/ATRIA_RECORDER_PATH.');
}

const fixture = spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', fixturePath,
  '-StatePath', statePath, '-ReadyPath', readyPath, '-RunId', runId,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
let fixtureError = '';
fixture.stderr.on('data', (chunk) => (fixtureError += chunk.toString('utf8')));

const actor = new NativeActorClient({ nativePath: actorPath });
const focusActor = new NativeActorClient({ nativePath: actorPath });
const recorder = new NativeRecorderClient({ nativePath: recorderPath, sessionRoot: sessionsRoot });

try {
  const ready = await waitFor(() => fs.existsSync(readyPath) && JSON.parse(fs.readFileSync(readyPath, 'utf8')), 'fixture ready');
  const listed = await waitFor(async () => {
    const result = await actor.windowList();
    const a = result.windows.find((item) => item.title === ready.titleA && item.pid === ready.pid);
    const b = result.windows.find((item) => item.title === ready.titleB && item.pid === ready.pid);
    return a && b ? { a, b } : null;
  }, 'fixture windows');

  await actor.windowFocus({ hwnd: listed.a.hwnd, title: listed.a.title, processName: listed.a.processName });
  const snapshotA = await actor.uiSnapshot({ scopeHwnd: listed.a.hwnd, maxElements: 100 });
  assert.equal(snapshotA.window.hwnd, listed.a.hwnd);
  assert.equal(snapshotA.window.pid, listed.a.pid);
  const inputA = element(snapshotA, 'Unicode Input A');
  const buttonA = element(snapshotA, 'Increment A');
  const expectA = exactExpect(listed.a);

  const supported = await actor.uiaInvoke({
    scopeHwnd: listed.a.hwnd,
    automationId: inputA.automationId,
    name: inputA.name,
    nameMatch: 'exact',
    action: 'set_value',
    value: '',
  });
  assert.equal(supported.status, 'succeeded');
  assert.equal(supported.verification.status, 'verified');
  assert.equal(Object.hasOwn(supported, 'readBack'), false);

  const unsupported = await actor.uiaInvoke({
    scopeHwnd: listed.a.hwnd,
    automationId: buttonA.automationId,
    name: buttonA.name,
    nameMatch: 'exact',
    action: 'set_value',
    value: 'not-written',
  });
  assert.equal(unsupported.status, 'failed');
  assert.equal(unsupported.code, 'VALUE_PATTERN_UNSUPPORTED');

  await assert.rejects(
    actor.uiaInvoke({ scopeHwnd: listed.a.hwnd, name: 'Duplicate Action', nameMatch: 'exact', action: 'invoke' }),
    /AMBIGUOUS_TARGET/,
  );

  await recorder.start({ redactText: false, capturePolicy: 'off', installSkillOnStop: false, maxDurationSeconds: 60 });
  await actor.click({ x: inputA.cx, y: inputA.cy, expect: expectA, moveDurationMs: 0 });
  await actor.typeText({ text: expectedText, expect: expectA });
  await waitFor(() => normalizedText(state().textA) === expectedText, 'Unicode text write');
  const recorded = await recorder.stop();
  const events = readJsonlFile(recorded.eventsPath);
  const unicodeText = events.filter((event) => event.type === 'keyboard.text').map((event) => event.input.text).join('');
  assert.equal(unicodeText, expectedText.replace('\n', ''));
  assert.equal(events.some((event) => event.input?.keyName === 'VK_231'), false);

  await actor.uiaInvoke({ scopeHwnd: listed.a.hwnd, automationId: inputA.automationId, action: 'set_value', value: '' });
  const plan = planReplay(events, []);
  const replay = await executeReplay(actor, plan, { stepDelayMs: 0 });
  assert.equal(replay.status, 'succeeded');
  await waitFor(() => normalizedText(state().textA) === expectedText, 'Unicode replay readback');

  await actor.uiaInvoke({ scopeHwnd: listed.a.hwnd, automationId: inputA.automationId, action: 'set_value', value: '' });
  await recorder.start({ redactText: true, capturePolicy: 'off', installSkillOnStop: false, maxDurationSeconds: 60 });
  await actor.windowFocus({ hwnd: listed.a.hwnd, title: listed.a.title, processName: listed.a.processName });
  await actor.click({ x: inputA.cx, y: inputA.cy, expect: expectA, moveDurationMs: 0 });
  await actor.typeText({ text: fakeSecret, expect: expectA });
  const redacted = await recorder.stop();
  const publicLog = fs.readFileSync(redacted.eventsPath, 'utf8');
  const suppressedLog = fs.readFileSync(redacted.suppressedEventsPath, 'utf8');
  assert.equal(publicLog.includes(fakeSecret), false);
  assert.equal(suppressedLog.includes(fakeSecret), false);
  assert.equal(suppressedLog.includes('keyName'), false);
  assert.equal(suppressedLog.includes('scanCode'), false);

  await actor.uiaInvoke({ scopeHwnd: listed.a.hwnd, automationId: inputA.automationId, action: 'set_value', value: '' });
  await actor.windowFocus({ hwnd: listed.a.hwnd, title: listed.a.title, processName: listed.a.processName });
  await actor.click({ x: inputA.cx, y: inputA.cy, expect: expectA, moveDurationMs: 0 });
  const pauseText = 'x'.repeat(200);
  const nativeActionEvents = [];
  const removeActionListener = actor.addEventListener((event) => nativeActionEvents.push(event));
  const longType = actor.typeText({ text: pauseText, expect: expectA });
  await waitFor(() => nativeActionEvents.some((event) => event.action === 'type' && event.phase === 'running'), 'native running event');
  await wait(100);
  const pauseStartedAt = Date.now();
  const pauseAck = await actor.pause();
  const pauseReturnMs = Date.now() - pauseStartedAt;
  const pauseAckMs = Date.parse(pauseAck.acknowledgedAt) - Date.parse(pauseAck.requestedAt);
  assert.equal(pauseAck.acknowledged, true);
  assert.ok(pauseAckMs >= 0 && pauseAckMs < 500, `native pause acknowledgement took ${pauseAckMs}ms`);
  await wait(60);
  const pausedLength = normalizedText(state().textA).length;
  await wait(180);
  assert.equal(normalizedText(state().textA).length, pausedLength);
  actor.resume();
  const longTypeResult = await longType;
  assert.equal(longTypeResult.typed, 200);
  await waitFor(() => normalizedText(state().textA) === pauseText, 'resumed long text write');
  assert.deepEqual(
    nativeActionEvents.filter((event) => event.action === 'type').map((event) => event.phase),
    ['running', 'input_dispatched'],
  );
  removeActionListener();

  await actor.uiaInvoke({ scopeHwnd: listed.a.hwnd, automationId: inputA.automationId, action: 'set_value', value: '' });
  await actor.windowFocus({ hwnd: listed.a.hwnd, title: listed.a.title, processName: listed.a.processName });
  const switchingClick = actor.click({ x: buttonA.cx, y: buttonA.cy, expect: expectA, moveDurationMs: 1000 });
  await wait(120);
  await focusActor.windowFocus({ hwnd: listed.b.hwnd, title: listed.b.title, processName: listed.b.processName });
  await assert.rejects(switchingClick, /FOCUS_MISMATCH/);
  await wait(150);
  assert.equal(state().clicksA, 0);
  assert.equal(state().clicksB, 0);

  await actor.windowFocus({ hwnd: listed.a.hwnd, title: listed.a.title, processName: listed.a.processName });
  await actor.click({ x: buttonA.cx, y: buttonA.cy, expect: expectA, moveDurationMs: 0 });
  await waitFor(() => state().clicksA === 1, 'bound click');
  assert.equal(state().clicksB, 0);

  process.stdout.write(JSON.stringify({
    ok: true,
    runId,
    actorPath,
    recorderPath,
    fixturePid: ready.pid,
    unicodeRecordedSegments: events.filter((event) => event.type === 'keyboard.text').length,
    replayStatus: replay.status,
    redactedSuppressedEvents: redacted.suppressedEventCount,
    focusSwitchPreventedClick: true,
    valuePatternSupportedVerified: true,
    valuePatternUnsupportedStructured: true,
    nativeActionNotifications: true,
    pauseAckMs,
    pauseReturnMs,
    pausedLength,
    postAckInputCount: 0,
  }, null, 2) + '\n');
} finally {
  try { await recorder.stop(); } catch (_) {}
  actor.close();
  focusActor.close();
  if (!fixture.killed) fixture.kill();
  await wait(500);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  if (fixtureError.trim()) process.stderr.write(fixtureError.trim() + '\n');
}
