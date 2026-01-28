# Infinitabs prompt and notes

## Notes

* Just in time post-processing of the sessions: instead of requiring the user to classify asap the tabs before saving, which replaces the chore of triaging open tabs which is never done because it is too time consuming, the insight here is to find a way to save all the open tabs fast in a way that is modular enough in that it allows to later: 1. classify the saved tabs, 2. renavigate/reopen select tabs without having to reopen the whole session, 3. sch through the tabs and especially the pages content (this compensates for the closing of the tabs, we can always access the content without having the tab open). Hence, the idea I suggest is to do "lazy tabs management" or "JIT tabs management": first and foremost find a way to store tabs so that all kinds of postprocessing can be done afterwards on the saved tabs.

I propose the storage system based on bookmarks as a way to overcome the siloing of databases, this opens up a lot of versatility and modularity potential by allowing other apps to do further postprocessing easily on bookmarks and hence on tabs sessions, such as auto archival or summarization or reorganization/grouping, etc.

But how to organize is not clear to me. At the minimum, I think we should keep the metadata about the windows and the tabs groups, so that we should save in nested folders (one nested level for the window's title, and another nested level for tabs groups).

Then we need a way to explore a saved session (a bookmarked session) as if it was a live session, with live tabs, but in fact only one tab is open at a time. This would fit most needs, because most of the time we don't need to have multiple tabs open, we can just have one or two or a couple, but the user needs to be able to add tabs and that they are added to the bookmarked session transparently. But other times, the user needs multiple tabs to stay open simultaneously, ex to listen to music at the same time, so there should not be just a single tab open at a time, it should be the tabs used in the last 30min for example, like a suspender.

So yes I think there needs to be three systems merged in one:
* a tabs suspender that suspend tabs into bookmarks, overwriting already saved bookmarks and deleting them on close.
* a sessions bookmarker that would allow to quickly switch between sessions or dump one. Switching to another session would not open all tabs but show the list of tabs in a virtual tabs bar that would allow to lazily load the selected tabs, not all the tabs.
* a fake navbar that would display bookmarks in a folder as if they were real live tabs. Such as a vertical tabs bar. This virtual navbar would have the very crucial role of lazily loading sessions, by only loading in memory the selected tabs, and showing others as if they were in memory.

I think the breakthrough here is to subvert the tabs suspender concept into in fact an auto session updater. Instead of suspending tabs, a stale tab would simply be bookmarked and unloaded from memory (but still visible as a fake tab in the fake navbar).

However, the challenge is to know what rules that the tabs suspender should follow to update the bookmarks using live open tabs, because we do not want to repeat bookmarking the same tabs over and over again, but we also do want to bookmark new tabs and updated tabs (a tab where we clicked on a link to visit another URL in the same tab).

Because the issue with the usual tabs stashing method is that you never want to reopen a past stash/session because it will be too big, you have too many tabs, so you just open a subset of tabs. But then, if you do that, you will likely continue your search on the topic, so you will add tabs, and then save a new session. So now, you have two sessions, the old one with lots of tabs, and the new one with new tabs but also a mix of old tabs that you opened in the subset of URLs but did not have time to process before stashing today's tabs, so this leads to fragmentation. This is why an effective solution should be able to load a subset of tabs from a past big session, but it should be able to add new URLs and changed tabs back into the old session, dynamically and transparently and very reliably.

Since we use bookmarks with this system, I already know of 3rd-party tools to search through bookmarks, and even index the content of the pages linked by the bookmarks and summarize the content and then thiscontent can be searched, enabling some form of semantic search but much faster and complete than a semantic search based on URL.

But we would need a search system that once a matching tab is found, it would say which is the session. Or even better, allow to preview the rest of the tabs in the same folder/session.

* Best tabs sessions management combo:
    * My JIT lazy tabs sessions manager with a virtual vertical navbar (replacing Phew AI Tab). With an auto suspender to bookmarks, and tabs being a cache view.
    * Fast bookmarks search engine (would be even better if integrated, so that it would highlight the session if it is in one)
    * Full text tabs forever (FTTF)
    * Floccus to autosync between browsers
    * TidyMap to reorganize/group bookmarks (makes a virtual tabs groups).
    * Bookmarks Summarizer python app for full text search on content and summaries
    * Wherewasi for temporal clustering

* [ ] update another session manager to be a simpler autosession save and sessions switcher and save all tabs in current window as a session (with tabs groups - this it what chrome already does but it takes time because it asks where to save, what folder name etc - instead user selects once in params where to save sessions, then they are autocreated with folder name being a concatenation of the first words of all contained tabs groups and date time, use can edit later). So it will generate sessions that will be compatible with my other virtual navbar extension later if I cannot make it now.

* [ ] TOP ME AI LLM PROMPT : Try to be innovative, and to think in a first principles way. Suggest several other options.

## Prompt (add the specs file after)

You are an expert browser extension engineer and UX designer.
 Your task is to design and implement the **first core version** of a Chrome extension (later portable to Firefox) that introduces a **virtual vertical tabstrip** backed by bookmarks, with a clean conceptual separation between:

* **Logical tabs** (persistent, stored as bookmarks)
* **Live tabs** (real browser tabs, a small active subset)

This prompt describes the overall **goal**, **architecture**, and **design choices** you must follow. It is intentionally high level: you must translate these concepts into concrete APIs, data models, and code structure yourself.

------

## 1. Overall Product Goal

Build an extension that lets a power user manage very large numbers of tabs without RAM explosion or cognitive overload, by:

* Treating the **native browser tabs** as a small, temporary working set (the “live” tabs).
* Treating **bookmarks** as the canonical, persistent record of all tabs in a session (the “logical” tabs).
* Providing a **vertical sidebar navstrip** that shows all logical tabs for the current window, and clearly indicates which ones are currently live.

The vertical navstrip is the **primary navigation and management UI** for tabs in a window.
 The native tabstrip remains visible and is used only for the small active subset of live tabs.

------

## 2. Core Conceptual Model

### 2.1. One window = one session

* Each browser window corresponds to one **session**.
* A session is represented by a dedicated **bookmark folder**.
* Within that folder, each bookmark entry corresponds to a **logical tab** for that window.
* **Tabs groups** are stored as **bookmark subfolders** (exactly one level deep), populated with bookmarks. There are no nested subfolders beyond the second level.

Here is an illustration of a sample tree:

```
Browser
├── Window 1  (Session 1 Bookmark Folder)
│   ├── Logical Tab 1  (Bookmark)
│   ├── Logical Tab 2  (Bookmark)
│   ├── Tab Group A    (Subfolder)
│   │   ├── Logical Tab A1  (Bookmark)
│   │   └── Logical Tab A2  (Bookmark)
│   └── Tab Group B    (Subfolder)
│       ├── Logical Tab B1  (Bookmark)
│       └── Logical Tab B2  (Bookmark)
│
└── Window 2  (Session 2 Bookmark Folder)
    ├── Logical Tab 1  (Bookmark)
    └── Tab Group C    (Subfolder)
        ├── Logical Tab C1  (Bookmark)
        └── Logical Tab C2  (Bookmark)
```

### 2.2. Logical tabs vs live tabs

* A **logical tab** is a durable object representing “this page belongs to this session at this position”.
    * It is stored as a bookmark (URL + title) in a session-specific folder.
    * The **order** of bookmarks in that folder represents the tab order in the session.
* A **live tab** is an actual browser tab: it has a tab in the native tabstrip, can be active, can be closed, etc.
    * Live tabs are just a **cache / materialization** of logical tabs.
    * Only a small subset of logical tabs is live at any time.

### 2.3. Vertical virtual navstrip (sidebar)

* The extension exposes a **persistent vertical navstrip** in a sidebar (Chrome Side Panel; later Firefox sidebar).
* This navstrip:
    * Lists all logical tabs for the current window, in order.
    * Highlights which logical tabs currently have a live tab attached.
    * Allows the user to click a logical tab to open or focus the corresponding live tab.
    * Allows basic operations via mouse and context menu (and later keyboard shortcuts).

The user should be able to **navigate and manage the entire session from the sidebar**, without needing to see all tabs in the native tabstrip.

Essentially, the vertical virtual navstrip is a way to show bookmarks as if they were navigation tabs, with transparent just-in-time loading of the selected bookmarks as real tabs. This allows several benefits:

1. automatic persistence even if the session/window is closed (because everything is always saved as bookmarks).
2. much reduced RAM footprint, since most tabs can just remain as bookmarks and do not need to be active (eg, links opened as background tabs should by default be saved as bookmarks and not loaded as live tabs until selected later by the user). In other words, this allows to do deep research sessions involving opening lots and lots of links in the background without hogging the RAM as they just get saved as bookmarks / logical tabs. This also avoids fragmentation since the user do not need to open a new window anymore because of tabs bankruptcy (ie, having too many tabs to navigate / load in RAM), here they can continue to navigate and open links in the same session and tabs groups that are the most pertinent for their task at hand. This hence allows to open new windows only to start new sessions to handle new tasks, not to free up RAM or space.
3. the native tabstrip will serve as a natural way for the user to focus on just a couple of live tabs among all the logical tabs in the current session, although the vertical navstrip should also offer a way to filter the bookmarks to only show the ones that are live.
4. ease and speed up tremendously switching between sessions, because the just-in-time / lazy live tabs loading of just the selected logical tabs allows to open sessions with any number of bookmarks / logical tabs, since in reality the vertical navstrip will just display the bookmarks / logical tabs list for this session (and logical tabs groups) but won't load all logical tabs, only the selected ones.

------

## 3. Phase 1 Scope (What you must implement now)

For this first version, focus on implementing:

### 3.1. Session ↔ bookmarks structure

* For each window, maintain (or create on demand) a **session bookmark folder**.
* Use that folder’s children as the **ordered list of logical tabs**.
* Keep the bookmark structure simple and flat for now:
    * One folder per window.
    * One bookmark per logical tab.
    * Bookmark order = logical tab order.

### 3.2. Vertical navstrip UI

* Implement a **sidebar UI** that:
    * Shows all logical tabs (bookmarks) for the current window.
    * For each logical tab entry, display:
        * A favicon (if easily obtainable)
        * The tab title
        * A visual indicator that the tab is live (for example bold text, an icon, or highlight) if there is a corresponding live browser tab.
    * Allows clicking a logical tab to:
        * If a live tab already exists for it: focus that live tab.
            * When you create the live tab, also maintain a clear internal mapping between live tab IDs and logical tab entries so the system always knows “which live tab corresponds to which logical tab”, so that any change in the live tab (navigating to other URLs, closing, reordering, etc) can be reflected to the logical tab instantly.
        * If no live tab exists: create a new live tab for that logical tab in the current window and attach it.

### 3.3. Automatic syncing between logical tabs and live tabs

You must keep logical tabs (bookmarks) and live tabs in sync **both ways**:

* When a **new tab is created** in a window that belongs to a session:
    * Insert a corresponding logical tab in the correct position in the session’s bookmark folder (or in a logical tabs groups / bookmark subfolder if the live tab is created in a tabs group).
* When a tab’s **URL or title changes**:
    * Update the corresponding bookmark.
* When a live tab is **reordered** in the native tabstrip:
    * Mirror the ordering in the logical tabs (and bookmarks). Since not all logical tabs are open, you may need to guess where to place the live tab in the logical tabs session. A simple rule of thumb is: if there are at least two live tabs, and one is moved, move the logical tab to be just after the live tab directly to the left.
        * For example: if there are five logical tabs: giraffe, bird, dog, fish, cat. And there are three live tabs: giraffe, dog, cat. And now if I move the live tab "cat" to be after "giraffe": giraffe, cat, dog. Then the logical tabs should be ordered this way: giraffe, cat, bird, dog, fish. With "cat" also being just after "giraffe" in logical tabs too.
* When a tab is placed inside or outside a **tabs group**:
    * Also move the corresponding logical tab inside or outside the tab group accordingly.
* When a tab is **closed**:
    * Remove its “live” indicator in the sidebar.
    * Decide whether the logical tab stays (default for now: keep the bookmark; closing the live tab does not delete the logical tab - but closing the logical tab does delete the bookmark - but offer a setting to change this behavior and allow closing the live tab to delete the logical tab / bookmark).

Use a clear internal mapping between real tab IDs and logical tab entries so the system always knows “which live tab corresponds to which logical tab”.

### 3.4. Manual “unmount” operation from the vertical navstrip

Implement a **manual bulk unmount action** accessible from the vertical navstrip via a context menu or similar interaction:

* The user can invoke an action such as “Unmount all live tabs except this one” or “Unmount all live tabs except selected ones”.
* “Unmount” means:
    * Close the corresponding live tabs in the browser.
    * Keep their logical tabs intact as bookmarks in the session.

This is conceptually similar to “Close tabs to the right”, but:

* It operates on **the whole live set** within the session.
* It **does not delete** any logical tabs or bookmarks.
* It simply collapses the active working set back to a minimal number of live tabs (for example, only the current one).

This operation is essential for reducing RAM load and visual clutter while preserving the full session state.

### 3.5 Sessions listing and switching

Offer a button to display a list of sessions, essentially just a list of top-level sessions bookmarks folders, and allow to quickly switch the current window to the selected session. Clicking on another session's name would instantly unmount all current live tabs, and mount the last active tab in the selected session. And simultaneously, the side bar should switch to show all the logical tabs in the session.

------

## 4. Design Constraints and Intentional Choices

When designing and implementing, respect these constraints and choices:

1. **Do not try to replace or override the native tabstrip.**
    * The native tabstrip remains visible.
    * It shows only the small active subset of live tabs.
    * Standard shortcuts like `Ctrl+W` and `Ctrl+Tab` continue to work on live tabs.
2. **The sidebar navstrip is the canonical view of the session.**
    * It always reflects the full set of logical tabs.
    * It visually marks which ones are currently live.
    * It is independent of page loading state and remains visible even while pages load.
3. **Bookmarks are the canonical storage for logical tabs.**
    * Treat bookmarks as the persistent “source of truth” for each session’s tab list.
    * Design the structure to be exportable and compatible with external tools that index bookmarks (ie, simply use bookmarks with no metadata and keep the bookmarks' URLs and titles as they are originally, do not add tags in them).
4. **Keep the internal architecture general enough to extend later.**
    * You must anticipate future integration of an **automatic tabs suspender into bookmarks** (for example, based on idle time or memory pressure) that will close live tabs and rely entirely on logical tab representation (ie, contrary to other tabs suspenders, this one would save the live tabs into bookmarks / logical tabs and close the live tabs to free memory and cognitive clutter in the native tabstrip).
    * Leave clear boundaries in the design (modules, functions) so this future suspender can plug in without redesigning everything.
5. **Sessions are per-window, not global.**
    * Each window manages its own logical tabs and bookmark folder.
    * The sidebar view is scoped to the current window’s session.
    * Different windows display different sessions in parallel. This is important to allow multitasking workflows, or activities segregation (eg, one window for work tasks, another for music or entertainment videos, another for a videocall, etc.).

------

## 5. Non-goals for this first version

For this phase, **do not**:

* Implement advanced grouping, tagging, or multi-level folder structures.
* Implement automatic tab suspension logic (just reserve architectural space for it).
* Implement cross-window analytics or global search across sessions.
* Override native shortcuts globally.

Focus on:

* The **vertical sidebar navstrip**
* **Logical tabs stored as bookmarks**
* **Live tab mounting on click**
* **Robust two-way synchronization** between bookmarks and live tabs
* **Manual bulk unmount action** to reduce live tabs to a minimal set

------

## 6. Architectural Expectations

When you design the code, aim for:

* **Clear separation of concerns**:
    * A **session / logical tab manager** responsible for the mapping between windows <=> sessions, logical tabs <=> bookmarks.
    * A **live tab sync layer** that listens to tab events and updates the logical model and bookmarks.
    * A **sidebar UI layer** that reads from the logical model and sends user actions back to the background logic.
* **Robustness and determinism**:
    * The system must always be able to reconstruct the session state from bookmarks and current tabs after a browser restart.
    * Behavior should be predictable and not depend on timing quirks.
* **Extensibility**:
    * Make it easy to attach future features such as:
        * Automatic tab suspension into bookmarks.
        * Advanced session operations.
        * Content indexing on bookmarked pages.

------

## 7. Implementation Targets

* Target **Chrome MV3** first, using the side panel for the vertical navstrip.
* Design the architecture to be cross-browser so it can later be adapted to **Firefox** using its sidebar APIs with minimal changes.

You now have the conceptual and architectural description of the project.
 Use this as your high-level guide when designing data structures, APIs usage, event handlers, and UI components.