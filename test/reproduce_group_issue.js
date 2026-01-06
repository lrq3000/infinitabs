
import { listeners } from './mock_chrome.js';
import '../src/utils.js';
// Load background script
await import('../src/background.js');

const GROUP_NAME = "Amazon.fr : livres, DVD, jeux vidéo, musique, high-tech, informatique, jouets, vêtements, chaussures, sport, bricolage, maison, beauté, puériculture, épicerie et plus encore !";
const GROUP_COLOR = "blue";
const EXPECTED_TITLE = `${GROUP_NAME} [${GROUP_COLOR}]`;
const WINDOW_ID = 1;

async function runTest() {
    console.log("Starting Reproduction Test (Duplicate Groups)...");

    // 1. Initialize
    if (listeners['windows.onCreated']) {
        await listeners['windows.onCreated']({ id: WINDOW_ID });
    }
    await new Promise(r => setTimeout(r, 100));

    // 2. Setup: Create a session with an EXISTING group folder
    // We need to find the session ID created by init
    const rootId = (await chrome.bookmarks.search({ title: "InfiniTabs Sessions" }))[0].id;
    const sessionFolder = (await chrome.bookmarks.getChildren(rootId))[0];
    const sessionId = sessionFolder.id;

    console.log(`Session ID: ${sessionId}`);

    // Create the "Existing" group folder
    const existingGroup = await chrome.bookmarks.create({
        parentId: sessionId,
        title: EXPECTED_TITLE
    });
    console.log(`Created existing group folder: ${existingGroup.id} - ${existingGroup.title}`);

    // Verify it exists
    let children = await chrome.bookmarks.getChildren(sessionId);
    let groups = children.filter(c => !c.url);
    console.log(`Groups before test: ${groups.length}`); // Should be 1

    // 3. Simulate "Open background tab in existing group"
    // We assume 'sync' missed this group, so it is NOT in state.liveGroupToBookmark.
    // We treat it as a "new" group event from the perspective of the extension logic.

    const liveGroupId = 999;

    // Setup Mock for TabGroups.get
    chrome.tabGroups.get = async (id) => {
        if (id === liveGroupId) {
            return { id, title: GROUP_NAME, color: GROUP_COLOR, windowId: WINDOW_ID };
        }
        return null;
    };

    // Trigger the logic that calls getOrCreateGroupBookmark.
    // We can use chrome.tabs.onUpdated with groupId change (or initial assignment)
    // or chrome.tabGroups.onCreated (but that implies a NEW group).
    // The user says "opens links as background tabs". This triggers tabs.onCreated.
    // tabs.onCreated checks groupId. If valid, calls getOrCreateGroupBookmark (logic inside).

    const newTab = { id: 555, windowId: WINDOW_ID, groupId: liveGroupId, title: "New Tab", url: "http://example.com" };

    console.log("Triggering tabs.onCreated for tab in group...");
    if (listeners['tabs.onCreated']) {
        await listeners['tabs.onCreated'](newTab);
    }

    // Wait for async processing
    await new Promise(r => setTimeout(r, 500));

    // 4. Verify results
    children = await chrome.bookmarks.getChildren(sessionId);
    groups = children.filter(c => !c.url);
    console.log(`Groups after test: ${groups.length}`);

    groups.forEach(g => console.log(`- ${g.title} (${g.id})`));

    if (groups.length > 1) {
        console.log("FAILURE: Duplicate groups detected!");

        // check titles
        const titles = groups.map(g => g.title);
        const unique = new Set(titles);
        if (unique.size < titles.length) {
             console.log("CONFIRMED: Duplicate titles found.");
        }
    } else {
        console.log("SUCCESS: No duplicates found (or test setup failed to trigger creation).");
    }

}

runTest();
