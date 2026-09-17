#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');

const browserPort = Number(process.env.ATRIA_BROWSER_PORT || 47652);
const fixturePort = Number(process.env.ATRIA_FIXTURE_PORT || 8099);
const debugPort = Number(process.env.ATRIA_CHROME_DEBUG_PORT || 9222);
const token = String(process.env.ATRIA_BROWSER_AUTH_TOKEN || '');
const fixture = (label) => `http://127.0.0.1:${fixturePort}/visual-feedback.html?page=${label}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (message) => {
      const payload = JSON.parse(message.data);
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message));
      else pending.resolve(payload.result);
    });
  }

  async call(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket.close();
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function findAtriaWorker() {
  const targets = await jsonFetch(`http://127.0.0.1:${debugPort}/json/list`);
  for (const target of targets.filter((item) => item.type === 'service_worker')) {
    const client = new CdpClient(target.webSocketDebuggerUrl);
    try {
      const evaluated = await client.call('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name',
        returnByValue: true,
      });
      if (evaluated?.result?.value === 'Atria Agent Browser Bridge') return { target, client };
    } catch (_) {
      client.close();
    }
    client.close();
  }
  throw new Error('Atria extension service worker was not loaded in the isolated Chrome profile');
}

async function configureExtension() {
  const { client } = await findAtriaWorker();
  const expression = `chrome.storage.local.set({atriaBridgePort:${browserPort},atriaBridgeToken:${JSON.stringify(token)}}).then(()=>true)`;
  const configured = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.equal(configured?.result?.value, true);
  client.close();
}

async function bridge(path, options = {}) {
  return jsonFetch(`http://127.0.0.1:${browserPort}${path}`, {
    ...options,
    headers: { 'X-Atria-Token': token, ...(options.headers || {}) },
  });
}

function textBlocks(response) {
  return (response?.result?.content || []).filter((block) => block.type === 'text').map((block) => block.text);
}

function parsedBlocks(response) {
  return textBlocks(response).flatMap((value) => {
    try { return [JSON.parse(value)]; } catch (_) { return []; }
  });
}

function payload(response) {
  return parsedBlocks(response)[0] || null;
}

