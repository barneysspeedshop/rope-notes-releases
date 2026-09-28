# Rope Notes release catalog

This repository publishes the signed stable update catalog for Rope Notes. The
catalog names release metadata and SHA-256 digests. It does not contain release
artifacts or license credentials.

`stable.jws` starts as a signed empty catalog. Publish a release only after its
artifacts exist in the private R2 bucket.

## Verify the catalog

Run the dependency-free tool from this repository:

```sh
node tools/release-catalog.mjs verify --input stable.jws
```

The tool uses `release-signing-public.pem` by default. The Rope Notes client
embeds the same public key.

## Build an empty catalog

Keep the private signing key outside this repository. Pass its path only when
you publish a catalog:

```sh
node tools/release-catalog.mjs build-empty \
  --private-key=/secure/release-signing-private.pem \
  --output=stable.jws \
  --sequence=2
```

The command writes the file atomically and verifies the result before it
returns. A catalog sequence must increase for every accepted publication.

## Build a release catalog

Create a release description that maps supported targets to local artifact
paths:

```json
{
  "id": "2026.09.27",
  "version": "1.4.0",
  "build": 42,
  "publishedAt": "2026-09-27T12:00:00Z",
  "notes": "Bug fixes.",
  "artifacts": {
    "linux-x64": "/secure/builds/RopeNotes-1.4.0.AppImage",
    "macos-arm64": "/secure/builds/RopeNotes-1.4.0-macOS-arm64.zip",
    "macos-x64": "/secure/builds/RopeNotes-1.4.0-macOS-x64.zip"
  }
}
```

Build and verify the catalog:

```sh
node tools/release-catalog.mjs build \
  --private-key=/secure/release-signing-private.pem \
  --release-json=/secure/release.json \
  --output=stable.jws \
  --sequence=2
node tools/release-catalog.mjs verify --input stable.jws
```

The tool reads each file, computes its size and SHA-256 digest, checks the
target-specific filename extension, and writes deterministic JSON. It accepts
`linux-x64`, `macos-arm64`, and `macos-x64`.

Upload every artifact to private R2 at
`artifacts/sha256/<sha256>`. Publish `stable.jws` only after those uploads
finish. The Pages Function authenticates each download and reads the digest
address directly.

## Export the public key

Print the raw base64 public key for embedding or deployment checks:

```sh
node tools/release-catalog.mjs public-key \
  --public-key=release-signing-public.pem
```

For key rotation, commit the new public key, add it to the client key map, and
ship that client before signing a catalog with the new key. Pass `--key-id` and
`--public-key` to build and verify commands during the overlap period.

Never commit the private signing key. The tool reads it only when a build or
key-generation command receives its path explicitly.

## Tests

Run the dependency-free behavior tests:

```sh
npm test
```

The tests cover the committed cross-runtime vector, signature mutations,
noncanonical base64url segments, unknown key IDs, deterministic serialization,
empty catalogs, target extensions, file sizes, and SHA-256 computation.

macOS artifacts may be signed, notarized `.dmg` installers or legacy `.zip` archives.
DMG catalogs require a client with DMG filename support; older ZIP-only clients
need a manual installer update first.
