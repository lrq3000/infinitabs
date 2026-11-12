import { MemoryStorage } from './storage-fixture.mjs';

export class BrowserFixture {
    constructor() {
        this.windows = new Map([[1, { id: 1, type: 'normal', focused: true, incognito: false }], [2, { id: 2, type: 'normal', focused: false, incognito: false }]]);
        this.tabs = new Map([[11, { id: 11, windowId: 1, active: true, url: 'https://a.test', groupId: -1 }], [22, { id: 22, windowId: 2, active: true, url: 'https://c.test', groupId: -1 }]]);
        this.root = { id: 'root', title: 'InfiniTabs Sessions', children: [
            { id: 's', title: 'Source', children: [{ id: 'a', parentId: 's', title: 'A', url: 'https://a.test' }, { id: 'b', parentId: 's', title: 'B', url: 'https://b.test' }] },
            { id: 'other', title: 'Other', children: [{ id: 'c', parentId: 'other', title: 'C', url: 'https://c.test' }] },
            { id: 'closed', title: 'Saved', children: [{ id: 'd', parentId: 'closed', title: 'D', url: 'https://d.test' }] }
        ] };
        this.state = { windowToSession: { 1: 's', 2: 'other' }, sessionsById: {}, tabToLogical: { 11: 'logical-a', 22: 'logical-c' } };
        this.listeners = {};
        this.messages = [];
        const event = name => ({ addListener: fn => { (this.listeners[name] ??= []).push(fn); } });
        this.chrome = {
            runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, sendMessage: async message => { this.messages.push(message); } },
            storage: { local: new MemoryStorage(), session: new MemoryStorage() },
            bookmarks: {
                create: async values => {
                    const parent = this.node(values.parentId);
                    if (!parent) throw new Error('Parent folder missing');
                    const node = { ...values, id: `created-${this.nextBookmarkId = (this.nextBookmarkId || 0) + 1}`, index: parent.children.length };
                    parent.children.push(node); return structuredClone(node);
                },
                getSubTree: async id => this.node(id) ? [structuredClone(this.node(id))] : [],
                get: async id => this.node(id) ? [structuredClone(this.node(id))] : [],
                onCreated: event('created'), onChanged: event('changed'), onMoved: event('moved'), onRemoved: event('removed')
            },
            windows: {
                get: async id => { const value = this.windows.get(id); if (!value) throw new Error('Window closed'); return structuredClone(value); },
                getAll: async () => [...this.windows.values()].map(win => ({ ...win, tabs: [...this.tabs.values()].filter(tab => tab.windowId === win.id) })),
                update: async (id, values) => { if (values.focused) for (const win of this.windows.values()) win.focused = false; Object.assign(this.windows.get(id), values); },
                create: async values => {
                    const id = Math.max(...this.windows.keys()) + 1;
                    this.windows.set(id, { id, type: values.type || 'normal', focused: Boolean(values.focused), incognito: false });
                    const tab = { id: id * 100, windowId: id, url: values.url, active: true, groupId: -1 }; this.tabs.set(tab.id, tab);
                    return { ...this.windows.get(id), tabs: [tab] };
                },
                remove: async id => { this.windows.delete(id); for (const tab of this.tabs.values()) if (tab.windowId === id) this.tabs.delete(tab.id); },
                onFocusChanged: event('focus')
            },
            tabs: {
                get: async id => { const tab = this.tabs.get(id); if (!tab) throw new Error('Tab closed'); return { ...tab }; },
                update: async (id, values) => {
                    const tab = this.tabs.get(id); if (!tab) throw new Error('Tab closed');
                    if (values.active) for (const other of this.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
                    Object.assign(tab, values); return { ...tab };
                },
                query: async query => [...this.tabs.values()].filter(tab => (query.windowId === undefined || query.windowId === tab.windowId) && (query.active === undefined || query.active === tab.active)),
                remove: async id => { for (const value of [id].flat()) this.tabs.delete(value); }
            },
            commands: { onCommand: event('command') }
        };
        this.bind(1, 's'); this.bind(2, 'other');
        this.state.sessionsById.s.logicalTabs[0].liveTabIds = [11];
        this.state.sessionsById.other.logicalTabs[0].liveTabIds = [22];
    }

    node(id, parent = this.root) {
        if (parent.id === id) return parent;
        for (const child of parent.children || []) { const found = this.node(id, child); if (found) return found; }
        return null;
    }

    bind(windowId, sessionId) {
        const folder = this.node(sessionId);
        this.state.windowToSession[windowId] = sessionId;
        this.state.sessionsById[sessionId] = { sessionId, windowId, logicalTabs: folder.children.filter(node => node.url).map(node => ({ bookmarkId: node.id, logicalId: `logical-${node.id}`, sessionId, url: node.url, title: node.title, liveTabIds: [] })) };
    }

    async mount(windowId, logicalId) {
        const logical = this.state.sessionsById[this.state.windowToSession[windowId]].logicalTabs.find(tab => tab.logicalId === logicalId);
        const wasMounted = logical.liveTabIds.length > 0;
        if (!logical.liveTabIds.length) {
            const id = Math.max(...this.tabs.keys()) + 1;
            this.tabs.set(id, { id, windowId, url: logical.url, active: false, groupId: -1 });
            logical.liveTabIds = [id]; this.state.tabToLogical[id] = logicalId;
        }
        for (const tab of this.tabs.values()) if (tab.windowId === windowId) tab.active = tab.id === logical.liveTabIds[0];
        // Match the real background helper: only its ALREADY-mounted branch focuses a window. The MRU adapter must supply focus after creating an unmounted projection.
        if (wasMounted) await this.chrome.windows.update(windowId, { focused: true });
    }

    options() {
        return { chrome: this.chrome, initialize: async () => {}, getState: () => this.state, getRoot: async () => 'root', focusOrMount: this.mount.bind(this), bindSession: this.bind.bind(this), refreshSession: async (sessionId, windowId) => {
            const previous = new Map(this.state.sessionsById[sessionId].logicalTabs.map(tab => [tab.bookmarkId, tab.liveTabIds]));
            this.bind(windowId, sessionId);
            for (const logical of this.state.sessionsById[sessionId].logicalTabs) logical.liveTabIds = previous.get(logical.bookmarkId) || [];
        } };
    }
}
