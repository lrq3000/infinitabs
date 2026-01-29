
import { listeners } from './mock_chrome.js';
import '../src/background.js';

// Wait for initialization
await new Promise(r => setTimeout(r, 100));

// Setup environment
const windowId = 1;

// Create window in mock
await chrome.windows.create({ id: windowId, type: 'normal' });

// Mock existing session bookmark
const rootId = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
const sessionFolder = await chrome.bookmarks.create({
    parentId: rootId.id,
    title: "Session - Window 1 [windowId:1]"
});

console.log('Created Session Bookmark:', sessionFolder.id);

// Mock state initialization
const onStartup = listeners['onStartup'];
if (onStartup) await onStartup();

console.log('Background initialized');

// Create 3 tabs
// Ensure groupId is -1 (ungrouped)
const tab1 = await chrome.tabs.create({ id: 101, windowId: windowId, index: 0, url: "http://tab1.com", title: "Tab 1", groupId: -1 });
const tab2 = await chrome.tabs.create({ id: 102, windowId: windowId, index: 1, url: "http://tab2.com", title: "Tab 2", groupId: -1 });
const tab3 = await chrome.tabs.create({ id: 103, windowId: windowId, index: 2, url: "http://tab3.com", title: "Tab 3", groupId: -1 });

// Note: background.js listener is triggered by chrome.tabs.create in mock.

// Wait a bit for async operations in background to finish
await new Promise(r => setTimeout(r, 100));

// Check bookmark order
let children = await chrome.bookmarks.getChildren(sessionFolder.id);
console.log('Initial Bookmarks:', children.map(c => c.title));

if (children.length !== 3) {
    console.error(`Setup failed: expected 3 bookmarks, got ${children.length}`);
    process.exit(1);
}

// Update Tab 2 in mock to be in a group
const groupId = 999;
const t2 = await chrome.tabs.get(102);
t2.groupId = groupId;

// Simulate Group Creation
const onGroupCreated = listeners['tabGroups.onCreated'];
if (onGroupCreated) {
    console.log('Simulating Group Creation...');
    await onGroupCreated({ id: groupId, windowId: windowId, title: "New Group", color: "blue" });
}

// Wait a bit
await new Promise(r => setTimeout(r, 100));

// Check bookmark order
children = await chrome.bookmarks.getChildren(sessionFolder.id);
// Note: The mock does not update .index of siblings on splice, so we use array index.
console.log('Bookmarks after grouping:', children.map((c, i) => `${c.title} (Actual Index: ${i})`));

const groupFolder = children.find(c => c.title.includes("Group"));
if (!groupFolder) {
    console.error("FAIL: Group folder not found");
    process.exit(1);
} else {
    const actualIndex = children.indexOf(groupFolder);
    console.log(`Group Folder Actual Index: ${actualIndex}`);

    // We expect it to be at index 1 (after Tab 1).
    if (actualIndex === 3) {
        console.log("FAIL: Group folder placed at end (Issue Reproduced).");
        process.exit(1);
    } else if (actualIndex === 1) {
        console.log("SUCCESS: Group folder placed correctly at index 1.");
        process.exit(0);
    } else {
        console.log(`FAIL: Observed index: ${actualIndex}`);
        process.exit(1);
    }
}
