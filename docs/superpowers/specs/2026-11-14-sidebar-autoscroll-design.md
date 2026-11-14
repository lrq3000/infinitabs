# Visibility-aware sidebar scrolling

## Intent and approved behavior

Selecting a fully visible tab must preserve the list's scroll position, whether the tab is already mounted, becomes mounted, or becomes active after another tab closes or unmounts. A partially clipped or off-screen selected row must be revealed. Locate Current Tab follows the same visibility rule and retains its ability to expand a collapsed group.

## Existing mechanism and approaches

`renderSession` notices an active logical-ID change and schedules `scrollElementIntoViewWithContext`, which unconditionally aligns the second preceding sibling to the top. Locate independently centers the active row unconditionally. The selected approach is a constant-time geometry check inside the existing animation-frame callback, after DOM changes settle, shared with Locate. Removing automatic scrolling altogether would strand off-screen selections; suppressing only click-triggered scrolling would miss automatic selection and mounting-related ID changes. The separate Recent popup already uses nearest-edge scrolling and is checked without speculative changes.

## Design and constraints

Compare the actual selected row, not its context siblings, with the scroll container's inner viewport. Fully visible rows require no scroll call. Off-screen rows retain the current two-row context; Locate retains centering. Reuse the existing helper with optional context/alignment parameters rather than introducing a subsystem. Ignore disconnected or non-rendered targets, and preserve existing drag suppression, search navigation, collapsed groups, and compact/domain/full-URL display modes. No dependencies, configuration changes, or page-content injection are needed.

Independent review found a second source of selection-driven movement: background updates reapply an active search and navigate to its first match. Refresh those highlights without navigating; keep first-match reveal for user-entered queries and Previous/Next navigation. This is part of the same visible-selection requirement, not a change to search matching or activation semantics.

## Verification and scope

Exercise the production helper with deterministic DOM-boundary inputs in Node, then use an isolated Chromium profile with the actual unpacked extension and generated localhost/bookmark fixtures. Cover mounted and unmounted clicks, automatic selection after close/unmount, clipped top/bottom edges, Locate, collapsed groups, hidden normal view, and compact/detailed rows. Keep screenshots, evidence, and the isolated browser profile in the approved temporary directory. Make only local commits; do not push, merge, delete artifacts, or interact with the personal browser.
