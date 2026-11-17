import { HotkeyChord } from './registry.js';

// Scope determines editing behavior, so future command and local actions need only a registry entry, not another options-page handler.
export class HotkeySettingsView {
    constructor({ root, registry }) {
        Object.assign(this, { root, registry });
        this.document = root.ownerDocument;
        this.window = this.document.defaultView;
        this.abort = new AbortController();
        this.recording = null; this.message = ''; this.saving = false;
        registry.onChange = () => this.render();
    }

    element(tag, text) {
        const element = this.document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        return element;
    }

    async mount() {
        this.root.addEventListener('click', event => this.click(event), { signal: this.abort.signal });
        this.window.addEventListener('keydown', event => this.capture(event), { capture: true, signal: this.abort.signal });
        this.window.addEventListener('blur', () => this.cancelRecording(), { signal: this.abort.signal });
        this.window.addEventListener('focus', () => this.registry.refreshCommands().catch(error => this.status(error.message)), { signal: this.abort.signal });
        try { await this.registry.ready(); }
        catch (error) { this.message = `Could not load shortcuts: ${error.message}`; }
        this.render();
    }

    status(message) { this.message = message; this.render(); }
    cancelRecording() { if (!this.recording || this.saving) return; this.recording = null; this.status('Recording cancelled.'); }

    async click(event) {
        const button = event.target.closest('button[data-action]');
        if (!button || this.saving) return;
        const id = button.dataset.action;
        if (id === 'cancel-recording') { this.cancelRecording(); return; }
        const action = this.registry.definitions.get(id);
        if (action.scope === 'browser') {
            try { await this.registry.chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); }
            catch (error) { this.status(error.message); }
        } else if (button.dataset.reset) {
            try { await this.registry.resetBinding(id); this.status('Default shortcut restored.'); }
            catch (error) { this.status(error.message); }
        } else {
            this.recording = id;
            this.status('Press a shortcut. Escape or Cancel stops recording.');
            this.root.querySelector('button[data-recording]')?.focus();
        }
    }

    async capture(event) {
        if (!this.recording) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (this.saving) return;
        if (event.key === 'Escape') { this.cancelRecording(); return; }
        const chord = HotkeyChord.fromEvent(event);
        if (!chord) return;
        this.saving = true;
        try {
            await this.registry.setBinding(this.recording, chord);
            this.recording = null; this.message = 'Shortcut saved.';
        } catch (error) { this.message = error.message; }
        finally { this.saving = false; this.render(); }
    }

    render() {
        const table = this.element('table');
        const header = this.element('tr');
        for (const title of ['Function', 'Hotkey', 'Scope', '']) { const cell = this.element('th', title); cell.scope = 'col'; header.append(cell); }
        const head = this.element('thead'); head.append(header); table.append(head);
        const body = this.element('tbody');
        for (const action of this.registry.actions) {
            const row = this.element('tr'); row.dataset.hotkeyId = action.id;
            const label = this.element('td', action.label);
            const cell = this.element('td');
            const recording = this.recording === action.id;
            const button = this.element('button', recording ? 'Press shortcut…' : this.registry.binding(action.id) || 'Not assigned');
            button.type = 'button'; button.dataset.action = action.id;
            button.setAttribute('aria-label', `Change shortcut: ${action.label}`);
            button.title = action.scope === 'browser' ? 'Change in Chrome’s shortcut settings' : 'Click, then press a replacement shortcut';
            if (recording) button.dataset.recording = 'true';
            button.disabled = this.saving;
            cell.append(button);
            const controls = this.element('td');
            if (action.scope !== 'browser') {
                const reset = this.element('button', 'Reset'); reset.type = 'button'; reset.dataset.action = action.id; reset.dataset.reset = 'true'; reset.disabled = this.saving;
                reset.setAttribute('aria-label', `Reset shortcut: ${action.label}`); controls.append(reset);
            }
            row.append(label, cell, this.element('td', action.scope === 'browser' ? 'Browser — Chrome-managed' : 'Recent switcher'), controls);
            body.append(row);
        }
        table.append(body);
        const scroll = this.element('div'); scroll.className = 'hotkeys-table-scroll'; scroll.append(table);
        const status = this.element('p', this.message); status.setAttribute('role', 'status'); status.id = 'hotkeys-status';
        const cancel = this.element('button', 'Cancel recording'); cancel.type = 'button'; cancel.dataset.action = 'cancel-recording'; cancel.hidden = !this.recording; cancel.disabled = this.saving;
        this.root.replaceChildren(scroll, status, cancel);
    }

    dispose() { this.abort.abort(); this.registry.dispose(); }
}
