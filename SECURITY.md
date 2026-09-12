# Security boundary

Atria CLI can drive a real browser and Windows desktop. Treat page content,
UI text, recordings, and generated Skills as untrusted input.

- Keep services on loopback and review permissions before enabling actions.
- Do not use the bridge on pages containing secrets, payment data, or one-time codes.
- Require user confirmation before sending, publishing, paying, deleting, uploading, or granting access.
- Do not place cookies, tokens, `.env` files, login state, or customer data in this repository.
- Report security issues privately before publishing a reproduction containing sensitive data.
