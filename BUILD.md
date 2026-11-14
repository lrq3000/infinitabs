# Build

## Load the extension directly for development

InfiniTabs ships plain JavaScript, HTML, and CSS. To try the current working files without creating any package, open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select this repository's `src/` folder. After editing files, click **Reload** on the existing extension card. No compilation, npm dependencies, or signing key is required for this route.

## Install-ready distribution ZIP

The unpacked extension requires no compilation, signing key, or npm installation. From the repository root, run `python scripts/package_release.py --tag <release-tag>` with Python 3.9+ and Git, replacing `<release-tag>` with the intended release tag. The tag may have a leading `v`; its numeric version must match committed `package.json`, both root version entries in `package-lock.json`, and `src/manifest.json`. Optional SemVer prerelease/build suffixes are retained in the filename without changing Chrome's numeric manifest version.

For example, if the committed project version is `1.2.3`, use the following commands in Bash or PowerShell. Replace the example version with the version you intend to release; it is not the repository's current version.

```bash
python scripts/package_release.py --help
python scripts/package_release.py --tag v1.2.3
```

To choose a different output directory instead of the default `dist/`:

```bash
python scripts/package_release.py --tag v1.2.3 --output-dir release-artifacts
```

The result is `dist/<package-name>_v<release-version>.zip`, for example `sample-tabs_v1.2.3.zip` for a package named `sample-tabs` and tag `v1.2.3`. It contains committed `HEAD:src` files directly at the archive root plus the exact committed root MIT `LICENSE`. Packaging rejects missing MIT notices, invalid required MV3 fields, signing keys, symlinks, Windows-reserved names, case aliases, and file/directory conflicts, including conflicts with the injected `LICENSE`. Local edits, untracked files, tests, dependencies, and previous distributions are not included; commit intended source changes before packaging. The local `--tag` argument labels and validates committed HEAD; it does not check out another tag. Existing local output with the same filename is overwritten. Use `--output-dir <directory>` to change the output location.

