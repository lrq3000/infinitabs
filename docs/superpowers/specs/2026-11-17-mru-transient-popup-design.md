# Transient Recent popup refinement

## Approved outcome and approach

The user accepted retaining the separate browser-hosted popup rather than moving to a toolbar-anchored action popover. Keep the native window frame and existing tab rows/buttons; hide the redundant in-page heading for the normal switcher while preserving the saved-session bridge heading. Close and cancel on any loss of popup focus, including mouse-opened and pointer-disarmed modes. For a keyboard gesture, confirm only after the primary modifier's actual release and release of all other keys observed pressed in the popup. Repeat keydowns must not count twice and physical key identity must survive Shift/case changes. Releases before the document starts listening remain unobservable; never invent them.

## Activation lifetime and constraints

After queued navigation and the worker's gesture barrier settle, the popup hands its selection to the worker. The worker closes the popup without waiting for mounting/focusing the target, continues the activation independently of the closing document, and logs/broadcasts failures. Sidebar activation retains its existing acknowledged/retryable behavior. Starting native-window removal must not wait for storage cleanup; do not remove a newer popup's persisted context. Retain website independence, toolbar/sidebar behavior, filters, row controls, cancellation ordering and existing shortcut settings. No new dependencies, permissions, content scripts, native product helper, publication, installation or root-checkout edits.

## Alternatives and limits

A toolbar action popup supplies frameless presentation and native outside-click dismissal but changes placement and action ownership; it is unnecessary for this priority. The current separate window is the smallest reusable solution. A native helper would be required for reliable global physical key state but is outside scope. Window focus loss covers ordinary outside clicks; browser-owned dialogs and existing delete confirmation must be checked for false dismissal. Native Windows Ctrl+Escape remains OS-reserved. The source worktree, isolated browser profiles and test artifacts remain retained.

## Independent review guarantees

Dismissal captures popup/context identity before asynchronous source reads, so a delayed request cannot remove a newer popup for the same session. Physical held-key state belongs to the document and survives gesture resets; binding replay interprets actions without changing physical state. Release-driven confirmation rechecks physical state after each asynchronous navigation/barrier boundary and resumes on the final keyup without spinning. Explicit Enter remains an immediate confirmation action. Late activation results from an older gesture cannot close or disable its replacement; the worker alone owns popup activation dismissal. Each review finding and the related late-result case has failing-first regression coverage.
