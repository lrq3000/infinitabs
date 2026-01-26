// background.js
importScripts('utils.js');

// --- Constants ---
const ROOT_FOLDER_TITLE = "InfiniTabs Sessions";

// --- Global State ---
// Held in memory, persisted where necessary.
const state = {
    sessionsById: {},     // Record<SessionId, Session>
    windowToSession: {},  // Record<WindowId, SessionId>
    tabToLogical: {},     // Record<TabId, LogicalTabId>
    liveGroupToBookmark: {}, // Record<LiveGroupId, BookmarkId>
    sessionMountedTabs: {}, // Record<SessionId, { mountedIds: LogicalId[], lastActiveId: LogicalId }>
    ignoreMoveEventsForTabIds: new Set(), // Set<TabId>
    isCreatingGroup: false, // Flag to suppress bookmark creation during programmatic group creation
    pendingGroupCreations: {}, // Record<LiveGroupId, Promise<BookmarkId>> - Locks for group creation
    workspaceHistory: [], // Array<WorkspaceSnapshot>
    favoriteWorkspaces: [], // Array<WorkspaceSnapshot>
    lastKnownWorkspace: null, // WorkspaceSnapshot
    historySize: 50,
    reloadOnRestart: false, // User Preference
    restoreMountedTabs: false, // User Preference
    selectLastActiveTab: true, // User Preference
    maxTabHistory: 100, // User Preference
    tabHistory: {}, // Record<WindowId, Array<TabId>> - MRU Stack
    initialized: false
};


// Global flag to suppress auto-session creation during restore
// Kept outside 'state' object to ensure it's not accidentally reset or lost during state operations
let isRestoring = false;

const pendingMounts = []; // Queue of { logicalId, windowId }

// --- Helper Functions ---
// Queue for serializing move operations to handle group moves (SHIFT+Drag)
const moveMutex = new class {
    constructor() { this.p = Promise.resolve(); }
    run(fn) {
        this.p = this.p.then(fn).catch(e => console.error("Mutex error", e));
        return this.p;
    }
}();

function formatSessionTitle(name, windowId) {
    if (windowId) {
        // Remove any existing windowId from the name to avoid duplication
        const cleanName = name.replace(/ \[windowId:\d+\]$/, '');
        return `${cleanName} [windowId:${windowId}]`;
    }
    return name;
}

function parseSessionTitle(title) {
    const match = title.match(/^(.*?) \[windowId:(\d+)\]$/);
    if (match) {
        return {
            name: match[1].trim(),
            windowId: parseInt(match[2], 10)
        };
    }
    return { name: title, windowId: null };
}

function generateGuid() {
    return self.crypto.randomUUID();
}

/**
 * Tries to activate the previous tab from history, excluding specified tabs.
 * @param {number} windowId
 * @param {Array<number>} excludingTabIds
 */
async function activatePreviousTab(windowId, excludingTabIds = []) {
    if (!state.selectLastActiveTab) return;

    const history = state.tabHistory[windowId];
    if (!history || history.length === 0) return;

    const excludingSet = new Set(excludingTabIds);

    // Iterate backwards through the MRU history to find the most recently active tab that is still valid.
    // We iterate backwards because the end of the array contains the most recent tabs.
    // We also check against 'excludingSet' to ensure we don't try to activate a tab that is currently being closed.
    for (let i = history.length - 1; i >= 0; i--) {
        const tabId = history[i];
        if (excludingSet.has(tabId)) continue;

        try {
            const tab = await chrome.tabs.get(tabId);
            // Verify it is still in the same window (should be)
            if (tab.windowId === windowId) {
                await chrome.tabs.update(tabId, { active: true });
                return; // Done
            }
        } catch (e) {
            // Tab doesn't exist anymore, clean up stale entry
            // This might happen if onRemoved hasn't fired yet or race condition
            // state.tabHistory[windowId] refers to the live array
            const currentHistory = state.tabHistory[windowId];
            const currentIdx = currentHistory.indexOf(tabId);
            if (currentIdx !== -1) currentHistory.splice(currentIdx, 1);
        }
    }
}

/**
 * Gets or creates a bookmark folder for a given live group ID.
 * Uses a lock mechanism to prevent duplicate folders from race conditions.
 * @param {number} groupId - The live group ID.
 * @param {number} windowId - The window ID.
 * @returns {Promise<string|null>} The bookmark ID.
 */
async function getOrCreateGroupBookmark(groupId, windowId) {
    if (!groupId || groupId === -1) return null;

    // 1. Check existing mapping
    if (state.liveGroupToBookmark[groupId]) {
        return state.liveGroupToBookmark[groupId];
    }

    // 2. Check pending creation
    if (state.pendingGroupCreations[groupId]) {
        return state.pendingGroupCreations[groupId];
    }

    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return null;

    // 3. Start creation process
    const creationPromise = (async () => {
        try {
            // Debounce: Wait a bit to allow other extensions (e.g. Tabius) to rename the group
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Re-check session binding after debounce in case the window was rebound
            const currentSessionId = state.windowToSession[windowId];
            if (!currentSessionId || currentSessionId !== sessionId) {
                return null;
            }

            // Fetch group details
            let groupInfo;
            try {
                groupInfo = await chrome.tabGroups.get(groupId);
            } catch (e) {
                // Group might be gone
                return null;
            }

            const title = formatGroupTitle(groupInfo.title, groupInfo.color);
            const created = await chrome.bookmarks.create({
                parentId: currentSessionId,
                title: title
            });

            // Ensure adequate placement of new logical tab groups in sidebar by:
            // 1. Querying the live tabs in the window.
            // 2. Identifying the tabs belonging to the new group.
            // 3. Finding the closest preceding "anchor" tab (a live tab with a corresponding logical tab).
            // 4. Inserting the new group folder bookmark immediately after the anchor tab (or its parent group folder if the anchor is grouped).
            // This ensures that the sidebar order reflects the visual order of tabs and groups in the native live tabs strip.
            return moveMutex.run(async () => {
                let insertIndex = null;
                try {
                    const tabs = await chrome.tabs.query({ windowId });
                    const groupTabs = tabs.filter(t => t.groupId === groupId).sort((a, b) => a.index - b.index);

                    if (groupTabs.length > 0) {
                        const firstTab = groupTabs[0];
                        let anchorLogical = null;

                    // Build index-to-tab map for O(1) lookups
                    const tabByIndex = new Map(tabs.map(t => [t.index, t]));

                        // Find closest preceding live tab that is mapped
                        for (let i = firstTab.index - 1; i >= 0; i--) {
                        const tab = tabByIndex.get(i);
                            if (tab) {
                                const lid = state.tabToLogical[tab.id];
                                if (lid) {
                                    // Find the logical tab object to get bookmark ID
                                    const session = state.sessionsById[sessionId];
                                    if (session) {
                                        anchorLogical = session.logicalTabs.find(l => l.logicalId === lid);
                                        if (anchorLogical) break;
                                    }
                                }
                            }
                        }

                        if (anchorLogical) {
                            const anchorNodes = await chrome.bookmarks.get(anchorLogical.bookmarkId);
                            if (anchorNodes && anchorNodes.length > 0) {
                                const anchorNode = anchorNodes[0];
                                if (anchorNode.parentId !== sessionId) {
                                    // Anchor is in a subfolder (another group)
                                    // We place AFTER that group folder
                                    const folderNodes = await chrome.bookmarks.get(anchorNode.parentId);
                                    if (folderNodes && folderNodes.length > 0) {
                                        insertIndex = folderNodes[0].index + 1;
                                    }
                                } else {
                                    // Anchor is in root
                                    insertIndex = anchorNode.index + 1;
                                }
                            }
                        } else {
                            // No anchor found to the left -> start of list
                            insertIndex = 0;
                        }
                    }
                } catch (e) {
                    console.warn("Failed to calculate group insertion index", e);
                }

                const createData = {
                    parentId: sessionId,
                    title: title
                };
                if (insertIndex !== null) {
                    createData.index = insertIndex;
                }

                const created = await chrome.bookmarks.create(createData);

                state.liveGroupToBookmark[groupId] = created.id;

                // Reload session to reflect new group
                await reloadSessionAndPreserveState(sessionId, windowId);
                notifySidebarStateUpdated(windowId, sessionId);

                return created.id;
            });
        } catch (e) {
            console.error("Failed to create bookmark folder for group", e);
            return null;
        } finally {
            delete state.pendingGroupCreations[groupId];
        }
    })();

    state.pendingGroupCreations[groupId] = creationPromise;
    return creationPromise;
}

/**
 * Ensures that a live group exists for a logical tab if applicable, and adds the tab to it.
 * @param {number} tabId - The live tab ID.
 * @param {string} logicalGroupId - The logical group ID (bookmark folder ID).
 * @param {Object} session - The current session object.
 */
async function ensureLiveGroupForLogicalTab(tabId, logicalGroupId, session) {
    if (!logicalGroupId) return;

    // Try to resolve live group
    let liveGroupId = parseInt(Object.keys(state.liveGroupToBookmark).find(key => state.liveGroupToBookmark[key] === logicalGroupId));

    // If no live group exists for this bookmark folder, create one?
    if (!liveGroupId || isNaN(liveGroupId)) {
        try {
            // We need the group title/color from the session
            const groupInfo = session.groups[logicalGroupId];
            const parsed = parseGroupTitle(groupInfo.title);
            const title = parsed.name;
            const color = parsed.color;

            // Set flag to suppress onCreated/onUpdated listeners
            state.isCreatingGroup = true;

            liveGroupId = await chrome.tabs.group({ tabIds: tabId });
            state.liveGroupToBookmark[liveGroupId] = logicalGroupId;

            await chrome.tabGroups.update(liveGroupId, { title: title, color: color });
        } catch (e) {
            console.error("Failed to restore live group", e);
        } finally {
            state.isCreatingGroup = false;
        }
    } else {
        // Add to existing group
        try {
            await chrome.tabs.group({ groupId: liveGroupId, tabIds: tabId });
        } catch (e) {
            // Maybe group ceased to exist?
            delete state.liveGroupToBookmark[liveGroupId];
            // Retry creation? (omitted for brevity)
        }
    }
}

// Debounce helper
const bookmarkUpdateTimers = {}; // logicalId -> timerId
let sidebarUpdateTimer = null;
let workspaceUpdateTimer = null;

