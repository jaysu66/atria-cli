# Record/Replay Windows component

This component provides the Windows desktop MCP server, semantic workflow
recording, Skill generation, replay helpers, and Rust native recorder source.

The public preview intentionally excludes `bin/*.exe`, `target/`, and
`node_modules/`. Build and install them locally only after reviewing the
component's source and license status.

## Local setup

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\build-native.ps1
```

Run the component smoke test:

```powershell
npm run smoke:mcp
```

The first run should use a low-risk test application. Recording and replay can
observe or control the Windows desktop, so confirm the target window and user
intent before high-impact actions.

This component is a source candidate in the Atria CLI preview. It has no final
redistribution license in this bundle yet; see the root `LICENSE-STATUS.md`.
