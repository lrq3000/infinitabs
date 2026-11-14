# Recent tabs current-tab navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current tab first and persistently highlighted in Recent while retaining a separate keyboard cursor for fast switching.

**Architecture:** Derive `currentBookmarkId` from the existing source context and promote the eligible current row before query pagination. The shared view distinguishes active-tab presentation from `selectedKey`; explicit exclusion remains available for the Previous tab command. No new persisted state or mapping is required.

**Tech Stack:** JavaScript MV3 Chrome extension, Node built-in test runner, Python Playwright with installed isolated Chromium.

**Spec:** `docs/superpowers/specs/2026-11-14-recent-current-tab-design.md`.

## Global Constraints

Work only in `C:/git/infinitabs/.worktrees/recent-current-tab` on `feat/recent-current-tab`, created from `288d816f306da631d77a5ada7973961d5fe8fdb9`.

Retain existing session scope, Live Only, recovery consent, existing search relevance among older matches, bounded page rendering, generation guards, popup dismissal, themes, and mounted/unmounted activation behavior.

Do not manufacture visits or change bookmark placement. Use installed dependencies only. No push, merge, installation, signing build, deletion, regular-browser-profile changes, or version bump before integration.

## Review Focus

- Current identity without visit metadata must still appear exactly once and must not create stored visit metadata.
- Search mismatches, private targets, scope mismatches, and explicit exclusion must never be bypassed by current-row promotion.
- Current changes during a pending query or while viewing an older page must reset to current results without stale selection effects.
- Keyboard cursor and current highlight must remain distinguishable in light/dark themes, with correct independent accessibility attributes.
- Previous tab must skip current while ordinary queries include it; popup focus and refresh must not change real visit order.

---

### Task 1: Shared current-tab query, presentation, and regression coverage

**Files:** Modify `src/mru/{chrome-adapter.js,service.js,view.js,mru.css}`, `test/mru/{service,chrome-adapter,view}.test.mjs`, `test/verify_mru_switcher.py`, `README.md`, and these approved documents.

**Interfaces:** `MruChromeAdapter.context(sourceWindowId)` returns `{sourceWindowId,sourceSessionId,liveOnly,currentBookmarkId}`. `MruService.query({currentBookmarkId,excludeBookmarkId,...existingOptions})` returns the existing `{items,total}` shape, with eligible current first before slicing. `MruController.currentKey` derives `tab:<currentBookmarkId>` or null; `selectedKey` remains the independently navigable cursor. `MruView.render()` uses `aria-current="page"` only for the current row and `aria-selected` only for cursor selection.

- [x] Verify isolated baseline with `node --test --test-reporter=dot test/mru/*.test.mjs test/test_startup_restore.js`: exit 0, 75 checks.
- [x] Add service regressions for current-first ordering, deduplication, missing visit metadata without writes, normal filters, relevance, exclusions, and page totals; adapter regressions for authoritative source current identity and Previous tab skipping it; controller regressions for independent current identity, initial older selection, actual-current changes, and page/generation guards. Expected representative assertion: current `a` with newer visited `b` yields keys `['tab:a','tab:b']` with no duplicate.
- [x] Run `node --test --test-reporter=dot test/mru/service.test.mjs test/mru/chrome-adapter.test.mjs test/mru/view.test.mjs`; confirm the new behavior fails before production changes.
- [x] Extend the existing real Chromium runner for independent `aria-current` / `aria-selected`, current-first sidebar/popup, search hiding/showing current, native and sidebar tab changes, and keyboard activation. Update old expectations that deliberately excluded current. Run the browser command below once and confirm the new behavior fails before implementation. Previous tab is verified deterministically through the real adapter command handler in Node, not an OS-level browser shortcut.
- [x] Implement the declared interfaces in existing classes, preserving linear query assembly and shared presentation. Promote only the eligible current candidate, preserve older ranking, reset page/cursor only when the source current identity changes, and preserve positional paging semantics. Style selected rows with an inset outline and current rows with the existing active background; add a Current label. Document the behavior in the existing README MRU usage paragraph.
- [x] Run `node --test --test-reporter=dot test/mru/*.test.mjs test/test_startup_restore.js` and `python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe`; require exit 0 and no captured page/worker errors. Inspect light/dark and narrow screenshots. Run `git diff --check`.
- [x] Obtain one read-only fresh-context review of the scoped diff against the approved design; verify findings, fix only valid issues, and repeat affected checks if needed.
- [x] Review `git diff`, stage only the approved task files, and commit the complete working milestone as `feat(mru): show and highlight the current tab in recent results`, including motivation, mechanism, tests, and final `Agentic stack: OpenCode; OpenAI GPT-6.1 Sol.` attribution. Verify clean task worktree; the implementation commit includes this completed checklist and the evidence below.

