# Recent tabs current-tab navigation design

## Intent and approved behavior

Recent tabs is a navigation pane: show the source browser window's current logical tab first and persistently highlighted, followed by older visited tabs. Apply this consistently to the sidebar and separate switcher. The user explicitly chose a separate keyboard cursor and ordinary search filtering of the current tab: a nonmatching current tab is hidden, not pinned above unrelated matches.

The current row uses the existing active background, a Current label, and `aria-current="page"`. Keyboard selection retains `aria-selected` and the combobox active descendant but uses a distinct outline rather than the active background. Moving the cursor never activates a tab; Enter or clicking does. Initially target the most recent older matching tab, falling back to the current tab when it is the only match, preserving quick switching.

An actual current-tab change returns the view to its first page and resets the keyboard target; ordinary refreshes preserve the cursor by identity. Home/End and explicit page navigation continue targeting their positional first/last rows. The current tab occupies one result slot and appears once, including when recency metadata has not yet been recorded. It is not sticky while the user deliberately pages through older results.

## Approaches

Chosen: update the shared query service, Chrome source context, view, and scoped styles. Derive the current identity from the existing native-to-logical mapping, promote it before slicing the result page, and keep keyboard selection separate from current-tab styling. This keeps both interfaces and pagination consistent without new persistent state.

Rejected: prepend a current row only in the sidebar DOM. Although locally smaller, this duplicates presentation logic, leaves the switcher inconsistent, and cannot correctly account for filtering, totals, or page boundaries. Replacing the MRU store or adding a separate current-tab preference is unnecessary.

## Interfaces and constraints

`MruChromeAdapter.context(sourceWindowId)` exposes `currentBookmarkId` instead of automatically excluding that identity. `MruService.query` accepts `currentBookmarkId` for promotion and retains `excludeBookmarkId` for explicit exclusions. The Previous tab command passes the current identity as its exclusion so it continues activating the previous tab rather than the current one.

Retain existing session scope, Live Only, recovery consent, existing search relevance among older matches, bounded page rendering, generation guards, popup dismissal, themes, and mounted/unmounted activation behavior. Do not manufacture visits or change bookmark placement. Query work remains linear in the candidate count apart from the existing bounded recovery sort; current identity lookup is O(1) in the existing catalog.

## Authorized scope and verification

Work only in `C:/git/infinitabs/.worktrees/recent-current-tab` on `feat/recent-current-tab`, created from `288d816f306da631d77a5ada7973961d5fe8fdb9`. The approved isolation check permits adding `/.worktrees/` to repository-local `.git/info/exclude`; tracked files on main and existing worktrees remain untouched.

Modify `src/mru/chrome-adapter.js`, `src/mru/service.js`, `src/mru/view.js`, `src/mru/mru.css`, `test/mru/service.test.mjs`, `test/mru/chrome-adapter.test.mjs`, `test/mru/view.test.mjs`, `test/verify_mru_switcher.py`, and `README.md`, plus this design and its accompanying plan. Implement natively in this session with one read-only fresh-context review before completion.

First demonstrate failing regressions, then pass the MRU and startup-restore Node tests and the existing isolated Chromium end-to-end runner, inspect light/dark screenshots, and run `git diff --check`. Use installed dependencies only. Keep QA profiles/screenshots under `C:/Users/33632/AppData/Local/Temp/opencode`; leave them for manual cleanup. Create coherent conventional local commits with OpenCode / OpenAI GPT-6.1 Sol attribution. No push, merge, installation, signing build, deletion, regular-browser-profile changes, or version bump before integration.
