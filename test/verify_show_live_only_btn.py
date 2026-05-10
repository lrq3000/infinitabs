import os
import sys
import json
from playwright.sync_api import sync_playwright

def test_show_live_only_btn():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-web-security'])
        context = browser.new_context()
        page = context.new_page()

        logical_tabs = [
            {
                "logicalId": "tab-1",
                "title": "Tab 1",
                "url": "https://example.com/1",
                "liveTabIds": [101],
                "groupId": None,
                "indexInSession": 0
            },
            {
                "logicalId": "tab-2",
                "title": "Tab 2",
                "url": "https://example.com/2",
                "liveTabIds": [],
                "groupId": None,
                "indexInSession": 1
            },
            {
                "logicalId": "tab-3",
                "title": "Tab 3",
                "url": "https://example.com/3",
                "liveTabIds": [],
                "groupId": "group-1",
                "indexInSession": 3
            },
            {
                "logicalId": "tab-4",
                "title": "Tab 4",
                "url": "https://example.com/4",
                "liveTabIds": [102],
                "groupId": "group-1",
                "indexInSession": 4
            },
            {
                "logicalId": "tab-5",
                "title": "Tab 5",
                "url": "https://example.com/5",
                "liveTabIds": [],
                "groupId": "group-2",
                "indexInSession": 6
            }
        ]

        mock_session = {
            "sessionId": "sess-1",
            "name": "Test Session",
            "lastActiveLogicalTabId": "tab-1",
            "logicalTabs": logical_tabs,
            "groups": {
                "group-1": {
                    "groupId": "group-1",
                    "title": "Group 1 [blue]",
                    "indexInSession": 2
                },
                "group-2": {
                    "groupId": "group-2",
                    "title": "Group 2 [red]",
                    "indexInSession": 5
                }
            }
        }

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

        page.add_init_script("""
            window.__scrollIntoViewTargets = [];
            const __originalScrollIntoView = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function(...args) {
                const id = this.getAttribute && this.getAttribute('data-id');
                if (id) {
                    window.__scrollIntoViewTargets.push(id);
                }
                return Reflect.apply(__originalScrollIntoView, this, args);
            };
        """)

        page.on("console", lambda msg: print(f"PAGE LOG: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        file_path = os.path.abspath("src/sidebar.html")
        url = f"file://{file_path}"
        page.goto(url)

        # Wait for all 5 tabs and 2 groups to render
        page.wait_for_selector("[data-id='tab-5']", state="attached", timeout=2000)

        # Count initially
        tabs_count = page.locator(".tab-item").count()
        groups_count = page.locator(".group-header").count()

        assert tabs_count == 5, f"Expected 5 tabs initially, got {tabs_count}"
        assert groups_count == 2, f"Expected 2 groups initially, got {groups_count}"

        # Click the toggle button
        toggle_btn = page.locator("#show-live-only-btn")
        page.evaluate("window.__scrollIntoViewTargets = []")
        toggle_btn.click()

        # Wait for render to finish (we can wait for tab-2 to detach)
        page.wait_for_selector("[data-id='tab-2']", state="detached", timeout=2000)

        tabs_count_after = page.locator(".tab-item").count()
        groups_count_after = page.locator(".group-header").count()

        assert tabs_count_after == 2, f"Expected 2 live tabs, got {tabs_count_after}"
        assert groups_count_after == 1, f"Expected 1 group with live tabs, got {groups_count_after}"

        # Wait a frame for requestAnimationFrame(scrollToActiveTab) to run.
        page.wait_for_timeout(100)
        scroll_targets_live_only = page.evaluate("window.__scrollIntoViewTargets")
        assert "tab-1" in scroll_targets_live_only, f"Expected toggle-on auto-scroll to focus tab-1, got {scroll_targets_live_only}"

        # Ensure correct tabs/groups are rendered
        assert page.locator("[data-id='tab-1']").is_visible()
        assert page.locator("[data-id='tab-4']").is_visible()
        assert page.locator("[data-id='group-1']").is_visible()

        # Reset scroll capture to isolate untoggle behavior.
        page.evaluate("window.__scrollIntoViewTargets = []")

        # Untoggle and confirm list is restored.
        toggle_btn.click()
        page.wait_for_selector("[data-id='tab-2']", state="attached", timeout=2000)

        tabs_count_restored = page.locator(".tab-item").count()
        groups_count_restored = page.locator(".group-header").count()

        assert tabs_count_restored == 5, f"Expected 5 tabs after untoggle, got {tabs_count_restored}"
        assert groups_count_restored == 2, f"Expected 2 groups after untoggle, got {groups_count_restored}"

        # Wait deterministically for requestAnimationFrame(scrollToActiveTab) side-effect.
        page.wait_for_function(
            "() => Array.isArray(window.__scrollIntoViewTargets) && window.__scrollIntoViewTargets.includes('tab-1')",
            timeout=2000
        )
        scroll_targets = page.evaluate("window.__scrollIntoViewTargets")
        assert "tab-1" in scroll_targets, f"Expected untoggle auto-scroll to focus tab-1, got {scroll_targets}"

        print("SUCCESS: show-live-only-btn works correctly.")

        browser.close()

if __name__ == "__main__":
    test_show_live_only_btn()
