# Group lifecycle consolidation: approved scope and verification

## Implementation plan and policy

Base: `0780c87aa61e82d9732cf10aafd0abc5cf40acca` (PR40 fix, PR76 movement,
PR77 mounting coverage). The controller owns publication/review/merge/closure.

1. Reproduce folder creation/reuse through actual background listeners and an
   isolated native group/background-link flow. Keep the existing regression files.
2. Share pending group resolution across native creation, grouped-tab creation,
   group updates and startup. Serialize lookup/binding/creation; keep the lock
   through completion. Existing groups skip the rename delay; cold-start move
   handlers must await initialization outside that queue.
3. Implement approved **Option 2**: reuse exactly one unmapped same-name/color
   folder even with different contents or no children. Multiple eligible folders
   mean creation. Preserve saved identities, contents and relative order.
4. Persist/attach new-tab history before the rename delay, catch up early native
   URL/title/pendingUrl, and recheck liveness/membership after asynchronous work.
5. Commit the verified creation/reuse milestone locally; then reproduce and fix
   the inherited removal classifier in a separate regression/production commit.
   Run the existing read-only CI checks and exact-source browser observer.

## Source intent and attribution

Ported intent, not merged old branches:

- PR31 head `6a4076bb2bebed0de625464fadfe1ee1a1ecbf9a`: long Amazon.fr title,
  background-link creation, single serialized lookup/create, mapped-folder
  exclusion and unambiguous reuse. Original contribution by
  `google-labs-jules[bot]` (`8b00679`), refinements by Stephen L. (`e98c331`,
  `6a4076b`). Its replacement/deletion of earlier reproduction files is not ported.
- PR28 head `26118d6e33514d20c2e9c1ac3012e14ed535efb9`: restored native groups
  reuse saved folder identity, title/color normalization, ambiguous matches create
  separately. Original contribution by `google-labs-jules[bot]` (`ab86cf0`),
  refinements by Stephen L. (`d015565`, `26118d6`). The pre-mutex duplicate create
  removed by these heads is already absent on the base.
- `test_group_folder_resolution.js` preserves these unique test intentions with
  hard failures and stable folder/tab assertions. `test/reproduce_issue.js`,
  `test/reproduce_group_issue.js` and every unrelated base regression are retained.

## Complexity and boundaries

`liveGroupToBookmark` remains the primary identity map; `pendingGroupCreations`
remains the in-flight lock. A known mapped group returns before debounce or
metadata lookup. Known-group new tabs and group updates bypass resolution when
already placed correctly. **No maintained secondary name/color/URL/reverse index,
native membership cache, invalidation listener or ordinary-tab index upkeep was
added.** The root metadata scan and bound-folder `Set` exist only during actual
unmapped resolution: O(R + B) extension-side scanning, O(B) temporary space.
The API returns root entries, not candidate child contents. Group creation retains
the existing native-placement work. Session reload remains a distinct cost.

Explanation only: `reloadSessionAndPreserveState` still does a nested `find` for
old/new logical tabs (O(N²)). A temporary bookmark-ID map could make that join
O(N), with O(N) space, without any maintained cache. That production optimization
is deliberately outside this approved milestone.

## Reproduction and commands

Run in `WORKTREE` (the owned worktree). `ARTIFACTS_DIR` is an existing external
temporary directory; `BROWSER_CACHE_DIR` contains the approved full Chromium for
Python Playwright 1.59.0. No crx build/install or personal browser is involved.

```powershell
node test/test_group_folder_resolution.js
node test/test_group_removal_classification.js
$env:PLAYWRIGHT_BROWSERS_PATH = 'BROWSER_CACHE_DIR'
python test/verify_group_lifecycle.py --headless --artifacts-dir 'ARTIFACTS_DIR'
python -m unittest discover -s test -p 'test_*.py'
python test/verify_move_logical_tabs.py --headless --artifacts-dir 'ARTIFACTS_DIR'
python test/verify_mount_logical_tabs.py --headless --artifacts-dir 'ARTIFACTS_DIR'
python test/verify_active_tab_reload.py --headless --artifacts-dir 'ARTIFACTS_DIR'
```

