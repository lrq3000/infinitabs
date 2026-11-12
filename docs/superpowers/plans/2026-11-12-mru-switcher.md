# InfiniTabs MRU Implementation Plan

> For agentic workers: use executing-plans for the operator-approved native execution. Track steps with checkboxes; use one fresh whole-branch reviewer at the end.

**Goal:** Fast logical-tab MRU switching in the sidebar and standalone keyboard popup.

**Architecture:** Self-contained src/mru storage, search/service, Chrome adapter and shared view. Native bookmarks and existing mount/bind functions remain authoritative; do not refactor the legacy close-tab history.

**Tech Stack:** Manifest V3 JavaScript/CSS, Chrome local/session storage and commands/windows APIs, Node tests, existing Python/Playwright isolated Chromium infrastructure. No new runtime dependency.

**Spec:** [Approved design](../specs/2026-11-12-mru-switcher-design.md).

## Global Constraints

Current session default; optional All sessions; existing Live Only controls tree and MRU per source window. Bookmark identity/layout is canonical. Recovery off by default, future-only, 100 entries / 30 days, restored to current session root end. Normal-window-only MRU. Preserve sidebar toolbar action, all existing comments/logs and close-tab behavior. No root edits, publication, main merge or cleanup. Persist only minimal surviving recency; keep recovery separate.

## Review Focus

- Delayed visit writes after external deletion must not resurrect records (Tasks 1/3).
- Internal popup as first worker event must create no session/bookmark/crash snapshot (Tasks 3/6).
- Context changes during selection must not restore into a different session (Tasks 3/4).
- Partial recovery/mount failure must reuse known new identity or visibly report uncertain completion (Task 5).
- Unicode/markup-like titles and rapid queries must remain safe, stable and usable (Tasks 2/4).

## Files and shared interfaces

Create src/mru/store.js (RecencyStore, RecoveryStore), search.js (MruSearch.match), service.js (MruService catalog/view/query policy), chrome-adapter.js (MruChromeAdapter lifecycle/messages/window coordination), view.js (MruView shared controller), popup.html/popup.js/mru.css (thin popup and scoped presentation). Create test/mru/{store,search,service,chrome-adapter,view,recovery}.test.mjs and test/verify_mru_switcher.py. Narrowly modify background.js/sidebar.js/sidebar.html/styles.css/options.js/options.html/manifest.json and mock_chrome.js only as required. Create todo.md and update README usage.

RecencyStore({storage,clock}) exposes ready(), touch(bookmarkId), forget(bookmarkIds), entries(). RecoveryStore handles configuration, capture/list/prune/clear and restore resume pointers. MruSearch.match(query,{title,url}) returns a fixed tier or no match. MruService({recencyStore,recoveryStore}) exposes catalog refresh, observeView({bookmarkId,isFocused,isIncognito}), query({sourceSessionId,liveOnly,allSessions,query,excludeBookmarkId,offset,limit}) returning items/total. MruChromeAdapter accepts Chrome and injected existing mount/bind/refresh hooks, exposes start/openSwitcher/activate/restoreDeleted and MRU-prefixed messages. MruView({root,client,context}) exposes mount/refresh/dispose/advanceSelection.

### Task 1: Durable storage and deletion policy

- [x] Write test/mru/store.test.mjs: repeated visits are distinct-by-bookmark, A/B/A order, hydrated ties/order, queued-write deletion purge, recovery-off absence.
- [x] Run node --test test/mru/store.test.mjs and observe missing behavior fail.
- [x] Implement namespaced per-record storage with a serialized writer, bounded separate recovery and injected clock; do not touch canonical bookmarks.
- [x] Run the focused tests and require zero failures; commit tests, storage and approved design/plan with conventional attribution.

### Task 2: Logical queries and search

- [x] Write search/service tests for duplicate URLs, background/private observations, Live Only, scopes/current exclusion, ranking/Unicode/paging and canonical ownership changes; run to RED.
- [x] Implement search.js/service.js using cached normalization and fixed stable tiers; no per-keystroke per-result Chrome calls.
- [x] Run node --test test/mru/search.test.mjs test/mru/service.test.mjs plus store tests to GREEN; commit.

### Task 3: Chrome lifecycle and activation

- [x] Write adapter tests for actual focus, attachment races, external/subtree deletion, first-event/restart popup exclusion, focus versus mount, safe unbound-session creation, simultaneous unrelated windows, stale/retargeted context, duplicate requests and private targets; run to RED.
- [x] Implement chrome-adapter.js and narrow background hooks, synchronously registered listeners with a readiness barrier, shared internal-window classification and safe activation/error messages.
- [x] Run adapter tests plus node test/test_history_switch.js, node test/test_active_tab_sync.js and node test/test_switch_session.js to GREEN; commit.

### Task 4: Shared UI and shortcuts

