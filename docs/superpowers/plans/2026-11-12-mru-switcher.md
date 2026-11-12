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

- [ ] Write test/mru/store.test.mjs: repeated visits are distinct-by-bookmark, A/B/A order, hydrated ties/order, queued-write deletion purge, recovery-off absence.
- [ ] Run node --test test/mru/store.test.mjs and observe missing behavior fail.
- [ ] Implement namespaced per-record storage with a serialized writer, bounded separate recovery and injected clock; do not touch canonical bookmarks.
- [ ] Run the focused tests and require zero failures; commit tests, storage and approved design/plan with conventional attribution.

### Task 2: Logical queries and search

- [ ] Write search/service tests for duplicate URLs, background/private observations, Live Only, scopes/current exclusion, ranking/Unicode/paging and canonical ownership changes; run to RED.
- [ ] Implement search.js/service.js using cached normalization and fixed stable tiers; no per-keystroke per-result Chrome calls.
- [ ] Run node --test test/mru/search.test.mjs test/mru/service.test.mjs plus store tests to GREEN; commit.

### Task 3: Chrome lifecycle and activation

- [ ] Write adapter tests for actual focus, attachment races, external/subtree deletion, first-event/restart popup exclusion, focus versus mount, safe unbound-session creation, simultaneous unrelated windows, stale/retargeted context, duplicate requests and private targets; run to RED.
- [ ] Implement chrome-adapter.js and narrow background hooks, synchronously registered listeners with a readiness barrier, shared internal-window classification and safe activation/error messages.
- [ ] Run adapter tests plus node test/test_history_switch.js, node test/test_active_tab_sync.js and node test/test_switch_session.js to GREEN; commit.

### Task 4: Shared UI and shortcuts

- [ ] Write view tests for previous selection/navigation, no highlight activation, stable IDs, stale responses, inert markup, paging and shared Live Only; run to RED.
- [ ] Implement shared view, Recent sidebar and popup using existing theme tokens and storage.session window filter state; preserve Workspaces/toolbar behavior.
- [ ] Add Alt+Shift+Q opening command and initially unbound Previous tab command; run all new Node tests to GREEN; commit.

### Task 5: Recovery integration

- [ ] Write recovery tests for opt-out absence/nonretroactivity, 100-entry/30-day bounds, Live Only exclusion, append-at-root fresh identity, no same-URL merging, retryable failed mount, concurrent retry identity and missing session; run to RED.
- [ ] Implement options/capture/pruning/restore with known-identity resume; report incomplete journal operations rather than blindly creating another bookmark.
- [ ] Run recovery and all new Node tests to GREEN; commit.

### Task 6: Browser verification and roadmap

- [ ] Add isolated real-browser MRU checks reusing mounting assertions, retaining profiles/evidence under C:/Users/33632/AppData/Local/Temp/opencode. Cover UI/filter/focus/scope/recovery/restart/exclusion and measured 10,000-candidate responsiveness.
- [ ] Run node --test test/mru/*.test.mjs, the three targeted Node regressions, python -B test/test_mount_oracle.py and python -B test/verify_mru_switcher.py --headless --artifacts-dir C:/Users/33632/AppData/Local/Temp/opencode. Do not install missing prerequisites or run signing builds.
- [ ] Write one-line deferred Quick Tabs capabilities in todo.md and update README usage/limitations.
- [ ] Obtain fresh read-only whole-branch review, verify/fix important findings with RED/GREEN and rerun affected checks. Commit the final milestone.
- [ ] Check git diff --check, final clean status/commit hashes, main synchronization and retained artifacts; report any gaps without overstating verification.

## Operational approval and execution ledger

The operator approved this plan and native execution on 2026-11-12. Worktree C:/git/infinitabs/.worktrees/mru-switcher, branch feat/mru-switcher; fetch/fast-forward before edits. All later operations stay here. No push/PR/main merge/cleanup. Local commits carry OpenCode / OpenAI GPT-6.1 Sol attribution.

Pre-flight: Task 1 stores feed Tasks 2/5; Task 2 service/search feed Tasks 3/4; Task 3 adapter messages/window context feed Tasks 4/5; Tasks 1-5 feed Task 6. Interfaces above match, no conflicting duplicate placement model.

Baseline: refreshed to origin/main 4bad7cc; existing test_history_switch.js, test_active_tab_sync.js and test_switch_session.js all pass. Existing Node MODULE_TYPELESS_PACKAGE_JSON warnings are baseline; do not change package type and break mixed CommonJS tests just to silence them.

Ruling: Native worktree API exposes no exact destination path; use the approved git worktree bootstrap and session_move to honor mandatory project-local worktree placement. Root .worktrees is already untracked; do not modify root ignore configuration, and stage explicit task paths only. Cost if wrong: root status continues showing its pre-existing worktree directory, without any task files being staged there.
