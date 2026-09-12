import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeWorkflow,
  buildSkillMarkdown,
  installGeneratedSkill,
  sanitizeSkillNamePart,
} from "../mcp/skill-generator.mjs";

test("sanitizeSkillNamePart returns a skill-safe fallback", () => {
  assert.equal(sanitizeSkillNamePart("WeChat.exe"), "wechat-exe");
  assert.equal(sanitizeSkillNamePart(""), "workflow");
});

test("buildSkillMarkdown writes valid frontmatter and semantic steps", () => {
  const events = [
    {
      type: "mouse.click",
      application: { processName: "notepad.exe" },
      window: { title: "Untitled - Notepad" },
      target: { uia: { name: "Edit", controlType: "Document" } },
    },
  ];
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-test",
    session: {
      sessionID: "s1",
      eventsPath: "events.jsonl",
      metadataPath: "metadata.json",
    },
    events,
    workflow: analyzeWorkflow(events, {}, { workflowName: "Notepad Save Draft" }),
  });
  assert.match(markdown, /^---\nname: record-replay-test\n/s);
  assert.match(markdown, /# Notepad Save Draft/);
  assert.match(markdown, /## How To Reuse/);
  assert.match(markdown, /Technical skill id: record-replay-test/);
  assert.match(markdown, /## Agent Execution Plan/);
  assert.match(markdown, /The replay contains 1 semantic step\(s\) and 1 cleaned step\(s\) of recorded event evidence/);
  assert.match(markdown, /execute this skill in 5 phase\(s\)/);
  assert.match(markdown, /Execute the 1 semantic replay step\(s\) from the Steps section in order/);
  assert.match(markdown, /## Workflow Summary/);
  assert.match(markdown, /## Recorded Event Evidence/);
  assert.match(markdown, /mouse\.click: use notepad\.exe on "Edit"/);
});

test("buildSkillMarkdown cleans consecutive duplicate replay steps", () => {
  const events = [
    {
      type: "mouse.click",
      application: { processName: "explorer.exe" },
      window: { title: "Program Manager" },
      target: { uia: { name: "Desktop" } },
    },
    {
      type: "mouse.click",
      application: { processName: "explorer.exe" },
      window: { title: "Program Manager" },
      target: { uia: { name: "Desktop" } },
    },
    {
      type: "keyboard.key",
      application: { processName: "ZCode.exe" },
      window: { title: "ZCode" },
      input: { keyName: "Enter" },
    },
  ];
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-dedupe-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events,
    workflow: analyzeWorkflow(events, {}, {
      workflowName: "Click Desktop And Return To Codex",
      workflowSummary: "Click the desktop and return to Codex.",
    }),
  });
  assert.match(markdown, /1\. mouse\.click: use explorer\.exe on "Desktop"\. Repeat 2 times\./);
  assert.match(markdown, /2\. keyboard\.key: press Enter in ZCode\.exe/);
  assert.match(markdown, /The replay contains 1 semantic step\(s\) and 2 cleaned step\(s\) of recorded event evidence/);
  assert.match(markdown, /Execute the 1 semantic replay step\(s\) from the Steps section in order/);
  assert.doesNotMatch(markdown, /3\. keyboard/);
});

test("buildSkillMarkdown puts supplied summaries into semantic steps", () => {
  const events = [
    {
      type: "mouse.click",
      application: { processName: "notepad.exe" },
      window: { title: "codex_rr_smoke.txt - Notepad" },
      target: { uia: { name: "Text editor" } },
    },
    {
      type: "keyboard.key",
      application: { processName: "notepad.exe" },
      window: { title: "codex_rr_smoke.txt - Notepad" },
      input: { keyName: "Ctrl" },
    },
  ];
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-notepad-smoke-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events,
    workflow: analyzeWorkflow(events, {}, {
      workflowName: "Notepad Smoke Text Entry",
      workflowSummary: "Open or focus a temporary Notepad text file, click into the editor, enter two short verification lines, save the file, and verify the text was written.",
    }),
  });
  assert.match(markdown, /## Steps\n\n1\. Open or focus a temporary Notepad text file\./);
  assert.match(markdown, /2\. Click into the editor\./);
  assert.match(markdown, /3\. Enter two short verification lines\./);
  assert.match(markdown, /4\. Save the file\./);
  assert.match(markdown, /5\. Verify the text was written\./);
  assert.match(markdown, /The replay contains 5 semantic step\(s\) and 2 cleaned step\(s\) of recorded event evidence/);
  assert.match(markdown, /## Recorded Event Evidence[\s\S]*keyboard\.key: press Ctrl in notepad\.exe/);
});

test("buildSkillMarkdown quotes YAML descriptions containing colon", () => {
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-colon-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events: [],
    workflow: analyzeWorkflow([], {}, {
      workflowName: "Command Prompt Clipboard File Write",
      workflowSummary: "Open Command Prompt: paste a command, run it, and close the prompt.",
    }),
  });
  assert.match(markdown, /^description: "Use when .* Command Prompt: paste a command/sm);
});
test("analyzeWorkflow derives a semantic slug and allows Codex summaries", () => {
  const workflow = analyzeWorkflow(
    [
      {
        type: "mouse.click",
        application: { processName: "notepad.exe" },
        target: { uia: { name: "Save" } },
      },
    ],
    { sessionID: "20260620-session" },
    {
      workflowName: "Save Notepad Draft",
      workflowSummary: "Save the current draft in Notepad.",
    },
  );
  assert.equal(workflow.title, "Save Notepad Draft");
  assert.equal(workflow.slug, "save-notepad-draft");
  assert.equal(workflow.summary, "Save the current draft in Notepad.");
});

