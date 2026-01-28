from playwright.sync_api import sync_playwright
import time
import os

def test_debounce_and_live_update():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--allow-file-access-from-files'])
        context = browser.new_context()

        # --- 1. Verify Options Debounce ---
        page_options = context.new_page()

        mock_script = """
        window.chrome = {
            storage: {
                local: {
                    get: (defaults, cb) => cb(defaults),
                    set: (items, cb) => {
                        window.__storage_set_called = (window.__storage_set_called || 0) + 1;
                        if (cb) cb();
                    }
                },
                onChanged: {
                    addListener: (cb) => {
                        window.__onChangedListener = cb;
                    }
                }
            }
        };
        """

        page_options.add_init_script(mock_script)
        page_options.goto(f"file://{os.getcwd()}/src/options.html")

        # Reset counter
        page_options.evaluate("window.__storage_set_called = 0")

        # Type into color input
        print("Typing into color input...")

        page_options.type("#active-tab-color-input", "a")
        page_options.wait_for_timeout(50)
        page_options.type("#active-tab-color-input", "b")

        # Check count immediately
        count_immediate = page_options.evaluate("window.__storage_set_called")
        print(f"Immediate calls: {count_immediate}")

        if count_immediate > 0:
            print("WARNING: Storage called immediately! Debounce might be failing or wait was too long.")

        # Wait 350ms
        page_options.wait_for_timeout(350)

        count_after = page_options.evaluate("window.__storage_set_called")
        print(f"Calls after 350ms: {count_after}")

        if count_after == 1:
             print("SUCCESS: Storage set called exactly once after delay.")
        elif count_after > 1:
             print(f"WARNING: Storage set called {count_after} times. Debounce might be flaky.")
        else:
             print("FAILURE: Storage set not called.")

        # --- 2. Verify Sidebar Live Update ---
        page_sidebar = context.new_page()
        page_sidebar.add_init_script(mock_script)

        mock_sidebar_script = """
        window.chrome.windows = { getCurrent: async () => ({id: 1}) };
        window.chrome.runtime = {
            sendMessage: async () => ({sessions: [], history: []}),
            onMessage: { addListener: () => {} },
            getURL: (path) => path,
            openOptionsPage: () => {}
        };
        window.localStorage.setItem('infiniTabsTheme', 'light');
        """
        page_sidebar.add_init_script(mock_sidebar_script)

        try:
            page_sidebar.goto(f"file://{os.getcwd()}/src/sidebar.html")
            page_sidebar.wait_for_timeout(1000)

            # Trigger storage change
            print("Triggering storage change in sidebar...")
            page_sidebar.evaluate("""
                if (window.__onChangedListener) {
                    const changes = { activeTabBg: { newValue: 'red' } };
                    window.__onChangedListener(changes, 'local');
                } else {
                    console.error("No onChangedListener found");
                }
            """)

            # Check CSS var
            bg = page_sidebar.evaluate("document.body.style.getPropertyValue('--active-bg')")
            print(f"Sidebar --active-bg: {bg}")

            if bg == 'red':
                print("SUCCESS: Sidebar updated color.")
            else:
                print(f"FAILURE: Sidebar color mismatch: {bg}")

            page_sidebar.screenshot(path="verification/verification.png")

        except Exception as e:
            print(f"Sidebar test failed: {e}")

if __name__ == "__main__":
    test_debounce_and_live_update()
