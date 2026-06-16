
import { listeners } from './mock_chrome.js';
import * as assert from 'assert';

// Mock specific parts for this test
global.importScripts = () => {}; // No-op

/**
 * Sends a background message through the mock listener and resolves with the response.
 * This keeps asynchronous callback handling deterministic in this test harness.
 */
function sendMessage(message) {
    return new Promise((resolve) => {
        listeners['onMessage'](message, {}, (response) => resolve(response || null));
    });
}

/**
 * Creates a grouped bookmark with one or more tab bookmarks under it.
 */
async function createGroupWithTabs(sessionId, groupTitle, tabUrls) {
    const groupNode = await global.chrome.bookmarks.create({
        parentId: sessionId,
        title: groupTitle
    });

    const tabNodes = [];
    for (let i = 0; i < tabUrls.length; i++) {
        const tabNode = await global.chrome.bookmarks.create({
            parentId: groupNode.id,
            title: `Tab ${i + 1} Inside Group`,
            url: tabUrls[i]
        });
        tabNodes.push(tabNode);
    }

    return { groupNode, tabNodes };
}

/**
 * Moves one logical tab out of its group into the session root.
 */
async function moveLogicalTabOutOfGroup(windowId, sessionId, logicalId) {
    const response = await sendMessage({
        type: "MOVE_LOGICAL_TABS",
        windowId,
        logicalIds: [logicalId],
        targetLogicalId: sessionId,
        position: 'inside'
    });

    assert.ok(response && response.success, "Move should succeed");
}

/**
 * Returns the current in-memory session object for a window.
 */
async function getCurrentSession(windowId) {
    const response = await sendMessage({ type: "GET_CURRENT_SESSION_STATE", windowId });
    return response && response.session ? response.session : null;
}

async function runTest() {
    console.log("Starting test...");

    let windowId = null;

    try {
        // 1. Initialize background.js
        await import('../src/background.js');

        // 2. Setup initial state
        if (listeners['onStartup']) await listeners['onStartup']();

        // Create a window
        windowId = 1;
        await global.chrome.windows.create({ id: windowId });

        // Wait for async init
        await new Promise(r => setTimeout(r, 100));

        // Get the session ID — await the async callback path deterministically.
        const initialSession = await getCurrentSession(windowId);
        const sessionId = initialSession ? initialSession.sessionId : null;
        assert.ok(sessionId, "Session should be created");
        console.log("Session ID:", sessionId);

        // 3. Create one single-tab group and one two-tab group to validate
        // both deletion and non-deletion behavior around empty-group cleanup.
        const singleTabGroup = await createGroupWithTabs(
            sessionId,
            "Single Tab Group [blue]",
            ["https://example.com"]
        );
        console.log("Created single-tab group bookmark:", singleTabGroup.groupNode.id);

        const multiTabGroup = await createGroupWithTabs(
            sessionId,
            "Multi Tab Group [green]",
            ["https://example.org/first", "https://example.org/second"]
        );
        console.log("Created multi-tab group bookmark:", multiTabGroup.groupNode.id);

        // 4. Reload session state via SWITCH_SESSION so background logical state
        // reflects the bookmark fixture we created above.
        console.log("Reloading session via SWITCH_SESSION...");
        await sendMessage({
            type: "SWITCH_SESSION",
            windowId,
            sessionId
        });

        // 5. Move the single-tab group's only tab out of the group.
        // Expected: group becomes empty and is deleted.
        let session = await getCurrentSession(windowId);
        assert.ok(session, "Session should be reloaded");

        const singleLogicalTab = session.logicalTabs.find(t => t.groupId === singleTabGroup.groupNode.id);
        assert.ok(singleLogicalTab, "Should find logical tab in single-tab group");

        console.log("Moving only tab out of single-tab group...");
        await moveLogicalTabOutOfGroup(windowId, sessionId, singleLogicalTab.logicalId);

        const singleGroupNodes = await global.chrome.bookmarks.get(singleTabGroup.groupNode.id);
        assert.strictEqual(singleGroupNodes.length, 0, "Single-tab group should be deleted once empty");
        console.log("SUCCESS: Empty single-tab group was deleted.");

        // 6. Move tabs out of a two-tab group sequentially.
        // After first move: group should still exist with one child.
        // After second move: group should be deleted.
        session = await getCurrentSession(windowId);
        assert.ok(session, "Session should be available before sequential moves");

        let multiGroupLogicalTabs = session.logicalTabs.filter(t => t.groupId === multiTabGroup.groupNode.id);
        assert.strictEqual(multiGroupLogicalTabs.length, 2, "Two logical tabs should exist in multi-tab group");

        console.log("Moving first tab out of multi-tab group...");
        await moveLogicalTabOutOfGroup(windowId, sessionId, multiGroupLogicalTabs[0].logicalId);

        const multiGroupAfterFirstMove = await global.chrome.bookmarks.get(multiTabGroup.groupNode.id);
        assert.strictEqual(multiGroupAfterFirstMove.length, 1, "Multi-tab group should still exist after first move");
        const remainingChildren = await global.chrome.bookmarks.getChildren(multiTabGroup.groupNode.id);
        assert.strictEqual(remainingChildren.length, 1, "Multi-tab group should keep one child after first move");

        session = await getCurrentSession(windowId);
        multiGroupLogicalTabs = session.logicalTabs.filter(t => t.groupId === multiTabGroup.groupNode.id);
        assert.strictEqual(multiGroupLogicalTabs.length, 1, "One logical tab should remain in multi-tab group");

        console.log("Moving second tab out of multi-tab group...");
        await moveLogicalTabOutOfGroup(windowId, sessionId, multiGroupLogicalTabs[0].logicalId);

        const multiGroupAfterSecondMove = await global.chrome.bookmarks.get(multiTabGroup.groupNode.id);
        assert.strictEqual(multiGroupAfterSecondMove.length, 0, "Multi-tab group should be deleted after second move");
        console.log("SUCCESS: Multi-tab group persisted while non-empty, then deleted once empty.");
    } finally {
        // Keep test runs isolated and reproducible by cleaning up created window state,
        // even when an assertion fails midway through the flow.
        if (windowId !== null) {
            await global.chrome.windows.remove(windowId);
        }
    }
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
