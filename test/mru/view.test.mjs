import test from 'node:test';
import assert from 'node:assert/strict';
import { MruController } from '../../src/mru/view.js';

function fixture() {
    assert.equal(typeof MruController, 'function', 'shared MRU controller must be implemented');
    const requests = [];
    const rows = ['a', 'b', 'c'].map(key => ({ key: `tab:${key}`, title: key }));
    const client = { request: async message => {
        requests.push(message);
        if (message.type === 'MRU_QUERY') return { items: rows, total: 3, context: { sourceWindowId: 1, sourceSessionId: 's', liveOnly: false } };
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
