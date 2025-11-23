# **InfiniTabs**

**Unlimited tabs. Zero clutter. Near-zero RAM.**
A radically new way to browse—built for researchers, power users, and anyone who regularly “declares tab bankruptcy.”

InfiniTabs lets you open a *theoretically infinite number of tabs and tab groups* without slowing down your browser, all within a familliar interface: browse as usual, but with superpowers.
It achieves this by cleanly separating **logical tabs** from **live tabs**, storing them as **native bookmarks**, and presenting them through a **persistent vertical sidebar tabstrip**.

---

## Description - What is InfiniTabs

Modern browsers force all open tabs to remain fully loaded in RAM.
Power users routinely accumulate hundreds or thousands of tabs across many windows, leading to:

* RAM exhaustion
* cognitive overload
* duplicate tab groups
* constant tab bankruptcy cycles
* slow tabstrip navigation
* slow recovery after crashes
* difficulty re-finding previously opened research threads

Although tabs suspenders exist, they only delay but do not eliminate RAM exhaustion, are prone to losing tabs on crash recovery, have discoverability issues (hard to search for a past tab in-context of the session), switching issues (reloading a past session requires reopening all tabs, even if suspended, causing RAM exhaustion, even if just to find one tab).

**InfiniTabs solves all of these problems at once** by replacing the traditional model with a fully persistent, crash-proof, unlimited tabs architecture, that looks just like an usual vertical tabs bar.

---

## Major Advantages of InfiniTabs

**1. Infinite Tabs, Zero RAM Usage**

You can open as many logical tabs as you want.
Only the ones you actively work on become live tabs.

**2. Automagical familiar UI**

Browse as usual with our vertical tabs bar, enjoy all the superpowers.

This is designed to provides the very same experience as a standard vertical tabs bar, all the magic happens automatically behind the scenes: open all the tabs you want, switch at any time to any other tab, close tabs, everything instantaneously. Most tabs you use will already be loaded, and you will only occasionally experience a slight delay, the time that the tab gets fetched if it was autosuspended.

**3. Never Declare Tab Bankruptcy Again**

Close all live tabs—your bookmarks/logical tabs remain perfectly intact.

**4. Optimized for deep research workflows**

InfiniTabs lets you:

* safely explore infinite rabbit holes
* without cluttering your working memory
* while preserving full retraceability even when closing the session at any time
* and keeping only a few active tasks visible
* Empowers neurodiversity (ADHD & Autism) workflows, allowing mixing depth search with breadth search and even immediate context switching and parallel multitasking with no slowdowns.

**5. Instant Session Switching**

Switching between past sessions:

* does **not** reload dozens or hundreds of tabs
* restores your entire workflow instantly
* mounts only the tabs you click but you keep the whole session context (neighboring tabs, tabs groups, window)

Switch back to a previous session in **under one second**.

**6. Full Crash Recovery**

Because everything is a bookmark:

* Crashes cannot destroy or lose any sessions, as they are saved way before a crash may happen
* Browser updates do not break the system
* You can extract all data even from a dead Chrome installation using external tools
* No periodic export needed, because all sessions changes are immediately synchronized on-disk

This is unmatched by any other session manager.

**7. Unified Search, Archiving, and AI Tools**

Since your sessions are simply bookmarks:

* External tools (past, present, future) can search, categorize, and archive them
* AI models can analyze your research corpus
* You are not locked into any proprietary format

**8. Human Cognition-Friendly Model**

InfiniTabs uses what we define as a decoupled split tabs model:

* Logical tab = reference to resource (also called "ghost tab")
* Live tab = temporary projection on the content (ie, the content is fetched in these tabs)

This leverages the cognitive limitations of the human brain to allow for a virtually infinite workspace illusion, while in reality only a very small subset of tabs are effectively loaded in-memory, just like how humans only work with a limited subset of less than 10 items at any time due to bounded working memory and attention.

---

## Installation

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `src` folder of this repository

---

## Quickstart

1. Open a new browser window.
2. Pin the InfiniTabs icon.
3. Click it to open the Side Panel.
4. A session named `Session – Window <ID>` appears automatically.
5. Close all native tabs—notice they remain visible in the InfiniTabs sidebar.
6. Click any item to mount it again as a live tab.

Note that on first launch, sessions are automatically created based on all open windows:
* All open tabs are captured
* Stored as the initial session for each window
* No risk of duplicate sessions, even if the extension is disabled and re-enabled later or after a crash, the sessions will be matched to the windows with no duplication.

