import test from 'node:test';
import assert from 'node:assert/strict';
import { MruController } from '../../src/mru/view.js';

function fixture() {
    assert.equal(typeof MruController, 'function', 'shared MRU controller must be implemented');
    const requests = [];
    const rows = ['a', 'b', 'c'].map(key => ({ key: `tab:${key}`, title: key }));
    const client = { request: async message => {
        requests.push(message);
        if (message.type === 'MRU_QUERY') return { items: rows, total: rows.length, context: { sourceWindowId: 1, sourceSessionId: 's', liveOnly: false } };
        return { success: true };
    } };
    const controller = new MruController({ client, context: { sourceWindowId: 1, sourceSessionId: 's' }, onChange: () => {} });
    return { controller, requests, client, rows };
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
