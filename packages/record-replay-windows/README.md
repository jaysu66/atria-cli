# Record/Replay Windows

Windows-only MCP component for UI Automation control, real mouse/keyboard input,
workflow recording, semantic Skill generation, truthful replay, and optional
standalone action feedback. `skills/record-replay-windows/SKILL.md` contains the
Agent protocol.

## Inputs and outputs

Inputs identify a window/control or physical coordinate, an action, expected
state, recording scope, or replay plan. Outputs contain structured status,
verification, counts, action events and optional screenshot/recording/Skill
paths. `needs_agent`, `partial`, `unknown`, `failed` and `cancelled` are never
converted to success.

## Install

Requirements: Windows, Node.js 18+, Rust stable with the Windows MSVC target,
and normal access to the interactive user desktop.

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\build-native.ps1
npm test
```

The build must produce `bin/actor.exe`, `bin/recorder.exe` and
`bin/overlay.exe` from the same source revision. Review the emitted SHA-256
manifest before using a binary candidate. The source candidate intentionally
omits compiled EXEs and `node_modules`.

## Experience and controls

An Agent normally snapshots UIA, binds the target window, performs one action,
and checks the returned verification before continuing. Enable the optional
overlay with `visual_enable`; use `{required:true}` only when an absent renderer
must stop subsequent writes. The overlay is click-through and non-activating,
shows safe action labels, and does not render typed body text.

Emergency tools are `automation_status`, `automation_pause`,
`automation_resume`, and `automation_stop`. Global pause/stop hotkeys are also
registered by the current overlay. The overlay also exposes tray commands for
Pause/Resume and Stop. A per-user broker owns the single renderer shared by MCP
clients and routes controls to the current operation owner.

Pause also holds actions waiting for the renderer or actor to start. Resume
continues a paused request; Stop cancels waiting requests permanently, so a
later Resume only enables newly submitted work. Actor restart preserves the
current pause/stop intent.

Element-index calls require the `snapshotId` returned by `ui_snapshot`.
For `computer_drag`, both endpoints share that ID; `computer_batch` takes one
top-level ID for all element-index steps. Invalid/stale scroll targets fail
without input. Only an omitted scroll target means the current cursor
position (a batch's shared snapshot alone does not give its scroll step a target).

Example: open an empty test editor and ask the Agent to dry-run a plan that
types “Atria test” without saving. Confirm the selected hwnd/title, enable
visual feedback, execute, then read the field back. Do not begin with a private
or unsaved document.

## Update and rollback

Update the MCP source, Skill, native source and all three EXEs as one version.
Stop only a daemon you own and only when no recording is active; keep user
recordings and generated Skills outside the package. Run `npm test`, compare the
binary hashes with the release manifest, then restart the daemon. Roll back the
same complete set—never pair a newer JS protocol with older native programs.

## Privacy, tested scope and limits

UI text, screenshots and recordings can contain private data and may enter an
Agent/model session. Default text recording is redacted and recording screenshots
are off. Key-event screenshots require explicit `capturePolicy:"key_events"`
with `redactText:false`; that opt-in can persist visible private content and is
intended only for a prepared fixture. Redacted input becomes a `needs_agent`
replay step. Confirm send/delete/pay/publish and unsaved-close operations
immediately before execution.

The current remediation source passed Node and Rust suites on Windows. Broker
singleton, reconnect and owner routing are covered with fake-renderer tests;
tray command mapping is covered by Rust tests. The rebuilt native candidate has
not yet been exercised with real input or a visible tray. A clean Windows
user/VM, two real Agent hosts, every DPI and negative-coordinate monitor
arrangement, live tray control, live cross-host renderer recovery, and
overlay-free Agent screenshots remain separate release gates.
