# Provenance boundary

This repository is assembled from project-controlled Atria source snapshots.

| Area | Recorded source | Distribution boundary |
| --- | --- | --- |
| CLI wrapper and overview Skill | This repository | Apache-2.0 source |
| Browser Bridge | `Atria/02-CLI与通用能力/browser-bridge` at the commit recorded in `manifests/source-files.json` | Existing MIT-licensed source |
| Record/Replay Windows | `Atria/02-CLI与通用能力/desktop-recording/plugins/record-replay-windows` at the recorded commit | Apache-2.0 source; no prebuilt native executable |
| Desktop and recording Skills | Recorded `dsh-kit` Skill snapshots | Apache-2.0 documentation and instructions |

`manifests/source-files.json` records every synchronized source file and its
SHA-256. The verifier rejects undeclared files inside synchronized roots.

The public source boundary excludes compiled executables, `node_modules`,
recordings, generated user Skills, browser profiles, cookies, credentials,
customer or company knowledge, local project memory, logs, and internal
deployment material. Native binaries must be built from the released source or
published separately with their own signed provenance and notices.
