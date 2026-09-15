import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { pluginPath } from "./plugin-path.mjs";
import { startVisualBroker } from "./visual-broker.mjs";
import { defaultVisualIpc, ensureVisualBrokerToken } from "./visual-ipc.mjs";

const MODES = new Set(["on", "required", "off"]);
const BROKER_MODULE = fileURLToPath(new URL("./visual-broker.mjs", import.meta.url));

export function defaultOverlayPath() {
  const packaged = pluginPath("bin", "overlay.exe");
  if (fs.existsSync(packaged)) return packaged;
  return pluginPath("native", "recorder", "target", "release", "overlay.exe");
}

export class VisualUnavailableError extends Error {
  constructor(message, code = "VISUAL_UNAVAILABLE") {
    super(message);
    this.name = "VisualUnavailableError";
    this.code = code;
  }
}

export class VisualController {
  constructor(options = {}) {
    const requestedMode = String(options.mode || process.env.ATRIA_VISUAL_MODE || "off").toLowerCase();
    const ipc = defaultVisualIpc();
    this.mode = MODES.has(requestedMode) ? requestedMode : "off";
    this.overlayPath = options.overlayPath || defaultOverlayPath();
    this.brokerPipePath = options.brokerPipePath || ipc.pipePath;
    this.brokerTokenPath = options.brokerTokenPath || ipc.tokenPath;
    this.brokerToken = options.brokerToken || ensureVisualBrokerToken(this.brokerTokenPath);
    this.launchBroker = options.launchBroker !== false;
    this.spawnBroker = options.spawnBroker || null;
    this.spawnRenderer = options.spawnRenderer || null;
    this.readyTimeoutMs = Number(options.readyTimeoutMs || 10_000);
    this.reconnectDelayMs = Number(options.reconnectDelayMs || 75);
    this.clientId = options.clientId || randomUUID();
    this.socket = null;
    this.ready = false;
    this.usable = false;
    this.degraded = false;
    this.issues = [];
    this.owner = false;
    this.brokerPid = null;
    this.startPromise = null;
    this.hardFailure = null;
    this.lastError = null;
    this.startedAt = null;
    this.rendererInfo = null;
    this.rendered = [];
    this.controlHandler = null;
    this.reconnectTimer = null;
    this.explicitlyClosed = false;
    this.embeddedBrokerStart = null;
  }

  setControlHandler(handler) {
    this.controlHandler = handler;
  }

  available() {
    return !this.launchBroker || Boolean(this.spawnRenderer) || fs.existsSync(this.overlayPath);
  }

  isRunning() {
    return Boolean(this.socket && !this.socket.destroyed && this.usable);
  }

  setMode(mode) {
    const normalized = String(mode || "").toLowerCase();
    if (!MODES.has(normalized)) throw new Error(`Unknown visual mode: ${mode}`);
    this.mode = normalized;
    if (normalized === "off") this.close();
    else this.explicitlyClosed = false;
    if (normalized !== "required") this.hardFailure = null;
    return this.status();
  }

  handleBrokerMessage(message = {}) {
    if (message.type === "renderer-state") {
      this.ready = Boolean(message.ready);
      this.usable = Boolean(message.usable);
      this.degraded = Boolean(message.degraded);
      this.issues = Array.isArray(message.issues) ? message.issues : [];
      this.owner = Boolean(message.owner);
      this.brokerPid = message.brokerPid || this.brokerPid;
      this.rendererInfo = message.renderer || null;
      if (message.error) {
        this.lastError = message.error;
        if (this.mode === "required" && message.error.code === "VISUAL_DISCONNECTED") {
          this.hardFailure = message.error;
        }
      } else if (this.usable && this.lastError?.code === "VISUAL_BROKER_DISCONNECTED") {
        this.lastError = null;
      }
    } else if (message.type === "rendered") {
      this.rendered.push(message);
      if (this.rendered.length > 2048) this.rendered.splice(0, this.rendered.length - 2048);
    } else if (message.type === "control" && this.controlHandler) {
      Promise.resolve(this.controlHandler(message.command)).catch(() => {});
    }
  }

