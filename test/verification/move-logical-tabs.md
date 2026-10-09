# Same-window logical tab movement: PR38 + PR75 consolidation

## Intent and provenance

Base: `2337fb152ea4e95b28ae48233dbb0ffe995b5546` (PR40 squash, fetched from
`origin/main` before creating the consolidation worktree).

- PR38, `4bc9365dc2f7dbba78ff2f2f098b0892b0d93d4d`: resolve moved tabs by stable
  bookmark identity, and pass the refreshed session to live grouping. Original
  work by google-labs-jules[bot] and Stephen L.; its `test/repro_issue.js` assumed
  obsolete `Window 100` naming. The replacement is `test/test_move_logical_tabs.js`,
  with deterministic setup and assertions of actual state, IDs, and order.
- PR75, `927779891b9ef752ea76b8b6eb3b1d7ccf75d353`: same identity correction for
  native reordering, by google-labs-jules[bot] with lrq3000 attribution. That patch
  still passed the old session to grouping and had no regression test.
- Only their movement intent was reconstructed on current main; no old histories
  or unrelated tests were imported. Authorship is acknowledged in the fix commit.

## Root causes and fix

`reloadSessionAndPreserveState` reconstructs logical IDs while retaining bookmark
and mounted tab identities. Looking up the UI's old logical IDs in that new
snapshot silently skipped grouping, ungrouping, and native ordering.

The handler now indexes the input logical IDs, collects stable bookmark IDs in a
Set, and filters the refreshed session once. Both grouping and native ordering use
those refreshed nodes; grouping receives the refreshed session as well.

Actual Chromium testing exposed two coupled ordering errors:

1. Incrementing the original bookmark insertion index splits a forward selection
   because earlier removals shift the destination. Insert selected bookmarks in
   reverse order and reuse each returned bookmark index as the next boundary.
2. Native tabs use a final destination index, unlike bookmarks' pre-removal index.
   Move tabs individually in reverse selection order after the same anchor, query
   current indices each time, and subtract the removal-before-anchor displacement.
   This also handles noncontiguous and reversed selections without relying on
   array-move placement semantics. Overshooting the anchor could otherwise move
   tabs beyond the native group and cause listeners to ungroup their bookmarks.

Reload preservation, quick-drag behavior, and Live Only deletion logic are used
unchanged. The quality-review correction below narrows programmatic native-event
feedback during movement. No production test hooks were added.

## Regression commands

Run from this checkout with Node and Python Playwright 1.59 / bundled Chromium:

```text
node test/test_move_logical_tabs.js
node test/test_move_group_feedback.js
node test/test_active_tab_sync.js
node test/test_switch_session.js
node test/test_add_new_tab.js
node test/test_history_switch.js
node test/test_sidebar_quick_drag.js
python test/verify_move_logical_tabs.py --artifacts-dir <existing-temporary-directory>
python test/verify_active_tab_reload.py --artifacts-dir <existing-temporary-directory>
git diff --check
```

The browser script loads `src` directly. Its portable default artifact parent is
the OS temporary directory. `--flow group_in`, `group_out`, `forward`, `backward`,
`saved_destination`, `saved_destination_grouped`, `group_entry_leading`,
`group_entry_trailing`, or `group_entry_mixed` selects one flow. Every flow
gets a disposable headed Chromium profile, a loopback
HTTP fixture, and only this unpacked extension. It uses real extension messages
and native APIs, with no API mocks. JSON evidence contains request/response state,
native tab IDs/group IDs/order, bookmark trees, timestamped native/bookmark events,
immediate and settled snapshots, console errors, Chromium version,
extension ID, and SHA256 of every extension source file. Screenshots are captured
after movement; profiles are removed at exit.

