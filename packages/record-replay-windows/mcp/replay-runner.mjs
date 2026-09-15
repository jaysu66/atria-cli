import fs from "node:fs";

// replay-runner.mjs — batch-I:确定性回放编排。
// 读 events.jsonl 生成回放计划(纯函数,可测),经 actor.exe 逐步执行:
//   UIA 定位优先(容忍布局漂移)→ 录制坐标兜底;特殊键重放;
//   脱敏文本(suppressed)不可确定性重放 → needs_agent 升级,停在该步,
//   由调用方 agent 按 SKILL.md 语义补完后带 startIndex 续跑。
// 这是 batch-L 失败自愈的引擎底座:每步返回 method 与失败上下文。

const MODIFIER_VK = new Set([0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c]);

const VK_TO_KEY = {
  0x0d: "enter",
  0x09: "tab",
  0x1b: "esc",
  0x08: "backspace",
  0x2e: "delete",
  0x2d: "insert",
  0x24: "home",
  0x23: "end",
  0x21: "pageup",
  0x22: "pagedown",
  0x25: "left",
  0x26: "up",
  0x27: "right",
  0x28: "down",
  0x20: "space",
};
for (let i = 0; i < 12; i += 1) VK_TO_KEY[0x70 + i] = `f${i + 1}`;

export function vkToKey(vkCode) {
  const code = Number(vkCode);
  if (MODIFIER_VK.has(code)) return null; // 裸修饰键 = 噪声,跳过
  return VK_TO_KEY[code] || null;
}

const SUPPRESSED_CLUSTER_GAP_MS = 2000;

