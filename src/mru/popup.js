import { MruClient, MruView } from './view.js';

const parameters = new URLSearchParams(location.search);
const root = document.getElementById('mru-popup-root');
const close = () => window.close();
document.getElementById('close-switcher').addEventListener('click', close);

function applyTheme() { document.body.classList.toggle('dark-mode', localStorage.getItem('infiniTabsTheme') === 'dark'); }
applyTheme();
window.addEventListener('storage', applyTheme);

if (parameters.has('bridge')) {
    document.getElementById('popup-title').textContent = 'Opening saved session…';
    root.textContent = 'Only the selected logical tab will be mounted.';
} else {
    const client = new MruClient(chrome);
    let view;
    try {
        const context = await client.request({ type: 'MRU_POPUP_CONTEXT', sourceWindowId: Number(parameters.get('sourceWindowId')) });
        view = new MruView({ root, client, context, showLiveToggle: true, onActivated: close, onDismiss: close });
        await view.mount(); view.focus();
        chrome.runtime.onMessage.addListener(message => {
            if (message.type === 'MRU_CONTEXT' && message.context) {
                view.controller.context = message.context; view.input.value = '';
                view.controller.search(''); view.focus();
            } else if (message.type === 'MRU_UPDATED') view.refresh();
            else if (message.type === 'MRU_ADVANCE') view.advanceSelection(1);
        });
        const colors = await chrome.storage.local.get({ activeTabBg: '' });
        if (colors.activeTabBg && CSS.supports('color', colors.activeTabBg)) document.documentElement.style.setProperty('--active-bg', colors.activeTabBg);
    } catch (error) { root.textContent = error.message; }
    window.addEventListener('pagehide', () => view?.dispose());
}
