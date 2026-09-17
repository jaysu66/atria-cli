#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const browserServer = join(root, 'packages', 'browser-bridge', 'mcp-server.js');
const browserBridgeCli = join(root, 'skills', 'atria-browser-bridge', 'scripts', 'bridge.js');
const desktopServer = join(root, 'packages', 'record-replay-windows', 'mcp', 'server.mjs');
const recordReplayPackage = join(root, 'packages', 'record-replay-windows');
const recordReplayDeps = join(recordReplayPackage, 'node_modules');
const recordReplayActor = join(recordReplayPackage, 'bin', 'actor.exe');
const recordReplayRecorder = join(recordReplayPackage, 'bin', 'recorder.exe');
const recordReplayOverlay = join(recordReplayPackage, 'bin', 'overlay.exe');
const skillsRoot = join(root, 'skills');
const desktopHelper = resolve(process.env.ATRIA_DESKTOP_HELPER || join(skillsRoot, 'atria-desktop', 'scripts', 'desktop.js'));

function localToken(name, envName) {
  if (process.env[envName]) return process.env[envName];
  const local = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
  const file = join(local, 'Atria', `${name}.token`);
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function localHealth(port, token, timeoutMs = 800) {
  return new Promise((resolveHealth) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers: token ? { 'X-Atria-Token': token } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolveHealth({ reachable: true, httpStatus: res.statusCode, response: JSON.parse(body) });
        } catch {
          resolveHealth({ reachable: true, httpStatus: res.statusCode, error: 'non-json-health-response' });
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('health-timeout')));
    req.on('error', (error) => resolveHealth({ reachable: false, error: error.code || error.message }));
    req.end();
  });
}

function help() {
  console.log(`Atria CLI ${packageVersion}

Usage:
  atria doctor --json [--component browser|desktop|recording|visual]
                                      Check components without installing or changing configuration
  atria skills list                   List bundled capabilities
  atria browser [--standalone] ...    Start the Browser Bridge MCP server
  atria desktop ...                   Start the Windows desktop MCP server
  atria recording ...                 Alias for the desktop recording engine
  atria mcp --capability <name>       Start a capability MCP server
  atria visual status                 Read optional overlay state
  atria visual enable [--required]    Enable overlay; required blocks when unavailable
  atria visual disable                Disable overlay without disabling automation
  atria automation status [id]        Read write-session or operation state
  atria automation pause|resume|stop  Control the active interruptible operation

This private candidate contains source and adapters. Native binaries are a
separate private candidate until redistribution licensing is approved.
`);
}

async function check(selectedComponent = null) {
  const browserPort = Number(process.env.ATRIA_BROWSER_PORT || 47652);
  const desktopPort = Number(process.env.ATRIA_DESKTOP_PORT || 47653);
  const [browserHealth, desktopHealth] = await Promise.all([
    localHealth(browserPort, localToken('browser-bridge', 'ATRIA_BROWSER_AUTH_TOKEN')),
    localHealth(desktopPort, localToken('desktop-bridge', 'ATRIA_DESKTOP_AUTH_TOKEN')),
  ]);
  const browserResponse = browserHealth.response || {};
  const desktopResponse = desktopHealth.response || {};
  const browserConnected = Boolean(browserResponse.bridgeState?.extensionClientId);
  const browserCompatible = browserResponse.bridgeState?.protocolVersion == null || browserResponse.bridgeState.protocolVersion === browserResponse.protocolVersion;
  const browserAmbiguous = Array.isArray(browserResponse.clients) && browserResponse.clients.length > 1;
  const components = {
    browser: {
      sourcePresent: existsSync(browserServer),
      extensionPresent: existsSync(join(root, 'packages', 'browser-bridge', 'extension', 'manifest.json')),
      endpoint: `http://127.0.0.1:${browserPort}`,
      runtime: browserHealth.reachable ? (browserResponse.authentication === 'required' ? 'pairing-required' : browserConnected ? 'connected' : 'server-ready-extension-disconnected') : 'not-running',
      protocolVersion: browserResponse.protocolVersion ?? null,
      extensionProtocolVersion: browserResponse.bridgeState?.protocolVersion ?? null,
      compatible: browserCompatible,
      ambiguous: browserAmbiguous,
      ready: existsSync(browserServer) && browserHealth.reachable && browserResponse.authentication !== 'required' && browserConnected && browserCompatible && !browserAmbiguous,
      nextStep: !browserHealth.reachable
        ? 'Run atria browser --standalone, then pair the extension.'
        : browserResponse.authentication === 'required'
          ? 'Run atria browser --pair and paste the local token into the extension popup.'
          : !browserConnected
            ? 'Load the matching extension and open its popup.'
            : !browserCompatible
              ? 'Reload the extension version bundled with this CLI.'
              : browserAmbiguous ? 'Close the extra extension client and keep one explicitly paired client.' : null,
    },
    desktop: {
      sourcePresent: existsSync(desktopServer),
      dependenciesPresent: existsSync(recordReplayDeps),
      actorPresent: existsSync(recordReplayActor),
      endpoint: `http://127.0.0.1:${desktopPort}`,
      daemon: desktopHealth.reachable ? (desktopResponse.authentication === 'required' ? 'pairing-required' : desktopResponse.ready ? 'ready' : 'initializing') : 'not-running',
      protocolVersion: desktopResponse.protocolVersion ?? null,
      ready: existsSync(desktopServer) && existsSync(recordReplayDeps) && existsSync(recordReplayActor),
      nextStep: !existsSync(recordReplayDeps) ? 'Install only record-replay-windows dependencies.' : !existsSync(recordReplayActor) ? 'Run the native build and verify actor.exe hash.' : null,
    },
    recording: {
      sourcePresent: existsSync(desktopServer),
      recorderPresent: existsSync(recordReplayRecorder),
      ready: existsSync(desktopServer) && existsSync(recordReplayDeps) && existsSync(recordReplayRecorder),
      nextStep: !existsSync(recordReplayRecorder) ? 'Build recorder.exe from the bundled source.' : null,
    },
    visual: {
      overlayPresent: existsSync(recordReplayOverlay),
      ready: existsSync(recordReplayOverlay),
      mode: process.env.ATRIA_VISUAL_MODE || 'default',
      nextStep: existsSync(recordReplayOverlay) ? null : 'Build or install the optional visual component; no download was performed.',
    },
  };
  const sourceReady = components.browser.sourcePresent && components.desktop.sourcePresent && existsSync(skillsRoot);
  const runtimeReady = components.desktop.ready && components.recording.ready;
  const selected = selectedComponent ? components[selectedComponent] : null;
  return {
    ok: selected ? Boolean(selected.ready) : sourceReady,
    selectedComponent,
    sourceReady,
    runtimeReady,
    node: process.version,
    platform: process.platform,
    root,
    components,
    note: selectedComponent ? null : 'No component was selected; ok reports bundle source integrity. Runtime readiness is reported per component.'
  };
}