test("analyzeWorkflow keeps action-only names instead of app context", () => {
  const workflow = analyzeWorkflow(
    [
      {
        type: "mouse.click",
        application: { processName: "Atria.exe" },
        target: { uia: { name: "Send" } },
      },
    ],
    { sessionID: "s1" },
    {
      workflowName: "Send Greeting In Atria Chat",
      workflowSummary: "Open Atria Chat, type a greeting, and send it.",
    },
  );
  assert.equal(workflow.title, "Send Greeting");
  assert.equal(workflow.slug, "send-greeting");
});

test("generated skills preserve Chinese visible names while keeping ASCII ids", () => {
  const events = [
    {
      type: "mouse.click",
      application: { processName: "Atria.exe" },
      target: { uia: { name: "发送" } },
    },
  ];
  const workflow = analyzeWorkflow(events, {}, {
    workflowName: "在 Atria 聊天中发送问候",
    workflowSummary: "打开 Atria 聊天窗口，输入问候语，并发送消息。",
  });
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-send-greeting-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events,
    workflow,
  });

  assert.equal(workflow.title, "发送问候");
  assert.equal(workflow.slug, "send-greeting");
  assert.match(markdown, /# 发送问候/);
  assert.match(markdown, /打开 Atria 聊天窗口/);
  assert.match(markdown, /Technical skill id: record-replay-send-greeting-test/);
});

test("installGeneratedSkill writes a unique local skill", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-skill-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-session-"));
  const eventsPath = path.join(sessionDir, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({
      type: "window.changed",
      application: { processName: "notepad.exe" },
      window: { title: "Untitled - Notepad" },
    }) + "\n",
    "utf8",
  );
  const result = installGeneratedSkill({
    sessionID: "s1",
    eventsPath,
    metadataPath: path.join(sessionDir, "metadata.json"),
  }, { skillsRoot: root });
  assert.equal(result.installed, true);
  assert.equal(fs.existsSync(result.skillPath), true);
  assert.match(result.skillName, /^record-replay-notepad-workflow-\d/);
  assert.match(fs.readFileSync(result.skillPath, "utf8"), /## Workflow Summary/);
  assert.match(result.activationNote, /Technical skill id: record-replay-/);
  assert.match(result.activationNote, /Agent Execution Plan/);
  assert.equal(result.reuseInstructions.length, 3);
  assert.equal(result.executionPlan.stepCount, 1);
  assert.equal(result.executionPlan.cleanedEventStepCount, 1);
  assert.equal(result.executionPlan.phases.length, 5);
});

test("installGeneratedSkill replaces earlier skills from the same session when finalizing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-skill-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrw-session-"));
  const eventsPath = path.join(sessionDir, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({
      type: "mouse.click",
      application: { processName: "explorer.exe" },
      target: { uia: { name: "Desktop" } },
    }) + "\n",
    "utf8",
  );
  const session = {
    sessionID: "20260621-065656-19df9234",
    eventsPath,
    metadataPath: path.join(sessionDir, "metadata.json"),
  };
  const draft = installGeneratedSkill(session, { skillsRoot: root });
  assert.match(draft.skillName, /^record-replay-explorer-/);
  assert.equal(fs.existsSync(draft.skillDirectoryPath), true);

  const final = installGeneratedSkill(session, {
    skillsRoot: root,
    workflowName: "Click Desktop And Return To Codex",
    workflowSummary: "Click the desktop and return to Codex.",
    replaceSessionSkills: true,
  });

  assert.match(final.skillName, /^record-replay-click-desktop-and-return-to-codex-/);
  assert.equal(fs.existsSync(final.skillDirectoryPath), true);
  assert.equal(fs.existsSync(draft.skillDirectoryPath), false);
  assert.deepEqual(final.replacedSkillDirectoryPaths, [draft.skillDirectoryPath]);
});

test("skill generation filters Codex host events when replay app events exist", () => {
  const events = [
    {
      type: "recorder.notice",
      application: { processName: "Codex.exe" },
      target: { uia: { name: "app" } },
    },
    {
      type: "mouse.click",
      application: { processName: "Codex.exe" },
      window: { title: "Codex" },
      target: { uia: { name: "Pane" } },
    },
    {
      type: "keyboard.key",
      application: { processName: "WindowsTerminal.exe" },
      window: { title: "RRW_E2E_RECORD_RESTART" },
      input: { keyName: "Enter" },
    },
  ];
  const workflow = analyzeWorkflow(events, {}, {
    workflowName: "Command Prompt Clipboard File Write",
    workflowSummary: "Open Command Prompt, paste a command, run it, and close the prompt.",
  });
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-command-prompt-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events,
    workflow,
  });

  assert.equal(workflow.primaryApp, "WindowsTerminal.exe");
  assert.equal(workflow.actionCounts.clicks, 0);
  assert.equal(workflow.actionCounts.keys, 1);
  assert.doesNotMatch(markdown, /Codex\.exe/);
  assert.doesNotMatch(markdown, /recorder\.notice/);
  assert.match(markdown, /keyboard\.key: press Enter in WindowsTerminal\.exe/);
});

test("generated skill markdown preserves non-ASCII UI labels", () => {
  const events = [
    {
      type: "mouse.click",
      application: { processName: "explorer.exe" },
      window: { title: "桌面 1" },
      target: { uia: { name: "打开" } },
    },
  ];
  const markdown = buildSkillMarkdown({
    skillName: "record-replay-ascii-test",
    session: { sessionID: "s1", eventsPath: "events.jsonl", metadataPath: "metadata.json" },
    events,
    workflow: analyzeWorkflow(events, {}, {
      workflowName: "Explorer Chinese Label Test",
      workflowSummary: "Replay a workflow with Chinese UI labels.",
    }),
  });
  assert.match(markdown, /桌面 1/);
  assert.match(markdown, /打开/);
});
