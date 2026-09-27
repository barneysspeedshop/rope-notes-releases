# Release catalog

This repository publishes `stable.jws`, a signed Rope Notes update catalog.
Keep the repository free of release artifacts, license tokens, and private
signing keys.

Use `tools/release-catalog.mjs` to compute artifact metadata and sign catalogs.
Pass the private signing-key path explicitly at publish time. Never add that
path or the key contents to a committed file.

Run `npm test` and `node tools/release-catalog.mjs verify --input stable.jws`
before publishing a catalog. Upload the named artifacts to private R2 before
publishing `stable.jws`.
