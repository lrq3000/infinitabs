# Automatic Release ZIP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically attach a correctly named, MIT-licensed, unpacked-installable ZIP to a published GitHub release, replacing any existing same-name asset.

**Architecture:** A Python-standard-library script packages committed source and performs release-ID-scoped API uploads. A minimal published-release workflow checks out the tagged event commit, runs tests, and invokes the script using the built-in token.

**Tech Stack:** Python 3 standard library, Git, GitHub Actions, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-11-14-release-zip-design.md`

## Global Constraints

- Keep the current project version unchanged; no pushes, PRs, merges, or live uploads.
- Filename: `<package-name>_v<release-version>.zip`; root entries are committed `src/` contents plus `LICENSE`.
- Always replace a same-name release ZIP; preserve unrelated assets and scope operations to the event release ID.
- No signing keys, new runtime dependencies, or modification of extension source.

## Review Focus

- A release deleted/recreated under the same tag must not receive uploads from an old release event.
- A same-name asset must be replaced even when it advertises an identical digest; unrelated assets must survive.
- Local or ignored files and unsafe Git entries must not leak into the ZIP.
- Version drift, malformed metadata, and absent MIT notices must stop packaging before upload.
- A failed replacement must be visible and must not report a successful upload.

---

### Task 1: Reusable deterministic packager

**Files:** Create `scripts/package_release.py` and `test/test_release_package.py`.

**Interfaces:** Produce `ReleasePackager(repository: Path, tag: str).build(output_dir: Path) -> Path`, consumed by the CLI and upload task. Fail invalid input with `ValueError` before emitting a usable artifact.

- [ ] Write packaging tests using isolated Git fixtures, including literal fixture versions unrelated to the real project release.
- [ ] Run `python -m unittest discover -s test -p test_release_package.py`; expect failure because the packager is absent.
- [ ] Implement committed-source packaging, metadata validation, deterministic ZIP generation, and root MIT inclusion.
- [ ] Rerun packaging tests; expect all packaging tests to pass. Run the existing Python suite and inspect `git diff --check`.
- [ ] Commit this coherent, passing packager milestone with its tests.

### Task 2: Replacement upload, workflow, and documentation

**Files:** Extend `scripts/package_release.py` and `test/test_release_package.py`; create `.github/workflows/release-zip.yml`; update `BUILD.md`.

**Interfaces:** Consume `ReleasePackager.build`; produce `ReleaseAssetUploader(repository: str, token: str).upload(archive: Path, tag: str, release_id: int) -> dict` and CLI `--tag TAG [--output-dir PATH] [--release-id ID]`. The upload CLI uses `GITHUB_REPOSITORY` and `GITHUB_TOKEN` only when `--release-id` is provided.

- [ ] Write HTTP-boundary tests for release identity, immutability, pagination, unconditional same-name replacement, preservation of other assets, and corrupt/failed uploads.
- [ ] Run new upload tests; expect failure because the uploader is absent.
- [ ] Implement release-ID-scoped upload/delete requests and post-upload digest checks. Add the published-release workflow and document local use, prerequisites, overwrite behavior, and retry limitations.
- [ ] Run `python -m unittest discover -s test -p 'test_*.py'`, focused shared-row/MRU Node tests, and `python scripts/package_release.py --tag v0.6.0`. Inspect the generated ZIP against Git, validate workflow structure with available tooling, and run `git diff --check`.
- [ ] Commit this coherent workflow/upload milestone with tests and documentation.
- [ ] Obtain an independent read-only branch review; fix verified important findings with RED→GREEN tests, commit corrections, and report exact checks and remaining hosted-run limitations.

## Execution record

Approved local implementation; user correction supersedes the initial no-clobber proposal: always overwrite the matching ZIP. Existing baseline: 20 Python tests and shared-row/MRU Node tests pass. Use the plan-scoped ignored ledger for task progress; retain generated artifacts rather than deleting them.
