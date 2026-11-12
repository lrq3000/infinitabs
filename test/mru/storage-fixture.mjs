// The only doubled boundary is Chrome's external key/value storage API; assertions inspect persisted values and the real stores.
export class MemoryStorage {
    constructor(values = {}) { this.values = structuredClone(values); }
    async get(keys = null) {
        if (keys === null) return structuredClone(this.values);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.map(key => [key, structuredClone(this.values[key] ?? keys?.[key])]));
    }
    async set(values) { Object.assign(this.values, structuredClone(values)); }
    async remove(keys) { for (const key of [keys].flat()) delete this.values[key]; }
}
