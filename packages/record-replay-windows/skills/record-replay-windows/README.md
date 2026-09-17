# Record/Replay Windows Skill

This Skill records a user's Windows demonstration as redacted semantic events, generates a reusable Skill, and replays deterministic steps through the matching native engine. It is the engine-specific companion to the higher-level `atria-recording` routing Skill.

## Input and output

- Input: excluded applications, optional session metadata, and a semantic workflow name/summary.
- Output: local `events.jsonl`, a recording summary, a generated Skill, and truthful replay statuses such as `succeeded`, `failed`, `cancelled`, `unknown`, or `needsAgent`.
- Text content and secrets are redacted. A redacted input is never reconstructed; replay stops at `needsAgent`.

## Requirements and install

Windows 11, Node.js 18+, Rust for source builds, npm dependencies, and freshly built `actor.exe`/`recorder.exe`. `overlay.exe` is optional visual feedback. From the package directory:

```powershell
npm install
npm run build:native
npm test
```

Start the matching MCP server only after its protocol and binary hashes agree with the candidate manifest.

## Example and controls

Call `event_stream_start`, let the user demonstrate, then call `event_stream_stop` and review the semantic result before `event_stream_generate_skill`. Run `replay_run` with `dryRun:true` first. During an active replay use `automation_pause`, `automation_resume`, or `automation_stop`; inspect `automation_status` and `action_events_recent` rather than retrying an `unknown` result.

The independent overlay may be controlled with `visual_status`, `visual_enable`, and `visual_disable`. It is separate from the host-rendered `event_stream_panel` widget and does not prove an OS action succeeded.

## Privacy, update, rollback, limits

Recording covers the whole desktop, so close private applications and pass `excludeApps`. Key-event screenshots are off by default. The explicit combination `capturePolicy:key_events` and `redactText:false` can persist visible private content and is intended only for a prepared fixture; `redactText:true` with key-event screenshots is rejected before recording starts. Generated workflows, tokens, and recordings remain outside the distributable package. Update source, Skill, dependencies, and native binaries as one compatible set. For rollback, restore the prior set by recorded SHA-256 values without deleting user recordings or configuration.

Tested on Windows 11 with Node.js 18+ and the local MCP path. Per-user broker singleton/reconnect and tray command mapping are covered by automated tests, but live multi-host recovery and visible tray interaction are not yet proven. Clean-VM installation, every Agent host, all DPI/display layouts, and every screenshot-exclusion path also remain open. Native redistribution licensing remains under review; keep the binary candidate private.
