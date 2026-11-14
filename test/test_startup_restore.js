const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Each case gets a fresh MV3 module/global environment. Chrome APIs are the test boundary: production initialization, import, messages and MRU remain real.
class StartupFixture {
    async prepare({ reload = true, blank = false, pending = false } = {}) {
        this.listeners = (await import('./mock_chrome.js')).listeners;
        this.windows = new Map([[1, { id: 1, type: 'normal', state: 'normal' }]]);
        this.tabs = new Map();
        this.events = new Set();
        this.hooks = {};
        this.nextWindow = 1;
        this.nextTab = 10;
        this.worker = 0;
        let bookmark = 0, logical = 0;
        const create = chrome.bookmarks.create;
        chrome.bookmarks.create = async data => structuredClone(await create({ ...data, id: String(++bookmark) }));
        for (const method of ['get', 'getSubTree', 'getChildren']) {
            const original = chrome.bookmarks[method];
            chrome.bookmarks[method] = async id => structuredClone(await original(id));
        }
        self.crypto.randomUUID = () => `startup-${++logical}`;
        chrome.runtime.getURL = file => `chrome-extension://fixture/${file}`;
        const storage = () => ({
            values: {},
            async get(keys) {
                const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || this.values);
                return structuredClone(Object.fromEntries(names.filter(key => key in this.values).map(key => [key, this.values[key]])));
            },
            async set(values) { Object.assign(this.values, structuredClone(values)); }
        });
        chrome.storage.local = storage();
        chrome.storage.session = storage();
        chrome.windows.getAll = async ({ populate } = {}) => [...this.windows.values()].map(win => ({
            ...win, ...(populate ? { tabs: [...this.tabs.values()].filter(tab => tab.windowId === win.id).map(tab => ({ ...tab })) } : {})
        }));
        chrome.windows.get = async id => {
            assert.ok(this.windows.has(id), `Window ${id} has closed`);
            return { ...this.windows.get(id) };
        };
        chrome.windows.create = async data => {
            const win = this.addWindow(data);
            const tab = this.addTab(win.id, data.url || 'chrome://newtab/');
            this.emit('windows.onCreated', { ...win });
            this.emit('tabs.onCreated', { ...tab });
            if (this.hooks.created) await this.hooks.created(win);
            return { ...win, tabs: [{ ...tab }] };
        };
        chrome.windows.update = async (id, data) => Object.assign(this.windows.get(id), data);
        chrome.windows.remove = async id => {
            if (this.hooks.remove) await this.hooks.remove(id);
            for (const tab of [...this.tabs.values()]) if (tab.windowId === id) {
                this.tabs.delete(tab.id);
                this.emit('tabs.onRemoved', tab.id, { windowId: id, isWindowClosing: true });
            }
            this.windows.delete(id);
            this.emit('windows.onRemoved', id);
        };
        chrome.tabs.query = async query => {
            if (this.hooks.query) await this.hooks.query(query);
            return [...this.tabs.values()].filter(tab => Object.entries(query).every(([key, value]) =>
                key === 'url' ? tab.url === value : tab[key] === value)).map(tab => ({ ...tab }));
        };
        chrome.tabs.get = async id => {
            if (!this.tabs.has(id)) throw new Error(`Tab ${id} has closed`);
            return { ...this.tabs.get(id) };
        };
        chrome.tabs.create = async data => {
            const tab = this.addTab(data.windowId, data.url, data);
            this.emit('tabs.onCreated', { ...tab });
            return { ...tab };
        };
        chrome.tabs.remove = async ids => {
            for (const id of [ids].flat()) {
                const tab = this.tabs.get(id);
                if (!tab) continue;
                this.tabs.delete(id);
                this.emit('tabs.onRemoved', id, { windowId: tab.windowId, isWindowClosing: false });
            }
        };
        chrome.tabs.update = async (id, data) => {
            const tab = this.tabs.get(id);
            Object.assign(tab, data);
            this.emit('tabs.onUpdated', id, data, { ...tab });
            return { ...tab };
        };
        this.root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
        this.folder = await chrome.bookmarks.create({ parentId: this.root.id, title: 'Saved [windowId:1]' });
        for (const url of ['https://example.test/a', 'https://example.test/b', ...(blank ? ['about:blank'] : [])]) {
            await chrome.bookmarks.create({ parentId: this.folder.id, title: url, url });
            this.addTab(1, pending ? '' : url, pending ? { pendingUrl: url } : {});
        }
        this.original = await this.saved();
        this.snapshot = { id: 'last', sessions: [{ sessionId: this.folder.id, windowId: 1 }], isTrivial: false };
        await chrome.storage.local.set({ windowToSession: { 1: this.folder.id }, reloadOnRestart: reload,
            lastKnownWorkspace: this.snapshot, workspaceHistory: [this.snapshot] });
        await this.loadWorker();
        return this;
    }

    addWindow(data = {}) {
        const win = { id: ++this.nextWindow, type: 'normal', state: 'normal', ...data };
        this.windows.set(win.id, win);
        return win;
    }

    addTab(windowId, url, data = {}) {
        const siblings = [...this.tabs.values()].filter(tab => tab.windowId === windowId);
        const tab = { id: ++this.nextTab, windowId, url, title: url || 'Loading', active: !siblings.length,
            index: siblings.length, groupId: -1, ...data };
        this.tabs.set(tab.id, tab);
        return tab;
    }

    emit(name, ...args) {
        const result = Promise.resolve(this.listeners[name]?.(...args));
        this.events.add(result);
        result.finally(() => this.events.delete(result)).catch(() => {});
        return result;
    }

    async drain() {
        while (this.events.size) await Promise.all([...this.events]);
    }

    async loadWorker() { await import(`../src/background.js?startup-test=${++this.worker}`); }
    saved() { return chrome.bookmarks.getChildren(this.folder.id); }
    send(message) { return new Promise(resolve => this.listeners.onMessage(message, {}, resolve)); }
    async session(windowId) { return (await this.send({ type: 'GET_CURRENT_SESSION_STATE', windowId })).session; }

    async restored() {
        await this.drain();
        assert.deepEqual(await this.saved(), this.original, 'Restoration must not add, remove, rename or reorder saved bookmarks');
        assert.equal(this.windows.has(1), false, 'Successful replacement closes the original window');
        const liveWindow = [...this.windows.keys()][0];
        const session = await this.session(liveWindow);
        assert.equal(session.sessionId, this.folder.id);
        assert.ok(session.logicalTabs.every(tab => tab.liveTabIds.length === 0), 'All saved tabs, including legitimate blanks, remain unmounted');
        return { liveWindow, session };
    }
}

