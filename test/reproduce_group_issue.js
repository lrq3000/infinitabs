
import { listeners } from './mock_chrome.js';

// Wait for initialization
// await new Promise(r => setTimeout(r, 100));

// Setup environment
const windowId = 1;
const sessionId = "session_1";

// Mock existing session bookmark
const rootId = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
const sessionFolder = await chrome.bookmarks.create({
    id: sessionId,
    parentId: rootId.id,
    title: "Session - Window 1 [windowId:1]"
});

// Create a Group Folder
const groupFolder = await chrome.bookmarks.create({
    parentId: sessionId,
    title: "My Group [red]"
});

// Create a tab inside the group
const tabInGroupBookmark = await chrome.bookmarks.create({
    parentId: groupFolder.id,
    title: "Tab In Group",
    url: "http://example.com/1"
});

// Create a corresponding live tab for the group tab
const tabInGroup = {
    id: 100,
    windowId: windowId,
    active: false,
    index: 0,
    url: "http://example.com/1",
    groupId: 555 // Native Group ID
};
await chrome.tabs.create(tabInGroup);

// Import background AFTER mock setup
await import('../src/background.js');

// Initialize background
const onStartup = listeners['onStartup'];
if (onStartup) await onStartup();

console.log('Background initialized');

// Populate state (simulate window binding)
// We need to make sure the background script knows about the existing tabs
// This usually happens during init -> bindWindowToSession -> syncExistingTabsInWindowToSession
// Since we manually created bookmarks and tabs, we can trigger a session reload or re-bind.
// But 'init' is already called.
// Let's force a "window created" event or similar if needed, but onStartup handles init.

// We need to make sure `state.windowToSession` is populated.
// Since we didn't put it in storage, `init` might have auto-bound it by matching window ID in title.
// Let's verify.

const onMessage = listeners['onMessage'];
const sendMessage = (msg) => {
    return new Promise(resolve => {
        onMessage(msg, {}, resolve);
    });
};

// Wait a bit for async init
await new Promise(r => setTimeout(r, 500));

let response = await sendMessage({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId });
if (!response.session) {
    console.log("Session not bound yet, creating window event...");
    // Simulate window creation
    const onWindowCreated = listeners['windows.onCreated'];
    await onWindowCreated({ id: windowId });
    await new Promise(r => setTimeout(r, 500));
    response = await sendMessage({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId });
}

console.log('Session Loaded:', response.session ? 'Yes' : 'No');

// Verify 'Tab In Group' is correctly mapped
const session = response.session;
const logicalInGroup = session.logicalTabs.find(l => l.url === tabInGroup.url);
// console.log("Logical in Group:", logicalInGroup);

// Now simulate creating a NEW tab (Ctrl+T)
// It will be at index 1 (after tabInGroup)
// It is NOT in a group (groupId: -1)

const newTabId = 101;
const newTab = {
    id: newTabId,
    windowId: windowId,
    active: true,
    index: 1, // After the grouped tab
    url: "about:blank",
    title: "New Tab",
    groupId: -1 // Not in a group
};

// Mock chrome.tabs.query to return the previous tab when queried
// background.js does: const tabs = await chrome.tabs.query({ windowId, index: tab.index - 1 });
// We need to ensure query works. The mock_chrome.js simplified query should handle windowId.
// But it doesn't handle 'index'.

// Let's patch chrome.tabs.query in mock if needed, or just rely on 'tabs' array being correct.
// The mock 'query' filters by windowId and active. It ignores index.
// background.js: `chrome.tabs.query({ windowId, index: tab.index - 1 })`
// We need to improve mock query to handle index.

const originalQuery = chrome.tabs.query;
chrome.tabs.query = async (queryInfo) => {
    const result = await originalQuery(queryInfo);
    if (queryInfo.index !== undefined) {
        return result.filter(t => t.index === queryInfo.index);
    }
    return result;
};

// Add new tab to mock tabs list
await chrome.tabs.create(newTab);

// Trigger onCreated
console.log('Simulating New Tab Creation...');
const onCreated = listeners['tabs.onCreated'];
await onCreated(newTab);

// Check where the bookmark was created
const bBookmark = await chrome.bookmarks.get(session.logicalTabs.find(l => l.liveTabIds.includes(newTabId))?.bookmarkId);
const bookmark = bBookmark[0];

if (!bookmark) {
    console.error("FAIL: Bookmark not created for new tab");
} else {
    console.log("New Bookmark Parent ID:", bookmark.parentId);
    console.log("Group Folder ID:", groupFolder.id);
    console.log("Session ID:", sessionId);

    if (bookmark.parentId === groupFolder.id) {
        console.error("FAIL: Bookmark was created inside the group folder!");
    } else if (bookmark.parentId === sessionId) {
        console.log("SUCCESS: Bookmark was created in session root.");
    } else {
        console.log("UNKNOWN: Bookmark created in " + bookmark.parentId);
    }
}

process.exit(0);
