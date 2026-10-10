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

Run every PowerShell block below from `WORKTREE` (the owned worktree), with Git,
Node and Python Playwright 1.59.0 already available. Baseline-object probes require
their referenced commit to be available locally. Configure the `ARTIFACTS_DIR` and
`BROWSER_CACHE_DIR` environment variables, or enter their values when prompted.
Both paths must already exist: artifacts belong in an approved external temporary
directory; the browser cache contains the approved full Chromium. Later blocks
reuse these prerequisites, environment variables, and the helper defined here.
Positive verification uses one native command per helper call: shell errors and
nonzero exit codes terminate the block before later checks can mask a failure.
Negative-proof blocks intentionally retain their explicit expected-exit-1 checks
instead of using this success-only helper. No crx build/install or personal browser
is involved.

```powershell
function Invoke-CheckedNative {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$ArgumentList = @()
    )
    $ErrorActionPreference = 'Stop' # Fail on shell/command-resolution errors too.
    $PSNativeCommandUseErrorActionPreference = $false # Check native exits explicitly across PS versions.
    $nativeCommand = Get-Command -Name $Command -CommandType Application -ErrorAction Stop
    & $nativeCommand.Source @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Native command '$Command' exited with code $exitCode"
    }
}

if (-not $env:ARTIFACTS_DIR) {
    $env:ARTIFACTS_DIR = Read-Host 'Existing approved external artifact directory'
}
if (-not $env:BROWSER_CACHE_DIR) {
    $env:BROWSER_CACHE_DIR = Read-Host 'Existing approved Playwright browser cache directory'
}
foreach ($name in @('ARTIFACTS_DIR', 'BROWSER_CACHE_DIR')) {
    $path = [Environment]::GetEnvironmentVariable($name)
    if (-not (Test-Path -LiteralPath "$path" -PathType Container)) {
        throw "$name must identify an existing directory"
    }
}
if (-not (Test-Path -LiteralPath 'test/test_group_folder_resolution.js' -PathType Leaf)) {
    throw 'Run these commands from the owned Infinitabs worktree'
}
$env:PLAYWRIGHT_BROWSERS_PATH = $env:BROWSER_CACHE_DIR
Invoke-CheckedNative 'node' @('test/test_group_folder_resolution.js')
Invoke-CheckedNative 'node' @('test/test_group_removal_classification.js')
Invoke-CheckedNative 'node' @('test/test_group_metadata_interleavings.js')
Invoke-CheckedNative 'node' @('test/test_group_lifecycle_fixture.js')
Invoke-CheckedNative 'python' @('test/verify_group_lifecycle.py', '--headless', '--artifacts-dir', "$env:ARTIFACTS_DIR")
Invoke-CheckedNative 'python' @('-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py')
Invoke-CheckedNative 'python' @('test/verify_move_logical_tabs.py', '--headless', '--artifacts-dir', "$env:ARTIFACTS_DIR")
Invoke-CheckedNative 'python' @('test/verify_mount_logical_tabs.py', '--headless', '--artifacts-dir', "$env:ARTIFACTS_DIR")
Invoke-CheckedNative 'python' @('test/verify_active_tab_reload.py', '--headless', '--artifacts-dir', "$env:ARTIFACTS_DIR")
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

### Cost and no-index audit before the snapshot reduction below

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
Invoke-CheckedNative 'node' @('test/test_group_metadata_interleavings.js')
# Optional focused reproduction, using the case name substring:
Invoke-CheckedNative 'node' @('test/test_group_metadata_interleavings.js', 'P1')
Invoke-CheckedNative 'node' @('test/test_group_metadata_interleavings.js', 'P2')
Invoke-CheckedNative 'node' @('test/test_group_metadata_interleavings.js', 'P3')
```

### Revised verification record before the snapshot reduction below

Production/test fix commit: `bc239f71964e3baad11abe073d1a77faf4dba4b6`.
These results supersede the earlier metadata-blind lifecycle result. They are
local verification evidence, not a claim that the controller's spec review passed.