## Execution evidence

Isolation setup: added only `/.worktrees/` to repository-local `.git/info/exclude`, created the approved worktree/branch from current main HEAD, and moved this session there. No dependencies installed.

Plan self-review: the one coherent task covers the full approved design, all five review-focus inputs have assigned tests, property names are consistent, and no unrelated refactor is planned.

Pre-flight: no shared interfaces between tasks (one coherent task). Task 1 base: `288d816f306da631d77a5ada7973961d5fe8fdb9`.

Ruling: use this approved committed checklist as the progress ledger rather than generating separate `.superpowers` bookkeeping files with Bash helpers — the approved scope already assigns this plan that responsibility, and a second ledger adds unnecessary state for one task — if interrupted, resume from these checkboxes and Git history. Keep all QA scratch artifacts instead of executing the skill's cleanup suggestion, as explicitly required by the approved plan.

Browser routing: the `browser` skill/plugin is not listed; use the approved repository Playwright runner with a fresh isolated Chromium profile. The real-user browser controller is intentionally not used for extension testing. The flow under test is: Recent/sidebar or switcher → current row plus older-tab cursor → native/click/keyboard activation updates current-first highlight independently of cursor movement.

RED evidence: the focused Node run failed ten new assertions for missing current identity, current-first ordering, missing-visit inclusion, and cursor reset. The browser regression failed against unchanged production code because source context did not expose `currentBookmarkId` (`mru-qa-td9dylpq`). After implementation, all 86 Node checks passed.

Browser evidence before final review fix: first run reached the last header screenshots but was terminated by the 120-second command deadline, with no surviving owned Python/Chromium process (`mru-qa-6glg_l7c`). The rerun with a 600-second budget passed all 12 workflows in isolated Chromium 153.0.8010.12, extension ID `nnjmbmdcoebilajjjakopcpghmdelgol`, with no captured page/worker errors. Evidence/profile/screenshots: `C:/Users/33632/AppData/Local/Temp/opencode/mru-qa-5rji86sn`. Inspected light narrow sidebar and dark popup screenshots, including independent filled current highlight and outlined keyboard cursor. Synthetic 10,000-candidate check rendered only 50 rows; median query 9.3ms, p95 18.8ms, initial render 27.3ms (local fixture measurements, not a native-tab-count guarantee).

Independent review: one P2 race reported, no other concrete findings or deferred minors. Reproduced pending Home and ArrowUp page-one responses changing current: positional page continuations overrode the reset cursor. Added both regressions, observed the expected failures, then guarded paging against a changed current identity as well as generation. Final Node run: 88/88 passed; `git diff --check` passed. No second reviewer is needed for this test-verified fix pass.

Final: Ruling: the reviewer declined full browser/theme verification because it did not operate Chromium — the main session independently inspected the saved 12-flow result, zero-error report, and light/dark screenshots and is rerunning the browser suite after the race fix — remaining scope is headless Chromium only, with the Previous tab command tested at the real adapter boundary rather than an OS shortcut.

Final browser verification after the review fix: all 12 workflows passed again, no captured page or worker errors, same isolated Chromium/extension ID. Retained evidence/profile/screenshots: `C:/Users/33632/AppData/Local/Temp/opencode/mru-qa-6pkbehlp`. Inspected the final light/dark 320px Recent screenshots: no clipping, current row has the filled highlight, older cursor row has a separate outline. Synthetic 10,000-candidate measurements: median query 9.2ms, p95 13.5ms, initial 50-row render 31.3ms. The preceding final Node spec-reporter run explicitly reported 88 tests, 88 passed, zero failures/skips. The pre-existing `MODULE_TYPELESS_PACKAGE_JSON` warning remains unchanged; no unrelated package-module conversion was made.

Task 1: complete in the local implementation commit containing this plan. All non-regenerable tests and directly related documentation are included; profiles, screenshots, and generated evidence remain outside the repository for manual cleanup. Branch/worktree are retained per the approved local-only scope, with no merge, push, or deletion. No deferred minor findings.
