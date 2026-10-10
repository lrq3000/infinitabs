// Inherited classifier regression: the real MOVE_LOGICAL_TABS handler reparents
// A/B logically before native synchronization. Closing the last native member C
// must not let that group's removal flatten saved G(S,C,A,B).
const assert = require('node:assert/strict');
const { GroupLifecycleFixture: Fixture } = require('./group_lifecycle_fixture.js');

async function main() {
    const f = await new Fixture().prepare(10);
    const fixtures = [];
    for (let windowId = 1; windowId <= 10; windowId++) {
        const group = f.addGroup(windowId), bookmarks = {}, live = {};
        let folder;
        for (const name of 'ABSCD') {
            if (name === 'S') folder = await f.folder(windowId);
            if (name === 'S' && windowId === 5) continue; // Empty LiveOnly preservation.
            const url = `https://example.test/removal/${windowId}/${name}`;
            bookmarks[name] = await chrome.bookmarks.create({ parentId: 'SC'.includes(name) ? folder.id : f.sessions.get(windowId), title: name, url });
            if (name !== 'S') live[name] = f.addTab(windowId, name === 'C' ? group.id : -1, { title: name, url, active: name === 'A' });
        }
        fixtures.push({ windowId, group, folder, bookmarks, live });
    }
    await f.start();
    // Native movement/grouping model for this specific interleaving. It calls the
    // actual registered listeners; it never imports/patches production state.
    let beforeMove;
    chrome.tabs.move = async (id, { index }) => {
        if (beforeMove) { const hook = beforeMove; beforeMove = null; await hook(); }
        const tab = f.tabs.get(id);
        const ordered = [...f.tabs.values()].filter(t => t.windowId === tab.windowId).sort((a, b) => a.index - b.index);
        ordered.splice(ordered.indexOf(tab), 1);
        ordered.splice(index, 0, tab);
        ordered.forEach((item, i) => { item.index = i; });
        await f.listeners['tabs.onMoved'](id, { windowId: tab.windowId, toIndex: index });
        return structuredClone(tab);
    };
    chrome.tabs.group = async ({ tabIds, groupId }) => {
        const tabs = [].concat(tabIds).map(id => f.tabs.get(id));
        assert.ok(tabs.every(Boolean));
        if (groupId === undefined) {
            const group = f.addGroup(tabs[0].windowId, '', 'grey');
            groupId = group.id;
            await f.listeners['tabGroups.onCreated'](structuredClone(group));
        }
        assert.ok(f.groups.has(groupId), 'Grouping must not target a removed native group');
        for (const tab of tabs) {
            tab.groupId = groupId;
            await f.listeners['tabs.onUpdated'](tab.id, { groupId }, structuredClone(tab));
        }
        return groupId;
    };
    chrome.tabGroups.update = async (id, changes) => {
        Object.assign(f.groups.get(id), changes);
        await f.listeners['tabGroups.onUpdated'](structuredClone(f.groups.get(id)));
    };
    const failures = [];
    async function check(name, run) {
        if (process.argv[2] && !name.includes(process.argv[2])) return;
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures.push(`${name}: ${error.stack}`); }
        finally { f.hooks = {}; beforeMove = null; }
    }
    async function assertPreserved(fixture, childNames = 'SC', closed = 'C') {
        const { windowId, folder, bookmarks, live } = fixture;
        const session = await f.session(windowId);
        assert.ok(session.groups[folder.id], 'Original saved folder identity must survive');
        assert.equal((await chrome.bookmarks.get(folder.id))[0]?.title, 'Saved group [blue]');
        assert.deepEqual((await chrome.bookmarks.getChildren(folder.id)).map(node => node.id),
            [...childNames].map(name => bookmarks[name].id));
        for (const name of childNames) {
            const logical = session.logicalTabs.find(t => t.bookmarkId === bookmarks[name].id);
            assert.equal(logical.groupId, folder.id);
            assert.deepEqual(logical.liveTabIds, !live[name] || closed.includes(name) ? [] : [live[name].id]);
        }
        assert.ok((await f.logical(live.A)) && (await f.logical(live.B)) && (await f.logical(live.D)), 'Unrelated live mappings retained');
    }

    for (const index of [0, 5, 8]) await check(`closing last native C during logical move preserves G (${index === 0 ? 'immediate' : index === 5 ? 'held removal' : 'before native read'})`, async () => {
        const fixture = fixtures[index], { windowId, folder, group, live, bookmarks } = fixture;
        let removal;
        const entered = Fixture.gate(), release = Fixture.gate();
        const closeDuringMove = async () => {
            assert.equal((await f.logical(live.A)).groupId, folder.id, 'A is already logically in G');
            assert.equal((await chrome.tabs.get(live.A.id)).groupId, -1, 'A is not yet natively in G');
            if (index !== 5) await f.close(live.C.id);
            else {
                f.tabs.delete(live.C.id);
                f.groups.delete(group.id);
                await f.listeners['tabs.onRemoved'](live.C.id, { windowId, isWindowClosing: false });
                f.hooks.getChildren = async id => {
                    if (id === folder.id) { delete f.hooks.getChildren; entered.release(); await release.promise; }
                };
                removal = f.listeners['tabGroups.onRemoved'](structuredClone(group));
                await entered.promise;
            }
        };
        if (index === 8) {
            f.hooks.tab = async id => {
                if (![live.A.id, live.B.id].includes(id)) return;
                delete f.hooks.tab;
                await closeDuringMove();
            };
        } else beforeMove = closeDuringMove;
        const before = await f.session(windowId);
        const response = await f.send({ type: 'MOVE_LOGICAL_TABS', windowId,
            logicalIds: before.logicalTabs.filter(t => [bookmarks.A.id, bookmarks.B.id].includes(t.bookmarkId)).map(t => t.logicalId),
            targetLogicalId: folder.id, position: 'inside' });
        release.release();
        if (removal) await removal;
        assert.equal(response.success, true);
        await assertPreserved(fixture, 'SCAB');
        const nativeGroup = (await chrome.tabs.get(live.A.id)).groupId;
        assert.notEqual(nativeGroup, -1);
        assert.notEqual(nativeGroup, group.id);
        assert.equal((await chrome.tabs.get(live.B.id)).groupId, nativeGroup);
        assert.deepEqual([...(f.groups.values())].filter(g => g.windowId === windowId).map(g => [g.title, g.color]), [['Saved group', 'blue']]);
    });

    await check('normal Close preserves history even when group event precedes tab event', async () => {
        await f.close(fixtures[1].live.C.id, true);
        await assertPreserved(fixtures[1]);
    });
    await check('genuine native Ungroup flattens saved and live children', async () => {
        const fixture = fixtures[2], { windowId, group, folder, live, bookmarks } = fixture;
        f.groups.delete(group.id);
        live.C.groupId = -1;
        await f.listeners['tabGroups.onRemoved'](structuredClone(group));
        assert.equal((await chrome.bookmarks.get(folder.id)).length, 0);
        for (const name of 'SC') assert.equal((await chrome.bookmarks.get(bookmarks[name].id))[0].parentId, f.sessions.get(windowId));
        const logical = await f.logical(live.C);
        assert.equal(logical.groupId, null);
        assert.deepEqual(logical.liveTabIds, [live.C.id]);
    });
    for (const index of [3, 4]) await check(`LiveOnly deletion preserves ${index === 3 ? 'saved children' : 'empty folder'}`, async () => {
        const fixture = fixtures[index];
        const response = await f.send({ type: 'DELETE_MOUNTED_TABS_IN_GROUP', windowId: fixture.windowId, groupId: fixture.folder.id });
        assert.equal(response.success, true);
        await assertPreserved(fixture, index === 3 ? 'S' : '');
        assert.equal((await chrome.bookmarks.get(fixture.bookmarks.C.id)).length, 0);
        assert.equal(f.tabs.has(fixture.live.C.id), false);
    });
    await check('stale removal must not dissolve a still-alive mapped native group', async () => {
        const fixture = fixtures[6];
        await f.listeners['tabGroups.onRemoved'](structuredClone(fixture.group));
        await assertPreserved(fixture, 'SC', '');
        const tab = await f.createTab(fixture.windowId, fixture.group.id);
        assert.equal((await f.logical(tab)).groupId, fixture.folder.id, 'Primary live binding must still work');
    });
    await check('native transfer into another group is not Ungroup', async () => {
        const fixture = fixtures[7], other = f.addGroup(fixture.windowId, 'Other', 'red');
        f.groups.delete(fixture.group.id);
        fixture.live.C.groupId = other.id;
        await f.listeners['tabGroups.onRemoved'](structuredClone(fixture.group));
        await assertPreserved(fixture, 'SC', '');
    });
    await check('failed logical bookmark write releases the extended ownership scope', async () => {
        const fixture = fixtures[9], { windowId, folder, group, live } = fixture;
        const move = chrome.bookmarks.move;
        try {
            chrome.bookmarks.move = async () => { throw new Error('Injected logical write failure'); };
            const response = await f.send({ type: 'MOVE_LOGICAL_TABS', windowId,
                logicalIds: [(await f.logical(live.A)).logicalId], targetLogicalId: folder.id, position: 'inside' });
            assert.ok(response.error, 'Logical write failure must be observable');
        } finally { chrome.bookmarks.move = move; }
        live.A.groupId = group.id;
        await f.listeners['tabs.onUpdated'](live.A.id, { groupId: group.id }, structuredClone(live.A));
        assert.equal((await f.logical(live.A)).groupId, folder.id, 'Later genuine native grouping must be imported');
        assert.equal((await chrome.bookmarks.get(fixture.bookmarks.A.id))[0].parentId, folder.id);
    });
    assert.deepEqual(failures, [], 'Removal classifier regressions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
