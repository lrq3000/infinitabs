import { MruClient, MruView } from './view.js';
import { HotkeyRegistry, HotkeyChord } from '../hotkeys/registry.js';
import { MruKeyboard } from './keyboard.js';

const parameters = new URLSearchParams(location.search);
const root = document.getElementById('mru-popup-root');
const close = () => window.close();
document.getElementById('close-switcher').addEventListener('click', close);

function applyTheme() { document.body.classList.toggle('dark-mode', localStorage.getItem('infiniTabsTheme') === 'dark'); }
applyTheme();
window.addEventListener('storage', applyTheme);

if (parameters.has('bridge')) {
    document.querySelector('.mru-popup-header').hidden = false;
    document.getElementById('popup-title').textContent = 'Opening saved session…';
    root.textContent = 'Only the selected logical tab will be mounted.';
} else {
    const client = new MruClient(chrome, { dismissSwitcherOnActivate: true });
    const registry = new HotkeyRegistry({ chrome });
    let view;
    const gesture = parameters.has('gestureId') ? { id: parameters.get('gestureId'), shortcut: parameters.get('shortcut'), sequence: 0 } : null;
    const keyboard = new MruKeyboard({ registry, gesture,
        barrier: gestureId => client.request({ ...view.controller.context, type: 'MRU_GESTURE_BARRIER', gestureId }),
        onDismiss: close, onError: error => { if (view) { view.controller.error = error.message; view.render(); } } });
    const abort = new AbortController();
    // Install before all initialization awaits: releasing Ctrl during a worker wake still confirms the eventual selection, rather than leaving a stuck popup.
    window.addEventListener('keydown', event => {
        const handled = keyboard.keyDown(event);
        const native = registry.definitions.get(registry.match(event))?.scope === 'browser';
        if (native || handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, signal: abort.signal });
    window.addEventListener('keyup', event => keyboard.keyUp(event), { capture: true, signal: abort.signal });
    window.addEventListener('blur', () => keyboard.blur(), { signal: abort.signal });
    window.addEventListener('pointerdown', () => keyboard.disarm(), { capture: true, signal: abort.signal });
    const listener = message => {
        if (message.type === 'MRU_ADVANCE') keyboard.command(message);
        else if (message.type === 'MRU_UPDATED' && view) view.refresh().then(() => keyboard.attach(view));
        else if (message.type === 'MRU_CONTEXT' && message.context && view) {
            keyboard.disarm();
            view.controller.context = message.context; view.input.value = '';
            keyboard.begin(message.context.gesture);
            view.controller.search('').then(() => { view.focus(); keyboard.attach(view); });
        }
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
        const context = await client.request({ type: 'MRU_POPUP_CONTEXT', sourceWindowId: Number(parameters.get('sourceWindowId')) });
        keyboard.begin(context.gesture);
        view = new MruView({ root, client, context, showLiveToggle: true, keyboardManaged: true, onActivated: close, onDismiss: close });
        await Promise.all([registry.ready(), view.mount()]); view.focus(); keyboard.attach(view);
        const hint = document.querySelector('.mru-popup-hint');
        registry.onChange = () => {
            const opener = registry.binding('open-mru-switcher');
            const modifier = HotkeyChord.primaryModifier(opener);
            hint.textContent = `${opener || 'Opening shortcut unassigned'} older · ${registry.binding('mru-newer')} newer · release ${modifier || 'opening modifier'} and held keys to switch · ${registry.binding('mru-confirm')}/click switch · Esc cancel`;
        };
        registry.onChange();
        const colors = await chrome.storage.local.get({ activeTabBg: '' });
        if (colors.activeTabBg && CSS.supports('color', colors.activeTabBg)) document.documentElement.style.setProperty('--active-bg', colors.activeTabBg);
    } catch (error) { root.textContent = error.message; }
    window.addEventListener('pagehide', () => { keyboard.dispose(); abort.abort(); chrome.runtime.onMessage.removeListener(listener); registry.dispose(); view?.dispose(); });
}
