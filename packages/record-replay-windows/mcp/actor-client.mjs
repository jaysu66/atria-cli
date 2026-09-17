import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

import { pluginPath } from "./plugin-path.mjs";

// actor-client.mjs — batch-I:actor.exe(自有执行引擎)的 stdio JSON-RPC 客户端。
// 与 native-client.mjs(recorder)同协议同模式:懒启动、请求超时、崩溃后下次调用自动重启。

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OPERATIONS = 256;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(method, params) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ method, params }))).digest("hex");
}

function markOperationSafe(operation, reason) {
  if (!operation || operation.safe) return;
  operation.safe = true;
  operation.safeAt = Date.now();
  operation.safeReason = reason;
  operation.resolveSafety?.({ operationId: operation.id, safe: true, reason });
}

export class NativeOperationError extends Error {
  constructor(code, message, operationId, status = "failed") {
    super(message);
    this.name = "NativeOperationError";
    this.code = code;
    this.operationId = operationId;
    this.status = status;
  }
}

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
    this.spawnActor = options.spawnActor || null;
    this.maxOperations = Number(options.maxOperations || DEFAULT_MAX_OPERATIONS);
    this.actorBootId = null;
    this.operations = new Map();
    this.eventListeners = new Set();
    this.closing = false;
    this.controlState = "running";
    this.controlPath = options.controlPath || path.join(os.tmpdir(), `atria-actor-control-${process.pid}-${crypto.randomUUID()}.txt`);
  }

  isStarted() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  createOperationId() {
    this.ensureStarted();
    return `${this.actorBootId}:${crypto.randomUUID()}`;
  }

  available() {
    return Boolean(this.spawnActor) || fs.existsSync(this.nativePath);
  }

  ensureStarted() {
    if (this.isStarted()) return;
    if (!this.spawnActor && !fs.existsSync(this.nativePath)) {
      throw new Error(`Native actor not found at ${this.nativePath}. Run npm run build:native first.`);
    }
    const spawnedBootId = crypto.randomUUID();
    this.actorBootId = spawnedBootId;
    this.closing = false;
    this.stderr = "";
    this.setControl(this.controlState);
    const spawnedProc = this.spawnActor
      ? this.spawnActor()
      : spawn(this.nativePath, ["--stdio"], {
          cwd: path.dirname(this.nativePath),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
    this.proc = spawnedProc;
    let processStderr = "";
    spawnedProc.stderr.on("data", (chunk) => {
      processStderr += chunk.toString();
      if (this.proc === spawnedProc) this.stderr = processStderr;
    });
    spawnedProc.on("exit", (code, signal) => {
      for (const [operationId, pending] of this.pending) {
        if (pending.operation.bootId !== spawnedBootId) continue;
        const error = new NativeOperationError(
          "ACTOR_EXITED",
          `Native actor exited with code=${code} signal=${signal}. The dispatched operation outcome is unknown. ${processStderr}`.trim(),
          pending.operation.id,
          "unknown",
        );
        clearTimeout(pending.timer);
        pending.operation.state = "unknown";
        pending.operation.error = error;
        pending.operation.settledAt = Date.now();
        markOperationSafe(pending.operation, "actor_process_exited");
        if (pending.operation.promisePending) {
          pending.operation.promisePending = false;
          pending.reject(error);
        }
        this.pending.delete(operationId);
      }
      if (this.proc === spawnedProc) this.proc = null;
    });
    const rl = readline.createInterface({ input: spawnedProc.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return;
      }
      if (message.method === "action/event" && message.params) {
        for (const listener of this.eventListeners) {
          try { listener(message.params); } catch (_error) {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.operation.settledAt = Date.now();
      markOperationSafe(pending.operation, "native_response_received");
      if (message.ok) {
        pending.operation.state = "succeeded";
        pending.operation.result = message.result;
        if (pending.operation.promisePending) {
          pending.operation.promisePending = false;
          pending.resolve(message.result);
        }
      } else {
        const nativeCode = String(message.error || "").match(/\b([A-Z][A-Z0-9_]{2,})\b/)?.[1] || "ACTOR_FAILED";
        const status = nativeCode === "ACTION_STOPPED" || nativeCode === "ACTION_PAUSED" || nativeCode === "REQUEST_EXPIRED"
          ? "cancelled"
          : "failed";
        const error = new NativeOperationError(nativeCode, message.error || "Native actor request failed", pending.operation.id, status);
        pending.operation.state = status;
        pending.operation.error = error;
        if (pending.operation.promisePending) {
          pending.operation.promisePending = false;
          pending.reject(error);
        }
      }
    });
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    const {
      operationId: inlineOperationId,
      sessionId: inlineSessionId,
      parentOperationId,
      stepIndex,
      ...nativeParams
    } = params || {};
    const explicitOperationId = options.operationId || inlineOperationId || null;
    const currentFingerprint = fingerprint(method, nativeParams);
    const existing = explicitOperationId ? this.operations.get(explicitOperationId) : null;
    if (existing) {
      if (existing.fingerprint !== currentFingerprint) {
        return Promise.reject(new NativeOperationError(
          "IDEMPOTENCY_CONFLICT",
          "The same operationId was reused with different actor arguments.",
          explicitOperationId,
        ));
      }
      if (existing.promisePending) return existing.promise;
      if (existing.state === "succeeded") return Promise.resolve(existing.result);
      return Promise.reject(existing.error || new NativeOperationError(
        "EXECUTION_UNKNOWN",
        "The actor operation is retained with an unknown outcome; query it instead of retrying.",
        explicitOperationId,
        existing.state === "unknown" ? "unknown" : "failed",
      ));
    }
    this.ensureStarted();
    const id = explicitOperationId || `${this.actorBootId}:${crypto.randomUUID()}`;
    if (!id.startsWith(`${this.actorBootId}:`)) {
      return Promise.reject(new NativeOperationError(
        "BOOT_MISMATCH",
        "The operationId belongs to an expired actor process; it will not be re-executed.",
        id,
      ));
    }
    if (this.operations.size >= this.maxOperations) {
      return Promise.reject(new NativeOperationError(
        "CAPACITY_REACHED",
        "Native actor operation capacity reached for this process; new work is refused to preserve idempotency.",
        id,
      ));
    }
    const operation = {
      id,
      bootId: this.actorBootId,
      method,
      fingerprint: currentFingerprint,
      state: "dispatched",
      createdAt: Date.now(),
      settledAt: null,
      result: null,
      error: null,
      promisePending: true,
      promise: null,
      safe: false,
      safeAt: null,
      safeReason: null,
      safetyPromise: null,
      resolveSafety: null,
    };
    operation.safetyPromise = new Promise((resolve) => {
      operation.resolveSafety = resolve;
    });
    const deadlineAtUnixMs = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const body = {
      id,
      method,
      params: {
        ...nativeParams,
        _atria: {
          bootId: this.actorBootId,
          sessionId: options.sessionId || inlineSessionId || "default",
          operationId: id,
          deadlineAtUnixMs,
          ...(parentOperationId ? { parentOperationId } : {}),
          ...(Number.isInteger(stepIndex) ? { stepIndex } : {}),
          controlPath: this.controlPath,
        },
      },
    };
    operation.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || !operation.promisePending) return;
        operation.promisePending = false;
        operation.state = "unknown";
        operation.settledAt = Date.now();
        operation.error = new NativeOperationError(
          "EXECUTION_TIMEOUT",
          `Native actor ${method} timed out after ${timeoutMs}ms; input may already have been dispatched.`,
          id,
          "unknown",
        );
        reject(operation.error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation });
      this.proc.stdin.write(`${JSON.stringify(body)}\n`, "utf8");
    });
    this.operations.set(id, operation);
    return operation.promise;
  }

  operationStatus(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    return {
      operationId: operation.id,
      bootId: this.actorBootId,
      method: operation.method,
      state: operation.state,
      createdAt: new Date(operation.createdAt).toISOString(),
      settledAt: operation.settledAt ? new Date(operation.settledAt).toISOString() : null,
      result: operation.result,
      error: operation.error ? { code: operation.error.code, message: operation.error.message, status: operation.error.status } : null,
      safe: operation.safe,
      safeAt: operation.safeAt ? new Date(operation.safeAt).toISOString() : null,
      safeReason: operation.safeReason,
    };
  }

  waitForOperationSafety(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) return Promise.resolve({ operationId, safe: true, reason: "operation_not_dispatched" });
    if (operation.safe) {
      return Promise.resolve({ operationId, safe: true, reason: operation.safeReason });
    }
    return operation.safetyPromise;
  }

  addEventListener(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  setControl(state) {
    this.controlState = state;
    if (state === "running") {
      try { fs.rmSync(`${this.controlPath}.ack`, { force: true }); } catch (_error) {}
    }
    fs.writeFileSync(this.controlPath, String(state), "utf8");
    return { state, requestedAt: new Date().toISOString() };
  }

  async waitForControlAck(state, timeoutMs = 500) {
    if (this.pending.size === 0) {
      return { acknowledged: true, acknowledgedAt: new Date().toISOString(), idle: true };
    }
    const readAck = () => {
      try {
        const ack = JSON.parse(fs.readFileSync(`${this.controlPath}.ack`, "utf8"));
        if (ack.state === state) return { acknowledged: true, acknowledgedAt: ack.timestamp, idle: false };
      } catch (_error) {
      }
      return null;
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const acknowledgement = readAck();
      if (acknowledgement) return acknowledgement;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // If this Node process was descheduled across the deadline, the native
    // timestamp still tells us whether the engine acknowledged within budget.
    const lateObservation = readAck();
    if (lateObservation) return { ...lateObservation, observedAfterDeadline: true };
    return { acknowledged: false, pending: true, reason: "native_call_not_interruptible_yet" };
  }

  async pause() {
    const request = this.setControl("paused");
    return { ...request, ...(await this.waitForControlAck("paused")) };
  }

  resume() {
    return this.setControl("running");
  }

  async stop() {
    const request = this.setControl("stopped");
    return { ...request, ...(await this.waitForControlAck("stopped")) };
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
    this.closing = true;
    try { this.setControl("stopped"); } catch (_error) {}
    for (const { reject, timer, operation } of this.pending.values()) {
      clearTimeout(timer);
      if (operation.promisePending) {
        operation.promisePending = false;
        operation.state = "unknown";
        operation.settledAt = Date.now();
        operation.error = new NativeOperationError(
          "ACTOR_CLOSING",
          "Native actor is closing; the dispatched operation outcome remains unknown until the process exits.",
          operation.id,
          "unknown",
        );
        reject(operation.error);
      }
    }
    if (proc) {
      try {
        proc.stdin?.end();
      } catch (_error) {
      }
      if (!proc.killed && proc.exitCode === null) {
        const killTimer = setTimeout(() => {
          if (!proc.killed && proc.exitCode === null) {
            try { proc.kill(); } catch (_error) {}
          }
        }, 750);
        killTimer.unref?.();
      }
    }
    if (!proc) {
      try { fs.rmSync(this.controlPath, { force: true }); } catch (_error) {}
      try { fs.rmSync(`${this.controlPath}.ack`, { force: true }); } catch (_error) {}
    } else {
      proc.once("exit", () => {
        try { fs.rmSync(this.controlPath, { force: true }); } catch (_error) {}
        try { fs.rmSync(`${this.controlPath}.ack`, { force: true }); } catch (_error) {}
      });
    }
  }
}
