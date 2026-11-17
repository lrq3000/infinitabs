import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from './mru/storage-fixture.mjs';

const module = await import('../src/hotkeys/registry.js').catch(() => ({}));
const { HotkeyRegistry, HotkeyChord } = module;
const key = (key, modifiers = {}) => ({ key, ...modifiers, getModifierState: () => false });

function fixture(values = {}, commands = [{ name: 'open-mru-switcher', shortcut: 'Ctrl+Down' }]) {
    assert.equal(typeof HotkeyRegistry, 'function', 'implement the shared hotkey registry');
    const storage = new MemoryStorage(values);
    const listeners = new Set();
    const chrome = { storage: { local: storage, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } }, commands: { getAll: async () => commands } };
    const registry = new HotkeyRegistry({ chrome });
    return { registry, storage, commands, change: changes => { for (const listener of listeners) listener(changes, 'local'); } };
}

test('chords normalize actual arrow/space events without assuming a letter layout', () => {
    assert.equal(typeof HotkeyChord, 'function', 'implement chord normalization');
    assert.equal(HotkeyChord.fromEvent(key('ArrowDown', { ctrlKey: true })), 'Ctrl+Down');
    assert.equal(HotkeyChord.fromEvent(key('ArrowUp', { ctrlKey: true })), 'Ctrl+Up');
    assert.equal(HotkeyChord.fromEvent(key(' ', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Space');
    assert.equal(HotkeyChord.fromEvent(key('é', { ctrlKey: true })), 'Ctrl+É');
    assert.equal(HotkeyChord.primaryModifier('Alt+Shift+Space'), 'Alt');
});

test('composition, modifier-only and AltGr text never become shortcut bindings', () => {
    assert.equal(typeof HotkeyChord, 'function', 'implement chord validation');
    for (const event of [key('Control', { ctrlKey: true }), key('Dead'), key('Process'), key('a', { isComposing: true }), key('a', { ctrlKey: true, altKey: true }), { ...key('é'), getModifierState: () => true }]) {
        assert.equal(HotkeyChord.fromEvent(event), null);
    }
});

test('localized Chrome accelerator labels still match arrows and derive hold independently of the key label', async () => {
    assert.equal(HotkeyChord.primaryModifier('Ctrl+Bas'), 'Ctrl');
    assert.equal(HotkeyChord.primaryModifier('Ctrl+UnrecognizedLocalizedKey'), 'Ctrl');
    assert.equal(HotkeyChord.normalize('Ctrl+Bas'), 'Ctrl+Down');
    const { registry } = fixture({}, [{ name: 'open-mru-switcher', shortcut: 'Ctrl+Bas' }]); await registry.ready();
    assert.equal(registry.binding('open-mru-switcher'), 'Ctrl+Bas');
    assert.equal(registry.match(key('ArrowDown', { ctrlKey: true })), 'open-mru-switcher');
    await assert.rejects(registry.setBinding('mru-newer', 'Ctrl+Down'), /already assigned/);
    registry.dispose();
});

test('actual native assignment overrides the suggested default and unbound is displayed honestly', async () => {
    const { registry, commands } = fixture({}, [{ name: 'open-mru-switcher', shortcut: 'Alt+Shift+Q' }]);
    await registry.ready();
    assert.equal(registry.binding('open-mru-switcher'), 'Alt+Shift+Q');
    assert.equal(registry.match(key('ArrowUp', { ctrlKey: true })), 'mru-newer');
    commands[0].shortcut = '';
    await registry.refreshCommands();
    assert.equal(registry.binding('open-mru-switcher'), '');
    await assert.rejects(registry.setBinding('open-mru-switcher', 'Ctrl+Space'), /Chrome/i);
    registry.dispose();
});

test('local changes persist per action, survive reload and reset to the default', async () => {
    const { registry, storage } = fixture();
    await registry.ready();
    await registry.setBinding('mru-newer', 'Ctrl+Space');
    assert.equal(registry.match(key(' ', { ctrlKey: true })), 'mru-newer');
    assert.equal(registry.match(key('ArrowUp', { ctrlKey: true })), null);
    assert.equal(storage.values['hotkeys.v1.mru-newer'], 'Ctrl+Space');
    const restored = fixture(storage.values).registry;
    await restored.ready();
    assert.equal(restored.binding('mru-newer'), 'Ctrl+Space');
    await restored.resetBinding('mru-newer');
    assert.equal(restored.binding('mru-newer'), 'Ctrl+Up');
    registry.dispose(); restored.dispose();
});

test('duplicate native/local bindings and invalid chords are rejected before persistence', async () => {
    const { registry, storage } = fixture(); await registry.ready();
    for (const binding of ['Ctrl+Down', 'Enter']) await assert.rejects(registry.setBinding('mru-newer', binding), /already|assigned/i);
    await assert.rejects(registry.setBinding('mru-newer', 'Ctrl'), /key|shortcut/i);
    assert.equal(storage.values['hotkeys.v1.mru-newer'], undefined);
    registry.dispose();
});

test('failed writes never display an unapplied binding and held Ctrl cannot defeat Escape', async () => {
    const { registry, storage } = fixture(); await registry.ready();
    storage.set = async () => { throw new Error('Storage failed'); };
    await assert.rejects(registry.setBinding('mru-newer', 'Ctrl+Space'), /Storage failed/);
    assert.equal(registry.binding('mru-newer'), 'Ctrl+Up');
    assert.equal(registry.match(key('Escape', { ctrlKey: true, shiftKey: true })), 'mru-cancel');
    registry.dispose();
});

test('corrupt stored values fall back safely and external settings update active lookup', async () => {
    const { registry, change } = fixture({ 'hotkeys.v1.mru-newer': { corrupt: true } }); await registry.ready();
    assert.equal(registry.binding('mru-newer'), 'Ctrl+Up');
    change({ 'hotkeys.v1.mru-newer': { newValue: 'Ctrl+Space' } });
    assert.equal(registry.match(key(' ', { ctrlKey: true })), 'mru-newer');
    assert.equal(registry.match(key('ArrowUp', { ctrlKey: true })), null);
    registry.dispose();
});
