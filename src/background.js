// background.js

// --- Constants ---
const ROOT_FOLDER_TITLE = "LazyTabs Sessions";

// --- Global State ---
// Held in memory, persisted where necessary.
const state = {
  sessionsById: {},     // Record<SessionId, Session>
  windowToSession: {},  // Record<WindowId, SessionId>
  tabToLogical: {},     // Record<TabId, LogicalTabId>
  initialized: false,
  ignoringTabMoves: new Set() // Set<TabId>
};

// --- Helper Functions ---

function generateGuid() {
  return self.crypto.randomUUID();
}

// Debounce helper
const bookmarkUpdateTimers = {}; // logicalId -> timerId
let sidebarUpdateTimer = null;

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

/**
 * Ensures the root bookmark folder exists.
 * @returns {Promise<string>} The ID of the root folder.
 */
async function ensureRootFolder() {
  const existing = await chrome.bookmarks.search({ title: ROOT_FOLDER_TITLE });
  // Ensure it is a folder (no URL)
  const folder = existing.find(n => n.title === ROOT_FOLDER_TITLE && !n.url);
  if (folder) return folder.id;
  
  const created = await chrome.bookmarks.create({ title: ROOT_FOLDER_TITLE });
  return created.id;
}

/**
 * Loads a session from a bookmark folder.
 * @param {string} sessionId - The bookmark ID of the session folder.
 * @returns {Promise<Object>} The Session object.
 */
async function loadSessionFromBookmarks(sessionId) {
  const sessionNodes = await chrome.bookmarks.getSubTree(sessionId);
  if (!sessionNodes || sessionNodes.length === 0) {
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
  
  return {
    sessionId: sessionId,
    name: sessionFolder.title,
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
    .map(folder => ({ sessionId: folder.id, name: folder.title }));
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
        windowToSession: state.windowToSession
    });
}

/**
 * Binds a window to a session.
 */
async function bindWindowToSession(windowId, sessionId) {
  // 1. Load session from bookmarks
  const session = await loadSessionFromBookmarks(sessionId);
  session.windowId = windowId;
  
  // 2. Update global state
  state.sessionsById[sessionId] = session;
  state.windowToSession[windowId] = sessionId;
  
  // 3. Persist mapping
  await persistState();
  
  // 4. Sync existing tabs
  await syncExistingTabsInWindowToSession(windowId, sessionId);
  
  // 5. Notify UI
  notifySidebarStateUpdated(windowId, sessionId);
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

// --- Initialization ---

let initPromise = null;

function init() {
  if (state.initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
      console.log("LazyTabs: Background initializing...");
      try {
          await ensureRootFolder();

          if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
              chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
                .catch(err => console.warn("setPanelBehavior failed", err));
          }
          
          // Restore persisted state
          const storage = await chrome.storage.local.get(['windowToSession']);
          if (storage.windowToSession) {
              state.windowToSession = storage.windowToSession;
          }
          
          const windows = await chrome.windows.getAll();
          
          for (const win of windows) {
            const storedSessionId = state.windowToSession[win.id];
            if (storedSessionId) {
              try {
                await bindWindowToSession(win.id, storedSessionId);
              } catch (e) {
                console.warn(`Could not restore session ${storedSessionId} for window ${win.id}`, e);
                // Clean up invalid mapping
                delete state.windowToSession[win.id];
                await persistState();
              }
            } else {
                const rootId = await ensureRootFolder();
                const newSessionTitle = `Session - Window ${win.id}`;
                const created = await chrome.bookmarks.create({
                    parentId: rootId,
                    title: newSessionTitle
                });
                await bindWindowToSession(win.id, created.id);
            }
          }

          state.initialized = true;
          console.log("LazyTabs: Background initialized.");
      } catch (e) {
          console.error("LazyTabs: Background init failed", e);
          initPromise = null; // Allow retry
          throw e;
      }
  })();
  
  return initPromise;
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Export for testing/usage if modules were used, but in Service Worker we rely on listeners.