function scheduleBookmarkUpdate(logicalId, updateFn, delay = 2000) {
    if (bookmarkUpdateTimers[logicalId]) {
        clearTimeout(bookmarkUpdateTimers[logicalId]);
    }
    bookmarkUpdateTimers[logicalId] = setTimeout(() => {
        delete bookmarkUpdateTimers[logicalId];
        updateFn();
    }, delay);
}

function scheduleSidebarUpdate(windowId, sessionId, delay = 200) {
    if (sidebarUpdateTimer) {
        clearTimeout(sidebarUpdateTimer);
    }
    sidebarUpdateTimer = setTimeout(() => {
        sidebarUpdateTimer = null;
        notifySidebarStateUpdated(windowId, sessionId);
    }, delay);
}

function scheduleWorkspaceUpdate(delay = 1000) {
    if (workspaceUpdateTimer) {
        clearTimeout(workspaceUpdateTimer);
    }
    workspaceUpdateTimer = setTimeout(() => {
        workspaceUpdateTimer = null;
        trackCurrentWorkspace();
    }, delay);
}

let mountedTabsUpdateTimer = null;
function scheduleMountedTabsUpdate(delay = 2000) {
    if (mountedTabsUpdateTimer) clearTimeout(mountedTabsUpdateTimer);
    mountedTabsUpdateTimer = setTimeout(() => {
        mountedTabsUpdateTimer = null;
        persistMountedTabs();
    }, delay);
}

async function persistMountedTabs() {
    // Rebuild the state from current memory to ensure consistency
    const mountedState = {};
    for (const sessionId of Object.keys(state.sessionsById)) {
        const session = state.sessionsById[sessionId];
        if (!session) continue;

        const mountedIds = session.logicalTabs
            .filter(lt => lt.liveTabIds.length > 0)
            .map(lt => lt.logicalId);

        if (mountedIds.length > 0 || session.lastActiveLogicalTabId) {
            mountedState[sessionId] = {
                mountedIds: mountedIds,
                lastActiveId: session.lastActiveLogicalTabId
            };
        }
    }

    state.sessionMountedTabs = mountedState;
    await chrome.storage.local.set({ sessionMountedTabs: mountedState });
}

async function restoreMountedTabsForSession(sessionId, windowId) {
    if (!state.restoreMountedTabs) return;

    const mountedInfo = state.sessionMountedTabs[sessionId];
    if (!mountedInfo || !mountedInfo.mountedIds) return;

    const session = state.sessionsById[sessionId];
    if (!session) return;

    const mountedSet = new Set(mountedInfo.mountedIds);
    const toMount = session.logicalTabs.filter(lt =>
        mountedSet.has(lt.logicalId) && lt.liveTabIds.length === 0
    );

    if (toMount.length === 0) return;

    console.log(`Restoring ${toMount.length} mounted tabs for session ${sessionId}`);

    // Sort by index in session to preserve order
    toMount.sort((a, b) => a.indexInSession - b.indexInSession);

    for (const logical of toMount) {
        try {
             const pendingEntry = { logicalId: logical.logicalId, windowId };
             pendingMounts.push(pendingEntry);

             const tab = await chrome.tabs.create({
                 windowId,
                 url: logical.url,
                 active: false
             });

             // Ensure group mapping
             if (logical.groupId) {
                 await ensureLiveGroupForLogicalTab(tab.id, logical.groupId, session);
             }
        } catch (e) {
            console.error("Failed to restore tab", e);
        }
    }

    // Restore active tab
    if (mountedInfo.lastActiveId) {
        // Wait a bit for tabs to be created and attached
        setTimeout(async () => {
            const logical = session.logicalTabs.find(l => l.logicalId === mountedInfo.lastActiveId);
            if (logical && logical.liveTabIds.length > 0) {
                const tabId = logical.liveTabIds[0];
                try {
                    await chrome.tabs.update(tabId, { active: true });
                } catch(e) {}
            }
        }, 500);
    }
}

/**
 * Ensures the root bookmark folder exists.
 * @returns {Promise<string>} The ID of the root folder.
 */
async function ensureRootFolder() {
    // Check for the new folder first
    let existing = await chrome.bookmarks.search({ title: ROOT_FOLDER_TITLE });
    let folder = existing.find(n => n.title === ROOT_FOLDER_TITLE && !n.url);
    if (folder) return folder.id;

    // Check for the old folder to migrate
    const OLD_ROOT_FOLDER_TITLE = "LazyTabs Sessions";
    existing = await chrome.bookmarks.search({ title: OLD_ROOT_FOLDER_TITLE });
    folder = existing.find(n => n.title === OLD_ROOT_FOLDER_TITLE && !n.url);
    if (folder) {
        const updated = await chrome.bookmarks.update(folder.id, { title: ROOT_FOLDER_TITLE });
        return updated.id;
    }

    // If neither exists, create it
    const created = await chrome.bookmarks.create({ title: ROOT_FOLDER_TITLE });
    return created.id;
}

/**
 * Loads a session from a bookmark folder.
 * @param {string} sessionId - The bookmark ID of the session folder.
 * @returns {Promise<Object>} The Session object.
 */
async function loadSessionFromBookmarks(sessionId) {
    console.log(`loadSessionFromBookmarks: Loading ${sessionId}`);
    const sessionNodes = await chrome.bookmarks.getSubTree(sessionId).catch(err => {
        console.error(`loadSessionFromBookmarks: getSubTree failed for ${sessionId}`, err);
        return null;
    });

    if (!sessionNodes || sessionNodes.length === 0) {
        console.error(`loadSessionFromBookmarks: Session folder ${sessionId} not found`);
        throw new Error(`Session folder ${sessionId} not found`);
    }

    const sessionFolder = sessionNodes[0];
    const children = sessionFolder.children || [];

    const logicalTabs = [];
    const groups = {};

    let index = 0;

    for (const child of children) {
        if (child.url) {
            // Direct bookmark = Top-level logical tab
            logicalTabs.push({
                logicalId: generateGuid(), // In-memory ID
                sessionId: sessionId,
                bookmarkId: child.id,
                url: child.url,
                title: child.title,
                groupId: null,
                indexInSession: index++,
                liveTabIds: [],
                lastUpdated: Date.now(),
                lastSavedTitle: child.title,
                lastSavedUrl: child.url
            });
        } else {
            // Folder = Tab Group
            const groupId = child.id;
            groups[groupId] = {
                groupId: groupId,
                sessionId: sessionId,
                title: child.title,
                indexInSession: index++
            };

            const groupChildren = child.children || [];
            for (let j = 0; j < groupChildren.length; j++) {
                const gChild = groupChildren[j];
                if (!gChild.url) continue; // Ignore nested folders (level 3)

                logicalTabs.push({
                    logicalId: generateGuid(),
                    sessionId: sessionId,
                    bookmarkId: gChild.id,
                    url: gChild.url,
                    title: gChild.title,
                    groupId: groupId,
                    indexInSession: index++, // Flattened session order
                    indexInGroup: j,
                    liveTabIds: [],
                    lastUpdated: Date.now(),
                    lastSavedTitle: gChild.title,
                    lastSavedUrl: gChild.url
                });
            }
        }
    }

    const parsedTitle = parseSessionTitle(sessionFolder.title);

    return {
        sessionId: sessionId,
        name: parsedTitle.name,
        rootFolderId: sessionFolder.parentId,
        windowId: null, // Will be set when bound
        logicalTabs: logicalTabs,
        groups: groups,
        lastSynced: Date.now(),
        lastActiveLogicalTabId: null
    };
}

/**
 * Retrieves the list of all available sessions.
 * @returns {Promise<Array<{sessionId: string, name: string}>>}
 */
async function getSessionList() {
    const rootId = await ensureRootFolder();
    const children = await chrome.bookmarks.getChildren(rootId);
    return children
        .filter(node => !node.url) // Only folders
        .map(folder => ({ sessionId: folder.id, name: parseSessionTitle(folder.title).name }));
}

function notifySidebarStateUpdated(windowId, sessionId) {
    const session = state.sessionsById[sessionId];
    if (!session) return;

    chrome.runtime.sendMessage({
        type: "STATE_UPDATED",
        windowId: windowId,
        session: session
    }).catch(() => {
        // Ignore error if no listeners (sidebar closed)
    });
}

/**
 * Maps a live tab to a logical tab in memory.
 */
function attachLiveTabToLogical(tab, logical) {
    state.tabToLogical[tab.id] = logical.logicalId;
    if (!logical.liveTabIds.includes(tab.id)) {
        logical.liveTabIds.push(tab.id);
        scheduleMountedTabsUpdate();
    }
    if (tab.favIconUrl) {
        logical.favIconUrl = tab.favIconUrl;
    }
}

/**
 * Persists the current window-session mapping to storage.
 */
async function persistState() {
    await chrome.storage.local.set({
        windowToSession: state.windowToSession,
        workspaceHistory: state.workspaceHistory,
        favoriteWorkspaces: state.favoriteWorkspaces,
        lastKnownWorkspace: state.lastKnownWorkspace,
        historySize: state.historySize
    });

    // Notify UI of history change
    chrome.runtime.sendMessage({ type: "HISTORY_UPDATED" }).catch(() => { });
}

/**
 * Binds a window to a session.
 */
async function bindWindowToSession(windowId, sessionId) {
    // 1. Load session from bookmarks
    const session = await loadSessionFromBookmarks(sessionId);
    session.windowId = windowId;

    // Update the bookmark title to include the windowId
    const newTitle = formatSessionTitle(session.name, windowId);
    // Fetch current bookmark title to check if update is needed
    const currentNodes = await chrome.bookmarks.get(sessionId);
    if (currentNodes.length > 0 && currentNodes[0].title !== newTitle) {
        await chrome.bookmarks.update(sessionId, { title: newTitle });
    }
    session.name = parseSessionTitle(newTitle).name; // Ensure in-memory name is clean

    // 2. Update global state
    state.sessionsById[sessionId] = session;
    state.windowToSession[windowId] = sessionId;

    // 3. Persist mapping
    await persistState();

    // 4. Sync existing tabs
    await syncExistingTabsInWindowToSession(windowId, sessionId);

    // 5. Restore mounted tabs if enabled
    await restoreMountedTabsForSession(sessionId, windowId);

    // 6. Notify UI
    notifySidebarStateUpdated(windowId, sessionId);

    // 7. Track Workspace
    scheduleWorkspaceUpdate();
}

