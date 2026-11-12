# Logical-tab MRU and quick switching

Approved by the operator on 2026-11-12 in this OpenCode conversation. The purpose is fast return to previously viewed logical tabs, inspired by Quick Tabs, without changing the canonical native bookmark layout or the existing select-previous-on-close behavior.

## Behavior and scope

Provide a Recent view in the Session sidebar and a compact standalone keyboard switcher. Preserve Workspaces and the toolbar icon's existing open-sidebar action. Default to the current session, with an explicit All sessions scope. Reuse the existing Live Only toggle, shared per source window: on includes mounted/native tabs (including discarded native tabs); off includes mounted and unmounted surviving logical tabs. Omit the current tab from switch targets and preselect the previous eligible tab. Background creation, background activation and merely highlighting a result are not views.

Keep one recency record per viewed canonical bookmark ID; same-URL bookmarks are different tabs. Persist recency across worker/browser restarts, but do not invent pre-install visits. Record focused-window selections and window focus changes, reconciling activations that preceded native/logical attachment. Native IDs and regenerated logical IDs are never durable identity. Bookmarks remain the sole identity/layout authority; recency does not store placement, group or parent snapshots.

Mounted selections focus the existing native tab/window. Unmounted selections use existing mount logic, preserving bookmark order/group and mounting only that tab. Cross-session selections focus the session's existing window, or create a new normal window bound to its saved session without replacing the caller's session. Coordinate window creation without dropping unrelated concurrent window events. Deduplicate concurrent activation requests and revalidate source/target context before effects.

## Presentation

Both surfaces share the same search/view/controller and existing theme variables. Show favicon, title, domain, mounted status and cross-session labels. Empty queries use newest-viewed-first order. Nonempty queries prioritize exact/prefix/substring title/URL matches before fuzzy subsequence matches, with recency within each fixed tier. Normalize/caches candidates independently of DOM, page the initial approximately 50 results and discard stale query responses without stealing selection.

Autofocus search; support arrows, Tab/Shift+Tab, Page Up/Down, Home/End, Enter and Escape. Suggest Alt+Shift+Q for opening; provide an initially unbound direct Previous tab command configurable through Chrome shortcuts. Do not promise reserved Ctrl+Tab interception. Keep one switcher window: invocation from another browser window retargets/reset it; invocation inside the switcher advances selection. Close on successful activation, Escape, source window closure or source-session change. Exclude switcher UI from all session/bookmark/workspace/crash-recovery tracking, including first lifecycle events and worker startup.

## Deleted recovery

Recovery is disabled by default. When disabled, deletion purges recency and retains no deleted URL/title snapshot; this is a collection/storage rule, not a display filter. Opt-in applies only to future deletions of previously viewed logical tabs. Keep recovery snapshots separately, capped at 100 entries and 30 days with lazy read/write/startup pruning. Save title, URL, last-viewed/deletion times and contextual source session, never former placement. Recovery entries cannot evict surviving recency and appear visibly marked only when Live Only is off, respecting session scope.

Restoration creates a fresh top-level bookmark at the end of the current source session and mounts it. Do not recreate former groups/positions or merge same-URL logical tabs. Remove recovery only after successful restoration; known partially restored identities are resumed rather than duplicated. Native bookmark and extension-storage APIs have no shared transaction: report unresolved partial operations instead of guessing by URL after a crash. Disabling recovery clearly warns and clears only this feature's recovery records, not Chrome history or unrelated workspace snapshots.

## Architecture, constraints and alternatives

Use a self-contained src/mru module with storage, search/service, shared view and narrow Chrome adapters. Prefer namespaced per-bookmark chrome.storage.local writes and worker-owned serialized mutation; share temporary per-window UI state through chrome.storage.session. Expected constant-time indexed touch/lookup, linear cached candidate search, paged DOM, no per-result Chrome API calls on each keystroke. Reconcile external bookmark metadata/move/removal and group/session subtree deletion; pending writes must not resurrect deletions. Storage failure must not damage canonical bookmarks.

Generalizing the existing native-tab close stack was rejected because it couples durable logical recency to ephemeral IDs. Porting Quick Tabs wholesale was rejected because it brings unrelated browser-tab-centric state, dependencies and keepalive machinery. Initial MRU support covers normal windows only; do not collect private visits or activate a private-bound target from a normal request. Incognito-specific support is deferred until the underlying session-isolation model is verified. No new runtime dependencies, history/host/scripting permissions or automatic mass mounting.

## Documentation and verification

Create root todo.md with a Future Quick Tabs-inspired features section, one physical line per deferred capability explaining both implementation and InfiniTabs philosophy. Include broader bookmark/history scopes and optional permissions; prefixes/engines/explicit fallback; pinned/group/audio filters; duplicate/close/unmount/merge/split/reload/mute/group actions; cycling/dwell policies; badge/display/custom CSS/query memory options; non-destructive alternate sorts and opt-in physical ordering; explicit no-match navigation/search and history exclusions.

Test identities/order, focus/background policy, attachment races, persistence, shared filters/scope, duplicate URLs, search/keyboard/paging, external/subtree deletion and pending-write races, opt-in retention and append-at-end restoration failures. Verify real extension behavior in isolated Chromium, including popup exclusion, worker/browser restart and a measured 10,000-candidate fixture. Retain non-regenerable tests and temporary QA artifacts. Use a fresh worktree based on refreshed origin/main; commit tested milestones locally. No push, PR, main merge or cleanup is authorized.
