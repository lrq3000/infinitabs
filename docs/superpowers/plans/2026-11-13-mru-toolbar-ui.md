# MRU Toolbar UI Implementation Plan

> **For agentic workers:** Use executing-plans for approved native implementation, then one fresh whole-branch reviewer. Track progress with the checkboxes below.

**Goal:** Present Recent with the same sidebar action/search layout as normal tabs and working previous/next match navigation.

**Architecture:** Keep one header search row, with the normal and MRU view's owned inputs occupying its existing wrapper in their respective modes. Reuse the shared MRU controller for match selection; leave worker/storage/search ranking and standalone popup presentation alone.

**Tech Stack:** Existing JavaScript ES modules, CSS, Node test runner and Python Playwright isolated MV3 Chromium harness; no new dependencies.

**Spec:** [Approved design](../specs/2026-11-13-mru-toolbar-ui-design.md).

## Global constraints

Worktree `C:/git/infinitabs/.worktrees/mru-toolbar-ui`; branch `feat/mru-toolbar-ui`; baseline `8794b7e`. No root edits, downloads, installation, push, PR, merge to main or cleanup. Retain temporary artifacts under `C:/Users/33632/AppData/Local/Temp/opencode`. Commit coherent tested milestones locally with OpenCode / OpenAI GPT-6.1 Sol attribution.

## Review focus

- Navigation crosses page boundaries and wraps the complete result set, not only the visible page (Task 1).
- An older asynchronous query/page response cannot change a newer selection (existing tests plus Task 1).
- Hidden normal search must not interfere with Recent queries or keyboard focus (Task 2).
- Recent input must not squeeze or move the shared search row at narrow widths or in dark mode (Task 2).
- Toggling off during an asynchronous mount must not show/focus the Recent input afterward (Task 2).

## File responsibilities

`src/mru/view.js`: controller selection boundaries and optional external search host. `src/sidebar.html`, `src/sidebar.js`: toolbar placement, mode visibility, clear/navigation routing and focus. `src/styles.css`: shared action/search styles and narrow-width layout. `src/mru/mru.css`: remove obsolete sidebar-only view-control rules if no longer used. `test/mru/view.test.mjs`: controller regression coverage. `test/verify_mru_switcher.py`: real rendered geometry, style, keyboard and mode checks. `README.md`: affected switcher-opening instruction.

### Task 1: Complete-result MRU navigation

**Interfaces:** Preserve `MruController.advanceSelection(direction)` and `page(offset, selectLast)`; direction is +1/-1, selection never sends `MRU_ACTIVATE`.

- [x] Add a 5-result fixture with `pageSize = 2` and real offset/limit slicing; assert literal selection order `a,b,c,d,e,a,e,d,c,b,a` across forward/backward boundaries and full-list wrap. Pin empty/single results and preserve existing stale-response/IME tests.
- [x] Run `node --test test/mru/view.test.mjs`; confirm the new full-list wrap regression fails before implementation.
- [x] Update `advanceSelection` in `src/mru/view.js` using the absolute result index and existing paged query/selection mechanism; retain generation guards and bounded page-size work.
- [x] Run `node --test test/mru/*.test.mjs` and `git diff --check`; require zero failures, inspect and commit Task 1 plus these approved documents as `fix(mru): cycle selection across all result pages`.

### Task 2: Shared sidebar search and familiar actions

**Interfaces:** Extend `MruView` with optional `searchHost` element; mount the owned input there only when supplied, otherwise preserve popup mount behavior. Existing `input`, `focus`, `advanceSelection`, `controller.search` remain the sidebar's integration points.

- [ ] Extend `MruCheck.run` with real sidebar presentation checks before popup activation: Recent follows Live Only; computed normal/hover/active styles agree; normal/recent search bounds agree at 320/420px and in both themes; only one search input and one trailing action are visible.
- [ ] Exercise two matching recent tabs via previous/next and keyboard, checking selected stable keys and unchanged active native tab. Clear recent query, retain independent normal query through mode changes, focus Recent with Ctrl+Shift+F, verify tooltip/accessibility text, and assert popup remains unchanged. Exercise empty matches and rapid mode-off during pending mount/refresh without relying on fixed sleeps.
- [ ] Run `python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe`; confirm a presentation assertion fails against the old toolbar.
- [ ] Move Recent into the action group; move the icon-only switcher into the search row, hidden outside Recent. Generalize normal input/action selectors for sharing and preserve active styling and theme tokens. Ensure inputs can shrink and action groups wrap without horizontal overflow.
- [ ] Add `searchHost` support without changing popup input presentation. In the sidebar, show the appropriate owned input, route clear and previous/next by mode, focus the visible input, and guard post-await focus against mode changes. Keep query state independent and rerendering of the hidden normal tree harmless.
- [ ] Update the README opening instruction and remove only obsolete sidebar control styling.
- [ ] Run the MRU Node suite, full existing MRU Chromium script, CI's inexpensive Node regressions and Python unit tests; run `git diff --check`. Inspect screenshots, browser evidence and the diff; commit as `feat(sidebar): align Recent with the existing search toolbar`.

### Final review and delivery

- [ ] Dispatch one fresh-context read-only reviewer with the approved spec and `8794b7e..HEAD`; no edits or new permissions. Verify findings against code, fix still-valid in-scope defects with regression coverage, rerun affected checks and commit any fixes.
- [ ] Verify clean task worktree and local commit hashes, record checks/artifact paths in this ledger, then report outcome and limitations. Do not push, merge or remove the worktree.

## Execution ledger

- Approved plan and native implementation: 2026-11-13 through OpenChamber approval card.
- Baseline: MRU Node suite passes (46 tests). Python Playwright is installed; default Chromium revision 1217 is absent, installed full revision 1243 is available for the existing executable override. Browser plugin is not listed; use the explicitly approved repository Playwright workflow, not the ordinary browser profile.
- Self-review: all requested placement, styling, navigation, tooltip, mode restoration, query, keyboard and popup-preservation requirements map to Task 2; full-result navigation and asynchronous query safety map to Task 1/existing tests. No runtime dependency or permission changes.
- Pre-flight: Task 1 preserves `MruController.advanceSelection(direction)` consumed through `MruView.advanceSelection(direction)` in Task 2; no interface conflict.
- Ruling: Use this approved, committed plan as the execution ledger rather than creating additional shell-script-managed scratch artifacts — the user approved these documentation paths and asks to retain development artifacts; cost if wrong is less automated task bookkeeping, not a product behavior change.
- Task 1: complete. New complete-list cycling assertion failed at the last page before implementation; all 48 MRU tests pass afterward (`node --test --test-reporter=dot test/mru/*.test.mjs`), and `git diff --check` is clean. Existing typeless-package Node warning remains unchanged; do not alter mixed-module package configuration for this task.
