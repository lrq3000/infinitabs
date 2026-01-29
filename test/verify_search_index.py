import os
import sys
import json
from playwright.sync_api import sync_playwright

def test_search_index():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-web-security"])
        context = browser.new_context()
        page = context.new_page()

        # Define Mock Chrome API
        page.add_init_script("""
            window.mockListeners = [];
            window.chrome = {
                runtime: {
                    sendMessage: async (msg) => {
                        if (msg.type === 'GET_SESSION_LIST') return { sessions: [{sessionId: 's1', name: 'Session 1'}] };
                        if (msg.type === 'GET_CURRENT_SESSION_STATE') {
                            return {
                                session: {
                                    sessionId: 's1',
                                    name: 'Session 1',
                                    lastActiveLogicalTabId: 't1',
                                    groups: {},
                                    logicalTabs: [
                                        { logicalId: 't1', title: 'Google Search', url: 'https://google.com', liveTabIds: [101], indexInSession: 0 },
                                        { logicalId: 't2', title: 'GitHub', url: 'https://github.com', liveTabIds: [102], indexInSession: 1 },
                                        { logicalId: 't3', title: 'Gmail', url: 'https://mail.google.com', liveTabIds: [103], indexInSession: 2 }
                                    ]
                                }
                            };
                        }
                        return {};
                    },
                    onMessage: {
                        addListener: (cb) => {
                            window.mockListeners.push(cb);
                        }
                    },
                    getURL: (path) => path
                },
                windows: {
                    getCurrent: async () => ({ id: 1 })
                },
                storage: {
                    local: {
                        get: (keys, cb) => cb({}),
                    },
                    onChanged: { addListener: () => {} }
                }
            };

            // Helper to dispatch message
            window.dispatchMessage = (msg) => {
                window.mockListeners.forEach(cb => cb(msg));
            };
        """)

        page.on("console", lambda msg: print(f"PAGE LOG: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        # Load the page
        file_path = os.path.abspath("src/sidebar.html")
        url = f"file://{file_path}"
        print(f"Navigating to: {url}")
        page.goto(url)

        # Wait for session to render (check for tabs)
        page.wait_for_selector(".tab-item[data-id='t1']", timeout=2000)

        # 1. Search for "google"
        print("Test 1: Search for 'google'")
        page.fill("#search-input", "google")
        # Trigger input event manually if needed, but fill does it.
        # Wait for search execution (it's synchronous but DOM update might take a tick)
        page.wait_for_timeout(100)

        # Verify t1 (Google Search) and t3 (Gmail) are matches
        matches = page.locator(".search-match")
        count = matches.count()
        if count != 2:
            print(f"FAILURE: Expected 2 matches for 'google', got {count}")
            sys.exit(1)

        ids = matches.evaluate_all("els => els.map(el => el.dataset.id)")
        if 't1' not in ids or 't3' not in ids:
             print(f"FAILURE: Expected t1 and t3, got {ids}")
             sys.exit(1)
        print("SUCCESS: Search 'google' found correct tabs.")

        # 2. Search for "github"
        print("Test 2: Search for 'github'")
        page.fill("#search-input", "github")
        page.wait_for_timeout(100)
        matches = page.locator(".search-match")
        if matches.count() != 1:
             print(f"FAILURE: Expected 1 match for 'github', got {matches.count()}")
             sys.exit(1)

        id = matches.get_attribute("data-id")
        if id != 't2':
             print(f"FAILURE: Expected t2, got {id}")
             sys.exit(1)
        print("SUCCESS: Search 'github' found correct tab.")

        # 3. Simulate adding a new tab via STATE_UPDATED
        print("Test 3: Add new tab and search for it")
        new_session = {
            "sessionId": 's1',
            "name": 'Session 1',
            "lastActiveLogicalTabId": 't1',
            "groups": {},
            "logicalTabs": [
                { "logicalId": 't1', "title": 'Google Search', "url": 'https://google.com', "liveTabIds": [101], "indexInSession": 0 },
                { "logicalId": 't2', "title": 'GitHub', "url": 'https://github.com', "liveTabIds": [102], "indexInSession": 1 },
                { "logicalId": 't3', "title": 'Gmail', "url": 'https://mail.google.com', "liveTabIds": [103], "indexInSession": 2 },
                { "logicalId": 't4', "title": 'New Tab', "url": 'https://example.com', "liveTabIds": [104], "indexInSession": 3 }
            ]
        }

        page.evaluate(f"window.dispatchMessage({{ type: 'STATE_UPDATED', windowId: 1, session: {json.dumps(new_session)} }})")
        page.wait_for_selector(".tab-item[data-id='t4']", timeout=2000)

        # Search for "example"
        page.fill("#search-input", "example")
        page.wait_for_timeout(100)
        matches = page.locator(".search-match")
        if matches.count() != 1:
             print(f"FAILURE: Expected 1 match for 'example', got {matches.count()}")
             sys.exit(1)
        if matches.get_attribute("data-id") != 't4':
             print("FAILURE: Expected t4")
             sys.exit(1)
        print("SUCCESS: Search found new tab 'example'.")

        # 4. Simulate removing a tab
        print("Test 4: Remove tab and verify search")
        # Remove t2 (GitHub)
        new_session["logicalTabs"] = [t for t in new_session["logicalTabs"] if t["logicalId"] != 't2']
        page.evaluate(f"window.dispatchMessage({{ type: 'STATE_UPDATED', windowId: 1, session: {json.dumps(new_session)} }})")

        # Search for "github" - should be 0
        page.fill("#search-input", "github")
        page.wait_for_timeout(100)
        matches = page.locator(".search-match")
        if matches.count() != 0:
             print(f"FAILURE: Expected 0 matches for 'github', got {matches.count()}")
             sys.exit(1)
        print("SUCCESS: Removed tab not found.")

        # 5. Simulate updating a tab title
        print("Test 5: Rename tab and search")
        # Rename t1 to "Alpha Search"
        new_session["logicalTabs"][0]["title"] = "Alpha Search"
        page.evaluate(f"window.dispatchMessage({{ type: 'STATE_UPDATED', windowId: 1, session: {json.dumps(new_session)} }})")

        # Search for "alpha"
        page.fill("#search-input", "alpha")
        page.wait_for_timeout(100)
        matches = page.locator(".search-match")
        if matches.count() != 1:
             print(f"FAILURE: Expected 1 match for 'alpha', got {matches.count()}")
             sys.exit(1)
        if matches.get_attribute("data-id") != 't1':
             print("FAILURE: Expected t1")
             sys.exit(1)

        # Search for "google" - should still find URL or if title changed?
        # URL is still https://google.com.
        page.fill("#search-input", "google")
        page.wait_for_timeout(100)
        # t1 (url matches) and t3 (url/title matches)
        matches = page.locator(".search-match")
        if matches.count() != 2:
             print(f"FAILURE: Expected 2 matches for 'google' (url match), got {matches.count()}")
             sys.exit(1)
        print("SUCCESS: Updated tab found by new title and old url.")

        print("ALL TESTS PASSED")
        browser.close()

if __name__ == "__main__":
    test_search_index()
