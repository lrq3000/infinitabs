// Shared presentation and controls; tree selection/dragging and MRU activation remain the responsibility of each view.
export class TabRow {
    constructor({ document, chrome, onActivate, onUnmount, onDelete }) {
        Object.assign(this, { document, chrome, onActivate, onUnmount, onDelete });
        this.element = this.create('div', 'tab-item');
        this.element.tabRow = this;
        this.indicatorWrapper = this.create('button', 'live-indicator-wrapper');
        this.indicatorWrapper.type = 'button';
        this.indicatorWrapper.title = 'Close live tab (keep bookmark)';
        this.indicatorWrapper.setAttribute('aria-label', this.indicatorWrapper.title);
        this.indicatorWrapper.append(this.create('span', 'live-indicator'));
        this.icon = this.create('img', 'tab-icon'); this.icon.alt = '';
        this.text = this.create('span', 'tab-text');
        this.title = this.create('span', 'tab-title');
        this.descriptionElement = this.create('span', 'tab-description');
        this.text.append(this.title, this.descriptionElement);
        this.deleteButton = this.create('button', 'tab-delete-btn', '×');
        this.deleteButton.type = 'button';
        this.deleteButton.title = 'Delete logical tab and bookmark';
        this.deleteButton.setAttribute('aria-label', this.deleteButton.title);
        this.deleteButton.hidden = !onDelete;
        this.element.append(this.indicatorWrapper, this.icon, this.text, this.deleteButton);
        this.element.addEventListener('click', event => { if (!this.disabled) this.onActivate?.(event); });
        for (const [button, action] of [[this.indicatorWrapper, 'unmount'], [this.deleteButton, 'delete']]) {
            // Controls must not select/mount their row or steal the Recent search's keyboard focus.
            button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
            button.addEventListener('click', event => { event.stopPropagation(); this.perform(action); });
        }
    }

    create(tag, className, text) {
        const element = this.document.createElement(tag);
        element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    static description(url = '', mode = 'compact') {
        if (mode === 'compact') return '';
        if (mode === 'domain') {
            try { return new URL(url).hostname || url; } catch { return url; }
        }
        return url;
    }

    static async confirmDeletion(chrome, confirm) {
        const items = await chrome.storage.local.get({ confirmDeleteLogicalTab: true });
        return !items.confirmDeleteLogicalTab || confirm('Delete this logical tab (bookmark)?');
    }

    async perform(action) {
        if (this.disabled || this.pending || (action === 'unmount' && !this.mounted)) return;
        this.pending = true;
        try {
            if (action === 'delete') {
                if (await TabRow.confirmDeletion(this.chrome, message => this.document.defaultView.confirm(message))) await this.onDelete?.();
            } else await this.onUnmount?.();
        } catch (error) {
            const label = action === 'delete' ? 'Failed to delete logical tab' : 'Failed to unmount logical tab';
            console.error(label, error);
            this.document.defaultView.alert(`${label}. Please try again.`);
        } finally { this.pending = false; }
    }

    update(tab, { current = false, selected = false, groupColor, indented = false, disabled = false, displayMode = 'compact', description } = {}) {
        this.mounted = Boolean(tab.liveTabIds?.length);
        this.disabled = disabled;
        this.element.classList.toggle('live', this.mounted);
        this.element.classList.toggle('logical', !this.mounted);
        this.element.classList.toggle('active-live', current);
        this.element.classList.toggle('selected', selected);
        this.element.classList.toggle('indented', indented);
        this.element.setAttribute('aria-disabled', String(disabled));
        this.indicatorWrapper.disabled = disabled || !this.mounted;
        this.deleteButton.disabled = disabled;
        this.element.title = tab.url || '';
        // Bookmark titles and URLs may contain arbitrary markup-like strings. Never interpolate them into HTML.
        const title = tab.title || tab.url || '';
        if (this.title.textContent !== title) this.title.textContent = title;
        this.descriptionElement.textContent = description ?? TabRow.description(tab.url, displayMode);
        this.descriptionElement.hidden = !this.descriptionElement.textContent;
        this.element.classList.toggle('tab-detailed', Boolean(this.descriptionElement.textContent));
        const defaultFaviconUrl = this.chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(tab.url || '') + '&size=16';
        // Reattach on update so fallback captures the current URL rather than a stale bookmark/native favicon.
        this.icon.onerror = event => {
            if (this.icon.src !== defaultFaviconUrl) {
                console.warn(`Failed to load favicon: ${this.icon.src}. Falling back to default.`, event);
                this.icon.onerror = null; // Prevent a repeat loop if the fallback also fails.
                this.icon.src = defaultFaviconUrl;
            }
        };
        const faviconUrl = tab.favIconUrl || defaultFaviconUrl;
        if (this.icon.src !== faviconUrl) this.icon.src = faviconUrl;
        if (groupColor) {
            if (!this.groupLine) {
                this.groupLine = this.create('div', 'group-color-line');
                this.element.prepend(this.groupLine);
            }
            this.groupLine.className = `group-color-line group-line-${groupColor}`;
        } else if (this.groupLine) { this.groupLine.remove(); this.groupLine = null; }
    }
}
