# Build

## Install-ready distribution ZIP

The unpacked extension requires no compilation, signing key, or npm installation. From the repository root, run `python scripts/package_release.py --tag <release-tag>` with Python 3.9+ and Git, replacing `<release-tag>` with the intended release tag. The tag may have a leading `v`; its numeric version must match committed `package.json`, both root version entries in `package-lock.json`, and `src/manifest.json`. Optional SemVer prerelease/build suffixes are retained in the filename without changing Chrome's numeric manifest version.

The result is `dist/<package-name>_v<release-version>.zip`, for example `sample-tabs_v1.2.3.zip` for a package named `sample-tabs` and tag `v1.2.3`. It contains committed `HEAD:src` files directly at the archive root plus the exact committed root MIT `LICENSE`. Packaging rejects missing MIT notices, invalid required MV3 fields, signing keys, symlinks, Windows-reserved names, case aliases, and file/directory conflicts, including conflicts with the injected `LICENSE`. Local edits, untracked files, tests, dependencies, and previous distributions are not included; commit intended source changes before packaging. The local `--tag` argument labels and validates committed HEAD; it does not check out another tag. Existing local output with the same filename is overwritten. Use `--output-dir <directory>` to change the output location.

Users extract the ZIP into a permanent folder, open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`. No build step is required. For an update, preserve the existing installation folder path and reload the existing extension card instead of uninstalling; back up bookmarks first.

## Automatic GitHub release assets

After `.github/workflows/release-zip.yml` and the packaging script/tests are merged and included in a release's tagged commit, publishing a GitHub release automatically runs **Release distribution ZIP**. This applies to published stable releases and prereleases, not saved drafts. Keep project versions synchronized before tagging; the Action fails instead of silently renumbering a mismatched release. It packages the event's exact tagged commit, not a later main or moved tag, then attaches the ZIP to the same release. The asset appears after the Action finishes. Existing releases are not processed retroactively.

No personal token or signing secret is needed: the upload job uses GitHub's built-in `GITHUB_TOKEN` with `contents: write`. GitHub Actions and that permission must be allowed by repository/organization policy. Releases created by another workflow using its `GITHUB_TOKEN` do not normally trigger a second workflow; publish through the GitHub interface or use an appropriately authorized separate credential in that other workflow. Do not put tokens into repository files or command-line arguments.

**Replacement is intentional:** an existing ZIP with exactly the generated filename is always deleted and replaced, even if it advertises the same checksum. Other assets are preserved. Operations are scoped to the event's release ID, preventing a run for a deleted release from modifying a new release recreated under the same tag. The uploaded ZIP's name, size, state, and SHA-256 digest are checked. Deletion/upload are not atomic: a failed upload can temporarily leave that ZIP absent. Correct the failure and use **Re-run jobs** on the failed Action. A rerun of an obsolete/deleted release cannot upload to its replacement; use the new release's run.

**Immutable releases are incompatible with post-publication attachment:** GitHub does not allow adding, replacing, or deleting their assets after publication. If enabling release immutability, change the publishing process to build and attach assets to a draft before publishing; this workflow deliberately stops rather than attempting to modify an immutable release.

Run packaging regressions with `python -m unittest discover -s test -p test_release_package.py`. Tests use isolated Git fixtures and mocked HTTP responses, never live release modifications. Fixture directories are retained under the system temporary directory's `opencode/release-package-*` folders for diagnosis. The Python-standard-library packager is reusable locally and in CI; avoid adding a separate shell-based packaging implementation.

References: [release workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release), [release management and immutability](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository), and [GitHub token workflow-trigger restrictions](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow).

## Signed CRX (optional)

* To make a crx, use:

```
npm install
npm run build
```

The private key can be left out for testing purposes, one will then be autogenerated.