async function reloadSessionAndPreserveState(sessionId, windowId) {
    const reloadedSession = await loadSessionFromBookmarks(sessionId);
    reloadedSession.windowId = windowId;

    // Retrieve latest session state to preserve liveTabIds
    const latestSessionState = state.sessionsById[sessionId];

    if (latestSessionState) {
        // Map old Logical IDs to new Logical IDs using Bookmark ID as the key
        const oldIdToNewId = {};
        reloadedSession.logicalTabs.forEach(newLt => {
            const oldLt = latestSessionState.logicalTabs.find(old => old.bookmarkId === newLt.bookmarkId);
            if (oldLt) {
                newLt.liveTabIds = oldLt.liveTabIds;
                oldIdToNewId[oldLt.logicalId] = newLt.logicalId;

                // Update Global State Mapping (Tab -> New Logical ID)
                newLt.liveTabIds.forEach(tid => {
                    state.tabToLogical[tid] = newLt.logicalId;
                });
            }
        });

        // Preserve Active Tab State
        if (latestSessionState.lastActiveLogicalTabId) {
            const newActiveId = oldIdToNewId[latestSessionState.lastActiveLogicalTabId];
            if (newActiveId) {
                reloadedSession.lastActiveLogicalTabId = newActiveId;
            }
        }
    }

    state.sessionsById[sessionId] = reloadedSession;
    return reloadedSession;
}

/**
 * Tries to map current live tabs in the window to the session's logical tabs.
 * Creates new logical tabs (bookmarks) for unmapped live tabs.
 */
async function syncExistingTabsInWindowToSession(windowId, sessionId) {
    const session = state.sessionsById[sessionId];
    const tabs = await chrome.tabs.query({ windowId });

    // Rebuild tabToLogical mapping for this window from scratch
    // to ensure we are in sync with live tabs.
    // First clear old mappings for this session's tabs to avoid stale IDs.
    // Actually, safe to just overwrite.

    for (const tab of tabs) {
        // Find a match
        const match = session.logicalTabs.find(lt =>
            lt.url === tab.url && lt.liveTabIds.length === 0
        );

        if (match) {
            attachLiveTabToLogical(tab, match);

            // Map groups if applicable
            if (tab.groupId !== -1 && match.groupId) {
                // Live tab is grouped, and logical match is grouped
                state.liveGroupToBookmark[tab.groupId] = match.groupId;
            }
        } else {
            // Logic for new tabs
            // If the live tab is part of a group, we should try to place the bookmark in that group (if mapped)

            let parentId = sessionId;
            if (tab.groupId !== -1) {
                const mappedBookmarkId = state.liveGroupToBookmark[tab.groupId];
                if (mappedBookmarkId) {
                    parentId = mappedBookmarkId;
                } else {
                    // Try to fetch group info to create a new folder?
                    // This is async inside a loop, suboptimal, but necessary for correct initial sync.
                    try {
                        const groupInfo = await chrome.tabGroups.get(tab.groupId);
                        const groupTitle = formatGroupTitle(groupInfo.title, groupInfo.color);
                        const createdGroup = await chrome.bookmarks.create({
                            parentId: sessionId,
                            title: groupTitle
                        });
                        state.liveGroupToBookmark[tab.groupId] = createdGroup.id;
                        parentId = createdGroup.id;
                    } catch (e) {
                        console.warn("Could not get tab group info or create folder", e);
                    }
                }
            }

            const createdBookmark = await chrome.bookmarks.create({
                parentId: parentId,
                title: tab.title || "New Tab",
                url: tab.url || "about:blank"
            });

            // We need to reload session to see the new bookmark in our model
            // But doing it inside loop is bad.
            // Better to push to a list and reload once?
            // For now, we just rely on the fact that syncExistingTabsInWindowToSession is usually called once.
            // But we need to update in-memory session object manually or reload.
            // Let's just create a temporary logical object to attach, and reload at the end?
            // Actually, we must return a consistent state.
            // Let's reload once at the end.
        }
    }

    // Final reload to ensure state matches bookmarks
    await reloadSessionAndPreserveState(sessionId, windowId);

    // Re-attach live tabs because reload wipes references (but preserves via ID matching in reload function)
    // Wait, reloadSessionAndPreserveState preserves liveTabIds using bookmarkId matching.
    // But we just created bookmarks and didn't attach them in the session object before reload.
    // So reloadSessionAndPreserveState won't know about the new live mappings we intended.

    // We need to re-run the matching logic or attach manually after reload.
    // Since we created bookmarks, they exist.
    // Let's re-run the attach logic on the fresh session.
    const refreshedSession = state.sessionsById[sessionId];
    for (const tab of tabs) {
        // Find by URL/Title matching what we just created? No, risky.
        // We should map LiveTab -> BookmarkID -> LogicalTab
        // We can't easily know the bookmark ID of existing tabs without re-querying or storing.

        // Simplified approach:
        // We already have 'tab' (live).
        // We iterate refreshedSession.logicalTabs.
        // If logicalTab.url == tab.url (and not mapped), map it.
        // This repeats the work but ensures consistency.

        const match = refreshedSession.logicalTabs.find(lt =>
             lt.url === tab.url && lt.liveTabIds.length === 0
             // Ideally check bookmarkId if we tracked it
        );
        if (match) {
            attachLiveTabToLogical(tab, match);
             // Ensure group mapping persists
            if (tab.groupId !== -1 && match.groupId) {
                state.liveGroupToBookmark[tab.groupId] = match.groupId;
            }
        }
    }
}

/**
 * Workspace Tracking Logic
 */

function getCurrentWorkspaceSnapshot() {
    const sessions = [];
    // Only include sessions that are currently bound to a window
    for (const windowId of Object.keys(state.windowToSession)) {
        const sessionId = state.windowToSession[windowId];
        if (sessionId && state.sessionsById[sessionId]) {
            // We store the session ID. 
            // We also store window bounds/state if possible, but that requires async calls.
            // For simplicity in this sync function, we just store session IDs.
            // The restore logic will create new windows.
            sessions.push({
                sessionId: sessionId,
                windowId: parseInt(windowId, 10) // Store for reference, but won't be reused on restore
            });
        }
    }

    // If no sessions, it's empty
    if (sessions.length === 0) return null;

    return {
        id: generateGuid(),
        timestamp: Date.now(),
        sessions: sessions,
        windowCount: sessions.length,
        sessionCount: sessions.length // One session per window in this model
    };
}

function isWorkspaceTrivial(snapshot) {
    if (!snapshot || snapshot.sessions.length === 0) return true;

    // If only one window
    if (snapshot.sessions.length === 1) {
        const session = state.sessionsById[snapshot.sessions[0].sessionId];
        if (!session) return true;

        // If session has only one tab and it's a new tab/blank
        if (session.logicalTabs.length <= 1) {
            const tab = session.logicalTabs[0];
            if (!tab || tab.url === "chrome://newtab/" || tab.url === "about:blank" || tab.url === "edge://newtab/") {
                return true;
            }
        }
    }
    return false;
}

async function enrichSnapshotWithGeometry(snapshot) {
    const windows = await chrome.windows.getAll();
    const enrichedSessions = [];

    for (const s of snapshot.sessions) {
        const win = windows.find(w => w.id === s.windowId);
        if (win) {
            const enriched = {
                ...s,
                state: win.state,
                top: win.top,
                left: win.left,
                width: win.width,
                height: win.height
            };
            // console.log('Saving window geometry:', enriched);
            enrichedSessions.push(enriched);
        } else {
            // Window not found (likely closed but not yet cleaned up from state, or race condition)
            // We exclude it from the snapshot to ensure history reflects reality.
            console.warn(`Window ${s.windowId} not found during enrichment, excluding from snapshot.`);
        }
    }

    snapshot.sessions = enrichedSessions;
    snapshot.windowCount = enrichedSessions.length;
    snapshot.sessionCount = enrichedSessions.length;

    return snapshot;
}

async function trackCurrentWorkspace() {
    if (!state.initialized) return;

    let snapshot = getCurrentWorkspaceSnapshot();
    if (!snapshot) return;

    // Enrich with window state
    snapshot = await enrichSnapshotWithGeometry(snapshot);

    if (isWorkspaceTrivial(snapshot)) {
        return;
    }

    // Deduplicate or Update
    if (state.workspaceHistory.length > 0) {
        const last = state.workspaceHistory[state.workspaceHistory.length - 1];
        // Check if structure (sessions) is the same
        if (last.sessions.length === snapshot.sessions.length) {
            const lastSessionIds = new Set(last.sessions.map(s => s.sessionId));
            const currentSessionIds = new Set(snapshot.sessions.map(s => s.sessionId));
            let sameIds = true;
            for (const id of currentSessionIds) {
                if (!lastSessionIds.has(id)) {
                    sameIds = false;
                    break;
                }
            }

            if (sameIds) {
                // Structure is the same.
                // We should update the last entry with new geometry/timestamp instead of creating a new one.
                // This keeps history clean when just resizing/moving windows.

                // Check if geometry actually changed to avoid unnecessary writes
                let geometrySame = true;
                for (const s of snapshot.sessions) {
                    const lastS = last.sessions.find(ls => ls.sessionId === s.sessionId);
                    if (!lastS) { geometrySame = false; break; }

                    if (s.state !== lastS.state ||
                        s.top !== lastS.top ||
                        s.left !== lastS.left ||
                        s.width !== lastS.width ||
                        s.height !== lastS.height) {
                        geometrySame = false;
                        break;
                    }
                }

                if (geometrySame) return; // No change at all

                // Geometry changed, but structure is same -> Update in place
                last.sessions = snapshot.sessions;
                last.timestamp = snapshot.timestamp;

                state.lastKnownWorkspace = {
                    ...last,
                    isTrivial: isWorkspaceTrivial(snapshot)
                };
                await persistState();

                // Notify UI that history updated (even if just timestamp/geometry)
                chrome.runtime.sendMessage({ type: "HISTORY_UPDATED" }).catch(() => { });
                return;
            }
        }
    }

    state.workspaceHistory.push(snapshot);

    // Trim history
    if (state.workspaceHistory.length > state.historySize) {
        state.workspaceHistory = state.workspaceHistory.slice(-state.historySize);
    }

    state.lastKnownWorkspace = {
        ...snapshot,
        isTrivial: isWorkspaceTrivial(snapshot)
    };
    await persistState();
}

