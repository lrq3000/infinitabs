// Consolidates PR38's grouping reproduction and PR75's ordering intent through
// the public message boundary. No session-title guesses or production test hooks.
const assert = require('node:assert/strict');

class MovementCheck {
    constructor(windowId, grouped = false) {
        this.windowId = windowId;
        this.grouped = grouped;
        this.saved = new Map();
        this.live = new Map();
    }

    async prepare(root) {
        await chrome.windows.create({ id: this.windowId, type: 'normal' });
        this.folder = await chrome.bookmarks.create({
            parentId: root.id, title: `Movement [windowId:${this.windowId}]`
        });
        for (const [index, name] of ['A', 'B', 'C', 'D', 'E'].entries()) {
            if (name === 'C') {
                this.group = await chrome.bookmarks.create({ parentId: this.folder.id, title: 'Destination [blue]' });
            }
            const inGroup = this.grouped && (name === 'C' || name === 'D');
            const url = `https://example.com/${this.windowId}/${name}`;
            this.saved.set(name, await chrome.bookmarks.create({
                parentId: inGroup ? this.group.id : this.folder.id, title: name, url
            }));
            this.live.set(name, await chrome.tabs.create({
                id: this.windowId * 100 + index, windowId: this.windowId,
                groupId: inGroup ? this.windowId * 10 : -1, active: name === 'A', index, url, title: name
            }));
        }
    }

    async session() {
        return (await this.send({ type: 'GET_CURRENT_SESSION_STATE' })).session;
    }

    async unmount(name) {
        const tab = (await this.session()).logicalTabs.find(tab => tab.bookmarkId === this.saved.get(name).id);
        const response = await this.send({ type: 'UNMOUNT_LOGICAL_TAB', logicalId: tab.logicalId });
        assert.equal(response.success, true);
        this.live.delete(name);
    }

    send(message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 3000);
            this.listeners.onMessage({ windowId: this.windowId, ...message }, {}, response => {
                clearTimeout(timer);
                resolve(structuredClone(response)); // Match Chrome's message snapshot semantics.
            });
        });
    }

    async move(names, target, position, order, groupedNames = []) {
        const before = await this.session();
        const byBookmark = new Map(before.logicalTabs.map(tab => [tab.bookmarkId, tab]));
        const logical = name => byBookmark.get(this.saved.get(name).id);
        const response = await this.send({ type: 'MOVE_LOGICAL_TABS',
            logicalIds: names.map(name => logical(name).logicalId),
            targetLogicalId: target === 'group' ? this.group.id : logical(target).logicalId, position });
        assert.equal(response.success, true);
        const after = await this.session();
        const afterByBookmark = new Map(after.logicalTabs.map(tab => [tab.bookmarkId, tab]));
        assert.equal(after.sessionId, before.sessionId);
        assert.deepEqual(Object.keys(after.groups), Object.keys(before.groups), 'Retain group folders, including empty ones');
        for (const [name, bookmark] of this.saved) {
            const tab = afterByBookmark.get(bookmark.id);
            assert.ok(tab, `Retain bookmark ${name}`);
            assert.notEqual(tab.logicalId, logical(name).logicalId, 'Reload must regenerate logical IDs');
            assert.deepEqual(tab.liveTabIds, this.live.has(name) ? [this.live.get(name).id] : [], `Retain live identity ${name}`);
            assert.equal(tab.groupId || null, groupedNames.includes(name) ? this.group.id : null);
        }
        assert.equal(after.lastActiveLogicalTabId, afterByBookmark.get(this.saved.get('A').id).logicalId);
        const bookmarkNames = new Map([...this.saved].map(([name, bookmark]) => [bookmark.id, name]));
        assert.deepEqual(after.logicalTabs.map(tab => bookmarkNames.get(tab.bookmarkId)), order,
            'Bookmark-backed session order');
        const live = (await chrome.tabs.query({ windowId: this.windowId })).sort((a, b) => a.index - b.index);
        for (const [name, tab] of this.live) {
            assert.equal(live.find(item => item.id === tab.id).groupId,
                groupedNames.includes(name) ? this.windowId * 10 : -1, `Native group for ${name}`);
        }
        assert.deepEqual(live.map(tab => tab.id), order.filter(name => this.live.has(name)).map(name => this.live.get(name).id),
            'Native tab order');
    }
}