| Final check | Result | Runtime | Evidence under `ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| All ten Node scripts in CI + Python unittest discovery | 7 baseline scripts + 17 resolution, 10 classifier, 8 metadata cases; 20 Python tests passed | 63.4s combined | Console output |
| Strengthened lifecycle URL/title/save-acknowledgement oracle | 8/8 flows passed | 100.7s | `group-lifecycle-evidence-6ev80jfo` |
| Movement preservation | 10/10 flows passed | 173.4s | `movement-evidence-03lkvr8s` |
| Mount preservation | 9/9 flows passed | 193.5s | `mounting-evidence-ag1rihvl` |
| Active-state preservation | 3/3 flows passed | 9.3s | `pr40-evidence-k7pf65zh` |

The browser commands are the same documented commands above, using Playwright
1.59.0 / full Chromium 147.0.7727.15 and disposable profiles. All final commands
exited zero; browser worker/page error checks passed. The lifecycle check retained
1500ms uninterrupted quiet and 2500ms minimum observation. Node's inherited ESM
warning and intentional failure-injection diagnostics remain visible.

Final SHA-256 fingerprints, independently checked against the on-disk files and
the browser evidence after the fix commit:

| Source/script | SHA-256 |
| --- | --- |
| `src/background.js` | `65ea681798756fbb778e2d9bc773d34acb85f8ed9753da1c44452536beb13d5e` |
| `test/group_lifecycle_fixture.js` | `7c182bb47d71e714a44e326169c439661ca0964ff559f9b56cec690630897396` |
| `test/test_group_metadata_interleavings.js` | `d858c5254af9f08d19c82bccf6fd49cdb1928baf433d6d1f3037b1d88b7d153c` |
| `test/verify_group_lifecycle.py` | `732de7a80dc2fba193c2e638cf8fea9f9ab8dec1e492ea9b575f03e5cb8adb9e` |
| `test/verify_move_logical_tabs.py` | `7a86c5c16a5977eed197aa326dc2667c0ef3fd64dd65477f7563bd459bb18e27` |
| `test/verify_mount_logical_tabs.py` | `42a169695b52098367961f5c32266d6fbcc722b0ddec0c1b18d532baaed331f5` |
| `test/verify_active_tab_reload.py` | `cd980aced1f761b89ba2149c93bbdc26da121d6daf78a7e306153bcc7845685d` |

Self-review: the timer registry is the only per-bookmark pending-write owner;
its jobs are disposed when settled, and completed jobs are not retained as a cache.
Reload performs extra synchronization only at its own boundary. Clean saved edits,
closed-tab history, startup/coalescing, mapped fast paths, removal classification
and movement feedback remain covered. Exact held-API metadata interleavings are
Node models; real Chromium supplies the strengthened native/logical/persisted
agreement evidence. No production backdoor or test-only listener was added.

## Snapshot reduction from spec-approved `bf0c8f6`

The O(P) copy of all pending jobs at every reload has been removed. The existing
primary metadata revision now advances on a successful exact-payload write ACK
as well as on a metadata change. A write already pending before a subtree read
therefore leaves revision evidence when it finishes during that read, even after
its job is deleted. The existing unconditional revision propagation is retained
through clean reloads, so a newer completed reload cannot erase evidence needed
by an overlapping older read. The original nested `find` join is unchanged.

### Correctness proof before accepting the reduction

Three focused listener regressions were added to the existing metadata suite:

- A bookmark write is explicitly held **before** a subtree read; the read captures
  verified old URL/title; the write finishes during that read, with no new native
  navigation; the old read must retain the current native/logical/saved metadata.
- The same ordering, but a newer reload completes with saved new data before the
  old read returns. The test verifies replacement of the primary logical record
  and then rechecks agreement after the old read returns.
- An older payload succeeds while the logical record has newer values. Its ACK
  must record the older written values, including across reload; the newer values
  still require a separate write and must ultimately agree in all representations.

Controlled comparisons, with all temporary mutations removed before final checks:

| Implementation under test | Result |
| --- | --- |
| Original `bf0c8f6` with new ACK cases | All three pass |
| Remove registry snapshot, omit successful-ACK revision | Held-read and overlapping-read cases fail with stale logical URL |
| Advance ACK revision, retain unconditional propagation | All three pass |
| Retain ACK revision, omit propagation through reload | Overlapping-read case fails with stale logical URL |
| Final code with both guards | All eleven metadata cases pass, including the original eight |

Commands: `node test/test_group_metadata_interleavings.js ACK`, focused name
substring `"ACK pending before"` or `"ACK pending before overlapping"` during the
guard comparisons, then the complete three group/metadata scripts and baseline
commands documented above. These are API-gated correctness tests, not timing
benchmarks; no grace timer, listener, index or completed-job cache was added.

### Exact current cost

- **Changed metadata event:** unchanged from the approved fix: existing O(N)
  primary-record search, then O(1) revision increment/assignment and pending-timer
  bookkeeping. This reduction adds no work to that path.
- **Successful bookmark write:** one additional scalar increment and one primary
  record assignment, O(1). Exact `lastSaved*` payload acknowledgement is unchanged.
  Failed or skipped writes do not advance the ACK revision.
- **Reload start:** one scalar read, O(1) time and additional space. No pending-job
  enumeration or cross-session copy. The existing loop still has O(1) metadata
  checks/copies per matched record; total join complexity remains O(N²), with its
  pre-existing session/ID-remapping allocations. This is not a zero-cost reload.
- The existing registry still owns O(P) actually pending jobs; this change removes
  the **additional per-reload O(P) snapshot**, not the required debounce queue.
  Primary fields/counter are reused; there are no additional maintained structures.
  Rare folder matching and known-mapping fast paths are unchanged.

### Final-source verification and fingerprints

| Check | Result | Runtime | Evidence under `ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| Focused Node suites | 11 metadata + 17 resolution + 10 classifier cases pass | 57.3s | Console output |
| Baseline Node + Python | 7 scripts + 20 Python tests pass | 17.2s | Console output |
| Strengthened lifecycle browser checks | 8/8 pass | 102.0s | `group-lifecycle-evidence-24oy8gsh` |
| Movement browser preservation | 10/10 pass | 171.2s | `movement-evidence-2akog5m9` |
| Mount browser preservation | 9/9 pass | 193.4s | `mounting-evidence-os33zpw7` |
| Active-state browser preservation | 3/3 pass | 9.4s | `pr40-evidence-kt6fbqh7` |

