// sidebar.js

const sessionSelector = document.getElementById('session-selector');
const refreshSessionsBtn = document.getElementById('refresh-sessions');
const unmountOthersBtn = document.getElementById('unmount-others-btn');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const tabsContainer = document.getElementById('tabs-container');

// Search Elements
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear');
const searchPrevBtn = document.getElementById('search-prev');
const searchNextBtn = document.getElementById('search-next');

let currentSession = null;
let currentWindowId = null;
let isDarkMode = false;
let currentMatches = [];
let currentMatchIndex = -1;

// --- Initialization ---

async function init() {
  // Get current window
  const window = await chrome.windows.getCurrent();
  currentWindowId = window.id;

  // Setup Listeners
  refreshSessionsBtn.addEventListener('click', loadSessionsList);
  sessionSelector.addEventListener('change', onSessionSwitch);
  unmountOthersBtn.addEventListener('click', onUnmountOthers);
  themeToggleBtn.addEventListener('click', toggleTheme);
  
  // Search Listeners
  searchInput.addEventListener('input', performSearch);
  searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          clearSearch();
      }
  });
  searchClearBtn.addEventListener('click', clearSearch);
  searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
  searchNextBtn.addEventListener('click', () => navigateSearch(1));
  document.addEventListener('keydown', onKeyDown);

  chrome.runtime.onMessage.addListener(onMessage);

  // Load Theme
  const stored = localStorage.getItem('lazyTabsTheme');
  if (stored === 'dark') {
    setTheme(true);
  } else {
    setTheme(false);
  }

  // Initial Data Load
  await loadSessionsList();
  await refreshCurrentSession();
}

// --- Logic ---

function setTheme(dark) {
  isDarkMode = dark;
  if (dark) {
    document.body.classList.add('dark-mode');
    themeToggleBtn.textContent = "🌙"; // Moon
  } else {
    document.body.classList.remove('dark-mode');
    themeToggleBtn.textContent = "☀"; // Sun
  }
  localStorage.setItem('lazyTabsTheme', dark ? 'dark' : 'light');
}

function toggleTheme() {
  setTheme(!isDarkMode);
}

async function loadSessionsList() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SESSION_LIST" });
  const sessions = response.sessions || [];
  
  sessionSelector.innerHTML = '<option value="" disabled>Select Session...</option>';
  sessions.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = s.name;
    sessionSelector.appendChild(opt);
  });
  
  // If we have a current session, select it
  if (currentSession) {
    sessionSelector.value = currentSession.sessionId;
  }
}

async function refreshCurrentSession() {
  const response = await chrome.runtime.sendMessage({ 
    type: "GET_CURRENT_SESSION_STATE", 
    windowId: currentWindowId 
  });
  
  if (response.session) {
    currentSession = response.session;
    sessionSelector.value = currentSession.sessionId;
    renderSession(currentSession);
  } else {
    currentSession = null;
    tabsContainer.innerHTML = '<div style="padding:10px; color:#888;">No session active for this window. Select one above.</div>';
  }
}

async function onSessionSwitch(e) {
  const newSessionId = e.target.value;
  if (!newSessionId) return;
  
  await chrome.runtime.sendMessage({
    type: "SWITCH_SESSION",
    windowId: currentWindowId,
    sessionId: newSessionId
  });
  
  // The background will reply, but we also expect a STATE_UPDATED message
  // which will trigger re-render.
}

async function onUnmountOthers() {
  if (!currentSession) return;
  
  // For MVP: Unmount all except the one that is currently "active" in the UI sense?
  // Or the one that is lastActiveLogicalTabId?
  // Let's keep the `lastActiveLogicalTabId`.
  
  const keepId = currentSession.lastActiveLogicalTabId;
  const toKeep = keepId ? [keepId] : [];
  
  if (confirm("Close all live tabs except the active one? logical tabs (bookmarks) will remain.")) {
      await chrome.runtime.sendMessage({
        type: "UNMOUNT_ALL_EXCEPT",
        windowId: currentWindowId,
        logicalIdsToKeep: toKeep
      });
  }
}