async function restoreWorkspace(snapshot) {
    console.log("restoreWorkspace: Starting. Setting isRestoring = true");
    isRestoring = true;

    try {
        const currentWindows = await chrome.windows.getAll();
        const newWindowIds = [];

        for (const sessionInfo of snapshot.sessions) {
            const createData = {
                url: "about:blank", // Will be populated by session bind
                state: sessionInfo.state || 'normal'
            };

            if (sessionInfo.state !== 'maximized' && sessionInfo.state !== 'minimized' && sessionInfo.state !== 'fullscreen') {
                if (sessionInfo.top !== undefined) createData.top = sessionInfo.top;
                if (sessionInfo.left !== undefined) createData.left = sessionInfo.left;
                if (sessionInfo.width !== undefined) createData.width = sessionInfo.width;
                if (sessionInfo.height !== undefined) createData.height = sessionInfo.height;
            }

            console.log('restoreWorkspace: Creating window with geometry:', createData);
            const win = await chrome.windows.create(createData);
            console.log('restoreWorkspace: Window created:', win.id);

            // Force maximization if needed (sometimes create doesn't apply it reliably?)
            if (sessionInfo.state === 'maximized' && win.state !== 'maximized') {
                console.log('restoreWorkspace: Forcing maximization for window', win.id);
                await chrome.windows.update(win.id, { state: 'maximized' });
            }

            newWindowIds.push(win.id);

            // Bind session
            console.log('restoreWorkspace: Binding window', win.id, 'to session', sessionInfo.sessionId);
            try {
                await bindWindowToSession(win.id, sessionInfo.sessionId);
                console.log('restoreWorkspace: Bound successfully');
            } catch (err) {
                console.error(`restoreWorkspace: Failed to bind session ${sessionInfo.sessionId}`, err);
                // Fallback: Create a new session for this window so it's not orphaned
                try {
                    const rootId = await ensureRootFolder();
                    const newSessionTitle = formatSessionTitle(`Session - Window ${win.id}`, win.id);
                    const created = await chrome.bookmarks.create({
                        parentId: rootId,
                        title: newSessionTitle
                    });
                    await bindWindowToSession(win.id, created.id);
                } catch (fallbackErr) {
                    console.error("restoreWorkspace: Critical - Failed to create fallback session", fallbackErr);
                }
            }
        }

        // Close old windows
        for (const win of currentWindows) {
            if (win.type === 'normal' || win.type === 'popup') {
                try {
                    await chrome.windows.remove(win.id);
                } catch (e) {
                    console.warn("Failed to close window", win.id, e);
                }
            }
        }
    } finally {
        console.log("restoreWorkspace: Finished. Setting isRestoring = false");
        isRestoring = false;
        scheduleWorkspaceUpdate();
    }
}

// --- Initialization ---

let initPromise = null;

function init(options = {}) {
    if (state.initialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
        console.log("InfiniTabs: Background initializing...");
        try {
            await ensureRootFolder();

            if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
                chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
                    .catch(err => console.warn("setPanelBehavior failed", err));
            }

            // Restore persisted state
            const storage = await chrome.storage.local.get(['windowToSession', 'workspaceHistory', 'favoriteWorkspaces', 'lastKnownWorkspace', 'historySize', 'reloadOnRestart', 'selectLastActiveTab', 'maxTabHistory', 'restoreMountedTabs', 'sessionMountedTabs']);
            if (storage.windowToSession) state.windowToSession = storage.windowToSession;
            if (storage.workspaceHistory) state.workspaceHistory = storage.workspaceHistory;
            if (storage.favoriteWorkspaces) state.favoriteWorkspaces = storage.favoriteWorkspaces;
            if (storage.lastKnownWorkspace) state.lastKnownWorkspace = storage.lastKnownWorkspace;
            if (storage.historySize) state.historySize = storage.historySize;
            if (storage.reloadOnRestart !== undefined) state.reloadOnRestart = storage.reloadOnRestart;
            if (storage.selectLastActiveTab !== undefined) state.selectLastActiveTab = storage.selectLastActiveTab;
            if (storage.maxTabHistory !== undefined) state.maxTabHistory = storage.maxTabHistory;
            if (storage.restoreMountedTabs !== undefined) state.restoreMountedTabs = storage.restoreMountedTabs;
            if (storage.sessionMountedTabs) state.sessionMountedTabs = storage.sessionMountedTabs;

            // Only skip binding if we are in a startup context AND auto-reload is enabled
            const shouldSkipBinding = options.isStartup && state.reloadOnRestart && state.lastKnownWorkspace;

            if (!shouldSkipBinding) {
                const windows = await chrome.windows.getAll();
                const rootId = await ensureRootFolder();
                const sessionFolders = await chrome.bookmarks.getChildren(rootId);

                const sessionFoldersByWindowId = {};
                for (const folder of sessionFolders) {
                    const parsed = parseSessionTitle(folder.title);
                    if (parsed.windowId) {
                        sessionFoldersByWindowId[parsed.windowId] = folder.id;
                    } else {
                        // Try to parse old format "Session - Window 12345"
                        const match = folder.title.match(/^Session - Window (\d+)$/);
                        if (match) {
                            const windowId = parseInt(match[1], 10);
                            sessionFoldersByWindowId[windowId] = folder.id;
                        }
                    }
                }

                for (const win of windows) {
                    const storedSessionId = state.windowToSession[win.id];
                    if (storedSessionId) {
                        try {
                            await bindWindowToSession(win.id, storedSessionId);
                        } catch (e) {
                            console.warn(`Could not restore session ${storedSessionId} for window ${win.id}`, e);
                            delete state.windowToSession[win.id];
                            await persistState();
                        }
                    } else if (sessionFoldersByWindowId[win.id]) {
                        // Found an existing session folder for this window
                        await bindWindowToSession(win.id, sessionFoldersByWindowId[win.id]);
                    } else {
                        // Create a new session folder
                        const newSessionTitle = formatSessionTitle(`Session - Window ${win.id}`, win.id);
                        const created = await chrome.bookmarks.create({
                            parentId: rootId,
                            title: newSessionTitle
                        });
                        await bindWindowToSession(win.id, created.id);
                    }
                }

                // Initial workspace track
                scheduleWorkspaceUpdate(2000);
            } else {
                console.log("InfiniTabs: Auto-reload enabled. Skipping initial window binding.");
            }

            state.initialized = true;
            console.log("InfiniTabs: Background initialized.");
        } catch (e) {
            console.error("InfiniTabs: Background init failed", e);
            initPromise = null; // Allow retry
            throw e;
        }
    })();

    return initPromise;
}

async function onStartupHandler() {
    await init({ isStartup: true });
    if (state.reloadOnRestart && state.lastKnownWorkspace) {
        console.log("InfiniTabs: Auto-reloading last workspace on startup...");
        // We restore specifically the sessions that were open.
        // NOTE: This will close current windows (which might be the browser's own session restore).
        // This effectively overrides the browser's session restore if both are active.
        await restoreWorkspace(state.lastKnownWorkspace);
    }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(onStartupHandler);

// Listen for changes in local storage to update runtime configuration
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        if (changes.reloadOnRestart) {
            state.reloadOnRestart = changes.reloadOnRestart.newValue;
        }
        if (changes.restoreMountedTabs) {
            state.restoreMountedTabs = changes.restoreMountedTabs.newValue;
        }
        if (changes.selectLastActiveTab) {
            state.selectLastActiveTab = changes.selectLastActiveTab.newValue;
        }
        if (changes.maxTabHistory) {
            const parsed = parseInt(changes.maxTabHistory.newValue, 10);
            const nextMax = Number.isFinite(parsed) && parsed > 0 ? parsed : state.maxTabHistory;
            state.maxTabHistory = nextMax;
            Object.values(state.tabHistory).forEach(history => {
                if (history.length > nextMax) {
                    history.splice(0, history.length - nextMax);
                }
            });
        }
    }
});

// --- Event Listeners ---

chrome.windows.onCreated.addListener(async (window) => {
    console.log(`onCreated: Window ${window.id} created. isRestoring=${isRestoring}`);
    if (!state.initialized) await init();

    // Suppress if we are in the middle of a restore operation
    if (isRestoring) {
        console.log(`onCreated: Suppressing for window ${window.id} due to restore.`);
        return;
    }

    // Immediate session binding
    const windowId = window.id;
    if (!state.windowToSession[windowId]) {
        console.log(`onCreated: Binding new session for window ${windowId} immediately.`);

        try {
            const rootId = await ensureRootFolder();
            const newSessionTitle = formatSessionTitle(`Session - Window ${windowId}`, windowId);
            const created = await chrome.bookmarks.create({
                parentId: rootId,
                title: newSessionTitle
            });
            await bindWindowToSession(windowId, created.id);
        } catch (e) {
            console.error("onCreated: Failed to bind session", e);
        }
    }
});

chrome.windows.onBoundsChanged.addListener(async (window) => {
    if (!state.initialized) await init();
    // Track workspace when window is moved or resized
    scheduleWorkspaceUpdate();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    if (!state.initialized) await init();

    // If the window was tracking a session, we need to update state
    if (state.windowToSession[windowId]) {
        console.log(`Window ${windowId} closed, updating workspace history.`);
        delete state.windowToSession[windowId];

        // Check if all windows are closed (Clean Exit)
        if (Object.keys(state.windowToSession).length === 0) {
            console.log("All windows closed. Clearing lastKnownWorkspace to prevent false crash detection.");
            state.lastKnownWorkspace = null;
            await persistState();
        } else {
            // Immediate update to capture the closure in history
            await trackCurrentWorkspace();
        }
    } else {
        // Even if not tracking a session, update workspace to ensure consistency
        scheduleWorkspaceUpdate();
    }
});

// --- Tab Group Listeners ---

