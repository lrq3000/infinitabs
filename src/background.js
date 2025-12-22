// background.js

// --- Constants ---
const ROOT_FOLDER_TITLE = "InfiniTabs Sessions";

// --- Global State ---
// Held in memory, persisted where necessary.
const state = {
    sessionsById: {},     // Record<SessionId, Session>
    windowToSession: {},  // Record<WindowId, SessionId>
    tabToLogical: {},     // Record<TabId, LogicalTabId>
    ignoreMoveEventsForTabIds: new Set(), // Set<TabId>
    workspaceHistory: [], // Array<WorkspaceSnapshot>
    favoriteWorkspaces: [], // Array<WorkspaceSnapshot>
    lastKnownWorkspace: null, // WorkspaceSnapshot
    historySize: 50,
    reloadOnRestart: false, // User Preference
    initialized: false
};


// Global flag to suppress auto-session creation during restore
// Kept outside 'state' object to ensure it's not accidentally reset or lost during state operations
let isRestoring = false;

// --- Helper Functions ---
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

    // 5. Notify UI
    notifySidebarStateUpdated(windowId, sessionId);

    // 6. Track Workspace
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
        } else {
            // Logic for new tabs is complex (positioning etc). 
            // For simplified sync on reload: if we can't find it, we create it.
            // But checking if it's already mapped via state.tabToLogical is risky if state was lost.
            // We rely on URL match for restoration.

            // If no URL match found, create new.
            const createdBookmark = await chrome.bookmarks.create({
                parentId: sessionId,
                title: tab.title || "New Tab",
                url: tab.url || "about:blank"
            });

            const logical = {
                logicalId: generateGuid(),
                sessionId: sessionId,
                bookmarkId: createdBookmark.id,
                url: tab.url || "about:blank",
                title: tab.title || "New Tab",
                groupId: null,
                indexInSession: session.logicalTabs.length, // Append
                liveTabIds: [],
                lastUpdated: Date.now(),
                lastSavedTitle: tab.title || "New Tab",
                lastSavedUrl: tab.url || "about:blank"
            };

            session.logicalTabs.push(logical);
            attachLiveTabToLogical(tab, logical);
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
            console.log('Saving window geometry:', enriched);
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
        // Even if trivial, we might want to update lastKnownWorkspace if we want to detect "clean exit" vs crash?
        // But user said: "Skip saving trivial workspaces".
        // However, for crash detection, if we only save rich workspaces, 
        // and on startup we see a trivial one, we know it crashed?
        // Actually, if we close gracefully, we should probably clear lastKnownWorkspace or mark it?
        // But the requirement says: "Always record states implicitly."
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
                // We preserve the ID of the history entry? 
                // User said "update the parameters of the last historical workspace record".
                // So we keep the ID, but update timestamp and sessions (which contain geometry).
                last.sessions = snapshot.sessions;
                last.timestamp = snapshot.timestamp;
                // last.windowCount/sessionCount are same.

                // Store simplified 'isTrivial' flag on the lastKnownWorkspace object (not in history)
                // for robust crash detection on startup (when sessions aren't loaded yet).
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

    // Store simplified 'isTrivial' flag on the lastKnownWorkspace object (not in history)
    // for robust crash detection on startup (when sessions aren't loaded yet).
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
        // 1. Close all current windows (except maybe the one we are running in? No, "Close all current windows")
        // But if we close the window running the extension (if it's not a service worker?), we might die?
        // Manifest V3 Service Worker lives independently.

        const currentWindows = await chrome.windows.getAll();
        // We should probably keep one window open while we open others, or just open new ones first then close old ones?
        // "Close all current windows" implies we want a clean slate.
        // If we close ALL windows, the browser might exit if "Continue running background apps" is off?
        // Safer: Open new windows first, then close old ones.

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
                    console.log(`restoreWorkspace: Fallback created new session ${created.id}`);
                    await bindWindowToSession(win.id, created.id);
                } catch (fallbackErr) {
                    console.error("restoreWorkspace: Critical - Failed to create fallback session", fallbackErr);
                }
            }
        }

        // Close old windows
        for (const win of currentWindows) {
            // Don't close the DevTools window if open?
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
            const storage = await chrome.storage.local.get(['windowToSession', 'workspaceHistory', 'favoriteWorkspaces', 'lastKnownWorkspace', 'historySize', 'reloadOnRestart']);
            if (storage.windowToSession) state.windowToSession = storage.windowToSession;
            if (storage.workspaceHistory) state.workspaceHistory = storage.workspaceHistory;
            if (storage.favoriteWorkspaces) state.favoriteWorkspaces = storage.favoriteWorkspaces;
            if (storage.lastKnownWorkspace) state.lastKnownWorkspace = storage.lastKnownWorkspace;
            if (storage.historySize) state.historySize = storage.historySize;
            if (storage.reloadOnRestart !== undefined) state.reloadOnRestart = storage.reloadOnRestart;

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

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.reloadOnRestart) {
        state.reloadOnRestart = changes.reloadOnRestart.newValue;
    }
});

