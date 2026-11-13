# Responsive Sidebar Header Implementation Plan

> **For agentic workers:** Use executing-plans for the approved inline implementation, then one independent read-only review. Track progress below.

**Goal:** Keep the dynamically shrinking session selector and fixed-size Rename/Refresh/Theme/Settings buttons visible together at the top right.

**Architecture:** Move existing DOM nodes into the session-selector flex row; constrain only selector minimum/flex sizing and button shrinking. No production JavaScript changes.

**Tech Stack:** Existing HTML/CSS and Python Playwright MV3 verification; Node/Python regression suites, no added dependency.

**Spec:** [Approved design](../specs/2026-11-13-sidebar-header-controls-design.md).

## Global constraints

Fresh worktree `C:/git/infinitabs/.worktrees/sidebar-header-controls`, branch `feat/sidebar-header-controls`, baseline `ac9f4ef`. Root and previous worktrees remain untouched. No version bump, install/download, push, main merge or cleanup. Retain QA artifacts in `C:/Users/33632/AppData/Local/Temp/opencode`.

## Review focus

- Long selected session names must not set an intrinsic minimum width that hides buttons.
- Resizing must change only selector width, not button dimensions.
- Theme/Settings and Rename/Refresh must remain usable in both themes at narrow widths.
- Existing MRU search/normal-mode geometry and behavior must remain intact after header relocation.
- Legacy settings verification must use the same real-extension test rather than an obsolete parent-class mock.

### Task 1: Responsive header and regression coverage

**Files/interfaces:** `src/sidebar.html`: keep IDs and existing Rename/Refresh order, move Theme/Settings after Refresh. `src/styles.css`: session-selector row uses flexible selector with zero minimum and non-shrinking buttons; remove unused `.header-left-group`. `test/verify_mru_switcher.py`: add `MruCheck.sidebar_header()` after the strict MRU-order scenarios; reuse the existing browser/profile/fixture lifecycle. `test/verify_settings_btn.py`: preserve the manual entrypoint name while delegating to the shared real-extension runner with its existing CLI flags.

- [x] Add real-header tests that rename to a long title through the shipped prompt, measure header/control bounding boxes at 420/320/280/240px in both themes, assert ordered on-row visible controls and stable per-theme dimensions, and assert selector width differences equal viewport width differences. Test actual theme toggle, real options opening, refresh of a deliberately stale selector entry, and restore original title/theme/viewport before the browser-restart check.
- [x] Run `python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe`; require a clipping/alignment assertion to fail against current production code.
- [x] Move existing controls in `src/sidebar.html`; set selector `flex: 1`/`min-width: 0`, row alignment and button `flex-shrink: 0` in `src/styles.css`; remove only obsolete lower-left grouping styles. Keep JavaScript, labels and handlers unchanged.
- [x] Replace the legacy settings mock with the shared verification entrypoint; run its CLI with the same browser flags, expecting the complete strengthened header/MRU suite to pass. This also verifies the compatibility entrypoint itself.
- [x] Run `node --test --test-reporter=dot test/mru/*.test.mjs`, `python -B -m unittest discover -s test -p 'test_*.py'` and `git diff --check`; inspect light/dark narrow/wide screenshots. Commit all six approved files as `fix(sidebar): keep header controls visible while resizing`, with OpenCode / OpenAI GPT-6.1 Sol attribution.
- [x] Dispatch one fresh read-only review of `ac9f4ef..HEAD`, verify any findings and fix important in-scope defects with RED/GREEN coverage. Commit any verified fix, confirm clean worktree and report commits/checks/artifact paths without publication.

## Execution ledger

- Approved design and native execution: 2026-11-13. Fresh worktree created from main `ac9f4ef`; previous MRU worktree and root are unchanged.
- Pre-flight: one task, no inter-task shared interfaces. Existing IDs/handlers stay unchanged; existing Chromium fixture and paging/query tests are reused.
- Ruling: Use this approved committed plan as the execution ledger, without extra shell-managed scratch directories — keeps this small task within approved paths; cost if wrong is manual rather than automated bookkeeping.
- Self-review: every requested layout/sizing/control behavior maps to Task 1; narrow widths and long names exercise the reported clipping rather than source-text assertions. Browser plugin is not listed; use the explicitly approved installed-Chromium Playwright workflow and isolated retained profiles.
- Baseline: all 53 MRU Node tests pass at `ac9f4ef`.
- RED: real long-name layout reproduced a 685px selector in a 420px sidebar before source edits (`mru-qa-5cd1l62c`).
- Ruling: Run actual header actions after strict MRU-order fixtures, and close the earlier owned recovery-options page once configured — opening/closing real Settings can activate the harness's sidebar tab and add an MRU entry, so running it during setup perturbed the existing two-match fixture; cost if wrong is test-order coupling, not any production tracking change. No production JavaScript or MRU policy was changed.
- GREEN: compatibility entrypoint `python -B test/verify_settings_btn.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe` passes all 11 browser flows with eight header width/theme cases and zero page/worker errors. Evidence/profile/screenshots retained at `C:/Users/33632/AppData/Local/Temp/opencode/mru-qa-4pzbn9_s`; earlier RED/debug profiles also retained. Screenshots at 240px dark and 420px light inspected: all controls visible, long selector text clipped within its own field rather than displacing actions. Node 53 tests, Python 20 tests, and `git diff --check` pass.
- Task 1 implementation commit: `c68ee91`.
- Final review: fresh read-only reviewer inspected `ac9f4ef..c68ee91`, independently reran all 53 MRU tests, validated saved geometry for all eight width/theme cases, inspected narrow/wide light/dark screenshots and verified clean Git diff/status. No Critical, Important or Minor findings; no declined-to-judge items, no fix pass needed. Reviewer did not rerun Python or Chromium; author ran both as recorded above.
- Remaining coverage limits: tests use real extension pages in isolated headless Chromium, not native side-panel drag resizing; browser zoom and keyboard/screen-reader interactions were not separately exercised. A native-sidebar smoke test is an optional final precaution, not evidence of a known defect. No push, main merge, version bump, installation or cleanup occurred.