chrome.tabGroups.onCreated.addListener(async (group) => {
    if (!state.initialized) await init();
    if (isRestoring) return; // Handled by sync/restore logic
    if (state.isCreatingGroup) return; // Handled programmatically

    await getOrCreateGroupBookmark(group.id, group.windowId);
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
    if (!state.initialized) await init();

    const bookmarkId = state.liveGroupToBookmark[group.id];
    if (!bookmarkId) return;

    const newTitle = formatGroupTitle(group.title, group.color);

    // Check if changed
    try {
        const nodes = await chrome.bookmarks.get(bookmarkId);
        if (nodes && nodes.length > 0 && nodes[0].title !== newTitle) {
            await chrome.bookmarks.update(bookmarkId, { title: newTitle });

            const sessionId = state.windowToSession[group.windowId];
            if (sessionId) {
                await reloadSessionAndPreserveState(sessionId, group.windowId);
                notifySidebarStateUpdated(group.windowId, sessionId);
            }
        }
    } catch (e) {
        console.error("Failed to update bookmark for group", e);
    }
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
    if (!state.initialized) await init();

    const bookmarkId = state.liveGroupToBookmark[group.id];
    if (!bookmarkId) return;

    delete state.liveGroupToBookmark[group.id];

    const sessionId = state.windowToSession[group.windowId];
    if (!sessionId) {
        // Fallback: If session not found, just ensure we don't leave empty folders?
        // But safer to do nothing if we can't determine context.
        return;
    }

    try {
        const session = state.sessionsById[sessionId];
        if (!session) return; // Should be loaded if sessionId exists

        // Distinguish between "Group Closed" (tabs closed) and "Group Ungrouped" (tabs moved out/ungrouped).
        // - "Closed": Tabs are dead. We want to PERSIST the logical group (folder).
        // - "Ungrouped": Tabs are alive. We want to DISSOLVE the logical group (flatten tabs).

        const children = await chrome.bookmarks.getChildren(bookmarkId);

        // 1. If folder is empty, delete it regardless.
        if (children.length === 0) {
            await chrome.bookmarks.remove(bookmarkId);
        } else {
            // 2. Check if this is an "Ungroup" operation.
            // If any logical tab *currently in this group* has live tabs, it means the user likely ungrouped them
            // (or dragged them out, triggering this removal).
            // Note: If tabs were closed, onRemoved(tab) would have fired and cleared liveTabIds.

            const tabsInGroup = session.logicalTabs.filter(t => t.groupId === bookmarkId);
            const hasLiveTabs = tabsInGroup.some(t => t.liveTabIds.length > 0);

            if (hasLiveTabs) {
                // Ungroup detected: Move children out and delete folder.
                const groupNode = await chrome.bookmarks.get(bookmarkId);
                const parentId = groupNode[0].parentId;
                const index = groupNode[0].index;

                // Move children to parent (flatten)
                for (let i = 0; i < children.length; i++) {
                    await chrome.bookmarks.move(children[i].id, { parentId: parentId, index: index + i });
                }
                await chrome.bookmarks.remove(bookmarkId);
            }
            // Else: Closed detected: Preserve folder.
        }

        await reloadSessionAndPreserveState(sessionId, group.windowId);
        notifySidebarStateUpdated(group.windowId, sessionId);
    } catch (e) {
        console.error("Failed to handle group removal", e);
    }
});

// --- Tab Listeners (Updated) ---

