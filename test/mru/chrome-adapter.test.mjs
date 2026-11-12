import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserFixture } from './browser-fixture.mjs';
import { MruChromeAdapter } from '../../src/mru/chrome-adapter.js';

async function fixture() {
    assert.equal(typeof MruChromeAdapter, 'function', 'Chrome adapter must be implemented');
    const browser = new BrowserFixture();
    const adapter = new MruChromeAdapter(browser.options());
    adapter.start(); await adapter.ready();
    return { browser, adapter };
}

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
