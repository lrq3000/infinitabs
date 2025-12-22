
// Basic mock of chrome API
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
        onMessage: { addListener: (fn) => listeners['onMessage'] = fn },
        sendMessage: async (msg) => { console.log('sendMessage', msg); }
    },
    windows: {
        onCreated: { addListener: (fn) => listeners['windows.onCreated'] = fn },
        onRemoved: { addListener: (fn) => listeners['windows.onRemoved'] = fn },
        onBoundsChanged: { addListener: (fn) => listeners['windows.onBoundsChanged'] = fn },
        getAll: async () => windows,
        create: async (data) => {
            const win = { id: data.id || Date.now(), ...data };
            windows.push(win);
            // Trigger onCreated? In real browser yes.
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
             // simplified query logic
             return tabs.filter(t => {
                 if (queryInfo.windowId && t.windowId !== queryInfo.windowId) return false;
                 if (queryInfo.active !== undefined && t.active !== queryInfo.active) return false;
                 return true;
             });
        },
        create: async (data) => {
             const tab = { id: Math.floor(Math.random() * 1000), ...data };
             tabs.push(tab);
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
        move: async (ids, moveInfo) => {}
    },
    storage: {
        local: {
            get: async (keys) => storage.local,
            set: async (items) => Object.assign(storage.local, items)
        }
    },
    bookmarks: {
        search: async (query) => bookmarks.filter(b => b.title === query.title),
        create: async (data) => {
            const b = { id: Math.random().toString(), ...data, children: [] };
            bookmarks.push(b);
            // Also need to put it in parent if parentId is set
            if (data.parentId) {
                const parent = findBookmark(data.parentId);
                if (parent && parent.children) parent.children.push(b);
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
             // Implement move if needed for tests
        },
        remove: async (id) => {}
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

function findBookmark(id) {
    // DFS search
    const stack = [...bookmarks];
    while (stack.length) {
        const node = stack.pop();
        if (node.id === id) return node;
        if (node.children) stack.push(...node.children);
    }
    return null;
}

export { listeners };
