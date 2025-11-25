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
let lastScrolledActiveId = null;

// Selection & Drag State
let selectedLogicalIds = new Set();
let lastSelectedLogicalId = null; // For shift-click range
let draggedLogicalIds = [];
let ignoreNextAutoScroll = false;

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

// Helper for deep comparison simplified for our session objects
function haveTabsChanged(s1, s2) {
    if (!s1 || !s2) return true;
    if (s1.sessionId !== s2.sessionId) return true;
    if (s1.lastActiveLogicalTabId !== s2.lastActiveLogicalTabId) return true;
    
    if (s1.logicalTabs.length !== s2.logicalTabs.length) return true;
    
    // Check tabs
    for (let i = 0; i < s1.logicalTabs.length; i++) {
        const t1 = s1.logicalTabs[i];
        const t2 = s2.logicalTabs[i];
        if (t1.logicalId !== t2.logicalId) return true;
        if (t1.title !== t2.title) return true;
        if (t1.url !== t2.url) return true;
        if (t1.liveTabIds.length !== t2.liveTabIds.length) return true;
        if (t1.groupId !== t2.groupId) return true;
    }
    
    // Check groups
    const g1Keys = Object.keys(s1.groups);
    const g2Keys = Object.keys(s2.groups);
    if (g1Keys.length !== g2Keys.length) return true;
    
    for (const k of g1Keys) {
        const g1 = s1.groups[k];
        const g2 = s2.groups[k];
        if (!g2) return true;
        if (g1.title !== g2.title) return true;
    }
    
    return false;
}

function onMessage(message, sender, sendResponse) {
  if (message.type === "STATE_UPDATED") {
    if (message.windowId === currentWindowId) {
      const newSession = message.session;
      
      // Check if update is necessary
      if (!haveTabsChanged(currentSession, newSession)) {
          currentSession = newSession; // Update reference but don't render
          return;
      }

      currentSession = newSession;
      
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
  if (!session.logicalTabs || session.logicalTabs.length === 0) {
    tabsContainer.innerHTML = '<div style="padding:10px; color:#888;">Empty Session</div>';
    return;
  }

  // Determine if we need to scroll
  let shouldScroll = false;

  if (ignoreNextAutoScroll) {
      // Suppress autoscroll for user-initiated move
      ignoreNextAutoScroll = false;
      // Update lastScrolledActiveId so subsequent updates don't trigger scroll
      lastScrolledActiveId = session.lastActiveLogicalTabId;
  } else if (session.lastActiveLogicalTabId !== lastScrolledActiveId) {
      shouldScroll = true;
      lastScrolledActiveId = session.lastActiveLogicalTabId;
  }

  const itemsToRender = [];
  
  session.logicalTabs.forEach(tab => {
    itemsToRender.push({ type: 'tab', id: tab.logicalId, data: tab, index: tab.indexInSession });
  });
  
  Object.values(session.groups).forEach(group => {
    itemsToRender.push({ type: 'group', id: group.groupId, data: group, index: group.indexInSession });
  });
  
  itemsToRender.sort((a, b) => a.index - b.index);
  
  // Diff and patch DOM
  const currentChildren = Array.from(tabsContainer.children);
  
  // If length mismatch or major structural change, simpler to clear if the list size changed significantly?
  // For robustness, let's iterate and match.
  
  // Remove excess children
  while (currentChildren.length > itemsToRender.length) {
      tabsContainer.removeChild(tabsContainer.lastChild);
      currentChildren.pop();
  }
  
  itemsToRender.forEach((item, i) => {
      let el = currentChildren[i];
      
      // Check if element exists and matches type/ID
      if (el && el.dataset.id === item.id && el.dataset.type === item.type) {
          // Update existing
          if (item.type === 'group') {
              updateGroupElement(el, item.data);
          } else {
              updateTabElement(el, item.data, session, shouldScroll);
          }
      } else {
          // Create new
          let newEl;
          if (item.type === 'group') {
              newEl = createGroupElement(item.data);
          } else {
              newEl = createTabElement(item.data, session, shouldScroll);
          }
          
          if (el) {
              tabsContainer.replaceChild(newEl, el);
              currentChildren[i] = newEl; // Update reference if needed
          } else {
              tabsContainer.appendChild(newEl);
          }
      }
  });
}

function createGroupElement(group) {
    const el = document.createElement('div');
    el.className = 'group-header';
    el.dataset.id = group.groupId;
    el.dataset.type = 'group';
    el.draggable = true;
    setupDragHandlers(el);
    updateGroupElement(el, group);
    return el;
}

function updateGroupElement(el, group) {
    if (el.textContent !== group.title) {
        el.textContent = group.title;
    }
}

function createTabElement(tab, session, shouldScroll) {
    const el = document.createElement('div');
    el.dataset.id = tab.logicalId;
    el.dataset.type = 'tab';
    el.draggable = true;
    setupDragHandlers(el);
    
    // Structure
    // <span class="live-indicator"></span>
    // <img class="tab-icon" src="...">
    // <span class="tab-title">...</span>
    // <button class="tab-delete-btn">x</button>
    
    const indicatorWrapper = document.createElement('div');
    indicatorWrapper.className = 'live-indicator-wrapper';
    indicatorWrapper.title = 'Close live tab (keep bookmark)';
    indicatorWrapper.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tab.liveTabIds.length > 0) {
            chrome.runtime.sendMessage({
                type: "UNMOUNT_LOGICAL_TAB",
                windowId: currentWindowId,
                logicalId: tab.logicalId
            });
        }
    });

    const indicator = document.createElement('span');
    indicator.className = 'live-indicator';
    indicatorWrapper.appendChild(indicator);
    el.appendChild(indicatorWrapper);
    
    const icon = document.createElement('img');
    icon.className = 'tab-icon';
    el.appendChild(icon);
    
    const title = document.createElement('span');
    title.className = 'tab-title';
    el.appendChild(title);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tab-delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete logical tab and bookmark';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); 
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
    
    el.addEventListener('click', (e) => {
        handleTabClick(e, tab.logicalId);
    });
    
    updateTabElement(el, tab, session, shouldScroll);
    return el;
}