All browser suites ran once on this final source using the existing isolated
Playwright 1.59.0 / full Chromium 147.0.7727.15 runners. Metadata URL/title/exact
save-acknowledgement assertions and event-quiet observation were retained.

Changed SHA-256 fingerprints:

- `src/background.js`: `c8dcb439f399f3703d3622997b1e3a736e4e78fc34d417e2be068ff674621561`
- `test/test_group_metadata_interleavings.js`: `a7671696c8966a3587e580cc328c15fd100267026c15fc54b2bb55aee9f2d06e`

Fixture and Python script fingerprints are unchanged from the preceding table;
they were independently checked on disk and against the final browser evidence.
`git diff --check` passes. All changes stay in the owned worktree.

Limit: no separately named `lastNative`/cache-clear stress script was present in
the owned checkout or approved artifact directory, so execution of those external
probes is not claimed. Existing last-native closure/classifier/movement cases pass.
The exact held-read/ACK orderings above are modeled API schedules; browser suites
provide actual native/logical/bookmark agreement and preservation evidence.

## Startup ownership/order correction after quality review of `281672c`

Two introduced regressions were reproduced before production edits. Empty-session
imports of native groups First/Middle/Last lost a bookmark/live binding when First
and Last shared a URL, and reversed saved folder/logical order when all URLs were
distinct. The same focused assertions pass with the actual `0780c87` module body.
The optional Node baseline loader reads that Git object and relocates only its
relative imports in memory; it never overwrites a production file or worktree.

The correction batches group import with one final reload. An import-local
`Map<BookmarkId, NativeTab>` records each matched/created bookmark's ownership
before another iteration can claim it. Final attachment uses those stable IDs,
not another URL match. The preceding imported bookmark is passed to the shared
resolver as placement context; startup does not need to publish partial logical
records or re-query the native strip to find its already-imported predecessor.
Ordinary group creation retains its current placement/reload behavior. Existing
reused folders retain their saved order and saved-only children.

### Completion guard and negative proof

The resolution suite has a **referenced** 120-second watchdog, cleared on normal
completion or an explicit failure. It asserts completion of all 20 default cases
(the original 17 plus three startup cases); filters must select at least one case.
Restoring the old init-inside-mutex ordering **in memory** with a one-second
watchdog prints `suite unfinished; completedCases=0` and exits **1**, rather than
silently exiting zero with an unresolved promise. This was verified before and
after the startup correction. Other old test scripts are unchanged.

Reproduction commands in `WORKTREE`:

