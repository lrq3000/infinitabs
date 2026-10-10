// Test-only event scheduling around the existing Chrome mock. Native reads return
// snapshots and missing native identities reject, as the real Chrome APIs do.
// No production state is exported or modified; tests drive listeners/messages.
const assert = require('node:assert/strict');

class GroupLifecycleFixture {
    async prepare(count = 20) {
        this.listeners = (await import('./mock_chrome.js')).listeners;
        this.tabs = new Map();
        this.groups = new Map();
        this.sessions = new Map();
        this.nextId = 100;
        this.hooks = {};
        this.calls = { children: 0, group: 0 };
        this.reads = { subTrees: new Map(), tabs: new Map(), groups: new Map() };
        let bookmarkId = 0, logicalId = 0;
        const create = chrome.bookmarks.create;
        chrome.bookmarks.create = async data => {
            await this.hook('create', data);
            const node = await create({ ...data, id: String(++bookmarkId) });
            const siblings = await chrome.bookmarks.getChildren(node.parentId);
            siblings.forEach((sibling, index) => { sibling.index = index; });
            return structuredClone(node);
        };
        for (const method of ['get', 'getChildren', 'getSubTree']) {
            const original = chrome.bookmarks[method];
            chrome.bookmarks[method] = async id => {
                if (method === 'getChildren') this.calls.children++;
                if (method === 'getSubTree') this.reads.subTrees.set(id, (this.reads.subTrees.get(id) || 0) + 1);
                await this.hook(method, id);
                const snapshot = structuredClone(await original(id));
                await this.hook(`after${method}`, { id, snapshot });
                return snapshot;
            };
        }
        const update = chrome.bookmarks.update;
        chrome.bookmarks.update = async (id, data) => {
            await this.hook('update', { id, data });
            const snapshot = structuredClone(await update(id, data));
            await this.hook('updated', { id, data });
            return snapshot;
        };
        self.crypto.randomUUID = () => `lifecycle-${++logicalId}`;
        chrome.tabs.get = async id => {
            await this.hook('tab', id);
            assert.ok(this.tabs.has(id), `No tab ${id}`);
            return structuredClone(this.tabs.get(id));
        };
        chrome.tabs.query = async query => {
            this.reads.tabs.set(query.windowId, (this.reads.tabs.get(query.windowId) || 0) + 1);
            await this.hook('query', query);
            return structuredClone([...this.tabs.values()].filter(tab => Object.entries(query)
                .every(([key, value]) => tab[key] === value)).sort((a, b) => a.index - b.index));
        };
        chrome.tabGroups.get = async id => {
            this.calls.group++;
            this.reads.groups.set(id, (this.reads.groups.get(id) || 0) + 1);
            await this.hook('group', id);
            assert.ok(this.groups.has(id), `No native group ${id}`);
            return structuredClone(this.groups.get(id));
        };
        chrome.tabs.remove = async ids => {
            for (const id of [].concat(ids)) await this.close(id);
        };
        const root = await chrome.bookmarks.create({ title: 'InfiniTabs Sessions' });
        for (let windowId = 1; windowId <= count; windowId++) {
            await chrome.windows.create({ id: windowId, type: 'normal' });
            this.sessions.set(windowId, (await chrome.bookmarks.create({ parentId: root.id,
                title: `Lifecycle [windowId:${windowId}]` })).id);
        }
        return this;
    }

    async hook(name, arg) {
        if (this.hooks[name]) await this.hooks[name](arg);
    }

    async start(beforeInit = () => {}, backgroundSource) {
        if (backgroundSource) {
            // Baseline/negative probes execute the actual module body in memory.
            // Only relative import URLs are relocated; no production file changes.
            const { pathToFileURL } = require('node:url');
            const base = pathToFileURL(require('node:path').resolve(__dirname, '../src/background.js'));
            const source = backgroundSource.replace(/from '(\.\/[^']+)'/g,
                (_, relative) => `from '${new URL(relative, base).href}'`);
            await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
        } else await import('../src/background.js');
        const pending = beforeInit();
        await this.listeners.onInstalled();
        await pending;
    }

    send(message) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Message timeout: ${message.type}`)), 6000);
            this.listeners.onMessage(message, {}, response => { clearTimeout(timeout); resolve(structuredClone(response)); });
        });
    }

    async session(windowId) {
        return (await this.send({ type: 'GET_CURRENT_SESSION_STATE', windowId })).session;
    }

    addGroup(windowId, title = 'Saved group', color = 'blue') {
        const group = { id: ++this.nextId, windowId, title, color };
        this.groups.set(group.id, group);
        return group;
    }

    addTab(windowId, groupId = -1, updates = {}) {
        const id = ++this.nextId;
        const tab = { id, windowId, groupId, index: [...this.tabs.values()].filter(t => t.windowId === windowId).length,
            active: false, title: `Tab ${id}`, url: `https://example.test/${id}`, ...updates };
        this.tabs.set(id, tab);
        return tab;
    }

    async createTab(windowId, groupId = -1, updates = {}) {
        const tab = this.addTab(windowId, groupId, updates);
        await this.listeners['tabs.onCreated'](structuredClone(tab));
        return tab;
    }

    async close(id, groupFirst = false) {
        const tab = this.tabs.get(id);
        this.tabs.delete(id);
        const group = this.groups.get(tab.groupId);
        const removed = group && ![...this.tabs.values()].some(t => t.groupId === group.id);
        if (removed) this.groups.delete(group.id);
        if (removed && groupFirst) await this.listeners['tabGroups.onRemoved'](structuredClone(group));
        await this.listeners['tabs.onRemoved'](id, { windowId: tab.windowId, isWindowClosing: false });
        if (removed && !groupFirst) await this.listeners['tabGroups.onRemoved'](structuredClone(group));
    }

    async folder(windowId, title = 'Saved group [blue]', urls = []) {
        const folder = await chrome.bookmarks.create({ parentId: this.sessions.get(windowId), title });
        for (const url of urls) await chrome.bookmarks.create({ parentId: folder.id, title: 'Saved history', url });
        return folder;
    }

    async folders(windowId) {
        return (await chrome.bookmarks.getChildren(this.sessions.get(windowId))).filter(node => !node.url);
    }

    async logical(tab) {
        return (await this.session(tab.windowId)).logicalTabs.find(logical => logical.liveTabIds.includes(tab.id));
    }

    static gate() {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        return { promise, release };
    }

    static async until(condition, message, timeout = 5000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const result = await condition();
            if (result) return result;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out: ${message}`);
    }
}

module.exports = { GroupLifecycleFixture };