// Detect graceful shutdown?
// chrome.runtime.onSuspend is not reliable in Service Workers for this purpose usually, 
// but we can try to use it to clear the "crash" flag if we had one.
// Actually, the heuristic is: "If there is a lastKnownWorkspace ... and current state is trivial ... treat as crash".
// So we don't need onSuspend. We just rely on the state on startup.

// Export for testing/usage if modules were used, but in Service Worker we rely on listeners.

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

    console.log('Window bounds changed:', window.id, window.state);
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

const pendingMounts = []; // Queue of { logicalId, windowId }

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

    if (tab.index > 0) {
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
                            insertParentId = nodes[0].parentId;
                            insertIndex = nodes[0].index + 1;
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
        // because onActivated might have fired before we established the mapping.
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

    if (changed) {
        logical.lastUpdated = Date.now();

        // Debounce bookmark update
        scheduleBookmarkUpdate(logicalId, () => {
            // Double check if we really need to update bookmark
            if (logical.title === logical.lastSavedTitle && logical.url === logical.lastSavedUrl) {
                return;
            }

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

// Queue for serializing move operations to handle group moves (SHIFT+Drag)
const moveMutex = new class {
    constructor() { this.p = Promise.resolve(); }
    run(fn) {
        this.p = this.p.then(fn).catch(e => console.error("Mutex error", e));
        return this.p;
    }
}();

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

    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;

    const session = state.sessionsById[sessionId];
    if (!session) return;

    const logicalId = state.tabToLogical[tabId];

    if (logicalId) {
        session.lastActiveLogicalTabId = logicalId;
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
                case "SEARCH_ALL_SESSIONS": {
                    const results = await searchAllSessions(message.query);
                    sendResponse({ results });
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
        // Close live tabs as requested
        try {
            await chrome.tabs.remove(logical.liveTabIds);
        } catch (e) {
            console.warn("Failed to close live tabs", e);
        }

        logical.liveTabIds.forEach(tid => {
            delete state.tabToLogical[tid];
        });
    }

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

        try {
            await chrome.tabs.remove(toClose);
        } catch (e) {
            console.warn("Failed to close live tabs", e);
        }

        toClose.forEach(tid => delete state.tabToLogical[tid]);
        notifySidebarStateUpdated(windowId, sessionId);
    }
}

async function searchAllSessions(query) {
    if (!query || !query.trim()) return [];
    const rootId = await ensureRootFolder();
    const sessions = await chrome.bookmarks.getSubTree(rootId);
    if (!sessions || !sessions.length) return [];

    const root = sessions[0];
    const matches = [];
    const terms = query.toLowerCase().split(/\s+/).filter(t => t);

    // Helper to check match
    const isMatch = (title, url) => {
        const text = (title + " " + (url || "")).toLowerCase();
        return terms.every(term => text.includes(term));
    };

    // Traverse
    // Root children are Sessions.
    for (const sessionFolder of root.children || []) {
        if (sessionFolder.url) continue; // Should be folder
        const { name } = parseSessionTitle(sessionFolder.title);

        // Check session children (Tabs or Groups)
        const traverse = (nodes) => {
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                if (node.url) {
                    // It's a tab
                    if (isMatch(node.title, node.url)) {
                        // Extract Context
                        let prev = null;
                        let next = null;

                        // Look back
                        if (i > 0) {
                             const p = nodes[i - 1];
                             prev = p.url ? p.title : `Group: ${p.title}`;
                        }

                        // Look forward
                        if (i < nodes.length - 1) {
                             const n = nodes[i + 1];
                             next = n.url ? n.title : `Group: ${n.title}`;
                        }

                        matches.push({
                            sessionId: sessionFolder.id,
                            sessionName: name,
                            tab: {
                                title: node.title,
                                url: node.url,
                                id: node.id // bookmark id
                            },
                            context: { prev, next }
                        });
                    }
                } else {
                    // It's a group
                    traverse(node.children || []);
                }
            }
        }
        traverse(sessionFolder.children || []);
    }
    return matches;
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

    // Execute moves sequentially
    // Note: When moving multiple items to the same index, we need to increment the index
    // for each subsequent item IF we want them in order A, B, C at position X.
    // X -> A, X+1 -> B, ...

    // However, if we move A then B.
    // Move A to X.
    // Move B to X+1.
    // This assumes B wasn't already before A, shifting indices.

    // chrome.bookmarks.move handles re-indexing, but we must be careful.
    // Safest strategy: Move them one by one to the calculated target index.
    // If we insert A at X. The old item at X becomes X+1.
    // If we then insert B at X+1. It goes after A.

    for (let i = 0; i < bookmarksToMove.length; i++) {
        const bid = bookmarksToMove[i];
        await chrome.bookmarks.move(bid, { parentId: parentId, index: index + i });
    }

    // Update state using helper
    const reloadedSession = await reloadSessionAndPreserveState(sessionId, windowId);

    // Sync Live Tabs: Move corresponding live tabs to match new logical position
    // Requirement: "corresponding live tab should be moved to be just on the right (so just after) the live tab that corresponds to the logical tab just above the logical tab that was moved."

    // 1. Identify the logical tabs we just moved.
    // They are in 'logicalIds'.
    // 2. Find the logical tab *immediately preceding* the first moved logical tab in the *new* order.
    // Note: The logicalIds might end up contiguous or not depending on the move, but typically a drag drop is a block move.
    // If we moved [A, B] to after C. New order: C, A, B.
    // Anchor for A is C. Anchor for B is A.
    // We can move them as a block if we find the anchor for the block.

    // Let's assume block move for simplicity and robustness.
    // Find the first moved logical tab in the new session using the immutable bookmark ID.
    // logicalIds contains OLD IDs. reloadedSession has NEW IDs.
    const firstMovedBookmarkId = bookmarksToMove[0];
    const newIndex = reloadedSession.logicalTabs.findIndex(l => l.bookmarkId === firstMovedBookmarkId);

    if (newIndex !== -1) {
        let liveAnchorIndex = -1;

        // Search upwards for a logical tab that has a live tab
        for (let i = newIndex - 1; i >= 0; i--) {
            const prevLogical = reloadedSession.logicalTabs[i];
            if (prevLogical.liveTabIds.length > 0) {
                // Found an anchor
                try {
                    const anchorTab = await chrome.tabs.get(prevLogical.liveTabIds[0]);
                    liveAnchorIndex = anchorTab.index;
                } catch (e) { }
                break;
            }
        }

        // Collect live tab IDs to move
        // Use bookmark IDs to identify the moved tabs in the new session
        const liveTabsToMove = [];

        for (let i = newIndex; i < reloadedSession.logicalTabs.length; i++) {
            const l = reloadedSession.logicalTabs[i];
            // Check if this logical tab corresponds to one of the moved bookmarks
            if (bookmarksToMove.includes(l.bookmarkId)) {
                liveTabsToMove.push(...l.liveTabIds);
            }
            // Stop if we hit a tab that wasn't moved?
            // In a drag operation of multiple items, they are inserted contiguously.
            // If we have disjoint selection A, C moved to X. They become X, X+1.
            // So iterating from newIndex should find them all sequentially.
        }

        if (liveTabsToMove.length > 0) {
            // Retrieve current indices for accurate calculation
            const currentLiveTabs = await Promise.all(
                liveTabsToMove.map(tid => chrome.tabs.get(tid).catch(() => null))
            );
            const validTabs = currentLiveTabs.filter(t => t !== null);
            if (validTabs.length === 0) return;

            // Calculate target index
            // Formula: AnchorIndex - (Count of Moved Tabs currently LEFT of Anchor) + 1
            // If Anchor doesn't exist (Start), Target = 0.

            let targetIndex = 0;
            if (liveAnchorIndex !== -1) {
                const anchorIndex = liveAnchorIndex;
                const movingFromLeftCount = validTabs.filter(t => t.index < anchorIndex).length;
                targetIndex = anchorIndex - movingFromLeftCount + 1;
            }

            // Ensure non-negative
            if (targetIndex < 0) targetIndex = 0;

            // Add to ignore set to prevent echo
            validTabs.forEach(t => state.ignoreMoveEventsForTabIds.add(t.id));

            // Safety: clear after 2 seconds
            setTimeout(() => {
                validTabs.forEach(t => state.ignoreMoveEventsForTabIds.delete(t.id));
            }, 2000);

            try {
                const ids = validTabs.map(t => t.id);
                await chrome.tabs.move(ids, { index: targetIndex });
            } catch (e) {
                console.warn("Failed to sync live tabs", e);
                // Cleanup on error
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
