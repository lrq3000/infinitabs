# PR27 mounting investigation: NEEDS_CONTEXT

## Pinned inputs and decision

- Owned worktree: `WORKTREE` (isolated checkout `.worktrees/integrate-pr27-backlog`).
- Branch: `agent/integrate-pr27-backlog`.
- Base and fetched `origin/main`: `69d1c527e13d6e94390656ed2df9debb4a953042`
  (PR76), following `2337fb152ea4e95b28ae48233dbb0ffe995b5546` (PR40).
- Original PR27 head: `486e84e526dd4f91dca2e173cec240d38b2fa373`.
- Original implementation: `64280e8f4c8d0f8ec00011febe4af9db6410bfd0`, authored
  by `google-labs-jules[bot]`, committed by Stephen Karl Larroque. Follow-ups
  `e49e47f0ad932c2bfb870d50f675c8e5794428da` and `486e84e...` were authored by
  Stephen L. using OpenCode / `openai/gpt-5.3-codex`.

The complete original branch diff and all three commit descriptions were read.
Its intent was to avoid sticky-group insertion by creating at the window end,
grouping, then repositioning at an index passed through the pending mount entry.
Its later movement suppression depends on the obsolete timed
`ignoreMoveEventsForTabIds` mechanism. No original code was merged or ported.

**The reported defect did not reproduce on this base.** All nine real-browser
mounting cases below pass with unchanged production source, including the two
group-edge fixtures corrected after controller/spec review and the URL/order
and folder-title oracle strengthened after quality/GitHub review. The user decision is
to merge coverage only and keep PR27 open; publication remains with the controller.
Following the task's reproduction gate, this branch contains verification only,
not a mounting fix or a claim that every historical PR27 scenario is resolved. No failing Node model
was invented in the absence of a demonstrated production failure.

## Current implementation and invariant

`focusOrMountLogicalTab` computes an insertion index after the nearest mounted
logical predecessor, or zero without one. It calls `chrome.tabs.create` with
that index. Both pending-entry consumers (the `onCreated` listener and the create
promise fallback) attach the tab and use the current single-tab group wrapper.
The wrapper delegates to PR76's batched group helper. Neither mount path performs
the old PR's extra native reposition.

The mounting invariant tested is: exactly one new native instance, correct
bookmark-derived native order and group membership, preserved canonical bookmark
IDs/parents/indices/child order/URLs, unchanged unrelated live IDs and native
group metadata, and the mounted tab active in both Chrome and the shipped sidebar.
A saved-only folder must acquire a new native group with its saved title/color.
Every poll also requires the new native tab's URL and its current logical URL to
equal the canonical **pre-mount bookmark URL**, plus equality of the ordered
before/after logical bookmark-ID lists (including multiplicity). Logical IDs may
regenerate; bookmark identities and their order must remain stable.
Folder bookmark titles, including encoded group colors, also remain canonical;
URL-bearing tab bookmark titles may change as their pages finish navigating.

The fixture uses real native tabs with unique local HTTP URLs, saves them through
the extension, builds real groups, and uses `UNMOUNT_LOGICAL_TAB` to leave saved
targets. Setup asserts that saved-only folders survive and existing groups still
have two live members, so group-removal behavior cannot silently turn a grouped
test into a root test. Every mount uses the public `FOCUS_OR_MOUNT_TAB` message
from the actual `sidebar.html` page. No Chrome API or listener is mocked/replaced.

In the recorded nine mount operations, the native tab ends in its intended
position and the expected group updates occur. The event recorder sees **no
`tab-moved` or `bookmark-moved` events** during those mount intervals. The corrected
edge fixtures separately record the real sidebar move and bookmark reconciliation
under `edge_setup`, before clearing events for the mount. Thus the extra
reposition/suppression proposed by the old patch is not justified by these cases.
This observation does not imply `tabs.group` never relocates tabs: PR76's movement
scenarios demonstrate that it can for other starting arrangements.

## Browser cases and results

Fixture names start as `X,A,B,C,Y,U,V,Z` (the sidebar is also a real mapped tab).
Each flow runs in a separate disposable profile. The default unrelated active
group is `U,V`, active `U`; the last two flows use `X,A`, active `A`, immediately
before the saved `B` destination, with the sidebar moved to the window end.

