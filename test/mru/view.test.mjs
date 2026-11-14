import test from 'node:test';
import assert from 'node:assert/strict';
import { MruController } from '../../src/mru/view.js';

function fixture(currentBookmarkId = null) {
    assert.equal(typeof MruController, 'function', 'shared MRU controller must be implemented');
    const requests = [];
    const rows = ['a', 'b', 'c'].map(key => ({ key: `tab:${key}`, title: key }));
    const client = { request: async message => {
        requests.push(message);
        if (message.type === 'MRU_QUERY') return { items: rows, total: rows.length, context: { sourceWindowId: 1, sourceSessionId: 's', liveOnly: false, currentBookmarkId } };
        return { success: true };
    } };
    const controller = new MruController({ client, context: { sourceWindowId: 1, sourceSessionId: 's' }, onChange: () => {} });
    return { controller, requests, client, rows };
}

// Delay only the worker transport, keeping the actual controller/paging logic under test. Responses capture the requested query and offset before a newer request can change them.
class DelayedMruClient {
    constructor(count) {
        this.rows = Array.from({ length: count }, (_, index) => ({ key: `tab:${index}`, title: `Tab ${index}` }));
        this.delay = false; this.pending = []; this.requests = [];
    }

    request(message) {
        this.requests.push(message);
        if (message.type !== 'MRU_QUERY') return Promise.resolve({ success: true });
        const matches = message.query === 'only' ? this.rows.slice(0, 1) : this.rows;
        const result = { items: matches.slice(message.offset, message.offset + message.limit), total: matches.length };
        if (!this.delay) return Promise.resolve(result);
        return new Promise((resolve, reject) => this.pending.push({ message, resolve: () => resolve(result), reject }));
    }
}

test('keyboard highlight never activates until Enter and survives MRU refresh by identity', async () => {
    const { controller, requests, rows } = fixture();
    await controller.refresh(); assert.equal(controller.selectedKey, 'tab:a');
    await controller.keyDown('ArrowDown'); assert.equal(controller.selectedKey, 'tab:b');
    rows.reverse(); await controller.refresh(); assert.equal(controller.selectedKey, 'tab:b');
    assert.equal(requests.some(request => request.type === 'MRU_ACTIVATE'), false);
    await controller.keyDown('Enter');
    assert.equal(requests.at(-1).key, 'tab:b');
    assert.equal(requests.at(-1).sourceSessionId, 's');
});

test('current identity stays independent of a cursor initially targeting the older tab', async () => {
    const { controller, requests } = fixture('a');
    await controller.refresh();
    assert.equal(controller.currentKey, 'tab:a');
    assert.equal(controller.selectedKey, 'tab:b');
    await controller.keyDown('ArrowDown');
    assert.equal(controller.selectedKey, 'tab:c');
    assert.equal(controller.currentKey, 'tab:a');
    await controller.refresh();
    assert.equal(controller.selectedKey, 'tab:c');
    assert.equal(requests.some(request => request.type === 'MRU_ACTIVATE'), false);
});

test('a current-tab change resets the cursor but ordinary refresh keeps its identity', async () => {
    const { controller, client, rows } = fixture('a');
    await controller.refresh();
    await controller.keyDown('End');
    assert.equal(controller.selectedKey, 'tab:c');
    rows.splice(0, rows.length, ...['b', 'a', 'c'].map(key => ({ key: `tab:${key}` })));
    client.request = async () => ({ items: rows, total: rows.length, context: { sourceWindowId: 1, currentBookmarkId: 'b' } });
    await controller.refresh();
    assert.equal(controller.currentKey, 'tab:b');
    assert.equal(controller.selectedKey, 'tab:a');
});

test('only-current and filtered-current results keep navigable keyboard defaults', async () => {
    const { controller, rows } = fixture('a');
    rows.splice(1);
    await controller.refresh();
    assert.equal(controller.currentKey, 'tab:a');
    assert.equal(controller.selectedKey, 'tab:a');
    rows.splice(0, 1, { key: 'tab:b' });
    await controller.search('Beta');
    assert.equal(controller.currentKey, 'tab:a');
    assert.equal(controller.selectedKey, 'tab:b');
});

test('returning Home from older pages selects the first row rather than skipping current', async () => {
    const { controller, client, rows } = fixture('a');
    controller.pageSize = 2;
    client.request = async message => ({ items: rows.slice(message.offset, message.offset + message.limit), total: rows.length, context: { currentBookmarkId: 'a' } });
    await controller.refresh();
    await controller.keyDown('End');
    assert.equal(controller.offset, 2);
    await controller.keyDown('Home');
    assert.equal(controller.offset, 0);
    assert.equal(controller.selectedKey, 'tab:a');
});