chrome.tabs.onCreated.addListener(async (tab) => {
    // Ensure init if SW woke up just for this event
    if (!state.initialized) await init();

    const windowId = tab.windowId;

    const pendingIndex = pendingMounts.findIndex(p => p.windowId === windowId);
    if (pendingIndex !== -1) {
        const { logicalId } = pendingMounts[pendingIndex];
        pendingMounts.splice(pendingIndex, 1);

        const sessionId = state.windowToSession[windowId];
        if (sessionId) {
            const session = state.sessionsById[sessionId];
            if (session) {
                const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
                if (logical) {
                    attachLiveTabToLogical(tab, logical);

                    // Sync Group Mapping if logical has group and live doesn't (or mismatch)
                    // If logical is in a group, we should try to put live tab in that group?
                    // This is handled in syncExistingTabsInWindowToSession usually, but here it's dynamic.
                    // If we open a logical tab that is in a group, the live tab should be grouped.
                    if (logical.groupId) {
                        await ensureLiveGroupForLogicalTab(tab.id, logical.groupId, session);
                    }

                    notifySidebarStateUpdated(windowId, sessionId);
                    return;
                }
            }
        }
    }

    if (state.tabToLogical[tab.id]) return;

    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;

    // Note: We use current state snapshot to calculate insertion, 
    // but we must re-fetch state later to merge correctly.
    const currentSessionSnapshot = state.sessionsById[sessionId];
    if (!currentSessionSnapshot) return;

    let insertParentId = sessionId;
    let insertIndex = null;

    // Check if new tab is in a group
    if (tab.groupId !== -1) {
        // If live tab is in a group, we want to put bookmark in the corresponding folder
        const bookmarkId = state.liveGroupToBookmark[tab.groupId];
        if (bookmarkId) {
            insertParentId = bookmarkId;
        } else {
            // Group exists live but not mapped?
            // Wait for onCreated logic to create folder?
            // onCreated fires before onUpdated(tabs) usually?
            // If tab is created with groupId, maybe we haven't seen the group yet?
            // We can try to create it here too if missing.
            try {
                const groupInfo = await chrome.tabGroups.get(tab.groupId);
                const groupTitle = formatGroupTitle(groupInfo.title, groupInfo.color);
                const createdGroup = await chrome.bookmarks.create({
                    parentId: sessionId,
                    title: groupTitle
                });
                state.liveGroupToBookmark[tab.groupId] = createdGroup.id;
                insertParentId = createdGroup.id;
            } catch (e) {
                 // ignore
            }
        }
    } else if (tab.index > 0) {
        // Not grouped, try to follow neighbor
        const tabs = await chrome.tabs.query({ windowId, index: tab.index - 1 });
        if (tabs.length > 0) {
            const prevTab = tabs[0];
            const prevLogicalId = state.tabToLogical[prevTab.id];
            if (prevLogicalId) {
                const prevLogical = currentSessionSnapshot.logicalTabs.find(l => l.logicalId === prevLogicalId);
                if (prevLogical) {
                    try {
                        const nodes = await chrome.bookmarks.get(prevLogical.bookmarkId);
                        if (nodes && nodes.length > 0) {
                            const prevNode = nodes[0];
                            // If prev bookmark is in a folder (group) but new tab is NOT in a group,
                            // we must put the new bookmark after the group folder, in the session root.
                            // Unless the parent is the session root itself.

                            if (prevNode.parentId !== sessionId) {
                                // Previous bookmark is inside a subfolder (group)
                                // New tab is not in a group (checked earlier)
                                // So we place it in session root, after the group folder.

                                // Find the group folder node to determine where to insert
                                const groupFolderNodes = await chrome.bookmarks.get(prevNode.parentId);
                                if (groupFolderNodes && groupFolderNodes.length > 0) {
                                    insertParentId = sessionId;
                                    insertIndex = groupFolderNodes[0].index + 1;
                                }
                            } else {
                                // Previous bookmark is at root level
                                insertParentId = prevNode.parentId;
                                insertIndex = prevNode.index + 1;
                            }
                        }
                    } catch (e) {
                        console.warn("Could not find prev bookmark", e);
                    }
                }
            }
        }
    }

    const bookmarkData = {
        parentId: insertParentId,
        title: tab.title || "New Tab",
        url: tab.url || "about:blank"
    };
    if (insertIndex !== null) {
        bookmarkData.index = insertIndex;
    }

    const createdBookmark = await chrome.bookmarks.create(bookmarkData);

    // Reload session structure using helper
    const reloadedSession = await reloadSessionAndPreserveState(sessionId, windowId);

    const newLogical = reloadedSession.logicalTabs.find(l => l.bookmarkId === createdBookmark.id);
    if (newLogical) {
        attachLiveTabToLogical(tab, newLogical);

        // Fix for race condition: If the new tab is active, update the selection immediately
        if (tab.active) {
             const session = state.sessionsById[sessionId];
             if (session) {
                 session.lastActiveLogicalTabId = newLogical.logicalId;
             }
        }
    }

    notifySidebarStateUpdated(windowId, sessionId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!state.initialized) await init();

    // Check if group changed
    if (changeInfo.groupId !== undefined) {
         const logicalId = state.tabToLogical[tabId];
         if (logicalId) {
             const sessionId = state.windowToSession[tab.windowId];
             if (sessionId) {
                 const session = state.sessionsById[sessionId];
                 const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
                 if (logical) {
                     // Tab moved to a group or out of a group
                     let targetParentId = sessionId; // Default to root

                     if (tab.groupId !== -1) {
                         // If we are creating a group programmatically, we expect the mapping to be set.
                         // If state.isCreatingGroup is true, the bookmark creation is handled elsewhere or assumed unnecessary for this specific event flow.

                         if (state.isCreatingGroup) {
                             return;
                         }

                         // Use helper to get or create bookmark (handles race conditions)
                         const groupBookmarkId = await getOrCreateGroupBookmark(tab.groupId, tab.windowId);
                         if (groupBookmarkId) {
                             targetParentId = groupBookmarkId;
                         }
                     } else {
                        // Tab was ungrouped (tab.groupId === -1)
                        // Wait a bit to see if the tab is being closed (race condition fix)
                        // When a tab is closed, Chrome might emit an onUpdated event with groupId: -1 right before onRemoved.
                        // If we process this immediately, we might move the bookmark to the root folder, which is incorrect if the tab is about to be deleted (logical tab should stay where it is, just unlinked).
                        setTimeout(async () => {
                            let currentTab;
                            try {
                                currentTab = await chrome.tabs.get(tabId);
                            } catch (e) {
                                // Tab is gone (closed), ignore this update
                                return;
                            }

                            // Check if tab is still mapped (onRemoved cleans up the mapping)
                            if (!state.tabToLogical[tabId]) return;

                            // Check if tab is still ungrouped (might have been added to another group quickly?)
                            if (currentTab.groupId !== -1) return;

                            // Now safe to move
                            try {
                                const nodes = await chrome.bookmarks.get(logical.bookmarkId);
                                if (nodes[0].parentId !== targetParentId) {
                                    await chrome.bookmarks.move(logical.bookmarkId, { parentId: targetParentId });
                                    await reloadSessionAndPreserveState(sessionId, tab.windowId);
                                    notifySidebarStateUpdated(tab.windowId, sessionId);
                                }
                            } catch(e) {
                                console.error("Failed to move bookmark on group change (delayed)", e);
                            }
                        }, 100);
                        return;
                     }

                     // Move bookmark
                     try {
                         // Check current parent to avoid redundant moves
                         const nodes = await chrome.bookmarks.get(logical.bookmarkId);
                         if (nodes[0].parentId !== targetParentId) {
                             await chrome.bookmarks.move(logical.bookmarkId, { parentId: targetParentId });
                             await reloadSessionAndPreserveState(sessionId, tab.windowId);
                             notifySidebarStateUpdated(tab.windowId, sessionId);
                         }
                     } catch(e) {
                         console.error("Failed to move bookmark on group change", e);
                     }
                 }
             }
         }
    }

    // Optimization: Ignore loading state if title/url didn't change to avoid spamming the sidebar
    if (changeInfo.status === 'loading' && !changeInfo.url && !changeInfo.title) return;

    const logicalId = state.tabToLogical[tabId];
    if (!logicalId) return;

    const windowId = tab.windowId;
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
    if (!logical) return;

    let changed = false;
    if (changeInfo.url && changeInfo.url !== logical.url) {
        logical.url = changeInfo.url;
        changed = true;
    }
    if (changeInfo.title && changeInfo.title !== logical.title) {
        logical.title = changeInfo.title;
        changed = true;
    }
    if (changeInfo.favIconUrl && changeInfo.favIconUrl !== logical.favIconUrl) {
        logical.favIconUrl = changeInfo.favIconUrl;
        changed = true;
    }

    if (changed) {
        logical.lastUpdated = Date.now();

        // Debounce bookmark update
        scheduleBookmarkUpdate(logicalId, () => {
            // Double check if we really need to update bookmark
            if (logical.title === logical.lastSavedTitle && logical.url === logical.lastSavedUrl) {
                return;
            }

            // Note: favIconUrl is not persisted to bookmarks as Chrome bookmarks don't support storing favicon (or any kind of meta) data.
            // Favicons will fall back to the /_favicon/ service after reload until live tabs reattach.
            // TODO: store favIconUrl data in a local database in the extension. More generally, the extension should have a local database to store bookmarks' metadata, which should only be metadata that is not necessary for core functionality (ie, not necessary for managing or storing or recalling sessions and workspaces and tabs and tabs groups) but can be used to improve UX (eg, favicons recall after browser close and reopening).
            chrome.bookmarks.update(logical.bookmarkId, {
                title: logical.title,
                url: logical.url
            }).then(() => {
                logical.lastSavedTitle = logical.title;
                logical.lastSavedUrl = logical.url;
            }).catch(err => console.error("Failed to update bookmark", err));
        }, 2000); // 2s debounce to avoid rapid updates causing side effects

        // Debounce sidebar update for onUpdated events to prevent thrashing
        scheduleSidebarUpdate(windowId, sessionId);
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (!state.initialized) await init();

    const logicalId = state.tabToLogical[tabId];
    if (logicalId) {
        delete state.tabToLogical[tabId];

        const sessionId = state.windowToSession[removeInfo.windowId];
        if (sessionId) {
            const session = state.sessionsById[sessionId];
            if (session) {
                const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
                if (logical) {
                    logical.liveTabIds = logical.liveTabIds.filter(id => id !== tabId);
                }
                scheduleMountedTabsUpdate();
                notifySidebarStateUpdated(removeInfo.windowId, sessionId);
            }
        }
    }

    // Re-check active tab to update highlight
    // Wait a tick for the browser to switch focus
    setTimeout(async () => {
        const windowId = removeInfo.windowId;
        try {
            const tabs = await chrome.tabs.query({ active: true, windowId });
            if (tabs.length > 0) {
                const activeTab = tabs[0];
                const sessionId = state.windowToSession[windowId];
                if (sessionId && state.sessionsById[sessionId]) {
                    const logicalId = state.tabToLogical[activeTab.id];
                    if (logicalId) {
                        const session = state.sessionsById[sessionId];
                        session.lastActiveLogicalTabId = logicalId;
                        notifySidebarStateUpdated(windowId, sessionId);
                    }
                }
            }
        } catch (e) {
            // Window might be closed
        }
    }, 100);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    moveMutex.run(async () => {
        if (!state.initialized) await init();

        if (state.ignoreMoveEventsForTabIds.has(tabId)) {
            state.ignoreMoveEventsForTabIds.delete(tabId);
            return;
        }

        const logicalId = state.tabToLogical[tabId];
        if (!logicalId) return;

        const windowId = moveInfo.windowId;
        const sessionId = state.windowToSession[windowId];
        if (!sessionId) return;

        // Wait a brief moment to ensure chrome.tabs.query reflects the move
        await new Promise(resolve => setTimeout(resolve, 50));

        // Always fetch latest session state inside the mutex
        const session = state.sessionsById[sessionId];
        if (!session) return;

        const tabs = await chrome.tabs.query({ windowId });
        const liveTabsInOrder = tabs;

        const movedTabIndex = liveTabsInOrder.findIndex(t => t.id === tabId);
        if (movedTabIndex === -1) return;

        // Validation: If the index doesn't match moveInfo.toIndex (roughly), we might be stale.
        // But with multi-selection drag, subsequent moves might shift indices.
        // So we rely on liveTabsInOrder as the source of truth for the *current* state.

        const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
        if (!logical) return;

        // Requirement: "place just below the logical tab that is linked to the live tab directly to the left"
        // Iterate backwards from movedTabIndex - 1 to 0 to find the first live tab that has a logical counterpart
        let anchorLogical = null;
        for (let i = movedTabIndex - 1; i >= 0; i--) {
            const tab = liveTabsInOrder[i];
            const lid = state.tabToLogical[tab.id];
            if (lid) {
                const l = session.logicalTabs.find(x => x.logicalId === lid);
                if (l) {
                    anchorLogical = l;
                    break;
                }
            }
        }

        if (anchorLogical) {
            // Move after anchorLogical
            try {
                const nodes = await chrome.bookmarks.get(anchorLogical.bookmarkId);
                if (nodes && nodes.length > 0) {
                    const anchorNode = nodes[0];
                    // Move to same parent, next index
                    await chrome.bookmarks.move(logical.bookmarkId, {
                        parentId: anchorNode.parentId,
                        index: anchorNode.index + 1
                    });
                }
            } catch (e) {
                console.error("Failed to move bookmark to anchor", e);
            }
        } else {
            // No left anchor (moved to start, or only untracked tabs before it)
            // Move to the beginning of the session root
            try {
                await chrome.bookmarks.move(logical.bookmarkId, { parentId: sessionId, index: 0 });
            } catch (e) {
                console.error("Failed to move bookmark to root", e);
            }
        }

        // Reload session structure using helper
        await reloadSessionAndPreserveState(sessionId, windowId);
        notifySidebarStateUpdated(windowId, sessionId);
    });
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!state.initialized) await init();

    const windowId = activeInfo.windowId;
    const tabId = activeInfo.tabId;

    // Update History
    if (!state.tabHistory[windowId]) state.tabHistory[windowId] = [];
    const history = state.tabHistory[windowId];

    // Remove existing occurrence to move to end (MRU)
    const idx = history.indexOf(tabId);
    if (idx !== -1) history.splice(idx, 1);

    history.push(tabId);

    // Trim
    if (history.length > state.maxTabHistory) {
        history.shift();
    }

    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;

    const session = state.sessionsById[sessionId];
    if (!session) return;

    const logicalId = state.tabToLogical[tabId];

    if (logicalId) {
        session.lastActiveLogicalTabId = logicalId;
        scheduleMountedTabsUpdate();
        notifySidebarStateUpdated(windowId, sessionId);
    }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (!state.initialized) await init();
        try {
            switch (message.type) {
                case "GET_CURRENT_SESSION_STATE": {
                    const windowId = message.windowId;
                    const sessionId = state.windowToSession[windowId];
                    if (sessionId && state.sessionsById[sessionId]) {
                        sendResponse({ session: state.sessionsById[sessionId] });
                    } else {
                        // Attempt late bind if missing
                        if (windowId) {
                            // Fix: Prevent late bind if we are restoring, to avoid race condition
                            if (isRestoring) {
                                sendResponse({ session: null });
                                return;
                            }

                            const rootId = await ensureRootFolder();
                            const newSessionTitle = formatSessionTitle(`Session - Window ${windowId}`, windowId);
                            const created = await chrome.bookmarks.create({
                                parentId: rootId,
                                title: newSessionTitle
                            });
                            await bindWindowToSession(windowId, created.id);
                            sendResponse({ session: state.sessionsById[created.id] });
                        } else {
                            sendResponse({ session: null });
                        }
                    }
                    break;
                }
                case "GET_SESSION_LIST": {
                    const list = await getSessionList();
                    sendResponse({ sessions: list });
                    break;
                }
                case "SWITCH_SESSION": {
                    await handleSwitchSession(message.windowId, message.sessionId);
                    sendResponse({ success: true });
                    break;
                }
                case "DELETE_LOGICAL_GROUP": {
                    await handleDeleteLogicalGroup(message.windowId, message.groupId);
                    sendResponse({ success: true });
                    break;
                }
                case "RENAME_SESSION": {
                    await handleRenameSession(message.sessionId, message.newName);
                    sendResponse({ success: true });
                    break;
                }
                case "FOCUS_OR_MOUNT_TAB": {
                    await focusOrMountLogicalTab(message.windowId, message.logicalId);
                    sendResponse({ success: true });
                    break;
                }
                case "UNMOUNT_ALL_EXCEPT": {
                    await handleUnmountAllExcept(message.windowId, message.logicalIdsToKeep);
                    sendResponse({ success: true });
                    break;
                }
                case "UNMOUNT_LOGICAL_TAB": {
                    await handleUnmountLogicalTab(message.windowId, message.logicalId);
                    sendResponse({ success: true });
                    break;
                }
                case "DELETE_LOGICAL_TAB": {
                    await handleDeleteLogicalTab(message.windowId, message.logicalId);
                    sendResponse({ success: true });
                    break;
                }
                case "MOVE_LOGICAL_TABS": {
                    await handleMoveLogicalTabs(
                        message.windowId,
                        message.logicalIds,
                        message.targetLogicalId,
                        message.position
                    );
                    sendResponse({ success: true });
                    break;
                }
                case "GET_WORKSPACE_HISTORY": {
                    sendResponse({
                        history: state.workspaceHistory,
                        favorites: state.favoriteWorkspaces
                    });
                    break;
                }
                case "RESTORE_WORKSPACE": {
                    // message.snapshotId, message.type ('history' or 'favorite')
                    let snapshot;
                    if (message.source === 'favorite') {
                        snapshot = state.favoriteWorkspaces.find(s => s.id === message.snapshotId);
                    } else {
                        snapshot = state.workspaceHistory.find(s => s.id === message.snapshotId);
                    }

                    if (snapshot) {
                        console.log("Restoring snapshot:", JSON.stringify(snapshot, null, 2));
                        await restoreWorkspace(snapshot);
                        sendResponse({ success: true });
                    } else if (message.snapshot) {
                        // Direct snapshot object (e.g. from crash recovery)
                        console.log("Restoring direct snapshot:", JSON.stringify(message.snapshot, null, 2));
                        await restoreWorkspace(message.snapshot);
                        sendResponse({ success: true });
                    } else {
                        sendResponse({ error: "Snapshot not found" });
                    }
                    break;
                }
                case "SAVE_FAVORITE_WORKSPACE": {
                    let snapshot = getCurrentWorkspaceSnapshot();
                    if (snapshot) {
                        snapshot = await enrichSnapshotWithGeometry(snapshot);
                        snapshot.name = message.name;
                        snapshot.id = generateGuid(); // New ID for the favorite entry
                        state.favoriteWorkspaces.unshift(snapshot); // Add to top
                        await persistState();
                        sendResponse({ success: true });
                    } else {
                        sendResponse({ error: "Current workspace is empty" });
                    }
                    break;
                }
                case "CHECK_CRASH_STATUS": {
                    // Heuristic:
                    // 1. We have a lastKnownWorkspace
                    // 2. It is "rich" (not trivial)
                    // 3. Current state is "trivial"

                    const last = state.lastKnownWorkspace;
                    if (!last) {
                        sendResponse({ crashed: false });
                        break;
                    }

                    // Use persisted 'isTrivial' flag if available (robust for 1-window crash detection)
                    // Fallback to calculation for older states (might fail for 1-window case due to missing loaded sessions)
                    const lastWasTrivial = (last.isTrivial !== undefined)
                        ? last.isTrivial
                        : isWorkspaceTrivial(last);

                    const current = getCurrentWorkspaceSnapshot();
                    const currentIsTrivial = isWorkspaceTrivial(current);

                    if (!lastWasTrivial && currentIsTrivial) {
                        sendResponse({ crashed: true, lastWorkspace: last });
                    } else {
                        sendResponse({ crashed: false });
                    }
                    break;
                }
            }
        } catch (error) {
            console.error("Message handler error", error);
            sendResponse({ error: error.message });
        }
    })();
    return true;
});