| Flow ID | Saved target / invariant | Result |
| --- | --- | --- |
| `existing_middle` | B between native A and C in the original ABC group | PASS |
| `existing_first` | A before native B and C in the original ABC group | PASS |
| `existing_last` | C after native A and B in the original ABC group | PASS |
| `saved_group` | B in a saved-only folder, recreated as `Saved mount` / blue | PASS |
| `root_middle` | Root B between A and C, remaining ungrouped | PASS |
| `root_first` | Root X with no live logical predecessor | PASS |
| `root_blank` | Saved root B with `about:blank` URL | PASS |
| `root_after_active_group` | Root B immediately after unrelated active group XA | PASS |
| `saved_group_after_active_group` | Saved-only B group immediately after active group XA | PASS |

Each passes polling followed by at least 500 ms of unchanged snapshots and no
new recorded events, with a 15-second deadline. This exceeds the existing 50 ms
movement queue delay and 100 ms delayed ungroup callback, but does not prove
absence of arbitrarily late events. Screenshots independently record the real
sidebar, whose single active row is asserted against the mounted logical ID.

### Review correction: prove the group edge before mounting

Controller/spec review identified a material gap in commit `c67fb28`: grouping
noncontiguous X/A left the live sidebar between A and the saved B destination.
The old evidence showed `X(group), A(active, group), Sidebar, C, ...`, making
Sidebar the nearest live logical predecessor. The original two PASS results did
**not** establish immediate adjacency to the active group; their earlier report
descriptions overstated the evidence. The other seven cases were unaffected.

The corrected fixture obtains the sidebar's actual tab via `tabs.getCurrent`,
moves it to the same window's end via `tabs.move({index: -1})`, and gives the
active group explicit `Active edge` / red metadata via `tabGroups.update`.
The shipped native-event handlers reconcile bookmarks/session state. No direct
production-state mutation or mocked Chrome API is used.

Before sending `FOCUS_OR_MOUNT_TAB`, both edge cases now require:

- B is saved-only in its intended root or saved-group parent.
- B's nearest **live logical** predecessor is A, whose live identity is retained.
- Exact native order is `X,A,C,Y,U,V,Z,Sidebar`, independently of the generic
  bookmark-derived mount expectation; all remain in the target window.
- A is active in native and session state, and the active group's only members
  are X/A. The desired index is **2**, equal to the group's last index **1** + 1.
- Sidebar is ungrouped at index **7**, and the mounted logical order has caught
  up with the native move. X/A's bookmark parents and group title/color agree
  between native, session and persisted bookmark state.

These preconditions must remain quiet for 500 ms and are asserted again against
the settled `before` snapshot immediately before dispatch. Evidence records the
boundary indices and predecessor identities in `boundary_precondition`.
In the edge-correction run `mounting-evidence-z7p28pse`, setup quiet periods were 524 ms (root) and 526 ms
(saved group); post-mount quiet periods were 511 ms and 518 ms respectively.
Both targets mounted at index 2, preserving the active group's identity and
metadata; the root target remained ungrouped and the saved-group target acquired
its own restored group. Both targeted reruns passed first, then all nine passed.

Only the mounting script and this report changed for that edge correction. The shared
runner, other seven case assertions, CI and production code are unchanged, so
their earlier preservation checks below remain applicable.

### Quality correction: reject URL corruption and logical order/duplicates

Quality review of `f49b307` identified two oracle gaps, not a production failure:

- Persisted bookmark URLs can remain correct during the two-second write
  debounce while the newly mounted native and logical URLs are already wrong.
  A 500 ms quiet observation alone could accept that state.
- Converting logical records to dictionaries erased their order and silently
  collapsed duplicate bookmark identities.

The recorded real URLs were correct, so the bounded non-reproduction result
stands. The current oracle now rejects both gaps on **every poll**, without an
extra two-second sleep: URL expectations come from the pre-mount bookmark tree,
and ordered bookmark-ID lists are compared before constructing lookup maps.
The previous bookmark, native order/group, identity and highlight checks remain.

`test/test_mount_oracle.py` runs the actual browser-check assertion against
minimal valid snapshots. Its positive controls include saved blank/HTTP mounts
and regenerated logical IDs. Single-property negative cases cover wrong native
URL, wrong logical URL, stale pre-mount logical URL versus the authoritative
bookmark, reordered records, and a duplicate unrelated bookmark with a distinct
logical ID. Each negative starts with a passing snapshot and checks the intended
assertion reason, not an unrelated malformed-fixture error. Two virtual-clock
cases reuse `SimulatedMovement` to check rejection before a two-second bookmark
write and URL corruption on a later poll within the normal quiet interval.

