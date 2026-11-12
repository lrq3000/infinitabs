import test from 'node:test';
import assert from 'node:assert/strict';
import { MruSearch } from '../../src/mru/search.js';

test('matching distinguishes exact, prefix, substring and gapped title matches', () => {
    assert.equal(typeof MruSearch, 'function', 'search must be implemented');
    const tiers = ['tab', 'Tabs guide', 'A tab guide', 'Tables and books'].map(title => MruSearch.match('tab', { title, url: '' }));
    assert.ok(tiers[0] < tiers[1]); assert.ok(tiers[1] < tiers[2]);
    assert.ok(MruSearch.match('tbs', { title: 'Tables', url: '' }) > tiers[2]);
    assert.equal(MruSearch.match('xyz', { title: 'Tables', url: '' }), null);
});

test('normalized Unicode, multi-term AND queries, URL matches and empty queries work', () => {
    assert.equal(typeof MruSearch, 'function');
    assert.equal(MruSearch.match('foo', { title: 'ＦＯＯ', url: '' }), 0);
    assert.notEqual(MruSearch.match('CAFÉ notes', { title: 'Café research notes', url: '' }), null);
    assert.equal(MruSearch.match('café absent', { title: 'Café research notes', url: '' }), null);
    assert.notEqual(MruSearch.match('example', { title: '', url: 'https://example.test/path' }), null);
    assert.equal(MruSearch.match('  ', { title: '', url: '' }), 0);
});