- [x] Write view tests for previous selection/navigation, no highlight activation, stable IDs, stale responses, inert markup, paging and shared Live Only; run to RED.
- [x] Implement shared view, Recent sidebar and popup using existing theme tokens and storage.session window filter state; preserve Workspaces/toolbar behavior.
- [x] Add Alt+Shift+Q opening command and initially unbound Previous tab command; run all new Node tests to GREEN; commit.

### Task 5: Recovery integration

- [x] Write recovery tests for opt-out absence/nonretroactivity, 100-entry/30-day bounds, Live Only exclusion, append-at-root fresh identity, no same-URL merging, retryable failed mount, concurrent retry identity and missing session; run to RED.
- [x] Implement options/capture/pruning/restore with known-identity resume; report incomplete journal operations rather than blindly creating another bookmark.
- [x] Run recovery and all new Node tests to GREEN; commit.

### Task 6: Browser verification and roadmap

- [x] Add isolated real-browser MRU checks reusing mounting assertions, retaining profiles/evidence under C:/Users/33632/AppData/Local/Temp/opencode. Cover UI/filter/focus/scope/recovery/restart/exclusion and measured 10,000-candidate responsiveness.
- [x] Run node --test test/mru/*.test.mjs, the three targeted Node regressions, python -B test/test_mount_oracle.py and python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode. Do not install missing prerequisites or run signing builds.
- [x] Write one-line deferred Quick Tabs capabilities in todo.md and update README usage/limitations.
- [x] Obtain fresh read-only whole-branch review, verify/fix important findings with RED/GREEN and rerun affected checks. Commit the final milestone.
- [x] Check git diff --check, final clean status/commit hashes, main synchronization and retained artifacts; report any gaps without overstating verification.

## Operational approval and execution ledger

The operator approved this plan and native execution on 2026-11-12. Worktree C:/git/infinitabs/.worktrees/mru-switcher, branch feat/mru-switcher; fetch/fast-forward before edits. All later operations stay here. No push/PR/main merge/cleanup. Local commits carry OpenCode / OpenAI GPT-6.1 Sol attribution.

Pre-flight: Task 1 stores feed Tasks 2/5; Task 2 service/search feed Tasks 3/4; Task 3 adapter messages/window context feed Tasks 4/5; Tasks 1-5 feed Task 6. Interfaces above match, no conflicting duplicate placement model.

Baseline: refreshed to origin/main 4bad7cc; existing test_history_switch.js, test_active_tab_sync.js and test_switch_session.js all pass. Existing Node MODULE_TYPELESS_PACKAGE_JSON warnings are baseline; do not change package type and break mixed CommonJS tests just to silence them.

Ruling: Native worktree API exposes no exact destination path; use the approved git worktree bootstrap and session_move to honor mandatory project-local worktree placement. Root .worktrees is already untracked; do not modify root ignore configuration, and stage explicit task paths only. Cost if wrong: root status continues showing its pre-existing worktree directory, without any task files being staged there.

### Execution status

- [x] Task 1: 9d34a6a — durable recency/recovery storage; five RED→GREEN tests.
- [x] Task 2: bd7d21b — scoped logical queries and fuzzy search; eleven cumulative tests.
- [x] Task 3: 35e633d — Chrome lifecycle and public routing; nineteen cumulative tests and three original regressions.
- [x] Task 4: f51209c — shared sidebar/popup UI and commands; twenty-three cumulative tests plus real sidebar/popup/keyboard checks.
- [x] Task 5: 6ba623c — explicit recovery settings, cold-event deletion and resumable append-at-end restore; thirty cumulative tests plus actual Chromium recovery.
- [x] Task 6 functional verification/documentation: thirty-three MRU tests, twenty Python tests, eight Chromium workflows, targeted original history/active/session/drag/group/movement regressions, README and one-line deferred-feature checklist.
- [x] Fresh whole-branch review, important-findings fix pass and final rerun; code committed through e6bbc6d, with this final documentation milestone completing the record.

Browser evidence is retained at C:/Users/33632/AppData/Local/Temp/opencode/mru-qa-rebema76: isolated Chromium 153.0.8010.12 (installed Playwright revision 1243), light/dark popup and 360px sidebar screenshots, worker/browser-process restart, transparent unmounted restore and cross-session bridge with concurrent unrelated window creation. Synthetic production-service/view benchmark: 10,000 candidates, twenty queries, median 5.80ms, p95 12.40ms, initial fifty-row render 35.50ms; these are local fixture measurements, not a promise for every profile or 10,000 native browser tabs.

Ruling: The installed Python Playwright expects missing Chromium revision 1217; reuse the already installed revision 1243 through --executable rather than download anything. Cost if wrong: possible protocol incompatibility, addressed by running the actual flows and reporting the browser version.

Ruling: Existing persisted windowToSession storage can lag a quick window closure; validate MRU activation destinations against the current native window inventory instead of changing unrelated legacy persistence policy. Cost if wrong: an extra native inventory query per activation, but no per-result/keystroke API scan. RED→GREEN tests cover stale bindings, concurrent popup creation and optional command-tab omission.

Ruling: Legacy quick-drag VM tests hard-code static import replacement; inject the real new MRU module into that VM. Populated native window snapshots are now supported by the shared Chrome mock, preserving existing startup query-count guarantees. Cost if wrong: VM coverage remains weaker than browser evidence, so actual rendered flows are tested separately.

## Final verification and independent review

One fresh independent reviewer inspected 4bad7cc..fb76f88 and reported five Important findings plus four behavior findings initially marked Minor. Each finding was independently reproduced before correction; the four behavior findings were treated as release-blocking because stale selection/IME can activate unintended tabs, and cold popup/window-type handling violates the supported lifecycle contract. No second review was commissioned: the single corrective pass is verified by the regression tests below, not a claim that the original reviewer re-approved later commits.

- [x] Deletion-time consent: delayed-handler tests first retained pre-opt-in data; receipt-time consent tickets and epochs now reject later opt-in and old work crossing opt-out/opt-in.
- [x] Durable uncertain restoration: a lost post-create identity journal first allowed a duplicate after cold retry; pre-create intent now persists uncertainty and blocks automatic duplication across restart.
- [x] Canonical URL/ownership: external edits/moves first mounted an old URL or rejected a valid logical identity; unmounted targets now use the existing metadata-preserving reload and mounted projections are focused without duplication.
- [x] Concurrent saved-session targets: different target keys first created two windows for one session; per-session discovery/binding/mount coordination now produces one destination without suppressing unrelated windows.
- [x] Native focus: the fixture now matches the real helper's missing-focus unmounted branch; explicit destination focus is asserted both in Node and actual Chromium.
- [x] Stale paging: a delayed page continuation first selected the wrong item from newer results; generation/application checks now guard the continuation as well as the response.
- [x] Cold source closure: a persisted popup first remained open after losing its source during worker wake; hydrated context now validates native source existence/binding and pre-readiness removals.
- [x] Window boundaries: actual website-popup fixtures first passed source/destination checks; normal/non-private eligibility is now consistent without changing InfiniTabs' ordinary website-popup session tracking.
- [x] IME input: composing Enter/arrows first activated or moved MRU selection and canceled a real Chromium composition event; composition keys now retain their input-method default action.

Correction commits: b16532e (consent/durable intent), 23ffaaf (canonical/session/native-focus activation), e6bbc6d (selection/composition/cold context/window guards). Existing reload preservation now indexes old bookmarks once, retaining O(n) rather than O(n²) behavior on the new unmounted activation path; the temporary index costs per-reload memory, not another canonical layout model. Underlying legacy incognito/workspace-persistence policy and optional Quick Tabs roadmap implementations remain explicitly out of scope. No deferred review minors remain.

Final Node command: `node --test --test-reporter=dot --test-concurrency=2 test/mru/*.test.mjs test/test_history_switch.js test/test_active_tab_sync.js test/test_switch_session.js test/test_sidebar_quick_drag.js test/test_group_folder_resolution.js test/test_group_metadata_interleavings.js test/test_group_removal_classification.js test/test_move_logical_tabs.js test/test_move_group_feedback.js test/test_group_lifecycle_fixture.js` — 56 passing checks, including 46 MRU cases and ten existing script-level checks (some legacy scripts contain additional internal cases).

Final Python command: `python -B -m unittest discover -s test -p "test_*.py"` — 20 passing tests. The standalone mount oracle also passed its 12 tests earlier.

Final Chromium command: `python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode --executable C:/Users/33632/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe` — nine passing workflows, no captured page/worker errors. Final retained evidence/profile/screenshots: C:/Users/33632/AppData/Local/Temp/opencode/mru-qa-b9_malwh. Browser: isolated Chromium 153.0.8010.12. Synthetic 10,000-candidate benchmark: median 6.00ms, p95 10.90ms, first fifty-row render 34.60ms; not a native-tab-count or cross-machine guarantee.

Remaining validation limits: the shipped sidebar UI was automated as an extension page, not through Chrome's real side-panel embedding; OS-level shortcut dispatch/toolbar clicking and a physical IME were not exercised. Composition-event handling, popup keyboard interaction and native mount/focus effects were exercised. No packaging/signing build was run because this source extension loads unpacked and the build command creates signing artifacts.

Latest fetch left no origin/main commits outside this branch. Root worktree status remains its original manifest edit and untracked directories; no root edits, user-profile interaction, push, PR, main merge or cleanup occurred. Temporary evidence/profiles under Temp/opencode/mru-qa-* and logs under Temp/opencode/mru-*.log, plus this plan's ignored .superpowers/sdd workspace, are deliberately retained for manual cleanup.
