
// mock_chrome.js
const listeners = {};
const storage = { local: {} };
const windows = [];
const tabs = [];
const bookmarks = [];

global.chrome = {
    runtime: {
        onInstalled: { addListener: (fn) => listeners['onInstalled'] = fn },
        onStartup: { addListener: (fn) => listeners['onStartup'] = fn },
        onSuspend: { addListener: (fn) => listeners['onSuspend'] = fn },
        onMessage: { addListener: (fn) => listeners['onMessage'] = fn, dispatch: (m, s, r) => listeners['onMessage'] && listeners['onMessage'](m, s, r) },
        sendMessage: async (msg) => { /* console.log('sendMessage', msg); */ }
    },
    windows: {
        onCreated: { addListener: (fn) => listeners['windows.onCreated'] = fn },
        onRemoved: { addListener: (fn) => listeners['windows.onRemoved'] = fn },
        onBoundsChanged: { addListener: (fn) => listeners['windows.onBoundsChanged'] = fn },
        getAll: async () => windows,
        create: async (data) => {
            const win = { id: data.id || Date.now(), ...data };
            windows.push(win);
            if (listeners['windows.onCreated']) listeners['windows.onCreated'](win);
            return win;
        },
        update: async (id, data) => {},
        remove: async (id) => {
            const idx = windows.findIndex(w => w.id === id);
            if (idx !== -1) windows.splice(idx, 1);
        }
    },
    tabs: {
        onCreated: { addListener: (fn) => listeners['tabs.onCreated'] = fn },
        onUpdated: { addListener: (fn) => listeners['tabs.onUpdated'] = fn },
        onRemoved: { addListener: (fn) => listeners['tabs.onRemoved'] = fn },
        onAttached: { addListener: (fn) => listeners['tabs.onAttached'] = fn },
        onDetached: { addListener: (fn) => listeners['tabs.onDetached'] = fn },
        onMoved: { addListener: (fn) => listeners['tabs.onMoved'] = fn },
        onActivated: { addListener: (fn) => listeners['tabs.onActivated'] = fn },
        query: async (queryInfo) => {
             // console.log('Mock Query:', queryInfo, 'Current Tabs:', tabs);
             return tabs.filter(t => {
                 if (queryInfo.windowId && t.windowId !== queryInfo.windowId) return false;
                 if (queryInfo.active !== undefined && t.active !== queryInfo.active) return false;
                 if (queryInfo.index !== undefined && t.index !== queryInfo.index) return false;
                 return true;
             });
        },
        create: async (data) => {
             const tab = { id: Math.floor(Math.random() * 1000), groupId: -1, index: tabs.length, ...data };
             console.log('Mock Tab Created:', tab);
             tabs.push(tab);
             if (listeners['tabs.onCreated']) listeners['tabs.onCreated'](tab);
             return tab;
        },
        get: async (id) => tabs.find(t => t.id === id),
        update: async (tabId, updateProperties) => {
            const tab = tabs.find(t => t.id === tabId);
            if (tab) {
                Object.assign(tab, updateProperties);
                if (updateProperties.active) {
                    // Deactivate others in same window
                    tabs.forEach(t => {
                        if (t.windowId === tab.windowId && t.id !== tabId) {
                            t.active = false;
                        }
                    });
                    if (listeners['tabs.onActivated']) {
                        listeners['tabs.onActivated']({ tabId: tabId, windowId: tab.windowId });
                    }
                }
                if (listeners['tabs.onUpdated']) {
                    listeners['tabs.onUpdated'](tabId, updateProperties, tab);
                }
            }
            return tab;
        },
        remove: async (ids) => {
             const idArr = Array.isArray(ids) ? ids : [ids];
             for (const id of idArr) {
                 const idx = tabs.findIndex(t => t.id === id);
                 if (idx !== -1) tabs.splice(idx, 1);
             }
        },
        move: async (ids, moveInfo) => {
            const idArr = Array.isArray(ids) ? ids : [ids];
            const toMove = tabs.filter(t => idArr.includes(t.id));

            if (moveInfo.windowId !== undefined) {
                toMove.forEach(t => t.windowId = moveInfo.windowId);
                // Trigger onDetached/onAttached?
                // Real Chrome does. Mock should?
                // background.js relies on onAttached for "native drag", but for "programmatic move" via handleMoveLogicalTabs,
                // we explicitly handle logic. But wait, handleMoveLogicalTabs updates state BEFORE move.
                // If onAttached fires, it checks logic.
                // If I don't trigger events, handleMoveLogicalTabs logic runs and is fine.
                // But tests for onAttached (native drag) rely on manual firing.
                // Test for functional drag relies on message handler calling move.
                // So updating windowId is enough for verification.
            }

            // Remove from current positions
            for (const t of toMove) {
                const idx = tabs.indexOf(t);
                if (idx !== -1) tabs.splice(idx, 1);
            }
            // Insert at new position
            // Logic for index -1 (append)
            let insertIdx = moveInfo.index;
            if (insertIdx === -1) insertIdx = tabs.length;
            tabs.splice(insertIdx, 0, ...toMove);
            // Update indices
            tabs.forEach((t, i) => t.index = i);
        },
        group: async (options) => { return 999; }, // Mock group ID
        ungroup: async (ids) => {},
    },
    tabGroups: {
        onCreated: { addListener: (fn) => listeners['tabGroups.onCreated'] = fn, dispatch: (g) => listeners['tabGroups.onCreated'] && listeners['tabGroups.onCreated'](g) },
        onUpdated: { addListener: (fn) => listeners['tabGroups.onUpdated'] = fn, dispatch: (g) => listeners['tabGroups.onUpdated'] && listeners['tabGroups.onUpdated'](g) },
        onRemoved: { addListener: (fn) => listeners['tabGroups.onRemoved'] = fn, dispatch: (g) => listeners['tabGroups.onRemoved'] && listeners['tabGroups.onRemoved'](g) },
        get: async (groupId) => ({ title: "Group", color: "blue", id: groupId }),
        update: async () => {}
    },
    storage: {
        local: {
            get: async (keys) => storage.local,
            set: async (items) => Object.assign(storage.local, items)
        },
        onChanged: { addListener: (fn) => listeners['storage.onChanged'] = fn }
    },
    bookmarks: {
        search: async (query) => bookmarks.filter(b => b.title === query.title),
        create: async (data) => {
            const b = { id: Math.random().toString(), ...data, children: [] };
            bookmarks.push(b);
            if (data.parentId) {
                const parent = findBookmark(data.parentId);
                if (parent && parent.children) {
                    if (data.index !== undefined) {
                        parent.children.splice(data.index, 0, b);
                        b.index = data.index;
                    } else {
                        b.index = parent.children.length;
                        parent.children.push(b);
                    }
                }
            }
            return b;
        },
        update: async (id, data) => {
             const b = findBookmark(id);
             if (b) Object.assign(b, data);
             return b;
        },
        get: async (idOrList) => {
             const id = Array.isArray(idOrList) ? idOrList[0] : idOrList;
             const b = findBookmark(id);
             return b ? [b] : [];
        },
        getChildren: async (id) => {
             const b = findBookmark(id);
             return b ? b.children || [] : [];
        },
        getSubTree: async (id) => {
             const b = findBookmark(id);
             return b ? [b] : [];
        },
        move: async (id, dest) => {
            const node = findBookmark(id);
            if (!node) return undefined;

            // Remove from old parent
            const oldParent = findBookmark(node.parentId);
            if (oldParent && oldParent.children) {
                const oldIndex = oldParent.children.indexOf(node);
                if (oldIndex !== -1) {
                    oldParent.children.splice(oldIndex, 1);
                    // Update indices of remaining siblings
                    oldParent.children.forEach((c, i) => c.index = i);
                }
            }

            // Add to new parent
            if (dest.parentId) {
                const newParent = findBookmark(dest.parentId);
                if (newParent && newParent.children) {
                    node.parentId = dest.parentId;
                    if (dest.index !== undefined) {
                        newParent.children.splice(dest.index, 0, node);
                    } else {
                        // Append
                        newParent.children.push(node);
                    }
                    // Update all indices in new parent
                    newParent.children.forEach((c, i) => c.index = i);
                }
            } else if (dest.index !== undefined && oldParent) {
                 // Move within same parent
                 node.parentId = oldParent.id; // redundant but safe
                 oldParent.children.splice(dest.index, 0, node);
                 oldParent.children.forEach((c, i) => c.index = i);
            }
            return node;
        },
        remove: async (id) => {
             const node = findBookmark(id);
             if (node) {
                 const parent = findBookmark(node.parentId);
                 if (parent && parent.children) {
                     const idx = parent.children.indexOf(node);
                     if (idx !== -1) parent.children.splice(idx, 1);
                 }
                 // Remove from top level if needed
                 const topIdx = bookmarks.indexOf(node);
                 if (topIdx !== -1) bookmarks.splice(topIdx, 1);
             }
        },
        removeTree: async (id) => {
             // Mock removeTree same as remove for simple tree structures in memory
             await global.chrome.bookmarks.remove(id);
        },
        getTree: () => {
             // Return a mock tree structure wrapping our flat bookmarks array
             // Ideally we should build a real tree from parentIds
             // For the test case, we know the structure.
             // Root -> "InfiniTabs Sessions" (first folder usually)
             // We can just construct it.

             // Find root folder
             const rootFolder = bookmarks.find(b => b.parentId === undefined) || { id: '0', title: '', children: [] };
             // Assuming flat list, let's build tree on the fly or just return root if we maintained children
             // In create/move/remove we maintained 'children' array on nodes.
             // So we just need to find the top level nodes.
             // Usually Chrome has root '0', then '1' (Bookmarks Bar), etc.
             // Our mock creates everything with parentId if specified.
             // If parentId is missing, it's a top level node (like the "InfiniTabs Sessions" root we create first).

             // Our code ensures Root Folder.
             const roots = bookmarks.filter(b => !b.parentId);
             // Wrap in a fake root node as getTree returns [rootNode]
             return [{
                 id: 'root',
                 title: '',
                 children: roots
             }];
        }
    },
    sidePanel: {
        setPanelBehavior: async () => {}
    }
};

global.self = {
    crypto: {
        randomUUID: () => Math.random().toString(36).substring(2)
    }
}

// Add importScripts shim
global.importScripts = (path) => {
    // In node environment, we can't easily eval another file in global scope synchronously
    // without reading it. But since we know what utils.js contains (helper functions),
    // and we can't easily require it (ESM vs CommonJS mess), we can just mock the functions
    // it provides if they are global.
    // However, background.js relies on them.
    // For this test, I'll just define them globally here.
};

global.formatGroupTitle = function(title, color) {
    const safeTitle = title || "Group";
    const safeColor = color || "grey";
    return `${safeTitle} [${safeColor}]`;
};

global.parseGroupTitle = function(fullTitle) {
    const match = fullTitle.match(/^(.*?) \[([a-z]+)\]$/);
    if (match) {
        return { name: match[1].trim(), color: match[2].toLowerCase() };
    }
    return { name: fullTitle, color: 'grey' };
};


function findBookmark(id) {
    const stack = [...bookmarks];
    while (stack.length) {
        const node = stack.pop();
        if (node.id === id) return node;
        if (node.children) stack.push(...node.children);
    }
    return null;
}

export { listeners };