```powershell
Invoke-CheckedNative 'node' @('test/test_group_folder_resolution.js', 'startup imports')
$env:GROUP_TEST_BACKGROUND_REF = '0780c87aa61e82d9732cf10aafd0abc5cf40acca'
try { Invoke-CheckedNative 'node' @('test/test_group_folder_resolution.js', 'startup imports') }
finally { Remove-Item Env:GROUP_TEST_BACKGROUND_REF }

$env:GROUP_TEST_OLD_INIT_MUTEX = '1'
$env:GROUP_RESOLUTION_TIMEOUT_MS = '1000'
try {
    node test/test_group_folder_resolution.js
    if ($LASTEXITCODE -ne 1) { throw 'Expected referenced watchdog to exit 1' }
} finally {
    Remove-Item Env:GROUP_TEST_OLD_INIT_MUTEX
    Remove-Item Env:GROUP_RESOLUTION_TIMEOUT_MS
}
```

### Measured import reads and cost boundaries

Instrumented Node counts for the three-native-tab target session, captured before
the test oracle performs its own reads:

| Source/fixture | Session subtree reads | Native tab queries | Native group metadata/liveness reads |
| --- | ---: | ---: | ---: |
| Base `0780c87`, duplicate or distinct URLs | 2 | 2 | 3 |
| Reviewed `281672c`, duplicate URLs (incorrectly only two groups) | 4 | 4 | 6 |
| Reviewed `281672c`, distinct URLs | 5 | 5 | 9 |
| Corrected source, duplicate or distinct URLs | **2** | **2** | **9** |

The two subtree reads are the initial load and **one final reload**, with no
per-group/per-tab intermediate reloads. The two native tab queries are the import
snapshot and active-tab query. The shared resolver's existing three group reads
per newly created group remain for metadata/liveness checks; total API parity
with the old base is not claimed. Actual Chromium worker logs also show exactly
two loads of the new target session in each startup flow.

Temporary import storage is O(T) for T native tabs plus one predecessor scalar.
Each ownership operation is O(1); final attachment traverses the L reloaded logical
records once with O(1) association lookup. Existing initial URL-based tab matching
is retained, with an ownership exclusion. The separate shared reload's nested
`find` join is unchanged. Metadata-only folder eligibility remains operation-local
O(R + B). There is no import-map maintenance on ordinary browsing events, no new
global index/cache/listener, and no per-existing-group one-second startup delay.

### Actual Chromium startup proof and final validation

The two new browser flows create real native groups, choose duplicate or distinct
URLs, create a fresh empty saved session through `chrome.bookmarks`, set its real
`chrome.storage.local` binding, then stop/restart the extension worker through the
existing cold-worker helper. Public messages read the resulting session. No
production state, API, listener or browser profile is patched. Assertions cover
every native tab exactly once, distinct saved group bindings, folder/logical/native
order, stable native IDs/group membership, and native/logical/persisted metadata.

Both failed on `281672c`:

- `ARTIFACTS_DIR/group-lifecycle-evidence-dgbz1c5y/startup_duplicate_urls`: missing
  per-native-tab bookmark/coverage.
- `ARTIFACTS_DIR/group-lifecycle-evidence-bcwm2owx/startup_distinct_urls`: wrong
  logical/native order.

Final-source runs (Playwright 1.59.0 / full Chromium 147.0.7727.15):