function listSkills() {
  const names = ['atria-cli-overview', 'atria-browser-bridge', 'atria-desktop', 'atria-recording', 'record-replay-windows'];
  for (const name of names) {
    console.log(`${existsSync(join(skillsRoot, name)) ? 'available' : 'missing'}\t${name}`);
  }
}

async function startServer(server, args) {
  if (!existsSync(server)) {
    console.error(`Atria component is missing: ${server}`);
    process.exitCode = 2;
    return;
  }
  if (server === desktopServer) {
    const status = await check('desktop');
    if (!status.runtimeReady) {
      console.error('Record/Replay is source-ready but not runnable yet. Install its dependencies and build native binaries; see packages/record-replay-windows/README.md.');
      process.exitCode = 2;
      return;
    }
  }
  const child = spawn(process.execPath, [server, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = typeof code === 'number' ? code : 1;
    if (signal) console.error(`Atria component stopped by ${signal}`);
  });
}

function runDesktopTool(tool, input = {}) {
  return new Promise((resolveRun) => {
    if (!existsSync(desktopHelper)) {
      console.error(`Atria desktop helper is missing: ${desktopHelper}`);
      process.exitCode = 2;
      resolveRun(2);
      return;
    }
    const child = spawn(process.execPath, [desktopHelper, tool, JSON.stringify(input)], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', (error) => {
      console.error(`Unable to start desktop helper: ${error.message}`);
      process.exitCode = 2;
      resolveRun(2);
    });
    child.once('exit', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : 1;
      if (signal) console.error(`Atria desktop helper stopped by ${signal}`);
      process.exitCode = exitCode;
      resolveRun(exitCode);
    });
  });
}

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  help();
} else if (command === '--version' || command === '-v') {
  console.log(packageVersion);
} else if (command === 'doctor') {
  const componentIndex = args.indexOf('--component');
  const selectedComponent = componentIndex >= 0 ? args[componentIndex + 1] : null;
  if (selectedComponent && !['browser', 'desktop', 'recording', 'visual'].includes(selectedComponent)) {
    console.error('Use --component browser, desktop, recording, or visual.');
    process.exitCode = 2;
  }
  const result = await check(selectedComponent);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.ok ? 'ok' : 'incomplete'}\tnode=${result.node}\tplatform=${result.platform}`);
  process.exitCode = result.ok ? 0 : 2;
} else if (command === 'skills' && args.shift() === 'list') {
  listSkills();
} else if (command === 'browser') {
  await startServer(args.includes('--pair') ? browserBridgeCli : browserServer, args);
} else if (command === 'desktop' || command === 'recording') {
  await startServer(desktopServer, args);
} else if (command === 'visual') {
  const action = args.shift();
  if (action === 'status' && args.length === 0) await runDesktopTool('visual_status');
  else if (action === 'enable' && args.every((arg) => arg === '--required')) await runDesktopTool('visual_enable', { required: args.includes('--required') });
  else if (action === 'disable' && args.length === 0) await runDesktopTool('visual_disable');
  else {
    console.error('Use atria visual status, enable [--required], or disable.');
    process.exitCode = 2;
  }
} else if (command === 'automation') {
  const action = args.shift();
  if (action === 'status' && args.length <= 1) await runDesktopTool('automation_status', args[0] ? { operationId: args[0] } : {});
  else if (['pause', 'resume', 'stop'].includes(action) && args.length === 0) await runDesktopTool(`automation_${action}`);
  else {
    console.error('Use atria automation status [operationId], pause, resume, or stop.');
    process.exitCode = 2;
  }
} else if (command === 'mcp') {
  const capabilityIndex = args.indexOf('--capability');
  const capability = capabilityIndex >= 0 ? args[capabilityIndex + 1] : undefined;
  const passthrough = capabilityIndex >= 0 ? args.filter((_, index) => index !== capabilityIndex && index !== capabilityIndex + 1) : args;
  if (capability === 'browser') await startServer(browserServer, passthrough);
  else if (capability === 'desktop' || capability === 'recording') await startServer(desktopServer, passthrough);
  else {
    console.error('Use --capability browser, desktop, or recording.');
    process.exitCode = 2;
  }
} else {
  console.error(`Unknown command: ${command}`);
  help();
  process.exitCode = 2;
}