const cases = {
    async 'multiple windows preserve groups and an empty saved session'() {
        const f = await new StartupFixture().prepare();
        const group = await chrome.bookmarks.create({ parentId: f.folder.id, title: 'Saved research [blue]' });
        await chrome.bookmarks.create({ parentId: group.id, title: 'Same URL in a group', url: 'https://example.test/a' });
        f.original = await f.saved();
        const originalEmpty = f.addWindow();
        f.addTab(originalEmpty.id, 'about:blank');
        const empty = await chrome.bookmarks.create({ parentId: f.root.id, title: `Empty [windowId:${originalEmpty.id}]` });
        f.snapshot.sessions.push({ sessionId: empty.id, windowId: originalEmpty.id });
        await chrome.storage.local.set({ lastKnownWorkspace: f.snapshot, workspaceHistory: [f.snapshot],
            windowToSession: { 1: f.folder.id, [originalEmpty.id]: empty.id } });
        await f.listeners.onStartup();
        await f.restored();
        assert.equal(f.windows.size, 2);
        assert.equal(f.windows.has(originalEmpty.id), false);
        const sessions = await Promise.all([...f.windows.keys()].map(id => f.session(id)));
        assert.deepEqual(sessions.find(session => session.sessionId === empty.id).logicalTabs, []);
        assert.equal(sessions.find(session => session.sessionId === f.folder.id).groups[group.id].title, 'Saved research [blue]');
    },
    async 'repeated browser lifetimes never grow saved sessions'() {
        const f = await new StartupFixture().prepare();
        for (let restart = 0; restart < 3; restart++) {
            if (restart) {
                chrome.storage.session.values = {}; // A browser lifetime boundary, not a worker suspension.
                await f.loadWorker();
            }
            await f.listeners.onStartup();
            await f.restored();
            assert.equal(f.windows.size, 1);
        }
        assert.equal(f.nextWindow, 4);
    },
    async 'startup excludes its own placeholder'() {
        const f = await new StartupFixture().prepare();
        await f.listeners.onStartup();
        await f.restored();
    },
    async 'tab event before startup restores only once'() {
        const f = await new StartupFixture().prepare();
        const first = f.emit('tabs.onCreated', { ...f.tabs.values().next().value });
        await first;
        await f.listeners.onStartup();
        await f.restored();
        assert.equal(f.nextWindow, 2, 'Late runtime startup must not restore the workspace a second time');
    },
    async 'late original tab events cannot duplicate saved URLs'() {
        const f = await new StartupFixture().prepare();
        f.hooks.remove = async id => {
            if (id === 1) for (const tab of f.tabs.values()) if (tab.windowId === 1) f.emit('tabs.onCreated', { ...tab });
        };
        await f.listeners.onStartup();
        await f.restored();
    },
    async 'saved blanks and repeated URLs retain their identities'() {
        const f = await new StartupFixture().prepare({ blank: true });
        await chrome.bookmarks.create({ parentId: f.folder.id, title: 'Intentional second A', url: 'https://example.test/a' });
        f.original = await f.saved();
        await f.listeners.onStartup();
        await f.restored();
    },
    async 'pending URLs reconcile without extra blank bookmarks'() {
        const f = await new StartupFixture().prepare({ reload: false, pending: true });
        await f.listeners.onStartup();
        await f.drain();
        assert.deepEqual(await f.saved(), f.original, 'Use the pending navigation URL instead of inventing blank saved tabs');
        const session = await f.session(1);
        assert.ok(session.logicalTabs.every(tab => tab.liveTabIds.length === 1));
    },
    async 'worker wake retains restored binding and new live tabs'() {
        const f = await new StartupFixture().prepare();
        await f.listeners.onStartup();
        const { liveWindow } = await f.restored();
        await f.loadWorker();
        const session = await f.session(liveWindow);
        assert.equal(session.sessionId, f.folder.id, 'A bridge-only window must retain its session across worker suspension');
        const tab = await chrome.tabs.create({ windowId: liveWindow, url: 'https://example.test/new' });
        await f.drain();
        const after = await f.session(liveWindow);
        assert.equal(after.logicalTabs.filter(logical => logical.liveTabIds.includes(tab.id)).length, 1);
        assert.ok([...f.tabs.values()].every(native => !native.url.includes('bridge=workspace')), 'A real tab replaces the workspace bridge');
        await f.loadWorker();
        const awake = await f.session(liveWindow);
        assert.equal(awake.logicalTabs.filter(logical => logical.liveTabIds.includes(tab.id)).length, 1);
        assert.equal(f.nextWindow, 2, 'Worker restart must not trigger browser-startup restoration');
    },
    async 'installation is not browser-startup restoration'() {
        const f = await new StartupFixture().prepare();
        await f.listeners.onInstalled({ reason: 'update' });
        await f.drain();
        assert.equal(f.windows.has(1), true);
        assert.deepEqual(await f.saved(), f.original);
    },
    async 'late binding and tab creation share one import'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'install' });
        const win = f.addWindow();
        const native = f.addTab(win.id, 'https://example.test/new');
        f.hooks.query = async query => {
            if (query.windowId !== win.id || query.active !== undefined) return;
            f.hooks.query = null;
            f.emit('tabs.onCreated', { ...native });
        };
        await f.session(win.id);
        await f.drain();
        const session = await f.session(win.id);
        assert.equal(session.logicalTabs.length, 1, 'Initial reconciliation and onCreated must not save the same native tab twice');
        assert.deepEqual(session.logicalTabs[0].liveTabIds, [native.id]);
    },
    async 'unrelated user window is captured during restoration'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'install' });
        let user;
        f.hooks.created = async () => {
            f.hooks.created = null;
            user = await chrome.windows.create({ url: 'https://example.test/user' });
        };
        await f.send({ type: 'RESTORE_WORKSPACE', snapshot: f.snapshot });
        await f.drain();
        const session = await f.session(user.id);
        assert.equal(session.logicalTabs.length, 1);
        assert.equal(session.logicalTabs[0].url, 'https://example.test/user');
    },
    async 'missing session never closes original windows'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'install' });
        const snapshot = { id: 'missing', sessions: [{ sessionId: 'missing', windowId: 1 }] };
        const response = await f.send({ type: 'RESTORE_WORKSPACE', snapshot });
        await f.drain();
        assert.ok(response.error, 'Restoration must report an unavailable saved session');
        assert.equal(f.windows.has(1), true, 'Failure must retain original tabs/windows');
        assert.deepEqual((await chrome.storage.local.get('lastKnownWorkspace')).lastKnownWorkspace, f.snapshot);
    },
    async 'clean shutdown retains the auto-reload workspace'() {
        const f = await new StartupFixture().prepare();
        await f.listeners.onInstalled({ reason: 'update' });
        await chrome.windows.remove(1);
        await f.drain();
        assert.deepEqual((await chrome.storage.local.get('lastKnownWorkspace')).lastKnownWorkspace, f.snapshot);
    },
    async 'clean shutdown without auto-reload still clears crash status'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'update' });
        await chrome.windows.remove(1);
        await f.drain();
        assert.equal((await chrome.storage.local.get('lastKnownWorkspace')).lastKnownWorkspace, null);
    },
    async 'failed binding cannot publish an intermediate workspace later'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'update' });
        const get = chrome.bookmarks.getSubTree;
        chrome.bookmarks.getSubTree = async id => {
            if (id === f.folder.id) throw new Error('Injected bookmark read failure');
            return get(id);
        };
        const response = await f.send({ type: 'RESTORE_WORKSPACE', snapshot: f.snapshot });
        assert.ok(response.error);
        await f.drain();
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(f.windows.has(1), true);
        assert.deepEqual((await chrome.storage.local.get('lastKnownWorkspace')).lastKnownWorkspace, f.snapshot,
            'A failed restore must cancel pre-existing and intermediate history publication');
    },
    async 'failed import does not release another native import early'() {
        const f = await new StartupFixture().prepare({ reload: false });
        await f.listeners.onInstalled({ reason: 'install' });
        const win = f.addWindow();
        const first = f.addTab(win.id, 'https://example.test/first');
        const second = f.addTab(win.id, 'https://example.test/second');
        let releaseFirst, releaseSecond, enteredFirst = false, enteredSecond = false, firstEvent;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const secondGate = new Promise(resolve => { releaseSecond = resolve; });
        const create = chrome.bookmarks.create;
        chrome.bookmarks.create = async data => {
            if (data.url === first.url && !enteredFirst) {
                enteredFirst = true;
                await firstGate;
                throw new Error('Injected first-tab import failure');
            }
            if (data.url === second.url && !enteredSecond) {
                enteredSecond = true;
                await secondGate;
            }
            return create(data);
        };
        f.hooks.query = async query => {
            if (query.windowId !== win.id || query.active !== undefined) return;
            f.hooks.query = null;
            firstEvent = f.emit('tabs.onCreated', { ...first });
            f.emit('tabs.onCreated', { ...second });
        };
        const binding = f.session(win.id);
        while (!enteredFirst || !enteredSecond) await new Promise(resolve => setImmediate(resolve));
        releaseFirst();
        await firstEvent.catch(() => {});
        // Drain the first failure's microtasks while the second import is still deliberately held. A batch must wait for ALL owned IDs, not fail-fast.
        await new Promise(resolve => setImmediate(resolve));
        releaseSecond();
        await binding;
        await f.drain();
        const session = await f.session(win.id);
        assert.equal(session.logicalTabs.length, 2, 'One failed dependency must not let reconciliation race a still-pending writer');
        assert.equal(session.logicalTabs.filter(tab => tab.liveTabIds.includes(second.id)).length, 1);
    }
};

if (process.argv[2]) {
    const timer = setTimeout(() => { console.error('Startup regression deadlocked'); process.exit(1); }, 8000);
    cases[process.argv[2]]().then(() => { clearTimeout(timer); process.exit(0); }, error => {
        console.error(error); process.exit(1);
    });
} else {
    for (const name of Object.keys(cases)) test(name, () => {
        const result = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8', timeout: 12000 });
        assert.equal(result.status, 0, `${name}\n${result.stdout}\n${result.stderr}`);
    });
}
