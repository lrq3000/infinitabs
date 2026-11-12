import { RecencyStore, RecoveryStore } from './store.js';
import { MruService } from './service.js';

// Chrome-specific effects live here; the stores, search and view do not own native tabs or bookmark placement.
export class MruChromeAdapter {
    constructor({ chrome, initialize, getState, getRoot, focusOrMount, bindSession, refreshSession }) {
        Object.assign(this, { chrome, initialize, getState, getRoot, focusOrMount, bindSession, refreshSession });
        this.recencyStore = new RecencyStore({ storage: chrome.storage.local });
        this.recoveryStore = new RecoveryStore({ storage: chrome.storage.local });
        this.service = new MruService({ recencyStore: this.recencyStore, recoveryStore: this.recoveryStore });
        this.internalWindows = new Set();
        this.privateWindows = new Set();
        this.logicalIndexes = new WeakMap();
        this.activations = new Map();
        this.sessionActivations = new Map();
        this.windowUi = new Map();
        this.openQueue = Promise.resolve();
        this.popupWindowId = null;
        this.popupContext = null;
        this.loading = null;
    }

    start() {
        // Register before waiting for initialization: MV3 can wake for any one of these events.
        this.chrome.windows.onFocusChanged?.addListener(windowId => {
            if (windowId >= 0) this.run(this.observeCurrent(windowId));
        });
        this.chrome.bookmarks.onRemoved?.addListener((id, info) => this.run(this.onBookmarksRemoved(id, info)));
        for (const event of ['onCreated', 'onChanged', 'onMoved']) this.chrome.bookmarks[event]?.addListener(() => this.scheduleRefresh());
        this.chrome.commands?.onCommand.addListener((command, tab) => this.run(this.command(command, tab)));
    }

    run(promise) { promise.catch(error => { console.warn('InfiniTabs MRU:', error.message); this.broadcast({ type: 'MRU_ERROR', error: error.message }); }); }
    broadcast(message = { type: 'MRU_UPDATED' }) { this.chrome.runtime.sendMessage(message).catch(() => {}); }
    isInternalTab(tab) {
        const prefix = this.chrome.runtime.getURL?.('mru/');
        return Boolean(prefix && [tab?.url, tab?.pendingUrl].some(url => url?.startsWith(prefix)));
    }
    isInternalWindowId(id) { return this.internalWindows.has(id); }

    async isInternalWindow(window) {
        if (window.incognito) this.privateWindows.add(window.id);
        if (this.internalWindows.has(window.id)) return true;
        const tabs = window.tabs || await this.chrome.tabs.query({ windowId: window.id }).catch(() => []);
        const internal = tabs.length > 0 && tabs.every(tab => this.isInternalTab(tab));
        // A bridge starts as an internal-only NORMAL window, then becomes a real session window after binding/mounting. Only switcher popup windows stay excluded by ID.
        if (internal && window.type === 'popup') this.internalWindows.add(window.id);
        return internal;
    }

    ready() {
        if (!this.loading) this.loading = (async () => {
            await this.initialize();
            await Promise.all([this.recencyStore.ready(), this.recoveryStore.ready()]);
            const windows = await this.chrome.windows.getAll({ populate: true });
            for (const window of windows) {
                if (await this.isInternalWindow(window) && window.type === 'popup') this.popupWindowId = window.id;
            }
            const saved = await this.chrome.storage.session?.get('mru.switcher');
            this.popupContext = saved?.['mru.switcher'] || null;
            await this.refreshCatalog();
        })().catch(error => { this.loading = null; throw error; });
        return this.loading;
    }

    logicalForNative(tab) {
        const state = this.getState();
        const session = state.sessionsById[state.windowToSession[tab.windowId]];
        if (!session) return null;
        let index = this.logicalIndexes.get(session.logicalTabs);
        if (!index) {
            index = new Map(session.logicalTabs.map(logical => [logical.logicalId, logical]));
            this.logicalIndexes.set(session.logicalTabs, index);
        }
        return index.get(state.tabToLogical[tab.id]) || null;
    }

