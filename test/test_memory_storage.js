// test/test_memory_storage.js
import { strict as assert } from 'assert';

// Mock chrome.bookmarks
global.chrome = {
    storage: {
        session: {
            data: {},
            get: async (key) => {
                if (key) return { [key]: global.chrome.storage.session.data[key] };
                return global.chrome.storage.session.data;
            },
            set: async (items) => {
                Object.assign(global.chrome.storage.session.data, items);
            }
        }
    },
    bookmarks: {
        get: async (id) => {
            if (id === '1' || id === '2') {
                return [{ id, title: 'Bookmark ' + id, parentId: '0', index: 0 }];
            }
            return [];
        },
        create: async (details) => {
            return { id: 'bm_' + Math.random(), ...details };
        },
        getChildren: async (id) => {
            return [];
        },
        getSubTree: async (id) => {
             return [{ id, children: [] }];
        }
    },
    runtime: {
        id: 'test-id'
    }
};

// Mock crypto
// global.crypto is read-only in newer Node, but we can rely on native crypto if available or try to define property
if (!global.crypto) {
    global.crypto = {
        randomUUID: () => 'uuid-' + Math.random().toString(36).substring(2, 9)
    };
} else if (!global.crypto.randomUUID) {
    // If native crypto exists but not randomUUID (older Node?), polyfill it?
    // Node 22 has it.
    // The issue is likely I am trying to overwrite the global crypto object entirely.
    // Let's rely on built-in.
}

// Import storage (it adds itself to global scope or we import the class?)
// storage.js defines `class MemoryStorage`, `class StorageManager` and `const storage = new StorageManager()`.
// Since it is not a module, we need to eval it or load it similarly.
// For testing, we can read the file and eval it, or wrap it.
// Given the environment, let's use a simple evaluation trick.

import fs from 'fs';
import path from 'path';

const storagePath = path.join(process.cwd(), 'src', 'storage.js');
const storageCode = fs.readFileSync(storagePath, 'utf8');

// Execute storage code and capture the instance
eval(storageCode); // This sets global.storage now
const storage = global.storage;

async function testStorage() {
    console.log("Starting Memory Storage Tests...");

    // 1. Basic Creation in Memory
    const rootId = storage.getMemoryRootId();
    console.log(`Root ID: ${rootId}`);
    assert.ok(rootId, "Memory Root ID should exist");

    const session = await storage.create({
        parentId: rootId,
        title: "Test Memory Session"
    });
    console.log("Created Session:", session);
    assert.ok(session.id.startsWith('mem_'), "ID should be memory prefix");
    assert.equal(session.title, "Test Memory Session");

    // 2. Create child tab
    const tab = await storage.create({
        parentId: session.id,
        title: "Tab 1",
        url: "https://example.com"
    });
    console.log("Created Tab:", tab);
    assert.equal(tab.parentId, session.id);

    // 3. Get / GetChildren
    const children = await storage.getChildren(session.id);
    console.log("Session Children:", children);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, tab.id);

    // 4. Update
    await storage.update(tab.id, { title: "Tab 1 Updated" });
    const updatedTab = (await storage.get(tab.id))[0];
    assert.equal(updatedTab.title, "Tab 1 Updated");

    // 5. Move
    // Create another folder
    const folder2 = await storage.create({
        parentId: rootId,
        title: "Folder 2"
    });
    await storage.move(tab.id, { parentId: folder2.id });
    const movedTab = (await storage.get(tab.id))[0];
    assert.equal(movedTab.parentId, folder2.id);

    const oldChildren = await storage.getChildren(session.id);
    assert.equal(oldChildren.length, 0, "Old parent should be empty");

    const newChildren = await storage.getChildren(folder2.id);
    assert.equal(newChildren.length, 1, "New parent should have tab");

    // 6. Native Interop
    // Calling get on a non-memory ID should delegate to chrome.bookmarks
    const native = await storage.get('1');
    assert.equal(native[0].title, 'Bookmark 1', "Should retrieve native bookmark");

    // 7. Verify Persistence in Mock Session Storage
    const stored = await chrome.storage.session.get('memoryNodes');
    assert.ok(stored.memoryNodes, "Should have saved to session storage");
    const map = new Map(stored.memoryNodes);
    assert.ok(map.has(folder2.id), "Session storage should contain nodes");

    console.log("All Memory Storage Tests Passed!");
}

testStorage().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
