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
        this.generation = 0; this.error = ''; this.busy = false;
    }

    async refresh() {
        const generation = ++this.generation;
        try {
            const result = await this.client.request({ ...this.context, type: 'MRU_QUERY', query: this.query, allSessions: this.allSessions, offset: this.offset, limit: this.pageSize });
            if (generation !== this.generation) return;
            this.context = result.context || this.context;
            this.items = result.items;
            this.total = result.total;
            if (!this.items.some(item => item.key === this.selectedKey)) this.selectedKey = this.items[0]?.key || null;
            this.error = '';
        } catch (error) { if (generation === this.generation) this.error = error.message; }
        if (generation === this.generation) this.onChange();
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
        this.offset = Math.max(0, offset); this.selectedKey = null;
        const generation = this.generation + 1;
        const applied = await this.refresh();
        // Refresh rejects stale rows, but paging has a second selection effect after awaiting it. Guard that continuation too, including a newer search/retarget/dispose.
        if (!applied || generation !== this.generation) return;
        if (selectLast) this.selectedKey = this.items.at(-1)?.key || null;
        this.onChange();
    }

    async advanceSelection(direction) {
        if (!this.items.length) return;
        const index = this.items.findIndex(item => item.key === this.selectedKey) + direction;
        if (index >= this.items.length && this.offset + this.items.length < this.total) return this.page(this.offset + this.pageSize);
        if (index < 0 && this.offset > 0) return this.page(this.offset - this.pageSize, true);
        this.selectedKey = this.items[(index + this.items.length) % this.items.length].key;
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
}

export class MruView {
    constructor({ root, client, context, showLiveToggle = false, onActivated, onDismiss }) {
        Object.assign(this, { root, client, showLiveToggle });
        this.controller = new MruController({ client, context, onChange: () => this.render(), onActivated, onDismiss });
        this.abort = new AbortController();
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
        this.input.type = 'search'; this.input.placeholder = 'Find a recently viewed tab…';
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
        this.root.replaceChildren(this.input, controls, this.list, this.status, paging);
        await this.controller.refresh();
    }

    render() {
        if (!this.list) return;
        const controller = this.controller;
        this.list.replaceChildren();
        let selected;
        for (const [index, item] of controller.items.entries()) {
            const row = this.element('button', 'mru-result'); row.type = 'button'; row.dataset.key = item.key;
            row.id = `${this.list.id}-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item.key === controller.selectedKey)); row.disabled = controller.busy;
            const icon = this.element('img', 'mru-favicon'); icon.alt = ''; icon.src = this.client.faviconUrl(item.url || '');
            const text = this.element('span', 'mru-result-text');
            // Never interpolate bookmark titles or URLs into HTML: bookmarks can contain arbitrary markup-like strings.
            text.append(this.element('span', 'mru-result-title', item.title || item.url));
            let domain; try { domain = new URL(item.url).hostname || item.url; } catch { domain = item.url; }
            const state = item.deleted ? 'Deleted · Restore' : item.liveTabIds?.length ? 'Mounted' : 'Unmounted';
            const context = controller.allSessions ? ` · ${item.sessionName || 'Previous session'}` : '';
            text.append(this.element('span', 'mru-result-meta', `${state} · ${domain}${context}`));
            row.title = item.url; row.append(icon, text);
            this.listen(row, 'mousedown', event => event.preventDefault());
            this.listen(row, 'click', () => { controller.selectedKey = item.key; controller.activate(item.key); });
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
    dispose() { this.controller.generation++; this.abort.abort(); this.root.replaceChildren(); }
}