// --- Actions Implementation ---

async function handleRenameSession(sessionId, newName) {
    const session = state.sessionsById[sessionId];
    const windowId = session ? session.windowId : null;

    // If we don't have the session loaded, we need to get the bookmark to find the windowId
    if (!windowId) {
        try {
            const nodes = await chrome.bookmarks.get(sessionId);
            if (nodes && nodes.length > 0) {
                const parsed = parseSessionTitle(nodes[0].title);
                // Update with windowId if present, otherwise just use the new name
                const newTitle = parsed.windowId
                    ? formatSessionTitle(newName, parsed.windowId)
                    : newName;
                await chrome.bookmarks.update(sessionId, { title: newTitle });
            }
        } catch (e) {
            console.warn("Could not find bookmark to rename", e);
        }
    } else {
        await chrome.bookmarks.update(sessionId, { title: formatSessionTitle(newName, windowId) });
    }

    // Update in-memory state if session is loaded
    if (session) {
        session.name = newName;
        if (session.windowId) {
            notifySidebarStateUpdated(session.windowId, sessionId);
        }
    }
}

async function handleSwitchSession(windowId, newSessionId) {
    const oldSessionId = state.windowToSession[windowId];
    if (oldSessionId) {
        const oldSession = state.sessionsById[oldSessionId];
        const placeholder = await chrome.tabs.create({ windowId, url: "about:blank", active: true });

        const tabs = await chrome.tabs.query({ windowId });
        const toClose = tabs.filter(t => t.id !== placeholder.id).map(t => t.id);
        if (toClose.length > 0) {
            await chrome.tabs.remove(toClose);
        }

        for (const tid of toClose) delete state.tabToLogical[tid];
    }

    await bindWindowToSession(windowId, newSessionId);

    const newSession = state.sessionsById[newSessionId];
    let targetLogical = null;
    if (newSession.lastActiveLogicalTabId) {
        targetLogical = newSession.logicalTabs.find(l => l.logicalId === newSession.lastActiveLogicalTabId);
    }
    if (!targetLogical && newSession.logicalTabs.length > 0) {
        targetLogical = newSession.logicalTabs[0];
    }

    if (targetLogical) {
        await focusOrMountLogicalTab(windowId, targetLogical.logicalId);
    }
}

async function focusOrMountLogicalTab(windowId, logicalId) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];
    const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
    if (!logical) return;

    if (logical.liveTabIds.length > 0) {
        const tabId = logical.liveTabIds[0];
        try {
            await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(windowId, { focused: true });
        } catch (e) {
            logical.liveTabIds = [];
            await focusOrMountLogicalTab(windowId, logicalId);
        }
    } else {
        const pendingEntry = { logicalId, windowId };
        pendingMounts.push(pendingEntry);

        // Calculate smart insert index
        // Look for the closest left-side neighbor that is live
        const currentIdx = session.logicalTabs.findIndex(l => l.logicalId === logicalId);
        let insertIndex = 0; // default leftmost

        if (currentIdx > 0) {
            for (let i = currentIdx - 1; i >= 0; i--) {
                const prevLogical = session.logicalTabs[i];
                if (prevLogical.liveTabIds.length > 0) {
                    // Found a live neighbor
                    // Get its live tab index
                    try {
                        const prevLiveTabId = prevLogical.liveTabIds[0]; // assume first
                        const prevLiveTab = await chrome.tabs.get(prevLiveTabId);
                        insertIndex = prevLiveTab.index + 1;
                    } catch (e) { }
                    break;
                }
            }
        }

        try {
            const tab = await chrome.tabs.create({
                windowId,
                url: logical.url,
                active: true,
                index: insertIndex
            });

            const idx = pendingMounts.indexOf(pendingEntry);
            if (idx !== -1) {
                pendingMounts.splice(idx, 1);
                attachLiveTabToLogical(tab, logical);

                // If the bookmark is in a group, we should add the live tab to a group
                if (logical.groupId) {
                    await ensureLiveGroupForLogicalTab(tab.id, logical.groupId, session);
                }

                notifySidebarStateUpdated(windowId, sessionId);
            }
        } catch (e) {
            const idx = pendingMounts.indexOf(pendingEntry);
            if (idx !== -1) pendingMounts.splice(idx, 1);
            console.error("Failed to create tab", e);
        }
    }

    session.lastActiveLogicalTabId = logicalId;
    notifySidebarStateUpdated(windowId, sessionId);
}

async function handleDeleteLogicalTab(windowId, logicalId) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    const logicalIndex = session.logicalTabs.findIndex(l => l.logicalId === logicalId);
    if (logicalIndex === -1) return;
    const logical = session.logicalTabs[logicalIndex];

    // Remove bookmark
    try {
        await chrome.bookmarks.remove(logical.bookmarkId);
    } catch (e) {
        console.error("Failed to delete bookmark", e);
    }

    // Remove from session model
    session.logicalTabs.splice(logicalIndex, 1);

    // Cleanup live tab mappings and close live tabs
    if (logical.liveTabIds && logical.liveTabIds.length > 0) {
        // Switch tab if active tab is being closed
        const activeTab = await chrome.tabs.query({ active: true, windowId }).then(tabs => tabs[0]);
        if (activeTab && logical.liveTabIds.includes(activeTab.id)) {
            await activatePreviousTab(windowId, logical.liveTabIds);
        }

        // Close live tabs as requested
        try {
            await chrome.tabs.remove(logical.liveTabIds);
        } catch (e) {
            console.warn("Failed to close live tabs", e);
        }

        logical.liveTabIds.forEach(tid => {
            delete state.tabToLogical[tid];
        });

        scheduleMountedTabsUpdate();
    }

    notifySidebarStateUpdated(windowId, sessionId);
}

async function handleDeleteLogicalGroup(windowId, groupId) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];
    if (!session) return;

    const group = session.groups[groupId];
    if (!group) return;

    // 1. Remove bookmark folder and children
    try {
        await chrome.bookmarks.removeTree(groupId);
    } catch (e) {
        console.error("Failed to delete bookmark group", e);
    }

    // 2. Identify logical tabs in this group to close their live counterparts
    const tabsInGroup = session.logicalTabs.filter(t => t.groupId === groupId);
    const liveTabsToClose = [];

    tabsInGroup.forEach(t => {
        if (t.liveTabIds && t.liveTabIds.length > 0) {
            liveTabsToClose.push(...t.liveTabIds);
        }
    });

    // 3. Close live tabs
    if (liveTabsToClose.length > 0) {
        // Switch tab if active tab is being closed
        const activeTab = await chrome.tabs.query({ active: true, windowId }).then(tabs => tabs[0]);
        if (activeTab && liveTabsToClose.includes(activeTab.id)) {
            await activatePreviousTab(windowId, liveTabsToClose);
        }

        try {
            await chrome.tabs.remove(liveTabsToClose);
        } catch (e) {
            console.warn("Failed to close live tabs for deleted group", e);
        }

        // Clean up tabToLogical mappings
        liveTabsToClose.forEach(tid => {
            delete state.tabToLogical[tid];
        });
    }

    // 4. Clean up state
    const liveGroupId = Object.keys(state.liveGroupToBookmark).find(k => state.liveGroupToBookmark[k] === groupId);
    if (liveGroupId) {
        delete state.liveGroupToBookmark[liveGroupId];
    }

    await reloadSessionAndPreserveState(sessionId, windowId);
    notifySidebarStateUpdated(windowId, sessionId);
}

