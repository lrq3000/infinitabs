import test from 'node:test';
import assert from 'node:assert/strict';
import { MruChromeAdapter } from '../../src/mru/chrome-adapter.js';
import { BrowserFixture } from './browser-fixture.mjs';

async function fixture() {
    const browser = new BrowserFixture();
    const adapter = new MruChromeAdapter(browser.options()); await adapter.ready();
    return { browser, adapter };
}

async function snapshot(adapter) {
    await adapter.recoveryStore.configure(true);
    return adapter.recoveryStore.capture({ title: 'Recovered A', url: 'https://a.test', sourceSessionId: 'other', lastViewedAt: 1 });
}

test('public recovery settings opt in explicitly and do not recover earlier deletions', async () => {
    const { adapter } = await fixture();
    assert.equal((await adapter.handleMessage({ type: 'MRU_RECOVERY_STATUS' })).enabled, false);
    await adapter.recoveryStore.capture({ title: 'Before opt-in', url: 'https://old.test', lastViewedAt: 1 });
    await adapter.handleMessage({ type: 'MRU_RECOVERY_CONFIGURE', enabled: true });
    assert.deepEqual(await adapter.recoveryStore.list(), []);
    assert.equal((await adapter.handleMessage({ type: 'MRU_RECOVERY_STATUS' })).enabled, true);
});

test('recovery appends a fresh root bookmark without merging another same-URL logical tab', async () => {
    const { browser, adapter } = await fixture();
    const record = await snapshot(adapter);
    const before = structuredClone(browser.node('s').children);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: `deleted:${record.recoveryId}` });
    const children = browser.node('s').children;
    assert.deepEqual(children.slice(0, -1), before);
    assert.equal(children.at(-1).parentId, 's'); assert.equal(children.at(-1).title, 'Recovered A');
    assert.equal(children.filter(node => node.url === 'https://a.test').length, 2);
    assert.equal([...browser.tabs.values()].filter(tab => tab.url === 'https://a.test').length, 2);
    assert.deepEqual(await adapter.recoveryStore.list(), []);
});

test('a failed mount leaves a resumable identity; repeated/concurrent retry never duplicates it', async () => {
    const { browser, adapter } = await fixture();
    const record = await snapshot(adapter);
    const mount = adapter.focusOrMount;
    adapter.focusOrMount = async () => { throw new Error('temporary mount failure'); };
    const request = { sourceWindowId: 1, sourceSessionId: 's', key: `deleted:${record.recoveryId}` };
    await assert.rejects(adapter.activate(request), /temporary mount failure/);
    const [pending] = await adapter.recoveryStore.list();
    assert.equal(pending.restoredBookmarkId, browser.node('s').children.at(-1).id);
    adapter.focusOrMount = mount;
    await Promise.all([adapter.activate(request), adapter.activate(request)]);
    assert.equal(browser.node('s').children.filter(node => node.title === 'Recovered A').length, 1);
    assert.deepEqual(await adapter.recoveryStore.list(), []);
});

test('disabled recovery clears existing snapshots and rejects replay', async () => {
    const { browser, adapter } = await fixture();
    const record = await snapshot(adapter);
    await adapter.handleMessage({ type: 'MRU_RECOVERY_CONFIGURE', enabled: false });
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: `deleted:${record.recoveryId}` }), /recovery|available/i);
    assert.equal(JSON.stringify(browser.chrome.storage.local.values).includes('Recovered A'), false);
});

test('a session change during asynchronous selection cannot create a restored bookmark', async () => {
    const { browser, adapter } = await fixture();
    const record = await snapshot(adapter);
    const get = browser.chrome.bookmarks.getSubTree;
    browser.chrome.bookmarks.getSubTree = async id => {
        const result = await get(id); browser.state.windowToSession[1] = 'other'; return result;
    };
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: `deleted:${record.recoveryId}` }), /session/i);
    assert.equal(browser.node('s').children.length, 2);
});

test('cold-worker deletion still recovers viewed metadata carried by the removal event', async () => {
    const { browser, adapter } = await fixture();
    await adapter.recoveryStore.configure(true); await adapter.observeCurrent(1);
    const node = structuredClone(browser.node('s'));
    browser.root.children = browser.root.children.filter(folder => folder.id !== 's');
    const cold = new MruChromeAdapter(browser.options());
    await cold.onBookmarksRemoved('s', { parentId: 'root', node });
    const entries = await cold.recoveryStore.list();
    assert.equal(entries.length, 1); assert.equal(entries[0].url, 'https://a.test'); assert.equal(entries[0].sourceSessionId, 's');
    assert.deepEqual(cold.recencyStore.entries(), []);
});

test('cold deletion of a leaf retains current-session recovery scope from its canonical parent', async () => {
    const { browser, adapter } = await fixture();
    await adapter.recoveryStore.configure(true); await adapter.observeCurrent(1);
    const node = structuredClone(browser.node('a'));
    browser.node('s').children = browser.node('s').children.filter(child => child.id !== 'a');
    const cold = new MruChromeAdapter(browser.options());
    await cold.onBookmarksRemoved('a', { parentId: 's', node });
    assert.equal((await cold.recoveryStore.list())[0].sourceSessionId, 's');
});

test('enabling recovery cannot authorize a deletion already waiting in its handler', async () => {
    const { browser, adapter } = await fixture();
    await adapter.observeCurrent(1);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    adapter.getRoot = async () => { await gate; return 'root'; };
    const node = structuredClone(browser.node('a'));
    browser.node('s').children = browser.node('s').children.filter(child => child.id !== 'a');
    const deletion = adapter.onBookmarksRemoved('a', { parentId: 's', node });
    await adapter.recoveryStore.configure(true);
    release(); await deletion;
    assert.deepEqual(await adapter.recoveryStore.list(), []);
    assert.equal(JSON.stringify(browser.chrome.storage.local.values).includes('https://a.test'), false);
});

test('opt-out and later opt-in invalidate a previously pending deletion consent', async () => {
    const { browser, adapter } = await fixture();
    await adapter.recoveryStore.configure(true); await adapter.observeCurrent(1);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    adapter.getRoot = async () => { await gate; return 'root'; };
    const node = structuredClone(browser.node('a'));
    browser.node('s').children = browser.node('s').children.filter(child => child.id !== 'a');
    const deletion = adapter.onBookmarksRemoved('a', { parentId: 's', node });
    await adapter.recoveryStore.configure(false); await adapter.recoveryStore.configure(true);
    release(); await deletion;
    assert.deepEqual(await adapter.recoveryStore.list(), []);
});

test('a lost post-create journal cannot produce another bookmark after worker restart', async () => {
    const { browser, adapter } = await fixture();
    const record = await snapshot(adapter);
    const set = browser.chrome.storage.local.set.bind(browser.chrome.storage.local);
    browser.chrome.storage.local.set = async values => {
        if (Object.values(values).some(value => value?.restoredBookmarkId)) throw new Error('journal unavailable');
        return set(values);
    };
    const request = { sourceWindowId: 1, sourceSessionId: 's', key: `deleted:${record.recoveryId}` };
    await assert.rejects(adapter.activate(request), /created.*status|uncertain/i);
    browser.chrome.storage.local.set = set;
    const cold = new MruChromeAdapter(browser.options()); await cold.ready();
    await assert.rejects(cold.activate(request), /uncertain|inspect/i);
    assert.equal(browser.node('s').children.filter(node => node.title === 'Recovered A').length, 1);
});
