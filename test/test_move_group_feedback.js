// Focused native-event model for the saved-only destination regression. Chromium
// remains authoritative; unlike the simpler movement mock this emits group loss
// and runs the real delayed onUpdated listener, including deliberately slow APIs.
const assert = require('node:assert/strict');

class GroupFeedbackBrowser {
    constructor(listeners) {
        this.listeners = listeners;
        this.groups = new Map();
        this.nextGroupId = 1000;
        this.delay = 0;
        this.failNextMove = false;
    }

    async setGroup(tab, groupId) {
        const oldGroupId = tab.groupId;
        if (oldGroupId === groupId) return;
        tab.groupId = groupId;
        await this.listeners['tabs.onUpdated'](tab.id, { groupId }, structuredClone(tab));
        if (oldGroupId !== -1 && !(await chrome.tabs.query({ windowId: tab.windowId })).some(t => t.groupId === oldGroupId)) {
            const old = this.groups.get(oldGroupId);
            this.groups.delete(oldGroupId);
            if (old) await this.listeners['tabGroups.onRemoved'](old);
        }
    }

    async group({ tabIds, groupId }) {
        const tabs = await Promise.all([].concat(tabIds).map(id => chrome.tabs.get(id)));
        if (groupId === undefined) {
            groupId = this.nextGroupId++;
            const group = { id: groupId, windowId: tabs[0].windowId, title: '', color: 'grey' };
            this.groups.set(groupId, group);
            await this.listeners['tabGroups.onCreated'](group);
        }
        for (const tab of tabs) await this.setGroup(tab, groupId);
        return groupId;
    }

    async move(id, { index }) {
        if (this.failNextMove) {
            this.failNextMove = false;
            throw new Error('Injected native move failure');
        }
        assert.equal(typeof id, 'number', 'This model covers individual native moves');
        const tab = await chrome.tabs.get(id);
        const tabs = (await chrome.tabs.query({ windowId: tab.windowId })).sort((a, b) => a.index - b.index);
        const oldIndex = tab.index;
        const members = tabs.filter(t => t.groupId === tab.groupId).length;
        tabs.splice(oldIndex, 1);
        tabs.splice(Math.min(index, tabs.length), 0, tab);
        tabs.forEach((item, i) => { item.index = i; });
        const left = tabs[tab.index - 1]?.groupId ?? -1;
        const right = tabs[tab.index + 1]?.groupId ?? -1;
        // The Chromium rule relevant here: separating one member from a group
        // ungroups it; the last remaining member carries its group when moved.
        const groupId = left !== -1 && left === right ? left :
            tab.groupId !== -1 && (members === 1 || left === tab.groupId || right === tab.groupId) ? tab.groupId : -1;
        this.listeners['tabs.onMoved'](id, { windowId: tab.windowId, fromIndex: oldIndex, toIndex: tab.index });
        await this.setGroup(tab, groupId);
        if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
        return structuredClone(tab);
    }
}

