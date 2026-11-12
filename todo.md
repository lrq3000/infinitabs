# Future work

## Future Quick Tabs-inspired features

The initial MRU implementation intentionally concentrates on viewed logical tabs, shared Live Only filtering, fuzzy finding, keyboard switching and explicitly opted-in deleted-tab recovery; the items below are optional future extensions, not promises or changes to the canonical bookmark layout.

- [ ] General bookmark search (`/b`): add an explicit separate scope backed by native bookmark search, preserving the distinction between arbitrary bookmarks and session-owned logical tabs and mounting only the selected result.
- [ ] Browser-history search (`/h`): request the optional `history` permission only on explicit enablement, search Chrome's existing history on demand and never import page-navigation records into logical-tab MRU.
- [ ] Suggested bookmark fallback: when few MRU results match, offer an explicit Search bookmarks action instead of silently broadening the result set or mixing unrelated bookmarks into viewed-tab history.
- [ ] Query-prefix syntax: parse documented `/w`, `/p`, `/g`, `/b` and `/h` prefixes into the same explicit scope/filter objects used by visible controls, avoiding opaque whitespace-based mode switching.
- [ ] Additional search engines (`/fuzzy`, `/fuse`, `/regex`, `/subs`): retain MRU tie-breaking and bounded rendering while offering explicit per-query modes; vendor/license a maintained fuzzy engine only if it measurably improves results, and isolate/time-bound regular-expression execution.
- [ ] Current-window filter (`/w`): filter live projections by native window while keeping current-session scope distinct, because a session also contains unmounted logical tabs and can outlive its window.
- [ ] Pinned-tab filter (`/p`): filter mounted tabs by Chrome's pinned state without mounting saved tabs just to determine whether they are pinned; define any optional saved pin metadata as supplementary rather than canonical placement.
- [ ] Current-group filter (`/g`): derive membership from the canonical bookmark folder and resolve the source's active logical group, including unmounted group members when Live Only is off.
- [ ] Audible/noisy filter (`<))`): index native audible/muted state and expose an explicit filter without loading silent or unmounted logical tabs to inspect audio.
- [ ] Close from results or middle click: interpret quick close as unmounting the selected native projection while preserving its logical bookmark; make permanent logical deletion a separately labeled and confirmed action.
- [ ] Bulk close (`/close`): preview the matched mounted set, unmount it through existing close/fallback logic and preserve bookmarks, with permanent logical deletion offered only as a distinct opt-in operation.
- [ ] Duplicate selected/current tab: create a distinct canonical bookmark identity and use normal insertion/mounting paths, rather than URL deduplication or an untracked native-only duplicate; optionally expose a native shortcut.
- [ ] Merge into session/window (`/merge`): move canonical bookmarks to the chosen session and move their existing native projections consistently, preserving unmounted records without eagerly opening them.
- [ ] Split into session/window (`/split`): create a canonical session folder and move selected bookmark identities plus their mounted projections into it, leaving unmounted selections unloaded.
- [ ] Reload matched tabs (`/reload`): operate only on mounted/native results by default and never mass-mount saved logical tabs merely to reload them.
- [ ] Mute/unmute (`/mute`, `/unmute`): apply native audio changes to mounted results and make unsupported unmounted targets explicit instead of automatically opening them.
- [ ] Group matched results (`/group`): update canonical bookmark-folder membership first through shared movement logic and reconcile only existing native tab groups, preserving empty saved groups and unloaded tabs.
- [ ] Forward/back MRU cycling without a popup: maintain a short-lived frozen navigation sequence per source context so repeated shortcuts traverse earlier/later entries instead of oscillating between two immediately promoted tabs.
- [ ] Configurable dwell/update delay: distinguish committed viewing from transient keyboard cycling with an explicit, tested policy that survives worker sleeps, without requiring a keepalive timer or interfering with immediate previous-tab switching.
- [ ] Unify close-time fallback with logical MRU: adapt the existing live-only close policy through a small adapter only after compatibility tests prove it will not mount an unmounted logical tab merely because another tab closed.
- [ ] Tab-count badge: distinguish mounted/native count from logical count, update from lifecycle deltas and provide an opt-out rather than displaying an ambiguous global total.
- [ ] Result-display controls: share options for favicon/URL/tooltips, density and session labels across popup/sidebar while retaining accessible status and keyboard selection; never change bookmark content to implement display preferences.
- [ ] Custom CSS: allow explicit component-scoped styling against InfiniTabs theme tokens, keep it separate from canonical data and do not accept executable scripts or unrestricted external-resource injection.
- [ ] Remember last search: offer local, explicitly opted-in query retention with a clear reset action and no private-window leakage, rather than silently persisting potentially sensitive queries.
- [ ] Alternate result sorting: offer URL or native-window ordering as a view-only choice with MRU retained as the default; never reorder canonical bookmark folders as a side effect of a search.
- [ ] Optional physical tab reordering: make move-left/right-on-switch an explicit opt-in and route it through existing native/bookmark reconciliation, documenting that canonical layout can change instead of maintaining a second independent tab-order mapping.
- [ ] Explicit no-result navigation/search: present a separate Open URL or Search the web action with validated safe schemes and an explicit chosen provider, never reinterpret Enter on an empty MRU list as surprise navigation.
- [ ] History exclusion rules: if browser-history scope is enabled, apply documented local query/result exclusions with bounded regular expressions without copying a second full browsing-history database into the extension.
- [ ] Advanced shortcut preferences: expose links and effective bindings from Chrome's native commands configuration, reusing one command handler per action and clearly documenting browser/OS-reserved key combinations.
- [ ] Pinned/devtools visibility preferences: keep ordinary debugging/internal extension windows excluded by default and expose any advanced inclusion deliberately, without letting InfiniTabs' own switcher create phantom sessions or history.
- [ ] Private-window MRU: first verify and define the existing session/bookmark isolation model, then implement separate ephemeral recency and activation boundaries without enabling incognito access automatically or mixing private data into normal storage.

Reference inventory: [Quick Tabs features and commands](https://github.com/babyman/quick-tabs-chrome-extension); implementation inspiration does not imply that these optional capabilities are already available in InfiniTabs.