The seven pre-existing Node scripts remain in `.github/workflows/movement-regressions.yml`;
new checks extend that same read-only workflow and reuse its observer/runner.

Baseline red evidence: `test_group_folder_resolution.js` failed nine cases on
`0780c87`, including startup reuse, three folders for one native group, early lock
release, long/empty/normalized folder reuse, disappearance and pending URL loss.
The real `metadata_recreation` flow failed with three same-title folders. Subsequent
focused tests exposed an early reload URL/title gap and stale group feedback;
each failed before its corresponding repair.

`verify_group_lifecycle.py` uses real `chrome.tabs.group`, `tabGroups.update`,
bookmarks and a real middle-click background link. The browser itself assigns the
new tab's group. Native/logical membership, saved history, identity, long title,
colors and final bookmark URLs must agree. Every assertion remains event/state
quiet for **1500ms**, with at least **2500ms** observation, beyond the 1000ms rename
debounce. The base observer also captures snapshots, native events, console errors,
screenshots, full source hashes, test-script hashes, browser version and extension ID.

Metadata recreation tests use real native creation against saved folders (including
different contents); they do not claim to automate the browser's Ctrl+Shift+T UI.
Exact held API scheduling, failure injection, disappearance and startup concurrency
are deterministic Node models using actual production listeners, not browser proof
of that exact schedule. Browser profiles/evidence stay under `ARTIFACTS_DIR`.

## Inherited removal classifier: separately committed fix

The unchanged base removal handler was reproduced before this fix (on the
creation/reuse commit `f78eb98`). Both the Node listener model and real Chromium
lost G when `MOVE_LOGICAL_TABS` had already logically assigned A/B to G(S,C), but
A/B remained natively ungrouped and C, the last native member, closed.

The classifier now captures unowned logical live IDs at event receipt, reads
actual native tabs once, and only interprets surviving **ungrouped** candidates
as Ungroup. Dead IDs, tabs already transferred to another native group and
operation-owned A/B do not qualify. The primary binding is removed for the old
group; a still-alive native group or a new binding to the saved folder protects
that folder. Empty logical groups retain the existing LiveOnly preservation rule.

The same existing `syncingLiveTabIds` guard now begins **before logical bookmark
writes**, and releases in `finally` after the logical/native move phase. A focused
test proved why this boundary matters: closing C during the first native tab read
still flattened G if ownership only began afterward. No native-member index,
new persistent tracking or general transaction architecture is introduced.

Ten Node cases check the immediate/held/pre-native-read closure windows, normal
Close with reversed callback ordering, genuine Ungroup, LiveOnly saved/empty
folder preservation, stale removal of a still-alive group, native transfer, and
guard cleanup after a failed logical bookmark write. Existing movement tests
continue to cover native failure, late feedback, surviving/closing tabs and
immediate genuine native drags after a logical move.

The Chromium `removal_move_close` case uses an additive test-side native movement
observer to call `chrome.tabs.remove(C)` during the public move. It does not
replace any production API/listener. Evidence asserts A/B's native `groupId` was
still `-1`, C was in G at the trigger, and G's native removal actually occurred.
It failed before the classifier fix and passed afterward with the same saved
folder/children and a newly formed native group for A/B. Separate native Close,
Ungroup and LiveOnly cases also verify saved/native/logical structure.

Limits: native queries are asynchronous snapshots, not a maintained record of
every past native group membership. The classification is for the observed
current facts and existing operation ownership. Precisely held API reads and
the pre-native-read closure boundary remain modeled schedules; the actual
native-move closure ordering above was observed in Chromium.

## Initial local validation record (superseded by spec-review fixes below)

