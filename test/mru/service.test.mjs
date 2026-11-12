import test from 'node:test';
import assert from 'node:assert/strict';
import { RecencyStore, RecoveryStore } from '../../src/mru/store.js';
import { MemoryStorage } from './storage-fixture.mjs';
import { MruService } from '../../src/mru/service.js';

async function fixture() {
    assert.equal(typeof MruService, 'function', 'service must be implemented');
    const storage = new MemoryStorage();
    const recencyStore = new RecencyStore({ storage, clock: () => 20 });
    const recoveryStore = new RecoveryStore({ storage });
    const service = new MruService({ recencyStore, recoveryStore });
    service.setCatalog([
        { bookmarkId: 'a', sessionId: 's', title: 'Alpha', url: 'https://same.test', liveTabIds: [1] },
        { bookmarkId: 'b', sessionId: 's', title: 'Beta', url: 'https://same.test', liveTabIds: [] },
        { bookmarkId: 'c', sessionId: 'other', title: 'Gamma', url: 'https://other.test', liveTabIds: [3] }
    ]);
    for (const bookmarkId of ['a', 'b', 'c']) await service.observeView({ bookmarkId, isFocused: true });
    return { service, recencyStore, recoveryStore };
}

test('scope/live/current filters preserve distinct bookmark IDs even for duplicate URLs', async () => {
    const { service } = await fixture();
    const ids = async options => (await service.query({ sourceSessionId: 's', ...options })).items.map(x => x.bookmarkId);
    assert.deepEqual(await ids({}), ['b', 'a']);
    assert.deepEqual(await ids({ liveOnly: true }), ['a']);
    assert.deepEqual(await ids({ allSessions: true }), ['c', 'b', 'a']);
    assert.deepEqual(await ids({ excludeBookmarkId: 'b' }), ['a']);
});

test('background/private views and returning from the switcher do not promote a tab', async () => {
    const { service, recencyStore } = await fixture();
    await service.observeView({ bookmarkId: 'a', isFocused: false });
    await service.observeView({ bookmarkId: 'b', isFocused: true, isIncognito: true });
    const before = recencyStore.entries();
    await service.observeView({ bookmarkId: 'c', isFocused: true });
    assert.deepEqual(recencyStore.entries(), before);
    await service.observeView({ bookmarkId: 'a', isFocused: true });
    assert.deepEqual(recencyStore.entries().map(x => x.bookmarkId), ['a', 'c', 'b']);
});

test('catalog ownership changes, relevance and paging use current canonical metadata', async () => {
    const { service } = await fixture();
    service.setCatalog([
        { bookmarkId: 'a', sessionId: 'other', title: 'Tab', url: '', liveTabIds: [1] },
        { bookmarkId: 'b', sessionId: 's', title: 'Tables guide', url: '', liveTabIds: [] },
        { bookmarkId: 'c', sessionId: 's', title: 'A tab guide', url: '', liveTabIds: [3] }
    ]);
    const local = await service.query({ sourceSessionId: 's' });
    assert.deepEqual(local.items.map(x => x.bookmarkId), ['c', 'b']);
    const first = await service.query({ allSessions: true, query: 'tab', limit: 1 });
    assert.equal(first.total, 3); assert.equal(first.items[0].bookmarkId, 'a');
    const next = await service.query({ allSessions: true, query: 'tab', offset: 1, limit: 1 });
    assert.equal(next.items[0].bookmarkId, 'b');
});

test('deleted snapshots are separate, source-scoped, marked, and excluded by Live Only', async () => {
    const { service, recoveryStore } = await fixture();
    await recoveryStore.configure(true);
    await recoveryStore.capture({ title: 'Deleted', url: 'https://deleted.test', sourceSessionId: 's', lastViewedAt: 25 });
    const all = await service.query({ sourceSessionId: 's' });
    assert.equal(all.items[0].deleted, true);
    assert.equal((await service.query({ sourceSessionId: 's', liveOnly: true })).items.some(x => x.deleted), false);
    assert.equal((await service.query({ sourceSessionId: 'other' })).items.some(x => x.deleted), false);
});
