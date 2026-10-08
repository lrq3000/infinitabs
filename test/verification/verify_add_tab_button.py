from pathlib import Path

from playwright.sync_api import sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFICATION_DIR = REPO_ROOT / "verification"
SCREENSHOTS_DIR = VERIFICATION_DIR / "screenshots"
VIDEOS_DIR = VERIFICATION_DIR / "videos"

def run_cuj(page):
    page.goto(f"file://{(REPO_ROOT / 'src' / 'sidebar.html').resolve()}")
    page.wait_for_timeout(500)

    # Check if the Add New Tab button is visible
    button = page.locator("#add-new-tab-btn")
    assert button.is_visible()
    assert button.text_content() == "＋"

    # Take a screenshot
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOTS_DIR / "verification.png"))
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-web-security"])
        context = browser.new_context(
            record_video_dir=str(VIDEOS_DIR)
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
