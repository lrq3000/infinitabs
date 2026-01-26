
// test/test_history_switch.js
const assert = require('assert');

// 1. Setup Mock Environment
async function runTest() {
    console.log("Starting test_history_switch.js...");

    // Import mock chrome
    const { listeners } = await import('./mock_chrome.js');

    // Setup Global State
    // We need to initialize background logic.
    // Since background.js is a script, we can "import" it, but it executes immediately.
    // We rely on mock_chrome to provide the environment.

    // Note: mock_chrome.js sets globals.
    // We need to import background.js to register listeners.
    await import('../src/background.js');

    // Helper to wait
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // small helper that waits for the active tab reduces flakiness
    const waitForActiveTab = async (windowId, expectedTabId, timeoutMs = 500) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const tabs = await chrome.tabs.query({ windowId });
            const active = tabs.find(t => t.active);
            if (active && active.id === expectedTabId) return;
            await wait(10);
        }
        throw new Error(`Timed out waiting for active tab ${expectedTabId}`);
    };

    // 2. Setup Scenario
    // Create a window
    const window = await chrome.windows.create({ focused: true });

    // Create tabs
    const tab1 = await chrome.tabs.create({ windowId: window.id, active: true, index: 0, title: "Tab 1" });
    const tab2 = await chrome.tabs.create({ windowId: window.id, active: false, index: 1, title: "Tab 2" });
    const tab3 = await chrome.tabs.create({ windowId: window.id, active: false, index: 2, title: "Tab 3" });

    // Trigger initialization of background (usually done on install/startup)
    if (listeners['onInstalled']) listeners['onInstalled']();

    await wait(100);

    // Enable the option
    await chrome.storage.local.set({
        maxTabHistory: 10
    });

    // Manually trigger onChanged because mock doesn't do it automatically
    if (listeners['storage.onChanged']) {
        listeners['storage.onChanged']({
            maxTabHistory: { newValue: 10 }
        }, 'local');
    }

    console.log("Tabs created:", tab1.id, tab2.id, tab3.id);

    // 3. Simulate Activation Sequence: Tab 1 -> Tab 2 -> Tab 3
    // Tab 1 is already active from creation (implicitly) but let's be explicit
    await chrome.tabs.update(tab1.id, { active: true });
    await waitForActiveTab(window.id, tab1.id);

    await chrome.tabs.update(tab2.id, { active: true });
    await waitForActiveTab(window.id, tab2.id);

    await chrome.tabs.update(tab3.id, { active: true });
    await waitForActiveTab(window.id, tab3.id);

    // Current Active: Tab 3
    // History (expected): [Tab 1, Tab 2, Tab 3]

    // 4. Test Unmount Tab 3 -> Should go to Tab 2
    console.log("Unmounting Tab 3 (Active)...");

    // We use message passing to simulate UI action "UNMOUNT_LOGICAL_TAB"
    // First we need the logical ID for Tab 3
    // Background should have mapped them.

    // To get logical ID, we can ask background state (via message)
    // Or we can cheat and look at `state` if we exported it, but we didn't.
    // So we use "GET_CURRENT_SESSION_STATE"

    let response = await new Promise(resolve => {
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: window.id }, {}, resolve);
    });

    const session = response.session;
    assert(session, "Session should be created");

    const logicalTab3 = session.logicalTabs.find(t => t.liveTabIds.includes(tab3.id));
    assert(logicalTab3, "Logical tab 3 should exist");

    // Trigger Unmount
    await new Promise(resolve => {
        listeners['onMessage']({
            type: "UNMOUNT_LOGICAL_TAB",
            windowId: window.id,
            logicalId: logicalTab3.logicalId
        }, {}, resolve);
    });

    await wait(100);

    // Verify Tab 2 is active
    let tabs = await chrome.tabs.query({ windowId: window.id });
    let activeTab = tabs.find(t => t.active);
    console.log("Active tab after closing Tab 3:", activeTab.id);
    assert.strictEqual(activeTab.id, tab2.id, "Tab 2 should be active after closing Tab 3");

    // 5. Test Unmount Tab 2 -> Should go to Tab 1
    console.log("Unmounting Tab 2 (Active)...");

    // Fetch session again to be safe
    response = await new Promise(resolve => {
        listeners['onMessage']({ type: "GET_CURRENT_SESSION_STATE", windowId: window.id }, {}, resolve);
    });
    const logicalTab2 = response.session.logicalTabs.find(t => t.liveTabIds.includes(tab2.id))
    assert(logicalTab2, "Logical tab 2 should exist");;

    await new Promise(resolve => {
        listeners['onMessage']({
            type: "UNMOUNT_LOGICAL_TAB",
            windowId: window.id,
            logicalId: logicalTab2.logicalId
        }, {}, resolve);
    });

    await wait(100);

    tabs = await chrome.tabs.query({ windowId: window.id });
    activeTab = tabs.find(t => t.active);
    console.log("Active tab after closing Tab 2:", activeTab.id);
    assert.strictEqual(activeTab.id, tab1.id, "Tab 1 should be active after closing Tab 2");

    console.log("Test Passed!");
}

runTest().catch(e => {
    console.error("Test Failed:", e);
    process.exit(1);
});