For the recorded Windows run, PowerShell environment variables were:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="C:\Users\33632\AppData\Local\Temp\opencode\pr40-playwright"
$env:PYTHONDONTWRITEBYTECODE="1"
python test/verify_move_logical_tabs.py --artifacts-dir "C:\Users\33632\AppData\Local\Temp\opencode"
```

## Recorded red/green evidence

Evidence parent: `C:\Users\33632\AppData\Local\Temp\opencode`.
Runtime extension ID: `hljoodiifakocogpbpjgccalblgnkgdc` (discovered, not hardcoded).
Chromium: `147.0.7727.15`.

| Run | Evidence directory | Result |
| --- | --- | --- |
| Unmodified main, before production edits | `movement-evidence-_b_kb7uh` | All four flows fail at product assertions: A remains ungrouped; C remains grouped; forward bookmarks become C,D,A,E,B instead of C,D,A,B,E; backward native order stays A,B,C,D,E. |
| Identity-only intermediate fix | `movement-evidence-h2v7fnjn` | Ungroup/backward pass; grouping/forward still expose insertion-index errors. |
| Consolidated fix | `movement-evidence-8rkkndqd` | All four flows pass, including repeated selections with current IDs and real sidebar active highlight. |
| Expanded forward coverage | `movement-evidence-gvu54won` | Five moves pass: forward, reversed input, mixed saved-only/live selection, saved-only movement, and noncontiguous native selection. |
| Grouping plus Live Only deletion | `movement-evidence-_f3tsvp2` | Two group moves pass; deletion then removes only mounted A/B/C while preserving saved-only D, its group folder, and outside E. |

Background SHA256:

- Main: `c0901bc7abe1bfab7cd59721251ac525e49ca56a94f5dae76c6f2981f14af962`
- Initial consolidation (before quality-review correction): `e65d57a6bccbcc74895e61a9e619f02e427f5a65d2442c1a394dd3b8c0f56223`
- After saved-only destination correction: `346004910e01d1fc4b4ad05feded204084ecd09b035507fbde4d9079a63e043a`
- After batched-group insertion correction: `45ee0acb0b8fed3c8214b2c92284dec06f76a3982dba46640222410ff4f081ee`

The Node movement regression also failed before production edits and passed after
the fix. Its local adapters provide deterministic IDs and actual in-memory group
and order changes. The shared mock's bookmark indexing differs from Chromium;
the local adapter corrects that difference. Browser evidence is the authority for
native index semantics and event feedback. The five existing Node suites pass
before and after the production change. Node emits its pre-existing
`MODULE_TYPELESS_PACKAGE_JSON` warning; package configuration was not changed.

## Quality-review correction: saved-only destination feedback

The earlier browser fixture only targeted an already-live group. At reviewed head
`889768ec48a22c694f026081d6fbc18baba3ddf2`, the added `saved_destination` flow
reproduced the reported regression in real Chromium before production changes:

- Initial bookmarks: A,B,C,G(S saved-only),D; native fixture tabs: A,B,C,D.
- Send public `MOVE_LOGICAL_TABS` for A/B inside G.
- Expected: bookmarks C,G(S,A,B),D and native C,[A,B in G],D.
- Actual after 2.5 seconds: bookmarks C,G(S,A),D,B and native C,[A in G],B,D.
  The handler had returned success. The extension-page bridge is also present in
  the raw trees/native arrays; the sequences above describe only fixture tabs.
- Event evidence records B joining the newly created group, then becoming
  ungrouped during its separate relocation. Its bookmark is moved to the root
  about 118 ms later by the inherited delayed group-change listener.

The correction relocates the selected live tabs first, then assigns their final
group membership from the refreshed session. This prevents creating and then
splitting a new destination group at the old native position. A scoped Set of
selected native tab IDs also prevents intermediate move/group events from
rewriting bookmarks, including when the selected tabs started in another group.
Move events are classified at receipt, before the move mutex can defer them past
the end of synchronization. The Set replaces the previous consumable/timed move
suppression and is cleared in `finally`, including failed native moves. Title/URL
updates and later genuine native events still use their normal listeners.

| Run | Evidence directory | Result |
| --- | --- | --- |
| Reviewed head, before correction | `movement-evidence-a0aoch24` | Saved-only destination fails with settled logical group B missing, matching the native and bookmark event trace. |
| Corrected source | `movement-evidence-c28yr_h2` | Existing four flows and saved-only destination pass, including Live Only deletion and active highlight. |
| Grouped source | `movement-evidence-vtto0n0z` | Previously grouped A/B move into the saved-only destination; a repeated partial move out also passes after 2.5-second settling. |
| PR40 preservation | `pr40-evidence-29sqb6gs` | Cold worker, full extension reload, and session switch all pass. |

`test_move_group_feedback.js` independently reproduced the settled bookmark-order
failure before the correction. Its focused event model invokes the real message
handler and delayed group-change listener. It now passes for ungrouped input,
grouped input with native moves deliberately delayed 150 ms (longer than the
100 ms callback), and an injected native move failure followed by genuine native
group/move changes. The failure case intentionally emits the production warning;
the subsequent assertions verify both feedback guards were released.

All seven focused Node scripts pass. Browser runs in this correction completed
without timeout. The movement harness now emits progress and schedules a timed
Python stack dump per flow so future hangs can be diagnosed before external
command termination. Failed native moves still use the existing warning/success
response contract; retry/rollback or concurrent external edits are outside scope.

## Quality-review correction: first-member insertion order

The added `group_entry_leading` browser flow reproduced the second review finding
on `7d25c2f3262c97f8b3ce7a5c5ed843df3c69719e`, before production edits:

- Initial fixture order: X,G(C,D),A,B, with A/B ungrouped.
- Public move: select A/B and insert before C.
- Desired logical/bookmark and native order: X,G(A,B,C,D).
- Settled native result after 2.5 seconds: X,G(B,A,C,D), despite correct logical
  order and a successful response. The native event trace shows both relocation
  moves, followed by an extra move of A across B during the first grouping call.

Adding individual tabs to an existing group can itself move them to the group
boundary. The handler now collects native IDs per destination logical group in a
Map and submits each block through one `chrome.tabs.group` call after relocation.
The batched helper shares the existing lookup/creation/title/color/error logic;
the single-tab helper delegates to it with a one-element array so other callers
keep their contract. Ungrouping is likewise submitted as one destination batch.
No additional individual moves occur after grouping, and the scoped feedback
guard and `finally` cleanup remain intact.

The Node movement mock now models group-induced boundary relocation and automatic
group membership between two existing members. Its new leading-insertion case
failed with the same A/B reversal before the fix and passes afterward. Native API
behavior is independently checked by Chromium, including leading/trailing entry
and mixed already-grouped/new members. Active-tab assertions now support a fixture
whose first/active tab is X rather than A.

| Run | Evidence directory | Result |
| --- | --- | --- |
| Reviewed head, before batching | `movement-evidence-j27p7q8l` | Leading insertion fails: expected X,A,B,C,D; actual X,B,A,C,D. |
| Batched grouping | `movement-evidence-qaj57wjo` | All nine movement flows pass, including saved-only/grouped-source cases, leading/trailing insertion, mixed membership, active highlight, and Live Only deletion. |
| Shared-helper preservation | `pr40-evidence-pdo1bk9p` | Cold worker, extension reload, and session switch pass after the helper change. |

All seven focused Node scripts pass (14 operations in the movement script). The
approved browser cache was absent at the start of this round; it was restored with
`python -m playwright install chromium --no-shell` under the existing approved
temporary parent, yielding the same Chromium 147.0.7727.15. The initial missing-
executable launch failure is not counted as a product regression. Subsequent
browser runs completed without timeout.

## Complexity and scope

New/changed selection bookkeeping is O(n + m + k) time and space for n logical
tabs, m selected bookmark nodes, and k moved live tabs. It makes O(m) bookmark
moves and O(k) native moves/queries, plus an O(n) backward anchor search. Existing
reload matching is still O(n²). The grouping helper scans native-group mappings
once per distinct destination group during movement; optimizing that existing
lookup is outside this consolidation.

Coverage is same-window tab movement through the production message handler.
Whole-group movement was not expanded: main's fallback only relocates the folder,
and adding descendant-native synchronization would introduce separate semantics.
Cross-window behavior remains for PR59. Pinned tabs, concurrent external moves,
multiple live copies of one logical tab, and OS-level drag gestures are not covered
by these regressions. Quick-drag caller checks and public movement-handler
regressions pass in Node; normal `onDrop` is not directly exercised.

The PR40 browser harness is imported unchanged for polling/messages/sidebar setup.
Its active-reload suite was rerun after the quality-review listener changes and
passed; the movement flows also assert active identity and the rendered active
highlight after every move.
