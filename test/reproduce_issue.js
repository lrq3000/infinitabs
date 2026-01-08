
import { listeners } from './mock_chrome.js';
import * as assert from 'assert';

// Mock specific parts for this test
global.importScripts = () => {}; // No-op

async function runTest() {
    console.log("Starting test...");

    // 1. Initialize background.js
    await import('../src/background.js');

    // 2. Setup initial state
    if (listeners['onStartup']) await listeners['onStartup']();

    // Create a window
    const windowId = 1;
    await global.chrome.windows.create({ id: windowId });

    // Wait for async init
    await new Promise(r => setTimeout(r, 100));

    // Get the session ID
    let sessionId;
    listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, (response) => {
        if (response.session) sessionId = response.session.sessionId;
    });

    if (!sessionId) {
        await new Promise(r => setTimeout(r, 100));
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, (response) => {
            if (response.session) sessionId = response.session.sessionId;
        });
    }

    assert.ok(sessionId, "Session should be created");
    console.log("Session ID:", sessionId);

    // 3. Create a group in bookmarks (Simulating existing state)
    const groupNode = await global.chrome.bookmarks.create({
        parentId: sessionId,
        title: "Test Group [blue]"
    });
    console.log("Created group bookmark:", groupNode.id);

    // Create a tab bookmark inside the group
    const tabNode = await global.chrome.bookmarks.create({
        parentId: groupNode.id,
        title: "Tab Inside Group",
        url: "https://example.com"
    });
    console.log("Created tab bookmark:", tabNode.id);

    // 4. Reload session state via SWITCH_SESSION
    console.log("Reloading session via SWITCH_SESSION...");
    await new Promise(resolve => {
        listeners['onMessage']({
            type: "SWITCH_SESSION",
            windowId: windowId,
            sessionId: sessionId
        }, {}, () => resolve());
    });

    // Get session state again to find logical IDs
    let session;
    listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: windowId }, {}, (response) => {
        session = response.session;
    });

    assert.ok(session, "Session should be reloaded");

    // Find the tab in the group
    const logicalTab = session.logicalTabs.find(t => t.groupId === groupNode.id);
    assert.ok(logicalTab, "Should find logical tab in group");
    const logicalId = logicalTab.logicalId;

    console.log("Moving tab out of group...");

    // 5. Move the tab out of the group (to root)
    await new Promise((resolve, reject) => {
        listeners['onMessage']({
            type: "MOVE_LOGICAL_TABS",
            windowId: windowId,
            logicalIds: [logicalId],
            targetLogicalId: sessionId,
            position: 'inside'
        }, {}, (response) => {
            if (response && response.success) resolve();
            else reject(new Error("Move failed"));
        });
    });

    // 6. Verify results
    const nodes = await global.chrome.bookmarks.get(groupNode.id);

    if (nodes.length === 0) {
        console.log("SUCCESS: Group bookmark was deleted.");
    } else {
        console.log("FAILURE: Group bookmark still exists.");
        process.exit(1);
    }
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