test('current change on an older page returns to page one without stale page-selection effects', async () => {
    const client = new DelayedMruClient(5);
    const request = client.request.bind(client);
    let currentBookmarkId = '0';
    client.request = async message => ({ ...await request(message), context: { currentBookmarkId } });
    const controller = new MruController({ client, context: { currentBookmarkId: '0' } });
    controller.pageSize = 2;
    await controller.page(2);
    client.delay = true;
    const page = controller.page(4, true);
    currentBookmarkId = '1';
    client.pending[0].resolve();
    // Wait for the refresh continuation to request the new first page, without timing sleeps.
    for (let i = 0; i < 8 && client.pending.length < 2; i++) await Promise.resolve();
    assert.equal(client.pending.length, 2);
    assert.equal(client.pending[1].message.offset, 0);
    client.pending[1].resolve();
    await page;
    assert.equal(controller.currentKey, 'tab:1');
    assert.equal(controller.offset, 0);
    assert.equal(controller.selectedKey, 'tab:0');
});

// Both actions request offset zero, so a current change needs its own guard even when refresh does not issue a second query/generation.
for (const key of ['Home', 'ArrowUp']) {
    test(`current change during pending ${key} cannot override the reset cursor on page one`, async () => {
        const client = new DelayedMruClient(6);
        const request = client.request.bind(client);
        let currentBookmarkId = '0';
        client.request = async message => ({ ...await request(message), context: { currentBookmarkId } });
        const controller = new MruController({ client, context: { currentBookmarkId: '0' } });
        controller.pageSize = 3;
        await controller.page(3);
        assert.equal(controller.selectedKey, 'tab:3');
        client.rows = ['1', '0', '2', '3', '4', '5'].map(id => ({ key: `tab:${id}` }));
        client.delay = true;
        const navigation = controller.keyDown(key);
        assert.equal(client.pending[0].message.offset, 0);
        currentBookmarkId = '1';
        client.pending[0].resolve();
        await navigation;
        assert.equal(controller.currentKey, 'tab:1');
        assert.equal(controller.offset, 0);
        assert.equal(controller.selectedKey, 'tab:0', 'a real current change must retain the newly selected most-recent older target');
        await controller.keyDown('Enter');
        assert.equal(client.requests.at(-1).key, 'tab:0');
    });
}

test('Home/End/Tab/Shift+Tab and paging select deterministic result positions', async () => {
    const { controller } = fixture(); await controller.refresh();
    await controller.keyDown('End'); assert.equal(controller.selectedKey, 'tab:c');
    await controller.keyDown('Home'); assert.equal(controller.selectedKey, 'tab:a');
    await controller.keyDown('Tab'); assert.equal(controller.selectedKey, 'tab:b');
    await controller.keyDown('Tab', true); assert.equal(controller.selectedKey, 'tab:a');
    await controller.keyDown('PageDown'); assert.equal(controller.selectedKey, 'tab:c');
    await controller.keyDown('PageUp'); assert.equal(controller.selectedKey, 'tab:a');
});

test('an older query response cannot overwrite newer results or their selection', async () => {
    const { controller, client } = fixture();
    const pending = [];
    client.request = message => new Promise(resolve => pending.push({ message, resolve }));
    const old = controller.search('old'); const current = controller.search('new');
    pending[1].resolve({ items: [{ key: 'tab:new' }], total: 1 }); await current;
    pending[0].resolve({ items: [{ key: 'tab:old' }], total: 1 }); await old;
    assert.equal(controller.items[0].key, 'tab:new');
    assert.equal(controller.selectedKey, 'tab:new');
});

test('Live Only changes use shared worker state rather than a separate local filter', async () => {
    const { controller, requests } = fixture();
    await controller.setLiveOnly(true);
    assert.ok(requests.some(request => request.type === 'MRU_SET_LIVE_ONLY' && request.value === true && request.sourceWindowId === 1));
    assert.equal(requests.at(-1).type, 'MRU_QUERY');
});

test('a stale backward-page completion cannot select the last item of a newer query', async () => {
    const { controller, client } = fixture();
    const pending = [];
    client.request = message => new Promise(resolve => pending.push({ message, resolve }));
    const page = controller.page(0, true);
    const search = controller.search('new');
    pending[1].resolve({ items: [{ key: 'tab:new1' }, { key: 'tab:new2' }], total: 2 }); await search;
    assert.equal(controller.selectedKey, 'tab:new1');
    pending[0].resolve({ items: [{ key: 'tab:old1' }, { key: 'tab:old2' }], total: 2 }); await page;
    assert.equal(controller.selectedKey, 'tab:new1');
});

test('IME confirmation and navigation do not activate or move the MRU selection', async () => {
    const { controller, requests } = fixture(); await controller.refresh();
    await controller.keyDown('Enter', false, true);
    await controller.keyDown('ArrowDown', false, true);
    assert.equal(controller.selectedKey, 'tab:a');
    assert.equal(requests.some(request => request.type === 'MRU_ACTIVATE'), false);
});

