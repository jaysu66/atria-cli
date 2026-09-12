---
name: atria-cli-overview
description: Use when the user asks what Atria CLI can do, which Atria capability to use, how browser/desktop/recording modes differ, or how to start and verify a local Atria capability.
---

# Atria CLI overview

Use this Skill as the capability map for the local `atria-cli` bundle. It is a
thin entrypoint: it routes to separate engines and must not imply that every
component is installed or publicly licensed.

## Choose the capability

- Website, logged-in Chrome page, page extraction, form interaction, screenshot,
  or network/API capture: use `atria-browser-bridge`.
- Native Windows application, window focus, UI Automation, real desktop input,
  or a cross-app workflow: use `atria-desktop`.
- “Record what I demonstrate”, “turn this into a reusable Skill”, or replay a
  recorded workflow: start with `atria-recording`; it selects the engine.
- Low-level event-stream start/stop/status/generate/replay operations: use
  `record-replay-windows` after confirming its Windows runtime is installed.

Browser clicks are recorded by the desktop recorder. The public Browser Bridge
captures page network traffic, not a browser-native click recording.

## Start and verify

From the bundle root:

```powershell
npm run doctor
node .\bin\atria.mjs skills list
node .\bin\atria.mjs browser --standalone
```

Use `doctor --json` before claiming that a capability is runnable. A source
component can be present while its dependencies, Chrome extension, Rust toolchain,
or native binaries are still missing.

## Operating rules

1. Keep execution local unless the user explicitly chooses an external service.
2. Read the selected capability Skill before calling its tools; do not invent a
   second engine or bypass its helper scripts.
3. For desktop work, inspect the current UI and verify focus before typing.
4. For recordings, warn that the whole screen may be captured, exclude private
   apps, and dry-run a replay before a consequential run.
5. Confirm destructive or externally visible actions immediately before they
   occur. Do not expose cookies, passwords, OTPs, tokens, or generated session
   exports.
6. Report source-ready, runtime-ready, and license-ready as separate states.

## User-facing explanation

Describe Atria CLI as a local capability layer: the user can ask an Agent to
operate a browser or Windows app, or teach a repeatable workflow by demonstration.
Do not call this bundle a one-click installer or a cloud service. The current
preview requires manual Chrome extension setup and a separately built Windows
native runtime for desktop recording/replay.

Read the root `README.md`, `docs/QUICKSTART.md`, and the selected capability's
`SKILL.md` for setup details; do not load unrelated component documentation.
