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
        this.deferEvents = false;
        this.events = [];
        this.beforeMove = null;
        this.beforeGroup = null;
    }

    async emit(name, ...args) {
        if (this.deferEvents) this.events.push([name, structuredClone(args)]);
        else await this.listeners[name](...args);
    }

    async flushEvents() {
        this.deferEvents = false;
        for (const [name, args] of this.events.splice(0)) await this.emit(name, ...args);
    }

    async setGroup(tab, groupId) {
        const oldGroupId = tab.groupId;
        if (oldGroupId === groupId) return;
        tab.groupId = groupId;
        await this.emit('tabs.onUpdated', tab.id, { groupId }, structuredClone(tab));
        if (oldGroupId !== -1 && !(await chrome.tabs.query({ windowId: tab.windowId })).some(t => t.groupId === oldGroupId)) {
            const old = this.groups.get(oldGroupId);
            this.groups.delete(oldGroupId);
            if (old) await this.listeners['tabGroups.onRemoved'](old);
        }
    }

    async group({ tabIds, groupId }) {
        if (this.beforeGroup) {
            const hook = this.beforeGroup;
            this.beforeGroup = null;
            await hook([].concat(tabIds));
        }
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
        if (this.beforeMove) {
            const hook = this.beforeMove;
            this.beforeMove = null;
            await hook(id);
        }
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
        await this.emit('tabs.onMoved', id, { windowId: tab.windowId, fromIndex: oldIndex, toIndex: tab.index });
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
    // Chrome returns snapshots. Otherwise removing the final native group makes
    // its bookmark listener mutate the very children array it is iterating.
    const getChildren = chrome.bookmarks.getChildren;
    chrome.bookmarks.getChildren = async id => structuredClone(await getChildren(id));
    // Native bookmark destinations are measured before removing a same-parent
    // source. This matters when genuine native drags import a forward reorder.
    const moveBookmark = chrome.bookmarks.move;
    chrome.bookmarks.move = async (id, destination) => {
        const [node] = await chrome.bookmarks.get(id);
        const adjusted = { ...destination };
        if (node.parentId === destination.parentId && node.index < destination.index) adjusted.index--;
        return moveBookmark(id, adjusted);
    };
    self.crypto.randomUUID = () => `feedback-${++logicalId}`;
    const browser = new GroupFeedbackBrowser(listeners);
    const queryTabs = chrome.tabs.query;
    chrome.tabs.query = async query => (await queryTabs(query)).sort((a, b) => a.index - b.index);
    const getTab = chrome.tabs.get;
    chrome.tabs.get = async id => {
        const tab = await getTab(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
    };
    const removeTabs = chrome.tabs.remove;
    const close = async id => {
        const tab = await chrome.tabs.get(id);
        await removeTabs(id);
        (await chrome.tabs.query({ windowId: tab.windowId })).forEach((t, index) => { t.index = index; });
        await listeners['tabs.onRemoved'](id, { windowId: tab.windowId, isWindowClosing: false });
    };
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
    for (const windowId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        const rootBoundary = [10, 12].includes(windowId);
        const groupBoundary = windowId === 11;
        const grouped = [2, 4, 8, 9].includes(windowId) || groupBoundary;
        await chrome.windows.create({ id: windowId, type: 'normal' });
        const folder = await chrome.bookmarks.create({ parentId: root.id, title: `Feedback [windowId:${windowId}]` });
        const old = grouped ? await chrome.bookmarks.create({ parentId: folder.id, title: 'Source [red]' }) : null;
        if (old) browser.groups.set(windowId * 10, { id: windowId * 10, windowId, title: 'Source', color: 'red' });
        const bookmarks = {}, live = {};
        let destination = groupBoundary ? old : null;
        for (const [index, name] of [...'ABCSD'].entries()) {
            if ((name === 'S' && !rootBoundary && !groupBoundary) || (name === 'C' && rootBoundary)) {
                destination = await chrome.bookmarks.create({ parentId: folder.id, title: 'Saved destination [blue]' });
            }
            const inOld = grouped && (groupBoundary || 'AB'.includes(name));
            const inBoundary = rootBoundary && name === 'C';
            if (inBoundary) browser.groups.set(windowId * 10, { id: windowId * 10, windowId, title: 'Saved destination', color: 'blue' });
            const url = `https://example.com/feedback/${windowId}/${name}`;
            bookmarks[name] = await chrome.bookmarks.create({
                parentId: inBoundary || (name === 'S' && !rootBoundary) ? destination.id : inOld ? old.id : folder.id, title: name, url
            });
            if (name !== 'S') live[name] = await chrome.tabs.create({
                id: windowId * 100 + index, windowId, index: name === 'D' ? 3 : index,
                groupId: inOld || inBoundary ? windowId * 10 : -1, active: name === 'A', title: name, url
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
            if (windowId >= 10) {
                const names = new Map(Object.entries(bookmarks).map(([name, bookmark]) => [bookmark.id, name]));
                if (windowId !== 12) {
                    // A is already correctly placed after saved-only S. An
                    // unrelated D drag must not make A's queued feedback replay
                    // anchor placement, at the root OR inside a native group.
                    browser.deferEvents = true;
                    const response = await send({ type: 'MOVE_LOGICAL_TABS', windowId,
                        logicalIds: [byBookmark.get(bookmarks.A.id).logicalId],
                        targetLogicalId: byBookmark.get(bookmarks.D.id).logicalId, position: 'before' });
                    assert.equal(response.success, true);
                    assert.deepEqual((await session(windowId)).logicalTabs.map(tab => names.get(tab.bookmarkId)), [...'BCSAD']);
                    await chrome.tabs.move(live.D.id, { index: 0 });
                    await browser.flushEvents();
                } else {
                    // A genuine root drag after grouped C must anchor after the
                    // folder G, never reparent A into G from C's bookmark parent.
                    await chrome.tabs.move(live.A.id, { index: 2 });
                }
                await new Promise(resolve => setTimeout(resolve, 600));
                const after = await session(windowId);
                const active = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks.A.id);
                assert.deepEqual({
                    order: after.logicalTabs.map(tab => names.get(tab.bookmarkId)),
                    parent: (await chrome.bookmarks.get(bookmarks.A.id))[0].parentId,
                    group: (await chrome.tabs.get(live.A.id)).groupId
                }, {
                    order: [...(windowId === 12 ? 'BCASD' : 'DBCSA')],
                    parent: windowId === 11 ? destination.id : fixture.folder.id,
                    group: windowId === 11 ? windowId * 10 : -1
                }, 'Local placement and saved-only boundary');
                assert.equal(after.lastActiveLogicalTabId, active.logicalId);
                assert.deepEqual((await chrome.tabs.query({ windowId })).map(tab => tab.id),
                    [...(windowId === 12 ? 'BCAD' : 'DBCA')].map(name => live[name].id));
                console.log(`PASS local-boundary scenario ${windowId}`);
                continue;
            }
            // Deliver native feedback only after the public move has replied.
            // No artificial sleep determines the ordering of this race.
            browser.deferEvents = [4, 8, 9].includes(windowId);
            if (windowId === 5) browser.beforeMove = id => close(id);
            if (windowId === 6) browser.beforeMove = () => close(live.C.id);
            if (windowId === 7) browser.beforeGroup = () => close(live.B.id);
            const response = await send({ type: 'MOVE_LOGICAL_TABS', windowId,
                logicalIds: [...'AB'].map(name => byBookmark.get(bookmarks[name].id).logicalId),
                targetLogicalId: destination.id, position: 'inside' });
            assert.equal(response.success, true);
            if (windowId === 8) await chrome.tabs.move(live.D.id, { index: 0 });
            if (windowId === 9) await chrome.tabs.move(live.A.id, { index: 2 });
            await browser.flushEvents();
            await new Promise(resolve => setTimeout(resolve, windowId >= 8 ? 600 : 250));
            if (windowId === 3) {
                // A later genuine browser change must not be swallowed by a guard
                // left behind by the failed MOVE_LOGICAL_TABS operation.
                const external = await chrome.tabs.group({ tabIds: live.B.id });
                await new Promise(resolve => setTimeout(resolve, 250));
                const after = await session(windowId);
                const tab = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks.B.id);
                assert.notEqual(tab.groupId, destination.id, 'Group feedback guard must clear on native failure');
                assert.equal((await chrome.tabs.get(live.B.id)).groupId, external);
                // Explicitly leave the remaining one-member group: moving that
                // group preserves membership in Chromium and is not ungrouping.
                await chrome.tabs.ungroup(live.A.id);
                await new Promise(resolve => setTimeout(resolve, 250));
                await chrome.tabs.move(live.A.id, { index: 0 });
                await new Promise(resolve => setTimeout(resolve, 250));
                assert.equal((await chrome.bookmarks.get(bookmarks.A.id))[0].parentId, fixture.folder.id,
                    'Move feedback guard must clear on native failure');
                assert.equal((await chrome.bookmarks.get(bookmarks.A.id))[0].index, 0,
                    `Genuine drag to start must import: ${JSON.stringify({
                        children: (await chrome.bookmarks.getChildren(fixture.folder.id)).map(node => ({ id: node.id, title: node.title })),
                        native: (await chrome.tabs.query({ windowId })).map(tab => ({ id: tab.id, groupId: tab.groupId }))
                    })}`);
                console.log('PASS failed native move releases feedback guard');
                continue;
            }
            const after = await session(windowId);
            const names = new Map(Object.entries(bookmarks).map(([name, bookmark]) => [bookmark.id, name]));
            assert.deepEqual(after.logicalTabs.map(tab => names.get(tab.bookmarkId)),
                [...(windowId === 8 ? 'DCSAB' : windowId === 9 ? 'CSBAD' : 'CSABD')], 'Settled bookmark order');
            const native = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
            const expectedNative = [5, 7].includes(windowId) ? 'CAD' : windowId === 6 ? 'ABD' :
                windowId === 8 ? 'DCAB' : windowId === 9 ? 'CBAD' : 'CABD';
            assert.deepEqual(native.map(tab => tab.id), [...expectedNative].map(name => live[name].id), 'Native order');
            const groupId = (await chrome.tabs.get(live.A.id)).groupId;
            assert.notEqual(groupId, -1);
            if (![5, 7].includes(windowId)) assert.equal((await chrome.tabs.get(live.B.id)).groupId, groupId, 'Both moved tabs must retain the destination group');
            assert.equal(browser.groups.get(groupId).title, 'Saved destination');
            assert.equal(browser.groups.get(groupId).color, 'blue');
            for (const name of 'SAB') {
                const tab = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks[name].id);
                assert.equal(tab.groupId, destination.id, `Settled logical group ${name}`);
                assert.equal((await chrome.bookmarks.get(bookmarks[name].id))[0].parentId, destination.id);
            }
            const active = after.logicalTabs.find(tab => tab.bookmarkId === bookmarks.A.id);
            assert.equal(after.lastActiveLogicalTabId, active.logicalId);
            if ([5, 6, 7].includes(windowId)) {
                const closed = windowId === 6 ? 'C' : 'B';
                assert.deepEqual(after.logicalTabs.find(tab => tab.bookmarkId === bookmarks[closed].id).liveTabIds, [],
                    'Closed tab keeps its bookmark and loses only its live identity');
            }
            if (windowId === 4) {
                // A real drag immediately after delayed feedback must remain
                // effective; a blanket grace timer would silently discard it.
                await chrome.tabs.move(live.B.id, { index: 3 });
                await new Promise(resolve => setTimeout(resolve, 250));
                assert.equal((await chrome.bookmarks.get(bookmarks.B.id))[0].parentId, fixture.folder.id);
                const nativeIds = (await chrome.tabs.query({ windowId })).map(tab => tab.id);
                assert.deepEqual(nativeIds, [...'CADB'].map(name => live[name].id));
                // A stale group payload must not recreate its already-removed
                // native group, but its independent title update still applies.
                await listeners['tabs.onUpdated'](live.B.id, { groupId, title: 'Updated B' },
                    { ...(await chrome.tabs.get(live.B.id)), groupId });
                const updated = (await session(windowId)).logicalTabs.find(tab => tab.bookmarkId === bookmarks.B.id);
                assert.equal(updated.title, 'Updated B');
                assert.equal(updated.groupId, null);
            }
            console.log(`PASS feedback scenario ${windowId}`);
        } catch (error) { failures.push(`window ${windowId}: ${error.message}`); }
    }
    // A failed final ungroup must be observable, with its affected IDs, even
    // though MOVE_LOGICAL_TABS retains its existing best-effort response contract.
    const fixture = fixtures[0];
    const before = await session(fixture.windowId);
    const byBookmark = new Map(before.logicalTabs.map(tab => [tab.bookmarkId, tab]));
    const ungroup = chrome.tabs.ungroup;
    const warn = console.warn;
    const warnings = [];
    const failure = new Error('Injected native ungroup failure');
    try {
        chrome.tabs.ungroup = async () => { throw failure; };
        console.warn = (...args) => { warnings.push(args); warn(...args); };
        await send({ type: 'MOVE_LOGICAL_TABS', windowId: fixture.windowId,
            logicalIds: [...'AB'].map(name => byBookmark.get(fixture.bookmarks[name].id).logicalId),
            targetLogicalId: byBookmark.get(fixture.bookmarks.D.id).logicalId, position: 'before' });
        assert.ok(warnings.some(args => args.includes(failure) && args.some(value =>
            Array.isArray(value) && value.includes(fixture.live.A.id) && value.includes(fixture.live.B.id))),
            'Ungroup failure must report the error and affected native IDs');
        console.log('PASS native ungroup failure diagnostic');
    } catch (error) {
        failures.push(`ungroup diagnostic: ${error.message}`);
    } finally {
        chrome.tabs.ungroup = ungroup;
        console.warn = warn;
    }
    assert.deepEqual(failures, [], 'Native group feedback regressions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
