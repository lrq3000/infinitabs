// Spec-review regressions for real production listeners. API gates control the
// interleaving, not production state. Deferred-write completion is observed from
// bookmarks; a successful bookmark save alone never proves logical agreement.
const assert = require('node:assert/strict');
const { GroupLifecycleFixture: Fixture } = require('./group_lifecycle_fixture.js');

class MetadataFixture extends Fixture {
    async update(tab, changes) {
        Object.assign(tab, changes);
        await this.listeners['tabs.onUpdated'](tab.id, changes, structuredClone(tab));
    }

    async persisted(bookmarkId, expected) {
        await Fixture.until(async () => {
            const [node] = await chrome.bookmarks.get(bookmarkId);
            return node?.url === expected.url && node?.title === expected.title;
        }, `bookmark ${bookmarkId} saved ${expected.title}`);
    }

    async agreement(tab, bookmarkId) {
        const native = await chrome.tabs.get(tab.id);
        const logical = await this.logical(tab);
        const [saved] = await chrome.bookmarks.get(bookmarkId);
        assert.equal(logical.bookmarkId, bookmarkId);
        for (const field of ['url', 'title']) {
            assert.equal(logical[field], native[field], `Current logical ${field} must match native`);
            assert.equal(saved[field], native[field], `Persisted ${field} must match native`);
        }
        assert.equal(logical.lastSavedUrl, saved.url, 'Acknowledged URL must be the value actually written');
        assert.equal(logical.lastSavedTitle, saved.title, 'Acknowledged title must be the value actually written');
    }

    async rename(group, title, color = group.color) {
        Object.assign(group, { title, color });
        await this.listeners['tabGroups.onUpdated'](structuredClone(group));
    }
}