Red/green proof:

- With only the new deterministic tests added to `f49b307`, **9 tests ran: 2
  positive controls passed and 7 negative tests failed with `AssertionError not
  raised`**. The old oracle accepted exactly the corrupted states under test.
- After strengthening the oracle, discovery ran **17 tests, all passing**: the
  same 9 oracle tests plus all 8 existing observer/settling tests.
- The existing CI helper step now discovers `test_*.py`, including all three
  unittest modules rather than only `test_movement_*.py`.
- All **9 actual mounting flows passed once** with the stricter assertions in
  `mounting-evidence-lj3ofi7b`. Source and shared movement/PR40 scripts are
  unchanged; their browser suites were not repeated for this correction.

The correction touches the oracle, its deterministic tests, CI discovery and
this report. It makes no production changes and does not close PR27.

### PR77 review correction: preserve persisted folder names and colors

Cubic's review of published head `42c9f93` identified that `structure()` omitted
all bookmark titles, so a saved folder name/color rewrite could pass even while
native and in-memory group metadata remained correct. Actual Chrome evidence
shows folder nodes without `url` and tab bookmarks with `url`; the repository's
Node mock additionally gives URL-bearing tabs `children: []`. The oracle now
compares titles for nodes **without `url`**, preserving empty-folder metadata
while still allowing navigation-sensitive tab-title updates in either shape.

Three new unittest methods cover group-name/color mutations, an empty saved
folder title mutation, and allowed tab-title updates with/without `children`.
Each negative mutates only persisted title data after its complete fixture passes
the actual mount oracle, leaving native/session group metadata intact.

- Red: with the new tests but the old oracle, **12 oracle tests ran with 3
  expected failures**: the empty-folder case and both group-name/color subcases
  reported `AssertionError not raised`. The tab-title positive control and all
  nine previous oracle tests passed.
- Green: unchanged CI discovery (`test_*.py`) ran **20 tests, all passing**:
  12 oracle tests plus 8 observer/settling tests.
- All **9 real Chromium mounting flows passed once** with folder-title
  preservation enabled, in `mounting-evidence-w0i4bim_`.
- Production source, CI and shared movement/active harnesses remain unchanged;
  no extra browser suites or arbitrary waits were added.

The controller reported exact-head PR77 CI success for published `42c9f93`.
The follow-up above is locally verified; its publication and CI remain with the
controller. No GitHub operation was performed during this correction.

## Verification changes and checks

`verify_mount_logical_tabs.py` subclasses `MovementCheck`, reusing its snapshot,
bookmark traversal, polling, public-message, fixture and event helpers. The
existing runner accepts the check class, flow list, fixture names and evidence
prefix; default movement behavior is preserved. Evidence hashes the concrete
check script as well as both shared helper scripts and every extension file.
The existing CI workflow runs the new check with the same pinned runtime and
artifact upload, without a second workflow or framework.

Location placeholders replace machine-specific paths following the matching
CodeRabbit/Cubic portability findings:

- `WORKTREE`: the isolated repository checkout described above.
- `ARTIFACTS_DIR`: an existing evidence/profile parent outside the checkout.
- `BROWSER_CACHE_DIR`: the installed Playwright browser cache; recorded runs used
  the cache basename `pr40-playwright` with Playwright 1.59.0.

Commands run across the initial milestone and corrections are shown below with
portable locations. Run from `WORKTREE`, setting the PowerShell variables
`$ARTIFACTS_DIR` and `$BROWSER_CACHE_DIR` to the corresponding local directories.

```powershell
node test/test_move_logical_tabs.js
node test/test_move_group_feedback.js
node test/test_active_tab_sync.js
node test/test_switch_session.js
node test/test_add_new_tab.js
node test/test_history_switch.js
node test/test_sidebar_quick_drag.js
python -B -m unittest discover -s test -p 'test_movement_*.py'
python -B test/test_mount_oracle.py -v # Red phases: 7 URL/order failures, later 3 folder-title failures
python -B -m unittest discover -s test -p 'test_*.py' -v # Green phases: 17, then 20 passing tests
$env:PLAYWRIGHT_BROWSERS_PATH=$BROWSER_CACHE_DIR
python -B test/verify_mount_logical_tabs.py --headless --flow root_after_active_group --artifacts-dir "$ARTIFACTS_DIR"
python -B test/verify_mount_logical_tabs.py --headless --flow saved_group_after_active_group --artifacts-dir "$ARTIFACTS_DIR"
python -B test/verify_mount_logical_tabs.py --headless --artifacts-dir "$ARTIFACTS_DIR"
python -B test/verify_move_logical_tabs.py --headless --artifacts-dir "$ARTIFACTS_DIR"
python -B test/verify_active_tab_reload.py --headless --artifacts-dir "$ARTIFACTS_DIR"
git diff --check
```

