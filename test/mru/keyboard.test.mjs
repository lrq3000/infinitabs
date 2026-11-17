import test from 'node:test';
import assert from 'node:assert/strict';
import { HotkeyRegistry } from '../../src/hotkeys/registry.js';
import { MruController } from '../../src/mru/view.js';
import { MemoryStorage } from './storage-fixture.mjs';

const { MruKeyboard } = await import('../../src/mru/keyboard.js').catch(() => ({}));
const event = (key, modifiers = {}) => ({ key, ...modifiers, getModifierState: () => false });

async function fixture(shortcut = 'Ctrl+Down', manual = false) {
    assert.equal(typeof MruKeyboard, 'function', 'implement the hold gesture handler');
    const registry = new HotkeyRegistry({ chrome: { storage: { local: new MemoryStorage() }, commands: { getAll: async () => [{ name: 'open-mru-switcher', shortcut }] } } });
    await registry.ready();
    const rows = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key: `tab:${key}` }));
    const activations = []; const pending = [];
    const client = { delay: false, request(message) {
        if (message.type === 'MRU_ACTIVATE') { activations.push(message.key); return Promise.resolve({ success: true }); }
        const result = { items: rows.slice(message.offset, message.offset + message.limit), total: rows.length };
        return this.delay ? new Promise(resolve => pending.push(() => resolve(result))) : Promise.resolve(result);
    } };
    const controller = new MruController({ client, context: { currentBookmarkId: 'a' } });
    let dismissed = 0;
    const gesture = { id: 'test-gesture', shortcut, sequence: 0 };
    const keyboard = new MruKeyboard({ registry, gesture: manual ? null : gesture, onDismiss: () => dismissed++ });
    const view = { controller, advanceSelection: direction => controller.advanceSelection(direction) };
    return { keyboard, controller, client, pending, activations, gesture, dismissed: () => dismissed, async mount() { await controller.refresh(); keyboard.attach(view); await keyboard.settled(); } };
}

test('startup repeat snapshots are deduplicated and early release commits the final selection once', async () => {
    const f = await fixture();
    const message = { type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 2 } };
    f.keyboard.command(message); f.keyboard.command(message);
    f.keyboard.keyUp(event('Control'));
    f.keyboard.keyUp(event('Control'));
    await f.mount();
    assert.deepEqual(f.activations, ['tab:d']);
});

test('held reverse navigation returns toward newer tabs without activating before release', async () => {
    const f = await fixture(); await f.mount();
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } });
    f.keyboard.keyDown(event('ArrowUp', { ctrlKey: true }));
    await f.keyboard.settled();
    assert.equal(f.controller.selectedKey, 'tab:b');
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('Control')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('queued repeat and release wait for a delayed page boundary instead of losing presses', async () => {
    const f = await fixture(); f.controller.pageSize = 2; await f.mount();
    f.client.delay = true;
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } });
    for (let i = 0; i < 20 && !f.pending.length; i++) await Promise.resolve();
    assert.equal(f.pending.length, 1);
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 2 } });
    f.keyboard.keyUp(event('Control'));
    assert.deepEqual(f.activations, []);
    f.pending.shift()(); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:d']);
});

test('Ctrl+Escape before attachment cancels pending release and cannot reactivate later', async () => {
    const f = await fixture();
    f.keyboard.keyUp(event('Control'));
    assert.equal(f.keyboard.keyDown(event('Escape', { ctrlKey: true })), true);
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } });
    await f.mount();
    assert.deepEqual(f.activations, []);
    assert.equal(f.dismissed(), 1);
});

test('blur cancels a pending page and release without activating after the page completes', async () => {
    const f = await fixture(); f.controller.pageSize = 2; await f.mount();
    f.client.delay = true;
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } });
    for (let i = 0; i < 20 && !f.pending.length; i++) await Promise.resolve();
    f.keyboard.keyUp(event('Control')); f.keyboard.blur();
    f.pending.shift()(); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    assert.equal(f.dismissed(), 1);
});

test('mouse-opened switchers ignore unrelated modifier releases but still support Enter', async () => {
    const f = await fixture('Ctrl+Down', true); await f.mount();
    f.keyboard.keyUp(event('Control')); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyDown(event('Enter')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('rebound opening chords derive their hold modifier without confirming on another release', async () => {
    const f = await fixture('Alt+Shift+Space'); await f.mount();
    f.keyboard.keyUp(event('Shift', { altKey: true })); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('Alt')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('native command DOM events do not advance a second time and pointer actions disarm release', async () => {
    const f = await fixture(); await f.mount();
    assert.equal(f.keyboard.keyDown(event('ArrowDown', { ctrlKey: true })), false);
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } }); await f.keyboard.settled();
    assert.equal(f.controller.selectedKey, 'tab:c');
    f.keyboard.disarm(); f.keyboard.keyUp(event('Control')); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
});