async function main() {
    const { listeners } = await import('./mock_chrome.js');
    let bookmarkId = 0, logicalId = 0;
    const createBookmark = chrome.bookmarks.create;
    chrome.bookmarks.create = data => createBookmark({ ...data, id: String(++bookmarkId) });
    self.crypto.randomUUID = () => `feedback-${++logicalId}`;
    const browser = new GroupFeedbackBrowser(listeners);
    chrome.tabs.group = options => browser.group(options);
    chrome.tabs.ungroup = async ids => {
        for (const id of [].concat(ids)) await browser.setGroup(await chrome.tabs.get(id), -1);
    };
    chrome.tabs.move = (id, info) => browser.move(id, info);
    chrome.tabGroups.get = async id => structuredClone(browser.groups.get(id));
    chrome.tabGroups.update = async (id, updates) => {
        const group = browser.groups.get(id);
        Object.assign(group, updates);
        await listeners['tabGroups.onUpdated'](structuredClone(group));
        return group;
    };
    const root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
    const fixtures = [];
    for (const windowId of [1, 2, 3]) {
        const grouped = windowId === 2;
        await chrome.windows.create({ id: windowId, type: 'normal' });
        const folder = await chrome.bookmarks.create({ parentId: root.id, title: `Feedback [windowId:${windowId}]` });
        const old = grouped ? await chrome.bookmarks.create({ parentId: folder.id, title: 'Source [red]' }) : null;
        if (old) browser.groups.set(20, { id: 20, windowId, title: 'Source', color: 'red' });
        const bookmarks = {}, live = {};
        let destination;
        for (const [index, name] of [...'ABCSD'].entries()) {
            if (name === 'S') destination = await chrome.bookmarks.create({ parentId: folder.id, title: 'Saved destination [blue]' });
            const inOld = grouped && 'AB'.includes(name);
            const url = `https://example.com/feedback/${windowId}/${name}`;
            bookmarks[name] = await chrome.bookmarks.create({
                parentId: name === 'S' ? destination.id : inOld ? old.id : folder.id, title: name, url
            });
            if (name !== 'S') live[name] = await chrome.tabs.create({
                id: windowId * 100 + index, windowId, index: name === 'D' ? 3 : index,
                groupId: inOld ? 20 : -1, active: name === 'A', title: name, url
            });
        }
        fixtures.push({ windowId, folder, destination, bookmarks, live });
    }
    await import('../src/background.js');
    await listeners.onInstalled();
    const send = message => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 5000);
        listeners.onMessage(message, {}, response => { clearTimeout(timer); resolve(structuredClone(response)); });
    });
    const session = async windowId => (await send({ type: 'GET_CURRENT_SESSION_STATE', windowId })).session;
    const failures = [];
    for (const fixture of fixtures) {
        const { windowId, destination, bookmarks, live } = fixture;
        try {
            browser.delay = windowId === 2 ? 150 : 0; // Longer than the delayed ungroup callback.
            browser.failNextMove = windowId === 3;
            const before = await session(windowId);
            const byBookmark = new Map(before.logicalTabs.map(tab => [tab.bookmarkId, tab]));
            const response = await send({ type: 'MOVE_LOGICAL_TABS', windowId,
                logicalIds: [...'AB'].map(name => byBookmark.get(bookmarks[name].id).logicalId),
                targetLogicalId: destination.id, position: 'inside' });
            assert.equal(response.success, true);
            await new Promise(resolve => setTimeout(resolve, 250));
            if (windowId === 3) {
                // A later genuine browser change must not be swallowed by a guard
                // left behind by the failed MOVE_LOGICAL_TABS operation.
                const external = await chrome.tabs.group({ tabIds: live.B.id });
                await new Promise(resolve => setTimeout(resolve, 250));
                const after = await session(windowId);
                const tab = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks.B.id);
                assert.notEqual(tab.groupId, destination.id, 'Group feedback guard must clear on native failure');
                assert.equal((await chrome.tabs.get(live.B.id)).groupId, external);
                await chrome.tabs.move(live.A.id, { index: 2 });
                await new Promise(resolve => setTimeout(resolve, 250));
                assert.equal((await chrome.bookmarks.get(bookmarks.A.id))[0].parentId, fixture.folder.id,
                    'Move feedback guard must clear on native failure');
                console.log('PASS failed native move releases feedback guard');
                continue;
            }
            const after = await session(windowId);
            const names = new Map(Object.entries(bookmarks).map(([name, bookmark]) => [bookmark.id, name]));
            assert.deepEqual(after.logicalTabs.map(tab => names.get(tab.bookmarkId)), [...'CSABD'], 'Settled bookmark order');
            const native = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
            assert.deepEqual(native.map(tab => tab.id), [...'CABD'].map(name => live[name].id), 'Native order');
            const groupId = (await chrome.tabs.get(live.A.id)).groupId;
            assert.notEqual(groupId, -1);
            assert.equal((await chrome.tabs.get(live.B.id)).groupId, groupId, 'Both moved tabs must retain the destination group');
            assert.equal(browser.groups.get(groupId).title, 'Saved destination');
            assert.equal(browser.groups.get(groupId).color, 'blue');
            for (const name of 'SAB') {
                const tab = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks[name].id);
                assert.equal(tab.groupId, destination.id, `Settled logical group ${name}`);
                assert.equal((await chrome.bookmarks.get(bookmarks[name].id))[0].parentId, destination.id);
            }
            const active = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks.A.id);
            assert.equal(after.lastActiveLogicalTabId, active.logicalId);
            console.log(`PASS saved-only destination (${windowId === 2 ? 'grouped source, slow native APIs' : 'ungrouped source'})`);
        } catch (error) { failures.push(`window ${windowId}: ${error.message}`); }
    }
    assert.deepEqual(failures, [], 'Native group feedback regressions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
