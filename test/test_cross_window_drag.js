
import './mock_chrome.js';
import { listeners } from './mock_chrome.js';

// Mock utils globally
global.formatGroupTitle = function(title, color) { return `${title} [${color}]`; };
global.parseGroupTitle = function(fullTitle) { return { name: fullTitle, color: 'grey' }; };
global.WORD_LIST = ['word'];

// Load background script
await import('../src/background.js');

async function run() {
    console.log("Starting cross-window drag test...");

    // Trigger startup
    if (listeners['onStartup']) listeners['onStartup']();
    await new Promise(r => setTimeout(r, 100));

    // Create Window 1 & 2
    const win1 = await chrome.windows.create({ id: 1 });
    await new Promise(r => setTimeout(r, 500));
    const win2 = await chrome.windows.create({ id: 2 });
    await new Promise(r => setTimeout(r, 500));

    // Get Sessions
    const roots = await chrome.bookmarks.search({ title: "InfiniTabs Sessions" });
    const sessions = await chrome.bookmarks.getChildren(roots[0].id);
    const session1Id = sessions.find(s => s.title.includes('windowId:1')).id;
    const session2Id = sessions.find(s => s.title.includes('windowId:2')).id;

    // Create a tab in Window 1
    const tab1 = await chrome.tabs.create({ windowId: 1, url: 'http://example.com', title: 'Test Tab' });
    await new Promise(r => setTimeout(r, 500));

    // Verify bookmark in Session 1
    const session1Children = await chrome.bookmarks.getChildren(session1Id);
    // Note: tab created without group ID defaults to -1 in my mock update, but let's check structure
    // If grouped, it's deep. If not, shallow.
    // My previous reproduction showed it might be grouped if not careful, but I fixed default groupId.
    // However, the tab might be inserted into a group if `background.js` logic decides so.
    // `handleNewTab`: `if (tab.groupId !== -1)`.

    // Let's find the logical ID of the tab.
    // We can't access `state` directly easily unless we export it or hack it.
    // But we can look at bookmarks.

    // Find bookmark by URL
    let bookmark1 = session1Children.find(b => b.url === 'http://example.com');
    // If not found, check subfolders
    if (!bookmark1) {
        for (const child of session1Children) {
             if (child.children) {
                 bookmark1 = child.children.find(b => b.url === 'http://example.com');
                 if (bookmark1) break;
             }
        }
    }

    if (!bookmark1) {
        console.error("Bookmark not found in Session 1");
        process.exit(1);
    }

    console.log("Found bookmark in Session 1:", bookmark1.id);

    // Need logical ID.
    // We can get session state via message.
    let response = {};
    const sendResponse = (res) => { response = res; };

    // Get session 1 state
    await listeners['onMessage']({ type: 'GET_CURRENT_SESSION_STATE', windowId: 1 }, {}, sendResponse);
    const session1State = response.session;
    const logicalTab1 = session1State.logicalTabs.find(l => l.bookmarkId === bookmark1.id);

    if (!logicalTab1) {
        console.error("Logical tab not found in state");
        process.exit(1);
    }
    const logicalId1 = logicalTab1.logicalId;
    console.log("Logical ID:", logicalId1);

    // Simulate MOVE_LOGICAL_TABS to Session 2 (Window 2)
    console.log("Moving logical tab to Window 2...");

    await listeners['onMessage']({
        type: 'MOVE_LOGICAL_TABS',
        windowId: 2, // Target window
        logicalIds: [logicalId1],
        targetLogicalId: session2Id, // Move to session root (append)
        position: 'inside'
    }, {}, () => {});

    await new Promise(r => setTimeout(r, 1000));

    // Verify Bookmark Moved
    const session1ChildrenAfter = await chrome.bookmarks.getChildren(session1Id);
    const session2ChildrenAfter = await chrome.bookmarks.getChildren(session2Id);

    const inSession1 = session1ChildrenAfter.some(b => b.id === bookmark1.id);
    const inSession2 = session2ChildrenAfter.some(b => b.id === bookmark1.id);

    if (inSession1) {
        console.error("FAILURE: Bookmark still in Session 1");
        process.exit(1);
    }
    if (!inSession2) {
        console.error("FAILURE: Bookmark not in Session 2");
        process.exit(1);
    }
    console.log("Bookmark moved successfully.");

    // Verify Live Tab Moved
    const tabs1 = await chrome.tabs.query({ windowId: 1 });
    const tabs2 = await chrome.tabs.query({ windowId: 2 });

    const tabInWin1 = tabs1.find(t => t.url === 'http://example.com');
    const tabInWin2 = tabs2.find(t => t.url === 'http://example.com');

    if (tabInWin1) {
        console.error("FAILURE: Live tab still in Window 1");
        process.exit(1);
    }
    if (!tabInWin2) {
        console.error("FAILURE: Live tab not in Window 2");
        process.exit(1);
    }

    console.log("Live tab moved successfully.");
    console.log("SUCCESS");
    process.exit(0);
}

run();
