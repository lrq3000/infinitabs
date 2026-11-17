# Recent Tab Hotkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hold-to-select Recent navigation and an extensible, truthful hotkey settings table.

**Architecture:** A shared registry owns action metadata, normalized chord lookup and local binding persistence; Chrome remains authoritative for browser-wide commands. A DOM-independent gesture controller serializes navigation and confirmation, with popup listeners installed before asynchronous initialization. Existing MRU views and row widgets remain authoritative for rendering and activation.

**Tech Stack:** Plain ES modules, Chrome MV3 APIs, Node's built-in test runner and the existing Python Playwright browser fixture; no additional dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-recent-tab-hotkeys-design.md`

## Global Constraints

- Ctrl+Down opens/selects older; Ctrl+Up selects newer inside the popup; releasing Ctrl activates once; Escape cancels even with Ctrl held.
- Preserve sidebar behavior, shared rows, click actions, current highlight, filters, privacy rules and existing user command assignments.
- Chrome-managed bindings open Chrome's native editor; local bindings support capture, validation, duplicate rejection and reset.
- No installations, downloads, added permissions or dependencies; no publication or modification of the root checkout/live browser profile.
- All new tests and non-regenerable design/implementation reports are committed; generated QA artifacts are retained outside the repository.

## Review Focus

- Modifier release during initialization or queued paging must not activate the wrong row or activate twice.
- Escape or window blur must disarm pending confirmation before asynchronous work finishes.
- Remapping, corrupt stored settings and failed storage writes must not disable cancellation or display an unapplied binding.
- Browser command delivery must not double-count a local DOM event or retarget the source session incorrectly.
- Row controls and mouse-opened popups must not accidentally arm release-to-confirm.

---

### Task 1: Shared hotkey registry and extensible settings table

**Files:** Create `src/hotkeys/registry.js`, `src/hotkeys/settings-view.js`, `test/hotkeys.test.mjs`; modify `src/options.html` and `src/options.js`.

**Interfaces:** `HotkeyRegistry({chrome,onChange})` exposes `ready()`, `refreshCommands()`, `binding(id)`, `match(event)`, `setBinding(id,chord)`, `resetBinding(id)`, `dispose()`, and action metadata. `HotkeyChord` normalizes DOM events/Chrome strings, formats labels, matches modifiers, and derives the primary hold modifier. `HotkeySettingsView({root,registry})` renders metadata-driven rows and owns capture lifecycle.

- [x] Write tests for literal Ctrl+Down/Ctrl+Up parsing, composition/AltGr/modifier-only rejection, cancellation independent of held modifiers, scope-aware duplicate checking, persistence/failure and actual Chrome bindings.
- [x] Run `node --test test/hotkeys.test.mjs`; expect missing registry behavior to fail before implementation.
- [x] Implement the registry with indexed lookup and versioned local storage. Capture local bindings on click; Escape aborts recording, a separate Cancel action remains reachable, and Reset restores defaults. Native rows open `chrome://extensions/shortcuts` and refresh on focus.
- [x] Run the new tests and baseline MRU/row tests; expect all passing.
- [x] Review diff and commit this coherent milestone with design and plan documents.

### Task 2: Serialized hold gesture and popup integration

**Files:** Create `src/mru/keyboard.js`, `test/mru/keyboard.test.mjs`; modify `src/manifest.json`, `src/mru/chrome-adapter.js`, `src/mru/popup.js`, `src/mru/popup.html`, `src/mru/view.js`, `test/mru/view.test.mjs` and `test/mru/chrome-adapter.test.mjs` as needed.

**Interfaces:** `MruKeyboard` consumes registry matching and an attached `MruView`; it exposes early `keyDown(event)`, `keyUp(event)`, `command(message)`, `attach(view)`, `cancel()`, `settled()` and `dispose()` lifecycle methods. Opening command context explicitly distinguishes keyboard gesture from mouse-opened manual mode. The view provides its existing controller, `advanceSelection(direction)` and activation path.

- [x] Write failing tests for early release, multiple queued directions, delayed page navigation, Ctrl+Escape, blur cancellation, rebound hold modifier, manual-mode safety and single activation.
- [x] Run `node --test test/mru/keyboard.test.mjs test/mru/view.test.mjs test/mru/chrome-adapter.test.mjs`; expect the new behavior to fail.
- [x] Implement early popup listeners and queued transitions. Route browser opening/repeat commands separately from local reverse navigation, change the suggested opener to Ctrl+Down, and avoid processing the same browser-managed chord twice.
- [x] Run focused tests including `test/hotkeys.test.mjs` and `test/tab-row.test.mjs`; expect all passing.
- [x] Review diff and commit the working gesture milestone.

### Task 3: Real browser verification, documentation and independent review

**Files:** Extend `test/verify_mru_switcher.py` with `--scenario hotkeys`; update `README.md`, the spec/plan checklists and `AGENTS.md` only for useful persistent project decisions.

**Interfaces:** Reuse `MruCheck`, its isolated fixture/profile setup and retained evidence. Exercise the shipped options and popup pages, not copied HTML.

- [x] Add browser assertions for capture/reset/persistence, native command readback, popup opening, both directions, release, cancellation, mouse/row-action safety and responsive settings layout.
- [x] Run `python test/verify_mru_switcher.py --scenario hotkeys --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode`; use an already installed Chromium executable if the bundled browser is missing. Do not install one without approval.
- [x] Run all directly relevant Node suites and inspect the UI evidence. Record any native-accelerator or initial-release limitation precisely.
- [x] Obtain one fresh-context whole-branch review. Fix verified important findings with regression tests; record rulings and deferred minor findings.
- [x] Review diff, commit documentation/QA and verified fixes, and report commits, checks, retained artifacts and limitations. Leave the worktree in place; do not push or merge.

## Independent review and fix pass

The whole branch was reviewed at bbb2d78. Six Important findings were reproduced with failing tests, then fixed in one pass: release/worker-sequence ordering, unrelated-keyup confirmation, startup custom cancellation, activation retry, queued source identity and owned-key cleanup. Regressions live in `test/mru/keyboard.test.mjs`, `test/mru/chrome-adapter.test.mjs` and `test/test_native_shortcut_cleanup.py`; the optional native driver is isolated in `test/native_shortcut_driver.py` so its safety tests require no browser package or actual OS input. One Minor finding is deferred: an explicit UI warning when a Chrome-managed assignment shadows a local binding. That collision is currently visible as duplicate entries but has no dedicated warning.