async function handleUnmountLogicalTab(windowId, logicalId) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
    if (!logical) return;

    if (logical.liveTabIds.length > 0) {
        const toClose = [...logical.liveTabIds];
        logical.liveTabIds = [];

        // Switch tab if active tab is being closed
        const activeTab = await chrome.tabs.query({ active: true, windowId }).then(tabs => tabs[0]);
        if (activeTab && toClose.includes(activeTab.id)) {
            await activatePreviousTab(windowId, toClose);
        }

        try {
            await chrome.tabs.remove(toClose);
        } catch (e) {
            console.warn("Failed to close live tabs", e);
        }

        toClose.forEach(tid => delete state.tabToLogical[tid]);
        scheduleMountedTabsUpdate();
        notifySidebarStateUpdated(windowId, sessionId);
    }
}

async function handleMoveLogicalTabs(windowId, logicalIds, targetLogicalId, position) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];
    if (!session) return;

    // Validate target
    // targetLogicalId might be a logicalTabId OR a groupId (string)
    // We need to resolve to a bookmark node.
    let targetBookmarkId = null;
    let targetIsGroup = false;

    // Check if target is a group in the session
    if (session.groups[targetLogicalId]) {
        targetBookmarkId = targetLogicalId; // GroupId is the bookmark ID for the folder
        targetIsGroup = true;
    } else {
        const targetLogical = session.logicalTabs.find(l => l.logicalId === targetLogicalId);
        if (targetLogical) {
            targetBookmarkId = targetLogical.bookmarkId;
        } else {
            // Maybe target is the session itself?
            if (targetLogicalId === sessionId) {
                targetBookmarkId = sessionId;
                targetIsGroup = true;
            }
        }
    }

    if (!targetBookmarkId) return;

    // Collect bookmark IDs to move
    const bookmarksToMove = [];
    for (const lid of logicalIds) {
        const l = session.logicalTabs.find(t => t.logicalId === lid);
        if (l) {
            bookmarksToMove.push(l.bookmarkId);
        } else {
            // Could be a group move? Not implemented in UI yet but good to be safe
            // For now assume only tabs.
            const g = session.groups[lid];
            if (g) {
                bookmarksToMove.push(g.groupId); // Move the folder
            }
        }
    }

    if (bookmarksToMove.length === 0) return;

    // Determine destination parent and index
    let parentId, index;

    if (position === 'inside') {
        // Must be a folder/group
        parentId = targetBookmarkId;
        // Append to end
        // Getting children count is async
        const children = await chrome.bookmarks.getChildren(parentId);
        index = children.length;
    } else {
        // 'before' or 'after' relative to target
        const targetNodes = await chrome.bookmarks.get(targetBookmarkId);
        if (!targetNodes || targetNodes.length === 0) return;
        const targetNode = targetNodes[0];
        parentId = targetNode.parentId;

        if (position === 'before') {
            index = targetNode.index;
        } else {
            index = targetNode.index + 1;
        }
    }

    for (let i = 0; i < bookmarksToMove.length; i++) {
        const bid = bookmarksToMove[i];
        await chrome.bookmarks.move(bid, { parentId: parentId, index: index + i });
    }

    // Update state using helper
    const reloadedSession = await reloadSessionAndPreserveState(sessionId, windowId);

    // Sync Live Groups: If we moved logical tabs INTO a group, we should group the live tabs.
    // If we moved OUT of a group, ungroup.
    // This is handled via 'onMoved' listener? No, we just did a bookmark move.
    // We need to explicitly update live state.

    // For each moved logical tab, check its new group status in reloadedSession
    for (const lid of logicalIds) {
        const logical = reloadedSession.logicalTabs.find(l => l.logicalId === lid);
        if (logical && logical.liveTabIds.length > 0) {
            if (logical.groupId) {
                // Should be in a group.
                // We assume user wants live tabs grouped if moving bookmark into a group
                // Use the new helper
                // Note: we iterate liveTabIds, which is array
                for (const tid of logical.liveTabIds) {
                    await ensureLiveGroupForLogicalTab(tid, logical.groupId, session);
                }
            } else {
                // Should be ungrouped
                try {
                    await chrome.tabs.ungroup(logical.liveTabIds);
                } catch(e) {}
            }
        }
    }

    // Sync Live Tabs Order
    // Move corresponding live tabs to match new logical position

    // We moved bookmark(s). Now we need to reorder live tabs to match the new logical order.
    // Strategy:
    // 1. Identify where we moved the logical tabs in the new session.
    // 2. Find the closest preceding logical tab that has a live tab (anchor).
    // 3. Move the live tabs of the moved logical tabs to after the anchor.

    // We can assume that dragging a set of tabs keeps them contiguous in the destination.
    // logicalIds contains the IDs of the moved tabs.
    // reloadedSession has the new order.

    // Find the first moved tab in the new order
    let firstMovedIndex = -1;
    for (let i = 0; i < reloadedSession.logicalTabs.length; i++) {
        if (logicalIds.includes(reloadedSession.logicalTabs[i].logicalId)) {
            firstMovedIndex = i;
            break;
        }
    }

    if (firstMovedIndex !== -1) {
        // Find Anchor (live tab before)
        let liveAnchorIndex = -1;
        for (let i = firstMovedIndex - 1; i >= 0; i--) {
            const prevLogical = reloadedSession.logicalTabs[i];
            if (prevLogical.liveTabIds.length > 0) {
                try {
                    // Use the last live tab of the logical tab (if multiple, rare but possible)
                    const lastLiveTabId = prevLogical.liveTabIds[prevLogical.liveTabIds.length - 1];
                    const anchorTab = await chrome.tabs.get(lastLiveTabId);
                    liveAnchorIndex = anchorTab.index;
                    break;
                } catch (e) { }
            }
        }

        // Collect all live tab IDs for the moved logical tabs (in order)
        const liveTabsToMove = [];
        for (let i = firstMovedIndex; i < reloadedSession.logicalTabs.length; i++) {
            const l = reloadedSession.logicalTabs[i];
            if (logicalIds.includes(l.logicalId)) {
                liveTabsToMove.push(...l.liveTabIds);
            }
        }

        if (liveTabsToMove.length > 0) {
            // Calculate target index
            let targetIndex = 0;
            if (liveAnchorIndex !== -1) {
                targetIndex = liveAnchorIndex + 1;
            }

            // Adjust target index because chrome.tabs.move counts relative to current state.
            // If we move tabs from left to right, index is straightforward.
            // If we move right to left, index is also straightforward if using 'index' property.
            // However, chrome.tabs.move behaves slightly differently depending on direction and selection.
            // But generally, providing the target index works.
            // One caveat: if we move multiple tabs, 'index' is the index of the first tab.

            // Also need to account for the fact that moving tabs effectively removes them from old position.
            // If we move from index 5 to index 2. Target 2.
            // If we move from index 2 to index 5. Target 5 (or 4?).
            // Chrome API handles this if we give the destination index.

            // Refinement: If moving AFTER an anchor, we might need to adjust if the moved tabs were previously BEFORE the anchor.
            // Current indices:
            const currentLiveTabs = await Promise.all(
                liveTabsToMove.map(tid => chrome.tabs.get(tid).catch(() => null))
            );
            const validTabs = currentLiveTabs.filter(t => t !== null);

            // If we are moving past an anchor, we just need to know the anchor's index.
            // But if the tabs to move are currently *before* the anchor, their removal shifts the anchor index down.
            // chrome.tabs.move index is "the index the first tab should end up at".

            // Let's count how many of the tabs-to-move are currently before the calculated targetIndex (which is based on current state).
            // Actually, liveAnchorIndex is based on current state.
            // If we move tabs that are currently at index 0, 1 to after tab at index 5.
            // Anchor is 5. Target is 6.
            // Tabs 0, 1 are moved to 6. Correct.

            // If we move tabs that are currently at index 5, 6 to after tab at index 1.
            // Anchor is 1. Target is 2.
            // Tabs 5, 6 moved to 2. Correct.

            // The only issue is if liveAnchorIndex itself shifts? No, we just fetched it.
            // Wait, if we use `index` in move, it puts them there.
            // If we move [A] to after [B].
            // If A is before B (0, 1). Target 2? No, B becomes 0. A becomes 1.
            // If we say move A to 2. A goes to 2. B stays 1? No B shifts to 0.

            // Safe bet: Just try to move to targetIndex.
            // But if we move multiple tabs, we pass -1? No, we can pass index.

            // Important: Add to ignore set
            validTabs.forEach(t => state.ignoreMoveEventsForTabIds.add(t.id));
            setTimeout(() => {
                validTabs.forEach(t => state.ignoreMoveEventsForTabIds.delete(t.id));
            }, 2000);

            try {
                const ids = validTabs.map(t => t.id);
                // We prefer moving one by one to ensure order if they are not contiguous?
                // Or allow block move.
                // chrome.tabs.move supports array of IDs and a single index.
                // It places them starting at index.
                await chrome.tabs.move(ids, { index: targetIndex });
            } catch (e) {
                console.warn("Failed to sync live tabs order", e);
                validTabs.forEach(t => state.ignoreMoveEventsForTabIds.delete(t.id));
            }
        }
    }

    notifySidebarStateUpdated(windowId, sessionId);
}

async function handleUnmountAllExcept(windowId, logicalIdsToKeep) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    const keepSet = new Set(logicalIdsToKeep);
    const toClose = [];

    for (const lt of session.logicalTabs) {
        if (!lt.liveTabIds.length) continue;
        if (keepSet.has(lt.logicalId)) continue;

        toClose.push(...lt.liveTabIds);
        lt.liveTabIds = [];
    }

    if (toClose.length > 0) {
        if (keepSet.size === 0) {
            await chrome.tabs.create({ windowId, url: "about:blank" });
        }
        await chrome.tabs.remove(toClose);
        toClose.forEach(tid => delete state.tabToLogical[tid]);
    }

    notifySidebarStateUpdated(windowId, sessionId);
}
