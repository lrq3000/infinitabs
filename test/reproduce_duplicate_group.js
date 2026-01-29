
import { listeners } from './mock_chrome.js';
import '../src/background.js';

// Setup Mock Environment
const windowId = 1;
await chrome.windows.create({ id: windowId, type: 'normal' });

// Mock existing session
const rootId = await chrome.bookmarks.create({ title: "InfiniTabs Sessions" });
const sessionFolder = await chrome.bookmarks.create({
    parentId: rootId.id,
    title: "Session - Window 1 [windowId:1]"
});

// Initialize background
const onStartup = listeners['onStartup'];
if (onStartup) await onStartup();

console.log('Background initialized');

// Spy on chrome.bookmarks.create
const originalCreate = chrome.bookmarks.create;
const createCalls = [];
chrome.bookmarks.create = async (data) => {
    createCalls.push(data);
    return originalCreate(data);
};

// Simulate Tab Group Creation
const groupId = 1001;
const groupInfo = {
    id: groupId,
    windowId: windowId,
    title: "My Group",
    color: "blue"
};

// Mock chrome.tabGroups.get because getOrCreateGroupBookmark calls it
chrome.tabGroups.get = async (id) => {
    if (id === groupId) return groupInfo;
    throw new Error("Group not found");
};

console.log('Simulating Group Creation...');
const onGroupCreated = listeners['tabGroups.onCreated'];
if (onGroupCreated) {
    // getOrCreateGroupBookmark has a debounce of 1000ms.
    // We need to wait for it.

    // We can't await the debounce easily as it is inside the function not returned by the listener directly?
    // Wait, onGroupCreated is async in background.js: chrome.tabGroups.onCreated.addListener(async (group) => { ... })
    // So if we await it, we await the promise returned by the listener function.

    const promise = onGroupCreated(groupInfo);

    // However, inside getOrCreateGroupBookmark there is `await new Promise(resolve => setTimeout(resolve, 1000));`
    // We need to advance timers or wait real time.
    // Node.js doesn't have fake timers by default unless we use a library or overwrite setTimeout.
    // But 1 second is acceptable for a test.

    await promise;

    // The listener returns the result of getOrCreateGroupBookmark promise?
    // background.js:
    // chrome.tabGroups.onCreated.addListener(async (group) => {
    //    ...
    //    await getOrCreateGroupBookmark(group.id, group.windowId);
    // });

    // So awaiting onGroupCreated should wait for the whole process.
}

console.log('Create calls:', createCalls);

const groupTitle = "My Group [blue]";
const groupCreates = createCalls.filter(c => c.title === groupTitle);

if (groupCreates.length === 2) {
    console.log("CONFIRMED: Duplicate group creation detected.");
    // Fail the test
    process.exit(1);
} else if (groupCreates.length === 1) {
    console.log("SUCCESS: Only one group folder created.");
    process.exit(0);
} else {
    console.log(`UNEXPECTED: Group created ${groupCreates.length} times.`);
    process.exit(1);
}
