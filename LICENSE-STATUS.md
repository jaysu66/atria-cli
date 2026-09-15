# License and publication status

This directory is a `0.2.0-private.4` review candidate, not a public or final legal release.

Before creating a public repository or publishing a package:

1. Confirm ownership and redistribution rights for every component and native binary.
2. Generate a dependency license report and SBOM from clean installs.
3. Remove private paths, credentials, cookies, customer data, recordings, and internal deployment details.
4. Assign a license to the CLI wrapper and each self-owned component.
5. Keep components with unresolved provenance in a private repository.

The Browser Bridge component currently carries its own MIT license. The
Record/Replay and dsh wrapper components still require a separate provenance
and license decision; the root package intentionally does not override them.
Source and native-binary candidates are kept separate. The native candidate is
PRIVATE REVIEW ONLY and must not be redistributed until ownership, third-party
notices, dependency licenses, and clean-build provenance are approved.
