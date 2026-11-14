# Startup restoration implementation plan

> **For agentic workers:** Execute inline with `executing-plans` and `test-driven-development`; obtain one independent whole-branch review before completion.

**Goal:** Prevent browser-restored native tabs from duplicating saved logical tabs when InfiniTabs reloads the last workspace.

**Architecture:** Keep bookmarks and the existing logical/live relationships unchanged. Share startup initialization, serialize competing imports only while work is in flight, exclude the existing internal bridge from import, and scope obsolete-event suppression to windows being replaced. Any browser-session marker is constant-size lifecycle metadata, not a tab registry.

**Tech stack:** Existing JavaScript MV3 extension, Node regressions, Python Playwright and installed Chromium.

**Spec:** Approved conversation: preserve automatic unmounted session restoration; no additional permanent mapping redundancy; no automatic deletion of existing duplicate bookmarks.

## Global constraints

- Only this fresh worktree may be edited; leave the root checkout and personal browser profile unchanged.
- No dependency installation, signing, push, merge, PR creation, or automatic duplicate cleanup.
- Preserve intentional repeated URLs, saved blank pages, stable bookmark identities, grouping and ordering.
- Temporary import coordination must release entries after completion; do not add permanent per-tab state.
- Retain browser profiles/evidence in `C:/Users/33632/AppData/Local/Temp/opencode`; commit non-regenerable tests.

## Review focus

- A native event initializes the worker before runtime startup: restore exactly once without importing obsolete windows.
- A navigation still has only pendingUrl: do not create a blank bookmark and later turn it into a duplicate.
- An extension reload or worker wake is not a new browser startup: retain current live tabs.
- Delayed events and concurrent imports: preserve new user tabs but never import the same native tab twice.
- Replacement fails or history collection overlaps restoration: preserve original windows and the last recovery snapshot.

## Task 1: deterministic reproduction and focused repair

**Files:** `src/background.js`, `test/test_startup_restore.js`, this plan.

**Interfaces:** Exercise shipped event listeners and runtime messages; no production testing API. Existing `init`, `restoreWorkspace`, `bindWindowToSession`, and native tab listeners retain their public contracts.

- [x] Write isolated-process regressions for startup/event ordering, pending URLs, placeholders, import overlap, saved repeats/blanks, worker wake, installation, new user windows and failures.
- [x] Run `node test/test_startup_restore.js`; observe relevant assertions fail before production changes.
- [x] Implement minimal lifecycle/temporary import coordination. Reuse the internal bridge rather than inventing another persisted placeholder mapping.
- [x] Run the new regressions and existing Node suites, inspect the diff, and commit this coherent milestone.

## Task 2: actual browser restart evidence and CI

**Files:** `test/verify_startup_restore.py`, `.github/workflows/movement-regressions.yml`, this plan; narrowly adjust Task 1 only for a demonstrated browser failure.

**Interfaces:** Load this worktree's unmodified manifest/source in a disposable persistent Chromium profile configured to restore tabs. Reuse existing Playwright runtime and fixture conventions.

- [x] Add a real browser-process restart regression and demonstrate failure against the baseline before relying on it as verification.
- [x] Require identical saved bookmark identities/parents/order/URLs after repeated restarts, no mounted saved tabs after automatic restoration, and worker-wake safety.
- [x] Run `python -B test/verify_startup_restore.py --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe` and wire the check into existing CI.
- [x] Run all maintained Node regressions, Python helper tests, focused browser compatibility checks and `git diff --check`; commit after success.
- [ ] Obtain an independent read-only review, fix verified important findings with RED→GREEN evidence, and verify all completed work is committed.

## Execution ledger

- Baseline: 57 selected Node checks passed; installed Python Playwright and Chromium are available.
- Ruling: retain the approved in-conversation design in this concise plan rather than generate a second design artifact or a separate scratch ledger; this avoids redundant workflow data without changing implementation scope.
- Ruling: the root `.worktrees/` directory is already unignored user state. Do not edit the immutable root's ignore configuration; stage only explicit task paths in this fresh worktree.
- RED: eight of the initial ten startup cases failed against unmodified production code, including two original URLs becoming five saved entries and concurrent reconciliation/onCreated saving a single new tab twice.
- RED→GREEN: added failure-publication and fail-fast dependency regressions; a failed restore no longer overwrites recovery history, and an import batch waits for every pending native owner even if another owner rejects.
- Ruling: key temporary import ownership by native tab ID, not by window. A window-wide queue deadlocked an existing group lifecycle interleaving where one callback legitimately awaits another tab's creation. The existing lifecycle suites pass with per-native ownership; there is still no additional permanent logical/live relationship.
- Verification: all 78 maintained Node checks passed with concurrency 2 (53 MRU cases, 11 existing script suites, 14 new startup cases). Existing mixed-module package warnings are unchanged.
- Browser harness finding: both command-line loading and CDP installation produce ephemeral COMMAND_LINE installations. Native startup was verified after seeding only the closed disposable profile's installation metadata as UNPACKED; extension source, bookmarks and extension storage are untouched. This fixture does not claim to test Chromium's installation persistence/security machinery.
- Task 1: complete; the first real browser restart also preserved all saved bookmark IDs/content and left every saved tab unmounted. Python helper suite: 20 passing tests.
- Task 1 commit: `ca1f458`.
- Expanded Node coverage: 80 passing checks, including 16 startup cases, multiple windows/groups, an empty session, and three browser-lifetime simulations.
- Browser RED: revision `7599718`, archived read-only with `--baseline-ref`, failed the corrected headless browser check because the original shutdown clears the recovery workspace and automatic unmounted restoration never completes. This is separate from the exact duplicate-URL RED demonstrated by the Node event-order regression.
- Browser GREEN: two headed process restarts (`startup-restore-swdasq_c`) and two headless process restarts (`startup-restore-66d3p2ot`) passed with identical bookmark IDs/parents/order/content, all saved tabs unmounted, and no captured worker errors. Evidence/profiles remain under the approved temporary directory.
- Final independent read-only review is in progress. No model override was used because the user did not request one.
- Browser compatibility: all 11 existing MRU/sidebar/mount/restart workflows passed (`mru-qa-nnq0f67d`), with no page or worker errors. `git diff --check` is clean.