| Check | Result | Runtime | Evidence under `ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| Resolution + classifier + metadata | 20 + 10 + 11 cases pass | 57.2s | Console output; `completedCases=20` |
| Guard negative + baseline Node/Python | Expected watchdog exit 1; 7 Node scripts + 20 Python tests pass | 18.3s | Console output |
| Expanded lifecycle | 10/10 browser flows pass | 130.2s | `group-lifecycle-evidence-uu_l5uwm` |
| Movement preservation | 10/10 pass | 174.1s | `movement-evidence-g63o2ekt` |
| Mount preservation | 9/9 pass | 196.5s | `mounting-evidence-uupw9iyb` |
| Active-state preservation | 3/3 pass | 9.1s | `pr40-evidence-t5zi0624` |

Final SHA-256 values:

- `src/background.js`: `6287083f3604562f4aafa95bf9649a44bfb7217abf3a85f0ada675d30a05c0bd`
- `test/group_lifecycle_fixture.js`: `4341cd015d467aac72290a5421bc560169680a0bce70968a1acbcf41e589decc`
- `test/test_group_folder_resolution.js`: `5c16a15185126986aabdca54dd22d3562de7a2dc7c7e8573958bab44c1ab0648`
- `test/verify_group_lifecycle.py`: `4226eabee2b83d8b5673f2910b96c48387f1794e2f54bf2f2b843c65ac85ea14`

Other browser runner/observer fingerprints remain as recorded above. The existing
CI commands automatically run the expanded resolution and lifecycle suites. These
are bounded fixtures and actual cold-worker startup evidence, not a claim about
arbitrary overlapping session switches or external bookmark edits during import.

## PR78 feedback verified against published `526280e`

Implementation/test commit: `fd55edd9b28dc5ea0803ee06361e7070347cf16e`.
The eight supplied review threads were assessed as six topics. All six findings
were valid in the inspected source. This is a local disposition/evidence record;
GitHub replies, thread resolution and publishing remain controller operations.

| Topic | Disposition and proof |
| --- | --- |
| 1. Overlapping same-tab moves release shared ownership too early | Fixed. Two actual public `MOVE_LOGICAL_TABS` handlers are held concurrently on A. With the published Set, releasing the first (success OR logical-write failure) lets C's removal flatten saved G while the second still owns A. Both cases fail first on `526280e`, then pass with reference-counted primary ownership. After the last owner exits, genuine Ungroup succeeds, proving release cleanup for the exercised ID. |
| 2. Rare reuse leaves canonical state/UI stale | Fixed. A folder and saved history are added behind the loaded model, and A's bookmark is moved into it externally. With the published early return, the native group update has no parent move to perform and leaves the folder invisible. The new Node case fails first, then passes. Reuse and creation now share publication; the real `external_reuse` browser flow also verifies canonical state and the public `STATE_UPDATED` notification. |
| 3. Metadata suite can pass without completing/selecting cases | Fixed. Before the guard, both an unmatched filter and an unresolved test gate exit zero. A small shared focused-suite helper now provides a referenced watchdog, selected/completed counts, and cleanup. Both negative probes exit 1. Resolution/removal/fixture checks share the helper rather than copying guard blocks. |
| 4. Held-removal fixture assumes a specific read without bounding that wait | Fixed. The specific folder-gate await has a 2s deadline and an explicit `Held-removal model assumption failed: expected getChildren(...)` diagnostic. Gate release and handler settlement are in `finally`; timeout handles are cleared. Deliberately suppressing that hook fails with this diagnostic using a 100ms probe deadline, rather than relying on the generic 6s RPC timeout. Positive structure/membership assertions are retained. |
| 5. Indexed mock creation renumbers snapshots, not backing nodes | Fixed. The new contract first fails with stale sibling indices `[0,0,1]` and an internal read-hook invocation. Internal normalization now uses the captured backing getter; `get`, `getChildren` and `getSubTree` agree on `[0,1,2]`, earlier snapshots remain unchanged, and internal bookkeeping invokes zero production-read hooks. Existing assertions pass unchanged. |
| 6. Copyable commands use literal path placeholders | Fixed. The prerequisite block now accepts environment/user-provided values, validates existing directories, assigns `$env:PLAYWRIGHT_BROWSERS_PATH = $env:BROWSER_CACHE_DIR`, and quotes `"$env:ARTIFACTS_DIR"` in browser commands. All command sections were reviewed against the common prerequisites; the variable-based browser invocations below were executed successfully. No machine path is embedded in the report. |

### Scope and precise costs

`LiveTabOwnership` replaces the one existing ownership Set with one private Map
of active native ID to owner count. It is **primary operation ownership**, not a
matching index or idle-tab cache. Acquisition/release each perform O(1) Map work
per selected native ID; a move with K selected native IDs remains O(K) ownership
work. `has` stays O(1); iteration yields unique IDs in insertion order, with O(U)
iteration/storage for U currently owned IDs. The last release removes the entry.
Ordinary metadata/tab events do not maintain counts; there is no grace timer.

For rare unmapped reuse with `reload=true`, publication now pays one canonical
session reload and notification, just as creation does. This is an intentional
rare-path correctness cost; the existing O(N²) reload join is unchanged. Known
mapped groups still bypass resolution, and batch startup's `reload=false` still
uses its single final reload (two subtree loads including the initial load).
Option 2 remains name/color-only, including different contents/empty folders;
there is no maintained secondary matching index or invalidation listener.

The counts do not serialize moves or define arbitration for conflicting concurrent
destinations. The held overlap tests use actual production handlers/public
messages with modeled native API gates and one canonical destination. They prove
ownership lifetime and output invariants, not a general transaction framework.

### Bounded negative probes

Run from the owned worktree with the prerequisites above. Each command below is
expected to fail with exit 1; these are test-only flags, not production timers.

```powershell
node test/test_group_metadata_interleavings.js NO_SUCH_CASE
if ($LASTEXITCODE -ne 1) { throw 'Unmatched filter must fail' }