    async refreshCatalog() {
        const rootId = await this.getRoot();
        const roots = await this.chrome.bookmarks.getSubTree(rootId);
        const candidates = [];
        this.folderSessions = new Map(); // Disposable ownership index derived from canonical folders; no persisted placement metadata.
        const visit = (node, session, ancestors) => {
            if (node.url) candidates.push({ bookmarkId: node.id, title: node.title, url: node.url, sessionId: session.id, sessionName: session.title.replace(/ \[windowId:\d+\]$/, ''), ancestorIds: ancestors, liveTabIds: [] });
            else {
                this.folderSessions.set(node.id, session.id);
                for (const child of node.children || []) visit(child, session, [...ancestors, node.id]);
            }
        };
        for (const session of roots[0]?.children || []) if (!session.url) visit(session, session, [rootId]);
        this.service.setCatalog(candidates);
        this.syncLiveCatalog();
        const missing = this.recencyStore.entries().filter(record => !this.service.catalog.has(record.bookmarkId)).map(record => record.bookmarkId);
        await this.recencyStore.forget(missing);
    }

    syncLiveCatalog() {
        for (const candidate of this.service.catalog.values()) { candidate.liveTabIds = []; candidate.private = false; }
        const state = this.getState();
        for (const [windowId, sessionId] of Object.entries(state.windowToSession)) {
            for (const logical of state.sessionsById[sessionId]?.logicalTabs || []) {
                const candidate = this.service.catalog.get(logical.bookmarkId);
                if (!candidate) continue;
                candidate.liveTabIds = logical.liveTabIds || [];
                candidate.windowId = Number(windowId);
                candidate.private = this.privateWindows.has(Number(windowId));
            }
        }
    }

    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.run((async () => { await this.ready(); await this.refreshCatalog(); this.broadcast(); })()), 20);
    }

    async observeCurrent(windowId) {
        // Older test doubles do not implement focus. Do not infer viewing from tab.active alone: every background window has an active tab too.
        if (!this.chrome.windows.get || this.internalWindows.has(windowId)) return;
        await this.ready();
        const window = await this.chrome.windows.get(windowId).catch(() => null);
        if (!window?.focused || window.incognito || this.internalWindows.has(windowId)) return;
        const [tab] = await this.chrome.tabs.query({ windowId, active: true });
        if (!tab || this.isInternalTab(tab)) return;
        const logical = this.logicalForNative(tab);
        if (!logical) return;
        if (!this.service.catalog.has(logical.bookmarkId)) await this.refreshCatalog();
        await this.service.observeView({ bookmarkId: logical.bookmarkId, isFocused: true });
        this.broadcast();
    }

    stateChanged(windowId, sessionId) {
        if (this.popupContext?.sourceWindowId === windowId && this.popupContext.sourceSessionId !== sessionId) this.run(this.closeSwitcher());
        this.run(this.observeCurrent(windowId));
        this.broadcast();
    }

    async onBookmarksRemoved(id, info, consent = this.recoveryStore.consentAtReceipt()) {
        // Preserve minimal visit evidence BEFORE cold initialization prunes missing bookmarks. Chrome's removal event supplies the deleted title/URL, so no always-on deleted snapshot store is needed.
        await this.recencyStore.ready();
        const visits = new Map(this.recencyStore.entries().map(record => [record.bookmarkId, record]));
        const ownership = new Map([...this.service.catalog.values()].map(candidate => [candidate.bookmarkId, candidate.sessionId]));
        await this.ready();
        const removed = new Set([id]);
        const snapshots = new Map();
        const rootId = await this.getRoot();
        const walk = (node, sourceSessionId) => {
            if (!node) return;
            removed.add(node.id);
            const visit = visits.get(node.id);
            if (node.url && visit) snapshots.set(node.id, { title: node.title, url: node.url, sourceSessionId: ownership.get(node.id) || sourceSessionId, lastViewedAt: visit.lastViewedAt });
            for (const child of node.children || []) walk(child, node.id === rootId ? child.id : sourceSessionId);
        };
        walk(info?.node, this.folderSessions.get(info?.parentId) || (info?.parentId === rootId ? id : null));
        for (const candidate of this.service.catalog.values()) {
            if (!removed.has(candidate.bookmarkId) && !candidate.ancestorIds.some(parent => removed.has(parent))) continue;
            removed.add(candidate.bookmarkId);
            const visit = visits.get(candidate.bookmarkId);
            if (visit && !candidate.private) snapshots.set(candidate.bookmarkId, { title: candidate.title, url: candidate.url, sourceSessionId: candidate.sessionId, lastViewedAt: visit.lastViewedAt });
            if (candidate.private) snapshots.delete(candidate.bookmarkId);
            this.service.catalog.delete(candidate.bookmarkId);
        }
        // Purge first, before awaiting snapshot writes; in-flight native focus callbacks cannot revive a removed catalog member.
        await this.recencyStore.forget(removed);
        for (const snapshot of snapshots.values()) await this.recoveryStore.capture(snapshot, consent);
        await this.refreshCatalog();
        this.broadcast();
    }

    async context(sourceWindowId) {
        await this.ready();
        const window = await this.chrome.windows.get(Number(sourceWindowId));
        if (window.incognito) throw new Error('MRU is unavailable in private windows');
        if (await this.isInternalWindow(window)) throw new Error('Choose a browsing window first');
        const sourceSessionId = this.getState().windowToSession[window.id];
        if (!sourceSessionId) throw new Error('Source session is no longer available');
        const key = `mru.window.${window.id}`;
        const stored = await this.chrome.storage.session?.get(key);
        const liveOnly = stored?.[key]?.liveOnly ?? this.windowUi.get(window.id)?.liveOnly ?? false;
        const [active] = await this.chrome.tabs.query({ windowId: window.id, active: true });
        return { sourceWindowId: window.id, sourceSessionId, liveOnly, excludeBookmarkId: active ? this.logicalForNative(active)?.bookmarkId : null };
    }

    openSwitcher(request) {
        // Windows.create resolves after lifecycle events; queue requests so rapid shortcuts cannot both observe a missing popup and create duplicate windows.
        const operation = this.openQueue.then(() => this.openSwitcherNow(request));
        this.openQueue = operation.catch(() => {});
        return operation;
    }

    async openSwitcherNow({ sourceWindowId }) {
        const context = await this.context(sourceWindowId);
        this.popupContext = context;
        await this.chrome.storage.session?.set({ 'mru.switcher': context });
        if (this.popupWindowId) {
            try {
                await this.chrome.windows.update(this.popupWindowId, { focused: true });
                this.broadcast({ type: 'MRU_CONTEXT', context });
                return;
            } catch { this.internalWindows.delete(this.popupWindowId); this.popupWindowId = null; }
        }
        const window = await this.chrome.windows.create({ url: this.chrome.runtime.getURL(`mru/popup.html?sourceWindowId=${context.sourceWindowId}`), type: 'popup', width: 540, height: 530, focused: true });
        this.popupWindowId = window.id;
        this.internalWindows.add(window.id);
    }

    async closeSwitcher() {
        const id = this.popupWindowId;
        this.popupWindowId = null; this.popupContext = null;
        await this.chrome.storage.session?.remove('mru.switcher');
        if (id) await this.chrome.windows.remove(id).catch(() => {});
    }

    windowRemoved(id) {
        const internal = this.internalWindows.delete(id);
        this.privateWindows.delete(id); this.windowUi.delete(id);
        if (id === this.popupWindowId) { this.popupWindowId = null; this.popupContext = null; }
        if (this.popupContext?.sourceWindowId === id) this.run(this.closeSwitcher());
        return internal;
    }

    async activate(request) {
        await this.validateSource(request);
        if (!this.activations.has(request.key)) {
            const operation = this.activateTarget(request).finally(() => this.activations.delete(request.key));
            this.activations.set(request.key, operation);
        }
        return this.activations.get(request.key);
    }

    async activateTarget(request) {
        await this.refreshCatalog();
        await this.validateSource(request);
        if (request.key?.startsWith('deleted:')) return this.restoreDeleted({ ...request, recoveryId: request.key.slice(8) });
        if (!request.key?.startsWith('tab:')) throw new Error('Recovery entry is not available');
        const bookmarkId = request.key.slice(4);
        const candidate = this.service.catalog.get(bookmarkId);
        if (!candidate || !(await this.chrome.bookmarks.get(bookmarkId)).length) throw new Error('This logical tab no longer exists');
        // Target-key deduplication is insufficient when DIFFERENT tabs share an unopened session. Serialize discovery/binding/mounting per session; unrelated sessions and native window events remain independent.
        const sessionId = candidate.sessionId;
        const previous = this.sessionActivations.get(sessionId) || Promise.resolve();
        const operation = previous.catch(() => {}).then(() => this.activateInSession(request, bookmarkId, sessionId));
        this.sessionActivations.set(sessionId, operation);
        try { return await operation; }
        finally { if (this.sessionActivations.get(sessionId) === operation) this.sessionActivations.delete(sessionId); }
    }

    async activateInSession(request, bookmarkId, sessionId) {
        await this.refreshCatalog();
        await this.validateSource(request);
        const candidate = this.service.catalog.get(bookmarkId);
        if (!candidate || candidate.sessionId !== sessionId) throw new Error('The logical tab moved or was deleted; refresh and try again');
        if (await this.focusMountedCandidate(candidate, request)) return { success: true };
        const state = this.getState();
        // Persisted window IDs can outlive a browser window/restart. Validate against one native inventory instead of trusting the first historical binding or creating duplicates when a later binding is still alive.
        const nativeWindows = new Map((await this.chrome.windows.getAll()).map(window => [window.id, window]));
        let windowId = Number(Object.keys(state.windowToSession).find(id => state.windowToSession[id] === candidate.sessionId && nativeWindows.has(Number(id))));
        let bridgeIds = [];
        if (!windowId) {
            // The internal bridge URL identifies the new window from its FIRST event, before windows.create resolves. Binding imports no bridge bookmark and never suppresses unrelated windows.
            const window = await this.chrome.windows.create({ url: this.chrome.runtime.getURL('mru/popup.html?bridge=1'), type: 'normal', focused: false });
            windowId = window.id;
            bridgeIds = (window.tabs || await this.chrome.tabs.query({ windowId })).filter(tab => this.isInternalTab(tab)).map(tab => tab.id);
            await this.bindSession(windowId, candidate.sessionId);
        }
        const window = await this.chrome.windows.get(windowId);
        if (window.incognito) throw new Error('Cannot activate a private-window tab');
        // Search catalog and loaded session state can diverge after external bookmark edits/moves. Reconcile through the existing metadata-preserving lifecycle before resolving an ephemeral logical ID.
        await this.refreshSession(candidate.sessionId, windowId);
        // Reacquire identity after binding/reload; logical IDs are intentionally ephemeral.
        const logical = state.sessionsById[candidate.sessionId]?.logicalTabs.find(tab => tab.bookmarkId === bookmarkId);
        if (!logical) throw new Error('This logical tab is no longer available');
        await this.validateSource(request);
        await this.focusOrMount(windowId, logical.logicalId);
        const mounted = state.sessionsById[candidate.sessionId]?.logicalTabs.find(tab => tab.bookmarkId === bookmarkId);
        const native = mounted?.liveTabIds?.length ? await this.chrome.tabs.get(mounted.liveTabIds[0]).catch(() => null) : null;
        if (!native) throw new Error('Tab could not be mounted; retry from its session');
        // Chrome tabs.create({active:true}) selects within a window but does not focus an unfocused window. The existing helper supplies focus only in its already-mounted branch.
        await this.chrome.windows.update(windowId, { focused: true });
        if (bridgeIds.length) await this.chrome.tabs.remove(bridgeIds);
        await this.observeCurrent(windowId);
        return { success: true };
    }

    async focusMountedCandidate(candidate, request) {
        for (const tabId of candidate.liveTabIds || []) {
            const native = await this.chrome.tabs.get(tabId).catch(() => null);
            if (!native || this.logicalForNative(native)?.bookmarkId !== candidate.bookmarkId) continue;
            const window = await this.chrome.windows.get(native.windowId);
            if (window.incognito) throw new Error('Cannot activate a private-window tab');
            await this.validateSource(request);
            // An external bookmark move may have changed canonical ownership without relocating its existing native projection. Focus that projection, never create a duplicate just because the destination's loaded model was stale.
            await this.chrome.tabs.update(tabId, { active: true });
            await this.chrome.windows.update(native.windowId, { focused: true });
            await this.observeCurrent(native.windowId);
            return true;
        }
        return false;
    }

    async validateSource(request) {
        const context = await this.context(request.sourceWindowId);
        if (request.sourceSessionId !== context.sourceSessionId) throw new Error('Source session changed; reopen the switcher');
        return context;
    }

    async restoreDeleted(request) {
        const context = await this.validateSource(request);
        const record = (await this.recoveryStore.list()).find(entry => entry.recoveryId === request.recoveryId);
        if (!record) throw new Error('Recovery entry is no longer available');
        if (!/^(https?:|about:|chrome:|edge:|file:)/i.test(record.url)) throw new Error('This URL cannot be restored as a browser tab');
        let bookmarkId = record.restoredBookmarkId;
        if (record.restoring && !bookmarkId) throw new Error('A prior restoration has uncertain completion. Inspect the session before recovering this entry; it will not create another bookmark automatically.');
        if (bookmarkId) {
            await this.refreshCatalog();
            if (this.service.catalog.get(bookmarkId)?.sessionId !== context.sourceSessionId) throw new Error('Previously restored tab was deleted or moved to a different session; inspect that session before retrying');
        } else {
            const [folder] = await this.chrome.bookmarks.get(context.sourceSessionId);
            if (!folder || folder.url) throw new Error('Source session is no longer available');
            await this.validateSource(request);
            // Bookmark creation and local storage cannot share a transaction. Persist intent BEFORE the native effect so a cold worker fails closed if the identity journal is lost afterward.
            const attempt = { ...record, restoring: true };
            await this.recoveryStore.update(attempt);
            // No index/group snapshot exists: omitted index appends to the canonical session root.
            let bookmark;
            try { bookmark = await this.chrome.bookmarks.create({ parentId: context.sourceSessionId, title: record.title, url: record.url }); }
            catch (error) {
                // A rejected native API call created nothing. Clear intent when possible; a failed cleanup retains the conservative uncertain state across restart.
                await this.recoveryStore.update({ ...record, restoring: false });
                throw error;
            }
            bookmarkId = bookmark.id;
            try { await this.recoveryStore.update({ ...attempt, restoredBookmarkId: bookmarkId }); }
            catch { throw new Error('A restored bookmark was created, but recovery status could not be saved. Inspect the session before retrying.'); }
        }
        await this.validateSource(request);
        await this.refreshSession(context.sourceSessionId, context.sourceWindowId);
        await this.activateTarget({ ...context, key: `tab:${bookmarkId}` });
        await this.recoveryStore.remove(record.recoveryId);
        this.broadcast();
        return { success: true };
    }

    async command(command, tab) {
        if (!['open-mru-switcher', 'previous-mru-tab'].includes(command)) return;
        await this.ready();
        const sourceWindowId = tab?.windowId ?? (await this.chrome.windows.getLastFocused()).id;
        if (sourceWindowId === this.popupWindowId) { this.broadcast({ type: 'MRU_ADVANCE' }); return; }
        if (command === 'open-mru-switcher') return this.openSwitcher({ sourceWindowId });
        const context = await this.context(sourceWindowId);
        this.syncLiveCatalog();
        const result = await this.service.query({ ...context, limit: 1 });
        if (result.items.length) await this.activate({ ...context, key: result.items[0].key });
    }

    async handleMessage(message) {
        if (message.type === 'MRU_RECOVERY_STATUS' || message.type === 'MRU_RECOVERY_CONFIGURE') {
            await this.ready();
            if (message.type === 'MRU_RECOVERY_CONFIGURE') {
                if (typeof message.enabled !== 'boolean') throw new Error('Recovery opt-in must be explicit');
                await this.recoveryStore.configure(message.enabled);
                this.broadcast();
            }
            return { enabled: this.recoveryStore.enabled, count: (await this.recoveryStore.list()).length };
        }
        if (message.type === 'MRU_POPUP_CONTEXT') {
            await this.ready();
            return this.popupContext || await this.context(message.sourceWindowId);
        }
        const context = await this.context(message.sourceWindowId);
        switch (message.type) {
            case 'MRU_CONTEXT': return context;
            case 'MRU_QUERY':
                this.syncLiveCatalog();
                return { ...await this.service.query({ ...message, ...context }), context };
            case 'MRU_SET_LIVE_ONLY': {
                const value = { liveOnly: Boolean(message.value) };
                this.windowUi.set(context.sourceWindowId, value);
                await this.chrome.storage.session?.set({ [`mru.window.${context.sourceWindowId}`]: value });
                this.broadcast();
                return { ...context, ...value };
            }
            case 'MRU_OPEN': await this.openSwitcher(context); return { success: true };
            case 'MRU_ACTIVATE': return this.activate(message);
            default: throw new Error('Unknown MRU request');
        }
    }
}
