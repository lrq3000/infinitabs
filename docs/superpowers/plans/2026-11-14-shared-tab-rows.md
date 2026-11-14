# Shared Tab Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify normal and Recent tab rows and controls, with a global compact/domain/URL display setting.

**Architecture:** Extract TabRow and TabDisplaySettings from the normal presentation. Keep activation and navigation in their owning views. Resolve MRU action keys in the Chrome adapter and delegate to existing lifecycle helpers instead of maintaining another tab mapping.

**Tech Stack:** Vanilla JavaScript ES modules, Chrome extension APIs, CSS, node:test, existing Python Playwright verification harness.

**Spec:** `docs/superpowers/specs/2026-11-14-shared-tab-rows-design.md`

## Global Constraints

- Compact title-only rows are the default everywhere; offer Title + domain and Title + full URL globally.
- Recent has no group headers, group indentation, or group-color lines. Normal grouping remains unchanged.
- No new dependencies or persistent identity/placement mappings, no main edits or publication, and no ordinary-browser-profile interaction.
- Retain all non-regenerable tests; local conventional commits include OpenCode and OpenAI GPT-6.1 Sol attribution.

## Review Focus

- A stale or externally moved bookmark must not cause a different logical tab to be deleted.
- A closed saved-session deletion must not mount a tab, open a window, or lose opt-in recovery semantics.
- Confirm cancellation and repeated control clicks must not activate rows or send duplicate effects.
- Shared row classes must not leak hidden Recent rows into normal selection, search, scrolling, or drag/drop queries.
- Live preference changes, arbitrary URL/title strings, and narrow dark layouts must not cause stale descriptions, unsafe HTML, or overflow.

---

### Task 1: Share row rendering and global display settings

**Files:** Create `src/ui/tab-row.js`, `src/ui/tab-display-settings.js`, `test/tab-row.test.mjs`; modify `src/sidebar.js`, `src/mru/view.js`, `src/styles.css`, `src/mru/mru.css`, `src/options.html`, `src/options.js`, `src/mru/popup.js`, and `test/verify_mru_switcher.py`.

**Interfaces:** `TabDisplaySettings({ chrome, onChange })`, `ready()`, `dispose()`, `mode`; `TabRow({ document, chrome, onActivate, onUnmount, onDelete })`, `element`, `update(tab, { current, selected, groupColor, indented, disabled, description })`. Modes are `compact`, `domain`, and `url`. Settings key is `tabDisplayMode`. Shared row methods own confirmation, content and control event isolation; callers own effect transport.

- [x] Add failing node tests for compact fallback, domain/URL formatting, storage change races, and confirmation preference/cancellation. Add browser assertions for shared row geometry, option persistence/live propagation, no state labels, no groups in Recent, and safe titles.
- [x] Run focused node tests and a focused browser entry to observe absent-feature failures; retain existing node baseline (66 tests passed).
- [x] Implement shared modules; replace duplicate normal/MRU row construction while retaining normal identity/drag hooks and MRU aria/keyboard semantics. Scope normal-only selectors to tabsContainer. Apply shared row CSS and the three-mode Appearance setting.
- [x] Verify node tests and browser row/layout checks. Inspect the diff and commit `refactor(ui): share tab rows and global display preferences` with associated tests and docs.

### Task 2: Route Recent unmount/delete through canonical lifecycle

**Files:** Modify `src/mru/chrome-adapter.js`, `src/background.js`, `src/mru/view.js`, `test/mru/chrome-adapter.test.mjs`, `test/mru/view.test.mjs`, `test/mru/background.test.mjs`, and `test/verify_mru_switcher.py`.

**Interfaces:** `MruController.mutate(type, key)` sends `MRU_UNMOUNT` or `MRU_DELETE` with source context and stable key, refreshes without dismissing, serializes user actions and surfaces errors. `MruChromeAdapter.mutate(request)` validates/reacquires identity, delegates `unmountLogicalTab(windowId, logicalId)` or `deleteLogicalTab(windowId, logicalId)`, and removes only canonical saved bookmarks when no native session window exists.

- [x] Add failing tests for mounted/unmounted deletion, mounted-only unmount, source retargeting rejection, cross-session and moved-key targeting, saved-session deletion without opening, error propagation, and controller busy/refresh/nonactivation behavior.
- [x] Observe focused failures, implement the smallest routing and callback wiring, then verify focused tests pass.
- [x] Extend real browser checks for control clicks, confirmation cancellation and opt-out preference, Live Only removal, popup staying open after actions, correct saved-session targeting, and normal-view compatibility. Run the full existing MRU verification harness and the repository's Node tests.
- [x] Inspect the complete diff and commit `feat(mru): add shared unmount and delete tab controls`.

### Task 3: Independent review and final verification

**Files:** Update this checklist and the progress ledger; change production/tests only for verified important findings.

- [ ] Request one fresh-context whole-branch review against the design and Review Focus. Independently verify reported issues before editing; for important findings use a failing regression test first.
- [ ] Run final Node and real-browser checks, inspect saved screenshots and console evidence, verify committed scope and clean task worktree. Commit any coherent tested corrections and completed checklist.
- [ ] Report local commit hashes, checks, retained artifacts and any remaining limitations. Leave the branch/worktree intact; do not push or merge.
