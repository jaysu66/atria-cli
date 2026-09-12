# Setup and troubleshooting

## What this skill needs

- **Windows.** The suite ships native `actor.exe` and `recorder.exe`; there is no macOS/Linux path.
- **Node.js 18+** on PATH.
- The **record-replay-windows suite** present locally.

## Suite location

`desktop.js` probes these paths in order and uses the first one containing `mcp/server.mjs`:

1. `$ATRIA_DESKTOP_SUITE_DIR`
2. `$AGENT_WORKBENCH_DESKTOP_AUTOMATION_DIR`
3. `~/Desktop/codex-record-replay-computer-use-suite/plugins/record-replay-windows`
4. `~/codex-personal-marketplace/plugins/record-replay-windows`

If the suite lives elsewhere, set `ATRIA_DESKTOP_SUITE_DIR` to its directory.

## Environment overrides

| Variable | Default | Meaning |
|---|---|---|
| `ATRIA_DESKTOP_SUITE_DIR` | probed | Suite directory containing `mcp/server.mjs` |
| `ATRIA_DESKTOP_HOST` | `127.0.0.1` | Daemon bind host |
| `ATRIA_DESKTOP_PORT` | `47653` | Daemon port (browser bridge uses 47652) |
| `ATRIA_DESKTOP_OUT` | `%TEMP%/atria-desktop` | Where screenshots and raw JSON land |
| `CODEX_SKILLS_ROOT` | `~/.codex/skills` | Where generated workflow skills install |

## Architecture

```
agent  ->  desktop.js (CLI)  --HTTP 47653-->  daemon  --stdio JSON-RPC-->  mcp/server.mjs  ->  actor.exe / recorder.exe
```

The daemon exists because recording is stateful: `server.mjs` calls `closeRecorder()` when its process exits, so a one-shot spawn per tool call would kill any active recording. The daemon keeps one MCP server alive across calls.

## Troubleshooting

**`suite not found`** - set `ATRIA_DESKTOP_SUITE_DIR` to the directory that contains `mcp/server.mjs`.

**`daemon did not become ready`** - run the daemon in the foreground to see its stderr:

```bash
node "<skill-dir>/scripts/desktop.js" --daemon
```

**Stale daemon after a suite update** - the daemon holds the old code. Restart it:

```bash
node "<skill-dir>/scripts/desktop.js" --stop
node "<skill-dir>/scripts/desktop.js" --start
```

**Port already in use** - another daemon is live. `--health` tells you its pid; `--stop` shuts it down.

**Empty `ui_snapshot`** - the window draws its own UI and exposes no accessibility tree (games, canvas apps, some Electron builds). Fall back to `computer_screenshot` plus coordinates, remembering `physical = image_coord * scale`.
