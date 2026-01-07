// src/storage.js

/**
 * In-memory implementation of a bookmark-like tree structure.
 * Simulates chrome.bookmarks API behavior for specific methods used by InfiniTabs.
 */
class MemoryStorage {
    constructor() {
        this.rootId = 'mem_root';
        // We load from storage on demand because constructor cannot be async
    }

    async _load() {
        try {
            const data = await chrome.storage.session.get('memoryNodes');
            if (data.memoryNodes) {
                // Convert array/object back to Map
                return new Map(data.memoryNodes);
            }
        } catch (e) {
            // Ignore error if storage not available yet or empty
        }

        // Default initialization
        const map = new Map();
        map.set(this.rootId, {
            id: this.rootId,
            title: "Memory Sessions",
            children: [],
            parentId: null,
            index: 0,
            dateAdded: Date.now()
        });
        return map;
    }

    async _save(map) {
        // Persist map as array/entries
        try {
            await chrome.storage.session.set({
                memoryNodes: Array.from(map.entries())
            });
        } catch(e) {
            console.error("Failed to save memory storage", e);
        }
    }

    _generateId() {
        return 'mem_' + crypto.randomUUID();
    }

    async get(idOrIdList) {
        const nodes = await this._load();
        const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
        const results = [];
        for (const id of ids) {
            const node = nodes.get(id);
            if (node) {
                // Return a copy to prevent direct mutation issues, similar to API
                results.push(JSON.parse(JSON.stringify(node)));
            }
        }
        if (results.length !== ids.length) {
             // chrome.bookmarks.get throws if any ID is missing, but for our usage
             // we can be slightly more lenient or mimic exact behavior.
             // For now, returning found ones is safer for hybrid usage.
             // But strictly speaking, we should probably throw or return empty.
             // Let's return what we found.
        }
        return results;
    }

    async getChildren(id) {
        const nodes = await this._load();
        const parent = nodes.get(id);
        if (!parent) return [];
        return (parent.children || []).map(childId => {
            return JSON.parse(JSON.stringify(nodes.get(childId)));
        });
    }

    async getSubTree(id) {
        const nodes = await this._load();
        const root = nodes.get(id);
        if (!root) throw new Error(`Node ${id} not found`);

        const buildTree = (nodeId) => {
            const node = nodes.get(nodeId);
            const clone = { ...node };
            if (node.children) {
                clone.children = node.children.map(childId => buildTree(childId));
            }
            return clone;
        };

        return [buildTree(id)];
    }

    async create(details) {
        const nodes = await this._load();
        const newId = this._generateId();
        const parentId = details.parentId || this.rootId;
        const parent = nodes.get(parentId);

        if (!parent) throw new Error(`Parent ${parentId} not found`);

        const newNode = {
            id: newId,
            parentId: parentId,
            title: details.title || "",
            url: details.url,
            index: details.index !== undefined ? details.index : (parent.children ? parent.children.length : 0),
            dateAdded: Date.now(),
            children: details.url ? undefined : [] // Folders have children
        };

        // Insert into parent
        if (!parent.children) parent.children = [];

        if (details.index !== undefined && details.index < parent.children.length) {
            parent.children.splice(details.index, 0, newId);
        } else {
            parent.children.push(newId);
            newNode.index = parent.children.length - 1; // Update index if appended
        }

        // Re-index siblings if inserted
        if (details.index !== undefined) {
             this._reindexChildren(nodes, parentId);
        }

        nodes.set(newId, newNode);
        await this._save(nodes);
        return JSON.parse(JSON.stringify(newNode));
    }

    async update(id, changes) {
        const nodes = await this._load();
        const node = nodes.get(id);
        if (!node) throw new Error(`Node ${id} not found`);

        if (changes.title !== undefined) node.title = changes.title;
        if (changes.url !== undefined) node.url = changes.url;

        await this._save(nodes);
        return JSON.parse(JSON.stringify(node));
    }

    async move(id, destination) {
        const nodes = await this._load();
        const node = nodes.get(id);
        if (!node) throw new Error(`Node ${id} not found`);

        const oldParentId = node.parentId;
        const oldParent = nodes.get(oldParentId);

        const newParentId = destination.parentId || oldParentId;
        const newParent = nodes.get(newParentId);

        if (!newParent) throw new Error(`Parent ${newParentId} not found`);

        // Remove from old parent
        const oldIndex = oldParent.children.indexOf(id);
        if (oldIndex !== -1) {
            oldParent.children.splice(oldIndex, 1);
            this._reindexChildren(nodes, oldParentId);
        }

        // Add to new parent
        let newIndex = destination.index;
        if (newIndex === undefined) newIndex = newParent.children.length; // append

        if (newIndex > newParent.children.length) newIndex = newParent.children.length;

        newParent.children.splice(newIndex, 0, id);

        node.parentId = newParentId;
        this._reindexChildren(nodes, newParentId);

        await this._save(nodes);
        return JSON.parse(JSON.stringify(node));
    }

