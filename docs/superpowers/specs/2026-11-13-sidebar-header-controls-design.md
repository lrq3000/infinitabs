# Responsive sidebar header controls

Approved through the OpenChamber design/implementation card on 2026-11-13. The operator additionally clarified that the session selector must resize dynamically with sidebar width, while buttons retain their natural dimensions and remain visible; Refresh currently leaves the viewport at narrow widths.

## Design and approaches

Move the existing Theme and Settings controls into the session-selector row. Preserve the approved order: Session selector, Rename, Refresh, Theme, Settings. Give the selector flexible remaining width and `min-width: 0`; give buttons non-shrinking intrinsic sizes. Keep the row in ordinary flex layout with vertically centered controls. Remove the now-empty lower left group and its unused CSS, preserving the lower Unmount Others/Live Only/Recent/Add controls and all existing JavaScript handlers.

Reuse existing controls and flex layout instead of fixed selector widths, absolute positioning or JavaScript resize listeners. Fixed widths cannot satisfy dynamic sidebar resizing; absolute positioning/resize handlers would add unnecessary layout coupling. No other product changes, version bump, installation, download, publication, main merge or cleanup are authorized.

## Verification and scope

Use a fresh `C:/git/infinitabs/.worktrees/sidebar-header-controls` worktree on `feat/sidebar-header-controls`, based on main `ac9f4ef`. Modify only `src/sidebar.html`, `src/styles.css`, `test/verify_mru_switcher.py`, `test/verify_settings_btn.py` and this task's design/plan. The obsolete mocked left-group-only settings script becomes a compatibility entrypoint for real-extension verification, avoiding duplicate mocks and unsafe file-page flags.

Prove clipping against current code before editing production. Verify real Rename/Refresh/Theme/Settings behavior; all four controls' order, same-row alignment, constant per-theme button dimensions, selector width tracking sidebar width, no horizontal overflow, and long session names at 240/280/320/420px in both themes. These are conservative test widths, not a claim about Chrome's actual minimum. Preserve existing MRU/search behavior through the complete Chromium regression harness and Node/Python suites. Retain browser profiles/screenshots in `C:/Users/33632/AppData/Local/Temp/opencode`, commit tested local milestones, then obtain one fresh-context read-only review.
