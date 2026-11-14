# Shared tab rows

## Intent and approval

Approved by the user on 2026-11-14: Recent must use the normal view's tab-row widgets and layout, including the green mounted-dot unmount action and hover-revealed delete cross. Extract reusable functionality rather than maintaining separate implementations.

## Goals and constraints

- Compact title-only rows are the default everywhere. One global setting offers Compact, Title + domain, and Title + full URL, and updates normal, Recent, and popup rows.
- Remove Mounted/Unmounted descriptive text. Recent has no group headers, group indentation, or group-color lines. Normal grouping remains unchanged.
- Preserve normal selection, drag/drop, search, favicon fallback, tooltips, confirmation preferences, and lifecycle effects. Preserve Recent ordering, paging, filtering, independent current highlight and keyboard cursor, and popup activation/dismissal semantics.
- A mounted dot only unmounts; deleting removes the logical bookmark and any live projection. Neither action activates the clicked row. Deleting from a closed saved session must not open a window or mount a tab.
- Resolve Recent actions using stable bookmark identity and current authoritative state; do not persist another identity or placement mapping. Preserve opt-in-only deleted-tab recovery.
- No dependencies, installs, main changes, publication, merging, or ordinary-browser-profile interaction. Use the approved isolated worktree and retain generated QA artifacts in the approved temporary directory.

## Approaches

Selected: extract one shared TabRow component, one global display-preference helper, and shared confirmation behavior from the normal view; inject view-specific activation and lifecycle callbacks. This reuses existing styles and lifecycle handlers while keeping normal tree navigation and Recent ordering independent.

Rejected: duplicate the normal controls in Recent, because behavior and layout would drift again. Replacing normal tree rendering wholesale with the MRU renderer is also unsuitable because normal incremental updates, drag/drop, and grouping already work and must remain intact.

## Implementation boundaries

The shared row owns markup, favicon fallback, text formatting, mounted/delete controls and presentation state. View owners retain item identity, navigation, selection, grouping and drag/drop. The MRU Chrome adapter translates stable bookmark keys to the existing background unmount/delete lifecycle at action time, including saved sessions. Recovery-only deleted entries remain restoration entries, not existing logical tabs with another delete/unmount action.

## Verification

Use node:test for global preference normalization/updates, confirmation and action boundaries, MRU routing, and asynchronous controller effects. Extend the existing real-extension Playwright harness for matching compact/detailed geometry, live setting changes, light/dark narrow layouts, dot/delete interactions, cancellation, unchanged bookmarks on unmount, deletion of mounted/unmounted targets, Live Only, saved-session routing, and existing navigation/worker restart regressions.
