const crypto = require('crypto');

class BridgeOperationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeOperationError';
    this.code = code;
    this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(tool, args) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ tool, args }))).digest('hex');
}

function operationError(operation, code, message, status = operation.state) {
  return {
    isError: true,
    status,
    operationId: operation.id,
    bootId: operation.bootId,
    content: [{ type: 'text', text: `${message} Operation: ${operation.id}` }],
  };
}

class OperationRegistry {
  constructor(options = {}) {
    this.bootId = options.bootId || crypto.randomUUID();
    this.maxOperations = Number(options.maxOperations || 512);
    this.resultTtlMs = Number(options.resultTtlMs || 10 * 60_000);
    this.now = options.now || Date.now;
    this.onQueued = options.onQueued || (() => {});
    this.operations = new Map();
    this.queue = [];
  }

  makeOperationId() {
    return `${this.bootId}:${crypto.randomUUID()}`;
  }

  assertOperationId(operationId) {
    if (typeof operationId !== 'string' || !operationId.startsWith(`${this.bootId}:`)) {
      throw new BridgeOperationError(
        'BOOT_MISMATCH',
        'The operationId belongs to an expired or different browser bridge boot. Query status before deciding whether to retry.',
        { bootId: this.bootId, operationId: operationId || null },
      );
    }
  }

  compactResults() {
    const now = this.now();
    for (const operation of this.operations.values()) {
      if (operation.result && operation.settledAt && now - operation.settledAt >= this.resultTtlMs) {
        operation.result = null;
        operation.resultExpired = true;
      }
    }
  }

  submit({ operationId, sessionId, tool, args, timeoutMs }) {
    this.compactResults();
    const id = operationId || this.makeOperationId();
    this.assertOperationId(id);
    const currentFingerprint = fingerprint(tool, args || {});
    const existing = this.operations.get(id);
    if (existing) {
      if (existing.fingerprint !== currentFingerprint) {
        throw new BridgeOperationError('IDEMPOTENCY_CONFLICT', 'The same operationId was reused with different tool arguments.', {
          operationId: id,
        });
      }
      if (existing.promisePending) return { operation: existing, promise: existing.promise, reused: true };
      if (existing.result) return { operation: existing, promise: Promise.resolve(existing.result), reused: true };
      return {
        operation: existing,
        promise: Promise.resolve(operationError(existing, 'RESULT_UNAVAILABLE', 'The operation is already known but its result is unavailable. Query its status; it was not re-executed.')),
        reused: true,
      };
    }

    if (this.operations.size >= this.maxOperations) {
      throw new BridgeOperationError('CAPACITY_REACHED', 'Browser operation capacity reached for this boot; new work is refused to preserve idempotency.', {
        maxOperations: this.maxOperations,
      });
    }

    const createdAt = this.now();
    const operation = {
      id,
      bootId: this.bootId,
      sessionId: String(sessionId || 'default'),
      tool,
      fingerprint: currentFingerprint,
      args: args || {},
      state: 'queued',
      createdAt,
      deadlineAt: createdAt + Math.max(1, Number(timeoutMs || 60_000)),
      assignedClientId: null,
      dispatchedAt: null,
      settledAt: null,
      result: null,
      resultExpired: false,
      promisePending: true,
      resolve: null,
      timer: null,
    };
    operation.promise = new Promise((resolve) => {
      operation.resolve = resolve;
    });
    operation.timer = setTimeout(() => this.timeout(id), Math.max(1, operation.deadlineAt - createdAt));
    this.operations.set(id, operation);
    this.queue.push(id);
    this.onQueued(operation);
    return { operation, promise: operation.promise, reused: false };
  }

  timeout(id) {
    const operation = this.operations.get(id);
    if (!operation || !operation.promisePending) return;
    if (operation.state === 'queued') {
      operation.state = 'cancelled';
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.settlePromise(operation, operationError(operation, 'QUEUE_TIMEOUT', `Browser operation expired before dispatching ${operation.tool}.`, 'cancelled'));
      return;
    }
    operation.state = 'unknown';
    this.settlePromise(operation, operationError(operation, 'EXECUTION_TIMEOUT', `Browser operation was dispatched but no result arrived before the deadline; do not retry blindly.`, 'unknown'));
  }

  take(clientId) {
    const now = this.now();
    while (this.queue.length) {
      const id = this.queue.shift();
      const operation = this.operations.get(id);
      if (!operation || operation.state !== 'queued') continue;
      if (operation.deadlineAt <= now) {
        this.timeout(id);
        continue;
      }
      operation.state = 'dispatched';
      operation.assignedClientId = clientId;
      operation.dispatchedAt = now;
      return {
        id: operation.id,
        operationId: operation.id,
        bootId: operation.bootId,
        sessionId: operation.sessionId,
        tool: operation.tool,
        args: operation.args,
        createdAt: new Date(operation.createdAt).toISOString(),
        deadlineAt: new Date(operation.deadlineAt).toISOString(),
      };
    }
    return null;
  }

  complete({ operationId, clientId, result }) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new BridgeOperationError('UNKNOWN_OPERATION', 'Unknown or expired operationId.', { operationId });
    }
    if (!operation.assignedClientId || operation.assignedClientId !== clientId) {
      throw new BridgeOperationError('RESULT_OWNER_MISMATCH', 'Result sender does not own this operation.', { operationId });
    }
    const normalizedState = result?.isError ? 'failed' : 'succeeded';
    if (['succeeded', 'failed'].includes(operation.state)) {
      const previous = fingerprint('result', operation.result || {});
      const incoming = fingerprint('result', result || {});
      if (previous !== incoming) {
        throw new BridgeOperationError('RESULT_CONFLICT', 'A different result was submitted for an already settled operation.', { operationId });
      }
      return { operation, duplicate: true };
    }
    clearTimeout(operation.timer);
    operation.state = normalizedState;
    operation.result = result;
    operation.settledAt = this.now();
    this.settlePromise(operation, result);
    return { operation, duplicate: false };
  }

  settlePromise(operation, result) {
    if (!operation.promisePending) return;
    operation.promisePending = false;
    operation.resolve(result);
    operation.resolve = null;
  }

  describe(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    this.compactResults();
    return {
      operationId: operation.id,
      bootId: operation.bootId,
      sessionId: operation.sessionId,
      tool: operation.tool,
      state: operation.state,
      createdAt: new Date(operation.createdAt).toISOString(),
      deadlineAt: new Date(operation.deadlineAt).toISOString(),
      dispatchedAt: operation.dispatchedAt ? new Date(operation.dispatchedAt).toISOString() : null,
      settledAt: operation.settledAt ? new Date(operation.settledAt).toISOString() : null,
      assignedClientId: operation.assignedClientId,
      resultExpired: operation.resultExpired,
      result: operation.result,
    };
  }

  snapshot() {
    const states = {};
    for (const operation of this.operations.values()) states[operation.state] = (states[operation.state] || 0) + 1;
    return { bootId: this.bootId, queued: this.queue.length, retained: this.operations.size, maxOperations: this.maxOperations, states };
  }
}

module.exports = { BridgeOperationError, OperationRegistry, fingerprint };
