#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserServer = join(root, 'packages', 'browser-bridge', 'mcp-server.js');
const desktopServer = join(root, 'packages', 'record-replay-windows', 'mcp', 'server.mjs');
const recordReplayPackage = join(root, 'packages', 'record-replay-windows');
const recordReplayDeps = join(recordReplayPackage, 'node_modules');
const recordReplayActor = join(recordReplayPackage, 'bin', 'actor.exe');
const recordReplayRecorder = join(recordReplayPackage, 'bin', 'recorder.exe');
const skillsRoot = join(root, 'skills');

function help() {
  console.log(`Atria CLI 0.1.0-public-preview

Usage:
  atria doctor --json                 Check the local bundle and runtime
  atria skills list                   List bundled capabilities
  atria browser [--standalone] ...    Start the Browser Bridge MCP server
  atria desktop ...                   Start the Windows desktop MCP server
  atria recording ...                 Alias for the desktop recording engine
  atria mcp --capability <name>       Start a capability MCP server

The public preview contains source and adapters. Native binaries and dependencies
are built or installed locally from the component instructions.
`);
}

function check() {
  const components = {
    browserBridge: existsSync(browserServer),
    recordReplaySource: existsSync(desktopServer),
    recordReplayDependencies: existsSync(recordReplayDeps),
    recordReplayNative: existsSync(recordReplayActor) && existsSync(recordReplayRecorder),
    skills: existsSync(skillsRoot)
  };
  const sourceReady = components.browserBridge && components.recordReplaySource && components.skills;
  const runtimeReady = components.recordReplayDependencies && components.recordReplayNative;
  return {
    ok: sourceReady && runtimeReady,
    sourceReady,
    runtimeReady,
    node: process.version,
    platform: process.platform,
    root,
    components
  };
}

function listSkills() {
  const names = ['atria-cli-overview', 'atria-browser-bridge', 'atria-desktop', 'atria-recording', 'record-replay-windows'];
  for (const name of names) {
    console.log(`${existsSync(join(skillsRoot, name)) ? 'available' : 'missing'}\t${name}`);
  }
}

function startServer(server, args) {
  if (!existsSync(server)) {
    console.error(`Atria component is missing: ${server}`);
    process.exitCode = 2;
    return;
  }
  if (server === desktopServer) {
    const status = check();
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

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  help();
} else if (command === '--version' || command === '-v') {
  console.log('0.1.0-public-preview');
} else if (command === 'doctor') {
  const result = check();
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.ok ? 'ok' : 'incomplete'}\tnode=${result.node}\tplatform=${result.platform}`);
  process.exitCode = result.ok ? 0 : 2;
} else if (command === 'skills' && args.shift() === 'list') {
  listSkills();
} else if (command === 'browser') {
  startServer(browserServer, args);
} else if (command === 'desktop' || command === 'recording') {
  startServer(desktopServer, args);
} else if (command === 'mcp') {
  const capabilityIndex = args.indexOf('--capability');
  const capability = capabilityIndex >= 0 ? args[capabilityIndex + 1] : undefined;
  const passthrough = capabilityIndex >= 0 ? args.filter((_, index) => index !== capabilityIndex && index !== capabilityIndex + 1) : args;
  if (capability === 'browser') startServer(browserServer, passthrough);
  else if (capability === 'desktop' || capability === 'recording') startServer(desktopServer, passthrough);
  else {
    console.error('Use --capability browser, desktop, or recording.');
    process.exitCode = 2;
  }
} else {
  console.error(`Unknown command: ${command}`);
  help();
  process.exitCode = 2;
}
