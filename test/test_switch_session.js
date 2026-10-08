const assert = require('node:assert/strict');

async function runTest() {
    const { listeners } = await import('./mock_chrome.js');

    // Keep these browser defaults local to this caller regression. The shared mock
    // uses random IDs and does not deactivate siblings when creating an active tab.
    // Both can mask which live tab SWITCH_SESSION actually chooses.
    let nextTabId = 100;
    let nextBookmarkId = 1;
    let nextLogicalId = 1;
    const createTab = chrome.tabs.create;
    const createBookmark = chrome.bookmarks.create;
    chrome.tabs.create = async (data) => {
        const tabs = await chrome.tabs.query({ windowId: data.windowId });
        const properties = { id: nextTabId++, groupId: -1, active: true, index: tabs.length, ...data };
        if (properties.active) {
            tabs.forEach(tab => { tab.active = false; });
        }
        return createTab(properties);
    };
    chrome.bookmarks.create = data => createBookmark({ ...data, id: String(nextBookmarkId++) });
    self.crypto.randomUUID = () => `logical-${nextLogicalId++}`;

    const root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
    const cases = [
        { name: 'two saved URLs', urls: ['https://example.com/first', 'https://example.com/second'] },
        { name: 'saved blank first', urls: ['about:blank', 'https://example.com/after-blank'] },
        { name: 'saved blank later', urls: ['https://example.com/before-blank', 'about:blank'] },
        { name: 'empty session', urls: [] }
    ];

    // Seed windows before loading production listeners, matching browser state that
    // already exists on startup. Each switch has its own window/session boundary.
    for (const [index, scenario] of cases.entries()) {
        scenario.windowId = index + 1;
        await chrome.windows.create({ id: scenario.windowId, type: 'normal' });
        await chrome.tabs.create({ windowId: scenario.windowId, url: `https://example.com/old/${index}` });
        scenario.folder = await chrome.bookmarks.create({ parentId: root.id, title: scenario.name });
        scenario.saved = [];
        for (const url of scenario.urls) {
            scenario.saved.push(await chrome.bookmarks.create({ parentId: scenario.folder.id, title: url, url }));
        }
    }

    // A real saved blank page must still be recognized during ordinary startup,
    // even when it is not the first bookmark. A global about:blank exclusion fails.
    const blankWindowId = cases.length + 1;
    await chrome.windows.create({ id: blankWindowId, type: 'normal' });
    const blankSession = await chrome.bookmarks.create({
        parentId: root.id, title: `Saved blank [windowId:${blankWindowId}]`
    });
    await chrome.bookmarks.create({ parentId: blankSession.id, title: 'First', url: 'https://example.com/unmounted' });
    const savedBlank = await chrome.bookmarks.create({ parentId: blankSession.id, title: 'Saved blank', url: 'about:blank' });
    const liveBlank = await chrome.tabs.create({ windowId: blankWindowId, url: 'about:blank' });

    await import('../src/background.js');
    await listeners.onInstalled();
    const sendMessage = message => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 2000);
        listeners.onMessage(message, {}, response => {
            clearTimeout(timer);
            resolve(response);
        });
    });
    const getSession = async windowId => (await sendMessage({ type: 'GET_CURRENT_SESSION_STATE', windowId })).session;

    const blankState = await getSession(blankWindowId);
    const blankLogical = blankState.logicalTabs.find(tab => tab.bookmarkId === savedBlank.id);
    assert.equal(blankState.lastActiveLogicalTabId, blankLogical.logicalId, 'Startup must recover a legitimate blank page');
    assert.deepEqual(blankLogical.liveTabIds, [liveBlank.id]);
    console.log('PASS: startup recovers a legitimately stored blank page');

    const failures = [];
    for (const scenario of cases) {
        try {
            const previous = await getSession(scenario.windowId);
            const previousBookmarkIds = previous.logicalTabs.map(tab => tab.bookmarkId);
            const response = await sendMessage({
                type: 'SWITCH_SESSION', windowId: scenario.windowId, sessionId: scenario.folder.id
            });
            assert.equal(response.success, true);
            const session = await getSession(scenario.windowId);
            const activeTabs = await chrome.tabs.query({ windowId: scenario.windowId, active: true });
            const savedIds = new Set(scenario.saved.map(bookmark => bookmark.id));
            const mountedSaved = session.logicalTabs.filter(tab => savedIds.has(tab.bookmarkId) && tab.liveTabIds.length);
            console.log(`${scenario.name}: active=${activeTabs.map(tab => tab.url)}, savedMounted=${mountedSaved.length}`);
            assert.equal(session.sessionId, scenario.folder.id);
            assert.equal(activeTabs.length, 1, 'Exactly one live tab must be active');
            assert.equal(activeTabs[0].url, scenario.urls[0] || 'about:blank', 'Switch must focus the first saved page');
            // Sync already reuses a saved blank bookmark for the placeholder. Keep
            // that inherited mapping even when another saved page should get focus.
            const expectedMounted = scenario.saved.filter((bookmark, index) => index === 0 || bookmark.url === 'about:blank');
            assert.deepEqual(new Set(mountedSaved.map(tab => tab.bookmarkId)),
                new Set(expectedMounted.map(bookmark => bookmark.id)), 'Mount the first saved page while preserving saved blanks');
            const activeLogical = session.logicalTabs.find(tab => tab.logicalId === session.lastActiveLogicalTabId);
            assert.ok(activeLogical, 'Active logical identity must be present in the switched session');
            assert.deepEqual(activeLogical.liveTabIds, [activeTabs[0].id]);
            if (scenario.saved.length) {
                assert.equal(activeLogical.bookmarkId, scenario.saved[0].id, 'Preserve the chosen saved bookmark identity');
            }
            // Switching must retain existing history, including legitimate blanks.
            for (const id of [...previousBookmarkIds, ...savedIds]) {
                assert.equal((await chrome.bookmarks.get(id)).length, 1, `Bookmark ${id} must not be deleted`);
            }
            console.log(`PASS: ${scenario.name}`);
        } catch (error) {
            failures.push(`${scenario.name}: ${error.message}`);
        }
    }
    assert.deepEqual(failures, [], 'SWITCH_SESSION regressions');
}

runTest().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
