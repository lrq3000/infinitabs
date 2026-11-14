# Visibility-aware Sidebar Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep fully visible selected tabs stationary while revealing clipped or off-screen selections.

**Architecture:** Add a viewport guard to the existing animation-frame scroll helper and route Locate through it. Preserve rendering, activation, mounting, and Recent popup mechanisms.

**Tech Stack:** Vanilla JavaScript, Node's test runner/VM, Python Playwright, existing Chromium installation.

**Spec:** `docs/superpowers/specs/2026-11-14-sidebar-autoscroll-design.md`

## Global Constraints

- Work only in `C:\git\infinitabs\.worktrees\fix-visible-tab-autoscroll`, branch `fix/visible-tab-autoscroll`.
- No installations, personal-browser interaction, push, merge, deletion, or unrelated refactors.
- Retain generated evidence/profile data in `C:\Users\33632\AppData\Local\Temp\opencode`.
- Commit non-regenerable tests and directly related documentation with the fix.

## Review Focus

- Evaluate visibility after DOM mutation, not before the scheduled animation frame.
- Treat both partially clipped edges as out of view and exact inner boundaries as visible.
- A normal-tree update while Recent is visible must not scroll the hidden tree or outer page.
- Locate must expand a collapsed active group without moving an already-visible active row.
- Preserve behavior when IDs regenerate during mounting, rows change height, or the target disconnects.

## Task 1: Visibility-aware selection and Locate

**Files:** Modify `src/sidebar.js`; create `test/test_sidebar_autoscroll.js` and `test/verify_sidebar_autoscroll.py`.

**Interfaces:** Keep `scrollElementIntoViewWithContext(element, { contextRows = 2, block = 'start' } = {})` as the sole guarded scroll path for the normal tree. Locate uses `{ contextRows: 0, block: 'center' }`. Existing callers need no changes.

- [x] Check isolated-worktree baseline with `node test/test_sidebar_quick_drag.js` and `node --test test/tab-row.test.mjs` (both pass; existing module-format warning).
- [x] Write Node boundary tests and an actual-extension Playwright reproduction before changing production code.
- [x] Run `node --test test/test_sidebar_autoscroll.js` and `python -B test/verify_sidebar_autoscroll.py --headless --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode`; expect the visible-selection assertion to fail on the baseline.
- [x] Add the geometry guard and share it with Locate; preserve context/centering for off-screen rows.
- [x] Repeat both new test commands and the baseline checks; expect all checks to pass.
- [x] Run the repository's Node tests using their existing direct-entrypoint conventions, report any existing failures, inspect the diff, and commit the coherent fix/tests/docs.

## Task 2: Independent validation and delivery

**Interfaces:** Review Task 1's unchanged activation/rendering contracts and geometry evidence; no new production interfaces.

- [x] Obtain one fresh-context, read-only whole-branch review of the approved behavior, diff, and evidence. Validate any actionable findings before changing code.
- [ ] Reproduce and correct the review's competing passive-search scroll path; retain explicit search navigation and rerun relevant suites.
- [ ] Verify the final commit and clean task worktree; report commit, checks, remaining limitations, and retained temporary artifacts.

## Execution ledger

- Plan approved through the inline approval card. Base: `554bb95`.
- Pre-flight: Task 2 consumes Task 1's tests/diff only; no competing production interfaces.
- Ruling: Track progress directly in this approved Markdown plan instead of Unix-specific scratch-workspace scripts, using the required patch tool on Windows; this avoids extra script/configuration changes. Cost if wrong: no behavioral impact, but no generated task/review package.
- Baseline reproduced: mounted visible click moved scrollTop from 584 to 706 in actual Chromium; four Node guard tests failed, and a separate short-viewport contextual-reveal test failed.
- Task 1 validation: all 8 helper tests, all 90 Node runner tests, all 12 existing CI Node entrypoints, Python's 20 unit tests, and all 39 real-extension browser flows passed. Final browser evidence/profile: `C:\Users\33632\AppData\Local\Temp\opencode\sidebar-scroll-zgmvtu6r`; Node logs: `C:\Users\33632\AppData\Local\Temp\opencode\sidebar-scroll-node-aljitkev`.
- Runtime adaptation: Playwright's pinned Chromium revision is not installed. Used `--executable-path C:\Users\33632\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe` without installing anything. One 180-second combined run timed out; its replacement completed all three modes with a 360-second budget. No lingering browser process from the interrupted profile was found.
- Test expectation correction: expanding a collapsed group can already make its active row visible; the browser test therefore requires visibility but does not require a scroll call in that case.
- Final review: no critical findings; an important residual passive-search scroll path needs reproduction/fix before completion. Overlapping selections during an unfinished smooth scroll remain unverified, not a demonstrated defect.
- Final: minor (deferred): the collapsed-group browser scenario verifies expansion and final visibility but does not separately assert stationary scroll when expansion alone reveals the selected row; visible-target suppression is covered by the shared-helper and ordinary Locate tests.
