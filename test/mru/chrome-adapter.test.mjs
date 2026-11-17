import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserFixture } from './browser-fixture.mjs';
import { MruChromeAdapter } from '../../src/mru/chrome-adapter.js';

async function fixture(overrides = {}) {
    assert.equal(typeof MruChromeAdapter, 'function', 'Chrome adapter must be implemented');
    const browser = new BrowserFixture();
    const adapter = new MruChromeAdapter({ ...browser.options(), ...overrides });
    adapter.start(); await adapter.ready();
    return { browser, adapter };
}

test('keyboard opening records the actual hold chord and repeats survive popup startup', async () => {
    const { browser, adapter } = await fixture();
    browser.chrome.commands.getAll = async () => [{ name: 'open-mru-switcher', shortcut: 'Ctrl+Space' }];
    await adapter.command('open-mru-switcher', { windowId: 1 });
    const context = await adapter.handleMessage({ type: 'MRU_POPUP_CONTEXT', sourceWindowId: 1 });
    assert.equal(context.gesture?.shortcut, 'Ctrl+Space');
    assert.equal(context.gesture?.sequence, 0);
    await adapter.command('open-mru-switcher', { windowId: adapter.popupWindowId });
    const updated = await adapter.handleMessage({ type: 'MRU_POPUP_CONTEXT', sourceWindowId: 1 });
    assert.equal(updated.gesture.sequence, 1);
    assert.equal(browser.messages.at(-1).gesture.sequence, 1);
});

test('queued commands keep their explicit source even when an earlier popup steals focus', async () => {
    const { browser, adapter } = await fixture();
    let releaseCreation;
    const create = browser.chrome.windows.create;
    browser.chrome.windows.create = async values => { await new Promise(resolve => { releaseCreation = resolve; }); return create(values); };
    const first = adapter.command('open-mru-switcher', { windowId: 1 });
    for (let i = 0; i < 100 && !releaseCreation; i++) await Promise.resolve();
    assert.equal(typeof releaseCreation, 'function');
    await browser.chrome.windows.update(2, { focused: true });
    const second = adapter.command('open-mru-switcher', { windowId: 2 });
    releaseCreation(); await Promise.all([first, second]);
    assert.equal(adapter.popupContext.sourceWindowId, 2);
    assert.equal(adapter.popupContext.gesture.sequence, 0, 'retarget is not a repeat in the old source');
});

test('gesture barriers wait for a received repeat storage write before acknowledging its sequence', async () => {
    const { browser, adapter } = await fixture();
    await adapter.command('open-mru-switcher', { windowId: 1 });
    const context = structuredClone(adapter.popupContext);
    let releaseWrite;
    const set = browser.chrome.storage.session.set.bind(browser.chrome.storage.session);
    browser.chrome.storage.session.set = async values => { await new Promise(resolve => { releaseWrite = resolve; }); return set(values); };
    const repeat = adapter.command('open-mru-switcher', { windowId: adapter.popupWindowId });
    for (let i = 0; i < 100 && !releaseWrite; i++) await Promise.resolve();
    assert.equal(typeof releaseWrite, 'function');
    let acknowledged = false;
    const barrier = adapter.handleMessage({ ...context, type: 'MRU_GESTURE_BARRIER', gestureId: context.gesture.id }).then(result => { acknowledged = true; return result; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(acknowledged, false);
    releaseWrite(); await repeat;
    const result = await barrier;
    assert.equal(result.gesture.sequence, 1);
    await assert.rejects(adapter.handleMessage({ ...context, type: 'MRU_GESTURE_BARRIER', gestureId: 'obsolete' }), /gesture/i);
});

test('native window focus loss closes a manual switcher independently of document focus', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    await browser.chrome.windows.update(1, { focused: true });
    for (const listener of browser.listeners.focus) listener(1);
    for (let i = 0; i < 100 && browser.windows.has(popupId); i++) await Promise.resolve();
    assert.equal(browser.windows.has(popupId), false);
    assert.equal(browser.tabs.get(11).active, true);
});

test('a transient no-window-focus notification does not dismiss an actually focused switcher', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    for (const listener of browser.listeners.focus) listener(-1);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(browser.windows.has(popupId), true);
});

