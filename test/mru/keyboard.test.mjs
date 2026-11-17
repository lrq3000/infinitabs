import test from 'node:test';
import assert from 'node:assert/strict';
import { HotkeyRegistry } from '../../src/hotkeys/registry.js';
import { MruController } from '../../src/mru/view.js';
import { MemoryStorage } from './storage-fixture.mjs';

const { MruKeyboard } = await import('../../src/mru/keyboard.js').catch(() => ({}));
const event = (key, modifiers = {}) => ({ key, ...modifiers, getModifierState: () => false });

async function fixture(shortcut = 'Ctrl+Down', manual = false, deferBindings = false) {
    assert.equal(typeof MruKeyboard, 'function', 'implement the hold gesture handler');
    const storage = new MemoryStorage();
    let finishBindings;
    if (deferBindings) storage.get = () => new Promise(resolve => { finishBindings = () => resolve({ 'hotkeys.v1.mru-cancel': 'Ctrl+Space' }); });
    const registry = new HotkeyRegistry({ chrome: { storage: { local: storage }, commands: { getAll: async () => [{ name: 'open-mru-switcher', shortcut }] } } });
    if (!deferBindings) await registry.ready();
    const rows = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key: `tab:${key}` }));
    const activations = []; const pending = [];
    const client = { delay: false, request(message) {
        if (message.type === 'MRU_ACTIVATE') { activations.push(message.key); return this.failActivation ? Promise.reject(new Error('Transient activation failure')) : Promise.resolve({ success: true }); }
        const result = { items: rows.slice(message.offset, message.offset + message.limit), total: rows.length };
        return this.delay ? new Promise(resolve => pending.push(() => resolve(result))) : Promise.resolve(result);
    } };
    const controller = new MruController({ client, context: { currentBookmarkId: 'a' } });
    let dismissed = 0;
    const gesture = { id: 'test-gesture', shortcut, sequence: 0 };
    const barrier = { call: async () => null };
    const keyboard = new MruKeyboard({ registry, gesture: manual ? null : gesture, barrier: id => barrier.call(id), onDismiss: () => dismissed++ });
    if (deferBindings) registry.ready();
    const view = { controller, advanceSelection: direction => controller.advanceSelection(direction) };
    return { keyboard, controller, client, pending, activations, gesture, barrier, finishBindings: () => finishBindings(), dismissed: () => dismissed, async mount() { await controller.refresh(); keyboard.attach(view); await keyboard.settled(); } };
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
    f.keyboard.keyUp(event('ArrowUp', { ctrlKey: true }));
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

