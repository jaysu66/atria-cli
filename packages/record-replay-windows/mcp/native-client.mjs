import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

import { pluginPath } from "./plugin-path.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DURATION_SECONDS = 1800;

export function defaultSessionRoot() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "EventStream", "sessions");
}

export function defaultNativePath() {
  const built = pluginPath("bin", "recorder.exe");
  if (fs.existsSync(built)) return built;
  return pluginPath("native", "recorder", "target", "release", "recorder.exe");
}

export class NativeRecorderClient {
  constructor(options = {}) {
    this.nativePath = options.nativePath || defaultNativePath();
    this.sessionRoot = options.sessionRoot || defaultSessionRoot();
    this.proc = null;
    this.pending = new Map();
    this.stderr = "";
  }

  isStarted() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  ensureStarted() {
    if (this.isStarted()) return;
    if (!fs.existsSync(this.nativePath)) {
      throw new Error(`Native recorder not found at ${this.nativePath}. Run npm run build:native first.`);
    }
    fs.mkdirSync(this.sessionRoot, { recursive: true });
    this.proc = spawn(this.nativePath, ["--stdio"], {
      cwd: path.dirname(this.nativePath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.proc.on("exit", (code, signal) => {
      const error = new Error(`Native recorder exited with code=${code} signal=${signal}. ${this.stderr}`.trim());
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.proc = null;
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Native recorder request failed"));
    });
  }

  idleStatus(extra = {}) {
    return {
      isRecording: false,
      maxDurationSeconds: extra.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
      ...extra,
    };
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.ensureStarted();
    const id = crypto.randomUUID();
    const body = { id, method, params: { sessionRoot: this.sessionRoot, ...params } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native recorder ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify(body)}\n`, "utf8");
    });
  }

  start(params = {}) {
    return this.request("start", params);
  }

  async status(params = {}) {
    if (!this.isStarted()) return this.idleStatus();
    const result = await this.request("status", params);
    if (!result?.isRecording) this.close();
    return result;
  }

  async stop(params = {}) {
    if (!this.isStarted()) {
      return this.idleStatus({
        endReason: "no_active_recording",
      });
    }
    const result = await this.request("stop", params, 60_000);
    if (!result?.isRecording) this.close();
    return result;
  }

  close() {
    const proc = this.proc;
    if (!proc) return;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Native recorder client closed."));
    }
    this.pending.clear();
    this.proc = null;
    try {
      proc.stdin?.end();
    } catch (_error) {
    }
    if (!proc.killed && proc.exitCode === null) {
      try {
        proc.kill();
      } catch (_error) {
      }
    }
  }
}
