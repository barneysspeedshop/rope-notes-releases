# Rope Notes release catalog

This repository publishes signed platform update catalogs for Rope Notes. Each
catalog names release metadata and SHA-256 digests. It does not contain release
artifacts or license credentials.

`stable-linux-x64.jws` and `stable-macos-arm64.jws` independently advertise the
latest release for their platform. The first Intel macOS publication creates
`stable-macos-x64.jws`. Linux also updates `stable.jws` with exactly the same
signed bytes for older Linux clients. Publish only after the artifact exists
in the private R2 bucket.

## Publish a production Linux AppImage from this computer

From the app checkout, run `./release_linux.sh`. The launcher supplies this
computer's paths and default release notes. To provide custom notes, run
`./release_linux.sh --notes 'Describe the release here.'`.

The equivalent direct invocation follows.

Run the publisher with Node.js 20 or newer from this repository:

```sh
read -r -p 'Private signing key path: ' signing_key
node tools/publish-linux.mjs --private-key "$signing_key" --notes 'Describe the release here.'
unset signing_key
```

The defaults use `/home/patrick/IdeaProjects/rope/rope_notes` for the app and
`/home/patrick/IdeaProjects/rope/ropenotes-site` for Wrangler. Override them with
`--app PATH` and `--site PATH`. Supply the private-key path at runtime. Do not
save it in this repository.

Before running, commit the app changes and increase the build in `pubspec.yaml`
above the published build. The publisher builds the current checkout, which
must include every feature intended for release. Submodules must be initialized
at their committed revisions. GitHub CLI, Git commit identity, Flutter, the
existing AppImage packaging assets, and Wrangler OAuth must already be configured.

The command runs the existing production build script, which also refreshes
`/home/patrick/Applications/Rope_Notes.AppImage`. It uploads the artifact to the
private `rope-notes-releases` R2 bucket, downloads it to verify its checksum,
then records a signed receipt for that target and immediately signs and pushes a
new `stable-linux-x64.jws` and its `stable.jws` alias to `main` in one commit.
Each platform becomes available independently.
GitHub raw-content caching can delay visibility for several minutes.

Linux and macOS builds can run independently, in either order. A `Published`
result means the advertised artifacts were verified in R2 and the catalog
advanced. A higher build does not wait for other platforms on an earlier build.
The Linux catalog sequence never drops below the old shared catalog's sequence
six; this keeps pre-migration Linux clients from rejecting the compatibility
alias as a rollback.

Each catalog uses schema v1 and describes one version/build. Publishing Linux
build 22 leaves the macOS catalog byte-for-byte unchanged at build 21. macOS
can then publish build 22, or a different newer build, without modifying either
Linux file. Catalog sequences advance independently. No publisher deletes R2
artifacts.

The initial Linux and Apple Silicon catalogs contain the exact signed combined
build-21 catalog from `main`. Updated clients select their platform URL. Older
Linux clients continue using `stable.jws`, which remains a Linux alias. Older
macOS clients also use that legacy URL, so after the first Linux publication
they cannot discover macOS updates. Install a new macOS build containing the
platform URL once to migrate those clients. Existing digest-addressed DMG
downloads, including the build-21 installer, remain valid.

Each signed target receipt lives on an immutable, parentless Git ref under
`ready/<version>-<build>/<target>`. Once a target/version/build receipt exists,
rerunning the normal platform script reuses it without rebuilding, even from a
newer checkout or with different command-line notes. The signed receipt remains
authoritative for the artifact, source commit, and release notes; publishing new
content requires a new build number. Different targets may come from different
source commits. Other platforms' receipts do not participate in version checks
or publication.

The publisher uses temporary checkouts and retries concurrent catalog pushes
up to eight times. Rerun the same command after an interrupted run to resume.
Concurrent pushes refresh `main` and change only the publisher's owned files.
Never force-push the catalog or receipt refs.

## Publish a macOS release

From the app checkout on macOS, run `./release_macos.sh`. Keep `rope_notes`,
`rope-notes-releases`, `ropenotes-site`, and the signing-key directory beside
each other, as on the Linux computer. Runtime options `--private-key PATH`,
`--site PATH`, and `--notes TEXT` override the launcher defaults.

The launcher uses `macos/scripts/build_direct_notarized.sh` to build, sign,
notarize, staple, and package `build/macos/RopeNotes-Direct.dmg`. Configure the
Developer ID certificate and notarization credentials required by that script
on the Mac. GitHub and Wrangler authentication must also be configured there.

The publisher verifies the built app's version, build number, and CPU
architecture before uploading. It advertises only the architecture of the Node
process on that Mac (`macos-arm64` or `macos-x64`). Use native Node to avoid
selecting the Intel target through Rosetta. The macOS publisher changes only
`stable-macos-<architecture>.jws`. Its version/build must advance that platform's
published release; it need not match Linux.

The launcher has been checked on Linux, but the Xcode signing and notarization
path still needs a run on the Mac.

Both launchers accept `--check` to verify publishing prerequisites and
`--build-only` to build locally without uploading or changing the catalog.
Both use the publisher in this release repository; update it on both computers.

## Verify the catalog

Run the dependency-free tool from this repository:

```sh
node tools/release-catalog.mjs verify --input stable-linux-x64.jws
node tools/release-catalog.mjs verify --input stable-macos-arm64.jws
```

The tool uses `release-signing-public.pem` by default. The Rope Notes client
embeds the same public key.

## Build an empty catalog

Keep the private signing key outside this repository. Pass its path only when
you publish a catalog:

```sh
node tools/release-catalog.mjs build-empty \
  --private-key=/secure/release-signing-private.pem \
  --output=stable-macos-x64.jws \
  --sequence=2
```

The command writes the file atomically and verifies the result before it
returns. A catalog sequence must increase for every accepted publication.

## Build a release catalog

The production publishers should normally build catalogs. For manual recovery,
create a release description containing only the target owned by that catalog:

```json
{
  "id": "2026.09.27",
  "version": "1.4.0",
  "build": 42,
  "publishedAt": "2026-09-27T12:00:00Z",
  "notes": "Bug fixes.",
  "artifacts": {
    "macos-arm64": "/secure/builds/RopeNotes-1.4.0-macOS-arm64.dmg"
  }
}
```

Build and verify the catalog:

```sh
node tools/release-catalog.mjs build \
  --private-key=/secure/release-signing-private.pem \
  --release-json=/secure/release.json \
  --output=stable-macos-arm64.jws \
  --sequence=2
node tools/release-catalog.mjs verify --input stable-macos-arm64.jws
```

The tool reads each file, computes its size and SHA-256 digest, checks the
target-specific filename extension, and writes deterministic JSON. It accepts
`linux-x64`, `macos-arm64`, and `macos-x64`.

Upload the artifact to private R2 at `artifacts/sha256/<sha256>`. Publish only
the matching platform catalog after the upload finishes. If manually recovering
a Linux publication, write the exact same signed bytes to both
`stable-linux-x64.jws` and `stable.jws` in one commit. The Pages Function
authenticates each download and reads the digest address directly.

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
