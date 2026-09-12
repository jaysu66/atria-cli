# Recording and replay

Record what the user demonstrates on their Windows desktop into a reusable skill, then replay it deterministically.

## Record

**1. Arm the recorder.**

```bash
node "<skill-dir>/scripts/desktop.js" event_stream_start @start.json
```

```json
{ "excludeApps": ["atria", "electron"] }
```

`excludeApps` matches process names by lowercase substring. Exclude your own harness window so the user's "I'm done" click does not land in the recording. All parameters are optional.

**2. Tell the user to demonstrate, then stop talking.**

Say clearly that recording has started and that you are waiting. Do not poll in a tight loop - the user needs time. `event_stream_status` returns `isRecording` and the captured event count when you do want to check.

Optionally open the on-screen panel with elapsed time and Start/Stop controls:

```bash
node "<skill-dir>/scripts/desktop.js" event_stream_panel
```

**3. Stop, and name the workflow.**

```bash
node "<skill-dir>/scripts/desktop.js" event_stream_stop @stop.json
```

```json
{
  "workflowName": "导出本月对账单",
  "workflowSummary": "在网银客户端筛选当月流水并导出 Excel 到桌面"
}
```

Naming rules that matter:
- **Action-only.** Keep the reusable action, omit app/window/location context unless it is essential. "导出本月对账单", not "在网银客户端里导出本月对账单".
- **Same language as the user.** If they spoke Chinese, name it in Chinese.
- Summary describes what the workflow accomplishes, not the click sequence.

**4. Refine if asked.**

If `event_stream_stop` returns `requiresCodexRefinement`, the server could not produce a semantic name on its own. Read the returned event summary, then immediately call:

```bash
node "<skill-dir>/scripts/desktop.js" event_stream_generate_skill @gen.json
```

```json
{
  "workflowName": "导出本月对账单",
  "workflowSummary": "在网银客户端筛选当月流水并导出 Excel 到桌面"
}
```

Do not report the recording as finished before this call returns - without it the skill stays a draft.

The generated skill installs into the skills root (`CODEX_SKILLS_ROOT`, default `~/.codex/skills`).

## Replay

```bash
node "<skill-dir>/scripts/desktop.js" replay_run @replay.json
```

```json
{ "sessionID": "...", "dryRun": true }
```

- Omit `sessionID` to replay the latest session.
- **Run `dryRun: true` first** and show the user the plan before touching their machine.
- Replay is UIA-first with coordinate fallback; special keys are re-sent.

### When replay stops with `needsAgent`

Typed text that was redacted at record time cannot be replayed deterministically - passwords, tokens, anything the recorder masked. The run halts and hands control back to you.

Do this:
1. Read the step description in the generated skill to see what text belongs there.
2. Supply it yourself with `computer_type` (or `ui_set_value`).
3. Resume from the next step:

```json
{ "sessionID": "...", "startIndex": 12 }
```

If the user must supply a secret, ask them to type it themselves - never enter credentials on their behalf.

### Record what you fixed

When a step failed deterministic replay and you completed it another way, append a fix note so future replays prefer the corrected path:

```bash
node "<skill-dir>/scripts/desktop.js" replay_note_fix @fix.json
```

This writes into the skill's `## Fix Log`. Do it in the same turn you worked around the failure, while you still know what actually worked.

## Cautions

- **Never `--stop` the daemon while recording.** It owns the recorder process; stopping it discards the session.
- Recording captures the whole desktop, not one app. Warn the user to close anything private before they start.
- Default max duration is 1800 seconds.
