import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { pluginPath } from "./plugin-path.mjs";

const MODES = new Set(["on", "required", "off"]);

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
    this.mode = MODES.has(requestedMode) ? requestedMode : "off";
    this.overlayPath = options.overlayPath || defaultOverlayPath();
    this.spawnRenderer = options.spawnRenderer || null;
    this.readyTimeoutMs = Number(options.readyTimeoutMs || 10_000);
    this.proc = null;
    this.ready = false;
    this.startPromise = null;
    this.hardFailure = null;
    this.lastError = null;
    this.startedAt = null;
    this.rendererInfo = null;
    this.rendered = [];
    this.stderr = "";
    this.controlHandler = null;
  }

  setControlHandler(handler) {
    this.controlHandler = handler;
  }

  available() {
    return Boolean(this.spawnRenderer) || fs.existsSync(this.overlayPath);
  }

  isRunning() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  setMode(mode) {
    const normalized = String(mode || "").toLowerCase();
    if (!MODES.has(normalized)) throw new Error(`Unknown visual mode: ${mode}`);
    this.mode = normalized;
    if (normalized === "off") this.close();
    if (normalized !== "required") this.hardFailure = null;
    return this.status();
  }

  handleRendererMessage(message = {}) {
    if (message.type === "renderer-ready") {
      this.ready = true;
      this.rendererInfo = message;
    } else if (message.type === "rendered") {
      this.rendered.push(message);
      if (this.rendered.length > 2048) this.rendered.splice(0, this.rendered.length - 2048);
    } else if (message.type === "control" && this.controlHandler) {
      Promise.resolve(this.controlHandler(message.command)).catch(() => {});
    }
  }

  async start() {
    if (this.mode === "off") return { ready: false, mode: "off" };
    if (this.ready && this.isRunning()) return { ready: true, ...this.rendererInfo };
    if (this.startPromise) return this.startPromise;
    if (!this.available()) {
      const error = new VisualUnavailableError(`Visual renderer not found at ${this.overlayPath}.`, "VISUAL_BINARY_MISSING");
      this.lastError = { code: error.code, message: error.message };
      if (this.mode === "required") this.hardFailure = this.lastError;
      throw error;
    }

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.lastError = { code: normalized.code || "VISUAL_START_FAILED", message: normalized.message };
        if (this.mode === "required") this.hardFailure = this.lastError;
        if (!settled) {
          settled = true;
          reject(normalized);
        }
      };
      try {
        this.proc = this.spawnRenderer
          ? this.spawnRenderer()
          : spawn(this.overlayPath, ["--stdio"], {
              cwd: path.dirname(this.overlayPath),
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
      } catch (error) {
        fail(error);
        return;
      }
      this.startedAt = new Date().toISOString();
      this.stderr = "";
      const timer = setTimeout(() => fail(new VisualUnavailableError(
        `Visual renderer did not report ready within ${this.readyTimeoutMs}ms.`,
        "VISUAL_READY_TIMEOUT",
      )), this.readyTimeoutMs);
      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch (_error) { return; }
        this.handleRendererMessage(message);
        if (message.type === "renderer-ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ready: true, ...message });
        }
      });
      this.proc.stderr.on("data", (chunk) => {
        this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
      });
      this.proc.once("error", fail);
      this.proc.once("exit", (code, signal) => {
        clearTimeout(timer);
        const wasReady = this.ready;
        this.ready = false;
        this.proc = null;
        const error = new VisualUnavailableError(
          `Visual renderer exited with code=${code} signal=${signal}.`,
          wasReady ? "VISUAL_DISCONNECTED" : "VISUAL_START_FAILED",
        );
        this.lastError = { code: error.code, message: error.message };
        if (this.mode === "required") this.hardFailure = this.lastError;
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async beforeAction() {
    if (this.mode === "off") return { ready: false, mode: "off" };
    if (this.hardFailure && this.mode === "required") {
      throw new VisualUnavailableError(this.hardFailure.message, this.hardFailure.code);
    }
    try {
      return await this.start();
    } catch (error) {
      if (this.mode === "required") throw error;
      return { ready: false, mode: this.mode, error: this.lastError };
    }
  }

  handleEvent(event) {
    if (this.mode === "off" || !this.ready || !this.isRunning()) return false;
    try {
      this.proc.stdin.write(`${JSON.stringify({ type: "action/event", event })}\n`, "utf8");
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
      rendererPath: this.overlayPath,
      renderer: this.rendererInfo,
      startedAt: this.startedAt,
      renderedCount: this.rendered.length,
      lastRendered: this.rendered.at(-1) || null,
      error: this.lastError,
    };
  }

  close() {
    const proc = this.proc;
    this.ready = false;
    this.proc = null;
    if (!proc) return;
    try { proc.stdin.write(`${JSON.stringify({ type: "command", command: "shutdown" })}\n`, "utf8"); } catch (_error) {}
    try { proc.stdin.end(); } catch (_error) {}
    const timer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try { proc.kill(); } catch (_error) {}
      }
    }, 750);
    timer.unref?.();
  }
}

