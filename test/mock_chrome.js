
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
             const tab = { id: Math.floor(Math.random() * 1000), ...data };
             console.log('Mock Tab Created:', tab);
             tabs.push(tab);
             if (listeners['tabs.onCreated']) listeners['tabs.onCreated'](tab);
             return tab;
        },
        get: async (id) => tabs.find(t => t.id === id),
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
            // Remove from current positions
            for (const t of toMove) {
                const idx = tabs.indexOf(t);
                if (idx !== -1) tabs.splice(idx, 1);
            }
            // Insert at new position
            tabs.splice(moveInfo.index, 0, ...toMove);
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
        session: {
            get: async (keys) => {
                 // Simple mock: keys string or array or object
                 // Return the session object
                 if (typeof keys === 'string') {
                     return { [keys]: storage.session[keys] };
                 }
                 return storage.session || {};
            },
            set: async (items) => {
                 if (!storage.session) storage.session = {};
                 Object.assign(storage.session, items);
            }
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
global.importScripts = (...paths) => {
    // We need to load storage.js to verify background.js
    // paths can be multiple arguments
    const fs = require('fs');
    const path = require('path');

    for (const p of paths) {
        if (p === 'utils.js') continue; // Handled by global mocks below
        if (p === 'storage.js') {
            const code = fs.readFileSync(path.join(process.cwd(), 'src', 'storage.js'), 'utf8');
            // Since const/class are block scoped, direct eval might not expose them to global if not var.
            // We can wrap it or just rely on manual assignment.
            // Let's replace 'const storage =' with 'global.storage =' in the code string for the test.
            const modifiedCode = code.replace('const storage = new StorageManager();', 'global.storage = new StorageManager();');
            eval(modifiedCode);
        }
    }
};

// Polyfill require for importScripts logic above if needed (since we are in ESM module test)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

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