test('popup activation handoff dismisses the window before a delayed native focus completes', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    let finishFocus;
    const update = browser.chrome.tabs.update;
    browser.chrome.tabs.update = async (id, values) => { await new Promise(resolve => { finishFocus = resolve; }); return update(id, values); };
    let accepted = false;
    const request = adapter.handleMessage({ type: 'MRU_ACTIVATE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:a', dismissSwitcher: true }).then(result => { accepted = result.success; return result; });
    for (let i = 0; i < 100 && (!finishFocus || !accepted); i++) await Promise.resolve();
    assert.equal(typeof finishFocus, 'function');
    assert.equal(browser.windows.has(popupId), false, 'the UI must not wait for native focus/mount');
    assert.equal(accepted, true);
    const activation = adapter.activations.get('tab:a');
    finishFocus(); await request; await activation;
    assert.equal(browser.tabs.get(11).active, true);
    assert.equal(browser.windows.has(1), true);
});

test('failed handed-off activation is reported by the worker after popup dismissal', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    browser.chrome.tabs.update = async () => { throw new Error('Native focus failed'); };
    const result = await adapter.handleMessage({ type: 'MRU_ACTIVATE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:a', dismissSwitcher: true }).catch(error => ({ error: error.message }));
    assert.equal(result.success, true, 'acceptance is not a false claim that activation completed');
    for (let i = 0; i < 100 && !browser.messages.some(message => message.type === 'MRU_ERROR'); i++) await Promise.resolve();
    assert.equal(browser.windows.has(popupId), false);
    assert.equal(browser.messages.find(message => message.type === 'MRU_ERROR')?.error, 'Native focus failed');
});

test('native popup removal starts without waiting for storage cleanup', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    let finishCleanup;
    browser.chrome.storage.session.remove = () => new Promise(resolve => { finishCleanup = resolve; });
    const close = adapter.closeSwitcher();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(browser.windows.has(popupId), false);
    assert.equal(typeof finishCleanup, 'function');
    finishCleanup(); await close;
});

