import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENTS = 2048;
const WRITE_METHODS = new Set([
  "click",
  "mouse_move",
  "drag",
  "scroll",
  "type_text",
  "key",
  "window_focus",
  "uia_invoke",
]);

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function safeCode(error) {
  const explicit = String(error?.code || "").trim();
  if (explicit) return explicit.slice(0, 80);
  const match = String(error?.message || error || "").match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return match?.[1] || "ACTION_FAILED";
}

function sanitizeTarget(action, params = {}) {
  const target = {};
  const integer = (value) => Number.isFinite(value) ? Math.round(Number(value)) : undefined;
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    const value = integer(params[key]);
    if (value !== undefined) target[key] = value;
  }
  if (params.button) target.button = String(params.button).slice(0, 16);
  if (Number.isFinite(params.clicks)) target.clicks = Math.max(1, Math.min(3, Number(params.clicks)));
  if (params.direction) target.direction = String(params.direction).slice(0, 16);
  if (Number.isFinite(params.amount)) target.amount = Number(params.amount);
  if (action === "type_text" || action === "type" || action === "set_value") {
    const body = action === "set_value" ? params.value : params.text;
    target.textLength = Number.isFinite(params.textLength)
      ? Number(params.textLength)
      : [...String(body || "")].length;
    target.clearFirst = Boolean(params.clearFirst);
  }
  if (action === "key" && params.keys) {
    target.keys = String(params.keys).slice(0, 80);
  }
  if (action === "uia_invoke" || action === "set_value") {
    target.uiaAction = String(params.uiaAction || params.action || (action === "set_value" ? "set_value" : "invoke")).slice(0, 32);
    if (params.controlType) target.controlType = String(params.controlType).slice(0, 64);
    target.hasLocator = Boolean(params.automationId || params.name || params.scopeHwnd);
    if (params.hasLocator === true) target.hasLocator = true;
  }
  if (action === "window_focus") {
    if (Number.isFinite(params.hwnd)) target.hwnd = Number(params.hwnd);
    if (Number.isFinite(params.pid)) target.pid = Number(params.pid);
    target.hasWindowSelector = Boolean(params.hwnd || params.pid || params.title || params.processName);
    if (params.hasWindowSelector === true) target.hasWindowSelector = true;
  }
  return target;
}

function normalizeOutcome(phase, outcome = {}) {
  const fallback = phase === "failed" ? "failed"
    : phase === "unknown" ? "unknown"
      : phase === "cancelled" ? "cancelled"
        : phase === "verified" ? "verified"
          : phase === "input_dispatched" ? "dispatched"
            : "pending";
  const normalized = { status: String(outcome.status || fallback).slice(0, 32) };
  if (outcome.code) normalized.code = String(outcome.code).slice(0, 80);
  if (outcome.reason) normalized.reason = String(outcome.reason).slice(0, 120);
  return normalized;
}

export class AutomationBusyError extends Error {
  constructor(owner = null) {
    super("The Windows desktop already has an active Atria write session.");
    this.name = "AutomationBusyError";
    this.code = "AUTOMATION_BUSY";
    this.owner = owner;
  }
}

export class AutomationControlError extends Error {
  constructor(state) {
    super(state === "stopped" ? "Automation was stopped." : "Automation is paused.");
    this.name = "AutomationControlError";
    this.code = state === "stopped" ? "ACTION_STOPPED" : "ACTION_PAUSED";
    this.state = state;
  }
}

export function defaultWriteLockPath() {
  const root = process.env.LOCALAPPDATA || os.tmpdir();
  return path.join(root, "Atria", "desktop-write.lock");
}

export class ActionCoordinator {
  constructor(actor, options = {}) {
    this.actor = actor;
    this.bootId = options.bootId || crypto.randomUUID();
    this.defaultSessionId = options.sessionId || `session-${process.pid}`;
    this.lockPath = options.lockPath || defaultWriteLockPath();
    this.eventLogPath = options.eventLogPath || null;
    this.maxEvents = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
    this.events = [];
    this.listeners = new Set();
    this.sequence = 0;
    this.controlState = "running";
    this.lockToken = null;
    this.visual = options.visual || null;
    this.removeActorListener = typeof actor?.addEventListener === "function"
      ? actor.addEventListener((event) => this.acceptNativeEvent(event))
      : null;
  }

  isWriteMethod(method) {
    return WRITE_METHODS.has(method);
  }

  newOperationId() {
    if (typeof this.actor?.createOperationId === "function") return this.actor.createOperationId();
    return `${this.bootId}:${crypto.randomUUID()}`;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventFor(action, phase, context = {}, target = {}, outcome = {}) {
    this.sequence += 1;
    return {
      schemaVersion: SCHEMA_VERSION,
      bootId: String(context.bootId || this.actor?.actorBootId || this.bootId),
      sessionId: String(context.sessionId || this.defaultSessionId),
      operationId: String(context.operationId || `${this.bootId}:${crypto.randomUUID()}`),
      sequence: this.sequence,
      action: String(action || "unknown").slice(0, 64),
      phase,
      target: sanitizeTarget(action, target),
      coordinateSpace: "desktop_physical",
      timestamp: new Date().toISOString(),
      outcome: normalizeOutcome(phase, outcome),
      ...(context.parentOperationId ? { parentOperationId: String(context.parentOperationId) } : {}),
      ...(Number.isInteger(context.stepIndex) ? { stepIndex: context.stepIndex } : {}),
    };
  }

  publish(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    if (this.eventLogPath) {
      try {
        fs.mkdirSync(path.dirname(this.eventLogPath), { recursive: true });
        fs.appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (_error) {
      }
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch (_error) {}
    }
    try { this.visual?.handleEvent(event); } catch (_error) {}
    return event;
  }

  emit(action, phase, context = {}, target = {}, outcome = {}) {
    return this.publish(this.eventFor(action, phase, context, target, outcome));
  }

  acceptNativeEvent(event = {}) {
    const phase = ["running", "input_dispatched", "verified", "failed", "unknown", "cancelled"].includes(event.phase)
      ? event.phase
      : "unknown";
    const context = {
      bootId: event.bootId,
      sessionId: event.sessionId,
      operationId: event.operationId,
      parentOperationId: event.parentOperationId,
      stepIndex: event.stepIndex,
    };
    return this.emit(event.action, phase, context, event.target, event.outcome);
  }

  recentEvents(limit = 100) {
    return this.events.slice(-Math.max(1, Math.min(1000, Number(limit) || 100)));
  }

  readLockOwner() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
    } catch (_error) {
      return null;
    }
  }

