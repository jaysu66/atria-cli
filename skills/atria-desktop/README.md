# Atria Desktop Skill

This Skill lets an Agent inspect and operate the current user's Windows desktop through UI Automation and real input, record demonstrations, replay deterministic workflows, and optionally show a click-through action overlay. It works without the Atria desktop product.

## Input and output

- Input: one named tool plus a JSON argument file, for example `computer_click` with an element index from `ui_snapshot`.
- Output: structured text, a truthful operation status, a raw JSON evidence path, and an image path only when a screenshot was requested.
- Sensitive typed content is redacted from recording and visual labels. Redacted text is returned as `needsAgent`, not guessed.

## Requirements and install

- Windows 11, Node.js 18+, and the matching `record-replay-windows` source/dependencies.
- Native `actor.exe` and `recorder.exe`; `overlay.exe` is optional.

From the kit root:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DesktopDir C:\path\to\record-replay-windows
```

The installer copies this Skill into `~/.agents/skills`. Explicit `-DesktopDir` or `ATRIA_DESKTOP_SUITE_DIR` wins over the bundled runtime; documented legacy paths are compatibility fallbacks only.

## Example and user experience

```powershell
node "$HOME\.agents\skills\atria-desktop\scripts\desktop.js" ui_snapshot
node "$HOME\.agents\skills\atria-desktop\scripts\desktop.js" visual_enable '{"required":false}'
```

The Agent first reads numbered accessible controls, then acts on an index and verifies the returned state. When enabled, the independent overlay shows the true action location/status while remaining click-through and non-activating. `event_stream_panel` is a separate host widget and is unavailable in hosts that do not render MCP resources.

## Pause, stop, privacy

Use `automation_pause`, `automation_resume`, and `automation_stop`. After pause is acknowledged, the Agent must not issue another write until resume. Before recording, close private windows and use `excludeApps`; recording covers the whole desktop. Recording screenshots are off by default. Explicit key-event screenshot capture requires `redactText:false` and may persist visible private content. Screenshots and raw results stay on the local machine.

## Update and rollback

Stop active recordings, replace the Skill and matching runtime as one versioned set, run `--health`, and verify the protocol before writes. To roll back, restore both the prior Skill directory and prior runtime/binary hashes; user recordings and local token/config files live outside the package and must not be deleted.

Tested: Windows 11, Node.js 18+, direct helper calls and an MCP client. Not yet proven: clean VM installation, every Agent host, tray UI, 100/150/200% multi-monitor alignment, hot-plug displays, and overlay exclusion from every screenshot API. Source is included in the Apache-2.0 candidate; no prebuilt native executable is distributed.