Users extract the ZIP into a permanent folder, open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`. No build step is required. For an update, preserve the existing installation folder path and reload the existing extension card instead of uninstalling; back up bookmarks first.

## Automatic GitHub release assets

After `.github/workflows/release-zip.yml` and the packaging script/tests are merged and included in a release's tagged commit, publishing a GitHub release automatically runs **Release distribution ZIP**. This applies to published stable releases and prereleases, not saved drafts. Keep project versions synchronized before tagging; the Action fails instead of silently renumbering a mismatched release. It packages the event's exact tagged commit, not a later main or moved tag, then attaches the ZIP to the same release. The asset appears after the Action finishes. Existing releases are not processed retroactively.

### Publish a release through GitHub

1. Ensure the workflow, script, and tests are merged and present in the commit being released. Synchronize `package.json`, the root/package-root entries in `package-lock.json`, and `src/manifest.json` to the intended numeric version, and commit those changes before publication.
2. On the repository's **Releases** page, choose **Draft a new release**. Select an existing matching tag or create one such as `v1.2.3` against the intended commit, then enter the release title and notes. Replace this example version with the actual project version.
3. Click **Publish release**. Saving a draft alone does not run the workflow; there is no need to build or attach the ZIP manually.
4. Open **Actions → Release distribution ZIP** and wait for the run to succeed. If it fails, inspect its logs and correct the reported issue rather than assuming an asset was attached.
5. Return to the same release's **Assets** and download `infinitabs_v<release-version>.zip`, not GitHub's automatic Source code ZIP. Extract it and use **Load unpacked** as described above.

No personal token or signing secret is needed: the upload job uses GitHub's built-in `GITHUB_TOKEN` with `contents: write`. GitHub Actions and that permission must be allowed by repository/organization policy. Releases created by another workflow using its `GITHUB_TOKEN` do not normally trigger a second workflow; publish through the GitHub interface or use an appropriately authorized separate credential in that other workflow. Do not put tokens into repository files or command-line arguments.

### Use the same script to attach an asset manually

The script creates the distribution ZIP; it does **not** create GitHub releases or tags, write release notes, publish drafts, or select the latest release. Without `--release-id`, it only writes the local ZIP. With `--release-id`, it also attaches that ZIP to an already published, mutable release, replacing any existing asset with the same generated filename.

For manual upload, first check out the exact source commit intended for that release; otherwise the script packages the current committed HEAD. Supply these environment variables through your secure local environment or credential manager before invoking the upload mode:

- `RELEASE_TAG`: the existing release's exact tag, including its leading `v` if present.
- `RELEASE_ID`: that release's positive numeric GitHub database ID, not its tag, version, or a Git commit hash.
- `GITHUB_REPOSITORY`: `lrq3000/infinitabs`, or the owner/repository containing your release.
- `GITHUB_TOKEN`: a credential authorized to write release assets in that repository. Never commit it, put its value into a command argument, or paste it into logs.

If GitHub CLI is installed and already authenticated, the read-only command `gh api repos/lrq3000/infinitabs/releases/tags/v1.2.3 --jq .id` returns the release ID; replace the example tag with the actual existing tag. Authentication/environment setup is not performed by the packaging script.

The Action supplies these variables automatically and invokes the script with the following Bash command. **This upload command changes the existing release and replaces its same-name ZIP**, so use it manually only when that replacement is intended:

```bash
python scripts/package_release.py --tag "$RELEASE_TAG" --release-id "$RELEASE_ID"
```

The equivalent PowerShell command is:

```powershell
python scripts/package_release.py --tag $env:RELEASE_TAG --release-id $env:RELEASE_ID
```

**Replacement is intentional:** an existing ZIP with exactly the generated filename is always deleted and replaced, even if it advertises the same checksum. Other assets are preserved. Operations are scoped to the event's release ID, preventing a run for a deleted release from modifying a new release recreated under the same tag. The uploaded ZIP's name, size, state, and SHA-256 digest are checked. Deletion/upload are not atomic: a failed upload can temporarily leave that ZIP absent. Correct the failure and use **Re-run jobs** on the failed Action. A rerun of an obsolete/deleted release cannot upload to its replacement; use the new release's run.

**Immutable releases are incompatible with post-publication attachment:** GitHub does not allow adding, replacing, or deleting their assets after publication. If enabling release immutability, change the publishing process to build and attach assets to a draft before publishing; this workflow deliberately stops rather than attempting to modify an immutable release.

Run packaging regressions with `python -m unittest discover -s test -p test_release_package.py`. Tests use isolated Git fixtures and mocked HTTP responses, never live release modifications. Fixture directories are retained under the system temporary directory's `opencode/release-package-*` folders for diagnosis. The Python-standard-library packager is reusable locally and in CI; avoid adding a separate shell-based packaging implementation.

References: [release workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release), [release management and immutability](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository), and [GitHub token workflow-trigger restrictions](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow).

## Signed CRX (optional)

For the existing npm CRX build route, install Node.js/npm, then run the following commands from the repository root. Unlike the Python distribution script, this route uses the current working `src/` files and does not add the root MIT license to its ZIP automatically.

```bash
npm install
npm run build
```

This produces `src.crx` and `src.zip` in the repository root, overwriting existing files with those names. Prefer the Python script's versioned, MIT-licensed ZIP for GitHub distribution and Chrome **Load unpacked** installation.

The current npm command passes `--private-key my-extension.pem`, but installed `crx3` 1.1.3 recognizes `--key`/`--keyPath`, not `--private-key`. Consequently that npm route generates a temporary signing key without saving it; do not rely on it for stable CRX signing identity. To create or reuse a persistent key explicitly after installing dependencies, use:

```bash
npx --no-install crx3 src/ --zip --key my-extension.pem
```

This also writes `src.crx` and `src.zip`; it reuses a valid `my-extension.pem` or creates it if absent. Keep that private key securely backed up and out of Git/release assets. CRX signing is optional and is not performed by the automatic release-ZIP workflow.
