import test from 'node:test';
import assert from 'node:assert/strict';
import { TabDisplaySettings } from '../src/ui/tab-display-settings.js';
import { TabRow } from '../src/ui/tab-row.js';

class DisplayStorage {
    constructor(value) {
        this.value = value;
        this.listeners = new Set();
        this.chrome = { storage: { local: { get: async () => ({ tabDisplayMode: this.value }) }, onChanged: {
            addListener: listener => this.listeners.add(listener), removeListener: listener => this.listeners.delete(listener)
        } } };
    }
    change(value, area = 'local') {
        this.value = value;
        for (const listener of this.listeners) listener({ tabDisplayMode: { newValue: value } }, area);
    }
}

test('display setting defaults to compact and rejects unsupported persisted modes', async () => {
    for (const value of [undefined, null, '', 'invalid', true]) {
        const storage = new DisplayStorage(value);
        const settings = new TabDisplaySettings({ chrome: storage.chrome });
        await settings.ready();
        assert.equal(settings.mode, 'compact');
        settings.dispose();
        assert.equal(storage.listeners.size, 0);
    }
});

test('one global preference propagates domain and full URL modes to every observer', async () => {
    const storage = new DisplayStorage('domain');
    const observed = [];
    const settings = new TabDisplaySettings({ chrome: storage.chrome, onChange: mode => observed.push(mode) });
    await settings.ready();
    assert.equal(settings.mode, 'domain');
    storage.change('url', 'sync');
    assert.equal(settings.mode, 'domain', 'unrelated storage areas must not change local preferences');
    storage.change('url');
    assert.equal(settings.mode, 'url');
    storage.change(undefined);
    assert.equal(settings.mode, 'compact');
    assert.deepEqual(observed, ['domain', 'url', 'compact']);
    settings.dispose();
});

test('a storage change arriving during initial read cannot be overwritten by the stale result', async () => {
    const storage = new DisplayStorage('compact');
    let resolve;
    storage.chrome.storage.local.get = () => new Promise(done => { resolve = done; });
    const settings = new TabDisplaySettings({ chrome: storage.chrome });
    const ready = settings.ready();
    storage.change('url');
    resolve({ tabDisplayMode: 'domain' });
    await ready;
    assert.equal(settings.mode, 'url');
    settings.dispose();
});

test('row descriptions offer domain and full URL without mounted-state labels', () => {
    for (const [url, mode, expected] of [
        ['https://example.test/a?b=c#d', 'compact', ''],
        ['https://example.test/a?b=c#d', 'domain', 'example.test'],
        ['https://example.test/a?b=c#d', 'url', 'https://example.test/a?b=c#d'],
        ['about:blank', 'domain', 'about:blank'],
        ['not a URL', 'domain', 'not a URL'],
        [undefined, 'url', '']
    ]) assert.equal(TabRow.description(url, mode), expected);
});

test('shared deletion confirmation honors opt-out and cancellation', async () => {
    let prompts = 0;
    const confirm = () => { prompts++; return false; };
    const chrome = { storage: { local: { get: async defaults => defaults } } };
    assert.equal(await TabRow.confirmDeletion(chrome, confirm), false);
    assert.equal(prompts, 1);
    chrome.storage.local.get = async () => ({ confirmDeleteLogicalTab: false });
    assert.equal(await TabRow.confirmDeletion(chrome, confirm), true);
    assert.equal(prompts, 1);
});
