import test from 'node:test';
import assert from 'node:assert/strict';
import { listeners } from '../mock_chrome.js';
import { MemoryStorage } from './storage-fixture.mjs';

test('background routes MRU queries and excludes its UI from startup/session creation', async () => {
    chrome.runtime.getURL = path => `chrome-extension://fixture/${path}`;
    chrome.storage.local = new MemoryStorage();
    chrome.storage.session = new MemoryStorage();
    chrome.windows.get = async id => (await chrome.windows.getAll()).find(win => win.id === id);
    const root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
    const session = await chrome.bookmarks.create({ parentId: root.id, title: 'Session [windowId:1]' });
    const bookmark = await chrome.bookmarks.create({ parentId: session.id, title: 'A', url: 'https://a.test' });
    await chrome.windows.create({ id: 1, focused: true, type: 'normal' });
    await chrome.tabs.create({ id: 11, windowId: 1, url: 'https://a.test', title: 'A', active: true, groupId: -1 });
    await chrome.windows.create({ id: 99, focused: false, type: 'popup' });
    await chrome.tabs.create({ id: 991, windowId: 99, url: chrome.runtime.getURL('mru/popup.html?sourceWindowId=1'), active: true, groupId: -1 });
    await import('../../src/background.js');
    await listeners.onInstalled();
    const message = value => Promise.race([
        new Promise(resolve => listeners.onMessage(value, {}, resolve)),
        new Promise(resolve => setTimeout(() => resolve({ error: 'No MRU handler' }), 150))
    ]);
    const result = await message({ type: 'MRU_QUERY', sourceWindowId: 1 });
    assert.ok(Array.isArray(result.items), JSON.stringify(result));
    const sessions = await message({ type: 'GET_SESSION_LIST' });
    assert.equal(sessions.sessions.length, 1, 'Switcher UI must not become a saved session');
    const allBookmarks = await chrome.bookmarks.getSubTree(root.id);
    assert.equal(JSON.stringify(allBookmarks).includes('chrome-extension://'), false);
    const target = { ...result.context, key: `tab:${bookmark.id}` };
    assert.deepEqual(await message({ ...target, type: 'MRU_UNMOUNT' }), { success: true });
    assert.equal((await chrome.tabs.query({ windowId: 1 })).length, 0, 'MRU must invoke the native unmount lifecycle');
    assert.equal((await chrome.bookmarks.get(bookmark.id))[0].id, bookmark.id, 'unmount must preserve the bookmark');
    assert.deepEqual(await message({ ...target, type: 'MRU_DELETE' }), { success: true });
    assert.deepEqual(await chrome.bookmarks.get(bookmark.id), []);
});
