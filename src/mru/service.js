import { MruSearch } from './search.js';

export class MruService {
    constructor({ recencyStore, recoveryStore }) {
        this.recencyStore = recencyStore;
        this.recoveryStore = recoveryStore;
        this.catalog = new Map();
        this.lastViewedBookmarkId = null;
    }

    setCatalog(tabs) {
        this.catalog = new Map(tabs.map(tab => [tab.bookmarkId, {
            ...tab, searchTitle: MruSearch.normalize(tab.title), searchUrl: MruSearch.normalize(tab.url)
        }]));
    }

    async observeView({ bookmarkId, isFocused, isIncognito = false }) {
        if (!isFocused || isIncognito || !this.catalog.has(bookmarkId) || this.lastViewedBookmarkId === bookmarkId) return;
        await this.recencyStore.touch(bookmarkId);
        this.lastViewedBookmarkId = bookmarkId;
    }

    matchCandidate(item, { sourceSessionId, liveOnly, allSessions, excludeBookmarkId, terms }) {
        if (item.private || (!allSessions && item.sessionId !== sourceSessionId) || (!item.deleted && item.bookmarkId === excludeBookmarkId) || (liveOnly && !item.liveTabIds?.length)) return null;
        return MruSearch.match(terms, item);
    }

    async query({ sourceSessionId, liveOnly = false, allSessions = false, query = '', currentBookmarkId, excludeBookmarkId, offset = 0, limit = 50 } = {}) {
        await this.recencyStore.ready();
        const visits = this.recencyStore.entries().map(visit => {
            const tab = this.catalog.get(visit.bookmarkId);
            return tab ? { ...tab, ...visit, key: `tab:${tab.bookmarkId}`, deleted: false } : null;
        }).filter(Boolean);
        const deleted = liveOnly ? [] : (await this.recoveryStore.list()).map(record => ({
            ...record, key: `deleted:${record.recoveryId}`, sessionId: record.sourceSessionId, liveTabIds: [], deleted: true
        })).sort((a, b) => b.lastViewedAt - a.lastViewedAt || b.ordinal - a.ordinal);

        // The surviving list is already MRU ordered; only the independently bounded recovery list needs sorting. Merge in linear time, keeping surviving tabs first on equal timestamps.
        const buckets = Array.from({ length: 7 }, () => []);
        const terms = MruSearch.prepare(query);
        const filters = { sourceSessionId, liveOnly, allSessions, excludeBookmarkId, terms };
        const candidate = this.catalog.get(currentBookmarkId);
        // Showing an active source tab does not manufacture a visit, even if the worker has not recorded its activation yet.
        let current = candidate ? { ...candidate, key: `tab:${candidate.bookmarkId}`, deleted: false } : null;
        let i = 0, j = 0;
        while (i < visits.length || j < deleted.length) {
            const item = i < visits.length && (j >= deleted.length || visits[i].lastViewedAt >= deleted[j].lastViewedAt) ? visits[i++] : deleted[j++];
            // Retain any existing visit metadata, but never emit current twice or let relevance place it below an older match.
            if (!item.deleted && item.bookmarkId === currentBookmarkId) { current = item; continue; }
            const tier = this.matchCandidate(item, filters);
            if (tier !== null) buckets[tier].push(item);
        }
        const results = buckets.flat();
        if (current && this.matchCandidate(current, filters) !== null) results.unshift(current);
        const start = Math.max(0, Number(offset) || 0);
        const count = Math.min(100, Math.max(1, Number(limit) || 50));
        return { items: results.slice(start, start + count), total: results.length };
    }
}
