from playwright.sync_api import sync_playwright
import os

def run_cuj(page):
    page.goto(f"file://{os.path.abspath('src/sidebar.html')}")
    page.wait_for_timeout(500)

    # Check if the Add New Tab button is visible
    button = page.locator("#add-new-tab-btn")
    assert button.is_visible()
    assert button.text_content() == "＋"

    # Take a screenshot
    os.makedirs("/home/jules/verification/screenshots", exist_ok=True)
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-web-security"])
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos"
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