test('Recent unmount/delete resolve the actual mounted destination and delegate its lifecycle', async () => {
    const calls = [];
    const { adapter } = await fixture({
        unmountLogicalTab: async (...args) => calls.push(['unmount', ...args]),
        deleteLogicalTab: async (...args) => calls.push(['delete', ...args])
    });
    for (const type of ['MRU_UNMOUNT', 'MRU_DELETE']) await adapter.handleMessage({ type, sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' });
    assert.deepEqual(calls, [['unmount', 2, 'logical-c'], ['delete', 2, 'logical-c']]);
});

test('Recent deletes unmounted tabs using their current canonical session rather than stale ownership', async () => {
    const calls = [];
    const { browser, adapter } = await fixture({ deleteLogicalTab: async (...args) => calls.push(args) });
    const bookmark = browser.node('b');
    browser.node('s').children = browser.node('s').children.filter(node => node.id !== 'b');
    bookmark.parentId = 'other'; browser.node('other').children.push(bookmark);
    await adapter.handleMessage({ type: 'MRU_DELETE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    assert.deepEqual(calls, [[2, 'logical-b-reload-1']]);
    assert.equal(browser.tabs.size, 2, 'deleting must never mount an unmounted logical tab');
});

test('a mounted bookmark moved externally still closes its real projection through the original lifecycle', async () => {
    const calls = [];
    const { browser, adapter } = await fixture({ deleteLogicalTab: async (...args) => calls.push(args) });
    const bookmark = browser.node('a');
    browser.node('s').children = browser.node('s').children.filter(node => node.id !== 'a');
    bookmark.parentId = 'other'; browser.node('other').children.push(bookmark);
    await adapter.handleMessage({ type: 'MRU_DELETE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:a' });
    assert.deepEqual(calls, [[1, 'logical-a']]);
});

test('an already-unmounted bound target is inert and leaves normal row identities usable', async () => {
    let called = false;
    const { browser, adapter } = await fixture({ unmountLogicalTab: async () => { called = true; } });
    const identities = browser.state.sessionsById.s.logicalTabs.map(tab => tab.logicalId);
    await adapter.handleMessage({ type: 'MRU_UNMOUNT', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    assert.deepEqual(browser.state.sessionsById.s.logicalTabs.map(tab => tab.logicalId), identities);
    assert.equal(called, false);
    await browser.mount(1, 'logical-b');
    assert.ok([...browser.tabs.values()].some(tab => tab.url === 'https://b.test'));
});

test('saved-session deletion removes only its bookmark, without binding or opening a window', async () => {
    const { browser, adapter } = await fixture();
    browser.chrome.bookmarks.remove = async id => {
        assert.equal(id, 'd');
        browser.node('closed').children = [];
    };
    await adapter.handleMessage({ type: 'MRU_UNMOUNT', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:d' });
    assert.ok(browser.node('d'), 'unmounting a saved-only target is inert');
    await adapter.handleMessage({ type: 'MRU_DELETE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:d' });
    assert.equal(browser.node('d'), null);
    assert.equal(browser.windows.size, 2);
    assert.deepEqual(browser.state.windowToSession, { 1: 's', 2: 'other' });
    assert.equal(browser.node('s').children.length, 2);
});

test('mutations reject stale sources, missing/recovery keys, private targets, and propagate lifecycle errors', async () => {
    const calls = [];
    const { browser, adapter } = await fixture({ deleteLogicalTab: async () => { calls.push('delete'); throw new Error('Delete failed'); } });
    const request = { type: 'MRU_DELETE', sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' };
    await assert.rejects(adapter.handleMessage({ ...request, sourceSessionId: 'obsolete' }), /session/i);
    await assert.rejects(adapter.handleMessage({ ...request, key: 'tab:missing' }), /exist/i);
    await assert.rejects(adapter.handleMessage({ ...request, key: 'deleted:old' }), /logical tab/i);
    browser.windows.get(2).incognito = true;
    await assert.rejects(adapter.handleMessage(request), /private/i);
    assert.deepEqual(calls, []);
    browser.windows.get(2).incognito = false;
    await assert.rejects(adapter.handleMessage(request), /Delete failed/);
    assert.deepEqual(calls, ['delete']);
});

test('only genuinely focused native selections enter recency, including late attachment', async () => {
    const { browser, adapter } = await fixture();
    await adapter.observeCurrent(2);
    assert.deepEqual(adapter.recencyStore.entries(), []);
    await adapter.observeCurrent(1);
    assert.deepEqual(adapter.recencyStore.entries().map(x => x.bookmarkId), ['a']);
    delete browser.state.tabToLogical[11];
    await adapter.recencyStore.forget(['a']); adapter.service.lastViewedBookmarkId = null;
    await adapter.observeCurrent(1); assert.deepEqual(adapter.recencyStore.entries(), []);
    browser.state.tabToLogical[11] = 'logical-a'; await adapter.observeCurrent(1);
    assert.equal(adapter.recencyStore.entries()[0].bookmarkId, 'a');
});

test('queries expose source current identity even without a recorded visit or focused window', async () => {
    const { adapter } = await fixture();
    const result = await adapter.handleMessage({ type: 'MRU_QUERY', sourceWindowId: 2 });
    assert.equal(result.context.currentBookmarkId, 'c');
    assert.deepEqual(result.items.map(item => item.key), ['tab:c']);
    assert.deepEqual(adapter.recencyStore.entries(), [], 'showing current must not record a background view');
});

test('Previous tab skips the current result and still switches to the most recent older tab', async () => {
    const { browser, adapter } = await fixture();
    await adapter.observeCurrent(1);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    await adapter.command('previous-mru-tab', { windowId: 1 });
    assert.equal(browser.tabs.get(11).active, true);
    const result = await adapter.handleMessage({ type: 'MRU_QUERY', sourceWindowId: 1 });
    assert.equal(result.context.currentBookmarkId, 'a');
    assert.deepEqual(result.items.map(item => item.key), ['tab:a', 'tab:b']);
});

test('existing mounted tabs focus without duplication and unmounted tabs mount only once', async () => {
    const { browser, adapter } = await fixture();
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' });
    assert.equal(browser.tabs.size, 2); assert.equal(browser.windows.get(2).focused, true);
    await Promise.all([adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' }), adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' })]);
    assert.equal([...browser.tabs.values()].filter(tab => tab.url === 'https://b.test').length, 1);
});

test('saved sessions open separately and keep the caller session and canonical layout', async () => {
    const { browser, adapter } = await fixture();
    const before = structuredClone(browser.root);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:d' });
    assert.equal(browser.state.windowToSession[1], 's');
    assert.equal(browser.windows.size, 3); assert.deepEqual(browser.root, before);
    assert.equal([...browser.tabs.values()].filter(tab => tab.url === 'https://d.test').length, 1);
    assert.equal([...browser.tabs.values()].some(tab => adapter.isInternalTab(tab)), false);
});

test('internal popup classification and retargeting never create native session records', async () => {
    const { browser, adapter } = await fixture();
    assert.equal(await adapter.isInternalWindow({ id: 50, type: 'popup', tabs: [{ url: browser.chrome.runtime.getURL('mru/popup.html') }] }), true);
    assert.equal(await adapter.isInternalWindow({ id: 51, type: 'popup', tabs: [{ url: 'https://normal-web-popup.test' }] }), false);
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const id = adapter.popupWindowId;
    await adapter.openSwitcher({ sourceWindowId: 2 });
    assert.equal(adapter.popupWindowId, id); assert.equal(adapter.popupContext.sourceWindowId, 2);
    assert.deepEqual(browser.state.windowToSession, { 1: 's', 2: 'other' });
    assert.equal(await adapter.isInternalWindow({ id }), true);
    const restarted = new MruChromeAdapter(browser.options()); await restarted.ready();
    assert.equal(restarted.popupWindowId, id); assert.equal(restarted.popupContext.sourceWindowId, 2);
});

test('stale source sessions and private-bound destinations are rejected before mounting', async () => {
    const { browser, adapter } = await fixture();
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 'gone', key: 'tab:b' }), /session/i);
    browser.windows.get(2).incognito = true;
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' }), /private/i);
    assert.equal(browser.tabs.size, 2);
});

test('external subtree deletion purges queued visits and captures only opted-in viewed tabs', async () => {
    const { browser, adapter } = await fixture();
    await adapter.observeCurrent(1);
    const removed = structuredClone(browser.node('s'));
    browser.root.children = browser.root.children.filter(node => node.id !== 's');
    await adapter.onBookmarksRemoved('s', { node: removed });
    assert.deepEqual(adapter.recencyStore.entries(), []);
    assert.deepEqual(await adapter.recoveryStore.list(), []);
    assert.equal(JSON.stringify(browser.chrome.storage.local.values).includes('https://a.test'), false);
});

test('Live Only state is shared per source window and survives worker reload', async () => {
    const { browser, adapter } = await fixture();
    await adapter.handleMessage({ type: 'MRU_SET_LIVE_ONLY', sourceWindowId: 1, value: true });
    assert.equal((await adapter.context(1)).liveOnly, true);
    assert.equal((await adapter.context(2)).liveOnly, false);
    const reloaded = new MruChromeAdapter(browser.options()); await reloaded.ready();
    assert.equal((await reloaded.context(1)).liveOnly, true);
});

test('a stale persisted window binding does not prevent reopening its saved session', async () => {
    const { browser, adapter } = await fixture();
    browser.windows.delete(2); browser.tabs.delete(22);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' });
    assert.equal(browser.state.windowToSession[1], 's');
    assert.equal([...browser.tabs.values()].filter(tab => tab.url === 'https://c.test').length, 1);
    const reopened = [...browser.tabs.values()].find(tab => tab.url === 'https://c.test');
    assert.ok(browser.windows.has(reopened.windowId));
});

test('simultaneous switcher invocations create one popup and the latest source wins', async () => {
    const { browser, adapter } = await fixture();
    await Promise.all([adapter.openSwitcher({ sourceWindowId: 1 }), adapter.openSwitcher({ sourceWindowId: 2 })]);
    assert.equal(browser.windows.size, 3);
    assert.equal(adapter.popupContext.sourceWindowId, 2);
});

test('a command with optional tab omitted still advances an already focused switcher', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    browser.chrome.windows.getLastFocused = async () => browser.windows.get(adapter.popupWindowId);
    await adapter.command('open-mru-switcher');
    assert.equal(browser.messages.at(-1).type, 'MRU_ADVANCE');
    assert.equal(adapter.popupContext.sourceWindowId, 1);
});

test('external URL edits to saved tabs are mounted from canonical rather than cached metadata', async () => {
    const { browser, adapter } = await fixture();
    browser.node('b').url = 'https://edited.test/new';
    await adapter.refreshCatalog();
    assert.equal(adapter.service.catalog.get('b').url, 'https://edited.test/new');
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    assert.ok([...browser.tabs.values()].some(tab => tab.url === 'https://edited.test/new'));
    assert.equal([...browser.tabs.values()].some(tab => tab.url === 'https://b.test'), false);
});

test('externally moved unmounted identities are reacquired in the destination session', async () => {
    const { browser, adapter } = await fixture();
    const bookmark = browser.node('b');
    browser.node('s').children = browser.node('s').children.filter(node => node.id !== 'b');
    bookmark.parentId = 'other'; browser.node('other').children.push(bookmark);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    const native = [...browser.tabs.values()].find(tab => tab.url === 'https://b.test');
    assert.equal(native?.windowId, 2);
    assert.ok(browser.state.sessionsById.other.logicalTabs.some(tab => tab.bookmarkId === 'b' && tab.liveTabIds.includes(native.id)));
});

test('different concurrent targets share one newly opened saved-session window', async () => {
    const { browser, adapter } = await fixture();
    browser.node('closed').children.push({ id: 'e', parentId: 'closed', title: 'E', url: 'https://e.test' });
    await Promise.all(['d', 'e'].map(id => adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: `tab:${id}` })));
    const destinations = [...browser.windows.keys()].filter(id => browser.state.windowToSession[id] === 'closed');
    assert.equal(destinations.length, 1);
    assert.equal([...browser.tabs.values()].find(tab => tab.url === 'https://d.test').windowId, destinations[0]);
    assert.equal([...browser.tabs.values()].find(tab => tab.url === 'https://e.test').windowId, destinations[0]);
});

test('mounting in another existing window explicitly focuses its native destination', async () => {
    const { browser, adapter } = await fixture();
    const saved = browser.node('s').children.pop();
    saved.parentId = 'other'; browser.node('other').children.push(saved);
    await browser.options().refreshSession('other', 2);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' });
    assert.equal(browser.windows.get(2).focused, true);
    assert.equal(browser.windows.get(1).focused, false);
});

test('a mounted identity moved externally is focused rather than duplicated', async () => {
    const { browser, adapter } = await fixture();
    const bookmark = browser.node('a');
    browser.node('s').children = browser.node('s').children.filter(node => node.id !== 'a');
    bookmark.parentId = 'other'; browser.node('other').children.push(bookmark);
    await adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:a' });
    assert.equal([...browser.tabs.values()].filter(tab => tab.url === 'https://a.test').length, 1);
    assert.equal(browser.tabs.get(11).active, true);
});

test('source closure on a cold worker closes the persisted switcher after hydration', async () => {
    const { browser, adapter } = await fixture();
    await adapter.openSwitcher({ sourceWindowId: 1 });
    const popupId = adapter.popupWindowId;
    await browser.chrome.windows.remove(1);
    const cold = new MruChromeAdapter(browser.options());
    cold.windowRemoved(1); await cold.ready();
    assert.equal(browser.windows.has(popupId), false);
    assert.equal(cold.popupWindowId, null);
});

test('website popups are not collected or accepted as normal MRU sources', async () => {
    const { browser, adapter } = await fixture();
    browser.windows.get(1).type = 'popup';
    await adapter.observeCurrent(1);
    assert.deepEqual(adapter.recencyStore.entries(), []);
    await assert.rejects(adapter.context(1), /normal/i);
});

test('non-normal destination windows are rejected before either focus or mounting', async () => {
    const { browser, adapter } = await fixture();
    browser.windows.get(2).type = 'popup';
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:c' }), /normal/i);
    const bookmark = browser.node('b');
    browser.node('s').children = browser.node('s').children.filter(node => node.id !== 'b');
    browser.node('other').children.push(bookmark); bookmark.parentId = 'other';
    await assert.rejects(adapter.activate({ sourceWindowId: 1, sourceSessionId: 's', key: 'tab:b' }), /normal/i);
    assert.equal(browser.windows.get(1).focused, true);
    assert.equal(browser.tabs.size, 2);
});
