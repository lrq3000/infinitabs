const assert = require('assert');

// This test validates Ctrl-specific insertion behavior.
async function runTest() {
    console.log('Starting test_chrome_tabs_create.js...');

    const { listeners } = await import('./mock_chrome.js');
    await import('../src/background.js');

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Extend mock query for this test so group filtering is realistic.
    const originalQuery = chrome.tabs.query;
    chrome.tabs.query = async (queryInfo) => {
        const tabs = await originalQuery(queryInfo);
        if (queryInfo.groupId === undefined) return tabs;
        return tabs.filter((tab) => tab.groupId === queryInfo.groupId);
    };

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

    const window = await chrome.windows.create({ focused: true });
    const groupedA = await chrome.tabs.create({ windowId: window.id, active: false, index: 0, groupId: 7, title: 'Grouped A' });
    const groupedB = await chrome.tabs.create({ windowId: window.id, active: true, index: 2, groupId: 7, title: 'Grouped B Active' });
    await chrome.tabs.create({ windowId: window.id, active: false, index: 3, groupId: -1, title: 'Ungrouped tail' });

    if (listeners['onInstalled']) listeners['onInstalled']();
    await wait(100);

    // Ignore setup calls and start assertions from ADD_NEW_TAB behavior only.
    createCalls.length = 0;
    groupCalls.length = 0;

    // Case 1: Ctrl + grouped active tab => insert after highest index in that group.
    await new Promise((resolve) => {
        listeners['onMessage']({ type: 'ADD_NEW_TAB', windowId: window.id, ctrlKey: true }, {}, resolve);
    });

    assert.ok(createCalls.length >= 1, 'chrome.tabs.create should be called for Ctrl + grouped path');
    assert.strictEqual(createCalls[0].index, groupedB.index + 1, 'Ctrl + grouped should insert after highest group index');
    assert.ok(groupCalls.length >= 1, 'Ctrl + grouped should preserve group via chrome.tabs.group');
    assert.strictEqual(groupCalls[0].groupId, 7, 'Ctrl + grouped should keep original group');

    // Case 2: Ctrl + ungrouped active tab => omit index and avoid grouping.
    const allTabsBeforeUngroupedCase = await chrome.tabs.query({ windowId: window.id });
    for (const tab of allTabsBeforeUngroupedCase) {
        await chrome.tabs.update(tab.id, { active: false });
    }
    const ungrouped = await chrome.tabs.create({ windowId: window.id, active: true, index: 5, groupId: -1, title: 'Ungrouped Active' });
    assert.ok(ungrouped, 'Ungrouped active tab should be created for scenario setup');
    const createCallCountBeforeSecondCtrl = createCalls.length;

    await new Promise((resolve) => {
        listeners['onMessage']({ type: 'ADD_NEW_TAB', windowId: window.id, ctrlKey: true }, {}, resolve);
    });

    assert.ok(createCalls.length > createCallCountBeforeSecondCtrl, 'Second Ctrl path should call create again');
    const secondCtrlCreateCall = createCalls[createCalls.length - 1];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(secondCtrlCreateCall, 'index'), false, 'Ctrl + ungrouped should omit insertion index');
    assert.strictEqual(groupCalls.length, 1, 'Ctrl + ungrouped should not call chrome.tabs.group');

    console.log('test_chrome_tabs_create.js passed.');
}

runTest().catch((error) => {
    console.error('test_chrome_tabs_create.js failed:', error);
    process.exit(1);
});
