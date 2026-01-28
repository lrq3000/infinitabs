# Technical Specification: Bidirectional Tab Synchronization

## Objective
Implement robust synchronization between "Live Tabs" (browser tabs) and "Logical Tabs" (bookmarks) such that reordering one list updates the other based on relative positioning.

## Core Logic: "Closest Previous Tab"
To maintain intuitive ordering without enforcing a strict 1:1 index mapping (which breaks when some tabs are closed/unmounted), we use the **Closest Previous** heuristic.

### 1. Live -> Logical (User moves a browser tab)
**Trigger:** `chrome.tabs.onMoved`
**Goal:** Move the corresponding bookmark to the correct position relative to its new neighbors.

**Algorithm:**
1. Identify the moved live tab (`movedTab`).
2. Find its corresponding `logicalTab`.
3. Look at the live tabs *before* the `movedTab` in the window (indices `0` to `movedTab.index - 1`).
4. Iterate backwards from the immediate predecessor:
   - Find the first live tab that *has* a corresponding `logicalTab`.
   - This is the `anchorTab`.
5. **If `anchorTab` exists:**
   - Move the `movedTab`'s bookmark to be immediately **after** the `anchorTab`'s bookmark.
6. **If no `anchorTab` exists** (moved to start, or all predecessors are unmapped):
   - Move the `movedTab`'s bookmark to the **start** of the session folder (index 0).

### 2. Logical -> Live (User moves a bookmark/sidebar item)
**Trigger:** `chrome.bookmarks.onMoved`
**Goal:** Move the actual browser tab to match the new logical order.

**Algorithm:**
1. Identify the moved bookmark.
2. Find the corresponding `logicalTab` in the session.
3. If the logical tab is **not live** (no `liveTabId`), stop (nothing to sync).
4. Look at the logical tabs *before* the moved bookmark in the same folder.
5. Iterate backwards from the immediate predecessor:
   - Find the first logical tab that is **currently live** (has a `liveTabId`).
   - This is the `anchorLogical`.
6. **If `anchorLogical` exists:**
   - Get the `liveTabId` of the `anchorLogical`.
   - Move the `movedLogical`'s live tab to be immediately **after** the `anchorLogical`'s live tab.
7. **If no `anchorLogical` exists:**
   - Move the live tab to the **start** of the window (index 0).

## Implementation Details

### `src/background.js`

#### New Listener: `chrome.bookmarks.onMoved`
- **Debouncing:** Essential to prevent rapid-fire updates if multiple bookmarks are moved programmatically.
- **Loop Prevention:** We must ensure that moving a bookmark (which moves a tab) doesn't trigger `tabs.onMoved` which tries to move the bookmark again.
  - *Strategy:* The "Closest Previous" logic is idempotent. If the tab is already in the correct relative position, the calculated target index will match the current index, resulting in a no-op or a move to the same index.

#### Refactor: `chrome.tabs.onMoved`
- Replace the current simple heuristic with the robust "Closest Previous" iteration described above.
- Handle cases where tabs are moved between windows (though `onMoved` is usually within-window; `onAttached`/`onDetached` handle cross-window). *Scope:* Focus on within-window `onMoved` for now.

#### Helper Functions
- `findClosestPreviousLiveLogical(session, logicalIndex)`: Returns the nearest preceding logical tab that is live.
- `findClosestPreviousMappedLiveTab(windowId, tabIndex)`: Returns the nearest preceding live tab that is mapped to a logical tab.

## Edge Cases
- **Pinned Tabs:** Pinned tabs usually stay at the start. The logic should respect them if they are mapped. If unmapped, they are ignored by the "Closest Previous" search.
- **Groups:** Moving a tab into/out of a group (folder) changes its hierarchy.
  - *Current Scope:* The prompt focuses on "position". Moving *into* a group is a hierarchy change. `bookmarks.onMoved` provides `parentId`. If `parentId` changes, we treat it as a move. The "Closest Previous" logic still applies within the *new* parent (group) context?
  - *Simplification:* For live tabs, "groups" are just visual separators or flat lists. If the sidebar supports groups, moving a bookmark *into* a group folder is valid. The live tab should just move relative to other live tabs in that group (or the flattened list).
  - *Decision:* We will treat the live tab order as a flattened projection of the logical hierarchy.
