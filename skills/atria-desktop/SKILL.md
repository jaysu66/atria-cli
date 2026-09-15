---
name: atria-desktop
description: Drives the user's real Windows desktop through the Atria record-replay suite - read a window's accessibility tree as numbered elements, click and type into native apps with real input, focus windows, batch actions, take screenshots, record a demonstrated workflow into a reusable skill, and deterministically replay it. Use whenever the user wants to operate a Windows desktop application, automate a GUI task outside the browser, inspect the screen, list or focus windows, record what they demonstrate, or replay a recorded workflow. Trigger phrases include 操作桌面, 帮我点, 桌面自动化, 控制这个软件, 看看屏幕, 录一下我的操作, 录制工作流, 回放那个流程, Windows 自动化, control this app, automate this desktop task, what is on my screen, record my workflow, replay the recording. The local daemon starts itself and the skill handles perception, element indexes, verification, pause, and optional visual feedback. Windows only.
---

# Atria Desktop

Control the user's **real Windows desktop** through the record-replay-windows MCP suite: UI Automation perception, real input, workflow recording, and deterministic replay.

## Calling convention

Every call goes through the helper script at `scripts/desktop.js` **inside this skill's own base directory** - the absolute path reported when this skill loaded. Write `<skill-dir>` below as that path; never assume `.claude`, since this skill also ships to other agent harnesses.

**Always** pass arguments as a JSON file with `@`:

```bash
node "<skill-dir>/scripts/desktop.js" <tool> @<args.json>
```

Write the args file with the Write tool - never with shell `echo`/heredoc. Use a unique filename per call so concurrent calls never collide. Delete it once the call returns.

**Never pass inline JSON.** Windows PowerShell 5.1 strips the inner double quotes when handing arguments to a native process, so inline JSON reliably fails to parse. The `@file` form is the only correct form.

For a tool that takes no arguments, omit the second argument entirely:

```bash
node "<skill-dir>/scripts/desktop.js" ui_snapshot
```

### What the script returns

- Text content is printed to stdout, truncated at 30 000 chars.
- **Screenshots are written to disk** and reported as `[image saved] <path>` - open that path with the `Read` tool to actually see the image. The base64 never reaches the transcript.
- The full raw JSON response is always written to a file, reported as `[raw] <path>`. Read it when output was truncated or looks wrong.

### Startup

The script starts its own daemon on first call - never ask the user to start anything. To check or control it explicitly:

```bash
node "<skill-dir>/scripts/desktop.js" --health
node "<skill-dir>/scripts/desktop.js" --start
node "<skill-dir>/scripts/desktop.js" --stop
node "<skill-dir>/scripts/desktop.js" --tools
```

The daemon holds the MCP server process open on `127.0.0.1:47653`. **Do not `--stop` it while a recording is active** - stopping the daemon kills the recorder.

## The core loop: snapshot, then act by index

`ui_snapshot` is the primary perception tool. It lists every interactive element of a window as numbered text drawn from the OS accessibility tree, so **acting precisely never requires vision**. Prefer it over screenshots.

```
ui_snapshot            ->  numbered elements with names and coordinates
computer_click         ->  {"elementIndex": 7}
```

Element indexes go stale as soon as the UI changes. Actions return fresh state automatically, so re-read the returned state rather than re-snapshotting blindly. When an action changed the layout, take a new `ui_snapshot` before using an index again.

Use `computer_screenshot` for **visual confirmation only** - when the user asks what something looks like, or when the accessibility tree is empty (custom-drawn UI, canvas, games).

## Tools

**Perception**
- `ui_snapshot` - numbered interactive elements of the foreground or named window. Start here.
- `ui_find` - find elements by name/automationId/controlType within a window scope.
- `ui_wait_for` - poll inside one call until an element appears. Use after navigation or dialogs instead of look-click-look round trips.
- `computer_screenshot` - scaled screen capture, returns the image. `physical = image_coord * scale`.
- `computer_window_list` - visible top-level windows (hwnd/title/pid/processName) plus the foreground one.