function onMessage(message, sender, sendResponse) {
  if (message.type === "STATE_UPDATED") {
    if (message.windowId === currentWindowId) {
      currentSession = message.session;
      // Update selector if needed (e.g. if name changed or just bound)
      if (sessionSelector.value !== currentSession.sessionId) {
          // It might be a new session not in our list yet?
          // Let's reload list just in case, but lazily? 
          // Check if option exists
          const opt = sessionSelector.querySelector(`option[value="${currentSession.sessionId}"]`);
          if (opt) {
              sessionSelector.value = currentSession.sessionId;
          } else {
              // Reload list to find it
              loadSessionsList().then(() => {
                  sessionSelector.value = currentSession.sessionId;
              });
          }
      }
      renderSession(currentSession);
      // Re-apply search if exists
      if (searchInput.value) performSearch();
    }
  }
}

// --- Search Logic ---

function parseSearchQuery(query) {
    const terms = [];
    const regex = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = regex.exec(query)) !== null) {
        if (match[1]) {
            // Quoted term
            terms.push({ term: match[1].toLowerCase(), exact: true });
        } else {
            // Regular term
            terms.push({ term: match[2].toLowerCase(), exact: false });
        }
    }
    return terms;
}

function clearSearch() {
    searchInput.value = '';
    performSearch();
}

function performSearch() {
    const query = searchInput.value;
    
    // Toggle clear button visibility
    if (query.length > 0) {
        searchClearBtn.style.display = 'block';
    } else {
        searchClearBtn.style.display = 'none';
    }

    currentMatches = [];
    currentMatchIndex = -1;
    
    const tabItems = document.querySelectorAll('.tab-item');
    tabItems.forEach(el => {
        el.classList.remove('search-match', 'active-match');
    });

    if (!query) return;
    
    const terms = parseSearchQuery(query);
    if (terms.length === 0) return;

    tabItems.forEach(el => {
        const title = el.querySelector('.tab-title').textContent.toLowerCase();
        const url = el.title.toLowerCase(); // Render sets title attribute to URL
        
        let matches = false;
        
        // OR Logic: Match any term
        for (const { term, exact } of terms) {
            if (exact) {
                // Exact match (must contain the full phrase)
                if (title.includes(term) || url.includes(term)) {
                    matches = true;
                    break;
                }
            } else {
                // Regular match
                if (title.includes(term) || url.includes(term)) {
                    matches = true;
                    break;
                }
            }
        }
        
        if (matches) {
            el.classList.add('search-match');
            currentMatches.push(el);
        }
    });

    if (currentMatches.length > 0) {
        navigateSearch(1); // Go to first match
    }
}

function navigateSearch(direction) {
    if (currentMatches.length === 0) return;
    
    // Clear active style on current
    if (currentMatchIndex !== -1 && currentMatches[currentMatchIndex]) {
        currentMatches[currentMatchIndex].classList.remove('active-match');
    }
    
    currentMatchIndex += direction;
    
    // Cycle
    if (currentMatchIndex >= currentMatches.length) currentMatchIndex = 0;
    if (currentMatchIndex < 0) currentMatchIndex = currentMatches.length - 1;
    
    const activeEl = currentMatches[currentMatchIndex];
    activeEl.classList.add('active-match');
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function onKeyDown(e) {
    // Ctrl+Shift+F
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        searchInput.focus();
    }
}

// --- Rendering ---

