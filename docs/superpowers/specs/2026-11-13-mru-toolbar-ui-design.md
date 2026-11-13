# MRU toolbar presentation

Approved by the operator through the plan approval card on 2026-11-13. Implement in this session, followed by one independent read-only review.

## Intent and scope

Make the Session sidebar's Recent view use the familiar normal-tab controls without a layout jump. Place Recent immediately after Live Only and before Add tab, with the same normal, hover and active appearance as the existing action buttons. In Recent mode, the fixed header search row shows `Search recent tabs...`, keeps the normal search field's position and dimensions, and supports clearing and previous/next match selection. Navigation highlights/scrolls results without activating them; existing Enter/click activation stays unchanged. Cycle through all matching results, including across page boundaries.

Replace Locate only in Recent mode with an icon-only `↗` button immediately after Next. Set its tooltip and accessible name to `Open recent tabs switcher in a separate window`. Turning Recent off restores normal search and Locate. Keep independent queries, current/all-session scope, shared Live Only filtering, keyboard navigation, private-window restrictions, recency and deleted-recovery policy. Do not redesign the standalone popup or change its search presentation.

## Approaches

Reuse the existing header search row and the shared MRU view/controller, rather than create a second look-alike toolbar. The former keeps sizing and styling in one place; the latter would duplicate layout and event handling. Implementation detail: let the MRU view place its existing owned input in the shared header wrapper, while hiding the normal input in Recent mode. This retains separate input state and combobox semantics without attaching two competing controllers to one input. This is an implementation choice within the approved shared-toolbar design.

## Constraints and verification

Use a fresh worktree at `C:/git/infinitabs/.worktrees/mru-toolbar-ui`, branch `feat/mru-toolbar-ui`, from current HEAD. Root and other worktrees remain untouched. No new dependencies, browser downloads, signing builds, push, PR, main merge or cleanup. Preserve relevant comments/logging and commit tests plus design/plan with tested local milestones. Retain isolated browser profiles/screenshots under `C:/Users/33632/AppData/Local/Temp/opencode`.

Prove previous/next navigation at both ends and page boundaries in Node controller tests. Extend the existing real-extension Chromium check to compare normal/recent search geometry and action styles in light/dark mode at narrow/wide sidebar widths, verify clearing and separate queries, keyboard focus and selection without activation, tooltip/icon placement, mode restoration, and real popup opening. Reuse installed Chromium through the existing `--executable` option if Python Playwright's default revision is absent. Do not install anything if prerequisites are unavailable.
