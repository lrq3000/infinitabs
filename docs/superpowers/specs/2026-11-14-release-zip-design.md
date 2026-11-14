# Automatic release ZIP design

## Intent and approved scope

Publishing a GitHub release should automatically attach an install-ready ZIP named from the project name and release version. Include every committed extension file at ZIP root and the unchanged root MIT `LICENSE`; do not require signing keys, dependency installation, or compilation. Implement locally in `ci/release-zip`, keeping the current version unchanged. No push, PR, merge, or live release change is authorized.

## Approach

Use a published-release GitHub Actions workflow, a reusable Python-standard-library packager, and GitHub's release-asset API. The workflow checks out the event's exact tagged commit, not mutable main. A tag-push workflow would run before a release exists and does not match the requested publish-button workflow. The existing npm build signs CRX files and is unnecessary for unpacked installation.

## Packaging contract

Package committed `HEAD:src` and `HEAD:LICENSE` only, excluding local/untracked artifacts. Derive the extension filename prefix from `package.json`'s safe unscoped name. Accept release tags with optional leading `v` and optional SemVer prerelease/build suffixes; the numeric release version must equal the Chrome manifest version and package/lockfile versions. Reject invalid versions, unsafe filenames/archive paths, symlinks, missing license, and missing entry points. Keep `manifest.json` at archive root. Use deterministic ZIP metadata so reruns of the same input generate the same bytes. Write to `dist/` by default.

## Upload and replacement contract

Use the built-in `GITHUB_TOKEN` with `contents: write`, scoped to the release job. Address uploads and deletions by the event's release ID, not a fresh tag lookup, so an obsolete event cannot modify a release recreated under the same tag. Verify tag, ID, published state, and mutability before changing assets. The user explicitly requested overwriting an existing same-name ZIP, even if its checksum matches, because an earlier artifact might be corrupted or the release may have been recreated after a fix. Delete only the matching asset and upload the verified replacement; preserve unrelated assets. Check the uploaded filename, state, size, and SHA-256. An upload failure after deletion can leave the ZIP absent until a rerun; do not conceal that limitation. Never publish a release or move tags from this script.

## Workflow and limits

Use `release: types: [published]`, including stable releases and prereleases but not drafts. Pin checkout to the repository's existing trusted action revision and disable persisted credentials. Pass event data via environment variables, not shell-code interpolation. Serialize runs for the same release ID without cancellation. Include packaging tests before uploading. The workflow must be present in the released commit; it does not retroactively run for v0.6.0. Immutable releases require assets before publication and are unsupported by this post-publication upload workflow. Releases created by another workflow using its `GITHUB_TOKEN` do not normally trigger another workflow; a human-published release or an appropriate separate credential is required.

## Verification

Use committed, isolated Git fixtures and mocked HTTP boundaries to test packaging, tag/version safety, deterministic output, licensing, corruption detection, paginated assets, replacement, stale release IDs, and upload failures. Do not make live upload/delete requests. Run the repository's Python tests, focused Node regressions, ZIP smoke checks, available workflow YAML validation, and independent read-only review. Document the absence of a real hosted Actions run until this branch is merged and a future release is published.