function renderSession(session) {
  tabsContainer.innerHTML = '';
  
  if (!session.logicalTabs || session.logicalTabs.length === 0) {
    tabsContainer.innerHTML = '<div style="padding:10px; color:#888;">Empty Session</div>';
    return;
  }

  // Group handling: 
  // The logicalTabs list is flat but has groupId.
  // We need to insert group headers.
  
  // We can just iterate the flat list. 
  // But since the flat list is sorted by `indexInSession`, we need to detect when we enter a new group.
  // Actually, the spec says "Tab Groups are stored as bookmark subfolders".
  // `indexInSession` interleaves top-level items and groups. 
  // Wait, my background logic flattened everything into `logicalTabs`.
  // But `groups` dictionary exists.
  
  // We need to reconstruct the render order.
  // The `logicalTabs` array is already sorted by `indexInSession`.
  // However, `indexInSession` was incremented for groups AND tabs.
  // But `logicalTabs` only contains TABS.
  // So we might have gaps in `indexInSession` where the Group Folder itself was.
  
  // Actually, my `loadSessionFromBookmarks` logic:
  // - Top level bookmark: index++
  // - Top level folder (Group): index++ (for the group itself), then children bookmarks: index++
  
  // So we can iterate through the expected indices or just iterate logicalTabs and check group transitions?
  // No, if we have:
  // Tab 1 (idx 0)
  // Group A (idx 1) -> Tab A1 (idx 2), Tab A2 (idx 3)
  // Tab 2 (idx 4)
  
  // `logicalTabs` will contain: Tab 1, Tab A1, Tab A2, Tab 2.
  // We need to inject "Group A" header between Tab 1 and Tab A1.
  
  // Better approach: Reconstruct a tree or list with group headers.
  // We can look at `session.groups`.
  
  const itemsToRender = [];
  
  // Add tabs
  session.logicalTabs.forEach(tab => {
    itemsToRender.push({ type: 'tab', data: tab, index: tab.indexInSession });
  });
  
  // Add groups headers
  Object.values(session.groups).forEach(group => {
    itemsToRender.push({ type: 'group', data: group, index: group.indexInSession });
  });
  
  // Sort by index
  itemsToRender.sort((a, b) => a.index - b.index);
  
  // Render
  itemsToRender.forEach(item => {
    if (item.type === 'group') {
      const groupEl = document.createElement('div');
      groupEl.className = 'group-header';
      groupEl.textContent = item.data.title;
      tabsContainer.appendChild(groupEl);
    } else {
      renderTab(item.data, session);
    }
  });
}

function renderTab(tab, session) {
  const el = document.createElement('div');
  const isLive = tab.liveTabIds.length > 0;
  const isActive = session.lastActiveLogicalTabId === tab.logicalId;
  
  let className = 'tab-item';
  if (tab.groupId) className += ' indented';
  if (isLive) className += ' live';
  if (isActive) className += ' active-live';
  else className += ' logical';
  
  el.className = className;
  el.title = tab.url; // Tooltip
  
  const faviconUrl = chrome.runtime.getURL("/_favicon/") + "?pageUrl=" + encodeURIComponent(tab.url) + "&size=16";
  
  el.innerHTML = `
    <span class="live-indicator"></span>
    <img class="tab-icon" src="${faviconUrl}" />
    <span class="tab-title">${escapeHtml(tab.title)}</span>
  `;

  // Delete Button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'tab-delete-btn';
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete logical tab and bookmark';
  deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent tab selection
      
      chrome.storage.local.get({ confirmDeleteLogicalTab: true }, (items) => {
          const shouldConfirm = items.confirmDeleteLogicalTab;
          if (!shouldConfirm || confirm("Delete this logical tab (bookmark)?")) {
              chrome.runtime.sendMessage({
                  type: "DELETE_LOGICAL_TAB",
                  windowId: currentWindowId,
                  logicalId: tab.logicalId
              });
          }
      });
  });
  el.appendChild(deleteBtn);
  
  el.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: "FOCUS_OR_MOUNT_TAB",
      windowId: currentWindowId,
      logicalId: tab.logicalId
    });
  });
  
  tabsContainer.appendChild(el);

  if (isActive) {
      setTimeout(() => {
          let target = el;
          if (target.previousElementSibling) {
              target = target.previousElementSibling;
              if (target.previousElementSibling) {
                  target = target.previousElementSibling;
              }
          }
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Start
init();