test('previous/next selection crosses pages and wraps the full matching result set', async () => {
    const { controller, client, requests } = fixture();
    const rows = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key: `tab:${key}`, title: key }));
    controller.pageSize = 2;
    client.request = async message => {
        requests.push(message);
        return { items: rows.slice(message.offset, message.offset + message.limit), total: rows.length };
    };
    await controller.search('matching tabs');
    const selected = [controller.selectedKey];
    for (const direction of [1, 1, 1, 1, 1, -1, -1, -1, -1, -1]) {
        await controller.advanceSelection(direction);
        selected.push(controller.selectedKey);
    }
    assert.deepEqual(selected, ['tab:a', 'tab:b', 'tab:c', 'tab:d', 'tab:e', 'tab:a', 'tab:e', 'tab:d', 'tab:c', 'tab:b', 'tab:a']);
    assert.equal(requests.some(message => message.type === 'MRU_ACTIVATE'), false);
    assert.ok(requests.every(message => message.query === 'matching tabs'));
});

test('previous/next selection is inert for empty matches and stable for one match', async () => {
    const { controller, rows, requests } = fixture();
    rows.splice(0);
    await controller.refresh();
    await controller.advanceSelection(-1);
    await controller.advanceSelection(1);
    assert.equal(controller.selectedKey, null);
    rows.push({ key: 'tab:only', title: 'Only match' });
    await controller.refresh();
    await controller.advanceSelection(-1);
    await controller.advanceSelection(1);
    assert.equal(controller.selectedKey, 'tab:only');
    assert.equal(requests.some(message => message.type === 'MRU_ACTIVATE'), false);
});

test('Previous during a narrowing query cannot supersede its first page with stale offsets', async () => {
    const client = new DelayedMruClient(60);
    const controller = new MruController({ client, context: { sourceWindowId: 1 } });
    await controller.refresh();
    client.delay = true;
    const search = controller.search('only');
    const navigation = controller.advanceSelection(-1);
    assert.equal(client.pending.length, 1, 'pending search must not issue stale page navigation');
    assert.equal(client.pending[0].message.offset, 0);
    client.pending[0].resolve();
    await Promise.all([search, navigation]);
    assert.equal(controller.total, 1);
    assert.equal(controller.offset, 0);
    assert.deepEqual(controller.items.map(item => item.key), ['tab:0']);
    assert.equal(controller.selectedKey, 'tab:0');
});

test('rapid Previous/Next on a short last page never indexes rows from a pending page', async () => {
    const client = new DelayedMruClient(5);
    const controller = new MruController({ client, context: { sourceWindowId: 1 } });
    controller.pageSize = 2;
    await controller.page(4);
    assert.equal(controller.selectedKey, 'tab:4');
    client.delay = true;
    const previous = controller.advanceSelection(-1);
    const next = controller.advanceSelection(1);
    const anotherNext = controller.advanceSelection(1);
    await assert.doesNotReject(Promise.all([next, anotherNext]));
    assert.equal(client.pending.length, 1);
    assert.equal(client.pending[0].message.offset, 2);
    client.pending[0].resolve();
    await previous;
    assert.equal(controller.offset, 2);
    assert.deepEqual(controller.items.map(item => item.key), ['tab:2', 'tab:3']);
    assert.equal(controller.selectedKey, 'tab:3');
});

test('a stale query completion cannot unlock navigation while the latest query is pending', async () => {
    const client = new DelayedMruClient(60);
    const controller = new MruController({ client, context: { sourceWindowId: 1 } });
    await controller.refresh();
    client.delay = true;
    const old = controller.search('old');
    const current = controller.search('only');
    client.pending[0].resolve();
    await old;
    const navigation = controller.advanceSelection(-1);
    assert.equal(client.pending.length, 2, 'stale completion must not unlock current query navigation');
    client.pending[1].resolve();
    await Promise.all([current, navigation]);
    assert.equal(controller.selectedKey, 'tab:0');
    assert.equal(controller.total, 1);
});

test('failed queries cannot navigate stale rows and a successful retry restores navigation', async () => {
    const client = new DelayedMruClient(60);
    const controller = new MruController({ client, context: { sourceWindowId: 1 } });
    await controller.refresh();
    client.delay = true;
    const search = controller.search('only');
    client.pending[0].reject(new Error('Worker unavailable'));
    await search;
    assert.equal(controller.error, 'Worker unavailable');
    const navigation = controller.advanceSelection(-1);
    assert.equal(client.pending.length, 1, 'failed query must not page its stale result set');
    await navigation;
    client.delay = false;
    await controller.search('');
    await controller.advanceSelection(1);
    assert.equal(controller.selectedKey, 'tab:1');
    assert.equal(controller.error, '');
});

test('paging buttons and positional keys cannot navigate old rows during a query load', async () => {
    const client = new DelayedMruClient(60);
    const controller = new MruController({ client, context: { sourceWindowId: 1 } });
    await controller.page(50);
    client.delay = true;
    const search = controller.search('only');
    const navigation = [controller.page(50), controller.page(0, true)];
    for (const key of ['Home', 'End', 'PageUp', 'PageDown']) navigation.push(controller.keyDown(key));
    assert.equal(client.pending.length, 1, 'all navigation paths must leave the pending first-page query intact');
    assert.equal(controller.selectedKey, null);
    client.pending[0].resolve();
    await Promise.all([search, ...navigation]);
    assert.equal(controller.selectedKey, 'tab:0');
    assert.equal(controller.offset, 0);
    assert.equal(controller.total, 1);
});
