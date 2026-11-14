import { TabRow } from '../ui/tab-row.js';
import { TabDisplaySettings } from '../ui/tab-display-settings.js';

// Worker transport is shared too: popup and sidebar cannot silently develop different error/filter semantics.
export class MruClient {
    constructor(chrome) { this.chrome = chrome; }
    async request(message) {
        const result = await this.chrome.runtime.sendMessage(message);
        if (!result || result.error) throw new Error(result?.error || 'MRU background is unavailable');
        return result;
    }
    faviconUrl(url) { return this.chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`); }
}

// The controller has no DOM dependency. Real browser tests cover the presentation; unit tests cover asynchronous query/selection state without a simulated document implementation.
export class MruController {
    constructor({ client, context, onChange = () => {}, onActivated = () => {}, onDismiss = () => {} }) {
        Object.assign(this, { client, context, onChange, onActivated, onDismiss });
        this.items = []; this.total = 0; this.query = ''; this.allSessions = false;
        this.offset = 0; this.pageSize = 50; this.selectedKey = null;
        this.generation = 0; this.error = ''; this.busy = false; this.loading = false;
    }

    // Search/page parameters change before the worker answers, while the visible rows still belong to the previous response. Never combine those snapshots for navigation; a failed query also leaves only stale rows until a successful retry.
    get canNavigate() { return !this.loading && !this.error && !this.busy; }

    // Current is derived from the authoritative source snapshot, not copied into a second selection model.
    get currentKey() { return this.context.currentBookmarkId ? `tab:${this.context.currentBookmarkId}` : null; }

    async refresh() {
        const generation = ++this.generation;
        this.loading = true;
        try {
            const result = await this.client.request({ ...this.context, type: 'MRU_QUERY', query: this.query, allSessions: this.allSessions, offset: this.offset, limit: this.pageSize });
            if (generation !== this.generation) return;
            const previousCurrentKey = this.currentKey;
            this.context = result.context || this.context;
            if (this.currentKey !== previousCurrentKey) {
                this.selectedKey = null;
                // A real tab change returns the navigation pane to current. Mere background refreshes must not steal a cursor or page the user is browsing.
                if (this.offset) { this.offset = 0; return this.refresh(); }
            }
            this.items = result.items;
            this.total = result.total;
            // Deleting/unmounting with Live Only can empty the last page. Requery a real page rather than leaving surviving earlier results stranded behind an empty pane.
            if (this.offset && this.offset >= this.total) {
                this.offset = Math.floor(Math.max(0, this.total - 1) / this.pageSize) * this.pageSize;
                return this.refresh();
            }
            // Preserve the switcher's quick Enter-to-previous behavior while current remains visibly highlighted above that target.
            if (!this.items.some(item => item.key === this.selectedKey)) this.selectedKey = (this.items.find(item => item.key !== this.currentKey) || this.items[0])?.key || null;
            this.error = '';
        } catch (error) { if (generation === this.generation) this.error = error.message; }
        // Only the latest request can unlock navigation. An older completion must not make a newer in-flight query's stale rows navigable.
        if (generation === this.generation) { this.loading = false; this.onChange(); }
        return generation === this.generation && !this.error;
    }

    search(query) { this.query = query; this.offset = 0; this.selectedKey = null; return this.refresh(); }
    setScope(allSessions) { this.allSessions = allSessions; this.offset = 0; this.selectedKey = null; return this.refresh(); }
    async setLiveOnly(value) {
        try {
            await this.client.request({ ...this.context, type: 'MRU_SET_LIVE_ONLY', value });
            this.offset = 0; await this.refresh();
        } catch (error) { this.error = error.message; this.onChange(); }
    }

    async page(offset, selectLast = false) {
        if (!this.canNavigate) return;
        this.offset = Math.max(0, offset); this.selectedKey = null;
        const generation = this.generation + 1;
        const currentKey = this.currentKey;
        const applied = await this.refresh();
        // Refresh rejects stale rows, but paging has a second selection effect after awaiting it. Guard that continuation too, including a newer search/retarget/dispose or a current change already answered on page one without another query.
        if (!applied || generation !== this.generation || currentKey !== this.currentKey) return;
        this.selectedKey = (selectLast ? this.items.at(-1) : this.items[0])?.key || null;
        this.onChange();
    }

    async advanceSelection(direction) {
        if (!this.canNavigate || !this.items.length) return;
        // Wrap in the complete filtered result set, not the loaded page: the last page can contain only one match. Only query another page when crossing its boundary.
        const index = this.items.findIndex(item => item.key === this.selectedKey);
        const target = (this.offset + index + direction + this.total) % this.total;
        const offset = Math.floor(target / this.pageSize) * this.pageSize;
        if (offset !== this.offset) return this.page(offset, direction < 0);
        this.selectedKey = this.items[target - this.offset].key;
        this.onChange();
    }

    async keyDown(key, shift = false, isComposing = false) {
        if (isComposing) return false;
        if (key === 'Escape') { this.onDismiss(); return true; }
        if (key === 'Enter') { await this.activate(); return true; }
        if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab') {
            await this.advanceSelection(key === 'ArrowUp' || (key === 'Tab' && shift) ? -1 : 1); return true;
        }
        if (!['Home', 'End', 'PageDown', 'PageUp'].includes(key)) return false;
        if (!this.canNavigate) return true;
        if (key === 'Home' && this.offset) await this.page(0);
        else if (key === 'End' && this.offset + this.items.length < this.total) await this.page(Math.floor((this.total - 1) / this.pageSize) * this.pageSize, true);
        else if (key === 'PageDown' && this.offset + this.items.length < this.total) await this.page(this.offset + this.pageSize);
        else if (key === 'PageUp' && this.offset) await this.page(this.offset - this.pageSize);
        else { this.selectedKey = (key === 'Home' || key === 'PageUp' ? this.items[0] : this.items.at(-1))?.key || null; this.onChange(); }
        return true;
    }

    async activate(key = this.selectedKey) {
        if (!key || this.busy) return;
        this.busy = true; this.onChange();
        try {
            await this.client.request({ ...this.context, type: 'MRU_ACTIVATE', key });
            this.onActivated();
        } catch (error) { this.error = error.message; }
        finally { this.busy = false; this.onChange(); }
    }

    async mutate(type, key) {
        if (!key || this.busy || this.loading) return;
        this.busy = true; this.onChange();
        try {
            await this.client.request({ ...this.context, type, key });
            await this.refresh();
        } catch (error) { this.error = error.message; }
        finally { this.busy = false; this.onChange(); }
    }
}

export class MruView {
    constructor({ root, client, context, showLiveToggle = false, searchHost = null, onActivated, onDismiss }) {
        Object.assign(this, { root, client, showLiveToggle, searchHost });
        this.controller = new MruController({ client, context, onChange: () => this.render(), onActivated, onDismiss });
        this.abort = new AbortController();
        this.chrome = client.chrome || root.ownerDocument.defaultView.chrome;
        this.display = new TabDisplaySettings({ chrome: this.chrome, onChange: mode => {
            root.ownerDocument.body.dataset.tabDisplay = mode;
            this.render();
        } });
        root.ownerDocument.body.dataset.tabDisplay = this.display.mode;
    }

    element(tag, className, text) {
        const element = this.root.ownerDocument.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    listen(element, event, handler) { element.addEventListener(event, handler, { signal: this.abort.signal }); }

    async mount() {
        this.root.classList.add('mru-root');
        const controls = this.element('div', 'mru-controls');
        this.input = this.element('input', 'mru-search');
        this.input.type = this.searchHost ? 'text' : 'search';
        this.input.placeholder = this.searchHost ? 'Search recent tabs...' : 'Find a recently viewed tab…';
        if (this.searchHost) this.input.classList.add('sidebar-search-input');
        this.input.setAttribute('aria-label', 'Search recent tabs');
        this.input.setAttribute('role', 'combobox'); this.input.setAttribute('aria-expanded', 'true'); this.input.setAttribute('aria-autocomplete', 'list');
        this.listen(this.input, 'input', () => this.controller.search(this.input.value));
        this.listen(this.input, 'keydown', event => {
            // Enter/arrows belong to the input method while composing. Do not even prevent their default action, or committing East Asian text can switch tabs instead.
            if (event.isComposing || event.keyCode === 229) return;
            if (['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Tab', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation(); this.controller.keyDown(event.key, event.shiftKey);
            }
        });
        this.scope = this.element('select'); this.scope.setAttribute('aria-label', 'Recent tab scope');
        for (const [value, label] of [['session', 'Current session'], ['all', 'All sessions']]) { const option = this.element('option', '', label); option.value = value; this.scope.append(option); }
        this.listen(this.scope, 'change', () => this.controller.setScope(this.scope.value === 'all'));
        controls.append(this.scope);
        if (this.showLiveToggle) {
            this.liveToggle = this.element('button', 'mru-live-toggle', 'Live Only'); this.liveToggle.type = 'button';
            this.listen(this.liveToggle, 'click', () => this.controller.setLiveOnly(!this.controller.context.liveOnly));
            controls.append(this.liveToggle);
        }
        this.list = this.element('div', 'mru-results'); this.list.id = `mru-results-${this.controller.context.sourceWindowId}`;
        this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', 'Recent tabs'); this.input.setAttribute('aria-controls', this.list.id);
        this.status = this.element('div', 'mru-status'); this.status.setAttribute('role', 'status');
        const paging = this.element('div', 'mru-paging');
        this.previous = this.element('button', '', 'Previous'); this.next = this.element('button', '', 'Next');
        this.listen(this.previous, 'click', () => this.controller.page(this.controller.offset - this.controller.pageSize));
        this.listen(this.next, 'click', () => this.controller.page(this.controller.offset + this.controller.pageSize));
        paging.append(this.previous, this.next);
        // The sidebar supplies its existing search slot; the popup keeps its self-contained input. Each mode owns its query and keyboard/combobox semantics without duplicate search rows.
        this.root.replaceChildren(controls, this.list, this.status, paging);
        if (this.searchHost) this.searchHost.prepend(this.input);
        else this.root.prepend(this.input);
        await this.display.ready();
        await this.controller.refresh();
    }

    render() {
        if (!this.list) return;
        const controller = this.controller;
        this.list.replaceChildren();
        let selected;
        for (const [index, item] of controller.items.entries()) {
            const tabRow = new TabRow({ document: this.root.ownerDocument, chrome: this.chrome,
                onActivate: () => { controller.selectedKey = item.key; controller.activate(item.key); },
                onUnmount: item.deleted ? undefined : () => controller.mutate('MRU_UNMOUNT', item.key),
                onDelete: item.deleted ? undefined : () => controller.mutate('MRU_DELETE', item.key)
            });
            const row = tabRow.element; row.dataset.key = item.key;
            row.id = `${this.list.id}-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item.key === controller.selectedKey));
            const isCurrent = item.key === controller.currentKey;
            tabRow.update(item, { current: isCurrent, disabled: controller.busy, displayMode: this.display.mode,
                description: item.deleted ? 'Deleted · Restore' : undefined });
            row.classList.add('mru-result');
            if (isCurrent) row.setAttribute('aria-current', 'page');
            row.addEventListener('mousedown', event => event.preventDefault());
            this.list.append(row);
            if (item.key === controller.selectedKey) selected = row;
        }
        if (selected) { this.input.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({ block: 'nearest' }); }
        else this.input.removeAttribute('aria-activedescendant');
        if (this.liveToggle) this.liveToggle.setAttribute('aria-pressed', String(controller.context.liveOnly));
        this.status.textContent = controller.error || (controller.total ? `${controller.offset + 1}–${controller.offset + controller.items.length} of ${controller.total} · ${controller.context.liveOnly ? 'Mounted tabs' : 'All logical tabs'}` : 'No recently viewed tabs match. Browse a tab to add it here.');
        this.status.dataset.error = String(Boolean(controller.error));
        this.previous.disabled = controller.offset === 0; this.next.disabled = controller.offset + controller.items.length >= controller.total;
    }

    refresh() { return this.controller.refresh(); }
    focus() { this.input.focus(); }
    advanceSelection(direction) { return this.controller.advanceSelection(direction); }
    dispose() { this.controller.generation++; this.abort.abort(); this.display.dispose(); this.input?.remove(); this.root.replaceChildren(); }
}
