import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_CLIENT_LINE = 1024 * 1024;

function writeLine(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  try {
    stream.write(`${JSON.stringify(message)}\n`, "utf8");
    return true;
  } catch (_error) {
    return false;
  }
}

export function rendererReadiness(message = {}) {
  const issues = [];
  if (message.schemaVersion !== 1) issues.push("RENDERER_SCHEMA_UNSUPPORTED");
  if (message.hotkeys?.pause !== true) issues.push("PAUSE_HOTKEY_UNAVAILABLE");
  if (message.hotkeys?.stop !== true) issues.push("STOP_HOTKEY_UNAVAILABLE");
  if (message.tray?.available !== true) issues.push("TRAY_UNAVAILABLE");
  if (message.tray?.pause !== true) issues.push("TRAY_PAUSE_UNAVAILABLE");
  if (message.tray?.stop !== true) issues.push("TRAY_STOP_UNAVAILABLE");
  return {
    ready: issues.length === 0,
    usable: message.type === "renderer-ready" && message.schemaVersion === 1,
    degraded: issues.length > 0,
    issues,
  };
}

export async function startVisualBroker(options = {}) {
  const pipePath = options.pipePath;
  const token = options.token;
  if (!pipePath || !token) throw new Error("Visual broker requires pipePath and token.");

  const clients = new Map();
  const operationOwners = new Map();
  const readyTimeoutMs = Number(options.readyTimeoutMs || 10_000);
  const idleExitMs = options.idleExitMs === undefined ? 15_000 : Number(options.idleExitMs);
  let renderer = null;
  let rendererStart = null;
  let rendererStartToken = null;
  let rendererStopping = null;
  let rendererState = { ready: false, usable: false, degraded: false, issues: [], renderer: null };
  let ownerClientId = null;
  let idleTimer = null;
  let closed = false;
  let closePromise = null;
  let api;

  const spawnRenderer = options.spawnRenderer || (() => spawn(options.overlayPath, ["--stdio"], {
    cwd: path.dirname(options.overlayPath),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }));

  function clientState(clientId) {
    return {
      type: "renderer-state",
      ...rendererState,
      brokerPid: process.pid,
      owner: ownerClientId === clientId,
    };
  }

  function broadcastState() {
    for (const client of clients.values()) writeLine(client.socket, clientState(client.clientId));
  }

  function rendererKey(message) {
    const sessionId = message.sessionId || "";
    const operationId = message.operationId || "";
    const sequence = message.sequence ?? "";
    return `${sessionId}\0${operationId}\0${sequence}`;
  }

  function stopRenderer(reason = "shutdown") {
    const proc = renderer;
    renderer = null;
    rendererStart = null;
    rendererStartToken = null;
    rendererState = { ready: false, usable: false, degraded: false, issues: [], renderer: null, reason };
    operationOwners.clear();
    if (!proc) return rendererStopping;
    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    rendererStopping = stopped;
    let finished = false;
    const finishStopping = () => {
      if (finished) return;
      finished = true;
      resolveStopped();
      if (rendererStopping === stopped) rendererStopping = null;
    };
    proc.once("exit", finishStopping);
    proc.once("close", finishStopping);
    if (proc.exitCode !== null) finishStopping();
    writeLine(proc.stdin, { type: "command", command: "shutdown", reason });
    try { proc.stdin.end(); } catch (_error) {}
    const timer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try { proc.kill(); } catch (_error) {}
      }
    }, 750);
    timer.unref?.();
    return stopped;
  }

  function scheduleIdleExit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (closed || clients.size || !Number.isFinite(idleExitMs) || idleExitMs < 0) return;
    // Negative disables broker exit; zero means close on the next event-loop turn.
    if (idleExitMs === 0) {
      idleTimer = setTimeout(() => api.close(), 0);
      idleTimer.unref?.();
      return;
    }
    idleTimer = setTimeout(() => api.close(), idleExitMs);
    idleTimer.unref?.();
  }

  async function ensureRenderer() {
    if (renderer && rendererState.usable) return rendererState;
    if (rendererStart) return rendererStart;
    if (rendererStopping) await rendererStopping;
    if (renderer && rendererState.usable) return rendererState;
    if (rendererStart) return rendererStart;
    const startToken = Symbol("renderer-start");
    rendererStartToken = startToken;
    const startAttempt = new Promise((resolve, reject) => {
      let proc;
      let settled = false;
      let timer = null;
      const fail = (error, code = "VISUAL_START_FAILED") => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const normalized = error instanceof Error ? error : new Error(String(error));
        const failureState = {
          ready: false,
          usable: false,
          degraded: false,
          issues: [code],
          renderer: null,
          error: { code, message: normalized.message },
        };
        if (proc && renderer === proc) stopRenderer(code);
        rendererState = failureState;
        broadcastState();
        reject(Object.assign(normalized, { code }));
      };
      try {
        proc = spawnRenderer();
        renderer = proc;
        proc.stdin?.on("error", () => {});
        proc.stderr?.resume();
      } catch (error) {
        fail(error);
        return;
      }
      timer = setTimeout(() => {
        fail(new Error(`Visual renderer did not report ready within ${readyTimeoutMs}ms.`), "VISUAL_READY_TIMEOUT");
      }, readyTimeoutMs);
      const output = readline.createInterface({ input: proc.stdout });
      output.on("error", () => {});
      output.on("line", (line) => {
        if (renderer !== proc) return;
        let message;
        try { message = JSON.parse(line); } catch (_error) { return; }
        if (message.type === "renderer-ready") {
          const readiness = rendererReadiness(message);
          rendererState = { ...readiness, renderer: message };
          broadcastState();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(rendererState);
          }
          return;
        }
        if (message.type === "rendered") {
          const targetId = operationOwners.get(rendererKey(message));
          const target = clients.get(targetId);
          if (target) writeLine(target.socket, message);
          operationOwners.delete(rendererKey(message));
          return;
        }
        if (message.type === "control") {
          const target = clients.get(ownerClientId);
          if (target) writeLine(target.socket, message);
          return;
        }
        if (message.type === "hidden" || message.type === "status" || message.type === "rejected") {
          for (const client of clients.values()) writeLine(client.socket, message);
        }
      });
      proc.once("error", (error) => fail(error));
      proc.once("exit", (code, signal) => {
        clearTimeout(timer);
        const active = renderer === proc;
        if (active) renderer = null;
        if (rendererStartToken === startToken) {
          rendererStart = null;
          rendererStartToken = null;
        }
        if (!active) return;
        const wasUsable = rendererState.usable;
        rendererState = {
          ready: false,
          usable: false,
          degraded: false,
          issues: [wasUsable ? "VISUAL_DISCONNECTED" : "VISUAL_START_FAILED"],
          renderer: null,
          error: {
            code: wasUsable ? "VISUAL_DISCONNECTED" : "VISUAL_START_FAILED",
            message: `Visual renderer exited with code=${code} signal=${signal}.`,
          },
        };
        operationOwners.clear();
        broadcastState();
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error(rendererState.error.message), { code: rendererState.error.code }));
        }
      });
    });
    const ownedStart = startAttempt.finally(() => {
      if (rendererStartToken === startToken && !rendererState.usable) {
        rendererStart = null;
        rendererStartToken = null;
      }
    });
    if (rendererStartToken === startToken) rendererStart = ownedStart;
    return ownedStart;
  }

  function removeClient(socket) {
    const client = [...clients.values()].find((entry) => entry.socket === socket);
    if (!client) return;
    clients.delete(client.clientId);
    if (ownerClientId === client.clientId) ownerClientId = null;
    for (const [key, clientId] of operationOwners) {
      if (clientId === client.clientId) operationOwners.delete(key);
    }
    if (!clients.size) {
      stopRenderer("no-clients");
      scheduleIdleExit();
    } else {
      broadcastState();
    }
  }

  function handleConnection(socket) {
    let authenticated = false;
    let bufferedBytes = 0;
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => {});
    lines.on("line", async (line) => {
      bufferedBytes += Buffer.byteLength(line, "utf8");
      if (bufferedBytes > MAX_CLIENT_LINE) {
        socket.destroy();
        return;
      }
      bufferedBytes = 0;
      let message;
      try { message = JSON.parse(line); } catch (_error) { socket.destroy(); return; }
      if (!authenticated) {
        if (message.type !== "hello" || message.token !== token || typeof message.clientId !== "string") {
          socket.destroy();
          return;
        }
        authenticated = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        const previous = clients.get(message.clientId);
        if (previous && previous.socket !== socket) previous.socket.destroy();
        clients.set(message.clientId, { clientId: message.clientId, socket, connectedAt: Date.now() });
        try {
          await ensureRenderer();
          writeLine(socket, clientState(message.clientId));
        } catch (_error) {
          writeLine(socket, clientState(message.clientId));
        }
        return;
      }
      const client = [...clients.values()].find((entry) => entry.socket === socket);
      if (!client) return;
      if (message.type === "claim") {
        ownerClientId = client.clientId;
        broadcastState();
      } else if (message.type === "action/event" && rendererState.usable && renderer) {
        ownerClientId = client.clientId;
        operationOwners.set(rendererKey(message.event || {}), client.clientId);
        writeLine(renderer.stdin, { type: "action/event", event: message.event });
        broadcastState();
      } else if (message.type === "release") {
        socket.end();
      }
    });
    socket.once("close", () => removeClient(socket));
    socket.on("error", () => removeClient(socket));
  }

  if (process.platform !== "win32") {
    try { fs.unlinkSync(pipePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const server = net.createServer(handleConnection);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  api = {
    pipePath,
    get rendererProcess() { return renderer; },
    get clientCount() { return clients.size; },
    get ownerClientId() { return ownerClientId; },
    disconnectClient(clientId) { clients.get(clientId)?.socket.destroy(); },
    writeRenderer(message) { return writeLine(renderer?.stdin, message); },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        for (const client of clients.values()) client.socket.destroy();
        clients.clear();
        const rendererStopped = stopRenderer("broker-close");
        await Promise.all([
          rendererStopped,
          new Promise((resolve) => server.close(() => resolve())),
        ]);
        if (process.platform !== "win32") {
          try { fs.unlinkSync(pipePath); } catch (_error) {}
        }
      })();
      return closePromise;
    },
  };
  scheduleIdleExit();
  return api;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const pipePath = readArg("--pipe");
  const tokenPath = readArg("--token-file");
  const overlayPath = readArg("--overlay");
  if (!pipePath || !tokenPath || !overlayPath) throw new Error("Missing visual broker arguments.");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  try {
    await startVisualBroker({ pipePath, token, overlayPath });
  } catch (error) {
    if (error?.code === "EADDRINUSE") return;
    throw error;
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => { process.exitCode = 1; });
}