  acquire(context = {}) {
    if (this.lockToken) throw new AutomationBusyError({ pid: process.pid, bootId: this.bootId });
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const token = crypto.randomUUID();
    const owner = {
      token,
      pid: process.pid,
      bootId: this.actor?.actorBootId || this.bootId,
      sessionId: context.sessionId || this.defaultSessionId,
      operationId: context.operationId || null,
      acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, "wx", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(owner), "utf8"); } finally { fs.closeSync(fd); }
        this.lockToken = token;
        return { token };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = this.readLockOwner();
        if (attempt === 0 && existing?.pid && !processIsAlive(existing.pid)) {
          try { fs.rmSync(this.lockPath, { force: true }); } catch (_error) {}
          continue;
        }
        throw new AutomationBusyError(existing && {
          pid: existing.pid,
          bootId: existing.bootId,
          sessionId: existing.sessionId,
          acquiredAt: existing.acquiredAt,
        });
      }
    }
    throw new AutomationBusyError(this.readLockOwner());
  }

  release(acquired) {
    if (!acquired) return;
    const current = this.readLockOwner();
    if (current?.token === acquired.token && this.lockToken === acquired.token) {
      try { fs.rmSync(this.lockPath, { force: true }); } catch (_error) {}
    }
    this.lockToken = null;
  }

  async withWriteSession(context, work) {
    if (this.controlState === "stopped") throw new AutomationControlError("stopped");
    const acquired = this.acquire(context);
    try {
      return await work({ ...context, lockHeld: true });
    } finally {
      this.release(acquired);
    }
  }

  async waitUntilRunnable() {
    while (this.controlState === "paused") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.controlState === "stopped") throw new AutomationControlError("stopped");
  }

  async run(action, params, invoke, context = {}) {
    const execute = async (heldContext) => {
      await this.waitUntilRunnable();
      await this.visual?.beforeAction();
      if (typeof this.actor?.ensureStarted === "function") this.actor.ensureStarted();
      const operationId = context.operationId || this.newOperationId();
      const actionContext = { ...heldContext, ...context, operationId };
      this.emit(action, "prepare", actionContext, params, { status: "pending" });
      const beforeCount = this.events.length;
      try {
        const result = await invoke(actionContext);
        const operationEvents = this.events.slice(beforeCount).filter((event) => event.operationId === operationId);
        if (!operationEvents.some((event) => event.phase === "running")) {
          this.emit(action, "running", actionContext, params, { status: "running" });
        }
        if (!operationEvents.some((event) => ["input_dispatched", "verified"].includes(event.phase))) {
          const verified = result?.verification?.status === "verified" || result?.focused === true;
          this.emit(action, verified ? "verified" : "input_dispatched", actionContext, params, {
            status: verified ? "verified" : "dispatched",
          });
        }
        return { ...result, operationId };
      } catch (error) {
        const operationEvents = this.events.slice(beforeCount).filter((event) => event.operationId === operationId);
        if (!operationEvents.some((event) => ["failed", "unknown", "cancelled"].includes(event.phase))) {
          const code = safeCode(error);
          const phase = code === "EXECUTION_TIMEOUT" ? "unknown"
            : code === "ACTION_PAUSED" || code === "ACTION_STOPPED" ? "cancelled"
              : "failed";
          this.emit(action, phase, actionContext, params, { code });
        }
        throw error;
      }
    };
    if (context.lockHeld) return execute(context);
    return this.withWriteSession(context, execute);
  }

  async pause() {
    this.controlState = "paused";
    const native = typeof this.actor?.pause === "function" ? await this.actor.pause() : null;
    return { state: "paused", ...native };
  }

  async resume() {
    const native = typeof this.actor?.resume === "function" ? await this.actor.resume() : null;
    this.controlState = "running";
    return { state: "running", ...native };
  }

  async stop() {
    this.controlState = "stopped";
    const native = typeof this.actor?.stop === "function" ? await this.actor.stop() : null;
    return { state: "stopped", ...native };
  }

  status() {
    return {
      state: this.controlState,
      bootId: this.actor?.actorBootId || this.bootId,
      lockOwner: this.readLockOwner(),
      eventCount: this.events.length,
      lastEvent: this.events.at(-1) || null,
      visual: this.visual?.status?.() || { mode: "off", ready: false },
    };
  }

  close() {
    this.removeActorListener?.();
    this.release({ token: this.lockToken });
    this.visual?.close?.();
  }
}
