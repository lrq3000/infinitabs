# PR27 mounting investigation: NEEDS_CONTEXT

## Pinned inputs and decision

- Owned worktree: `C:\git\infinitabs\.worktrees\integrate-pr27-backlog`.
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
group-edge fixtures corrected after controller/spec review. The user decision is
to merge coverage only and keep PR27 open; publication remains with the controller.
Following the task's reproduction gate, this branch contains verification only,
not a mounting fix or
a claim that every historical PR27 scenario is resolved. No failing Node model
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
In the final full run, setup quiet periods were 524 ms (root) and 526 ms
(saved group); post-mount quiet periods were 511 ms and 518 ms respectively.
Both targets mounted at index 2, preserving the active group's identity and
metadata; the root target remained ungrouped and the saved-group target acquired
its own restored group. Both targeted reruns passed first, then all nine passed.

Only the mounting script and this report changed for the correction. The shared
runner, other seven case assertions, CI and production code are unchanged, so
their earlier preservation checks below remain applicable.

## Verification changes and checks

`verify_mount_logical_tabs.py` subclasses `MovementCheck`, reusing its snapshot,
bookmark traversal, polling, public-message, fixture and event helpers. The
existing runner accepts the check class, flow list, fixture names and evidence
prefix; default movement behavior is preserved. Evidence hashes the concrete
check script as well as both shared helper scripts and every extension file.
The existing CI workflow runs the new check with the same pinned runtime and
artifact upload, without a second workflow or framework.

Commands run from the owned worktree across the initial milestone and correction:

```powershell
node test/test_move_logical_tabs.js
node test/test_move_group_feedback.js
node test/test_active_tab_sync.js
node test/test_switch_session.js
node test/test_add_new_tab.js
node test/test_history_switch.js
node test/test_sidebar_quick_drag.js
python -B -m unittest discover -s test -p 'test_movement_*.py'
$env:PLAYWRIGHT_BROWSERS_PATH='C:\Users\33632\AppData\Local\Temp\opencode\pr40-playwright'
python -B test/verify_mount_logical_tabs.py --headless --flow root_after_active_group --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode
python -B test/verify_mount_logical_tabs.py --headless --flow saved_group_after_active_group --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode
python -B test/verify_mount_logical_tabs.py --headless --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode
python -B test/verify_move_logical_tabs.py --headless --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode
python -B test/verify_active_tab_reload.py --headless --artifacts-dir C:\Users\33632\AppData\Local\Temp\opencode
git diff --check
```

- At the initial coverage milestone, all seven Node baseline scripts passed.
  Expected injected failure diagnostics and pre-existing module-type warnings
  remained visible. These unchanged suites were not rerun for the fixture correction.
- Eight movement-observer/settling Python tests passed at the initial milestone.
- All nine mounting flows pass after the edge-fixture correction, following two
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

Evidence parent: `C:\Users\33632\AppData\Local\Temp\opencode`.

| Directory | Contents |
| --- | --- |
| `mounting-evidence-p1i1vlmu` | Initial seven-flow non-reproduction, earlier test-script hashes. |
| `mounting-evidence-ih_ujaqz` | Historical nine-flow run; its two claimed edge cases did not establish adjacency and are superseded. |
| `mounting-evidence-fk97tvyq` | Corrected targeted `root_after_active_group`, including settled setup and explicit boundary proof. |
| `mounting-evidence-4k0nh6eh` | Corrected targeted `saved_group_after_active_group`, including settled setup and explicit boundary proof. |
| `mounting-evidence-z7p28pse` | Final corrected nine-flow run; per-flow snapshots, events, screenshots, exact source/script hashes. |
| `movement-evidence-z823_zj2` | Ten movement flows using the shared runner adjustment. |
| `pr40-evidence-1wst6qod` | Three active-state flows on the identical production source. |

Final tested byte SHA256 values (all source file hashes are in the evidence):

```text
src/background.js
9d632f1c181d37a1dcb76723f39e7d73ef6cede37a22f3aad97278cad2944df1
test/verify_mount_logical_tabs.py
eceb31f7ce5494958233efbb2d4e72c530a33dd4c93744fdfbd8f75073ac55fe
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
