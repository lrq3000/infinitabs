
import { listeners } from './mock_chrome.js';
import '../src/background.js';

// Wait for initialization
await new Promise(r => setTimeout(r, 100));

// Setup environment
const windowId = 1;
await chrome.windows.create({ id: windowId, type: 'normal' });

// Create Session
const rootId = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
const sessionFolder = await chrome.bookmarks.create({
    parentId: rootId.id,
    title: "Session - Window 1 [windowId:1]"
});

// Create Group Folder
const groupFolder = await chrome.bookmarks.create({
    parentId: sessionFolder.id,
    title: "My Group [blue]"
});
const groupId = groupFolder.id;

// Create Logical Tab in Group
const tabBookmark = await chrome.bookmarks.create({
    parentId: groupId,
    title: "Tab In Group",
    url: "https://example.com"
});

console.log('Setup: Session', sessionFolder.id, 'Group', groupId, 'Tab', tabBookmark.id);

// Initialize background
const onStartup = listeners['onStartup'];
if (onStartup) await onStartup();

// Wait for sync
await new Promise(r => setTimeout(r, 200));

// Verify initial state
let response = await new Promise(r => listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, r));
let session = response.session;
let logicalTab = session.logicalTabs.find(l => l.bookmarkId === tabBookmark.id);

if (!logicalTab) {
    console.error('Setup Fail: Logical tab not found');
    process.exit(1);
}
if (logicalTab.groupId !== groupId) {
    console.error(`Setup Fail: Logical tab not in group. Expected ${groupId}, got ${logicalTab.groupId}`);
    process.exit(1);
}

// Simulate Live Tab attached
const liveTabId = 200;
const liveGroupId = 999;

const liveTab = {
    id: liveTabId,
    windowId: windowId,
    active: true,
    index: 0,
    url: "https://example.com",
    title: "Tab In Group",
    groupId: liveGroupId
};

// Override just the get method, preserving other tabGroups functionality
const originalTabGroups = chrome.tabGroups;
chrome.tabGroups = {
    ...originalTabGroups,
    get: async (gid) => ({ id: gid, title: "My Group", color: "blue", windowId: windowId })
};

// Create tab in mock (so queries work)
await chrome.tabs.create(liveTab);

// Fire onCreated listener (so background logic runs)
// Note: onCreated logic in background uses `state.liveGroupToBookmark` or matches by URL.
// We hope it matches by URL because we set the URL to match the bookmark.
await listeners['tabs.onCreated'](liveTab);

// Wait for processing
await new Promise(r => setTimeout(r, 100));

// Force map if not mapped (in case onCreated logic failed to match)
response = await new Promise(r => listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, r));
session = response.session;
logicalTab = session.logicalTabs.find(l => l.bookmarkId === tabBookmark.id);

if (!logicalTab.liveTabIds.includes(liveTabId)) {
    console.log("Tab not attached automatically. Attempting explicit mount/focus...");
    // If not attached, maybe URL mismatch or something?
    // Let's try to simulate what happens when we "Mount" the tab.
    // Actually, simply attaching it manually via our 'knowledge' of internal state is hard.
    // But we can force it via FOCUS_OR_MOUNT.
    // However, since the tab exists in mock now, FOCUS_OR_MOUNT will try to activate it?
    // No, FOCUS_OR_MOUNT checks logical.liveTabIds. If empty, it creates NEW tab.

    // So if it's empty, we create NEW tab.
    await new Promise(r => listeners['onMessage']({
        type: "FOCUS_OR_MOUNT_TAB",
        windowId: windowId,
        logicalId: logicalTab.logicalId
    }, {}, r));

    await new Promise(r => setTimeout(r, 100));
}

// Re-check mapping
response = await new Promise(r => listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, r));
session = response.session;
logicalTab = session.logicalTabs.find(l => l.bookmarkId === tabBookmark.id);

if (!logicalTab.liveTabIds.length) {
    console.error("Failed to map tab to logical tab.");
    process.exit(1);
}

const mountedTabId = logicalTab.liveTabIds[0];
console.log(`Mounted Tab ID: ${mountedTabId}`);

// ISSUE REPRODUCTION SIMULATION:

console.log('Simulating Issue: Tab Close Race Condition');

// 1. Chrome fires onUpdated with groupId = -1 (Ungrouped)
console.log('Event: tabs.onUpdated (groupId: -1)');
const mountedTab = await chrome.tabs.get(mountedTabId);
await listeners['tabs.onUpdated'](mountedTabId, { groupId: -1 }, { ...mountedTab, groupId: -1 });

// 2. Chrome fires onRemoved quickly after onUpdated (simulating real behavior)
// This should happen BEFORE the 100ms timeout in background.js completes
await new Promise(r => setTimeout(r, 20)); // Small delay to simulate "immediately before"
console.log('Event: tabs.onRemoved');
await listeners['tabs.onRemoved'](mountedTabId, { windowId: windowId, isWindowClosing: false });

// Wait for the 100ms timeout in background.js to complete
await new Promise(r => setTimeout(r, 150));

// Final Check
const finalCheck = await chrome.bookmarks.get(tabBookmark.id);
console.log(`Final Parent: ${finalCheck[0].parentId} (Expected: ${groupId})`);

if (finalCheck[0].parentId !== groupId) {
    console.error("Test Failed: Bookmark was moved out of group.");
    process.exit(1);
} else {
    console.log("Test Passed: Bookmark preserved.");
    process.exit(0);
}
