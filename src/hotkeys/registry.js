// Add actions here, not another settings form or keyboard listener. Browser commands stay Chrome-owned; only focused-extension bindings are persisted by InfiniTabs.
export const HOTKEY_ACTIONS = Object.freeze([
    { id: 'open-mru-switcher', label: 'Open Recent / select older tab', scope: 'browser', defaultBinding: 'Ctrl+Down' },
    { id: 'previous-mru-tab', label: 'Switch immediately to previous tab', scope: 'browser', defaultBinding: '' },
    { id: 'mru-newer', label: 'Select newer recent tab', scope: 'switcher', defaultBinding: 'Ctrl+Up' },
    { id: 'mru-confirm', label: 'Switch to selected tab', scope: 'switcher', defaultBinding: 'Enter' },
    { id: 'mru-cancel', label: 'Cancel switcher (Escape always works)', scope: 'switcher', defaultBinding: 'Escape' }
]);

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Command'];
const MODIFIER_ALIASES = { Control: 'Ctrl', MacCtrl: 'Ctrl', Strg: 'Ctrl', Maj: 'Shift', Umschalt: 'Shift', Cmd: 'Command', '⌘': 'Command', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', ...MODIFIERS]);
const KEYS = { ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', '+': 'Plus', ',': 'Comma', '.': 'Period', Esc: 'Escape', Bas: 'Down', Haut: 'Up', Gauche: 'Left', Droite: 'Right', Espace: 'Space', Entrée: 'Enter', Échap: 'Escape', '↓': 'Down', '↑': 'Up', '←': 'Left', '→': 'Right' };

export class HotkeyChord {
    static normalize(value) {
        if (typeof value !== 'string' || !value) return null;
        const parts = value.split('+').map(part => MODIFIER_ALIASES[part] || part);
        const key = parts.pop();
        if (!key || MODIFIER_KEYS.has(key) || parts.some(part => !MODIFIERS.includes(part)) || new Set(parts).size !== parts.length) return null;
        if (parts.includes('Ctrl') && parts.includes('Alt')) return null; // AltGr is text input on BÉPO and many other layouts, not an extension shortcut.
        const normalizedKey = KEYS[key] || (key.length === 1 ? key.toUpperCase() : key);
        if (!/^(?:[^\s+]|Space|Plus|Comma|Period|Down|Up|Left|Right|Enter|Escape|Tab|Home|End|PageUp|PageDown|Insert|Delete|Backspace|F\d{1,2})$/u.test(normalizedKey)) return null;
        return [...MODIFIERS.filter(modifier => parts.includes(modifier)), normalizedKey].join('+');
    }

    static fromEvent(event) {
        if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph') || MODIFIER_KEYS.has(event.key)) return null;
        const modifiers = MODIFIERS.filter((_, index) => event[['ctrlKey', 'altKey', 'shiftKey', 'metaKey'][index]]);
        return this.normalize([...modifiers, KEYS[event.key] || event.key].join('+'));
    }

    static primaryModifier(binding) {
        // Chrome returns localized accelerator text, not canonical manifest syntax. Hold detection must not depend on recognizing a localized non-modifier key (for example French "Bas").
        const parts = typeof binding === 'string' ? binding.split('+').slice(0, -1).map(part => MODIFIER_ALIASES[part] || part) : [];
        return ['Ctrl', 'Alt', 'Command', 'Shift'].find(modifier => parts.includes(modifier)) || null;
    }

    static modifierHeld(event, modifier) {
        return Boolean(event[{ Ctrl: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Command: 'metaKey' }[modifier]]);
    }
}

export class HotkeyRegistry {
    constructor({ chrome, onChange = () => {} }) {
        Object.assign(this, { chrome, onChange });
        this.actions = HOTKEY_ACTIONS;
        this.definitions = new Map(this.actions.map(action => [action.id, action]));
        this.bindings = new Map(this.actions.map(action => [action.id, action.scope === 'browser' ? '' : action.defaultBinding]));
        this.index = new Map();
        this.revisions = new Map();
        this.commandGeneration = 0;
        this.initialized = false;
        this.changed = (changes, area) => {
            if (area !== 'local') return;
            for (const action of this.actions) {
                const key = this.storageKey(action.id);
                if (action.scope === 'browser' || !Object.hasOwn(changes, key)) continue;
                this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
                this.bindings.set(action.id, HotkeyChord.normalize(changes[key].newValue) || action.defaultBinding);
            }
            this.rebuild();
        };
        chrome.storage.onChanged?.addListener(this.changed);
        this.rebuild();
    }

    storageKey(id) { return `hotkeys.v1.${id}`; }
    binding(id) { return this.bindings.get(id) || ''; }

    ready() {
        if (!this.loading) this.loading = Promise.all([this.loadBindings(), this.refreshCommands()]).then(() => { this.initialized = true; }).catch(error => { this.loading = null; throw error; });
        return this.loading;
    }

    async loadBindings() {
        const actions = this.actions.filter(action => action.scope !== 'browser');
        const revisions = new Map(this.revisions);
        const values = await this.chrome.storage.local.get(actions.map(action => this.storageKey(action.id)));
        for (const action of actions) {
            const key = this.storageKey(action.id);
            if (revisions.get(key) !== this.revisions.get(key)) continue;
            this.bindings.set(action.id, HotkeyChord.normalize(values[key]) || action.defaultBinding);
        }
        this.rebuild();
    }

    async refreshCommands() {
        const generation = ++this.commandGeneration;
        const commands = await this.chrome.commands.getAll();
        if (generation !== this.commandGeneration) return;
        const assignments = new Map(commands.map(command => [command.name, command.shortcut || '']));
        for (const action of this.actions) if (action.scope === 'browser') this.bindings.set(action.id, assignments.get(action.id) || '');
        this.rebuild();
    }

    rebuild() {
        this.index.clear();
        // A native command wins over a conflicting local preference, including externally changed/corrupt storage. Never run two actions for the same chord.
        for (const scope of ['browser', 'switcher']) for (const action of this.actions) {
            if (action.scope !== scope) continue;
            const chord = HotkeyChord.normalize(this.binding(action.id));
            if (chord && !this.index.has(chord)) this.index.set(chord, action.id);
        }
        this.onChange();
    }

    match(event) {
        if (event.isComposing || event.keyCode === 229) return null;
        // Cancellation is a permanent safety escape hatch, irrespective of the currently held modifier or a customized cancel binding.
        if (event.key === 'Escape') return 'mru-cancel';
        return this.index.get(HotkeyChord.fromEvent(event)) || null;
    }

    async setBinding(id, value) {
        const action = this.definitions.get(id);
        if (!action) throw new Error('Unknown hotkey action');
        if (action.scope === 'browser') throw new Error('Change this shortcut in Chrome’s shortcut settings.');
        const chord = HotkeyChord.normalize(value);
        if (!chord) throw new Error('Press a key with optional modifiers; modifier-only and AltGr shortcuts are not supported.');
        const conflict = this.actions.find(candidate => candidate.id !== id && HotkeyChord.normalize(this.binding(candidate.id)) === chord);
        if (conflict || (chord.endsWith('Escape') && id !== 'mru-cancel')) throw new Error(`Shortcut already assigned to ${conflict?.label || 'Cancel switcher'}.`);
        await this.chrome.storage.local.set({ [this.storageKey(id)]: chord });
        this.bindings.set(id, chord);
        this.rebuild();
    }

    resetBinding(id) { return this.setBinding(id, this.definitions.get(id)?.defaultBinding); }
    dispose() { this.commandGeneration++; this.chrome.storage.onChanged?.removeListener(this.changed); }
}
