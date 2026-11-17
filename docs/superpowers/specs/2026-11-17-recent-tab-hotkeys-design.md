# Recent-tab hold switcher and editable hotkeys

## Intent and approved behavior

Provide layout-independent, one-handed recent-tab navigation for the user's BÉPO keyboard. Ctrl+Down opens the existing browser-hosted Recent switcher with the previous recent tab selected. Repeated Ctrl+Down selects older tabs; Ctrl+Up selects newer tabs. Release Ctrl to activate the selection once. Escape cancels, including while Ctrl remains held. Clicking rows and their existing unmount/delete buttons continues to work. Reuse shared rows, MRU storage, filters and display settings; do not inject website overlays or duplicate tab metadata.

## Approaches

Shift+Tab cannot register an opening Chrome command. Ctrl+Space and Ctrl+Shift+Space were considered; the user selected Ctrl+Down and Ctrl+Up. A native helper could support broader remapping but would add installation, permissions and maintenance. The approved approach is an extension-only implementation: one extensible action registry and settings table with Function, Hotkey and Scope. Switcher-only bindings support click-to-record, validation, duplicate rejection and reset. Browser-wide bindings are read from chrome.commands.getAll and edited through Chrome's own shortcut settings because Chrome has no commands.update API. Do not pretend a captured browser-wide binding was applied.

## Constraints and edge cases

Keep the toolbar's sidebar-opening action unchanged. A mouse-opened switcher remains open until Enter/click/Escape rather than committing on an unrelated Ctrl release. Preserve current-tab highlighting separately from the navigation cursor. Do not drop navigation while startup or paging is pending; cancel must win over queued activation. Register key listeners before asynchronous initialization. A Ctrl release before the popup document can listen is inherently unobservable: retain Enter/click as fallbacks and report browser timing limitations rather than inferring a release. Existing Chrome command assignments belong to the user and must not be overwritten. Derived release-to-confirm follows the actual opening chord's primary modifier when rebound. Only focused-switcher actions intercept local shortcuts; normal sidebar keyboard behavior remains unchanged.

## Scope and verification

No new permissions, dependencies, content scripts, native helper, public push, PR, merge, release or live-extension reload. Use the approved isolated worktree, local milestone commits, focused Node tests and the existing isolated Chromium fixture with a new hotkeys scenario. Retain browser artifacts in the approved OpenCode temporary directory. Inspect fast opening/release, cancellation, repeat/paging, remapping/persistence, browser-managed editing and row-action behavior. Implementation is inline with one independent whole-branch review.

## Verified platform constraints during implementation

French Chromium returns `Ctrl+Bas` from commands.getAll. Preserve that display value, canonicalize recognized aliases for matching, and derive the hold modifier independently of the localized non-modifier label. Windows reserves native Ctrl+Escape for Start: the DOM handler cancels when delivered; otherwise focus loss cancels the gesture, but the extension cannot suppress the OS action. Guarded native accelerator tests stopped before any keystroke because Windows did not expose the isolated QA window for foreground targeting; real extension-runtime/DOM gesture tests and command-adapter unit tests cover their respective boundaries, not an unverified native OS end-to-end path.

## Review-driven correctness guarantees

Confirmation waits for the worker's acknowledged gesture sequence, including repeats still awaiting a storage write or broadcast. Only the actual primary-modifier keyup can request release confirmation; an ordinary keyup must not invent a missed release. Saved custom actions are interpreted in input order after binding initialization, with Escape available immediately. Activation errors are retryable and distinct from query errors, so failed queries still prohibit stale navigation. Explicit command source IDs are captured before queueing. Optional test-only native injection tracks owned keydowns and permits release-only cleanup even after focus changes or interrupted injection; its cleanup tests do not send actual OS input. The browser QA uses the existing MRU_OPEN transport's explicit keyboard mode and the real worker release barrier rather than manufacturing worker gesture identity.
