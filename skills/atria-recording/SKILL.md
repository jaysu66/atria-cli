---
name: atria-recording
description: Records what the user demonstrates - on the Windows desktop or in their browser - into a reusable, replayable workflow, and routes each recording request to the engine that can actually capture it. This skill should be used whenever the user wants to record, capture, or "teach" a workflow by demonstrating it, replay or rerun a previously recorded workflow, turn a manual routine into an automation, capture network traffic or API payloads from a page, or asks which recording mode applies to their task. Trigger phrases include 录一下, 录制, 把我的操作录下来, 教你做一遍, 录成技能, 我演示给你看, 录制工作流, 回放, 重放一遍, 再跑一次那个流程, 抓一下这个页面的接口, 录接口, 抓包, record my workflow, record what I do, teach by demonstration, turn this into a skill, replay that recording, capture the API calls, record network traffic. Use it before starting any recording so the right engine is chosen the first time - picking wrong means the user demonstrates a whole workflow that was never captured.
---

# Atria Recording

Two engines, two different things they capture. **Choose before the user starts demonstrating** - a wrong choice costs them the whole demonstration.

## Routing

| The user wants to capture | Engine | Skill to use |
|---|---|---|
| Clicks and typing in a **native Windows app** | Desktop recorder | `atria-desktop` |
| Clicks and typing **in the browser** | Desktop recorder (Chrome is a Windows window) | `atria-desktop` |
| **Network requests / API payloads** of a page | Browser network capture | `atria-browser-bridge` |
| A workflow spanning **both** app and browser | Desktop recorder - it captures the whole screen | `atria-desktop` |

### Why browser clicks go through the desktop recorder

The open-source browser bridge captures **network traffic only** (`network_start` / `network_stop` / `network_list` / `network_detail`). It has no user-action recorder - the `workflow_record_start` / `workflow_record_stop` tools exist only in the internal Atria build of the bridge, not in `atria-browser-bridge`.

So when the user wants their browser *clicks* recorded, use the desktop recorder: Chrome is an ordinary Windows window, and the UIA tree covers it. Say this plainly if the user expected a browser-native recorder.

## Desktop recording

Full detail lives in the `atria-desktop` skill (`references/recording.md`). The shape:

```
event_stream_start   ->  user demonstrates  ->  event_stream_stop {workflowName, workflowSummary}
                                                    |
                                          requiresCodexRefinement?
                                                    |
                                          event_stream_generate_skill
```

Then replay with `replay_run` (always `dryRun: true` first).

Non-negotiables:
- Pass `excludeApps` so your own harness window is not recorded.
- Name the workflow **action-only**, in the **user's language**.
- Never stop the desktop daemon while a recording is live.
- Tell the user recording has started, then **wait** - do not poll in a tight loop.

## Browser network capture

Through the `atria-browser-bridge` skill:

```
network_start {tabId}  ->  drive or let the user drive the page  ->  network_list {tabId}
                                                                        |
                                                            network_detail {requestId}
network_stop {tabId}   (stops capture and discards the buffer)
```

Use this when the answer lives in an XHR/fetch JSON payload rather than in the rendered HTML - list pages, dashboards, anything paginated. Reading the API response directly beats parsing the DOM.

`network_stop` **discards** the buffer, so pull everything you need with `network_list` / `network_detail` before stopping.

## Before any recording

**Warn about scope.** The desktop recorder captures the entire screen, not one app. Ask the user to close anything private - password managers, personal chats, other clients' work - before they begin.

**Confirm the trigger.** Tell the user exactly when recording is live and exactly how they signal completion, so their "done" gesture is not itself captured as a step.

**Secrets are masked, not replayable.** Redacted text cannot be replayed deterministically; replay will stop with `needsAgent` at that step. If a workflow needs a credential, plan for the user to type it themselves at replay time.