async function main() {
    const { listeners } = await import('./mock_chrome.js');
    let bookmarkId = 0;
    let logicalId = 0;
    const createBookmark = chrome.bookmarks.create;
    chrome.bookmarks.create = data => createBookmark({ ...data, id: String(++bookmarkId) });
    self.crypto.randomUUID = () => `logical-${++logicalId}`;

    // Native bookmarks.move indexes the destination before removal, unlike the
    // shared mock. Chromium's forward regression independently checks this rule.
    const moveBookmark = chrome.bookmarks.move;
    chrome.bookmarks.move = async (id, destination) => {
        const [node] = await chrome.bookmarks.get(id);
        const adjusted = { ...destination };
        if (node.parentId === destination.parentId && node.index < destination.index) adjusted.index--;
        return moveBookmark(id, adjusted);
    };

    // Local, stateful API adapters: the shared mock's grouping is a no-op and its
    // global move mixes windows. Real event/order behavior is covered by Chromium.
    chrome.tabs.group = async ({ groupId, tabIds }) => {
        assert.ok(Number.isInteger(groupId), 'These fixtures must reuse the existing native group');
        for (const id of [].concat(tabIds)) (await chrome.tabs.get(id)).groupId = groupId;
        return groupId;
    };
    chrome.tabs.ungroup = async ids => {
        for (const id of [].concat(ids)) (await chrome.tabs.get(id)).groupId = -1;
    };
    chrome.tabs.move = async (ids, { index }) => {
        const selected = [].concat(ids);
        const windowId = (await chrome.tabs.get(selected[0])).windowId;
        const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
        // Chromium processes array moves sequentially with increasing destinations.
        for (const id of selected) {
            const [tab] = tabs.splice(tabs.findIndex(item => item.id === id), 1);
            tabs.splice(index === -1 ? tabs.length : Math.min(index++, tabs.length), 0, tab);
        }
        tabs.forEach((tab, i) => { tab.index = i; });
    };

    const root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
    const grouping = new MovementCheck(1, true);
    const ungrouping = new MovementCheck(2, true);
    const forward = new MovementCheck(3);
    const backward = new MovementCheck(4);
    for (const check of [grouping, ungrouping, forward, backward]) {
        check.listeners = listeners;
        await check.prepare(root);
    }
    await import('../src/background.js');
    await listeners.onInstalled();

    const cases = [
        ['multiselect into existing group, then repeat with refreshed IDs', async () => {
            await grouping.move(['A', 'B'], 'group', 'inside', ['C', 'D', 'A', 'B', 'E'], ['C', 'D', 'A', 'B']);
            await grouping.move(['A', 'B'], 'C', 'before', ['A', 'B', 'C', 'D', 'E'], ['A', 'B', 'C', 'D']);
        }],
        ['multiselect out of group', () => ungrouping.move(['C', 'D'], 'A', 'before', ['C', 'D', 'A', 'B', 'E'])],
        ['forward move, reversed selection, and saved-only tabs', async () => {
            await forward.move(['A', 'B'], 'E', 'before', ['C', 'D', 'A', 'B', 'E']);
            await forward.unmount('D');
            await forward.move(['B', 'A'], 'E', 'after', ['C', 'D', 'E', 'B', 'A']);
            await forward.move(['E', 'D'], 'C', 'before', ['E', 'D', 'C', 'B', 'A']);
            await forward.move(['D'], 'B', 'after', ['E', 'C', 'B', 'D', 'A']);
            await forward.move(['E', 'B'], 'A', 'after', ['C', 'D', 'A', 'E', 'B']);
        }],
        ['backward move then repeat selection after reload', async () => {
            await backward.move(['D', 'E'], 'B', 'before', ['A', 'D', 'E', 'B', 'C']);
            await backward.move(['D', 'E'], 'A', 'before', ['D', 'E', 'A', 'B', 'C']);
        }]
    ];
    const failures = [];
    for (const [name, run] of cases) {
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures.push(`${name}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'MOVE_LOGICAL_TABS regressions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