Production changes: `f78eb98` (creation/reuse) and `03d51f1` (classifier and full
operation ownership). All final runs below use identical production bytes,
Python Playwright **1.59.0**, full Chromium **147.0.7727.15**, headless disposable
profiles, and extension ID `dnemhhcolpnebjamkkefbdmmplgfeaif` for this worktree.

| Check | Result | Command runtime | Evidence under `ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| Seven existing + two new Node scripts; Python unittest discovery | 9 scripts; 20 Python tests passed (new scripts: 17 resolution + 10 classifier cases) | 40.9s combined | Console output; intentional injected-failure diagnostics retained |
| `verify_group_lifecycle.py` | 8 flows passed | 101.9s | `group-lifecycle-evidence-2qh_nb99` |
| `verify_move_logical_tabs.py` | 10 flows passed | 172.6s | `movement-evidence-svirheuu` |
| `verify_mount_logical_tabs.py` | 9 flows passed | 194.4s | `mounting-evidence-xh5ueshg` |
| `verify_active_tab_reload.py` | 3 flows passed | 8.2s | `pr40-evidence-mq0z8z1_` |

Browser failures before fixes:

- `group-lifecycle-evidence-awlrj2cu/metadata_recreation/evidence.json`: exact
  `0780c87` production; three same-title folders instead of one.
- `group-lifecycle-evidence-_uartjyt/removal_move_close/evidence.json`: creation
  milestone, unchanged inherited classifier; original saved folder deleted.

Each final browser directory contains `evidence.json` (per flow except the active
runner), screenshots, worker/page diagnostics, native event snapshots and source
fingerprints. Source/script SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `src/background.js` | `7230ff089247aa96624171d5f1de3c2d7116dca97aee71e6c1b46feac3631da6` |
| `test/verify_group_lifecycle.py` | `5f7ea2c35a403fbaa976d7022ae0cda54b059cec0bb9925723833b81359e3c07` |
| `test/verify_move_logical_tabs.py` | `7a86c5c16a5977eed197aa326dc2667c0ef3fd64dd65477f7563bd459bb18e27` |
| `test/verify_mount_logical_tabs.py` | `42a169695b52098367961f5c32266d6fbcc722b0ddec0c1b18d532baaed331f5` |
| `test/verify_active_tab_reload.py` | `cd980aced1f761b89ba2149c93bbdc26da121d6daf78a7e306153bcc7845685d` |

The full source-file fingerprint set is in the movement/mount/lifecycle evidence.
The inherited Node ESM package warning remains; injected failures intentionally
exercise existing console diagnostics. No browser page/worker errors occurred in
the final flows. `git diff --check` passed.

### Shared runner cleanup

Two earlier successful assertion runs exited on Windows `WinError 145` while
deleting a temporary `GPUCache`/`ShaderCache` after `context.close()`. The existing
runner now shares `ChromiumProfile`, a `TemporaryDirectory` subclass with at most
ten cleanup attempts (100ms apart), only for transient Windows errors 5/32/145.
Persistent/unrelated errors still fail. This only cleans the profile that the
runner itself allocated; it never enumerates or touches personal profiles. Final
runs above all exited zero, including cleanup. This test-infrastructure change is
separate from both production milestones.

### Self-review

- Single production file; no manifest, permissions, dependencies or reload-join
  optimization changes. No source-branch merge, history rewrite, or discarded tests.
- Known mapped paths precede resolution; a regression makes root metadata and
  native group lookup throw if that path tries to use them, then checks preserved
  group and tab identities.
- Temporary metadata/removal sets are operation-local. The only lifetime change
  to existing shared state is keeping the pending promise alive through its work
  and extending the existing move guard across the logical phase.
- Title/color reuse is explicitly content-independent; unique empty folders and
  ambiguous/mapped collisions are covered. Main's unrelated URL-based tab sync
  is unchanged, and is not a new folder content matcher.
- Browser race observations exceed the rename debounce. Deterministic model-only
  scheduling and the untested Ctrl+Shift+T UI are labeled above.
- Existing read-only CI runs the added scripts through the same runner/observer;
  all new test sources are committed, with runtime evidence outside Git.

## Spec-review revision of `f34293f`

The initial green lifecycle result was insufficient: its URL oracle omitted title
agreement. Review found real artifacts with logical `New Tab` and native/persisted
`PR40 active tab`. The strengthened oracle reproduced that failure on unmodified
`f34293f` in `ARTIFACTS_DIR/group-lifecycle-evidence-3mqqtlec/metadata_recreation`.

`node test/test_group_metadata_interleavings.js` first failed all three reported
invariants on `f34293f`, plus the held-write and stale-subtree variants:

1. An older combined group/metadata event resumed after resolution and overwrote
   newer navigation metadata. Metadata is now consumed synchronously before the
   group-related awaits, including the first native membership read.
2. Group reload discarded pending URL/title, and callbacks acknowledged an obsolete
   logical object (or acknowledged newer values that were never written). The
   existing pending-write registry now uses stable bookmark identity and retains
   one short-lived `BookmarkUpdate` until its timer/write settles. Writes for the
   same bookmark serialize; reload retargets the pending job to the current primary
   logical record, while callbacks acknowledge the exact payload written.
3. A native rename during placement changed the create key without rechecking
   eligibility. Placement and root metadata reads now finish before the final
   native metadata read and eligibility decision. Reuse/create use one name/color
   snapshot with no intervening await or rename retry loop.

Reload preserves dirty/pending primary metadata. Its temporary snapshot of pending
jobs also covers a save completing while an older subtree read is in flight. An
additional test failed when navigation **and** its save occurred wholly inside
that read: no job existed at either boundary. A monotonic metadata-write revision
on the primary record now identifies that newer metadata without keeping completed
jobs around. Clean saved-only bookmark edits are still adopted from the tree.

### Cost and no-index audit

- No name/color/URL/reverse lookup index, folder-content matcher, invalidation hook,
  or periodic maintenance was added. Known live-group mappings still bypass rare
  resolution completely. The one-off eligibility scan remains O(R + B); existing
  placement reads now precede it even on an unmapped reuse hit.
- Ordinary metadata handling keeps its existing primary-record `find` (O(N)).
  Additional work is O(1): a revision assignment/counter increment and access to
  the already-existing pending-write registry. There is no new full-session scan
  on metadata events or write acknowledgements. No job exists for an idle tab.
- At reload, P outstanding jobs are shallow-snapshotted in O(P) time/space; constant
  metadata fields and any pending job target are carried along during the existing
  join. The nested `find` join is unchanged and remains O(N²). This is metadata
  correctness work, not the unapproved reload-join optimization.
- Revisions are primary metadata fields plus one scalar, not lookup structures.
  Registry entries hold only pending timer/write work and are removed on settle.

### Regression scope

The eight new listener cases check older event replay, creation/debounce/reload,
rename eligibility and later bound-folder rename, ordinary URL-only/title-only
updates, serialized held writes plus newer navigation, a write completing during
reload, a navigation/write wholly inside reload, and clean saved bookmark edits.
They use the existing fixture with before/after API gates. All gate releases use
`finally`. Saves are observed from bookmarks and then compared against the current
logical record and native URL/title, including exact `lastSaved*` acknowledgements.

The real lifecycle oracle now requires native/current-logical/persisted **URL and
title** agreement for every live tab, and current `lastSavedUrl`/`lastSavedTitle`
acknowledgement. It retains the existing minimum/quiet observation and waits for
the actual deferred write condition; no fixed sleep was added to hide disagreement.

The new script is included in the existing read-only CI Node list:

```powershell
node test/test_group_metadata_interleavings.js
# Optional focused reproduction, using the case name substring:
node test/test_group_metadata_interleavings.js 'P1'
node test/test_group_metadata_interleavings.js 'P2'
node test/test_group_metadata_interleavings.js 'P3'
```
