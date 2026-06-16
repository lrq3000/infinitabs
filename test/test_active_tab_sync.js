
import { listeners } from './mock_chrome.js';
// We don't import background.js yet, we prepare environment first.

const windowId = 1;

// 1. Setup Mock State

// Setup Bookmarks
const root = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
const session = await chrome.bookmarks.create({
    parentId: root.id,
    title: "Session - Window 1 [windowId:1]"
});

// Create a bookmark for the tab
const bookmarkTab = await chrome.bookmarks.create({
    parentId: session.id,
    title: "Active Tab",
    url: "https://example.com/active"
});

// Setup Live Tabs
// We create the live tab BEFORE background init, so it exists when background queries it.
await chrome.tabs.create({
    id: 101,
    windowId: windowId,
    active: true, // This is the key
    url: "https://example.com/active",
    title: "Active Tab"
});

// Also create the window object so background can find it
await chrome.windows.create({ id: windowId, type: 'normal' });

console.log("Environment prepared. Importing background.js...");

// 2. Load Background
await import('../src/background.js');

// 3. Trigger Init
const onInstalled = listeners['onInstalled'];
if (onInstalled) {
    console.log("Triggering onInstalled...");
    await onInstalled();
} else {
    console.error("onInstalled listener not found!");
    process.exit(1);
}

// 4. Verify State
// Wait a bit for async operations in background
await new Promise(r => setTimeout(r, 200));

const onMessage = listeners['onMessage'];
const sendMessage = (msg) => {
    return new Promise(resolve => {
        onMessage(msg, {}, resolve);
    });
};

const response = await sendMessage({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId });
const sessionState = response.session;

if (!sessionState) {
    console.error("FAIL: Session state is null");
    process.exit(1);
}

console.log("Session loaded:", sessionState.sessionId);
console.log("lastActiveLogicalTabId:", sessionState.lastActiveLogicalTabId);

// Find the logical tab for our bookmark
const logicalTab = sessionState.logicalTabs.find(l => l.bookmarkId === bookmarkTab.id);

if (!logicalTab) {
    console.error("FAIL: Logical tab not found");
    process.exit(1);
}

console.log("Expected Active ID:", logicalTab.logicalId);

if (sessionState.lastActiveLogicalTabId === logicalTab.logicalId) {
    console.log("SUCCESS: Active tab correctly identified on startup.");
} else {
    console.error("FAIL: Active tab mismatch. Expected", logicalTab.logicalId, "got", sessionState.lastActiveLogicalTabId);
    process.exit(1);
}
