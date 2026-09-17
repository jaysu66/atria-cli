const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const indicatorPath = path.join(__dirname, '..', 'extension', 'content', 'visual-indicator.js');
const workerPath = path.join(__dirname, '..', 'extension', 'service-worker.js');

function loadVisualCompletionHelpers() {
  const source = fs.readFileSync(workerPath, 'utf8');
  const startMarker = '// BEGIN_TESTABLE_VISUAL_COMPLETION';
  const endMarker = '// END_TESTABLE_VISUAL_COMPLETION';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.notEqual(start, -1, 'visual completion helper start marker is present');
  assert.notEqual(end, -1, 'visual completion helper end marker is present');
  const context = { helpers: null };
  vm.runInNewContext(
    `${source.slice(start + startMarker.length, end)}\nhelpers = { readToolResultPayload, resolveVisualCompletionPhase };`,
    context,
    { filename: workerPath },
  );
  return context.helpers;
}

function contentResultForTest(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

class FakeStyle {
  constructor() {
    this.cssText = '';
    this.display = '';
  }

  setProperty(name, value) {
    this[name] = value;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.textContent = '';
    this.id = '';
    this.className = '';
    this.shadowForTest = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  attachShadow() {
    this.shadowForTest = new FakeElement('#shadow-root');
    return this.shadowForTest;
  }

  contains(candidate) {
    return this === candidate || this.children.some((child) => child.contains(candidate));
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
}

function createHarness() {
  const documentElement = new FakeElement('html');
  const created = [];
  const document = {
    documentElement,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
  };
  let listener = null;
  let nextTimer = 0;
  const timers = new Map();
  const context = {
    window: {},
    document,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    Date,
    Number,
    Math,
    Set,
    String,
    clearTimeout(id) { timers.delete(id); },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
  };
  vm.runInNewContext(fs.readFileSync(indicatorPath, 'utf8'), context, { filename: indicatorPath });
  const host = created[0];
  return {
    host,
    timers,
    send(message) {
      let response;
      const handled = listener(message, {}, (value) => { response = value; });
      return { handled, response };
    },
  };
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

test('indicator is isolated, click-through, bounded, and never renders typed text', () => {
  const harness = createHarness();
  assert.match(harness.host.style.cssText, /pointer-events:none/);
  assert.equal(harness.host.attributes.get('aria-hidden'), 'true');
  const shadow = harness.host.shadowForTest;
  const layer = findById(shadow, 'layer');
  const label = findById(shadow, 'label');
  const secret = 'FAKE_SECRET_DO_NOT_RENDER';

  for (let index = 0; index < 20; index += 1) {
    const { handled, response } = harness.send({
      type: 'atria.visual',
      event: {
        operationId: `boot:click:${index}`,
        action: index === 0 ? 'type' : 'left_click',
        phase: 'input_dispatched',
        target: { x: 100 + index, y: 200, width: 40, height: 20, textLength: secret.length, body: secret },
        body: secret,
        coordinateSpace: 'viewport_css',
        frameId: 0,
        tabId: 41,
        active: true,
      },
    });
    assert.equal(handled, true);
    assert.equal(response.ok, true);
    assert.equal(response.coordinatesRendered, true);
    assert.ok(response.transientCount <= 8);
  }

  assert.equal(label.textContent.includes(secret), false);
  assert.ok(layer.children.filter((node) => node.className === 'ripple').length <= 8);
});

test('untrusted iframe coordinates produce status only and background tabs are labelled', () => {
  const harness = createHarness();
  const result = harness.send({
    type: 'atria.visual',
    event: {
      operationId: 'boot:iframe:1',
      action: 'left_click',
      phase: 'running',
      target: { x: 50, y: 60 },
      coordinateSpace: 'viewport_css',
      frameId: 7,
      tabId: 92,
      active: false,
    },
  }).response;
  const label = findById(harness.host.shadowForTest, 'label');
  assert.equal(result.coordinatesRendered, false);
  assert.match(label.textContent, /后台标签 #92/);
  assert.match(label.textContent, /仅状态/);
});

test('service worker routes feedback and real screenshots to the exact requested tab', () => {
  const source = fs.readFileSync(workerPath, 'utf8');
  assert.match(source, /chrome\.tabs\.sendMessage\(tab\.id, \{ type: "atria\.visual", event \}\)/);
  assert.match(source, /coordinateSpace: "viewport_css"/);
  assert.match(source, /No real screenshot could be captured for the requested tab/);
  assert.match(source, /syntheticFallbackUsed: false/);
  assert.doesNotMatch(source, /Synthetic DOM snapshot/);
  assert.match(source, /operationId: envelope\.operationId \|\| envelope\.id/);
});

test('ordinary dispatched input is not upgraded to verified or emitted twice', () => {
  const { resolveVisualCompletionPhase } = loadVisualCompletionHelpers();
  for (const payload of [
    { clicked: true },
    { pressed: true, key: 'Enter' },
    { scrolled: true },
    { typed: true },
    { clicked: true, verified: null },
  ]) {
    assert.equal(resolveVisualCompletionPhase(contentResultForTest(payload), 'input_dispatched'), null);
  }

  const harness = createHarness();
  harness.send({
    type: 'atria.visual',
    event: {
      operationId: 'boot:plain-click:1',
      action: 'left_click',
      phase: 'input_dispatched',
      target: { x: 42, y: 84 },
      coordinateSpace: 'viewport_css',
      frameId: 0,
      tabId: 7,
      active: true,
    },
  });
  const label = findById(harness.host.shadowForTest, 'label');
  assert.match(label.textContent, /已发出输入/);
  assert.doesNotMatch(label.textContent, /已验证/);

  const source = fs.readFileSync(workerPath, 'utf8');
  assert.doesNotMatch(source, /emit\(result\?\.isError \? "failed" : "verified"/);
  assert.match(source, /resolveVisualCompletionPhase\(result, lastVisualPhase\)/);
});

test('only explicit verification emits verified and errors still emit failed', () => {
  const { readToolResultPayload, resolveVisualCompletionPhase } = loadVisualCompletionHelpers();
  const verified = contentResultForTest({ clicked: true, verified: true });
  assert.equal(readToolResultPayload(verified).verified, true);
  assert.equal(resolveVisualCompletionPhase(verified, 'input_dispatched'), 'verified');
  assert.equal(resolveVisualCompletionPhase(verified, 'verified'), null);

  const failed = { isError: true, content: [{ type: 'text', text: 'click failed' }] };
  assert.equal(resolveVisualCompletionPhase(failed, 'running'), 'failed');
  assert.equal(resolveVisualCompletionPhase(failed, 'failed'), null);
});
