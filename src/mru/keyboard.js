import { HotkeyChord } from '../hotkeys/registry.js';

// A gesture is independent of the DOM and of MRU identity. Queue intent, not key events or copied rows, so startup and asynchronous paging cannot lose rapid presses.
export class MruKeyboard {
    constructor({ registry, gesture = null, onDismiss = () => {}, onError = () => {} }) {
        Object.assign(this, { registry, onDismiss, onError });
        this.pending = []; this.epoch = 0; this.closed = false; this.activationStarted = false;
        this.begin(gesture);
    }

    begin(gesture) {
        if (this.closed) return;
        if (this.gestureId !== gesture?.id) {
            this.disarm();
            this.gestureId = gesture?.id;
            this.sequence = 0;
            this.modifier = gesture ? HotkeyChord.primaryModifier(gesture.shortcut) : null;
            this.armed = Boolean(this.modifier);
        }
        this.advanceTo(gesture?.sequence || 0);
    }

    advanceTo(sequence) {
        if (this.closed) return;
        for (let next = this.sequence || 0; next < sequence; next++) this.pending.push(1);
        this.sequence = Math.max(this.sequence || 0, sequence);
        this.pump();
    }

    command(message) {
        if (this.closed) return;
        if (message.gesture) this.begin(message.gesture);
        else { this.pending.push(1); this.pump(); }
    }

    attach(view) { this.view = view; this.pump(); }

    keyDown(event) {
        if (this.closed) return false;
        const action = this.registry.match(event);
        if (action === 'mru-cancel') { this.cancel(); return true; }
        if (action === 'mru-confirm') { this.armed = false; this.confirmRequested = true; this.pump(); return true; }
        if (action === 'mru-newer') { this.pending.push(-1); this.pump(); return true; }
        return false; // The opening chord is owned by commands.onCommand, not a second DOM advance.
    }

    keyUp(event) {
        if (!this.armed || this.closed || HotkeyChord.modifierHeld(event, this.modifier)) return;
        this.armed = false; this.confirmRequested = true; this.pump();
    }

    pump() {
        if (this.running || !this.view || this.closed) return;
        this.running = true;
        const epoch = this.epoch;
        this.draining = this.drain().catch(error => { this.disarm(); this.onError(error); }).finally(() => {
            this.running = false;
            if (epoch !== this.epoch && (this.pending.length || this.confirmRequested)) this.pump();
        });
    }

    async drain() {
        const epoch = this.epoch;
        while (!this.closed && epoch === this.epoch) {
            if (!await this.view.controller.whenReady() || this.closed || epoch !== this.epoch) return;
            if (this.pending.length) { await this.view.advanceSelection(this.pending.shift()); continue; }
            if (this.confirmRequested && !this.activationStarted) {
                this.confirmRequested = false; this.activationStarted = true;
                await this.view.controller.activate();
            }
            return;
        }
    }

    settled() { return this.draining || Promise.resolve(); }

    disarm() {
        this.epoch++; this.pending = []; this.armed = false; this.confirmRequested = false;
        this.activationStarted = false;
    }

    blur() { if (this.armed || this.confirmRequested) this.cancel(); }
    cancel() { if (this.closed) return; this.disarm(); this.closed = true; this.onDismiss(); }
    dispose() { this.disarm(); this.closed = true; }
}