  launchBrokerProcess() {
    if (!this.available()) {
      throw new VisualUnavailableError(`Visual renderer not found at ${this.overlayPath}.`, "VISUAL_BINARY_MISSING");
    }
    if (this.spawnBroker) {
      this.spawnBroker({
        pipePath: this.brokerPipePath,
        tokenPath: this.brokerTokenPath,
        token: this.brokerToken,
        overlayPath: this.overlayPath,
      });
      return;
    }
    if (this.spawnRenderer) {
      this.embeddedBrokerStart ||= startVisualBroker({
        pipePath: this.brokerPipePath,
        token: this.brokerToken,
        spawnRenderer: this.spawnRenderer,
        readyTimeoutMs: this.readyTimeoutMs,
        idleExitMs: 100,
      }).catch((error) => {
        if (error?.code !== "EADDRINUSE") throw error;
        return null;
      });
      this.embeddedBrokerStart.catch(() => {});
      return;
    }
    const proc = spawn(process.execPath, [
      BROKER_MODULE,
      "--pipe", this.brokerPipePath,
      "--token-file", this.brokerTokenPath,
      "--overlay", this.overlayPath,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    proc.once("error", () => {});
    proc.unref();
  }

  connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.brokerPipePath);
      let settled = false;
      let connected = false;
      let lines;
      const finish = (error, state) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          if (error.code !== "VISUAL_CONTROL_DEGRADED") {
            lines?.close();
            socket.destroy();
          }
          reject(error);
        } else {
          resolve(state);
        }
      };
      const timer = setTimeout(() => finish(new VisualUnavailableError(
        `Visual broker did not report renderer state within ${timeoutMs}ms.`,
        "VISUAL_READY_TIMEOUT",
      )), timeoutMs);
      lines = readline.createInterface({ input: socket });
      lines.on("error", () => {});
      socket.once("connect", () => {
        connected = true;
        this.socket = socket;
        this.startedAt ||= new Date().toISOString();
        socket.write(`${JSON.stringify({
          type: "hello",
          token: this.brokerToken,
          clientId: this.clientId,
          mode: this.mode,
        })}\n`, "utf8");
      });
      lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch (_error) { return; }
        this.handleBrokerMessage(message);
        if (message.type !== "renderer-state" || settled) return;
        if (message.usable) {
          if (this.mode === "required" && !message.ready) {
            const error = new VisualUnavailableError(
              `Visual controls are degraded: ${(message.issues || []).join(", ") || "unknown readiness failure"}.`,
              "VISUAL_CONTROL_DEGRADED",
            );
            this.lastError = { code: error.code, message: error.message };
            this.hardFailure = this.lastError;
            finish(error);
          } else {
            finish(null, { ready: Boolean(message.ready), usable: true, degraded: Boolean(message.degraded), issues: message.issues || [] });
          }
        } else if (message.error) {
          finish(new VisualUnavailableError(message.error.message, message.error.code));
        }
      });
      socket.on("error", (error) => {
        if (!connected) finish(error);
      });
      socket.once("close", () => {
        lines.close();
        if (!settled) finish(new VisualUnavailableError("Visual broker disconnected during startup.", "VISUAL_BROKER_DISCONNECTED"));
        if (this.socket !== socket) return;
        this.socket = null;
        this.ready = false;
        this.usable = false;
        this.owner = false;
        if (!this.explicitlyClosed && this.mode !== "off") {
          this.lastError = { code: "VISUAL_BROKER_DISCONNECTED", message: "Visual broker connection was lost; reconnecting." };
          this.scheduleReconnect();
        }
      });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.explicitlyClosed || this.mode === "off") return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch(() => {});
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  async start() {
    if (this.mode === "off") return { ready: false, usable: false, mode: "off" };
    if (this.hardFailure && this.mode === "required") {
      throw new VisualUnavailableError(this.hardFailure.message, this.hardFailure.code);
    }
    this.explicitlyClosed = false;
    if (this.isRunning()) {
      return { ready: this.ready, usable: true, degraded: this.degraded, issues: this.issues };
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const deadline = Date.now() + this.readyTimeoutMs;
      let launched = false;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const state = await this.connectOnce(Math.max(50, deadline - Date.now()));
          return state;
        } catch (error) {
          lastError = error;
          const retryable = ["ENOENT", "ECONNREFUSED", "EPIPE", "VISUAL_BROKER_DISCONNECTED"].includes(error?.code);
          if (!retryable) throw error;
          if (!launched && this.launchBroker) {
            this.launchBrokerProcess();
            launched = true;
          }
          await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs));
        }
      }
      throw lastError || new VisualUnavailableError("Visual broker connection timed out.", "VISUAL_READY_TIMEOUT");
    })().catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lastError = { code: normalized.code || "VISUAL_START_FAILED", message: normalized.message };
      if (this.mode === "required") this.hardFailure = this.lastError;
      throw normalized;
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async beforeAction() {
    if (this.mode === "off") return { ready: false, usable: false, mode: "off" };
    if (this.hardFailure && this.mode === "required") {
      throw new VisualUnavailableError(this.hardFailure.message, this.hardFailure.code);
    }
    try {
      const state = await this.start();
      this.socket?.write(`${JSON.stringify({ type: "claim" })}\n`, "utf8");
      return state;
    } catch (error) {
      if (this.mode === "required") throw error;
      return { ready: false, usable: false, mode: this.mode, error: this.lastError };
    }
  }

  handleEvent(event) {
    if (this.mode === "off" || !this.isRunning()) return false;
    try {
      this.socket.write(`${JSON.stringify({ type: "action/event", event })}\n`, "utf8");
      return true;
    } catch (error) {
      this.lastError = { code: "VISUAL_WRITE_FAILED", message: error.message };
      if (this.mode === "required") this.hardFailure = this.lastError;
      return false;
    }
  }

  status() {
    return {
      mode: this.mode,
      available: this.available(),
      running: this.isRunning(),
      ready: this.ready,
      usable: this.usable,
      degraded: this.degraded,
      issues: this.issues,
      owner: this.owner,
      brokerConnected: Boolean(this.socket && !this.socket.destroyed),
      brokerPid: this.brokerPid,
      clientId: this.clientId,
      rendererPath: this.overlayPath,
      renderer: this.rendererInfo,
      startedAt: this.startedAt,
      renderedCount: this.rendered.length,
      lastRendered: this.rendered.at(-1) || null,
      error: this.lastError,
    };
  }

  close() {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.usable = false;
    this.owner = false;
    if (!socket) return;
    try { socket.write(`${JSON.stringify({ type: "release" })}\n`, "utf8"); } catch (_error) {}
    try { socket.end(); } catch (_error) {}
    const timer = setTimeout(() => socket.destroy(), 250);
    timer.unref?.();
  }

  async dispose() {
    this.close();
    const broker = await this.embeddedBrokerStart?.catch(() => null);
    await broker?.close();
  }
}
