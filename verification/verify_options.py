import os
import json
from playwright.sync_api import sync_playwright

def verify_options_page():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()

            # Mock chrome API
            mock_chrome = """
            window.chrome = {
                storage: {
                    local: {
                        get: (defaults, callback) => {
                            const items = { ...defaults };
                            if (callback) callback(items);
                            return Promise.resolve(items);
                        },
                        set: (items, callback) => {
                            console.log('Saved:', items);
                            if (callback) callback();
                        }
                    },
                    onChanged: { addListener: () => {} }
                }
            };
            """
            page.add_init_script(mock_chrome)

            # Navigate to options page
            cwd = os.getcwd()
            options_path = f"file://{cwd}/src/options.html"
            page.goto(options_path, wait_until="load")

            # Wait for the checkbox to appear instead of using a fixed sleep,
            # avoiding flakiness on slower CI systems.
            page.wait_for_selector("#restore-mounted-tabs-checkbox")

            # Take screenshot of initial state
            page.screenshot(path="verification/options_initial.png")
            print("Initial screenshot taken.")

            # Check checkbox existence with a hard assertion to fail fast
            checkbox = page.locator("#restore-mounted-tabs-checkbox")
            if not checkbox.is_visible():
                raise AssertionError("restore-mounted-tabs-checkbox not visible")
            print("Checkbox is visible.")

            # Click it
            checkbox.check()

            # Verify it's checked with a hard assertion to fail fast
            if not checkbox.is_checked():
                raise AssertionError("Checkbox did not become checked")
            print("Checkbox is checked.")

            # Take screenshot of checked state
            page.screenshot(path="verification/options_checked.png")
            print("Checked screenshot taken.")
        finally:
            browser.close()

if __name__ == "__main__":
    verify_options_page()
