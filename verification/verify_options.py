import os
import json
from playwright.sync_api import sync_playwright

def verify_options_page():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
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
        page.goto(options_path)

        # Wait for options.js to run and populate
        page.wait_for_timeout(500) # Wait a bit for JS execution

        # Take screenshot of initial state
        page.screenshot(path="verification/options_initial.png")
        print("Initial screenshot taken.")

        # Check checkbox existence
        checkbox = page.locator("#restore-mounted-tabs-checkbox")
        if checkbox.is_visible():
            print("Checkbox is visible.")
        else:
            print("Checkbox NOT visible.")

        # Click it
        checkbox.check()

        # Verify it's checked
        if checkbox.is_checked():
            print("Checkbox is checked.")

        # Take screenshot of checked state
        page.screenshot(path="verification/options_checked.png")
        print("Checked screenshot taken.")

        browser.close()

if __name__ == "__main__":
    verify_options_page()
