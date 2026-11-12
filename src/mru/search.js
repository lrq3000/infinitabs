// Fixed relevance tiers let us preserve MRU order without an O(n log n) result sort.
export class MruSearch {
    static normalize(value) { return String(value || '').normalize('NFKC').toLowerCase(); }
    static prepare(query) { return this.normalize(query).trim().split(/\s+/).filter(Boolean); }

    static subsequence(needle, haystack) {
        let position = 0;
        for (const character of needle) {
            position = haystack.indexOf(character, position);
            if (position === -1) return false;
            position += character.length;
        }
        return true;
    }

    static match(query, candidate) {
        const terms = Array.isArray(query) ? query : this.prepare(query);
        const title = candidate.searchTitle ?? this.normalize(candidate.title);
        const url = candidate.searchUrl ?? this.normalize(candidate.url);
        let tier = 0;
        for (const term of terms) {
            let rank;
            if (title === term) rank = 0;
            else if (title.startsWith(term)) rank = 1;
            else if (title.includes(term)) rank = 2;
            else if (url.startsWith(term)) rank = 3;
            else if (url.includes(term)) rank = 4;
            else if (this.subsequence(term, title)) rank = 5;
            else if (this.subsequence(term, url)) rank = 6;
            else return null;
            tier = Math.max(tier, rank);
        }
        return tier;
    }
}
