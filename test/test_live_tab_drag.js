
import './mock_chrome.js';
import { listeners } from './mock_chrome.js';
import { waitFor } from './test_utils.js';

// Mock utils globally
global.formatGroupTitle = function(title, color) { return `${title} [${color}]`; };
global.parseGroupTitle = function(fullTitle) { return { name: fullTitle, color: 'grey' }; };
global.WORD_LIST = ['word'];

// Load background script
await import('../src/background.js');

async function run() {
    console.log("Starting reproduction test...");

    // Trigger startup
    if (listeners['onStartup']) listeners['onStartup']();
    await waitFor(async () => {
        const roots = await chrome.bookmarks.search({ title: "InfiniTabs Sessions" });
        return roots.length > 0;
    }, { label: 'session root creation after startup' });

    // Create Window 1
    const win1 = await chrome.windows.create({ id: 1 });
    // Create Window 2
    const win2 = await chrome.windows.create({ id: 2 });

    await waitFor(async () => {
        const windows = await chrome.windows.getAll();
        return windows.some(w => w.id === 1) && windows.some(w => w.id === 2);
    }, { label: 'two windows to exist' });

    // Verify Sessions created
    const root = await chrome.bookmarks.getChildren('0'); // '0' is usually root, but mock implementation might vary.
    // Wait, mock creates "InfiniTabs Sessions" at root.
    const roots = await chrome.bookmarks.search({ title: "InfiniTabs Sessions" });
    const sessionRootId = roots[0].id;
    await waitFor(async () => {
        const currentSessions = await chrome.bookmarks.getChildren(sessionRootId);
        return currentSessions.some(s => s.title.includes('windowId:1')) && currentSessions.some(s => s.title.includes('windowId:2'));
    }, { label: 'window sessions to be created' });
    const sessions = await chrome.bookmarks.getChildren(sessionRootId);
    console.log(`Sessions created: ${sessions.length}`);
    if (sessions.length !== 2) {
        console.error("Failed to create sessions for windows");
        process.exit(1);
    }

    const session1Id = sessions.find(s => s.title.includes('windowId:1')).id;
    const session2Id = sessions.find(s => s.title.includes('windowId:2')).id;

    // Create a tab in Window 1
    const tab1 = await chrome.tabs.create({ windowId: 1, url: 'http://example.com', title: 'Test Tab' });
    await waitFor(async () => {
        const children = await chrome.bookmarks.getChildren(session1Id);
        return children.some(b => b.url === 'http://example.com');
    }, { label: 'new tab bookmark in source session' });

    // Verify bookmark in Session 1
    const session1Children = await chrome.bookmarks.getChildren(session1Id);
    const bookmark = session1Children.find(b => b.url === 'http://example.com');
    if (!bookmark) {
        console.error("Bookmark not created in Session 1. Children:", JSON.stringify(session1Children, null, 2));
        process.exit(1);
    }
    console.log("Bookmark created in Session 1:", bookmark.id);

    // Verify NOT in Session 2
    const session2ChildrenBefore = await chrome.bookmarks.getChildren(session2Id);
    if (session2ChildrenBefore.find(b => b.url === 'http://example.com')) {
        console.error("Bookmark incorrectly exists in Session 2 already");
        process.exit(1);
    }

    // Simulate Drag to Window 2
    console.log("Simulating drag to Window 2...");

    // update tab object
    tab1.windowId = 2;
    // trigger listeners
    if (listeners['tabs.onDetached']) {
        listeners['tabs.onDetached'](tab1.id, { oldWindowId: 1, oldPosition: 0 });
    }
    if (listeners['tabs.onAttached']) {
        listeners['tabs.onAttached'](tab1.id, { newWindowId: 2, newPosition: 0 });
    }

    await waitFor(async () => {
        const session1ChildrenCurrent = await chrome.bookmarks.getChildren(session1Id);
        const session2ChildrenCurrent = await chrome.bookmarks.getChildren(session2Id);

        const bookmarkStillInSession1 = session1ChildrenCurrent.some(b => b.id === bookmark.id);
        const bookmarkInSession2 = session2ChildrenCurrent.some(b => b.id === bookmark.id);
        return !bookmarkStillInSession1 && bookmarkInSession2;
    }, { label: 'bookmark transfer to target session' });

    // Check if bookmark moved to Session 2
    const session1ChildrenAfter = await chrome.bookmarks.getChildren(session1Id);
    const session2ChildrenAfter = await chrome.bookmarks.getChildren(session2Id);

    const inSession1 = session1ChildrenAfter.find(b => b.id === bookmark.id);
    const inSession2 = session2ChildrenAfter.find(b => b.id === bookmark.id);

    console.log(`In Session 1: ${!!inSession1}, In Session 2: ${!!inSession2}`);

    if (inSession1 && !inSession2) {
        console.error("FAILURE: Bookmark remained in Session 1 (Issue reproduced).");
        process.exit(1);
    } else if (!inSession1 && inSession2) {
        console.log("SUCCESS: Bookmark moved to Session 2.");
        process.exit(0);
    } else {
        console.error("State unclear.");
        console.log("In Session 1:", !!inSession1);
        console.log("In Session 2:", !!inSession2);
        process.exit(1);
    }
}

run();