- At the initial coverage milestone, all seven Node baseline scripts passed.
  Expected injected failure diagnostics and pre-existing module-type warnings
  remained visible. These unchanged suites were not rerun for the fixture correction.
- Eight movement-observer/settling Python tests passed at the initial milestone
  and with the oracle tests during both corrections (17 total, then 20).
- All nine mounting flows pass after the latest folder-title correction. The edge-fixture correction followed two
  passing targeted edge checks. An earlier seven-flow run also passed; the old
  nine-flow run's two nominal edge checks are superseded by the correction above.
- All ten existing browser movement flows passed at the initial milestone: `group_in`, `group_out`,
  `forward`, `backward`, `saved_destination`, `saved_destination_grouped`,
  `group_entry_leading`, `group_entry_trailing`, `group_entry_mixed`,
  `root_boundaries`.
- All three active-state flows passed at the initial milestone: `cold_worker`, `extension_reload`,
  `session_switch` (including saved selection and history assertions).

Runtime: Windows, Node `24.12.0`, Python `3.13.12`, Playwright `1.59.0`, full
headless Chromium `147.0.7727.15`. The unpacked extension is the worktree's `src`
with its original manifest. Runtime extension ID:
`lbikljdgodiakenmajcfidkkenhjegdi`. Profiles are fresh and removed after use.

## Evidence and fingerprints

Evidence parent: `ARTIFACTS_DIR`. The recorded subdirectory basenames below are
retained verbatim, along with their hashes, runtime and observed outcomes.

| Directory | Contents |
| --- | --- |
| `mounting-evidence-p1i1vlmu` | Initial seven-flow non-reproduction, earlier test-script hashes. |
| `mounting-evidence-ih_ujaqz` | Historical nine-flow run; its two claimed edge cases did not establish adjacency and are superseded. |
| `mounting-evidence-fk97tvyq` | Corrected targeted `root_after_active_group`, including settled setup and explicit boundary proof. |
| `mounting-evidence-4k0nh6eh` | Corrected targeted `saved_group_after_active_group`, including settled setup and explicit boundary proof. |
| `mounting-evidence-z7p28pse` | Nine-flow run after edge correction, before the stricter URL/order oracle. |
| `mounting-evidence-lj3ofi7b` | Nine-flow run with URL/order assertions, before folder-title preservation. |
| `mounting-evidence-w0i4bim_` | Current nine-flow run including folder-title preservation; snapshots, events, screenshots and exact source/script hashes. |
| `movement-evidence-z823_zj2` | Ten movement flows using the shared runner adjustment. |
| `pr40-evidence-1wst6qod` | Three active-state flows on the identical production source. |

Final tested byte SHA256 values (all source file hashes are in the evidence):

```text
src/background.js
9d632f1c181d37a1dcb76723f39e7d73ef6cede37a22f3aad97278cad2944df1
test/verify_mount_logical_tabs.py
42a169695b52098367961f5c32266d6fbcc722b0ddec0c1b18d532baaed331f5
test/verify_move_logical_tabs.py
d72edaa52c90b65ab61bdfc1755309b5024f65a249856ee6203d91646360f29b
test/verify_active_tab_reload.py
b24cd3861190979d717a4cf6153e99d3c5c7882a8ea39f5c14107850d07a817e
```

## Context needed to continue

Current main already satisfies PR27's intended outcome **for these tested
arrangements**. To justify production changes, obtain an exact failing starting
layout (bookmark order, saved/live status, logical/native group membership,
active tab), action sequence and browser/version. A before/after native tab query
and canonical bookmark tree would distinguish sticky insertion, group relocation
and subsequent bookmark feedback.

These runs do not force create-event versus promise-fallback scheduling, delayed
native-event interleavings, pinned tabs, duplicate live copies, cross-window
movement or closure races. The grouped-removal defect and later milestones are
outside this investigation. Actual Ubuntu/GitHub Actions execution remains for
the controller. No runtime artifacts are stored in the repository.

Agentic stack: OpenCode with `openai/gpt-6-astra` (GPT-6); no additional agents.
