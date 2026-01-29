import fs from 'fs';
import vm from 'vm';

// Helper to run code in a fresh context
function runInSandbox(storageData, extraSetup) {
    const sandbox = {
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        // Mock Chrome API
        chrome: {
            runtime: {
                onInstalled: { addListener: (fn) => sandbox.listeners['onInstalled'] = fn },
                onStartup: { addListener: (fn) => sandbox.listeners['onStartup'] = fn },
                onMessage: { addListener: (fn) => sandbox.listeners['onMessage'] = fn, dispatch: (m, s, r) => sandbox.listeners['onMessage'] && sandbox.listeners['onMessage'](m, s, r) },
                sendMessage: async (msg) => { /* console.log('Msg:', msg); */ },
                getURL: (path) => path
            },
            windows: {
                onCreated: { addListener: (fn) => sandbox.listeners['windows.onCreated'] = fn },
                onRemoved: { addListener: (fn) => sandbox.listeners['windows.onRemoved'] = fn },
                onBoundsChanged: { addListener: (fn) => sandbox.listeners['windows.onBoundsChanged'] = fn },
                getAll: async () => sandbox.windows,
                create: async (data) => {
                    const win = { id: data.id || Math.floor(Math.random()*1000), ...data };
                    sandbox.windows.push(win);
                    return win;
                },
                update: async (id, data) => {}
            },
            tabs: {
                onCreated: { addListener: (fn) => sandbox.listeners['tabs.onCreated'] = fn },
                onUpdated: { addListener: (fn) => sandbox.listeners['tabs.onUpdated'] = fn },
                onRemoved: { addListener: (fn) => sandbox.listeners['tabs.onRemoved'] = fn },
                onMoved: { addListener: (fn) => sandbox.listeners['tabs.onMoved'] = fn },
                onActivated: { addListener: (fn) => sandbox.listeners['tabs.onActivated'] = fn },
                query: async (queryInfo) => {
                     return sandbox.tabs.filter(t => {
                         if (queryInfo.windowId && t.windowId !== queryInfo.windowId) return false;
                         if (queryInfo.active !== undefined && t.active !== queryInfo.active) return false;
                         return true;
                     });
                },
                create: async (data) => {
                     const tab = { id: Math.floor(Math.random() * 10000), ...data };
                     console.log('Sandbox Tab Created:', tab.title || tab.url, 'Active:', tab.active);
                     sandbox.tabs.push(tab);
                     return tab;
                },
                update: async (id, data) => {
                    const tab = sandbox.tabs.find(t => t.id === id);
                    if (tab) {
                        Object.assign(tab, data);
                        if (data.active) {
                            sandbox.tabs.forEach(t => {
                                if(t.windowId === tab.windowId && t.id !== id) t.active = false;
                            });
                        }
                    }
                    return tab;
                },
                remove: async (ids) => {
                    const idArr = Array.isArray(ids) ? ids : [ids];
                    sandbox.tabs = sandbox.tabs.filter(t => !idArr.includes(t.id));
                },
                get: async (id) => sandbox.tabs.find(t => t.id === id),
                group: async () => 888,
            },
            tabGroups: {
                onCreated: { addListener: () => {} },
                onUpdated: { addListener: () => {} },
                onRemoved: { addListener: () => {} },
                get: async () => ({ title: 'G', color: 'blue' }),
                update: async () => {}
            },
            bookmarks: {
                search: async (q) => sandbox.bookmarks.filter(b => b.title === q.title),
                create: async (data) => {
                    const b = { id: 'bm_' + Math.floor(Math.random()*10000), ...data, children: [] };
                    sandbox.bookmarks.push(b);
                    // Handle parent children
                    if (data.parentId) {
                        const p = sandbox.findBookmark(data.parentId);
                        if(p) {
                            if (!p.children) p.children = [];
                            p.children.push(b);
                        }
                    }
                    return b;
                },
                get: async (id) => { const b = sandbox.findBookmark(id); return b ? [b] : [] },
                getChildren: async (id) => { const b = sandbox.findBookmark(id); return b ? b.children || [] : [] },
                getSubTree: async (id) => { const b = sandbox.findBookmark(id); return b ? [b] : [] },
                update: async (id, data) => { const b = sandbox.findBookmark(id); Object.assign(b, data); return b; },
                move: async () => {},
                remove: async () => {}
            },
            storage: {
                local: {
                    get: async (keys) => {
                        // keys is list or object with defaults
                        if (Array.isArray(keys)) {
                            const res = {};
                            keys.forEach(k => res[k] = storageData[k]);
                            return res;
                        } else {
                            // Object with defaults
                            const res = {};
                            for (const k in keys) {
                                res[k] = storageData[k] !== undefined ? storageData[k] : keys[k];
                            }
                            return res;
                        }
                    },
                    set: async (items) => {
                        Object.assign(storageData, items);
                    }
                },
                onChanged: { addListener: () => {} }
            },
            sidePanel: { setPanelBehavior: async () => {} }
        },
        self: { crypto: { randomUUID: () => Math.random().toString(36).substring(2) } },
        importScripts: (path) => {}, // No-op as we bundle logic
        listeners: {},
        windows: [],
        tabs: [],
        bookmarks: [],
        findBookmark: (id) => {
             const stack = [...sandbox.bookmarks];
             while(stack.length) {
                 const node = stack.pop();
                 if (node.id === id) return node;
                 if (node.children) stack.push(...node.children);
             }
             return null;
        }
    };

    // Inject utils logic globally
    sandbox.formatGroupTitle = (t, c) => `${t||"Group"} [${c||"grey"}]`;
    sandbox.parseGroupTitle = (t) => {
        const m = t.match(/^(.*?) \[([a-z]+)\]$/);
        return m ? { name: m[1], color: m[2] } : { name: t, color: 'grey' };
    };

    if (extraSetup) extraSetup(sandbox);

    // Mock WORD_LIST
    sandbox.WORD_LIST = ['apple', 'banana', 'cherry'];

    let scriptContent = fs.readFileSync('src/background.js', 'utf8');
    // Strip imports for VM execution (since we mock them in sandbox)
    scriptContent = scriptContent.replace(/import .* from .*/g, '');

    vm.createContext(sandbox);
    vm.runInContext(scriptContent, sandbox);

    return sandbox;
}

