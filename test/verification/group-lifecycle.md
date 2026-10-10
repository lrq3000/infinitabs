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
