import os
import sys
import json
import tempfile
from playwright.sync_api import sync_playwright

# Configurable artifact directories — override via environment variables for CI/portability
SCREENSHOT_DIR = os.getenv('VERIFICATION_SCREENSHOT_DIR', os.path.join(tempfile.gettempdir(), 'verification_screenshots'))
VIDEO_DIR = os.getenv('VERIFICATION_VIDEO_DIR', os.path.join(tempfile.gettempdir(), 'verification_videos'))

def run_cuj(page):
    # Setup mock state for sidebar
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
            "logicalId": "tab-3",
            "title": "Unmounted Tab",
            "url": "https://example.com/3",
            "liveTabIds": [],
            "groupId": "group-1",
            "indexInSession": 3
        },
        {
            "logicalId": "tab-4",
            "title": "Mounted Tab",
            "url": "https://example.com/4",
            "liveTabIds": [102],
            "groupId": "group-1",
            "indexInSession": 4
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
                    if (msg.type === 'DELETE_MOUNTED_TABS_IN_GROUP') {{
                        window.__delete_mounted_sent = true;
                        return {{ success: true }};
                    }}
                    if (msg.type === 'DELETE_LOGICAL_GROUP') {{
                        window.__delete_logical_sent = true;
                        return {{ success: true }};
                    }}
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
        window.confirm = () => true; // Always confirm dialogs
    """)

    file_path = os.path.abspath("src/sidebar.html")
    url = f"file://{file_path}"
    page.goto(url)

    # Wait for initial render
    page.wait_for_selector("[data-id='tab-4']", state="attached", timeout=2000)

    # 1. Normal mode (showLiveOnly=false) -> DELETE_LOGICAL_GROUP
    page.wait_for_timeout(500)

    # We must hover over the group header itself to make the delete btn visible
    group_header = page.locator("[data-id='group-1']")
    group_delete_btn = page.locator("[data-id='group-1'] .group-delete-btn")

    group_header.hover()
    page.wait_for_timeout(500)

    # Click to delete in normal mode
    group_delete_btn.click()
    page.wait_for_timeout(500)

    # Check if correct message sent
    sent_logical = page.evaluate("window.__delete_logical_sent")
    assert sent_logical is True
    print("Normal mode: DELETE_LOGICAL_GROUP sent successfully.")

    # 2. Live Only mode (showLiveOnly=true) -> DELETE_MOUNTED_TABS_IN_GROUP
    page.evaluate("window.__delete_logical_sent = false")
    toggle_btn = page.locator("#show-live-only-btn")
    toggle_btn.click()
    page.wait_for_timeout(500)

    # Group delete button again (in live only mode)
    group_header.hover()
    page.wait_for_timeout(500)

    group_delete_btn.click()
    page.wait_for_timeout(500)

    sent_mounted = page.evaluate("window.__delete_mounted_sent")
    assert sent_mounted is True
    print("Live Only mode: DELETE_MOUNTED_TABS_IN_GROUP sent successfully.")

    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, "verification.png"))
    page.wait_for_timeout(1000)


if __name__ == "__main__":
    os.makedirs(VIDEO_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-web-security'])
        context = browser.new_context(
            record_video_dir=VIDEO_DIR,
            viewport={"width": 800, "height": 600}
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
