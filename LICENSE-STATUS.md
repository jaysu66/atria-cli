# License and publication status

`0.2.0-rc.1` is a source-only public release candidate. The repository is
still private until the maintainer performs the explicit visibility switch.

## License map

| Component | License | Public release boundary |
| --- | --- | --- |
| Root CLI, Record/Replay Windows source, Atria Skills | Apache-2.0 | Source files only |
| Bundled Browser Bridge | MIT | Its existing `packages/browser-bridge/LICENSE` applies |
| Node.js and Rust dependencies | Their upstream licenses | See generated dependency inventory and SPDX SBOM |
| Compiled native executables | Not included | Build locally; any future binary release needs signed provenance and matching notices |

The root Apache-2.0 license does not relicense third-party dependencies or the
MIT Browser Bridge. It also does not grant Atria trademark rights.

Before changing repository visibility or creating a tag:

1. Run `npm test`, `npm run verify`, and `npm run release:metadata:check`.
2. Run the Rust tests on Windows from the locked dependency graph.
3. Confirm the full-history secret scan passes on the candidate commit.
4. Confirm no executable, recording, credentials, browser profile, customer
   material, company knowledge, or local memory is tracked.
5. Review the release diff and obtain the maintainer's explicit public-release
   authorization.

This is an engineering release boundary, not legal advice. If ownership of a
specific file is disputed or unclear, remove it from the public candidate until
the right to distribute it is confirmed.