$env:GROUP_METADATA_UNRESOLVED_GATE = '1'
$env:GROUP_METADATA_TIMEOUT_MS = '1000'
try {
    node test/test_group_metadata_interleavings.js
    if ($LASTEXITCODE -ne 1) { throw 'Unresolved metadata gate must fail' }
} finally {
    Remove-Item Env:GROUP_METADATA_UNRESOLVED_GATE
    Remove-Item Env:GROUP_METADATA_TIMEOUT_MS
}

$env:GROUP_REMOVAL_SKIP_GATE = '1'
$env:GROUP_REMOVAL_GATE_TIMEOUT_MS = '100'
try {
    node test/test_group_removal_classification.js 'held removal'
    if ($LASTEXITCODE -ne 1) { throw 'Missing model read hook must fail' }
} finally {
    Remove-Item Env:GROUP_REMOVAL_SKIP_GATE
    Remove-Item Env:GROUP_REMOVAL_GATE_TIMEOUT_MS
}
```

### Final-source evidence

| Check | Result | Runtime | Evidence under `ARTIFACTS_DIR` |
| --- | --- | --- | --- |
| Four focused Node suites | 21 resolution + 12 removal/ownership + 11 metadata + 1 fixture-contract case pass | 58.2s | Console completion counts |
| Removal cleanup recheck + baseline | 12 cases + 7 baseline Node scripts + 20 Python tests pass | 19.3s | Console output |
| Lifecycle, including external-folder publication | 11/11 browser flows pass | 142.4s | `group-lifecycle-evidence-m80gthb6` |
| Movement preservation | 10/10 pass | 173.8s | `movement-evidence-nixsp26y` |
| Mount preservation | 9/9 pass | 195.9s | `mounting-evidence-bugsgz_7` |
| Active-state preservation | 3/3 pass | 9.2s | `pr40-evidence-siu7xmzb` |

The original 32 browser flows are retained, plus one new external-reuse flow.
All four browser suites ran once on the final production source, using isolated
Playwright 1.59.0 / Chromium 147.0.7727.15 profiles. Source hashes agree across the
evidence sets. Intentional Node fault-injection diagnostics remain visible;
browser page/worker error checks pass. `git diff --check` passes.

Final SHA-256 fingerprints:

| Source/script | SHA-256 |
| --- | --- |
| `src/background.js` | `6ffac634d1e2edff44c81e41fd0f86a2a42d6843c44afd87a09d2a21ed00587a` |
| `test/group_lifecycle_fixture.js` | `ac935c207129e31d9fc0b9f82e62dd7306ab81873638ea5e62ccc26a90d9da5b` |
| `test/group_lifecycle_suite.js` | `6b217868c1850414d9ab53875f6140bfba88c6a645e9c1db3fb700d3ddfc871d` |
| `test/test_group_folder_resolution.js` | `c0f7fc04444a2fa6cdc6223f1a8624e866095411c17f404fb0d5a4f35e509079` |
| `test/test_group_removal_classification.js` | `bf0f3c6db9750e094c877f5fb29b441fd4e65eb9111f87d973ecfe4cdca1aa9a` |
| `test/test_group_metadata_interleavings.js` | `ab2ea0ed9f99e7d5c081fbe40918b05b9d2d45b5fe0fc62dee0860ba4baad54d` |
| `test/test_group_lifecycle_fixture.js` | `b7b7896dffc33c6d2e580edc5004e976762ae7afd6b7e68ed72abe9af69771fe` |
| `test/verify_group_lifecycle.py` | `dd2ee1c3f74b38c4f9168aa8b3e0ed0d25e1c590b5c4ae2e63e408e3e6952e3e` |

Other browser runner/observer fingerprints are unchanged from the earlier tables
and were checked again against the final evidence. All new test files are committed
and the mock contract is included in the existing read-only CI Node list.
