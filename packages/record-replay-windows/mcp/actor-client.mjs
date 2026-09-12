import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

import { pluginPath } from "./plugin-path.mjs";

// actor-client.mjs — batch-I:actor.exe(自有执行引擎)的 stdio JSON-RPC 客户端。
// 与 native-client.mjs(recorder)同协议同模式:懒启动、请求超时、崩溃后下次调用自动重启。

const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultActorPath() {
  const built = pluginPath("bin", "actor.exe");
  if (fs.existsSync(built)) return built;
  return pluginPath("native", "recorder", "target", "release", "actor.exe");
}

export class NativeActorClient {
  constructor(options = {}) {
    this.nativePath = options.nativePath || defaultActorPath();
    this.proc = null;
    this.pending = new Map();
    this.stderr = "";
  }

  isStarted() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  available() {
    return fs.existsSync(this.nativePath);
  }

  ensureStarted() {
    if (this.isStarted()) return;
    if (!fs.existsSync(this.nativePath)) {
      throw new Error(`Native actor not found at ${this.nativePath}. Run npm run build:native first.`);
    }
    this.proc = spawn(this.nativePath, ["--stdio"], {
      cwd: path.dirname(this.nativePath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.proc.on("exit", (code, signal) => {
      const error = new Error(`Native actor exited with code=${code} signal=${signal}. ${this.stderr}`.trim());
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
      else pending.reject(new Error(message.error || "Native actor request failed"));
    });
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.ensureStarted();
    const id = crypto.randomUUID();
    const body = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native actor ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify(body)}\n`, "utf8");
    });
  }

  screenshot(params = {}) {
    return this.request("screenshot", params);
  }

  click(params = {}) {
    return this.request("click", params);
  }

  typeText(params = {}) {
    // 长文本按字符 8ms 节流,超时按文本长度放大。
    const budget = Math.max(DEFAULT_TIMEOUT_MS, String(params.text || "").length * 25 + 5000);
    return this.request("type_text", params, budget);
  }

  key(params = {}) {
    return this.request("key", params);
  }

  windowList() {
    return this.request("window_list", {});
  }

  windowFocus(params = {}) {
    return this.request("window_focus", params);
  }

  uiaFind(params = {}) {
    const budget = Math.max(DEFAULT_TIMEOUT_MS, Number(params.timeoutMs || 3000) + 10_000);
    return this.request("uia_find", params, budget);
  }

  uiaInvoke(params = {}) {
    const budget = Math.max(DEFAULT_TIMEOUT_MS, Number(params.timeoutMs || 3000) + 10_000);
    return this.request("uia_invoke", params, budget);
  }

  mouseMove(params = {}) {
    return this.request("mouse_move", params);
  }

  drag(params = {}) {
    const budget = Math.max(DEFAULT_TIMEOUT_MS, Number(params.durationMs || 400) + 10_000);
    return this.request("drag", params, budget);
  }

  scroll(params = {}) {
    return this.request("scroll", params);
  }

  uiSnapshot(params = {}) {
    return this.request("ui_snapshot", params, 20_000);
  }

  uiWaitFor(params = {}) {
    const budget = Number(params.timeoutMs || 8000) + 10_000;
    return this.request("ui_wait_for", params, budget);
  }

  cursor() {
    return this.request("cursor", {});
  }

  close() {
    const proc = this.proc;
    if (!proc) return;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Native actor client closed."));
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
