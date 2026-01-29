
import { listeners } from './mock_chrome.js';
import '../src/background.js'; // This will execute global code in background.js

// Wait for initialization
await new Promise(r => setTimeout(r, 100));

// Setup environment
const windowId = 1;

// Create window in mock
await chrome.windows.create({ id: windowId, type: 'normal' });

// Mock existing session bookmark
const rootId = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
// Note: Window 1 session
const sessionFolder = await chrome.bookmarks.create({
    parentId: rootId.id,
    title: "Session - Window 1 [windowId:1]"
});

console.log('Created Session Bookmark:', sessionFolder.id);

// Mock state initialization
// background.js calls init on startup.
const onStartup = listeners['onStartup'];
if (onStartup) await onStartup();

console.log('Background initialized');

// Simulate New Tab creation (Ctrl+T)
// 1. Browser creates tab
// 2. Browser activates tab

const newTabId = 101;
const newTab = {
    id: newTabId,
    windowId: windowId,
    active: true, // It is created active
    index: 0,
    url: "about:blank",
    title: "New Tab"
};

// Add tab to mock
chrome.tabs.create(newTab);

console.log('Simulating Tab Creation...');

// Step 1: onCreated
const onCreated = listeners['tabs.onCreated'];
const onCreatedPromise = onCreated(newTab);

// Step 2: onActivated (happens immediately after, often before onCreated async work finishes)
console.log('Simulating Tab Activation...');
const onActivated = listeners['tabs.onActivated'];
await onActivated({ tabId: newTabId, windowId: windowId });

// Wait for onCreated to finish
await onCreatedPromise;

// Verify state
const onMessage = listeners['onMessage'];
const sendMessage = (msg) => {
    return new Promise(resolve => {
        onMessage(msg, {}, resolve);
    });
};

const response = await sendMessage({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId });
const session = response.session;

// console.log('Session State:', JSON.stringify(session, null, 2));

const logicalTab = session.logicalTabs.find(l => l.liveTabIds.includes(newTabId));
if (!logicalTab) {
    console.error('FAIL: Logical tab not found for new tab');
    // Debug info
    console.log('Logical Tabs:', session.logicalTabs.map(l => ({ id: l.logicalId, live: l.liveTabIds })));
} else {
    console.log('Logical ID for new tab:', logicalTab.logicalId);
    console.log('Last Active Logical ID:', session.lastActiveLogicalTabId);

    if (session.lastActiveLogicalTabId === logicalTab.logicalId) {
        console.log('SUCCESS: Selection is correct.');
    } else {
        console.error('FAIL: Selection is incorrect. Expected ' + logicalTab.logicalId + ', got ' + session.lastActiveLogicalTabId);
    }
}
