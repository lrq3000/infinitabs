const assert = require('node:assert/strict');
const { GroupLifecycleFixture: Fixture } = require('./group_lifecycle_fixture.js');
const { GroupLifecycleSuite } = require('./group_lifecycle_suite.js');
const suite = new GroupLifecycleSuite('group fixture', 1);

async function main() {
    const f = await new Fixture().prepare(1), parentId = f.sessions.get(1);
    const a = await chrome.bookmarks.create({ parentId, title: 'A', url: 'https://example.test/a' });
    const b = await chrome.bookmarks.create({ parentId, title: 'B', url: 'https://example.test/b' });
    const before = await chrome.bookmarks.getChildren(parentId);
    let hookCalls = 0;
    f.hooks.getChildren = () => { hookCalls++; };
    const first = await chrome.bookmarks.create({ parentId, title: 'First', index: 0 });
    f.hooks = {};
    const children = await chrome.bookmarks.getChildren(parentId);
    const individual = await Promise.all([first, a, b].map(async node => (await chrome.bookmarks.get(node.id))[0]));
    const [tree] = await chrome.bookmarks.getSubTree(parentId);
    const indices = nodes => nodes.map(({ id, index }) => ({ id, index }));
    const expected = [first, a, b].map(({ id }, index) => ({ id, index }));
    assert.deepEqual({ children: indices(children), individual: indices(individual), tree: indices(tree.children), hookCalls },
        { children: expected, individual: expected, tree: expected, hookCalls: 0 },
        'Indexed creation must update backing sibling indices consistently, without production-read hooks during internal bookkeeping');
    assert.deepEqual(indices(before), [{ id: a.id, index: 0 }, { id: b.id, index: 1 }], 'Earlier API snapshots stay immutable');
}

suite.run(() => suite.check('indexed creation backing-node contract', main));