For best usage, it is recommended to keep the native tabstrip horizontal, not vertical (although in practice there is no problem, but the experience was designed to work with two tabstrip: the virtual one being vertical, and the live "focus" tabstrip being horizontal).

---

## Key Interactions

* **Create a Logical Tab** : Open a tab → It instantly appears in the sidebar and is saved as a bookmark.

* **Mount (Restore) a Tab** : Click a sidebar item → it opens as a live tab.

* **Unmount Tabs** : Use “Unmount Others” to collapse the active set. This closes live tabs but preserves them all as logical tabs.

* **Switch Sessions** : Use the session selector to jump between windows' sessions instantly.

---

## Core Innovations and design choices

### Logical Tabs vs Live Tabs

InfiniTabs introduces a new browsing model by reconceptualizing two different types of tabs:

#### **Live Tabs**

* Real browser tabs visible in the horizontal tabstrip
* Loaded in RAM
* Temporary view on the page's content
* Only a *small subset* of your workflow
* You can focus on just a handful of active tasks
* Perfect for ADHD/autistic workflows: a *bounded working set*

#### **Logical Tabs**

* Persistent objects stored as bookmarks
* Unloaded by default → **no RAM footprint**
* Displayed in the **InfiniTabs vertical sidebar**
* Mount (open) instantly when you click them
* Can represent **tens of thousands of tabs** safely
* Survive crashes, reinstalls, browser changes, and future migrations

**This architecture allows the user to explore unlimited research threads without ever overwhelming RAM or cognition.**

The insight is that we do not need to keep all tabs in RAM, because they are only viewports on the content, so they are only useful when a human look at them, and hence the efficiency of tabs loading is directly bounded by human cognitive abilities and browser architectures. Since humans can only process one page's content (or a couple max with split views or multiple windows) per sensory modality (visual, auditor) at once, it is unnecessary to load more than that. In practice, cognitive science repetitively shown that humans can only keep about 7 items in working memory, hence even if we assume that this is per sensory modality, this makes a bounded total of 14 tabs that need to be kept open at all times.

This is very similar to what is done in attention research for other modalities such as vision, it is well known that the human brain has a sparse representation of the visual fields, so that only the center of the view (fovea) is actually high resolution and fully colored, whereas the peripheral vision is highly compressed and in fact a mix of very low-resolution uncolored visual peripheral information which the brain postprocesses into a "super-resolution" by mixing with predictive memory (expected environment from past high-resolution information of this spatial location/viewpoint). This is starting to get implemented in consumer-grade VR headsets such as Valve's as of Novembre 2025. We apply here essentially the same principles of bounded human cognitive attention to drastically bound the computer RAM footprint of internet browsing without losing any navigation functionality, and in fact even gaining some as a side effect (eg, instant switching/resuming to past sessions).

NB: Of course there are circumstances where keeping more tabs loaded in RAM is preferable or necessary, such as autorefreshed tabs or tabs for (ticketing) queues, but this is an exception rather than the rule and can easily be managed as such by temporarily disabling auto suspending on these tabs.

### Why Bookmarks as the Storage Layer?

InfiniTabs deliberately uses **native bookmarks** as canonical storage because they are:

#### Crash-proof

Bookmarks persist even if:

