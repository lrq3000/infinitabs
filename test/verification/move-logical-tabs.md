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

Existing reload preservation, native listeners, quick-drag behavior, and Live Only
deletion logic are used unchanged. No production test hooks were added.

## Regression commands

Run from this checkout with Node and Python Playwright 1.59 / bundled Chromium:

```text
node test/test_move_logical_tabs.js
node test/test_active_tab_sync.js
node test/test_switch_session.js
node test/test_add_new_tab.js
node test/test_history_switch.js
node test/test_sidebar_quick_drag.js
python test/verify_move_logical_tabs.py --artifacts-dir <existing-temporary-directory>
git diff --check
```

The browser script loads `src` directly. Its portable default artifact parent is
the OS temporary directory. `--flow group_in`, `group_out`, `forward`, or `backward`
selects one flow. Every flow gets a disposable headed Chromium profile, a loopback
HTTP fixture, and only this unpacked extension. It uses real extension messages
and native APIs, with no API mocks. JSON evidence contains request/response state,
native tab IDs/group IDs/order, bookmark trees, console errors, Chromium version,
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
- Fixed: `e65d57a6bccbcc74895e61a9e619f02e427f5a65d2442c1a394dd3b8c0f56223`

The Node movement regression also failed before production edits and passed after
the fix. Its local adapters provide deterministic IDs and actual in-memory group
and order changes. The shared mock's bookmark indexing differs from Chromium;
the local adapter corrects that difference. Browser evidence is the authority for
native index semantics and event feedback. The five existing Node suites pass
before and after the production change. Node emits its pre-existing
`MODULE_TYPELESS_PACKAGE_JSON` warning; package configuration was not changed.

## Complexity and scope

New/changed selection bookkeeping is O(n + m + k) time and space for n logical
tabs, m selected bookmark nodes, and k moved live tabs. It makes O(m) bookmark
moves and O(k) native moves/queries, plus an O(n) backward anchor search. Existing
reload matching is still O(n²), and the existing grouping helper scans group
mappings per live tab; those broader optimizations are outside this consolidation.

Coverage is same-window tab movement through the production message handler.
Whole-group movement was not expanded: main's fallback only relocates the folder,
and adding descendant-native synchronization would introduce separate semantics.
Cross-window behavior remains for PR59. Pinned tabs, concurrent external moves,
multiple live copies of one logical tab, and OS-level drag gestures are not covered
by these regressions. Existing quick-drag/normal-drop caller checks pass in Node.

The PR40 browser harness is imported unchanged for polling/messages/sidebar setup.
Its active-reload suite was not repeated because shared helpers and active-reload
logic were not edited; the movement flows independently assert active identity and
the rendered active highlight after every move.
