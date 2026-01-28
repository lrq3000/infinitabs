from playwright.sync_api import sync_playwright
import os
import json

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()

    # Mock Chrome API
    page.add_init_script("""
    window.chrome = {
        runtime: {
            sendMessage: async () => { return { sessions: [] }; },
            onMessage: { addListener: () => {} },
            openOptionsPage: () => {}
        },
        windows: {
            getCurrent: async () => { return { id: 1 }; }
        },
        storage: {
            local: {
                get: (keys, cb) => cb({}),
                set: () => {}
            },
            onChanged: { addListener: () => {} }
        }
    };
    """)

    cwd = os.getcwd()
    page.goto(f"file://{cwd}/src/sidebar.html")

    # Check for the button
    btn = page.locator("#private-mode-btn")
    if btn.is_visible():
        print("Private mode button is visible")
    else:
        print("Private mode button is NOT visible")

    page.screenshot(path="verification_private_mode.png")
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
