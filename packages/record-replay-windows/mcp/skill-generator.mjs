import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_EVENTS_FOR_SKILL = 80;
const GENERIC_TARGETS = new Set([
  "button",
  "custom",
  "document",
  "edit",
  "pane",
  "text",
  "window",
]);
const RECORDER_HOST_PROCESSES = new Set(["codex.exe"]);

export function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function sanitizeSkillNamePart(value, maxLength = 48) {
  return String(value || "workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength) || "workflow";
}

function stripExe(value) {
  return String(value || "")
    .replace(/\.[^.\\/\s]+$/, "")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function singleLine(value, fallback = "") {
  return String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function yamlString(value) {
  return JSON.stringify(singleLine(value));
}

function skillLine(value, fallback = "") {
  return singleLine(value, fallback);
}

function sessionLinePattern(sessionID) {
  return new RegExp(`^-\\s+Session:\\s+${escapeRegExp(sessionID)}\\s*$`, "m");
}

function removeSiblingSkillsForSession(skillsRoot, sessionID, keepDir) {
  const removed = [];
  if (!sessionID || !fs.existsSync(skillsRoot)) return removed;
  const root = path.resolve(skillsRoot);
  const keep = path.resolve(keepDir);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("record-replay-")) continue;
    const skillDir = path.resolve(root, entry.name);
    if (skillDir === keep || path.dirname(skillDir) !== root) continue;
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const markdown = fs.readFileSync(skillPath, "utf8");
    if (!sessionLinePattern(sessionID).test(markdown)) continue;
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed.push(skillDir);
  }
  return removed;
}

function isRecorderHostEvent(event) {
  const processName = String(event.application?.processName || event.application?.name || "").toLowerCase();
  return event.type?.startsWith("recorder.") || RECORDER_HOST_PROCESSES.has(processName);
}

function replayRelevantEvents(events) {
  const filtered = events.filter((event) => !isRecorderHostEvent(event));
  return filtered.length ? filtered : events;
}

function dominantValue(events, getter, fallback) {
  const counts = new Map();
  for (const event of events) {
    const value = getter(event);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function compactWindowTitle(title, appLabel) {
  const value = singleLine(title);
  if (!value) return "";
  const withoutApp = value
    .replace(new RegExp(`\\s+-\\s+${escapeRegExp(appLabel)}$`, "i"), "")
    .replace(new RegExp(`^${escapeRegExp(appLabel)}\\s+-\\s+`, "i"), "")
    .trim();
  return withoutApp && withoutApp.length <= 48 ? withoutApp : value.slice(0, 48).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eventTargetLabel(event) {
  const uia = event.target?.uia;
  return singleLine(uia?.name || uia?.automationId || "");
}

function meaningfulTargets(events) {
  const counts = new Map();
  for (const event of events) {
    const label = eventTargetLabel(event);
    if (!label) continue;
    const normalized = label.toLowerCase();
    if (GENERIC_TARGETS.has(normalized)) continue;
    if (/^\d+$/.test(normalized)) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label)
    .slice(0, 5);
}

function actionCounts(events) {
  const counts = {
    clicks: 0,
    keys: 0,
    windows: 0,
  };
  for (const event of events) {
    if (event.type?.startsWith("mouse.")) counts.clicks += 1;
    if (event.type?.startsWith("keyboard.")) counts.keys += 1;
    if (event.type === "window.changed") counts.windows += 1;
  }
  return counts;
}

function inferPurpose(events, targets) {
  const joined = targets.join(" ").toLowerCase();
  const targetMatch = [
    ["save", "Save"],
    ["send", "Send"],
    ["submit", "Submit"],
    ["login", "Sign In"],
    ["sign in", "Sign In"],
    ["search", "Search"],
    ["download", "Download"],
    ["upload", "Upload"],
    ["export", "Export"],
    ["print", "Print"],
    ["open", "Open"],
    ["new", "Create"],
  ].find(([needle]) => joined.includes(needle));
  if (targetMatch) return targetMatch[1];

  const hasTyping = events.some((event) => event.type?.startsWith("keyboard."));
  const hasClicks = events.some((event) => event.type?.startsWith("mouse."));
  if (hasTyping && hasClicks) return "Edit And Navigate";
  if (hasTyping) return "Text Entry";
  if (hasClicks) return "Navigation";
  return "Workflow";
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

function stripContextFromName(value) {
  const text = singleLine(value);
  if (!text) return "";
  if (hasCjk(text)) {
    return text
      .replace(/^在\s*.+?(?:中|里|内)\s*/u, "")
      .replace(/(?:在|于|通过|使用)\s*[^，。；;]+(?:中|里|内)?$/u, "")
      .replace(/(?:到|至)\s*[^，。；;]+(?:聊天|窗口|应用|页面|工具|工作台|app).*$/iu, "")
      .trim() || text;
  }
  return text
    .replace(/\s+(?:in|on|within|inside|using|via)\s+.+$/i, "")
    .replace(/\s+with\s+(?:the\s+)?(?:.+\s+)?(?:app|application|window|browser|chat|page|tool|workspace)$/i, "")
    .trim() || text;
}

function slugValue(value, maxLength = 48) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function chineseActionSlug(value) {
  const text = String(value || "");
  const rules = [
    [/问候|打招呼/u, "send-greeting"],
    [/发送|发消息|发信|发送消息/u, "send-message"],
    [/保存/u, "save"],
    [/搜索|查询/u, "search"],
    [/下载/u, "download"],
    [/上传/u, "upload"],
    [/登录|登陆/u, "sign-in"],
    [/填写|输入|录入/u, "text-entry"],
    [/打开/u, "open"],
    [/导出/u, "export"],
    [/复制|粘贴/u, "copy-paste"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function slugForWorkflowName(value, fallback) {
  const stripped = stripContextFromName(value);
  return slugValue(stripped) || chineseActionSlug(stripped) || sanitizeSkillNamePart(fallback);
}

export function analyzeWorkflow(events, session = {}, options = {}) {
  const replayEvents = replayRelevantEvents(events);
  const primaryProcess = dominantValue(
    replayEvents,
    (event) => event.application?.processName || event.application?.name,
    "Windows desktop",
  );
  const primaryApp = stripExe(primaryProcess) || "Windows desktop";
  const appLabel = titleCase(primaryApp);
  const primaryWindow = dominantValue(
    replayEvents,
    (event) => event.window?.title || event.application?.windowTitle,
    "",
  );
  const windowLabel = compactWindowTitle(primaryWindow, appLabel);
  const targets = meaningfulTargets(replayEvents);
  const counts = actionCounts(replayEvents);
  const inferredPurpose = inferPurpose(replayEvents, targets);
  const suppliedName = singleLine(options.workflowName);
  const suppliedActionName = stripContextFromName(suppliedName);
  const suppliedSummary = singleLine(options.workflowSummary);
  const title = suppliedActionName || [appLabel, inferredPurpose === "Workflow" ? "Workflow" : inferredPurpose]
    .filter(Boolean)
    .join(" ");
  const targetPhrase = targets.length ? ` Key targets included ${targets.slice(0, 3).map((item) => `"${item}"`).join(", ")}.` : "";
  const windowPhrase = windowLabel ? ` in "${windowLabel}"` : "";
  const summary =
    suppliedSummary ||
    `Replay a recorded ${appLabel} workflow${windowPhrase} with ${counts.clicks} click event(s), ${counts.keys} keyboard event(s), and ${counts.windows} window focus change(s).${targetPhrase}`;
  const slugParts = [
    suppliedName ? slugForWorkflowName(suppliedName, inferredPurpose) : appLabel,
    suppliedName ? "" : inferredPurpose,
    suppliedName ? "" : targets[0],
  ]
    .filter(Boolean)
    .map((part) => slugValue(part) || sanitizeSkillNamePart(part))
    .filter(Boolean);
  const slug = sanitizeSkillNamePart(slugParts.join("-") || "workflow");

  return {
    title,
    summary,
    slug,
    primaryApp: primaryProcess,
    primaryWindow,
    targetHints: targets,
    actionCounts: counts,
    sessionID: session.sessionID || "",
    summaryWasSupplied: Boolean(suppliedSummary),
  };
}

function describeEvent(event) {
  const app = skillLine(event.application?.processName || event.application?.name || "current app");
  const windowTitle = skillLine(event.window?.title || event.application?.windowTitle || "");
  const target = skillLine(event.target?.uia?.name || event.target?.uia?.automationId || event.target?.uia?.controlType || "");
  const suffix = target ? ` on "${target}"` : windowTitle ? ` in "${windowTitle}"` : "";
  if (event.type?.startsWith("mouse.")) {
    return `${event.type}: use ${app}${suffix}.`;
  }
  if (event.type?.startsWith("keyboard.")) {
    const key = event.input?.keyName || event.input?.vkCode || "key";
    const redacted = event.redaction?.redacted ? " (sensitive text redacted)" : "";
    return `${event.type}: press ${key} in ${app}${suffix}${redacted}.`;
  }
  if (event.type === "window.changed") {
    return `Switch focus to ${app}${windowTitle ? `, window "${windowTitle}"` : ""}.`;
  }
  return `${event.type || "event"}: continue the demonstrated workflow.`;
}

function eventStepKey(event) {
  return [
    event.type || "",
    event.application?.processName || event.application?.name || "",
    event.window?.title || event.application?.windowTitle || "",
    event.target?.uia?.name || event.target?.uia?.automationId || event.target?.uia?.controlType || "",
    event.input?.keyName || event.input?.vkCode || "",
  ].map((part) => singleLine(part).toLowerCase()).join("|");
}

function cleanedReplaySteps(events) {
  const cleaned = [];
  for (const event of replayRelevantEvents(events).slice(0, MAX_EVENTS_FOR_SKILL)) {
    const key = eventStepKey(event);
    const previous = cleaned[cleaned.length - 1];
    if (previous?.key === key) {
      previous.count += 1;
      continue;
    }
    cleaned.push({ key, event, count: 1 });
  }
  return cleaned.map(({ event, count }, index) => {
    const description = describeEvent(event);
    const repeat = count > 1 ? ` Repeat ${count} times.` : "";
    return `${index + 1}. ${description}${repeat}`;
  });
}

function normalizeSemanticStep(value) {
  const text = singleLine(value)
    .replace(/^(?:and|then|to)\s+/i, "")
    .replace(/\.$/, "")
    .trim();
  if (!text || text.length < 3) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function splitSummaryIntoSteps(summary) {
  const value = singleLine(summary)
    .replace(/^Replay (?:a|the) recorded .*?:\s*/i, "")
    .replace(/^Regenerate .*?:\s*/i, "")
    .replace(/,\s+and\s+/gi, ", ")
    .replace(/\s+and then\s+/gi, ", ")
    .replace(/\s+then\s+/gi, ", ");
  return value
    .split(/\s*(?:;|:\s+|,\s+)\s*/g)
    .map((part) => normalizeSemanticStep(part))
    .filter(Boolean)
    .slice(0, 12);
}

function semanticReplaySteps(workflow, eventSteps) {
  const summary = singleLine(workflow?.summary);
  const hasSemanticSummary = workflow?.summaryWasSupplied || !/^Replay a recorded .+ with \d+ click event\(s\)/i.test(summary);
  if (summary && hasSemanticSummary) {
    const semantic = splitSummaryIntoSteps(summary);
    if (semantic.length) {
      return semantic.map((step, index) => `${index + 1}. ${skillLine(step)}`);
    }
  }
  return eventSteps.length
    ? eventSteps
    : ["1. Review the event stream and replay the demonstrated workflow semantically."];
}

function reuseInstructions(skillName, workflow) {
  const title = singleLine(workflow?.title || "this recorded workflow");
  return [
    "Start a new Codex thread or restart Codex so the generated skill index is refreshed.",
    `Ask Codex to replay "${title}" with this generated skill. Technical skill id: ${skillName}.`,
    "The agent should load this SKILL.md, inspect the current desktop state, then execute the Replay Guidance and Steps with Computer Use or a more specific app tool when available.",
  ];
}

function agentExecutionPlan(skillName, workflow, stepCount, cleanedEventStepCount = stepCount) {
  const title = singleLine(workflow?.title || "this recorded workflow");
  const count = Number.isFinite(stepCount) && stepCount > 0 ? stepCount : 1;
  const eventCount = Number.isFinite(cleanedEventStepCount) && cleanedEventStepCount > 0
    ? cleanedEventStepCount
    : count;
  return {
    stepCount: count,
    cleanedEventStepCount: eventCount,
    phases: [
      `Load this SKILL.md and confirm the user wants to replay "${title}" with the ${skillName} skill.`,
      "Inspect the current desktop, active window, and visible UI labels; align them with Trigger Conditions before taking action.",
      "Choose the safest control path: Computer Use for Windows desktop UI, or Browser/Chrome tooling when the workflow is web-based and DOM-aware control is available.",
      `Execute the ${count} semantic replay step(s) from the Steps section in order, consulting the ${eventCount} cleaned Recorded Event Evidence step(s) only for UI targets, ordering, and fallback details.`,
      "Run the Verification checks, report the final result, and explain any deviation, retry, or user handoff if the UI no longer matches the recording.",
    ],
  };
}

export function buildSkillMarkdown({ skillName, session, events, workflow }) {
  const analyzed = workflow || analyzeWorkflow(events, session);
  const eventSteps = cleanedReplaySteps(events);
  const steps = semanticReplaySteps(analyzed, eventSteps);
  const executionPlan = agentExecutionPlan(skillName, analyzed, steps.length || 1, eventSteps.length || 1);
  const verification = [
    "Check the final window state, visible success message, saved file, sent message, or other user-facing result shown at the end of the recording.",
    "If the workflow is browser-heavy, prefer Browser/Chrome tooling for replay and use the recorded events as behavioral evidence.",
    "If a UI Automation target is missing or unstable, fall back to Computer Use visual inspection and interact with the visible label instead of hard-coded coordinates.",
  ];
  const reuse = reuseInstructions(skillName, analyzed);

  const description = yamlString(`Use when the user asks to replay or automate this Windows workflow: ${singleLine(analyzed.summary)}`);
  const title = skillLine(analyzed.title || "Recorded Windows Workflow");
  const summary = skillLine(analyzed.summary || "Replay the recorded Windows workflow.");
  const primaryApp = skillLine(analyzed.primaryApp || "Windows desktop");
  const primaryWindow = skillLine(analyzed.primaryWindow || "");
  const eventsPath = skillLine(session.eventsPath || "");
  const metadataPath = skillLine(session.metadataPath || "");
  const sessionID = skillLine(session.sessionID || "unknown");
  return `---
name: ${skillName}
description: ${description}
---

# ${title}

## Workflow Summary

${summary}

## Trigger Conditions

Use this skill when the user asks to repeat the same workflow or a close variant in ${primaryApp || "the recorded Windows app"}.${primaryWindow ? ` Start from a window matching "${primaryWindow}".` : ""}

## Source Recording

- Session: ${sessionID}
- Primary app: ${primaryApp || "Windows desktop"}
- Events path: ${eventsPath}
- Metadata path: ${metadataPath}

## How To Reuse

${reuse.map((item) => `- ${skillLine(item)}`).join("\n")}

## Agent Execution Plan

The replay contains ${executionPlan.stepCount} semantic step(s) and ${executionPlan.cleanedEventStepCount} cleaned step(s) of recorded event evidence. The agent should execute this skill in ${executionPlan.phases.length} phase(s):

${executionPlan.phases.map((item, index) => `${index + 1}. ${skillLine(item)}`).join("\n")}

## Replay Guidance

Use Computer Use for desktop UI steps. Use Browser/Chrome tooling instead when the recorded app is Chrome, Edge, Electron, or WebView and a DOM-aware workflow is available.

## Steps

${steps.join("\n")}

## Recorded Event Evidence

${eventSteps.length ? eventSteps.join("\n") : "1. No low-level event evidence was available; rely on the Workflow Summary and current UI inspection."}

## Verification

${verification.map((item) => `- ${item}`).join("\n")}

## Failure Handling

- If a target button or field is missing, inspect the current window and use the nearest matching visible label or UI Automation name.
- If an administrator window, UAC prompt, or secure desktop appears, stop and ask the user to complete that step manually.
- Never reconstruct redacted passwords, OTPs, tokens, or keys from the event stream.
`;
}

export function installGeneratedSkill(session, options = {}) {
  const events = readJsonl(session.eventsPath);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "z").toLowerCase();
  const workflow = analyzeWorkflow(events, session, options);
  const baseName = `record-replay-${workflow.slug}-${timestamp}`;
  const skillsRoot = options.skillsRoot || path.join(os.homedir(), ".codex", "skills");
  let skillName = baseName;
  let skillDir = path.join(skillsRoot, skillName);
  let counter = 2;
  while (fs.existsSync(skillDir)) {
    skillName = `${baseName}-${counter}`;
    skillDir = path.join(skillsRoot, skillName);
    counter += 1;
  }
  fs.mkdirSync(skillDir, { recursive: true });
  const markdown = buildSkillMarkdown({ skillName, session, events, workflow });
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---/s.test(markdown)) {
    throw new Error("Generated skill frontmatter failed validation");
  }
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, markdown, "utf8");
  const replacedSkillDirectoryPaths = options.replaceSessionSkills
    ? removeSiblingSkillsForSession(skillsRoot, session.sessionID || "", skillDir)
    : [];
  const eventSteps = cleanedReplaySteps(events);
  const executionPlan = agentExecutionPlan(
    skillName,
    workflow,
    semanticReplaySteps(workflow, eventSteps).length || 1,
    eventSteps.length || 1,
  );
  return {
    installed: true,
    skillName,
    skillDirectoryPath: skillDir,
    skillPath,
    eventCountUsed: events.length,
    workflow,
    displayName: workflow.title,
    replacedSkillDirectoryPaths,
    reuseInstructions: reuseInstructions(skillName, workflow),
    executionPlan,
    activationNote: `Start a new Codex thread or restart Codex, then ask Codex to replay "${workflow.title}". Technical skill id: ${skillName}. The skill includes an Agent Execution Plan, semantic Steps, and cleaned event evidence.`,
  };
}
