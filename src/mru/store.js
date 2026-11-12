// Recency is supplementary metadata, never an alternative bookmark/session layout.
const PREFIX = 'mru.v1.';
const VISIT = `${PREFIX}visit.`;
const RECOVERY = `${PREFIX}deleted.`;
const ENABLED = `${PREFIX}recoveryEnabled`;

class StorageQueue {
    constructor(storage) { this.storage = storage; this.tail = Promise.resolve(); }
    enqueue(operation) {
        const result = this.tail.then(operation);
        // A quota/transient failure must reach its caller without disabling later writes.
        this.tail = result.catch(() => {});
        return result;
    }
}

export class RecencyStore extends StorageQueue {
    constructor({ storage, clock = Date.now }) {
        super(storage);
        this.clock = clock;
        this.visits = new Map();
        this.sequence = 0;
        this.loading = this.hydrate();
    }

    async hydrate() {
        const values = await this.storage.get(null);
        const records = Object.entries(values).filter(([key, value]) => key.startsWith(VISIT) && value && key === VISIT + value.bookmarkId && Number.isFinite(value.lastViewedAt) && Number.isFinite(value.sequence)).map(([, value]) => value);
        records.sort((a, b) => a.sequence - b.sequence);
        for (const record of records) {
            this.visits.set(record.bookmarkId, record);
            this.sequence = Math.max(this.sequence, record.sequence);
        }
    }

    ready() { return this.loading; }
    entries() { return [...this.visits.values()].reverse(); }

    async touch(bookmarkId) {
        await this.ready();
        const record = { bookmarkId, lastViewedAt: this.clock(), sequence: ++this.sequence };
        this.visits.delete(bookmarkId);
        this.visits.set(bookmarkId, record);
        await this.enqueue(async () => {
            // Forget/revisit can supersede a queued touch. Object identity is a bounded generation token: no permanent tombstones accumulate for deleted tabs.
            if (this.visits.get(bookmarkId) === record) await this.storage.set({ [VISIT + bookmarkId]: record });
        });
        return record;
    }

    async forget(bookmarkIds) {
        await this.ready();
        const ids = [...bookmarkIds];
        for (const id of ids) this.visits.delete(id);
        if (ids.length) await this.enqueue(() => this.storage.remove(ids.map(id => VISIT + id)));
    }
}

export class RecoveryStore extends StorageQueue {
    constructor({ storage, clock = Date.now }) {
        super(storage);
        this.clock = clock;
        this.records = new Map();
        this.enabled = false;
        this.policyEpoch = 0;
        this.hydrated = false;
        this.acceptingCaptures = false;
        this.loading = this.hydrate();
    }

    async hydrate() {
        const values = await this.storage.get(null);
        this.enabled = values[ENABLED] === true;
        this.initialEnabled = this.enabled;
        this.hydrated = true;
        this.acceptingCaptures = this.enabled && this.policyEpoch === 0;
        for (const [key, value] of Object.entries(values)) {
            if (key.startsWith(RECOVERY) && value && key === RECOVERY + value.recoveryId) this.records.set(value.recoveryId, value);
        }
        // An interrupted opt-out must not leave deleted URLs retained after restart.
        await this.prune();
    }

    ready() { return this.loading; }

    consentAtReceipt() {
        const epoch = this.policyEpoch;
        // Cold listeners use the persisted policy read that preceded later configuration, not whatever policy happens to be enabled when an awaited deletion resumes.
        if (!this.hydrated) return this.ready().then(() => ({ enabled: epoch === 0 && this.initialEnabled, epoch }));
        return Promise.resolve({ enabled: this.acceptingCaptures, epoch });
    }

    permits(consent) { return consent.enabled && this.enabled && this.acceptingCaptures && consent.epoch === this.policyEpoch; }

    async prune() {
        const cutoff = this.clock() - 30 * 86400000;
        const entries = [...this.records.values()].sort((a, b) => b.deletedAt - a.deletedAt || b.ordinal - a.ordinal);
        const discard = entries.filter((record, index) => !this.enabled || !Number.isFinite(record.deletedAt) || record.deletedAt < cutoff || index >= 100);
        for (const record of discard) this.records.delete(record.recoveryId);
        if (discard.length) await this.enqueue(() => this.storage.remove(discard.map(record => RECOVERY + record.recoveryId)));
    }

    async configure(enabled) {
        const epoch = ++this.policyEpoch;
        // Consent changes invalidate pending captures immediately; an opt-in is not effective until its own persistence operation succeeds.
        this.acceptingCaptures = false;
        await this.ready();
        await this.enqueue(async () => {
            await this.storage.set({ [ENABLED]: Boolean(enabled) });
            this.enabled = Boolean(enabled);
            this.acceptingCaptures = this.enabled && epoch === this.policyEpoch;
        });
        await this.prune();
    }

    async capture({ title, url, sourceSessionId, lastViewedAt }, receipt = this.consentAtReceipt()) {
        const consent = await receipt;
        await this.ready();
        if (!this.permits(consent)) return null;
        const record = await this.enqueue(async () => {
            if (!this.permits(consent)) return null;
            const value = { recoveryId: crypto.randomUUID(), title, url, sourceSessionId, lastViewedAt, deletedAt: this.clock(), ordinal: Math.max(0, ...[...this.records.values()].map(entry => entry.ordinal || 0)) + 1 };
            await this.storage.set({ [RECOVERY + value.recoveryId]: value });
            this.records.set(value.recoveryId, value);
            return value;
        });
        await this.prune();
        return record;
    }

    async list() {
        await this.ready();
        await this.prune();
        return [...this.records.values()].sort((a, b) => b.deletedAt - a.deletedAt || b.ordinal - a.ordinal);
    }

    async update(record) {
        const receipt = this.consentAtReceipt();
        await this.ready();
        const consent = await receipt;
        await this.enqueue(async () => {
            if (!this.permits(consent) || !this.records.has(record.recoveryId)) throw new Error('Recovery entry is no longer available');
            // Remember a successfully created bookmark even if journaling fails. Retrying in this worker must not create a second bookmark.
            this.records.set(record.recoveryId, record);
            await this.storage.set({ [RECOVERY + record.recoveryId]: record });
        });
    }

    async remove(recoveryId) {
        await this.ready();
        await this.enqueue(() => this.storage.remove(RECOVERY + recoveryId));
        this.records.delete(recoveryId);
    }

}
