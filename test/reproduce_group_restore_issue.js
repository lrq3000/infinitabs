
import { listeners } from './mock_chrome.js';
import '../src/background.js';

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function runTest() {
    console.log("Starting reproduction test...");

    const windowId = 100;
    const groupTitle = "Test Group";
    const groupColor = "blue";
    const fullGroupTitle = `${groupTitle} [${groupColor}]`;

    // 1. Setup Environment
    // Ensure root folder exists
    const root = await global.chrome.bookmarks.create({
        title: "InfiniTabs Sessions"
    });

    // Create Window
    await global.chrome.windows.create({ id: windowId });

    // Create Session Folder manually (simulating existing state)
    const sessionFolder = await global.chrome.bookmarks.create({
        parentId: root.id,
        title: `Session - Window ${windowId} [windowId:${windowId}]`
    });

    // Create Group Folder (Logical Group)
    const groupFolder = await global.chrome.bookmarks.create({
        parentId: sessionFolder.id,
        title: fullGroupTitle
    });
    const generatedGroupId = groupFolder.id;

    // Create Logical Tab inside Group
    await global.chrome.bookmarks.create({
        parentId: groupFolder.id,
        title: "Tab 1",
        url: "https://example.com"
    });

    console.log("Bookmarks structure created.");

    // 2. Initialize Background Script
    // This should trigger init(), find the window, find the matching session folder, and bind them.
    await listeners['onStartup']();

    await new Promise(r => setTimeout(r, 500));

    // Verify Session State
    const response1 = await new Promise(resolve => {
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, resolve);
    });

    assert(!!response1.session, "Session failed to bind!");

    const logicalGroups = response1.session.groups;
    const groupKey = Object.keys(logicalGroups)[0];
    assert(!!groupKey, "Group not found in session");
    console.log(`Initial Session Loaded. Group ID: ${groupKey}`);

    // 3. Simulate User Restoring Tab (Cmd+Shift+T)
    const newLiveGroupId = 999;

    console.log("Simulating Group Restoration...");
    // chrome.tabGroups.onCreated
    await listeners['tabGroups.onCreated']({
        id: newLiveGroupId,
        windowId: windowId,
        title: groupTitle,
        color: groupColor
    });

    console.log("Simulating Tab Restoration...");
    // chrome.tabs.onCreated
    // Note: When restoring, Chrome might fire onCreated first, then onUpdated?
    // Or onCreated with groupId set.
    const newTab = {
        id: 500,
        windowId: windowId,
        groupId: newLiveGroupId,
        title: "Tab 1",
        url: "https://example.com",
        index: 0,
        active: true
    };
    await listeners['tabs.onCreated'](newTab);

    await new Promise(r => setTimeout(r, 1000));

    // 4. Verify Result
    const response2 = await new Promise(resolve => {
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, resolve);
    });

    const session = response2.session;
    const restoredTab = session.logicalTabs.find(t => t.liveTabIds.includes(500));

    assert(!!restoredTab, "FAIL: Restored tab not mapped.");

    console.log("Restored Tab Logical Group ID:", restoredTab.groupId);
    console.log("Original Logical Group ID:", generatedGroupId);
    assert(restoredTab.groupId === generatedGroupId, "FAIL: Tab was NOT placed in the original logical group.");
    console.log("PASS: Tab correctly placed in original logical group.");

    // Check for duplicates
    const children = await global.chrome.bookmarks.getChildren(sessionFolder.id);
    const groups = children.filter(c => !c.url);
    assert(groups.length <= 1, "FAIL: Duplicate group folders found.");
    console.log("PASS: No duplicate groups.");

    // 5. Regression for ambiguous title matches:
    // If two unmapped logical folders share the same title/color, restoration MUST NOT
    // bind to either existing folder by guesswork. A new folder should be created instead.
    const ambiguousWindowId = 101;
    const ambiguousSessionFolder = await global.chrome.bookmarks.create({
        parentId: root.id,
        title: `Session - Window ${ambiguousWindowId} [windowId:${ambiguousWindowId}]`
    });

    const ambiguousGroupA = await global.chrome.bookmarks.create({
        parentId: ambiguousSessionFolder.id,
        title: fullGroupTitle
    });
    await global.chrome.bookmarks.create({
        parentId: ambiguousGroupA.id,
        title: "Tab A",
        url: "https://example-a.com"
    });

    const ambiguousGroupB = await global.chrome.bookmarks.create({
        parentId: ambiguousSessionFolder.id,
        title: fullGroupTitle
    });
    await global.chrome.bookmarks.create({
        parentId: ambiguousGroupB.id,
        title: "Tab B",
        url: "https://example-b.com"
    });

    await global.chrome.windows.create({ id: ambiguousWindowId });
    await listeners['onStartup']();
    await new Promise(r => setTimeout(r, 500));

    const ambiguousLiveGroupId = 1001;
    await listeners['tabGroups.onCreated']({
        id: ambiguousLiveGroupId,
        windowId: ambiguousWindowId,
        title: groupTitle,
        color: groupColor
    });

    await listeners['tabs.onCreated']({
        id: 1002,
        windowId: ambiguousWindowId,
        groupId: ambiguousLiveGroupId,
        title: "Restored",
        url: "https://restored-tab.com",
        index: 0,
        active: true
    });

    await new Promise(r => setTimeout(r, 1000));

    const ambiguousResponse = await new Promise(resolve => {
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: ambiguousWindowId }, {}, resolve);
    });
    assert(!!ambiguousResponse.session, "FAIL: Ambiguous scenario session failed to bind.");

    const ambiguousRestoredTab = ambiguousResponse.session.logicalTabs.find(t => t.liveTabIds.includes(1002));
    assert(!!ambiguousRestoredTab, "FAIL: Ambiguous scenario restored tab not mapped.");

    assert(
        ambiguousRestoredTab.groupId !== ambiguousGroupA.id && ambiguousRestoredTab.groupId !== ambiguousGroupB.id,
        "FAIL: Ambiguous title match incorrectly reused an existing logical group."
    );

    console.log("PASS: Ambiguous title match did not reuse an existing logical group.");
}

runTest().catch(e => console.error(e));
