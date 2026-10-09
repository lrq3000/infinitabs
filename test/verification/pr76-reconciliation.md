# PR76 concurrent contribution reconciliation

## Pinned inputs and intent

- Main: `2337fb152ea4e95b28ae48233dbb0ffe995b5546`.
- Common feature ancestor: `5674c370897d094b485c7fd07a25d34091baf0c9`.
- Local parent: `c9d0da70565becd54cf06bc9f25230f750bfa47f`, including
  `11ac1ab0d6c36a083685c83607e1f3203eb237cc` (diagnostic) and `c9d0da7` (observer).
- Pinned other parent: `d0ff76788f6113101df03f4cb06ea52c8717c180`, including
  `af86429f8fc3a0fe5c7d35822c9cb0d5862e1aad` (late events/closures/CI) and
  `d0ff767` (ungrouped-fixture assertion correction).

All four full commit bodies and both complete patches were inspected before the
normal, non-rewriting merge. The pinned ref and remote-tracking ref both named
`d0ff767` at inspection; no fetch, publication, or other worktree mutation was
needed. The user authorized preserving both histories, not selecting one branch
as a replacement for the other.

## Independently reproduced failures

The pinned remote `test_move_group_feedback.js` was temporarily checked out into
this owned worktree and run against local `c9d0da7` production. A `finally` block
restored the local test. The test failed at six product assertions:

| Scenario | Expected | Local pre-merge result |
| --- | --- | --- |
| 4: feedback delivered after the response | C,S,A,B,D | C,A,S,B,D |
| 5: selected B closes during relocation | Native C,A,D | A,C,D |
| 6: anchor C closes during relocation | Native A,B,D | A,D,B |
| 7: B closes before final grouping | A remains grouped | A ungrouped |
| 8: immediate unrelated drag with old events queued | D,C,S,A,B | D,C,A,S,B |
| 9: immediate in-group reorder with old events queued | C,S,B,A,D | C,B,A,S,D |

The same nine scenarios, genuine post-failure native events, stale group payload
with an independent title update, and diagnostic assertion pass on the combined
source. This verifies deterministic event-order failures; it does not establish
their frequency in real Chromium. The ordinary native flows were also rerun in
the actual browser, as recorded below.

## Hunk checklist and semantic decisions

Ranges below identify the hunks in each contribution's diff from `5674c37`.
All intents are retained; no hunk was discarded as Not applicable.

| Origin / hunk | Disposition | Resolution |
| --- | --- | --- |
| Remote background, original line 266 | Applied | Keep `withSurvivingTabs`; retry only when live IDs provably shrink. |
| Remote background, lines 284 and 296 | Applied | Use shrinking batches for both new and existing native groups; exit cleanly if every selected tab closed. |
| Remote background, line 1378 | Applied | Validate group payload against current native membership; continue independent title/URL processing. |
| Remote background, line 1425 | Applied | Recheck the scoped guard inside the delayed ungroup callback. |
| Remote background, line 1585 | Applied | Reconcile current native order and parent against logical order, locally within a native group, before importing late movement. |
| Remote background, line 1599 | Applied | Constrain grouped anchors to the actual native parent. |
| Remote background, line 1622 | Applied | Place a leading member before the next mounted member, preserving preceding saved-only children. |
| Remote background, line 2338 | Applied | Retain ordered anchor candidates for closure fallback. |
| Remote background, line 2360 | Applied | Filter departed tabs, continue per-tab failures, and repeat relocation only after participant disappearance. |
| Remote background, line 2388 | Applied | Filter final group batches to surviving IDs. |
| Remote background line 2401 + local background line 2402 | Applied with adaptation | Keep shrinking-batch ungrouping and the local warning text, affected IDs, and error. The warning/success response contract remains. |
| Remote group-feedback test, lines 10/25/37/55 | Applied | Keep event deferral/flush and before-move/before-group hooks. |
| Remote group-feedback test, lines 67/83/100 | Applied | Keep snapshot/get/query/closure adapters and nine deterministic fixtures. |
| Remote group-feedback test, lines 120/134/158 | Applied | Keep all late-event, immediate-drag, closure, failure-cleanup, title-update, and diagnostic assertions. |
| Both browser helper imports and extraction | Applied with adaptation | One implementation, `observe_expected_state`, retains the local records/deadline/minimum observation and the remote missing-key tolerance. No parallel waiter remains. |
| Local browser removal events, bookmark traversal, snapshot hunks | Applied | Keep direct persisted-parent/order checks, removal events, and one session snapshot per poll. |
| Both Live Only deletion call/assertion hunks | Applied with adaptation | Use the single observer and local evidence/tree checks, retaining the remote assertion that no native group remains. Duplicate native-closure checks are represented once. |
| Both movement caller and assertion-extraction hunks | Applied with adaptation | Keep recorded first/last snapshots and failure screenshots; both validators' identity/order/active assertions remain in one method. |
| Remote conditional group-ID correction (`d0ff767`) + local group-ID hunk | Applied with adaptation | Local `getattr(..., None)` safely handles ungrouped fixtures and new-group discovery without mutation during polling. |
| Both long-observation call-site hunks | Applied with adaptation | Default quiet period is 500 ms. Explicit 2500 ms cases require both that minimum observation and 2500 ms uninterrupted quiet, preserving the stronger remote condition. Deadline stays 15 seconds. |
| Local `test_movement_observer.py` | Applied with adaptation | Preserve all four tests; generalize its virtual-clock fixture for state timelines shared by both test modules. |
| Remote `test_movement_settling.py` | Applied with adaptation | Preserve all four tests and their unique slow-convergence/snapshot-reset assertions; delegate to the shared fixture and single observer, adapting timeout-evidence field names. |
| Remote movement and PR40 `--headless`/launch hunks | Applied | Keep full Chromium channel support and portable headed defaults. |
| Remote CI workflow | Applied with adaptation | Keep pinned actions, least privilege, Node/browser jobs, and artifacts; discover both settling test files (eight assertions). |
| Local and remote verification-document hunks | Applied with adaptation | Preserve both historical evidence narratives, label their historical context, and link this current reconciliation audit. |

