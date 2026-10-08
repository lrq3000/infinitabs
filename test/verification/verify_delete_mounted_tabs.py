from playwright.sync_api import sync_playwright
import os
import tempfile

def run_cuj(page):
    """Smoke navigation test: opens the sidebar and waits for initial render.
    This script is intended as a manual verification CUJ (critical user journey)
    for the 'Delete only mounted tabs' feature, not as an automated test suite."""
    page.goto("http://localhost:3000/src/sidebar.html") # We'll need to serve the local files
    page.wait_for_timeout(500)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        video_dir = os.getenv('VERIFICATION_VIDEO_DIR', os.path.join(tempfile.gettempdir(), 'verification_videos'))
        os.makedirs(video_dir, exist_ok=True)
        context = browser.new_context(
            record_video_dir=video_dir
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()  # MUST close context to save the video
            browser.close()
