# Third-party notices

This source release uses third-party packages through the Node.js and Rust
package ecosystems. Those packages are not relicensed by Atria.

- Exact resolved names, versions, ecosystems, and declared license expressions:
  [`manifests/dependency-licenses.json`](manifests/dependency-licenses.json)
- SPDX 2.3 software bill of materials:
  [`manifests/sbom.spdx.json`](manifests/sbom.spdx.json)
- Authoritative resolution inputs:
  `packages/record-replay-windows/package-lock.json` and
  `packages/record-replay-windows/native/recorder/Cargo.lock`

The bundled `packages/browser-bridge` component is Atria software distributed
under its existing MIT license. The remaining project-controlled source is
distributed under Apache License 2.0 unless a file states otherwise.

Run `npm run release:metadata:check` before a release. When dependencies
change, run `npm run release:metadata`, review the diff and upstream license
texts, then commit the refreshed manifests. A machine-generated inventory does
not replace compliance with each dependency license.
