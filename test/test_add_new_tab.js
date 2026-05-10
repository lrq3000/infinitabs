const assert = require('assert');

// This test validates the default insertion branch (no Ctrl)
// and the fallback branch when no active tab exists.
async function runTest() {
    console.log('Starting test_add_new_tab.js...');

    const { listeners } = await import('./mock_chrome.js');
    await import('../src/background.js');

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Capture calls so we can assert index and grouping behavior.
    const originalCreate = chrome.tabs.create;
    const originalGroup = chrome.tabs.group;
    const createCalls = [];
    const groupCalls = [];

    chrome.tabs.create = async (data) => {
        createCalls.push({ ...data });
        return originalCreate(data);
    };
    chrome.tabs.group = async (data) => {
        groupCalls.push({ ...data });
        return originalGroup(data);
    };

    // Scenario setup.
    const window = await chrome.windows.create({ focused: true });
    const tab1 = await chrome.tabs.create({ windowId: window.id, active: false, index: 0, groupId: -1, title: 'Tab 1' });
    const tab2 = await chrome.tabs.create({ windowId: window.id, active: true, index: 1, groupId: 444, title: 'Tab 2' });

    if (listeners['onInstalled']) listeners['onInstalled']();
    await wait(100);

    // Ignore setup calls and start assertions from ADD_NEW_TAB behavior only.
    createCalls.length = 0;
    groupCalls.length = 0;

    // Case 1: no Ctrl => index is active index + 1 and group is inherited.
    await new Promise((resolve) => {
        listeners['onMessage']({ type: 'ADD_NEW_TAB', windowId: window.id, ctrlKey: false }, {}, resolve);
    });

    assert.ok(createCalls.length >= 1, 'chrome.tabs.create should be called');
    assert.strictEqual(createCalls[0].index, tab2.index + 1, 'No Ctrl should insert after active tab');
    assert.strictEqual(groupCalls.length >= 1, true, 'Grouped active tab should trigger chrome.tabs.group');
    assert.strictEqual(groupCalls[0].groupId, 444, 'No Ctrl should inherit active tab group');

    // Case 2: no active tab => index and group are omitted safely.
    const allTabsBeforeCaseTwo = await chrome.tabs.query({ windowId: window.id });
    for (const tab of allTabsBeforeCaseTwo) {
        await chrome.tabs.update(tab.id, { active: false });
    }

    await new Promise((resolve) => {
        listeners['onMessage']({ type: 'ADD_NEW_TAB', windowId: window.id, ctrlKey: false }, {}, resolve);
    });

    assert.ok(createCalls.length >= 2, 'Second add tab call should be created');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(createCalls[1], 'index'), false, 'No active tab should omit insertion index');

    console.log('test_add_new_tab.js passed.');
}

runTest().catch((error) => {
    console.error('test_add_new_tab.js failed:', error);
    process.exit(1);
});
