
import './mock_chrome.js';
import { listeners } from './mock_chrome.js';

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
    await new Promise(r => setTimeout(r, 100));

    // Create Window 1
    const win1 = await chrome.windows.create({ id: 1 });
    // This should trigger session binding
    await new Promise(r => setTimeout(r, 500));

    // Create Window 2
    const win2 = await chrome.windows.create({ id: 2 });
    await new Promise(r => setTimeout(r, 500));

    // Verify Sessions created
    const root = await chrome.bookmarks.getChildren('0'); // '0' is usually root, but mock implementation might vary.
    // Wait, mock creates "InfiniTabs Sessions" at root.
    const roots = await chrome.bookmarks.search({ title: "InfiniTabs Sessions" });
    const sessionRootId = roots[0].id;
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
    await new Promise(r => setTimeout(r, 500));

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

    await new Promise(r => setTimeout(r, 1000));

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
