// PR31's long-name/background-tab intent and PR28's restore/ambiguity intent,
// originally by google-labs-jules[bot], refined by Stephen L. (see verification doc).
// These checks use actual background listeners, immutable native snapshots, and
// stable bookmark/native identities rather than passing on create-call counts.
const assert = require('node:assert/strict');
const { GroupLifecycleFixture: Fixture } = require('./group_lifecycle_fixture.js');

async function main() {
    const f = await new Fixture().prepare();
    const failures = [];
    async function check(name, run) {
        if (process.argv[2] && !name.includes(process.argv[2])) return;
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures.push(`${name}: ${error.stack}`); }
        finally { f.hooks = {}; }
    }
    const longName = 'Amazon.fr : livres, DVD, jeux vidéo, musique, high-tech, informatique, jouets, vêtements, chaussures, sport, bricolage, maison, beauté, puériculture, épicerie et plus encore !';
    const startupFolder = await f.folder(1, `${longName} [cyan]`, ['https://example.test/history']);
    const startupGroup = f.addGroup(1, longName, 'cyan');
    const startupTab = f.addTab(1, startupGroup.id);
    // More existing groups must not introduce sequential one-second debounces.
    for (let i = 2; i <= 4; i++) f.addTab(1, f.addGroup(1, `Other ${i}`).id);
    const started = Date.now();
    await f.start(() => f.listeners['tabs.onMoved'](startupTab.id, { windowId: 1, fromIndex: 0, toIndex: 0 }));
    await check('startup reuses unique metadata despite different contents without serial debounce', async () => {
        assert.equal((await f.logical(startupTab)).groupId, startupFolder.id);
        assert.ok(Date.now() - started < 2000, 'Existing-group startup must not wait 1s per group');
        assert.equal((await f.folders(1)).length, 4);
    });

    await check('concurrent native group and grouped tab creation produces one stable folder', async () => {
        const group = f.addGroup(2);
        const a = f.addTab(2, group.id), b = f.addTab(2, group.id);
        await Promise.all([f.listeners['tabGroups.onCreated'](group),
            f.listeners['tabs.onCreated'](structuredClone(a)), f.listeners['tabs.onCreated'](structuredClone(b))]);
        const folders = await f.folders(2);
        assert.equal(folders.length, 1);
        assert.equal((await f.logical(a)).groupId, folders[0].id);
        assert.equal((await f.logical(b)).groupId, folders[0].id);
        assert.equal((await chrome.bookmarks.getChildren(folders[0].id)).length, 2);
    });

    await check('pending resolution survives held async create through repeated events', async () => {
        const group = f.addGroup(3);
        const tab = f.addTab(3, group.id);
        const entered = Fixture.gate(), release = Fixture.gate();
        f.hooks.create = async data => {
            if (!data.url && data.parentId === f.sessions.get(3)) { entered.release(); await release.promise; }
        };
        const first = f.listeners['tabGroups.onCreated'](group);
        await entered.promise;
        const queries = f.calls.group;
        const second = f.listeners['tabGroups.onCreated'](group);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const shared = f.calls.group === queries;
        release.release();
        await Promise.all([first, second]);
        await f.listeners['tabs.onCreated'](structuredClone(tab));
        assert.equal((await f.folders(3)).length, 1);
        assert.equal((await f.logical(tab)).groupId, (await f.folders(3))[0].id);
        assert.ok(shared, 'Second caller must share the pending work, not start a new lookup');
    });

    for (const [windowId, title, urls, groupName, color] of [
        [4, `${longName} [blue]`, ['https://example.test/old-a', 'https://example.test/old-b'], longName, 'blue'],
        [5, 'Saved group [blue]', [], 'Saved group', 'blue'],
        [6, 'Saved group', ['https://example.test/old'], 'Saved group', 'grey']
    ]) await check(`unique unmapped reuse preserves history, identity and order (${windowId})`, async () => {
        await f.folder(windowId, 'Before [red]');
        const saved = await f.folder(windowId, title, urls);
        const original = await chrome.bookmarks.getChildren(saved.id);
        await f.folder(windowId, 'After [red]');
        const before = (await f.folders(windowId)).map(node => node.id);
        const group = f.addGroup(windowId, groupName, color);
        const tab = await f.createTab(windowId, group.id);
        assert.equal((await f.logical(tab)).groupId, saved.id);
        assert.deepEqual((await f.folders(windowId)).map(node => node.id), before);
        assert.deepEqual((await chrome.bookmarks.getChildren(saved.id)).slice(0, original.length), original);
        assert.equal((await chrome.bookmarks.get(saved.id))[0].title, title);
    });

    await check('mapped and concurrent same-name groups keep distinct identities', async () => {
        const saved = await f.folder(7);
        const first = f.addGroup(7), second = f.addGroup(7);
        const a = f.addTab(7, first.id), b = f.addTab(7, second.id);
        await Promise.all([f.listeners['tabs.onCreated'](structuredClone(a)), f.listeners['tabs.onCreated'](structuredClone(b))]);
        assert.equal((await f.folders(7)).length, 2);
        const parents = [(await f.logical(a)).groupId, (await f.logical(b)).groupId];
        assert.ok(parents.includes(saved.id));
        assert.notEqual(parents[0], parents[1]);
    });

    await check('multiple unmapped candidates create new folder without altering either history', async () => {
        const a = await f.folder(8, undefined, ['https://example.test/saved-a']);
        const b = await f.folder(8, undefined, ['https://example.test/saved-b']);
        const originals = await Promise.all([a, b].map(folder => chrome.bookmarks.getSubTree(folder.id)));
        const group = f.addGroup(8), tab = await f.createTab(8, group.id);
        const parent = (await f.logical(tab)).groupId;
        assert.ok(parent !== a.id && parent !== b.id);
        assert.equal((await f.folders(8)).length, 3);
        for (const [i, folder] of [a, b].entries()) {
            const [after] = await chrome.bookmarks.getSubTree(folder.id);
            // Insertion before a folder legitimately shifts its root index.
            assert.deepEqual({ ...after, index: 0 }, { ...originals[i][0], index: 0 });
        }
        assert.deepEqual((await f.folders(8)).filter(folder => [a.id, b.id].includes(folder.id)).map(folder => folder.id), [a.id, b.id]);
    });

    await check('different color is not a match; known binding does no metadata/native group search', async () => {
        const saved = await f.folder(9, 'Saved group [red]');
        const group = f.addGroup(9), first = await f.createTab(9, group.id);
        const parent = (await f.logical(first)).groupId;
        assert.notEqual(parent, saved.id);
        f.hooks.getChildren = id => {
            if (id === f.sessions.get(9)) throw new Error('Known mapping searched root metadata');
        };
        f.hooks.group = () => { throw new Error('Known mapping fetched group metadata'); };
        const second = await f.createTab(9, group.id);
        assert.equal((await f.logical(second)).groupId, parent);
        assert.deepEqual((await chrome.bookmarks.getChildren(parent)).map(node => node.id),
            [(await f.logical(first)).bookmarkId, (await f.logical(second)).bookmarkId]);
    });

    await check('failed resolution releases lock and later retry resolves', async () => {
        const group = f.addGroup(10);
        f.hooks.create = data => { if (!data.url) throw new Error('Injected folder creation failure'); };
        await f.listeners['tabGroups.onCreated'](group);
        f.hooks = {};
        const tab = await f.createTab(10, group.id);
        assert.equal((await f.folders(10)).length, 1);
        assert.equal((await f.logical(tab)).groupId, (await f.folders(10))[0].id);
    });

    await check('group disappears while queued browser read is held: no orphan folder', async () => {
        const group = f.addGroup(11);
        f.addTab(11, group.id);
        const entered = Fixture.gate(), release = Fixture.gate();
        f.hooks.query = async query => {
            if (query.windowId === 11) { entered.release(); await release.promise; }
        };
        const resolving = f.listeners['tabGroups.onCreated'](group);
        await entered.promise;
        f.groups.delete(group.id);
        for (const tab of f.tabs.values()) if (tab.groupId === group.id) tab.groupId = -1;
        release.release();
        await resolving;
        assert.equal((await f.folders(11)).length, 0);
    });

    await check('updates and quick close during rename debounce retain history without dead live IDs', async () => {
        const group = f.addGroup(12);
        const tab = f.addTab(12, group.id, { url: '', pendingUrl: 'https://example.test/pending' });
        const creating = f.listeners['tabs.onCreated'](structuredClone(tab));
        const logical = await Fixture.until(() => f.logical(tab), 'new tab mapped before rename debounce', 750);
        assert.equal(logical.url, tab.pendingUrl, 'pending URL must be saved, not about:blank');
        Object.assign(tab, { url: 'https://example.test/final', title: 'Final title' });
        await f.listeners['tabs.onUpdated'](tab.id, { url: tab.url, title: tab.title }, structuredClone(tab));
        await f.close(tab.id);
        await creating;
        await new Promise(resolve => setTimeout(resolve, 2100));
        const saved = (await f.session(12)).logicalTabs.find(t => t.bookmarkId === logical.bookmarkId);
        assert.deepEqual(saved.liveTabIds, []);
        const [node] = await chrome.bookmarks.get(saved.bookmarkId);
        assert.equal(node.url, tab.url);
        assert.equal(node.title, tab.title);
        assert.equal((await f.folders(12)).length, 0);
    });

    await check('tab closes during bookmark reload without attaching a dead identity', async () => {
        const tab = f.addTab(13, -1);
        f.hooks.getSubTree = async id => {
            if (id === f.sessions.get(13)) {
                delete f.hooks.getSubTree;
                await f.close(tab.id);
            }
        };
        await f.listeners['tabs.onCreated'](structuredClone(tab));
        const logical = (await f.session(13)).logicalTabs.find(t => t.url === tab.url);
        assert.ok(logical, 'Quickly closed creation must keep its bookmark history');
        assert.deepEqual(logical.liveTabIds, []);
    });

    await check('latest URL/title during initial reload are retained before group resolution', async () => {
        const group = f.addGroup(14), tab = f.addTab(14, group.id);
        f.hooks.getSubTree = async id => {
            if (id !== f.sessions.get(14)) return;
            delete f.hooks.getSubTree;
            Object.assign(tab, { url: 'https://example.test/latest', title: 'Latest title' });
            await f.listeners['tabs.onUpdated'](tab.id, { url: tab.url, title: tab.title }, structuredClone(tab));
        };
        await f.listeners['tabs.onCreated'](structuredClone(tab));
        await new Promise(resolve => setTimeout(resolve, 2100));
        const logical = await f.logical(tab);
        assert.equal(logical.url, tab.url);
        assert.equal(logical.title, tab.title);
        assert.equal((await chrome.bookmarks.get(logical.bookmarkId))[0].url, tab.url);
    });

    await check('group/window disappears during create: remove only the unbound empty new folder', async () => {
        const group = f.addGroup(15);
        f.addTab(15, group.id);
        f.hooks.create = async data => {
            if (data.parentId !== f.sessions.get(15) || data.url) return;
            f.groups.delete(group.id);
            await f.listeners['windows.onRemoved'](15);
        };
        await f.listeners['tabGroups.onCreated'](group);
        assert.equal((await f.folders(15)).length, 0);
    });

    await check('native group change during resolution cannot replay stale membership', async () => {
        const tab = await f.createTab(16);
        const group = f.addGroup(16);
        f.addTab(16, group.id); // A surviving peer keeps the group alive.
        tab.groupId = group.id;
        const grouped = f.listeners['tabs.onUpdated'](tab.id, { groupId: group.id }, structuredClone(tab));
        await new Promise(resolve => setTimeout(resolve, 100));
        tab.groupId = -1;
        await f.listeners['tabs.onUpdated'](tab.id, { groupId: -1, title: 'Ungrouped title' }, structuredClone(tab));
        await grouped;
        assert.equal((await f.logical(tab)).groupId, null);
        assert.equal((await chrome.bookmarks.get((await f.logical(tab)).bookmarkId))[0].parentId, f.sessions.get(16));
    });
    await check('concurrent known-group creation reloads identities during the native read', async () => {
        const group = f.addGroup(17);
        await f.listeners['tabGroups.onCreated'](group);
        const a = f.addTab(17, group.id, { active: true });
        let b;
        f.hooks.tab = async id => {
            if (id !== a.id) return;
            delete f.hooks.tab;
            b = await f.createTab(17, group.id);
        };
        await f.listeners['tabs.onCreated'](structuredClone(a));
        const logicalA = await f.logical(a), logicalB = await f.logical(b);
        assert.ok(logicalA && logicalB, 'Both native identities must survive concurrent reload');
        assert.equal(logicalA.groupId, logicalB.groupId);
        assert.equal((await f.session(17)).lastActiveLogicalTabId, logicalA.logicalId);
        assert.equal((await f.folders(17)).length, 1);
    });
    assert.deepEqual(failures, [], 'Group folder lifecycle regressions');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
