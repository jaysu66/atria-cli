# Atria Recording Skill

This routing Skill chooses the correct capture engine before a user demonstrates a workflow. Desktop/browser clicks use the Windows recorder; page API traffic uses Browser Bridge network capture.

## Input and output

- Input: what the user wants to capture, excluded applications, and a semantic workflow name/summary.
- Output: a local recording session, redacted event evidence, and optionally a generated Skill for deterministic replay.
- Network capture output is request metadata/body evidence from the selected tab; stopping capture discards its buffer.

## Requirements and install

Install from the kit root with `install.ps1`. Desktop recording requires Windows 11, Node.js 18+, `record-replay-windows`, `recorder.exe`, and `actor.exe`. Network capture requires the matching Browser Bridge and paired extension.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -BrowserDir C:\path\to\browser-bridge -DesktopDir C:\path\to\record-replay-windows
```

## Example and experience

For a desktop demonstration: start `event_stream_start` with the default `capturePolicy:off`, tell the user recording is live, wait for completion, then call `event_stream_stop`. Generate a Skill only after reviewing the semantic summary. Always run `replay_run` with `dryRun:true` before a real replay.

Use `automation_pause`, `automation_resume`, or `automation_stop` for replay control. The optional standalone overlay visualizes execution; `event_stream_panel` is a different host-only recording widget. Neither replaces verification of the target application's state.

## Privacy, update, rollback

The desktop recorder sees the whole screen. Close private applications and pass `excludeApps`. Secrets are masked and become `needsAgent`; they are never embedded into generated Skills. Key-event screenshots are off by default. Enabling them requires `capturePolicy:key_events` together with `redactText:false`, which can persist visible private content and is intended only for an isolated fixture. Update the routing Skill, desktop engine, Browser Bridge, and manifests as compatible versioned components. Roll back all matching components together while preserving user recordings, pairing tokens, and configuration outside the package.

Tested: Windows 11 and the local desktop/network capture routes. Limits: no browser-native click recorder, no guarantee that every host renders the MCP widget, and no completed clean-VM or full display-matrix acceptance. Native redistribution licensing remains under review; keep this candidate private.
