
import { listeners } from './mock_chrome.js';

// Utils shim
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

// Start background
await import('../src/background.js');

// Wait for init
await new Promise(r => setTimeout(r, 100));

// Setup: Create a window and a session
const window = await chrome.windows.create({ id: 100 });
// Trigger onCreated to bind session
listeners['windows.onCreated'](window);
await new Promise(r => setTimeout(r, 100)); // Wait for async bind

// Verify session created
const root = (await chrome.bookmarks.getTree())[0];
const sessionFolder = root.children[0].children.find(c => c.title.includes("Window 100"));
const sessionId = sessionFolder.id;

console.log(`Session created: ${sessionId}`);

// Create 3 tabs: A, B (to move), and C (anchor/bystander)
const tabA = await chrome.tabs.create({ windowId: 100, url: "http://a.com", title: "A", index: 0, active: false });
const tabB = await chrome.tabs.create({ windowId: 100, url: "http://b.com", title: "B", index: 1, active: false });
const tabC = await chrome.tabs.create({ windowId: 100, url: "http://c.com", title: "C", index: 2, active: true });

// Notify background of creation (simulating event flow)
listeners['tabs.onCreated'](tabA);
listeners['tabs.onCreated'](tabB);
listeners['tabs.onCreated'](tabC);
await new Promise(r => setTimeout(r, 200)); // Allow sync

// Create a Logical Group in the session (Bookmark Folder)
const groupFolder = await chrome.bookmarks.create({ parentId: sessionId, title: "TestGroup [blue]" });
const groupId = groupFolder.id;

// Create Tab G1 (inside group)
const tabG1 = await chrome.tabs.create({ windowId: 100, url: "http://g1.com", title: "G1", index: 3 });
listeners['tabs.onCreated'](tabG1);
await new Promise(r => setTimeout(r, 100));

// Create Group for G1
const liveGroupId = await chrome.tabs.group({ tabIds: [tabG1.id] });
// Update mock group metadata so background can read it
listeners['tabGroups.onCreated']({ id: liveGroupId, windowId: 100, title: "Group", color: "blue" });
await new Promise(r => setTimeout(r, 200)); // Allow sync and bookmark creation

// Now we should have a group bookmark.
// Let's find the group bookmark ID from the session.
// We need to ask background for the session state.
let response = await new Promise(resolve => {
    listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: 100 }, {}, resolve);
});
let session = response.session;
const logicalGroup = Object.values(session.groups)[0]; // Should be one group
console.log('Logical Group:', logicalGroup);

// Get logical IDs for A and B
const logicalA = session.logicalTabs.find(t => t.url === "http://a.com");
const logicalB = session.logicalTabs.find(t => t.url === "http://b.com");

console.log('Logical A:', logicalA.logicalId);
console.log('Logical B:', logicalB.logicalId);

// Track calls to chrome.tabs.group
const groupCalls = [];
const originalGroup = chrome.tabs.group;
chrome.tabs.group = async (opts) => {
    groupCalls.push(opts);
    return originalGroup(opts);
};

// Action: Move A and B into Group
await new Promise(resolve => {
    listeners['onMessage']({
        type: "MOVE_LOGICAL_TABS",
        windowId: 100,
        logicalIds: [logicalA.logicalId, logicalB.logicalId],
        targetLogicalId: logicalGroup.groupId, // The bookmark ID of the group
        position: 'inside'
    }, {}, resolve);
});

// Verification
await new Promise(r => setTimeout(r, 500)); // Wait for processing

console.log('Group Calls:', JSON.stringify(groupCalls, null, 2));

// Expectation: 2 calls. One for A, one for B.
if (groupCalls.length === 2) {
    console.log("SUCCESS: Both tabs grouped.");
} else {
    console.error(`FAILURE: Expected 2 group calls, got ${groupCalls.length}.`);
    process.exit(1);
}