function updateTabElement(el, tab, session, shouldScroll) {
    const isLive = tab.liveTabIds.length > 0;
    const isActive = session.lastActiveLogicalTabId === tab.logicalId;
    const isSelected = selectedLogicalIds.has(tab.logicalId);

    // Classes
    let className = 'tab-item';
    if (tab.groupId) className += ' indented';
    if (isLive) className += ' live';
    if (isActive) className += ' active-live';
    else className += ' logical';
    
    if (isSelected) className += ' selected';

    // Preserve search match if present (handled by performSearch, but we might be overwriting classes)
    // Ideally search should re-run or we preserve the class.
    // Since performSearch runs after render if input exists, it will fix it.
    
    if (el.className !== className) {
        // We might lose 'search-match' here.
        // Let's verify if we need to re-add search classes.
        // Actually `renderSession` is called on update. 
        // If we overwrite className, we lose search highlights until `performSearch` runs again.
        // `onMessage` calls `renderSession` then `performSearch`. So it's fine.
        el.className = className;
    }
    
    // Tooltip
    if (el.title !== tab.url) el.title = tab.url;
    
    // Content
    const icon = el.querySelector('.tab-icon');
    const title = el.querySelector('.tab-title');
    
    const faviconUrl = chrome.runtime.getURL("/_favicon/") + "?pageUrl=" + encodeURIComponent(tab.url) + "&size=16";
    if (icon.src !== faviconUrl) icon.src = faviconUrl;
    
    if (title.textContent !== tab.title) title.textContent = tab.title;
    
    // Scroll
    if (isActive && shouldScroll) {
      window.requestAnimationFrame(() => {
          // Check if element is still connected before scrolling
          if (!el.isConnected) return;
          
          let target = el;
          if (target.previousElementSibling) {
              target = target.previousElementSibling;
              if (target.previousElementSibling) {
                  target = target.previousElementSibling;
              }
          }
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
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

// --- Selection & Drag Logic ---

function handleTabClick(e, logicalId) {
    if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        if (selectedLogicalIds.has(logicalId)) {
            selectedLogicalIds.delete(logicalId);
        } else {
            selectedLogicalIds.add(logicalId);
            lastSelectedLogicalId = logicalId;
        }
    } else if (e.shiftKey && lastSelectedLogicalId) {
        // Range selection
        // Find range in current rendering order
        const allItems = Array.from(document.querySelectorAll('.tab-item'));
        const ids = allItems.map(el => el.dataset.id);

        const idx1 = ids.indexOf(lastSelectedLogicalId);
        const idx2 = ids.indexOf(logicalId);

        if (idx1 !== -1 && idx2 !== -1) {
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);

            // If ctrl not held, clear previous unless we want additive range?
            // Standard is Shift+Click extends selection.
            // But usually Shift+Click clears others outside range if Ctrl not held.
            // Let's implement standard explorer behavior:
            // Click = Select one.
            // Ctrl+Click = Toggle one.
            // Shift+Click = Select range from anchor (lastSelected) to current.

            selectedLogicalIds.clear(); // Standard behavior

            for (let i = start; i <= end; i++) {
                selectedLogicalIds.add(ids[i]);
            }
        }
    } else {
        // Single selection + Action
        // If simply clicking, we usually want to activate the tab.
        // But also select it.
        selectedLogicalIds.clear();
        selectedLogicalIds.add(logicalId);
        lastSelectedLogicalId = logicalId;

        chrome.runtime.sendMessage({
          type: "FOCUS_OR_MOUNT_TAB",
          windowId: currentWindowId,
          logicalId: logicalId
        });
    }

    // Refresh UI selection state
    if (currentSession) renderSession(currentSession);
}

function setupDragHandlers(el) {
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragend', onDragEnd);
}

function onDragStart(e) {
    const id = e.target.dataset.id;
    if (!id) return;

    // If dragging a selected item, drag all selected.
    // If dragging an unselected item, select it first (and clear others).
    if (!selectedLogicalIds.has(id)) {
        selectedLogicalIds.clear();
        selectedLogicalIds.add(id);
        lastSelectedLogicalId = id;
        if (currentSession) renderSession(currentSession);
    }

    draggedLogicalIds = Array.from(selectedLogicalIds);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(draggedLogicalIds));

    // Visual feedback
    e.target.classList.add('dragging');
}

function onDragOver(e) {
    e.preventDefault(); // Allow drop
    e.dataTransfer.dropEffect = 'move';

    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;

    target.classList.remove('drop-before', 'drop-after', 'drop-inside');

    // If target is a group, we might drop inside
    if (target.dataset.type === 'group') {
        // Top 25% -> before, Bottom 25% -> after, Middle 50% -> inside
        const h = rect.height;
        if (offsetY < h * 0.25) {
             target.classList.add('drop-before');
        } else if (offsetY > h * 0.75) {
             target.classList.add('drop-after');
        } else {
             target.classList.add('drop-inside');
        }
    } else {
        // Tabs: Before (top 50%) or After (bottom 50%)
        if (offsetY < rect.height / 2) {
             target.classList.add('drop-before');
        } else {
             target.classList.add('drop-after');
        }
    }
}

function onDragLeave(e) {
    e.currentTarget.classList.remove('drop-before', 'drop-after', 'drop-inside');
}

function onDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drop-before', 'drop-after', 'drop-inside');

    const targetId = target.dataset.id;
    if (!targetId) return;

    let position = null;
    const rect = target.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;

    if (target.dataset.type === 'group') {
        const h = rect.height;
        if (offsetY < h * 0.25) position = 'before';
        else if (offsetY > h * 0.75) position = 'after';
        else position = 'inside';
    } else {
        if (offsetY < rect.height / 2) position = 'before';
        else position = 'after';
    }

    if (draggedLogicalIds.length === 0) return;

    // Avoid dropping onto self
    if (draggedLogicalIds.includes(targetId) && position !== 'inside') return;

    // Suppress next auto-scroll since this is a user action
    ignoreNextAutoScroll = true;

    chrome.runtime.sendMessage({
        type: "MOVE_LOGICAL_TABS",
        windowId: currentWindowId,
        logicalIds: draggedLogicalIds,
        targetLogicalId: targetId,
        position: position
    });
}

function onDragEnd(e) {
    e.target.classList.remove('dragging');
    draggedLogicalIds = [];
}

// Start
init();
