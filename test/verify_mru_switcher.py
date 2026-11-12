"""Exercise the unpacked MRU extension in a retained, isolated Chromium profile; never touch the ordinary browser profile."""
import argparse
import json
import tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright, expect
from verify_move_logical_tabs import MovementCheck
from verify_active_tab_reload import FixtureHandler


class MruCheck(MovementCheck):
    def query(self, **options):
        response = self.send_message({"type": "MRU_QUERY", "sourceWindowId": self.window_id, **options})
        assert "error" not in response, response
        return response

    def select_native(self, name):
        self.sidebar.evaluate("async id => { const tab = await chrome.tabs.get(id); await chrome.windows.update(tab.windowId, {focused:true}); await chrome.tabs.update(id, {active:true}); }", self.live_ids[name])
        self.wait_until(lambda: self.query().get("context", {}).get("excludeBookmarkId") == self.bookmark_ids[name], "native focus")

    def run(self):
        self.select_native("A")
        self.select_native("B")
        self.select_native("C")
        expect(self.sidebar.locator("#recent-tabs-btn")).to_be_visible()
        self.sidebar.locator("#recent-tabs-btn").click()
        expect(self.sidebar.locator("#recent-tabs-container")).to_be_visible()
        expect(self.sidebar.locator("#recent-tabs-container [role=option]").first).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
        self.sidebar.screenshot(path=str(self.artifacts / "recent-sidebar.png"))
        self.evidence["flows"].append({"name": "sidebar-mru", "status": "pass"})
        sessions_before = self.send_message({"type": "GET_SESSION_LIST"})["sessions"]
        bookmarks_before = self.snapshot()["bookmarks"]
        with self.context.expect_page() as opened:
            self.sidebar.locator("#open-switcher-btn").click()
        popup = opened.value
        popup.on("pageerror", lambda error: self.evidence["page_errors"].append(str(error)))
        expect(popup.locator("h1")).to_have_text("Recent tabs")
        expect(popup.locator("[role=option]").first).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
        popup.screenshot(path=str(self.artifacts / "switcher-popup.png"))
        assert len(self.send_message({"type": "GET_SESSION_LIST"})["sessions"]) == len(sessions_before), "Switcher created a phantom session"
        assert self.snapshot()["bookmarks"] == bookmarks_before, "Switcher altered canonical bookmarks"
        popup.get_by_role("combobox", name="Search recent tabs").press("ArrowDown")
        popup.get_by_role("combobox", name="Search recent tabs").press("Enter")
        self.wait_until(lambda: popup.is_closed() and self.active_tab()["id"] == self.live_ids["A"], "keyboard activation and popup close")
        self.evidence["flows"].append({"name": "popup-keyboard-no-phantom-session", "status": "pass"})
        # Collection opt-out, not just result hiding: a viewed tab deleted before opt-in must leave no recovery payload.
        self.send_message({"type": "DELETE_LOGICAL_TAB", "windowId": self.window_id, "logicalId": self.logical("C")["logicalId"]})
        self.wait_until(lambda: not self.sidebar.evaluate("id => chrome.bookmarks.get(id).catch(() => [])", self.bookmark_ids["C"]), "deleted C bookmark")
        assert self.send_message({"type": "MRU_RECOVERY_STATUS"}) == {"enabled": False, "count": 0}
        persisted = self.sidebar.evaluate("async () => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('mru.v1.')))")
        assert "?C" not in json.dumps(persisted), persisted
        cdp = self.context.new_cdp_session(self.fixture)
        try:
            with self.context.expect_page() as opened:
                cdp.send("Target.createTarget", {"url": self.sidebar_url.replace("sidebar.html", "options.html"), "background": True})
        finally:
            cdp.detach()
        options = opened.value
        options.locator("#mru-recovery-checkbox").check()
        self.wait_until(lambda: self.send_message({"type": "MRU_RECOVERY_STATUS"})["enabled"], "recovery opt-in")
        self.unmount("B")
        self.send_message({"type": "DELETE_LOGICAL_TAB", "windowId": self.window_id, "logicalId": self.logical("B")["logicalId"]})
        self.wait_until(lambda: self.send_message({"type": "MRU_RECOVERY_STATUS"})["count"] == 1, "opted-in deleted B recovery")
        deleted = next(row for row in self.query()["items"] if row.get("deleted"))
        before = [node["id"] for node in self.snapshot()["bookmarks"][0]["children"]]
        self.sidebar.locator("#recent-tabs-container [data-key='" + deleted["key"] + "']").click()
        self.wait_until(lambda: self.send_message({"type": "MRU_RECOVERY_STATUS"})["count"] == 0, "recovery completion")
        after = self.snapshot()
        children = after["bookmarks"][0]["children"]
        assert [node["id"] for node in children[:-1]] == before, "Recovery changed existing placement"
        assert children[-1]["url"].endswith("?B") and children[-1]["id"] != self.bookmark_ids["B"], "Recovery must append a fresh canonical bookmark"
        assert self.active_tab()["url"].endswith("?B"), "Restored logical tab was not mounted/focused"
        self.evidence["flows"].append({"name": "recovery-opt-in-and-append", "status": "pass"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--executable", type=Path, help="Reuse an installed full Chromium instead of downloading the revision expected by Python Playwright")
    args = parser.parse_args()
    artifacts = Path(tempfile.mkdtemp(prefix="mru-qa-", dir=args.artifacts_dir))
    profile = artifacts / "profile"
    extension = Path(__file__).resolve().parents[1] / "src"
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    check = None
    print(f"MRU evidence/profile retained: {artifacts}", flush=True)
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(str(profile), channel="chromium", executable_path=str(args.executable) if args.executable else None, headless=args.headless,
                viewport={"width": 1100, "height": 800}, ignore_default_args=["--disable-extensions"],
                args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
            try:
                context.set_default_timeout(10000)
                check = MruCheck(context, artifacts)
                check.prepare(f"http://127.0.0.1:{server.server_port}/fixture", names="ABC")
                check.run()
                assert not check.evidence["page_errors"], check.evidence["page_errors"]
                print("MRU browser checks passed", flush=True)
            finally:
                if check:
                    (artifacts / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
                context.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