async function main() {
  assert.match(token, /^[A-Za-z0-9_-]{32,}$/);
  await wait(100);
  await configureExtension();

  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    health = await bridge('/health');
    if (health.clients?.length === 1 && health.clients[0].protocolVersion === health.protocolVersion) break;
    await wait(250);
  }
  assert.equal(health.clients?.length, 1, 'one isolated extension client should connect');
  assert.equal(health.clients[0].protocolVersion, health.protocolVersion);
  let operationCounter = 0;
  const operationRunId = Date.now().toString(36);
  const call = async (name, args = {}) => {
    const operationId = `${health.bootId}:s6:${operationRunId}:${++operationCounter}`;
    return bridge('/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, operationId, sessionId: 's6-isolated-chrome', arguments: args }),
    });
  };

  const opened = [];
  const checks = [];
  const check = (id, condition, detail) => {
    checks.push({ id, pass: Boolean(condition), detail });
    assert.ok(condition, `${id}: ${detail}`);
  };

  try {
    const pageA = payload(await call('tabs_create', { url: fixture('A'), active: true, groupTitle: 'S6 A' }));
    const pageB = payload(await call('tabs_create', { url: fixture('B'), active: false, groupTitle: 'S6 B' }));
    opened.push(pageA.id, pageB.id);
    await wait(900);

    const context = payload(await call('tabs_context'));
    const tabA = context.tabs.find((tab) => tab.id === pageA.id);
    const tabB = context.tabs.find((tab) => tab.id === pageB.id);
    check('WEB-05', tabA?.active === true && tabB?.active === false && tabA.agentGroupTitle === 'S6 A' && tabB.agentGroupTitle === 'S6 B', JSON.stringify({ tabA, tabB }));

    const tree = textBlocks(await call('read_page', { tabId: pageA.id, filter: 'interactive' })).join('\n');
    const refLine = tree.split('\n').find((line) => line.includes('引用点击') && line.includes('[ref_'));
    const inputLine = tree.split('\n').find((line) => line.includes('测试输入') && line.includes('[ref_'));
    const ref = (refLine?.match(/\[(ref_\d+)\]/) || [])[1];
    const inputRef = (inputLine?.match(/\[(ref_\d+)\]/) || [])[1];
    assert.ok(ref && inputRef, 'fixture refs should be discoverable');

    const refClick = payload(await call('computer', { tabId: pageA.id, action: 'left_click', ref }));
    const rectResponse = payload(await call('javascript_tool', {
      tabId: pageA.id,
      text: '(()=>{const r=document.querySelector("#coordinate-button").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    }));
    const coordinate = rectResponse.result;
    const coordinateClick = payload(await call('computer', { tabId: pageA.id, action: 'left_click', coordinate }));
    const countsA = payload(await call('javascript_tool', {
      tabId: pageA.id,
      text: '({ref:Number(document.querySelector("#ref-count").textContent),coordinate:Number(document.querySelector("#coordinate-count").textContent)})',
    })).result;
    check('WEB-01', countsA.ref === 1 && countsA.coordinate === 1 && refClick.visual?.coordinatesRendered && coordinateClick.visual?.coordinatesRendered, JSON.stringify({ countsA, refVisual: refClick.visual, coordinateVisual: coordinateClick.visual }));

    const typed = payload(await call('computer', { tabId: pageA.id, action: 'type', ref: inputRef, text: 'FAKE_S6_INPUT_你好' }));
    check('WEB-01-TYPE', typed.verified === true && typed.visual?.available === true && !JSON.stringify(typed.visual).includes('FAKE_S6_INPUT'), JSON.stringify(typed.visual));

    const rectB = payload(await call('javascript_tool', {
      tabId: pageB.id,
      text: '(()=>{const r=document.querySelector("#coordinate-button").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    })).result;
    const clickB = payload(await call('computer', { tabId: pageB.id, action: 'left_click', coordinate: rectB }));
    const countsB = payload(await call('javascript_tool', { tabId: pageB.id, text: 'Number(document.querySelector("#coordinate-count").textContent)' })).result;
    const countsAAfterB = payload(await call('javascript_tool', { tabId: pageA.id, text: 'Number(document.querySelector("#coordinate-count").textContent)' })).result;
    check('WEB-02-ROUTING', countsB === 1 && countsAAfterB === 1 && clickB.visual?.tabId === pageB.id && clickB.visual?.active === false, JSON.stringify({ countsB, countsAAfterB, visual: clickB.visual }));

    const shot = await call('computer', { tabId: pageB.id, action: 'screenshot' });
    const shotText = textBlocks(shot).join('\n');
    const imageBlock = (shot.result.content || []).find((block) => block.type === 'image' && String(block.data || '').length > 2000);
    const hasRealImage = Boolean(imageBlock);
    if (imageBlock && process.env.ATRIA_SCREENSHOT_FILE) {
      fs.writeFileSync(process.env.ATRIA_SCREENSHOT_FILE, Buffer.from(imageBlock.data, 'base64'));
    }
    check('WEB-02-SCREENSHOT', hasRealImage && /tab \d+ via (debugger\.Page\.captureScreenshot|activate\+captureVisibleTab)/.test(shotText) && !shotText.includes('Synthetic DOM'), shotText.slice(0, 180));

    await call('cdp_tool', { tabId: pageA.id, method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: 1.5 } });
    const zoomClick = payload(await call('computer', { tabId: pageA.id, action: 'left_click', ref }));
    const zoomCount = payload(await call('javascript_tool', { tabId: pageA.id, text: 'Number(document.querySelector("#ref-count").textContent)' })).result;
    check('WEB-03-ZOOM', zoomCount === 2 && zoomClick.visual?.coordinatesRendered === true, JSON.stringify({ zoomCount, visual: zoomClick.visual }));

    await call('navigate', { tabId: pageA.id, url: fixture('A-nav') });
    await wait(500);
    const navigatedTree = textBlocks(await call('read_page', { tabId: pageA.id, filter: 'interactive' })).join('\n');
    check('WEB-04-NAVIGATION', navigatedTree.includes('引用点击'), 'content scripts re-established after navigation');

    const restricted = payload(await call('tabs_create', { url: 'chrome://version', active: false, groupTitle: 'S6 restricted' }));
    opened.push(restricted.id);
    await wait(400);
    const restrictedShot = await call('computer', { tabId: restricted.id, action: 'screenshot' });
    const restrictedVisual = parsedBlocks(restrictedShot).find((item) => item.visual)?.visual;
    check('WEB-04-RESTRICTED', restrictedVisual?.available === false && /page-injection-unavailable/.test(restrictedVisual.reason || ''), JSON.stringify(restrictedVisual));

    const nulled = await call('javascript_tool', { tabId: pageB.id, text: 'null' });
    const thrown = await call('javascript_tool', { tabId: pageB.id, text: 'JSON.parse("{oops")' });
    check('WEB-06', !nulled.result.isError && textBlocks(nulled).join('\n').includes('"result": null') && thrown.result.isError && textBlocks(thrown).join('\n').includes('PAGE_ERROR'), 'null and thrown result remain distinguishable');

    const networkStarted = await call('network_start', { tabId: pageB.id });
    const networkStopped = await call('network_stop', { tabId: pageB.id });
    check('WEB-07', !networkStarted.result.isError && !networkStopped.result.isError, 'network route starts and stops before demonstration');
  } finally {
    for (const tabId of opened) await call('tabs_close', { tabId }).catch(() => {});
  }

  const report = `${JSON.stringify({ ok: true, chromeDebugPort: debugPort, bridgePort: browserPort, fixturePort, extension: health.clients[0], checks }, null, 2)}\n`;
  if (process.env.ATRIA_EVIDENCE_FILE) fs.writeFileSync(process.env.ATRIA_EVIDENCE_FILE, report, 'utf8');
  process.stdout.write(report);
}

const fixtures = require('./serve-fixtures.js');
main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (fixtures.server.listening) fixtures.server.close();
  });