**Action**
- `computer_click` - prefer `{elementIndex}` from `ui_snapshot`; `{x, y}` also works.
- `ui_set_value` - set a text field via UIA ValuePattern with **verified write** (reads the value back). The most reliable way to fill inputs - prefer it over `computer_type` for real fields.
- `computer_type` - type text, CJK supported, `\n` = Enter. `clearFirst: true` replaces content via Ctrl+A.
- `computer_key` - a key or combo: `enter`, `ctrl+s`, `alt+f4`. Pass `expect` to hard-verify the foreground window first.
- `ui_invoke` - act on a UIA element with no mouse at all: `invoke` / `click` / `focus` / `set_value`. Prefer this over coordinates whenever the element is findable.
- `computer_move`, `computer_drag`, `computer_scroll` - smooth, visible mouse motion.
- `computer_window_focus` - bring a window forward by hwnd, title substring, or processName. Returns whether focus actually landed - check it.
- `computer_batch` - several deterministic actions in ONE call. Stops on first error. **Indexes inside a batch refer to the snapshot taken before the batch**, so if an early action changes the UI, use coordinates or keyboard-only follow-ups for the rest.

**Recording and replay** - see `references/recording.md` for the full workflow.
- `event_stream_start` / `event_stream_status` / `event_stream_stop`
- `event_stream_generate_skill`, `event_stream_panel`
- `replay_run`, `replay_note_fix`

**Automation control and evidence**
- `automation_status` - read the active operation and pause/stop state; an optional `operationId` reads one known operation.
- `automation_pause` / `automation_resume` / `automation_stop` - control the current write session. After pause is acknowledged, do not send another action until resume.
- `action_events_recent` - inspect truthful intent/dispatched/succeeded/failed/cancelled events. Treat `unknown` as unknown; never retry it automatically.

**Independent visual feedback**
- `visual_status` - report visual mode, renderer readiness and connection state.
- `visual_enable` - enable the standalone Windows overlay; pass `required:true` when execution must stop if rendering is unavailable.
- `visual_disable` - turn the overlay off. Desktop execution remains available.

The independent overlay is not the same as `event_stream_panel`. The overlay is a small click-through Windows helper that can work for any host; `event_stream_panel` is an MCP host widget and appears only in hosts that render MCP resources. Do not promise that every host can show the widget.

Action results include an operation status. `succeeded` means the executor confirmed the action. `failed` and `cancelled` are terminal. `needs_agent` means the user or agent must supply missing information, commonly redacted text. `unknown` means delivery may have occurred; inspect `automation_status` or the target state before deciding what to do. A visual animation is evidence of renderer acknowledgement, not evidence that an OS action succeeded.

## Rules that keep this reliable

**Verify focus before typing.** Typing goes to whatever window has focus. Call `computer_window_focus` and check the returned flag, or pass `expect` to `computer_key`, before sending input that matters.

**Prefer verified writes.** `ui_set_value` reads the value back; `computer_type` does not. For anything the user cares about - a form field, a search box, a filename - use `ui_set_value` when the element supports it.

**Never guess coordinates.** If `ui_snapshot` did not surface the element, use `ui_find` or `ui_wait_for`. Falling back to raw x/y from a screenshot is the last resort, and it needs the `scale` factor applied.

**Batch only deterministic runs.** `computer_batch` is for sequences you already know work. While exploring, act one call at a time and read the returned state.

**This is the user's real machine.** Actions are visible and immediate. Before anything destructive - closing an unsaved window, deleting, submitting a payment, sending a message - confirm with the user first.

**Use dry-run for replay.** Call `replay_run` with `dryRun:true` first. If a step returns `needsAgent`, stop and hand control back instead of inventing missing text or input semantics.

**Keep recording screenshots off by default.** `event_stream_start` defaults to `capturePolicy:"off"`. Key-event screenshots require explicit `capturePolicy:"key_events"` plus `redactText:false`; use that only in a prepared non-private fixture because visible screen text can be persisted.

**Check versions before acting.** Run `--health` and compare the bridge protocol with the packaged component manifest. Refuse writes when protocol versions differ. This private candidate is tested on Windows 11 with Node.js 18+. Its per-user broker singleton/reconnect and tray command mapping are covered by automated tests, while live multi-host recovery and visible tray interaction remain unverified. Clean-machine installation, all DPI combinations, hot-plug displays, and overlay exclusion from every screenshot path are also still open.

## References

- `references/recording.md` - record a demonstrated workflow into a reusable skill, and replay it.
- `references/setup.md` - suite location, ports, environment overrides, troubleshooting.