// --- Event Listeners ---

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

  // Reload session structure
  const reloadedSession = await loadSessionFromBookmarks(sessionId);
  reloadedSession.windowId = windowId;
  
  // CRITICAL: Fetch the *latest* state from memory to merge liveTabIds.
  // Do NOT use currentSessionSnapshot as it might be stale if other events fired concurrently.
  const latestSessionState = state.sessionsById[sessionId] || currentSessionSnapshot;

  reloadedSession.logicalTabs.forEach(newLt => {
      const oldLt = latestSessionState.logicalTabs.find(old => old.bookmarkId === newLt.bookmarkId);
      if (oldLt) {
          newLt.liveTabIds = oldLt.liveTabIds;
      }
  });
  
  const newLogical = reloadedSession.logicalTabs.find(l => l.bookmarkId === createdBookmark.id);
  if (newLogical) {
      attachLiveTabToLogical(tab, newLogical);
  }

  state.sessionsById[sessionId] = reloadedSession;
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

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
    if (state.ignoringTabMoves.has(tabId)) {
        state.ignoringTabMoves.delete(tabId);
        return;
    }

    if (!state.initialized) await init();

    const logicalId = state.tabToLogical[tabId];
    if (!logicalId) return;

    const windowId = moveInfo.windowId;
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    // Heuristic: sync logical order to live order where possible.
    chrome.tabs.query({ windowId }, async (tabs) => {
        const liveTabsInOrder = tabs;
        
        const movedTabIndex = liveTabsInOrder.findIndex(t => t.id === tabId);
        if (movedTabIndex === -1) return;

        // Find the closest previous live tab that has a logical tab
        let prevLogical = null;
        for (let i = movedTabIndex - 1; i >= 0; i--) {
            const t = liveTabsInOrder[i];
            const lid = state.tabToLogical[t.id];
            if (lid) {
                const l = session.logicalTabs.find(lt => lt.logicalId === lid);
                if (l) {
                    prevLogical = l;
                    break;
                }
            }
        }

        const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
        if (logical) {
            if (prevLogical) {
                // Move after the found previous logical tab
                try {
                    const nodes = await chrome.bookmarks.get(prevLogical.bookmarkId);
                    if (nodes && nodes.length > 0) {
                        // If they are in the same folder (group), great.
                        // If different folders (groups), we might be moving it into a group or out of one?
                        // For now, let's assume flat structure or moving within same parent if possible,
                        // or just move to the same parent as prevLogical.
                        const prevNode = nodes[0];
                        await chrome.bookmarks.move(logical.bookmarkId, { parentId: prevNode.parentId, index: prevNode.index + 1 });
                    }
                } catch (e) {
                    console.error("Failed to sync logical position (after)", e);
                }
            } else {
                // No previous mapped tab found -> Move to start
                // But start of what? The session root? Or the group it is in?
                // If the user moved the tab to the very beginning of the window,
                // we probably want it at the beginning of the session.
                try {
                    await chrome.bookmarks.move(logical.bookmarkId, { parentId: session.sessionId, index: 0 });
                } catch (e) {
                     console.error("Failed to sync logical position (start)", e);
                }
            }
        }

        // Reload session structure
        const reloadedSession = await loadSessionFromBookmarks(sessionId);
        reloadedSession.windowId = windowId;
        
        // CRITICAL: Fetch the *latest* state from memory to merge liveTabIds.
        const latestSessionState = state.sessionsById[sessionId] || session;

        reloadedSession.logicalTabs.forEach(l => {
             const oldL = latestSessionState.logicalTabs.find(old => old.bookmarkId === l.bookmarkId);
             if (oldL) l.liveTabIds = oldL.liveTabIds;
        });
        state.sessionsById[sessionId] = reloadedSession;
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
                             const rootId = await ensureRootFolder();
                             const created = await chrome.bookmarks.create({
                                parentId: rootId,
                                title: `Session - Window ${windowId}`
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
                case "DELETE_LOGICAL_TAB": {
                    await handleDeleteLogicalTab(message.windowId, message.logicalId);
                    sendResponse({ success: true });
                    break;
                }
                case "MOVE_LOGICAL_TAB": {
                    await handleMoveLogicalTab(message.windowId, message.logicalId, message.targetLogicalId, message.position);
                    sendResponse({ success: true });
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
                    } catch (e) {}
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

async function handleMoveLogicalTab(windowId, logicalId, targetLogicalId, position) {
    const sessionId = state.windowToSession[windowId];
    if (!sessionId) return;
    const session = state.sessionsById[sessionId];

    const logical = session.logicalTabs.find(l => l.logicalId === logicalId);
    const target = session.logicalTabs.find(l => l.logicalId === targetLogicalId);

    if (!logical || !target) return;

    // 1. Move Bookmark
    try {
        const targetNodes = await chrome.bookmarks.get(target.bookmarkId);
        if (targetNodes && targetNodes.length > 0) {
            const targetNode = targetNodes[0];
            let newIndex = targetNode.index;
            if (position === "after") {
                newIndex++;
            }

            await chrome.bookmarks.move(logical.bookmarkId, {
                parentId: targetNode.parentId,
                index: newIndex
            });
        }
    } catch (e) {
        console.error("Failed to move bookmark", e);
        return;
    }

    // 2. Reload Session to update order
    const reloadedSession = await loadSessionFromBookmarks(sessionId);
    reloadedSession.windowId = windowId;

    // Preserve live state
    const currentSessionSnapshot = state.sessionsById[sessionId];
    reloadedSession.logicalTabs.forEach(l => {
         const oldL = currentSessionSnapshot.logicalTabs.find(old => old.bookmarkId === l.bookmarkId);
         if (oldL) l.liveTabIds = oldL.liveTabIds;
    });

    // Preserve last active
    reloadedSession.lastActiveLogicalTabId = currentSessionSnapshot.lastActiveLogicalTabId;

    state.sessionsById[sessionId] = reloadedSession;

    // 3. Sync Live Tab Position
    // We need to move the live tab (if exists) to the new correct position.
    // The correct position is determined by the live tab of the closest PREVIOUS logical tab (that is live).

    if (logical.liveTabIds.length > 0) {
        const liveTabId = logical.liveTabIds[0]; // Assume first live tab

        // Find new index of logical tab
        const newLogicalIndex = reloadedSession.logicalTabs.findIndex(l => l.logicalId === logical.logicalId);

        // Find closest previous live tab
        let prevLiveTabInfo = null;
        for (let i = newLogicalIndex - 1; i >= 0; i--) {
            const prevL = reloadedSession.logicalTabs[i];
            if (prevL.liveTabIds.length > 0) {
                prevLiveTabInfo = { logical: prevL, liveTabId: prevL.liveTabIds[0] };
                break;
            }
        }

        // Use ignoringTabMoves to prevent feedback loop where the live tab move
        // triggers onMoved which then tries to re-sync the bookmark position.
        state.ignoringTabMoves.add(liveTabId);

        // Fallback cleanup in case onMoved doesn't fire (e.g. same index)
        setTimeout(() => {
            if (state.ignoringTabMoves.has(liveTabId)) {
                state.ignoringTabMoves.delete(liveTabId);
            }
        }, 1000);

        if (prevLiveTabInfo) {
            try {
                const prevLiveTab = await chrome.tabs.get(prevLiveTabInfo.liveTabId);
                await chrome.tabs.move(liveTabId, { index: prevLiveTab.index + 1 });
            } catch (e) {
                console.warn("Failed to move live tab (after prev)", e);
                state.ignoringTabMoves.delete(liveTabId);
            }
        } else {
            // No previous live tab -> Move to start of window?
            // Or after pinned tabs?
            try {
                await chrome.tabs.move(liveTabId, { index: 0 });
            } catch (e) {
                console.warn("Failed to move live tab (start)", e);
                state.ignoringTabMoves.delete(liveTabId);
            }
        }
    }

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
