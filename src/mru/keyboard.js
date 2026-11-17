import { HotkeyChord } from '../hotkeys/registry.js';

// A gesture is independent of the DOM and of MRU identity. Queue intent, not key events or copied rows, so startup and asynchronous paging cannot lose rapid presses.
export class MruKeyboard {
    constructor({ registry, gesture = null, barrier = null, onDismiss = () => {}, onError = () => {} }) {
        Object.assign(this, { registry, barrier, onDismiss, onError });
        this.pending = []; this.epoch = 0; this.closed = false; this.activationStarted = false;
        this.pressed = new Set();
        this.inputs = []; this.bindingsReady = registry.initialized === true;
        this.begin(gesture);
        if (!this.bindingsReady) this.bindingInitialization = registry.ready().then(() => {
            this.bindingsReady = true;
            this.replaying = true;
            const inputs = this.inputs; this.inputs = [];
            for (const input of inputs) this[input.type](input.event);
            this.replaying = false;
            this.pump();
        }).catch(error => { this.disarm(); this.onError(error); });
    }

    begin(gesture) {
        if (this.closed) return;
        if (this.gestureId !== gesture?.id) {
            this.resetGesture();
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
        // Physical state belongs to this document, not to an individual gesture or deferred binding interpretation. Replaying old input must never modify today's held-key set.
        if (!this.replaying && !event.isComposing && event.keyCode !== 229) {
            this.pressed.add(this.keyIdentity(event));
            if (event.key === this.modifierKey || HotkeyChord.modifierHeld(event, this.modifier)) this.primaryReleased = false;
        }
        if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { this.cancel(); return true; }
        if (!this.bindingsReady) {
            if (!HotkeyChord.fromEvent(event)) return false;
            this.inputs.push({ type: 'keyDown', event: this.snapshot(event) });
            return true;
        }
        const action = this.registry.match(event);
        if (action === 'mru-cancel') { this.cancel(); return true; }
        if (action === 'mru-confirm') { this.armed = false; this.releaseConfirmation = false; this.confirmRequested = true; this.pump(); return true; }
        if (action === 'mru-newer') { this.pending.push(-1); this.pump(); return true; }
        return false; // The opening chord is owned by commands.onCommand, not a second DOM advance.
    }

    keyUp(event) {
        if (this.closed) return;
        if (!this.replaying) {
            this.pressed.delete(this.keyIdentity(event));
            if (event.key === this.modifierKey && !HotkeyChord.modifierHeld(event, this.modifier)) this.primaryReleased = true;
            else if (HotkeyChord.modifierHeld(event, this.modifier)) this.primaryReleased = false;
        }
        if (!this.bindingsReady) { this.inputs.push({ type: 'keyUp', event: this.snapshot(event) }); return; }
        if (this.confirmRequested && this.releaseConfirmation) { if (this.canConfirm) this.pump(); return; }
        // Do not infer a missed modifier release from another keyup. Once that release is observed, wait for any other observed held keys too, regardless of release order.
        if (!this.armed || !this.primaryReleased || this.pressed.size) return;
        this.armed = false; this.releaseConfirmation = true; this.confirmRequested = true; this.pump();
    }

    pump() {
        if (!this.bindingsReady || this.replaying || this.running || !this.view || this.closed) return;
        this.running = true;
        this.draining = this.drain().catch(error => { this.disarm(); this.onError(error); }).finally(() => {
            this.running = false;
            if (!this.closed && (this.pending.length || this.canConfirm) && this.view.controller.canNavigate) this.pump();
        });
    }

    async drain() {
        const epoch = this.epoch;
        while (!this.closed && epoch === this.epoch) {
            if (!await this.view.controller.whenReady() || this.closed || epoch !== this.epoch) return;
            if (this.pending.length) { await this.view.advanceSelection(this.pending.shift()); continue; }
            if (this.canConfirm && !this.activationStarted) {
                if (this.gestureId && this.barrier) {
                    const result = await this.barrier(this.gestureId);
                    if (this.closed || epoch !== this.epoch) return;
                    if (result?.gesture) {
                        if (result.gesture.id !== this.gestureId) throw new Error('Switcher gesture changed; select a tab again.');
                        this.advanceTo(result.gesture.sequence);
                        if (this.pending.length) continue;
                    }
                }
                // New input can arrive during query/page/barrier awaits. A release-driven confirmation must still have no observed held keys at the actual activation boundary.
                if (!this.canConfirm) return;
                this.confirmRequested = false; this.activationStarted = true;
                const activated = await this.view.controller.activate();
                if (this.closed || epoch !== this.epoch) return;
                this.activationStarted = Boolean(activated);
                if (activated) this.closed = true;
            }
            return;
        }
    }

    async settled() { await this.bindingInitialization; await this.draining; }

    snapshot(event) {
        return { key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, isComposing: event.isComposing, keyCode: event.keyCode };
    }

    keyIdentity(event) { return event.code || (event.key?.length === 1 ? event.key.toUpperCase() : event.key); }

    get modifierKey() { return { Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Command: 'Meta' }[this.modifier]; }
    get canConfirm() { return this.confirmRequested && (!this.releaseConfirmation || (this.primaryReleased && this.pressed.size === 0)); }

    resetGesture() {
        this.epoch++; this.pending = []; this.armed = false; this.confirmRequested = false;
        this.primaryReleased = false;
        this.releaseConfirmation = false;
        this.activationStarted = false;
    }

    disarm() { this.resetGesture(); this.inputs = []; }
    blur() { this.cancel(); }
    cancel() { if (this.closed) return; this.disarm(); this.pressed.clear(); this.closed = true; this.onDismiss(); }
    dispose() { this.disarm(); this.pressed.clear(); this.closed = true; }
}