    async remove(id) {
        const nodes = await this._load();
        const node = nodes.get(id);
        if (!node) return;

        if (node.children && node.children.length > 0) {
            throw new Error("Folder not empty. Use removeTree.");
        }

        this._removeFromParent(nodes, node);
        nodes.delete(id);
        await this._save(nodes);
    }

    async removeTree(id) {
        const nodes = await this._load();
        await this._removeTreeRecursive(nodes, id);
        await this._save(nodes);
    }

    async _removeTreeRecursive(nodes, id) {
        const node = nodes.get(id);
        if (!node) return;

        // Recursively delete children
        if (node.children) {
            for (const childId of [...node.children]) {
                await this._removeTreeRecursive(nodes, childId);
            }
        }

        this._removeFromParent(nodes, node);
        nodes.delete(id);
    }

    async search(query) {
        const nodes = await this._load();
        const results = [];
        const qTitle = query.title;
        for (const node of nodes.values()) {
             if (qTitle && node.title === qTitle) {
                 results.push(JSON.parse(JSON.stringify(node)));
             }
        }
        return results;
    }

    // Helpers
    _removeFromParent(nodes, node) {
        const parent = nodes.get(node.parentId);
        if (parent && parent.children) {
            const idx = parent.children.indexOf(node.id);
            if (idx !== -1) {
                parent.children.splice(idx, 1);
                this._reindexChildren(nodes, parent.id);
            }
        }
    }

    _reindexChildren(nodes, parentId) {
        const parent = nodes.get(parentId);
        if (parent && parent.children) {
            parent.children.forEach((childId, index) => {
                const child = nodes.get(childId);
                if (child) child.index = index;
            });
        }
    }
}

/**
 * Unified Storage Manager handling both Bookmarks and Memory backends.
 */
class StorageManager {
    constructor() {
        this.memory = new MemoryStorage();
        // Native bookmarks are accessed via global chrome.bookmarks
    }

    _isMemory(id) {
        return typeof id === 'string' && id.startsWith('mem_');
    }

    async get(idOrList) {
        if (Array.isArray(idOrList)) {
            // Mixed list?
            const memIds = idOrList.filter(id => this._isMemory(id));
            const bmIds = idOrList.filter(id => !this._isMemory(id));

            let results = [];
            if (memIds.length > 0) results = results.concat(await this.memory.get(memIds));
            if (bmIds.length > 0) results = results.concat(await chrome.bookmarks.get(bmIds));
            return results;
        } else {
            if (this._isMemory(idOrList)) return this.memory.get(idOrList);
            return chrome.bookmarks.get(idOrList);
        }
    }

    async getChildren(id) {
        if (this._isMemory(id)) return this.memory.getChildren(id);
        return chrome.bookmarks.getChildren(id);
    }

    async getSubTree(id) {
        if (this._isMemory(id)) return this.memory.getSubTree(id);
        return chrome.bookmarks.getSubTree(id);
    }

    async create(details) {
        // If parent is memory, create in memory
        if (details.parentId && this._isMemory(details.parentId)) {
            return this.memory.create(details);
        }
        // If parent is explicit native root (not likely used directly) or normal bookmark
        return chrome.bookmarks.create(details);
    }

    async update(id, changes) {
        if (this._isMemory(id)) return this.memory.update(id, changes);
        return chrome.bookmarks.update(id, changes);
    }

    async move(id, destination) {
        // Cannot move between backends easily here.
        // We assume moves stay within the same backend for now.
        if (this._isMemory(id)) {
            if (destination.parentId && !this._isMemory(destination.parentId)) {
                throw new Error("Cannot move memory node to bookmarks directly.");
            }
            return this.memory.move(id, destination);
        }
        return chrome.bookmarks.move(id, destination);
    }

    async remove(id) {
        if (this._isMemory(id)) return this.memory.remove(id);
        return chrome.bookmarks.remove(id);
    }

    async removeTree(id) {
        if (this._isMemory(id)) return this.memory.removeTree(id);
        return chrome.bookmarks.removeTree(id);
    }

    async search(query) {
        // This is tricky. search is usually global.
        // For InfiniTabs, it's used to find the ROOT folder.
        // We probably don't need full search for memory,
        // but let's support it if we want to find stuff.
        const memResults = await this.memory.search(query);
        const bmResults = await chrome.bookmarks.search(query);
        return [...bmResults, ...memResults];
    }

    // Custom helper to get all sessions from both sources
    async getAllSessions(nativeRootId) {
        let nativeSessions = [];
        try {
            const children = await chrome.bookmarks.getChildren(nativeRootId);
            nativeSessions = children.filter(node => !node.url);
        } catch(e) { console.warn("Error fetching native sessions", e); }

        const memSessions = await this.memory.getChildren(this.memory.rootId);
        return [...nativeSessions, ...memSessions];
    }

    getMemoryRootId() {
        return this.memory.rootId;
    }
}

// Expose as global for compatibility with importScripts in background.js and eval in tests
if (typeof self !== 'undefined') {
    self.storage = new StorageManager();
} else if (typeof global !== 'undefined') {
    global.storage = new StorageManager();
} else {
    // Fallback or window
    this.storage = new StorageManager();
}
