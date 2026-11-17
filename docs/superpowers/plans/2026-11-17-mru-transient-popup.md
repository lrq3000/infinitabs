# Transient Recent Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Recent window minimal and transient on observed shortcut-key release or outside focus.

**Architecture:** Extend the existing gesture controller with observed physical-key tracking and unconditional blur cancellation. A popup-only activation transport option hands activation to the worker, which closes the UI while the native operation continues; normal sidebar requests remain unchanged.

**Tech Stack:** Existing JavaScript modules, Chrome APIs, Node tests, and the installed isolated Chromium/Python Playwright fixture; no installs or downloads.

**Spec:** `docs/superpowers/specs/2026-11-17-mru-transient-popup-design.md`

## Global Constraints

- Keep the native frame, toolbar/sidebar behavior and shared tab row controls. Hide only the normal switcher's redundant in-page heading, not the session bridge heading.
- Only observed key releases are actionable; require the primary modifier's actual keyup and all other observed pressed keys to be up. Preserve the worker gesture barrier.
- Blur cancels in keyboard, manual and pointer-disarmed modes. It must not activate a pending selection.
- A popup may dismiss before activation completes; the worker owns completion and error reporting. Sidebar confirmation/retry behavior is unchanged.
- No added dependencies/permissions, installations, native product helper, push, merge or live-profile changes. Retain artifacts and local commits.

## Review Focus

- Ctrl released before a still-held arrow must not confirm until that arrow is released.
- Repeated keydowns and shifted character keyups must not leave an impossible pressed-key state.
- Blur in manual/disarmed mode or during a queued barrier must cancel without activation.
- The popup must close while a background mount is pending; a subsequent failure must be handled rather than becoming an unhandled rejection.
- Native-window removal must start even when storage cleanup is delayed, and ordinary row confirmation dialogs must remain usable.

---

### Task 1: Observed-key release and transient presentation

**Files:** Modify `src/mru/keyboard.js`, `src/mru/popup.js`, `src/mru/popup.html`, `src/mru/mru.css`, `src/mru/chrome-adapter.js`, `test/mru/keyboard.test.mjs`, `test/mru/chrome-adapter.test.mjs`, and `test/verify_mru_switcher.py`.

**Interfaces:** Keep `MruKeyboard.keyDown(event)`, `keyUp(event)`, `blur()` and `disarm()`; add internal observed-key identity/release helpers using event.code where available. The popup must forward native-chord DOM events to tracking without advancing twice. Add the focused browser scenario `--scenario transient` using the existing profile/fixture machinery.

- [x] Write failing tests for release ordering, repeat/case identity, manual/disarmed blur and cancellation during pending navigation; update old tests that omitted the arrow keyup to model complete presses.
- [x] Run `node --test test/mru/keyboard.test.mjs`; expect the new transient cases to fail.
- [x] Implement observed-key tracking and unconditional blur; hide the normal header with a hidden-aware CSS rule and show it for bridge mode only. Add native window-focus dismissal with ownership/focus revalidation after the browser test demonstrated emulated document focus.
- [x] Run the Node MRU/hotkey/tab-row suites and the isolated transient/row-controls browser scenarios; expect green checks with retained evidence.
- [x] Review the diff and commit this lifecycle/presentation milestone.

### Task 2: Worker-owned activation handoff and final review

**Files:** Modify `src/mru/view.js`, `src/mru/popup.js`, `src/mru/chrome-adapter.js`, `test/mru/view.test.mjs`, `test/mru/chrome-adapter.test.mjs`, `test/verify_mru_switcher.py`, `README.md`, and directly relevant `AGENTS.md` guidance.

**Interfaces:** Add a popup-only `MruClient(chrome, { dismissSwitcherOnActivate: true })` option; only MRU_ACTIVATE requests gain `dismissSwitcher: true`. The worker accepts that option, attaches its existing run/error handler to activation, and closes the UI independently of target completion. `closeSwitcher()` starts native removal and storage cleanup concurrently.

- [ ] Write failing tests for client scoping, dismissal while native activation is pending, worker error broadcast, and native removal during delayed storage cleanup.
- [ ] Run `node --test test/mru/view.test.mjs test/mru/chrome-adapter.test.mjs`; expect missing handoff behavior to fail.
- [ ] Implement scoped activation handoff and concurrent close/cleanup. Update user documentation for observed-key release, immediate UI dismissal and background error handling.
- [ ] Run all directly relevant Node tests, cleanup tests, and isolated transient/hotkeys/row-controls browser checks. Inspect screenshots and console evidence.
- [ ] Obtain one fresh-context review of this refinement; fix verified important findings with failing-first regressions, record rulings/deferred minors, commit coherent results, and leave the clean branch/worktree in place.
