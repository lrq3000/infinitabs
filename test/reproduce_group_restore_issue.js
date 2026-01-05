
import { listeners } from './mock_chrome.js';
import '../src/background.js';

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

    if (!response1.session) {
        throw new Error("Session failed to bind!");
    }

    const logicalGroups = response1.session.groups;
    const groupKey = Object.keys(logicalGroups)[0];
    if (!groupKey) throw new Error("Group not found in session");
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

    if (!restoredTab) {
        console.error("FAIL: Restored tab not mapped.");
    } else {
        console.log("Restored Tab Logical Group ID:", restoredTab.groupId);
        console.log("Original Logical Group ID:", generatedGroupId);

        if (restoredTab.groupId !== generatedGroupId) {
            console.error("FAIL: Tab was NOT placed in the original logical group.");
            if (restoredTab.groupId === null) {
                console.error("-> Tab is ungrouped (in session root).");
            } else {
                console.error(`-> Tab is in a new group: ${restoredTab.groupId}`);
            }
        } else {
            console.log("PASS: Tab correctly placed in original logical group.");
        }
    }

    // Check for duplicates
    const children = await global.chrome.bookmarks.getChildren(sessionFolder.id);
    const groups = children.filter(c => !c.url);
    if (groups.length > 1) {
        console.error("FAIL: Duplicate group folders found.");
        groups.forEach(g => console.log(` - ${g.title} (${g.id})`));
    } else {
        console.log("PASS: No duplicate groups.");
    }
}

runTest().catch(e => console.error(e));