test('an unrelated keyup cannot invent a missed opening-modifier release', async () => {
    const f = await fixture(); await f.mount();
    f.keyboard.keyDown(event('x'));
    f.keyboard.keyUp(event('x'));
    await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('ArrowDown'));
    await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyDown(event('Enter')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('release waits for the worker repeat barrier and applies its acknowledged sequence', async () => {
    const f = await fixture(); await f.mount();
    let acknowledge; let calls = 0;
    f.barrier.call = () => ++calls === 1 ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve({ gesture: { ...f.gesture, sequence: 1 } });
    f.keyboard.keyUp(event('Control'));
    for (let i = 0; i < 20 && !acknowledge; i++) await Promise.resolve();
    assert.deepEqual(f.activations, [], 'a received worker repeat must not be bypassed by release');
    assert.equal(typeof acknowledge, 'function');
    acknowledge({ gesture: { ...f.gesture, sequence: 1 } });
    await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:c']);
});

test('Escape stays effective while release is awaiting the worker barrier', async () => {
    const f = await fixture(); await f.mount();
    let acknowledge;
    f.barrier.call = () => new Promise(resolve => { acknowledge = resolve; });
    f.keyboard.keyUp(event('Control'));
    for (let i = 0; i < 20 && !acknowledge; i++) await Promise.resolve();
    assert.equal(typeof acknowledge, 'function');
    f.keyboard.keyDown(event('Escape', { ctrlKey: true }));
    acknowledge({ gesture: { ...f.gesture, sequence: 1 } });
    await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    assert.equal(f.dismissed(), 1);
});

test('saved custom cancellation during binding initialization wins over a later Ctrl release', async () => {
    const f = await fixture('Ctrl+Down', false, true);
    f.keyboard.keyDown(event(' ', { ctrlKey: true }));
    f.keyboard.keyUp(event('Control'));
    const mount = f.mount();
    f.finishBindings(); await mount;
    assert.deepEqual(f.activations, []);
    assert.equal(f.dismissed(), 1);
});

for (const refresh of [false, true]) test(`activation failure permits keyboard retry ${refresh ? 'after refresh' : 'without requiring refresh'}`, async () => {
    const f = await fixture(); await f.mount(); f.client.failActivation = true;
    f.keyboard.keyUp(event('Control')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
    f.client.failActivation = false;
    if (refresh) await f.controller.refresh();
    f.keyboard.keyDown(event('Enter')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b', 'tab:b']);
});

test('releasing Ctrl first waits until the observed arrow is released', async () => {
    const f = await fixture(); await f.mount();
    f.keyboard.keyDown(event('ArrowUp', { ctrlKey: true, code: 'ArrowUp' }));
    await f.keyboard.settled();
    f.keyboard.keyUp(event('Control', { code: 'ControlLeft' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('ArrowUp', { code: 'ArrowUp' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:a']);
});

test('repeated and shifted key events use physical identity without trapping a held gesture', async () => {
    const f = await fixture(); await f.mount();
    f.keyboard.keyDown(event('A', { ctrlKey: true, shiftKey: true, code: 'KeyQ' }));
    f.keyboard.keyDown(event('A', { ctrlKey: true, shiftKey: true, code: 'KeyQ', repeat: true }));
    f.keyboard.keyUp(event('Control', { code: 'ControlLeft', shiftKey: true })); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('a', { code: 'KeyQ' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

for (const disarm of [false, true]) test(`focus loss cancels ${disarm ? 'pointer-disarmed keyboard' : 'mouse-opened'} popups`, async () => {
    const f = await fixture('Ctrl+Down', !disarm); await f.mount();
    if (disarm) f.keyboard.disarm();
    f.keyboard.blur();
    f.keyboard.keyUp(event('Control')); await f.keyboard.settled();
    assert.equal(f.dismissed(), 1);
    assert.deepEqual(f.activations, []);
});

test('a command beginning in a manual popup preserves keys already observed held', async () => {
    const f = await fixture('Ctrl+Down', true); await f.mount();
    f.keyboard.keyDown(event('Control', { code: 'ControlLeft', ctrlKey: true }));
    f.keyboard.keyDown(event('ArrowDown', { code: 'ArrowDown', ctrlKey: true }));
    f.keyboard.command({ type: 'MRU_ADVANCE', gesture: { ...f.gesture, sequence: 1 } });
    await f.keyboard.settled();
    f.keyboard.keyUp(event('Control', { code: 'ControlLeft' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('ArrowDown', { code: 'ArrowDown' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:c']);
});

test('binding replay cannot erase a modifier re-pressed after a historical release', async () => {
    const f = await fixture('Ctrl+Down', false, true);
    f.keyboard.keyUp(event('Control', { code: 'ControlLeft' }));
    f.keyboard.keyDown(event('Control', { code: 'ControlLeft', ctrlKey: true }));
    const mount = f.mount(); f.finishBindings(); await mount;
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('Control', { code: 'ControlLeft' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('release confirmation rechecks newly held keys after a delayed barrier and resumes on keyup', async () => {
    const f = await fixture(); await f.mount();
    let acknowledge; let calls = 0;
    f.barrier.call = () => ++calls === 1 ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve({ gesture: f.gesture });
    f.keyboard.keyUp(event('Control'));
    for (let i = 0; i < 30 && !acknowledge; i++) await Promise.resolve();
    assert.equal(typeof acknowledge, 'function');
    f.keyboard.keyDown(event('ArrowDown', { code: 'ArrowDown' }));
    await f.controller.keyDown('ArrowDown'); // The input's existing plain-arrow handler still owns this navigation.
    acknowledge({ gesture: f.gesture }); await f.keyboard.settled();
    assert.deepEqual(f.activations, []);
    f.keyboard.keyUp(event('ArrowDown', { code: 'ArrowDown' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:c']);
});

test('explicit Enter confirmation remains available while another key is held', async () => {
    const f = await fixture(); await f.mount();
    f.keyboard.keyDown(event('x', { code: 'KeyX' }));
    f.keyboard.keyDown(event('Enter', { code: 'Enter' })); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b']);
});

test('a late activation result cannot shut down a newer gesture in the same document', async () => {
    const f = await fixture(); await f.mount();
    const request = f.client.request.bind(f.client);
    let finishActivation; let delayFirst = true;
    f.client.request = message => {
        const result = request(message);
        if (message.type !== 'MRU_ACTIVATE' || !delayFirst) return result;
        delayFirst = false;
        return new Promise(resolve => { finishActivation = () => resolve(result); });
    };
    f.keyboard.keyUp(event('Control'));
    for (let i = 0; i < 30 && !finishActivation; i++) await Promise.resolve();
    assert.equal(typeof finishActivation, 'function');
    f.keyboard.begin({ ...f.gesture, id: 'replacement-gesture' });
    finishActivation(); await f.keyboard.settled();
    f.keyboard.keyDown(event('Enter')); await f.keyboard.settled();
    assert.deepEqual(f.activations, ['tab:b', 'tab:b']);
});