* the browser crashes
* the extension corrupts
* Chrome updates to a new extension manifest (eg, many extension lost precious users' data when Google forcefully uninstalled MV2 extensions)
* Chrome suddenly activates new TOS and uninstall extensions not fitting them
* the profile fails to load
* the extension is uninstalled
* the browser gets corrupted and cannot be launched anymore (no way to access the extension anymore)

It is a standard in all browsers that bookmarks are preserved as much as possible, whereas extensions internal storage can be freely manipulated with no particular care by the browser, with terms changing at any time.

#### File-format stable and future-proof

Bookmarks are simple:
**URL + title + position in the tree**
No hidden metadata, no proprietary formats, no database lock-in.

#### Interoperable with the entire bookmarks ecosystem

Because sessions = bookmark folders, you immediately gain compatibility with:

* bookmark full-text search tools
* bookmark fuzzy search engines
* bookmark AI classifiers
* third-party archival/summarization tools
* cloud sync (Chrome/Google account)
* offline extraction tools in case Chrome becomes unusable

This also enable other browser's extension that work on bookmarks (such as bookmarks fuzzy search engine, full-text search engine, auto bookmarks AI grouping, etc) to instantly extend their functionality to work on live tabs and live sessions too (since they are stored as bookmarks all the time with our extension).

Hence, the extension is conceived with a high modularity in mind, ala Linux, where it fits into an ecosystem where the user has the freedom to expand functionalities with third-party tools and extensions that work on bookmarks.

#### Infinite scalability

Chrome supports enormous bookmark trees. InfiniTabs becomes a limitless storage engine for your browsing universe, since it is not bounded by RAM anymore but only by storage space (and bookmarks have a negligible storage footprint).

### One Window = One Session

Each browser window corresponds to **one session**, saved as one bookmark folder:

```
LazyTabs Sessions
└── Session – Window 1234
    ├── Bookmark (Logical Tab 1)
    ├── Bookmark (Logical Tab 2)
    ├── Tab Group A (Folder)
    │   ├── Bookmark A1
    │   └── Bookmark A2
    └── Tab Group B (Folder)
        ├── Bookmark B1
        └── Bookmark B2
```

This means:

* Your workflow is segmented naturally
* Switching windows = switching sessions
* You can reopen any session instantly
* Logical tabs persist even if the window is closed
* Naturally possible to have multiple sessions/windows in parallel to do multitasking (eg, one window for documents writing, one for AI brainstorming, one for documents researching, one for listening to music, etc).

---

### Vertical Sidebar Tabstrip

InfiniTabs replaces the traditional horizontal tabstrip with:

#### A vertical, scrollable, limitless tabstrip

* Stores **logical tabs** (bookmarks)
* Displays live tabs with a clear indicator
* Allows thousands of items to be browsed effortlessly
* Integrates tightly with tab groups
* Supports reorder, mount, unmount, and session switching

#### Implemented as a Side Panel for robustness

This ensures the sidebar always displays—even on:

* `chrome://` pages
* Extension store pages
* Pages during loading
* Crash states
* Pages that temporarily disable extension scripts

#### Known Chrome limitation

Chrome’s Side Panel currently cannot:

* auto-collapse
* be resized below a certain width
* collapse to icons-only

But these trade-offs are worth the reliability and universal visibility.

---

## Troubleshooting

* **Background logs:**
  Chrome Extensions → Find InfiniTabs → “service worker” link → Console
* **Sidebar logs:**
  Open Side Panel → Right-click → Inspect
* **Bookmark integrity:**
  Check the `LazyTabs Sessions` folder in Bookmark Manager

---

## Roadmap

Future releases will introduce:

* Automatic tab suspension into logical tabs
* Full-text search of session content
* AI grouping and semantic clustering
* Cross-session analytics
* Sorting, filtering, tagging
* Firefox port
* Edge and other Chromium-based browsers

## Author

Authored by Stephen Karl Larroque.

Conceptualized by the author.
Implementation by agentic coding under supervision (Google's Jules with Gemini 3 Pro + VSCode Kilo Code with Grok Code Fast 1).

## License

Licensed under the MIT Public License.

## Suggested complementary 3rd-party extensions/tools

Here is a non-exhaustive list of complementary **opensource** 3rd-party extensions or tools that work well with InfiniTabs:
* [Search Bookmarks, History and Tabs](https://github.com/Fannon/search-bookmarks-history-and-tabs): Fast bookmarks fuzzy search engine
* [Full text tabs forever (FTTF)](https://github.com/iansinnott/full-text-tabs-forever): Full-text search of historically visited pages (once you have the page title, you can find it in InfiniTabs)
* [Floccus](https://github.com/floccusaddon/floccus): Autosync bookmarks (and hence sessions if using InfiniTabs) between browsers (also works on mobile via native Floccus app on F-Droid or [Mises](https://github.com/mises-id/mises-browser-core) or [Cromite](https://github.com/uazo/cromite/)).
* [TidyMark](https://github.com/PanHywel/TidyMark): Reorganize/group bookmarks (supports cloud or offline ollama).
* [Bookmarks Summarizer](https://github.com/lrq3000/BookmarkSummarizer): Python app for full text search on content and AI-generated summaries (using cloud or offline ollama). (Untested alternatives: ArchiveBox, LinkWarden, other self-hosted bookmarks managers...).
* [Wherewasi](https://github.com/Jay-Karia/wherewasi): Temporal and semantic tabs clustering into sessions using cloud Gemini AI.
* [Bookmarks Manager & Viewer](https://github.com/inbasic/bookmarks-manager): A very reactive and clear tree-like manager for bookmarks, can be used to find past bookmarks and in which past sessions they were.