Browser evidence now additionally hashes the executed test scripts, so final Git
blob hashes can be compared with the tested source and harness without rerunning
the browser solely to change a commit label.

The remote contribution deliberately extends closure handling: a rejected native
batch is retried only after the input shrinks, and a relocation pass repeats only
after a relevant tab disappears. This is bounded by participant loss, not a
general retry policy. Other errors keep the best-effort warning/success contract.

## Combined verification

Executed in the owned worktree:

```text
python -m unittest discover -s test -p 'test_movement_*.py'
node test/test_move_group_feedback.js
node test/test_move_logical_tabs.js
node test/test_active_tab_sync.js
node test/test_switch_session.js
node test/test_add_new_tab.js
node test/test_history_switch.js
node test/test_sidebar_quick_drag.js
python test/verify_move_logical_tabs.py --headless --artifacts-dir <approved-temp-parent>
python test/verify_active_tab_reload.py --headless --artifacts-dir <approved-temp-parent>
git diff --check
```

- Eight virtual-clock tests pass; all seven Node scripts pass, including all nine
  feedback scenarios and 14 movement operations. Expected injected warnings and
  the pre-existing Node module-type warning remain visible.
- All nine real Chromium movement flows and all three PR40 flows pass in full
  Chromium headless mode. No command timeout occurred. PR40 was launched with a
  60-second `faulthandler` diagnostic wrapper; the movement runner has its own.
- Workflow YAML parses and its read-only permissions, Ubuntu runner, and
  15-minute job limit were checked. CI discovers both test modules and runs the
  same browser commands above. Actual Ubuntu/Node 22 Actions execution is left to
  the controller; local validation used Windows, Node 24.12.0, Python 3.13.12,
  Playwright 1.59, and Chromium 147.0.7727.15.

Evidence parent: `C:\Users\33632\AppData\Local\Temp\opencode`.

| Directory | Evidence |
| --- | --- |
| `movement-evidence-49ugi1nc` | Nine merged-source movement flows, snapshots, events, extension and test hashes; `headless: true`. |
| `pr40-evidence-gey5854i` | Cold worker, extension reload, and session switch on the same merged background hash. |

Extension ID: `hljoodiifakocogpbpjgccalblgnkgdc`.

SHA256 fingerprints:

```text
src/background.js
aabe0cafdefe0fbb198d421278f38837d9edd4417d89e46f3b10d4911271d10d
test/verify_move_logical_tabs.py
5f8397c0cb8dbd8289d28698780bc311f1ba6ae0070979cb16511d994f46c02c
test/verify_active_tab_reload.py
b24cd3861190979d717a4cf6153e99d3c5c7882a8ea39f5c14107850d07a817e
```

Remaining limits: arbitrary cross-window/pinned/whole-group semantics and multiple
live copies remain outside this milestone. Deterministic tests control the late
event and closure interleavings; the browser tests use real APIs without forcing
Chrome's callback scheduling. Finite quiet observation is not a promise that no
arbitrarily late event can occur. No important regression was found in the
requested combined scope.
