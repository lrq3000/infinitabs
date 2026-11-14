// One preference serves the normal tree, Recent sidebar and switcher. This is presentation state only, never another logical/native tab mapping.
export class TabDisplaySettings {
    constructor({ chrome, onChange = () => {} }) {
        Object.assign(this, { chrome, onChange });
        this.mode = 'compact';
        this.revision = 0;
        this.onStorageChanged = (changes, area) => {
            if (area !== 'local' || !changes.tabDisplayMode) return;
            this.revision++;
            this.apply(changes.tabDisplayMode.newValue);
        };
        chrome.storage.onChanged.addListener(this.onStorageChanged);
    }

    static normalize(mode) { return ['domain', 'url'].includes(mode) ? mode : 'compact'; }

    apply(value) {
        const mode = TabDisplaySettings.normalize(value);
        if (mode === this.mode) return;
        this.mode = mode;
        this.onChange(mode);
    }

    ready() {
        if (!this.loading) {
            const revision = this.revision;
            this.loading = this.chrome.storage.local.get({ tabDisplayMode: 'compact' }).then(items => {
                // A storage event is newer than this initial read's snapshot, even if the older promise resolves last.
                if (revision === this.revision) this.apply(items.tabDisplayMode);
            });
        }
        return this.loading;
    }

    dispose() { this.revision++; this.chrome.storage.onChanged.removeListener(this.onStorageChanged); }
}
