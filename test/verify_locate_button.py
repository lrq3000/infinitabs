import os
import sys
import json
from playwright.sync_api import sync_playwright

def test_locate_btn():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Create a context with small height to ensure scrolling is needed
        context = browser.new_context(viewport={"width": 400, "height": 600})
        page = context.new_page()

        # Generate 50 tabs
        logical_tabs = []
        for i in range(50):
            logical_tabs.append({
                "logicalId": f"tab-{i}",
                "title": f"Tab Number {i} - This is a long title to fill space",
                "url": f"https://example.com/page{i}",
                "liveTabIds": [100 + i], # All live for simplicity
                "favIconUrl": "",
                "groupId": None,
                "indexInSession": i
            })

        # Make tab 40 active (should be near bottom)
        active_tab_id = "tab-40"

        mock_session = {
            "sessionId": "sess-1",
            "name": "Test Session",
            "lastActiveLogicalTabId": active_tab_id,
            "logicalTabs": logical_tabs,
            "groups": {}
        }

        # Define Mock Chrome API
        # We use json.dumps to ensure python dicts become valid JS objects
        page.add_init_script(f"""
            window.chrome = {{
                runtime: {{
                    sendMessage: async (msg) => {{
                        if (msg.type === 'GET_SESSION_LIST') return {{ sessions: [{{sessionId: 'sess-1', name: 'Test Session'}}] }};
                        if (msg.type === 'GET_CURRENT_SESSION_STATE') return {{ session: {json.dumps(mock_session)} }};
                        if (msg.type === 'GET_WORKSPACE_HISTORY') return {{ history: [], favorites: [] }};
                        if (msg.type === 'CHECK_CRASH_STATUS') return {{ crashed: false }};
                        return {{}};
                    }},
                    onMessage: {{ addListener: () => {{}} }},
                    getURL: (path) => path,
                    openOptionsPage: () => {{}}
                }},
                windows: {{
                    getCurrent: async () => ({{ id: 1 }})
                }},
                storage: {{
                    local: {{
                        get: (keys, cb) => cb({{}})
                    }}
                }}
            }};
        """)

        page.on("console", lambda msg: print(f"PAGE LOG: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        # Load the page
        file_path = os.path.abspath("src/sidebar.html")
        url = f"file://{file_path}"
        print(f"Navigating to: {url}")
        page.goto(url)

        # Locate Button check
        try:
            locate_btn = page.wait_for_selector("#locate-current", state="visible", timeout=2000)
        except Exception as e:
            print(f"FAILURE: `#locate-current` not found or not visible: {e}")
            sys.exit(1)

        # Wait for tabs to render
        page.wait_for_selector(f"[data-id='{active_tab_id}']", state="attached", timeout=2000)

        # Scroll to top manually to ensure active tab is NOT visible
        tabs_container = page.locator("#tabs-container")
        tabs_container.evaluate("el => el.scrollTop = 0")

        # Verify active tab element reference
        active_el = page.locator(f".tab-item.active-live[data-id='{active_tab_id}']")

        # Check initial visibility (should be hidden or at bottom)
        # Note: with 50 items, tab 40 is likely out of view in a 600px window
        if active_el.is_visible():
             print("Warning: Active tab IS visible before click. It might be barely visible.")
        else:
             print("Active tab is correctly hidden initially.")

        # Click Locate
        print("Clicking locate button...")
        locate_btn.click()

        # Wait for scroll animation
        page.wait_for_timeout(1000)

        # Check visibility
        if active_el.is_visible():
            print("SUCCESS: Active tab is visible after click.")
        else:
            print("FAILURE: Active tab is NOT visible after click.")
            sys.exit(1)

        # Check scrollTop
        scroll_top = tabs_container.evaluate("el => el.scrollTop")
        print(f"ScrollTop: {scroll_top}")
        if scroll_top < 100:
             print("FAILURE: ScrollTop is too low, didn't scroll down enough.")
             sys.exit(1)

        # Screenshot
        page.screenshot(path="verification_locate_btn.png")
        print("Screenshot saved to verification_locate_btn.png")

        browser.close()

if __name__ == "__main__":
    test_locate_btn()