async function main() {
    const f = await new MetadataFixture().prepare(8);
    await f.start();
    const failures = [];
    async function check(name, run) {
        if (process.argv[2] && !name.includes(process.argv[2])) return;
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures.push(`${name}: ${error.stack}`); }
        finally { f.hooks = {}; }
    }

    await check('P1 older combined group/metadata event cannot replay after a newer navigation', async () => {
        const tab = await f.createTab(1), bookmarkId = (await f.logical(tab)).bookmarkId;
        const group = f.addGroup(1);
        const release = Fixture.gate();
        let entered = false;
        f.hooks.group = async () => { delete f.hooks.group; entered = true; await release.promise; };
        const older = f.update(tab, { groupId: group.id, url: 'https://example.test/older', title: 'Older' });
        try {
            await Fixture.until(() => entered, 'older event waiting on group resolution');
            await f.update(tab, { url: 'https://example.test/latest', title: 'Latest' });
            assert.equal((await f.logical(tab)).title, 'Latest', 'Newer event must have been consumed during the wait');
        } finally { release.release(); }
        await older;
        assert.equal((await f.logical(tab)).title, 'Latest', 'Older handler must not roll back the newer title');
        assert.equal((await f.logical(tab)).url, tab.url);
        await f.persisted(bookmarkId, tab);
        await f.agreement(tab, bookmarkId);
    });

    await check('P2 creation resolution reload retains pending URL/title before and after save', async () => {
        const group = f.addGroup(2), tab = f.addTab(2, group.id, { title: 'Initial' });
        const creating = f.listeners['tabs.onCreated'](structuredClone(tab));
        const logical = await Fixture.until(() => f.logical(tab), 'early attachment');
        await f.update(tab, { url: 'https://example.test/final', title: 'Final' });
        await creating;
        // Keep both observations: the old implementation eventually writes Final
        // but its current logical record still reads Initial after group reload.
        const beforeSave = await f.logical(tab);
        await f.persisted(logical.bookmarkId, tab);
        await f.agreement(tab, logical.bookmarkId);
        assert.equal(beforeSave.title, 'Final');
        assert.equal(beforeSave.url, tab.url);
    });

    await check('P3 rename during placement must reuse the unique final name/color candidate', async () => {
        const saved = await f.folder(3, 'Final name [blue]', ['https://example.test/original-history']);
        const originalChildren = await chrome.bookmarks.getChildren(saved.id);
        const group = f.addGroup(3, 'Initial name', 'red');
        f.hooks.query = async query => {
            if (query.windowId !== 3) return;
            delete f.hooks.query;
            await f.rename(group, 'Final name', 'blue');
        };
        const tab = await f.createTab(3, group.id);
        assert.equal((await f.logical(tab)).groupId, saved.id);
        assert.deepEqual((await f.folders(3)).map(folder => folder.id), [saved.id]);
        assert.deepEqual((await chrome.bookmarks.getChildren(saved.id)).slice(0, originalChildren.length), originalChildren);
        await f.rename(group, 'Later bound rename', 'pink');
        assert.equal((await chrome.bookmarks.get(saved.id))[0].title, 'Later bound rename [pink]');
        assert.equal((await f.logical(tab)).groupId, saved.id);
    });

    await check('ordinary URL-only and title-only updates keep primary metadata and saved values coherent', async () => {
        const tab = await f.createTab(4), bookmarkId = (await f.logical(tab)).bookmarkId;
        f.hooks.group = f.hooks.getChildren = () => { throw new Error('Ordinary metadata searched group folders'); };
        await f.update(tab, { url: 'https://example.test/url-only' });
        assert.equal((await f.logical(tab)).url, tab.url);
        await f.persisted(bookmarkId, tab);
        await f.agreement(tab, bookmarkId);
        await f.update(tab, { title: 'Title only' });
        assert.equal((await f.logical(tab)).title, tab.title);
        await f.persisted(bookmarkId, tab);
        await f.agreement(tab, bookmarkId);
    });

    await check('in-flight write plus reload and newer navigation cannot acknowledge or overwrite newer values', async () => {
        const group = f.addGroup(5), tab = await f.createTab(5, group.id);
        const bookmarkId = (await f.logical(tab)).bookmarkId;
        const release = Fixture.gate();
        let entered = false;
        f.hooks.update = async ({ id, data }) => {
            if (id === bookmarkId && data.title === 'In flight') { entered = true; await release.promise; }
        };
        // Observe the newer real debounce expiring while the old API stays held.
        // This controls scheduling, rather than sleeping until assertions pass.
        const setTimeout = global.setTimeout;
        let newerTimerFired = false;
        let duringReload;
        try {
            await f.update(tab, { url: 'https://example.test/in-flight', title: 'In flight' });
            await Fixture.until(() => entered, 'older native metadata write in flight');
            await f.rename(group, 'Reload during write');
            duringReload = await f.logical(tab);
            global.setTimeout = (callback, delay, ...args) => setTimeout(() => {
                if (delay === 2000) newerTimerFired = true;
                return callback(...args);
            }, delay);
            await f.update(tab, { url: 'https://example.test/newest', title: 'Newest' });
            await Fixture.until(() => newerTimerFired, 'newer debounce expired during the held older write');
        } finally { global.setTimeout = setTimeout; release.release(); }
        await f.persisted(bookmarkId, tab);
        await f.agreement(tab, bookmarkId);
        assert.equal(duringReload.title, 'In flight');
        assert.equal(duringReload.url, 'https://example.test/in-flight');
    });

    await check('reload whose bookmark snapshot predates a completed write cannot restore stale metadata', async () => {
        const group = f.addGroup(6), tab = await f.createTab(6, group.id);
        const bookmarkId = (await f.logical(tab)).bookmarkId;
        const release = Fixture.gate();
        let entered = false;
        f.hooks.aftergetSubTree = async ({ id }) => {
            if (id !== f.sessions.get(6)) return;
            delete f.hooks.aftergetSubTree;
            entered = true;
            await release.promise;
        };
        await f.update(tab, { url: 'https://example.test/saved-during-reload', title: 'Saved during reload' });
        const reloading = f.rename(group, 'Hold old subtree');
        try {
            await Fixture.until(() => entered, 'old bookmark tree snapshot captured');
            await f.persisted(bookmarkId, tab);
        } finally { release.release(); }
        await reloading;
        await f.agreement(tab, bookmarkId);
    });

    await check('a clean saved-only bookmark edit is still adopted by reload', async () => {
        const group = f.addGroup(7), tab = await f.createTab(7, group.id);
        const peer = await f.createTab(7, group.id);
        const bookmarkId = (await f.logical(tab)).bookmarkId;
        await f.close(tab.id);
        await chrome.bookmarks.update(bookmarkId, { url: 'https://example.test/external-edit', title: 'External saved edit' });
        await f.rename(group, 'Reload saved edit');
        const saved = (await f.session(7)).logicalTabs.find(logical => logical.bookmarkId === bookmarkId);
        assert.equal(saved.title, 'External saved edit');
        assert.equal(saved.url, 'https://example.test/external-edit');
        assert.deepEqual(saved.liveTabIds, []);
        await f.agreement(peer, (await f.logical(peer)).bookmarkId);
    });
    await check('navigation and its save wholly inside a held reload still supersede the old subtree', async () => {
        const group = f.addGroup(8), tab = await f.createTab(8, group.id);
        const bookmarkId = (await f.logical(tab)).bookmarkId;
        const release = Fixture.gate();
        let entered = false;
        f.hooks.aftergetSubTree = async ({ id }) => {
            if (id !== f.sessions.get(8)) return;
            delete f.hooks.aftergetSubTree;
            entered = true;
            await release.promise;
        };
        // No write is pending when reload begins, nor when its old tree returns.
        const reloading = f.rename(group, 'Read before navigation');
        try {
            await Fixture.until(() => entered, 'clean old subtree snapshot captured');
            await f.update(tab, { url: 'https://example.test/inside-read', title: 'Navigation inside read' });
            await f.persisted(bookmarkId, tab);
            await f.agreement(tab, bookmarkId);
        } finally { release.release(); }
        await reloading;
        await f.agreement(tab, bookmarkId);
    });
    assert.deepEqual(failures, [], 'Spec-review metadata interleavings');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
