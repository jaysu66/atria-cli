---
name: record-replay-windows
description: Use when the user wants to record a Windows desktop workflow with the Record & Replay Windows plugin, check event-stream recording status, stop a recording, inspect generated events.jsonl files, or generate a reusable Codex skill from a recorded Windows workflow.
---

# Record & Replay Windows

Use the `event-stream` MCP tools exposed by this plugin:

1. Call `event_stream_start` before the user demonstrates a workflow. This renders the Record & Replay panel with elapsed time and a Stop button.
2. Let the user perform the workflow normally in Windows.
3. Call `event_stream_status` if you need paths, event counts, or active recording state.
4. Call `event_stream_stop` when the workflow is complete. If you already understand the workflow, pass both `workflowName` and `workflowSummary` so the generated skill is named from Codex's summary. Make `workflowName` action-only: keep the reusable action and omit app/window/location context such as `in Atria Chat` unless it is essential. Use the user's primary language when it is clear; for Chinese users, pass Chinese `workflowName` and `workflowSummary`. If you omit them, the server first tries MCP sampling to have Codex summarize and semantically name the workflow before installing the skill.
5. If `event_stream_stop` returns `summarySource: "codex-sampling"` or `summarySource: "codex-summary"` and `requiresCodexRefinement` is false, treat the generated skill as the final semantic skill.
6. If `event_stream_stop` returns `requiresCodexRefinement: true`, do not stop. Review `codexRefinementContext`, inspect the draft `generatedSkill.skillPath` or returned event summary as needed, then immediately call `event_stream_generate_skill` with the same `sessionID` plus a better semantic `workflowName` and `workflowSummary`.
7. Only report completion after a semantic generated skill result is installed, unless the user explicitly asked for a draft only.
8. When reporting completion, proactively tell the user the generated skill's visible action title, technical skill id/path, and how to reuse it: start a new Codex thread or restart Codex, then ask Codex to replay the visible action title. Do not present the ASCII technical id as the user-facing name when a better display title is available. Also summarize the generated skill's `Agent Execution Plan`: how many semantic replay steps it contains, how many cleaned event-evidence steps it keeps, how many execution phases the next agent should follow, and what each phase does.

If the user asks for the visible recording control, call `event_stream_panel`. The panel first uses a token-protected local loopback control channel served by a lightweight `panel-control-server.mjs` helper so Start, Refresh, and Stop can update the same recorder state even when host MCP app server-tool proxying is unavailable or the stdio MCP process does not stay alive for the panel. The panel retries the configured local endpoints briefly while the helper starts. If the panel sends a user message that a draft skill was generated or includes `recordReplayAction.status.requiresCodexRefinement`, immediately review the supplied status/context and call `event_stream_generate_skill`; do not ask the user to repeat "stop" first. If both direct control paths are unavailable, the panel may send a user message asking Codex to start, refresh, or stop; respond by calling the requested event-stream tool yourself.

The stop tool writes the final session files and installs a semantic skill when Codex sampling or supplied summary data is available. Generated skills are installed under the user's configured Skill root (for example `%USERPROFILE%\\.codex\\skills`); folders use `record-replay-<workflow-slug>-<timestamp>` and keep the session ID only as source-recording metadata. The folder/frontmatter `name` is a technical ASCII id for Codex compatibility; the Markdown title and `displayName` are the user-facing name and may be Chinese. A draft skill from automatic event analysis is only a fallback so the recording is not lost; Codex should refine it into a semantic skill before presenting the result. When `event_stream_generate_skill` finalizes a recording, it removes earlier `record-replay-*` draft skill directories that point to the same source session, so the user sees the semantic name instead of a stale session or automatic-analysis name. Final skills include `How To Reuse`, `Agent Execution Plan`, semantic `Steps`, and `Recorded Event Evidence` that collapses consecutive duplicate low-level events. The execution plan must tell the next agent to load the skill, inspect the current UI, choose the safest control tool, execute the semantic steps in order, consult event evidence only for UI targets/fallback details, and verify the outcome.

Session files are stored under:

```text
%LOCALAPPDATA%\Codex\EventStream\sessions\<sessionID>\
```

Prefer the generated skill's semantic steps over raw coordinates. For browser workflows, use the event stream as evidence and prefer Browser/Chrome tooling for later execution when possible.
