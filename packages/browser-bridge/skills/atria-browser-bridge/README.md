# Atria Browser Bridge Skill

This Skill lets an MCP-capable Agent read and operate the user's real Chrome
through a local server and an unpacked MV3 extension. `SKILL.md` is the Agent
protocol; this file is the user-facing install and experience guide.

## Inputs and outputs

Inputs are a URL or tab id, page references, coordinates, form values, local
upload paths, and an explicit task. Outputs are structured page data, verified
action results, real screenshots/PDF files, and optional network records.
`computer` results also report whether the visible tab-scoped marker rendered.

## Install and update

Requirements: Node.js 18+, Chrome/Chromium, this complete component directory,
and an MCP-capable Agent.

1. Start `node mcp-server.js --standalone`.
2. Open `chrome://extensions`, enable Developer mode, and load `extension/`.
3. Use the extension popup to pair with the random local token.
4. Register `node mcp-server.js` as an MCP server or install this whole Skill
   directory in the host's Skill root.

For an update, replace server, extension, helper script and Skill from the same
release, restart the local server, reload the unpacked extension, then check
`browser_status` before acting. Do not mix protocol versions. To roll back,
restore all four pieces from the previous fixed release and reload again; user
Chrome profiles and cookies are not part of the package and must not be copied.

## User experience

Ask, for example: “Open this test page, click the Save button, and verify the
result.” The Agent lists tabs, reads the page, resolves a live target and sends
one real input. The requested tab shows a click-through target/cursor/ripple and
a short lifecycle label. Typing labels show only character count. Background
tabs identify themselves separately. Restricted pages show an explicit visual
limitation in the result rather than a false rendered-success claim.

## Pause, privacy and limits

The browser component has no global pause switch: stop/cancel the calling Agent
task to prevent new browser calls. Windows `atria automation pause|resume|stop`
commands do not control Chrome.

Page content and network responses are not automatically redacted and can reach
the model/session log. Never ask the Agent to type credentials, payment data or
government identifiers. Confirm publish, pay, delete, send and permission
changes immediately before the real action. Cross-origin iframe content and
restricted browser pages are not directly readable. Screenshots are real images
or explicit failures, never DOM illustrations.

The candidate was exercised with an isolated local MCP client and Chrome for
Testing 153 on Windows. Cross-host Agent acceptance and real cross-origin iframe
coordinate measurement remain separate release gates; this README does not
claim them complete.
