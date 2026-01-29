import os
import sys
from playwright.sync_api import sync_playwright

def test_options_checkbox():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Define Mock Chrome API
        page.add_init_script("""
            window.chrome = {
                storage: {
                    local: {
                        get: (keys, cb) => {
                            console.log('storage.get called with', keys);
                            // Return defaults
                            const items = {
                                confirmDeleteLogicalTab: true,
                                historySize: 50,
                                reloadOnRestart: false,
                                nameSessionsWithWords: true,
                                selectLastActiveTab: true,
                                maxTabHistory: 100,
                                restoreMountedTabs: false
                            };
                            if (cb) cb(items);
                            return Promise.resolve(items);
                        },
                        set: (items, cb) => {
                            console.log('storage.set called with', items);
                            if (cb) cb();
                            return Promise.resolve();
                        }
                    }
                }
            };
        """)

        page.on("console", lambda msg: print(f"PAGE LOG: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        # Load the page
        file_path = os.path.abspath("src/options.html")
        url = f"file://{file_path}"
        print(f"Navigating to: {url}")
        page.goto(url)

        # Wait for JS to init
        page.wait_for_timeout(500)

        # Check checkbox
        checkbox = page.wait_for_selector("#name-sessions-with-words-checkbox", timeout=2000)
        if checkbox:
            print("SUCCESS: #name-sessions-with-words-checkbox found.")
        else:
            print("FAILURE: #name-sessions-with-words-checkbox not found.")
            sys.exit(1)

        if checkbox.is_visible():
            print("SUCCESS: Checkbox is visible.")
        else:
            print("FAILURE: Checkbox is not visible.")
            sys.exit(1)

        # Verify default checked state (mock returns true)
        checked = checkbox.is_checked()
        if checked:
            print("SUCCESS: Checkbox is checked by default (from storage).")
        else:
            print("FAILURE: Checkbox is NOT checked.")
            sys.exit(1)

        # Verify other main features are present (regression check)
        history_input = page.query_selector("#history-size-input")
        if history_input:
             print("SUCCESS: History size input found.")

        last_active_chk = page.query_selector("#select-last-active-checkbox")
        if last_active_chk:
             print("SUCCESS: Select last active checkbox found (Merged from Main).")
        else:
             print("FAILURE: Select last active checkbox NOT found (Main merge failed?).")
             sys.exit(1)

        # Verify new feature "Restore mounted tabs"
        restore_tabs_chk = page.query_selector("#restore-mounted-tabs-checkbox")
        if restore_tabs_chk:
             print("SUCCESS: Restore mounted tabs checkbox found (My Feature).")
             if restore_tabs_chk.is_visible():
                  print("SUCCESS: Restore mounted tabs checkbox is visible.")
        else:
             print("FAILURE: Restore mounted tabs checkbox NOT found.")
             sys.exit(1)

        # Screenshot
        screenshot_path = "verification_options_checkbox.png"
        page.screenshot(path=screenshot_path)
        print(f"Screenshot saved to {screenshot_path}")

        browser.close()

if __name__ == "__main__":
    test_options_checkbox()
