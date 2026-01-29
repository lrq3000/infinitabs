import os
import sys
from playwright.sync_api import sync_playwright

def test_settings_btn():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Define Mock Chrome API
        page.add_init_script("""
            window.chrome = {
                runtime: {
                    sendMessage: async (msg) => {
                        if (msg.type === 'GET_SESSION_LIST') return { sessions: [] };
                        if (msg.type === 'GET_CURRENT_SESSION_STATE') return { session: null };
                        if (msg.type === 'GET_WORKSPACE_HISTORY') return { history: [], favorites: [] };
                        if (msg.type === 'CHECK_CRASH_STATUS') return { crashed: false };
                        return {};
                    },
                    onMessage: { addListener: () => {} },
                    getURL: (path) => path,
                    openOptionsPage: () => {
                        console.log('chrome.runtime.openOptionsPage called');
                        window.__optionsPageOpened = true;
                    }
                },
                windows: {
                    getCurrent: async () => ({ id: 1 })
                },
                storage: {
                    local: {
                        get: (keys, cb) => cb({})
                    }
                }
            };
        """)

        page.on("console", lambda msg: print(f"PAGE LOG: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        # Load the page
        file_path = os.path.abspath("src/sidebar.html")
        url = f"file://{file_path}"
        print(f"Navigating to: {url}")
        page.goto(url)

        # Check if button exists
        settings_btn = page.wait_for_selector("#settings-btn", timeout=2000)
        if settings_btn:
            print("SUCCESS: #settings-btn found.")
        else:
            print("FAILURE: #settings-btn not found.")
            sys.exit(1)

        # Check visibility
        if settings_btn.is_visible():
            print("SUCCESS: #settings-btn is visible.")
        else:
            print("FAILURE: #settings-btn is not visible.")
            sys.exit(1)

        # Check placement
        parent_class = settings_btn.evaluate("el => el.parentElement.className")
        if parent_class == "header-left-group":
            print("SUCCESS: #settings-btn is inside .header-left-group.")
        else:
            print(f"FAILURE: #settings-btn is NOT inside .header-left-group. Parent class: {parent_class}")
            sys.exit(1)

        # Click and check if mock function was called
        settings_btn.click()

        opened = page.evaluate("window.__optionsPageOpened")
        if opened:
            print("SUCCESS: chrome.runtime.openOptionsPage was called.")
        else:
            print("FAILURE: chrome.runtime.openOptionsPage was NOT called.")
            sys.exit(1)

        # Screenshot
        page.screenshot(path="verification_settings_btn.png")
        print("Screenshot saved to verification_settings_btn.png")

        browser.close()

if __name__ == "__main__":
    test_settings_btn()
