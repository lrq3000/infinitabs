import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from './storage-fixture.mjs';
import { RecencyStore, RecoveryStore } from '../../src/mru/store.js';

test('A/B/A visits retain distinct bookmark identities in newest-first order', async () => {
    assert.equal(typeof RecencyStore, 'function', 'RecencyStore must be implemented');
    const storage = new MemoryStorage();
    const store = new RecencyStore({ storage, clock: () => 50 });
    await store.touch('a'); await store.touch('b'); await store.touch('a');
    assert.deepEqual(store.entries().map(x => x.bookmarkId), ['a', 'b']);
    const reloaded = new RecencyStore({ storage, clock: () => 50 });
    await reloaded.ready();
    assert.deepEqual(reloaded.entries().map(x => x.bookmarkId), ['a', 'b']);
    await reloaded.touch('b');
    assert.deepEqual(reloaded.entries().map(x => x.bookmarkId), ['b', 'a']);
});

test('forget removes queued visits and persistence without resurrecting records', async () => {
    assert.equal(typeof RecencyStore, 'function');
    const storage = new MemoryStorage();
    const store = new RecencyStore({ storage });
    await store.ready();
    await Promise.all([store.touch('a'), store.touch('a'), store.forget(['a'])]);
    assert.deepEqual(store.entries(), []);
    const reloaded = new RecencyStore({ storage }); await reloaded.ready();
    assert.deepEqual(reloaded.entries(), []);
});

test('a failed storage operation does not poison subsequent writes', async () => {
    assert.equal(typeof RecencyStore, 'function');
    const storage = new MemoryStorage();
    const store = new RecencyStore({ storage }); await store.ready();
    const set = storage.set.bind(storage); storage.set = async () => { throw new Error('quota'); };
    await assert.rejects(store.touch('a'), /quota/);
    storage.set = set; await store.touch('b');
    const reloaded = new RecencyStore({ storage }); await reloaded.ready();
    assert.deepEqual(reloaded.entries().map(x => x.bookmarkId), ['b']);
});

test('disabled recovery collects nothing, including after hydration', async () => {
    assert.equal(typeof RecoveryStore, 'function');
    const storage = new MemoryStorage();
    const store = new RecoveryStore({ storage });
    await store.capture({ title: 'Private deleted title', url: 'https://example.test/deleted', sourceSessionId: 's', lastViewedAt: 1 });
    assert.deepEqual(await store.list(), []);
    assert.equal(JSON.stringify(storage.values).includes('Private deleted title'), false);
});

test('recovery is bounded separately, expires at 30 days and clears on opt-out', async () => {
    assert.equal(typeof RecoveryStore, 'function');
    let now = 1000;
    const storage = new MemoryStorage();
    const store = new RecoveryStore({ storage, clock: () => now });
    await store.configure(true);
    for (let i = 0; i < 101; i++) await store.capture({ title: `Tab ${i}`, url: `https://example.test/${i}`, sourceSessionId: 's', lastViewedAt: i });
    const entries = await store.list();
    assert.equal(entries.length, 100);
    assert.equal(entries.some(x => x.title === 'Tab 0'), false);
    now += 30 * 86400000 + 1;
    assert.deepEqual(await store.list(), []);
    await store.capture({ title: 'Last title', url: 'https://example.test/last', sourceSessionId: 's', lastViewedAt: now });
    await store.configure(false);
    assert.deepEqual(await store.list(), []);
    assert.equal(JSON.stringify(storage.values).includes('Last title'), false);
});
