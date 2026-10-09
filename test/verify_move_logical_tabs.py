"""Verify same-window MOVE_LOGICAL_TABS in isolated, unpacked Chromium.

Run with Python Playwright and its bundled Chromium. --artifacts-dir must exist;
it defaults to the OS temporary directory. No profiles or artifacts enter Git.
Reuses PR40's public-message, polling, console, and sidebar helpers unchanged.
"""

import argparse
import hashlib
import json
import tempfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from verify_active_tab_reload import ActiveTabReloadCheck, FixtureHandler


class MovementCheck(ActiveTabReloadCheck):
    def prepare(self, fixture_url):
        self.worker = (self.context.service_workers or [None])[0]
        if self.worker is None:
            self.worker = self.context.wait_for_event("serviceworker")
        extension_id = urlparse(self.worker.url).netloc
        self.evidence["extension_id"] = extension_id
        self.fixture = self.context.pages[0]
        target = self.worker.evaluate("async () => (await chrome.tabs.query({active: true}))[0]")
        self.tab_id, self.window_id = target["id"], target["windowId"]
        self.sidebar_url = f"chrome-extension://{extension_id}/sidebar.html"
        self.open_sidebar()
        self.session()
        self.live_ids = {"A": self.tab_id}
        self.bookmark_ids = {}
        for name in "ABCDE":
            page = self.fixture
            if name != "A":
                with self.context.expect_page() as opened:
                    tab = self.worker.evaluate("""windowId => chrome.tabs.create({
                        windowId, url: 'about:blank', active: false
                    })""", self.window_id)
                self.live_ids[name] = tab["id"]
                page = opened.value
                self.wait_until(lambda: any(tab["id"] in logical["liveTabIds"]
                    for logical in self.session()["logicalTabs"]), "new blank tab mapping")
            url = fixture_url + "?" + name
            page.goto(url)
            saved = self.wait_until(lambda: next((tab for tab in self.session()["logicalTabs"]
                if tab["lastSavedUrl"] == url and self.live_ids[name] in tab["liveTabIds"]), None),
                f"saved fixture {name}")
            self.bookmark_ids[name] = saved["bookmarkId"]
        self.fixture.bring_to_front()
        self.wait_until(lambda: self.session()["lastActiveLogicalTabId"] == self.logical("A")["logicalId"],
                        "active fixture mapping")

    def logical(self, name):
        return next(tab for tab in self.session()["logicalTabs"] if tab["bookmarkId"] == self.bookmark_ids[name])

    def group(self):
        self.group_id = self.sidebar.evaluate("ids => chrome.tabs.group({tabIds: ids})",
                                             [self.live_ids[name] for name in "CD"])
        self.wait_until(lambda: self.logical("C")["groupId"] and
            self.logical("C")["groupId"] == self.logical("D")["groupId"], "native group bookmark mapping")
        self.group_bookmark_id = self.logical("C")["groupId"]

    def snapshot(self):
        return {"session": self.session(), "native": self.sidebar.evaluate(
            "windowId => chrome.tabs.query({windowId})", self.window_id),
            "bookmarks": self.sidebar.evaluate("id => chrome.bookmarks.getSubTree(id)", self.session()["sessionId"])}

    def unmount(self, name):
        response = self.send_message({"type": "UNMOUNT_LOGICAL_TAB", "windowId": self.window_id,
                                      "logicalId": self.logical(name)["logicalId"]})
        assert response.get("success"), response
        self.wait_until(lambda: not self.logical(name)["liveTabIds"], f"unmount {name}")
        del self.live_ids[name]

    def verify_live_only_deletion(self):
        # The existing group-removal listener preserves saved-only children. Check
        # that native move events did not leave stale mappings that defeat it.
        self.unmount("D")
        before = self.snapshot()
        response = self.send_message({"type": "DELETE_MOUNTED_TABS_IN_GROUP", "windowId": self.window_id,
                                      "groupId": self.group_bookmark_id})
        assert response.get("success"), response
        self.fixture = self.sidebar  # A was active and is now intentionally deleted.
        self.fixture.wait_for_timeout(500)
        after = self.snapshot()
        self.evidence["flows"].append({"flow": "live_only_deletion_after_move", "before": before, "after": after})
        retained = {tab["bookmarkId"]: tab for tab in after["session"]["logicalTabs"]}
        for name in "ABC":
            assert self.bookmark_ids[name] not in retained, f"Mounted bookmark {name} not deleted"
        assert retained[self.bookmark_ids["D"]]["groupId"] == self.group_bookmark_id
        assert retained[self.bookmark_ids["D"]]["liveTabIds"] == []
        assert self.bookmark_ids["E"] in retained
        assert self.group_bookmark_id in after["session"]["groups"], "Saved-only group must survive native removal"
        children = self.sidebar.evaluate("id => chrome.bookmarks.getChildren(id)", self.group_bookmark_id)
        assert [child["id"] for child in children] == [self.bookmark_ids["D"]]

    def move(self, names, target, position, order, grouped=""):
        before = self.snapshot()
        by_bookmark = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
        request = {"type": "MOVE_LOGICAL_TABS", "windowId": self.window_id,
            "logicalIds": [by_bookmark[self.bookmark_ids[name]]["logicalId"] for name in names],
            "targetLogicalId": self.group_bookmark_id if target == "group" else
                by_bookmark[self.bookmark_ids[target]]["logicalId"], "position": position}
        response = self.send_message(request)
        assert response.get("success"), response
        # Let production onMoved's 50ms queue and ungroup's 100ms delayed callback
        # run before checking the durable result, not only the message response.
        self.fixture.wait_for_timeout(500)
        after = self.snapshot()
        record = {"request": request, "before": before, "after": after, "expected_order": list(order)}
        self.evidence["flows"].append(record)
        self.sidebar.screenshot(path=str(self.artifacts / f"move-{len(self.evidence['flows'])}.png"))
        session = after["session"]
        assert session["sessionId"] == before["session"]["sessionId"]
        assert set(session["groups"]) == set(before["session"]["groups"]), "Retain group folders, including empty ones"
        current = {tab["bookmarkId"]: tab for tab in session["logicalTabs"]}
        assert set(current) == set(by_bookmark), "Move must retain every bookmark"
        for name, bookmark_id in self.bookmark_ids.items():
            tab = current[bookmark_id]
            assert tab["logicalId"] != by_bookmark[bookmark_id]["logicalId"], "Logical IDs must refresh"
            assert tab["liveTabIds"] == ([self.live_ids[name]] if name in self.live_ids else []), f"Live identity changed: {name}"
            assert tab["groupId"] == (self.group_bookmark_id if name in grouped else None), f"Logical group: {name}"
        names_by_bookmark = {value: key for key, value in self.bookmark_ids.items()}
        logical_order = [names_by_bookmark[tab["bookmarkId"]] for tab in session["logicalTabs"]
                         if tab["bookmarkId"] in names_by_bookmark]
        assert logical_order == list(order), f"Bookmark order: expected {order}, got {logical_order}"
        names_by_live = {value: key for key, value in self.live_ids.items()}
        native = [tab for tab in after["native"] if tab["id"] in names_by_live]
        for tab in native:
            name = names_by_live[tab["id"]]
            expected = self.group_id if name in grouped else -1
            assert tab["groupId"] == expected, f"Native group {name}: expected {expected}, got {tab['groupId']}"
        native_order = [names_by_live[tab["id"]] for tab in native]
        expected_native = [name for name in order if name in self.live_ids]
        assert native_order == expected_native, f"Native order: expected {expected_native}, got {native_order}"
        assert self.active_tab()["id"] == self.tab_id
        active_logical_id = current[self.bookmark_ids["A"]]["logicalId"]
        assert session["lastActiveLogicalTabId"] == active_logical_id
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_count(1)
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_attribute("data-id", active_logical_id)

    def run(self, flow):
        if flow in ("group_in", "group_out"):
            self.group()
        if flow == "group_in":
            self.move("AB", "group", "inside", "CDABE", "CDAB")
            self.move("AB", "C", "before", "ABCDE", "ABCD")
            self.verify_live_only_deletion()
        elif flow == "group_out":
            self.move("CD", "A", "before", "CDABE")
        elif flow == "forward":
            self.move("AB", "E", "before", "CDABE")
            self.unmount("D")
            self.move("BA", "E", "after", "CDEBA")
            self.move("ED", "C", "before", "EDCBA")
            self.move("D", "B", "after", "ECBDA")
            self.move("EB", "A", "after", "CDAEB")
        elif flow == "backward":
            self.move("DE", "B", "before", "ADEBC")
            self.move("DE", "A", "before", "DEABC")
        assert not self.evidence["page_errors"], self.evidence["page_errors"]
        errors = [msg for msg in self.evidence["worker_console"] if msg["type"] == "error"]
        assert not errors, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--flow", choices=["all", "group_in", "group_out", "forward", "backward"], default="all")
    args = parser.parse_args()
    if not args.artifacts_dir.is_dir():
        parser.error("--artifacts-dir must exist")
    extension = Path(__file__).resolve().parents[1] / "src"
    artifacts = Path(tempfile.mkdtemp(prefix="movement-evidence-", dir=args.artifacts_dir))
    print(f"Extension: {extension}\nEvidence: {artifacts}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    failures = []
    try:
        with sync_playwright() as playwright:
            for flow in (["group_in", "group_out", "forward", "backward"] if args.flow == "all" else [args.flow]):
                folder = artifacts / flow
                folder.mkdir()
                with tempfile.TemporaryDirectory(prefix="movement-profile-", dir=args.artifacts_dir) as profile:
                    context = playwright.chromium.launch_persistent_context(profile, headless=False,
                        viewport={"width": 1100, "height": 800}, ignore_default_args=["--disable-extensions"],
                        args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
                    context.set_default_timeout(15000)
                    check = MovementCheck(context, folder)
                    check.evidence.update(extension_path=str(extension), isolated_profile=profile,
                        chromium=context.browser.version, source_sha256={str(path.relative_to(extension)):
                            hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(extension.rglob("*")) if path.is_file()})
                    try:
                        check.prepare(f"http://127.0.0.1:{server.server_port}/movement")
                        check.run(flow)
                        print(f"PASS {flow} ({check.evidence['extension_id']})", flush=True)
                    except Exception as error:
                        check.evidence["failure"] = str(error)
                        failures.append(f"{flow}: {error}")
                        print(f"FAIL {flow}: {error}", flush=True)
                    finally:
                        (folder / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
                        context.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert not failures, failures


if __name__ == "__main__":
    main()