// 把脱敏键事件按时间邻近聚簇(一簇 ≈ 一段连续输入)。
export function clusterSuppressed(suppressedEvents) {
  const typed = (suppressedEvents || [])
    .filter((e) => e?.type === "keyboard.key" && e?.timestamp)
    .map((e) => ({ at: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  const clusters = [];
  for (const item of typed) {
    const last = clusters[clusters.length - 1];
    if (last && item.at - last.endAt <= SUPPRESSED_CLUSTER_GAP_MS) {
      last.endAt = item.at;
      last.count += 1;
    } else {
      clusters.push({ startAt: item.at, endAt: item.at, count: 1 });
    }
  }
  return clusters;
}

function eventUia(event) {
  const uia = event?.target?.uia;
  if (!uia) return null;
  const name = String(uia.name || "");
  const automationId = String(uia.automationId || "");
  const className = String(uia.className || "");
  const controlType = String(uia.controlType || "");
  if (!name && !automationId) return null; // 没有可定位特征,退坐标
  return { name, automationId, className, controlType };
}

// 纯函数:事件流 + 脱敏事件 → 回放计划。
export function planReplay(events, suppressedEvents = []) {
  const steps = [];
  const clusters = clusterSuppressed(suppressedEvents);
  let clusterIdx = 0;
  const pushDueClusters = (beforeMs) => {
    while (clusterIdx < clusters.length && clusters[clusterIdx].startAt <= beforeMs) {
      steps.push({
        kind: "needs_agent",
        reason: "typed_text_redacted",
        approxKeys: clusters[clusterIdx].count,
        guidance:
          "用户在此输入了一段文本(录制时已脱敏,无法确定性重放)。请按技能 SKILL.md 的 Steps 语义,用 computer_type 输入等效内容后,以 startIndex 续跑 replay_run。",
      });
      clusterIdx += 1;
    }
  };

  for (const event of events || []) {
    const type = String(event?.type || "");
    if (!type || type.startsWith("recorder.")) continue;
    const at = Date.parse(event.timestamp || "") || 0;
    pushDueClusters(at);
    const processName = String(event.application?.processName || "");
    const windowTitle = String(event.window?.title || event.application?.windowTitle || "");
    const windowHwnd = Number(event.window?.hwnd ?? event.application?.hwnd ?? 0) || null;
    const processId = Number(event.application?.pid ?? 0) || null;
    if (type === "mouse.click" || type === "mouse.context_menu" || type === "mouse.middle_click") {
      steps.push({
        kind: "click",
        button: type === "mouse.context_menu" ? "right" : type === "mouse.middle_click" ? "middle" : "left",
        x: Number(event.input?.x ?? 0),
        y: Number(event.input?.y ?? 0),
        uia: eventUia(event),
        processName,
        windowTitle,
        windowHwnd,
        processId,
      });
    } else if (type === "mouse.wheel") {
      const delta = Number(event.input?.wheelDelta ?? event.input?.delta ?? 0);
      if (Number.isFinite(delta) && delta !== 0) {
        steps.push({
          kind: "scroll",
          direction: delta > 0 ? "up" : "down",
          amount: Math.max(1, Math.round(Math.abs(delta) / 120)),
          x: Number(event.input?.x ?? 0),
          y: Number(event.input?.y ?? 0),
          processName,
          windowTitle,
          windowHwnd,
          processId,
        });
      } else {
        steps.push({
          kind: "needs_agent",
          reason: "wheel_direction_missing",
          guidance: "录制事件没有保留滚轮方向，无法安全重放。请人工完成该滚动后，以 startIndex 续跑 replay_run。",
        });
      }
    } else if (type === "keyboard.text") {
      const text = typeof event.input?.text === "string" ? event.input.text : "";
      if (text) {
        steps.push({ kind: "type", text, processName, windowTitle, windowHwnd, processId });
      } else {
        steps.push({
          kind: "needs_agent",
          reason: "unicode_text_missing",
          guidance: "录制事件声明了文本输入但未保留文本内容。请人工补足后，以 startIndex 续跑 replay_run。",
        });
      }
    } else if (type === "keyboard.key") {
      const key = vkToKey(event.input?.vkCode);
      if (key) {
        steps.push({ kind: "key", keys: key, processName, windowTitle, windowHwnd, processId });
      } else if (!MODIFIER_VK.has(Number(event.input?.vkCode))) {
        steps.push({
          kind: "needs_agent",
          reason: `key_not_mapped:${event.input?.keyName || event.input?.vkCode}`,
          guidance: "录制事件没有可安全重放的按键或文本语义。请按技能步骤人工补足后，以 startIndex 续跑 replay_run。",
        });
      }
      // 裸修饰键静默跳过(不占步骤位)
    }
  }
  pushDueClusters(Number.POSITIVE_INFINITY);
  return steps;
}

export function readJsonlFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function ensureFocus(actor, step, state, stepIndex) {
  const wantProcess = step.processName || "";
  if (!wantProcess && !step.windowTitle && !step.windowHwnd) return { ok: true, method: "none", expect: undefined };
  const targetKey = `${step.windowHwnd || ""}|${step.processId || ""}|${wantProcess}|${step.windowTitle || ""}`;
  // A cached selection is only a routing hint. Every native write still receives
  // the exact hwnd/pid returned here and re-checks foreground immediately before input.
  if (state.targetKey === targetKey && state.expect) return { ok: true, method: "cached", expect: state.expect };
  let result = null;
  if (step.windowHwnd) {
    try {
      result = await actor.windowFocus({
        hwnd: step.windowHwnd,
        processName: wantProcess || undefined,
        title: step.windowTitle || undefined,
        _actionStepIndex: stepIndex,
      });
    } catch (_error) {
      result = null;
    }
  }
  if (step.windowTitle) {
    if (!result?.focused) {
      try {
        result = await actor.windowFocus({ title: step.windowTitle, processName: wantProcess || undefined, _actionStepIndex: stepIndex });
      } catch (_error) {
        result = null;
      }
    }
  }
  if (!result?.focused && wantProcess) {
    try {
      result = await actor.windowFocus({ processName: wantProcess, _actionStepIndex: stepIndex });
    } catch (error) {
      return { ok: false, method: "focus_failed", error: error.message };
    }
  }
  const foreground = result?.foreground || {};
  const fgProcess = String(foreground.processName || "");
  if (wantProcess && !fgProcess.toLowerCase().includes(wantProcess.toLowerCase().replace(/\.exe$/, ""))) {
    return { ok: false, method: "focus_mismatch", foreground: result?.foreground };
  }
  if (!result?.focused || !foreground.hwnd || !foreground.pid) {
    return { ok: false, method: "focus_unverified", foreground };
  }
  const expect = {
    hwnd: foreground.hwnd,
    pid: foreground.pid,
    processName: fgProcess || undefined,
    titleExact: foreground.windowTitle || undefined,
  };
  state.targetKey = targetKey;
  state.expect = expect;
  return { ok: true, method: "focused", expect };
}

async function executeClick(actor, step, expect, stepIndex) {
  if (step.uia) {
    try {
      const locator = {
        scopeTitle: step.windowTitle || undefined,
        name: step.uia.name || undefined,
        automationId: step.uia.automationId || undefined,
        timeoutMs: 2500,
        maxResults: 3,
      };
      const found = await actor.uiaFind(locator);
      const el = (found?.elements || []).find((e) => Array.isArray(e.boundingRect));
      if (el) {
        const [l, t, r, b] = el.boundingRect;
        if (r > l && b > t) {
          const cx = Math.round((l + r) / 2);
          const cy = Math.round((t + b) / 2);
          await actor.click({ x: cx, y: cy, button: step.button, expect, _actionStepIndex: stepIndex });
          return { ok: true, method: "uia", at: { x: cx, y: cy } };
        }
      }
    } catch (_error) {
      // UIA 失败退坐标
    }
  }
  await actor.click({ x: step.x, y: step.y, button: step.button, expect, _actionStepIndex: stepIndex });
  return { ok: true, method: "coords", at: { x: step.x, y: step.y } };
}

function summarizeReplay(plan, startIndex, results, {
  status,
  executionFinished,
  stoppedAt,
  needsAgent,
} = {}) {
  const plannedCount = Math.max(0, plan.length - startIndex);
  const succeededCount = results.filter((result) => result.ok === true && result.method !== "skipped").length;
  const failedCount = results.filter((result) => result.ok === false && result.kind !== "needs_agent").length;
  const skippedCount = results.filter((result) => result.method === "skipped").length;
  const needsAgentCount = results.filter((result) => result.kind === "needs_agent").length;
  const attemptedCount = results.filter((result) => result.kind !== "needs_agent" && result.method !== "skipped").length;
  const unresolvedCount = failedCount + skippedCount + needsAgentCount;
  const rangeCompleted = Boolean(executionFinished) && unresolvedCount === 0 && results.length === plannedCount;
  const completed = rangeCompleted && startIndex === 0;
  const nextIndex = Number.isInteger(stoppedAt) ? stoppedAt : startIndex + results.length;
  const resolvedStatus = status || (rangeCompleted ? "succeeded" : failedCount > 0 ? "partial" : "unknown");

  return {
    status: resolvedStatus,
    overallStatus: completed ? "succeeded" : startIndex > 0 && rangeCompleted ? "partial" : resolvedStatus,
    completed,
    rangeCompleted,
    executionFinished: Boolean(executionFinished),
    startIndex,
    endIndexExclusive: startIndex + results.length,
    nextIndex,
    plannedCount,
    attemptedCount,
    succeededCount,
    failedCount,
    skippedCount,
    needsAgentCount,
    unresolvedCount,
    ...(Number.isInteger(stoppedAt) ? { stoppedAt } : {}),
    ...(needsAgent ? { needsAgent } : {}),
    results,
  };
}

// 执行回放计划。返回逐步结果;needs_agent / 失败默认停住(让 agent 接管后续跑)。
export async function executeReplay(actor, plan, options = {}) {
  const stepDelayMs = Number.isFinite(options.stepDelayMs) ? Number(options.stepDelayMs) : 400;
  const startIndex = Math.max(0, Number(options.startIndex || 0));
  const stopOnFailure = options.stopOnFailure !== false;
  const captureDir = options.captureDir || null; // batch-L 运行留痕:每步执行后截关键帧,不传不截
  const results = [];
  const state = { targetKey: null, expect: null };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let index = startIndex; index < plan.length; index += 1) {
    const step = plan[index];
    if (step.kind === "skip") {
      results.push({ index, kind: step.kind, ok: false, unresolved: true, method: "skipped", reason: step.reason });
      continue;
    }
    if (step.kind === "needs_agent") {
      results.push({ index, kind: step.kind, ok: false, escalation: step });
      return summarizeReplay(plan, startIndex, results, {
        status: "needs_agent",
        executionFinished: false,
        stoppedAt: index,
        needsAgent: step,
      });
    }
    try {
      const focus = await ensureFocus(actor, step, state, index);
      if (!focus.ok) {
        results.push({ index, kind: step.kind, ok: false, method: focus.method, error: focus.error, foreground: focus.foreground });
        if (stopOnFailure) {
          return summarizeReplay(plan, startIndex, results, {
            status: "failed",
            executionFinished: false,
            stoppedAt: index,
          });
        }
        continue;
      }
      if (step.kind === "click") {
        const outcome = await executeClick(actor, step, focus.expect, index);
        results.push({ index, kind: "click", ...outcome });
      } else if (step.kind === "key") {
        await actor.key({ keys: step.keys, expect: focus.expect, _actionStepIndex: index });
        results.push({ index, kind: "key", ok: true, method: "key", keys: step.keys });
      } else if (step.kind === "type") {
        await actor.typeText({ text: step.text, expect: focus.expect, _actionStepIndex: index });
        results.push({ index, kind: "type", ok: true, method: "unicode_text", length: [...step.text].length });
      } else if (step.kind === "scroll") {
        await actor.scroll({
          direction: step.direction,
          amount: step.amount,
          x: step.x,
          y: step.y,
          expect: focus.expect,
          _actionStepIndex: index,
        });
        results.push({ index, kind: "scroll", ok: true, method: "scroll", direction: step.direction, amount: step.amount });
      } else {
        results.push({ index, kind: step.kind, ok: false, error: `unknown step kind: ${step.kind}` });
        if (stopOnFailure) {
          return summarizeReplay(plan, startIndex, results, {
            status: "failed",
            executionFinished: false,
            stoppedAt: index,
          });
        }
      }
    } catch (error) {
      results.push({ index, kind: step.kind, ok: false, error: error.message });
      if (stopOnFailure) {
        return summarizeReplay(plan, startIndex, results, {
          status: "failed",
          executionFinished: false,
          stoppedAt: index,
        });
      }
    }
    if (captureDir && results.length && results[results.length - 1].index === index) {
      try {
        const shot = await actor.screenshot({ outputDir: captureDir });
        results[results.length - 1].capturePath = shot?.path || null;
      } catch (_error) {
        // 截图失败不影响回放
      }
    }
    if (stepDelayMs > 0) await sleep(stepDelayMs);
  }
  const hasFailure = results.some((result) => result.ok === false);
  return summarizeReplay(plan, startIndex, results, {
    status: hasFailure ? "partial" : "succeeded",
    executionFinished: true,
  });
}