// Test Flow
async function runTest() {
    console.log("--- Starting Restore State Test ---");

    // Shared storage persistence between sessions
    const persistentStorage = {
        restoreMountedTabs: true, // Enable the feature
    };

    // === Session 1: Setup and Persist ===
    console.log("\n--- Phase 1: Setup ---");
    const sandbox1 = runInSandbox(persistentStorage, (sb) => {
        // Pre-populate a window
        sb.windows.push({ id: 1 });
    });

    // Trigger startup
    if (sandbox1.listeners['onStartup']) await sandbox1.listeners['onStartup']();

    // Wait for init
    await new Promise(r => setTimeout(r, 100));

    // Create a new tab (simulating user action)
    // Note: onStartup -> init calls ensureRootFolder, which creates root if missing
    // window creation triggers bindWindowToSession

    const onCreated1 = sandbox1.listeners['tabs.onCreated'];
    const tab1 = { id: 101, windowId: 1, active: true, url: 'http://example.com/1', title: 'Tab 1' };
    console.log("Creating Tab 1...");
    await onCreated1(tab1);

    // Wait for debounce (persistMountedTabs)
    console.log("Waiting for persistence...");
    await new Promise(r => setTimeout(r, 2500));

    console.log("Storage after Phase 1:", JSON.stringify(persistentStorage.sessionMountedTabs, null, 2));

    if (!persistentStorage.sessionMountedTabs) {
        console.error("FAIL: sessionMountedTabs not persisted");
        process.exit(1);
    }

    // === Session 2: Restore ===
    console.log("\n--- Phase 2: Restore ---");
    const sandbox2 = runInSandbox(persistentStorage, (sb) => {
        sb.windows.push({ id: 2 }); // New Window ID on restart
    });

    // Get session ID from Phase 1
    const sessionId = Object.keys(persistentStorage.sessionMountedTabs)[0];
    if (!sessionId) {
        console.error("FAIL: No session found");
        process.exit(1);
    }

    console.log("Restoring Session ID:", sessionId);

    // Copy bookmarks to simulate persistence
    sandbox2.bookmarks = JSON.parse(JSON.stringify(sandbox1.bookmarks));

    // Initialize Phase 2
    if (sandbox2.listeners['onInstalled']) await sandbox2.listeners['onInstalled']();

    // Manually bind for testing restoration logic
    console.log("Switching Window 2 to Session...");
    // We can use onMessage to trigger SWITCH_SESSION
    // We need to wrap it because dispatch in mock might be different
    const onMessage2 = sandbox2.listeners['onMessage'];

    await new Promise(r => {
        onMessage2({ type: "SWITCH_SESSION", windowId: 2, sessionId: sessionId }, {}, (res) => {
            r(res);
        });
    });

    // Verification
    console.log("Verifying restored tabs...");

    const restoredTabs = sandbox2.tabs;
    console.log("Restored Tabs:", restoredTabs);

    const targetUrl = 'http://example.com/1';
    const found = restoredTabs.find(t => t.url === targetUrl);

    if (found) {
        console.log("SUCCESS: Tab restored.");
        if (found.active) {
            console.log("SUCCESS: Tab is active.");
        } else {
             // Wait for activation
             await new Promise(r => setTimeout(r, 600));
             const updatedTab = await sandbox2.tabs.find(t => t.id === found.id);
             if (updatedTab && updatedTab.active) {
                 console.log("SUCCESS: Tab activated after delay.");
             } else {
                 console.error("FAIL: Tab not activated.");
                 process.exit(1);
             }
        }
    } else {
        console.error("FAIL: Tab not restored.");
        process.exit(1);
    }

    console.log("\n--- Test Passed ---");
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
