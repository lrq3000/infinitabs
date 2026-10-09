"""Verify same-window MOVE_LOGICAL_TABS in isolated, unpacked Chromium.

Run with Python Playwright and its bundled Chromium. --artifacts-dir must exist;
it defaults to the OS temporary directory. No profiles or artifacts enter Git.
Reuses PR40's public-message, polling, console, and sidebar helpers unchanged.
"""

import argparse
import faulthandler
import hashlib
import json
import tempfile
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from verify_active_tab_reload import ActiveTabReloadCheck, FixtureHandler


class MovementCheck(ActiveTabReloadCheck):
    def prepare(self, fixture_url, names="ABCDE"):
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
        self.active_name = names[0]
        self.live_ids = {self.active_name: self.tab_id}
        self.bookmark_ids = {}
        for name in names:
            page = self.fixture
            if name != self.active_name:
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
        self.wait_until(lambda: self.session()["lastActiveLogicalTabId"] == self.logical(self.active_name)["logicalId"],
                        "active fixture mapping")
        # Observe real event feedback without replacing any extension API/listener.
        self.sidebar.evaluate("""() => {
            globalThis.movementEvents = [];
            const record = (type, detail) => movementEvents.push({type, detail, at: Date.now()});
            chrome.tabs.onUpdated.addListener((id, change, tab) => {
                if (change.groupId !== undefined) record('tab-group', {id, change, tab});
            });
            chrome.tabs.onMoved.addListener((id, info) => record('tab-moved', {id, info}));
            chrome.tabGroups.onCreated.addListener(group => record('group-created', group));
            chrome.tabGroups.onRemoved.addListener(group => record('group-removed', group));
            chrome.bookmarks.onMoved.addListener((id, info) => record('bookmark-moved', {id, info}));
        }""")

    def logical(self, name):
        return next(tab for tab in self.session()["logicalTabs"] if tab["bookmarkId"] == self.bookmark_ids[name])

    def group(self, names="CD"):
        self.group_id = self.sidebar.evaluate("ids => chrome.tabs.group({tabIds: ids})",
                                             [self.live_ids[name] for name in names])
        self.wait_until(lambda: self.logical(names[0])["groupId"] and all(
            self.logical(name)["groupId"] == self.logical(names[0])["groupId"] for name in names),
            "native group bookmark mapping")
        self.group_bookmark_id = self.logical(names[0])["groupId"]

    def saved_destination(self):
        self.group("S")
        self.sidebar.evaluate("id => chrome.tabGroups.update(id, {title: 'Saved destination', color: 'blue'})", self.group_id)
        self.wait_until(lambda: self.session()["groups"][self.group_bookmark_id]["title"] == "Saved destination [blue]",
                        "saved group metadata")
        self.unmount("S")
        self.wait_until(lambda: not self.sidebar.evaluate("windowId => chrome.tabGroups.query({windowId})", self.window_id),
                        "destination to have no native group")
        # Fixture placement uses the existing bookmark-folder move path, leaving
        # A/B/C/D live and S saved-only. The tested operation selects only A/B.
        response = self.send_message({"type": "MOVE_LOGICAL_TABS", "windowId": self.window_id,
            "logicalIds": [self.group_bookmark_id], "targetLogicalId": self.logical("D")["logicalId"], "position": "before"})
        assert response.get("success"), response
        self.group_id = None  # The tested move must create a new native group.

    def snapshot(self):
        return {"session": self.session(), "native": self.sidebar.evaluate(
            "windowId => chrome.tabs.query({windowId})", self.window_id),
            "native_groups": self.sidebar.evaluate("windowId => chrome.tabGroups.query({windowId})", self.window_id),
            "bookmarks": self.sidebar.evaluate("id => chrome.bookmarks.getSubTree(id)", self.session()["sessionId"])}

    def unmount(self, name):
        response = self.send_message({"type": "UNMOUNT_LOGICAL_TAB", "windowId": self.window_id,
                                      "logicalId": self.logical(name)["logicalId"]})
        assert response.get("success"), response
        self.wait_until(lambda: not self.logical(name)["liveTabIds"], f"unmount {name}")
        del self.live_ids[name]

    def wait_for_settled(self, validate, description, quiet_ms=500, timeout_ms=15000):
        """Require the expected state AND an uninterrupted quiet observation.

        Polling is bounded; any native/bookmark event or snapshot change resets
        the quiet interval. A finite observation cannot prove arbitrary future
        silence, so timeout evidence records the last state and assertion.
        """
        deadline = time.monotonic() + timeout_ms / 1000
        quiet_since = None
        previous = None
        last_error = None
        while time.monotonic() < deadline:
            snapshot = self.snapshot()
            events = self.sidebar.evaluate("movementEvents")
            signature = json.dumps([snapshot, events], sort_keys=True)
            try:
                validate(snapshot)
            except (AssertionError, KeyError) as error:
                last_error = str(error)
                quiet_since = None
            else:
                if quiet_since is None or signature != previous:
                    quiet_since = time.monotonic()
                if time.monotonic() - quiet_since >= quiet_ms / 1000:
                    return snapshot
            previous = signature
            self.fixture.wait_for_timeout(50)  # Poll cadence, not a success criterion.
        self.evidence["settling_timeout"] = {
            "description": description, "last_error": last_error,
            "snapshot": snapshot, "events": events,
        }
        raise AssertionError(f"Timed out waiting for {description}: {last_error}")

    def verify_live_only_deletion(self):
        # The existing group-removal listener preserves saved-only children. Check
        # that native move events did not leave stale mappings that defeat it.
        self.unmount("D")
        before = self.snapshot()
        response = self.send_message({"type": "DELETE_MOUNTED_TABS_IN_GROUP", "windowId": self.window_id,
                                      "groupId": self.group_bookmark_id})
        assert response.get("success"), response
        self.fixture = self.sidebar  # A was active and is now intentionally deleted.
        after = self.wait_for_settled(self.assert_live_only_deletion, "Live Only deletion")
        self.evidence["flows"].append({"flow": "live_only_deletion_after_move", "before": before, "after": after})

    def assert_live_only_deletion(self, after):
        retained = {tab["bookmarkId"]: tab for tab in after["session"]["logicalTabs"]}
        for name in "ABC":
            assert self.bookmark_ids[name] not in retained, f"Mounted bookmark {name} not deleted"
        assert retained[self.bookmark_ids["D"]]["groupId"] == self.group_bookmark_id
        assert retained[self.bookmark_ids["D"]]["liveTabIds"] == []
        assert self.bookmark_ids["E"] in retained
        assert self.group_bookmark_id in after["session"]["groups"], "Saved-only group must survive native removal"
        children = next(node["children"] for node in after["bookmarks"][0]["children"]
                        if node["id"] == self.group_bookmark_id)
        assert [child["id"] for child in children] == [self.bookmark_ids["D"]]
        removed = {self.live_ids[name] for name in "ABC"}
        assert not removed.intersection(tab["id"] for tab in after["native"])
        assert not after["native_groups"], "No mounted group should remain"

    def move(self, names, target, position, order, grouped="", quiet_ms=500):
        before = self.snapshot()
        self.sidebar.evaluate("movementEvents.length = 0")
        by_bookmark = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
        request = {"type": "MOVE_LOGICAL_TABS", "windowId": self.window_id,
            "logicalIds": [by_bookmark[self.bookmark_ids[name]]["logicalId"] for name in names],
            "targetLogicalId": self.group_bookmark_id if target == "group" else
                by_bookmark[self.bookmark_ids[target]]["logicalId"], "position": position}
        response = self.send_message(request)
        assert response.get("success"), response
        immediate = self.snapshot()
        after = self.wait_for_settled(
            lambda snapshot: self.assert_move_state(snapshot, before, order, grouped),
            f"move {names} {position} {target}", quiet_ms=quiet_ms)
        record = {"request": request, "response": response, "before": before, "immediate": immediate,
                  "after": after, "quiet_ms": quiet_ms, "expected_order": list(order),
                  "events": self.sidebar.evaluate("movementEvents")}
        self.evidence["flows"].append(record)
        self.sidebar.screenshot(path=str(self.artifacts / f"move-{len(self.evidence['flows'])}.png"))
        if grouped and self.group_id is None:
            self.group_id = after["native_groups"][0]["id"]
        active_logical_id = next(tab["logicalId"] for tab in after["session"]["logicalTabs"]
                                if tab["bookmarkId"] == self.bookmark_ids[self.active_name])
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_count(1)
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_attribute("data-id", active_logical_id)

    def assert_move_state(self, after, before, order, grouped):
        by_bookmark = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
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
        group_id = self.group_id if grouped else None
        if grouped and group_id is None:
            assert len(after["native_groups"]) == 1, "Saved-only destination must create exactly one native group"
            group = after["native_groups"][0]
            assert (group["title"], group["color"]) == ("Saved destination", "blue")
            group_id = group["id"]
        for tab in native:
            name = names_by_live[tab["id"]]
            expected = group_id if name in grouped else -1
            assert tab["groupId"] == expected, f"Native group {name}: expected {expected}, got {tab['groupId']}"
        native_order = [names_by_live[tab["id"]] for tab in native]
        expected_native = [name for name in order if name in self.live_ids]
        assert native_order == expected_native, f"Native order: expected {expected_native}, got {native_order}"
        assert [tab["id"] for tab in after["native"] if tab["active"]] == [self.tab_id]
        active_logical_id = current[self.bookmark_ids[self.active_name]]["logicalId"]
        assert session["lastActiveLogicalTabId"] == active_logical_id

    def run(self, flow):
        if flow in ("group_in", "group_out") or flow.startswith("group_entry"):
            self.group()
        if flow == "group_entry_leading":
            # A/B are genuinely ungrouped before this first move, not members
            # returned to the front after an earlier successful group insertion.
            self.move("AB", "C", "before", "XABCD", "ABCD", quiet_ms=2500)
        elif flow == "group_entry_trailing":
            self.move("AB", "D", "after", "XCDAB", "CDAB", quiet_ms=2500)
        elif flow == "group_entry_mixed":
            self.move("AD", "C", "before", "XADCB", "ADC", quiet_ms=2500)
            self.move("BC", "D", "after", "XADBC", "ADBC", quiet_ms=2500)
        elif flow in ("saved_destination", "saved_destination_grouped"):
            self.saved_destination()
            if flow == "saved_destination_grouped":
                destination = self.group_bookmark_id
                self.group("AB")
                self.group_bookmark_id = destination
                self.group_id = None
            self.move("AB", "group", "inside", "CSABD", "SAB", quiet_ms=2500)
            if flow == "saved_destination_grouped":
                self.move("A", "C", "before", "ACSBD", "SB", quiet_ms=2500)
        elif flow == "group_in":
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
    flows = ["group_in", "group_out", "forward", "backward", "saved_destination", "saved_destination_grouped",
             "group_entry_leading", "group_entry_trailing", "group_entry_mixed"]
    parser.add_argument("--flow", choices=["all", *flows], default="all")
    parser.add_argument("--headless", action="store_true", help="Use full Chromium without a display server")
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
            for flow in (flows if args.flow == "all" else [args.flow]):
                # Capture an exact Python/Playwright stack if a flow stalls, before
                # the external command timeout can discard its diagnostics.
                faulthandler.dump_traceback_later(60, repeat=False)
                folder = artifacts / flow
                folder.mkdir()
                with tempfile.TemporaryDirectory(prefix="movement-profile-", dir=args.artifacts_dir) as profile:
                    context = playwright.chromium.launch_persistent_context(profile, headless=args.headless, channel="chromium",
                        viewport={"width": 1100, "height": 800}, ignore_default_args=["--disable-extensions"],
                        args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
                    context.set_default_timeout(15000)
                    check = MovementCheck(context, folder)
                    check.evidence.update(extension_path=str(extension), isolated_profile=profile,
                        chromium=context.browser.version, source_sha256={str(path.relative_to(extension)):
                            hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(extension.rglob("*")) if path.is_file()})
                    try:
                        print(f"Preparing {flow}", flush=True)
                        names = "ABCDS" if flow.startswith("saved_destination") else "ABCDE"
                        if flow.startswith("group_entry"):
                            names = "XABCD" if flow == "group_entry_trailing" else "XCDAB"
                        check.prepare(f"http://127.0.0.1:{server.server_port}/movement", names=names)
                        print(f"Running {flow}", flush=True)
                        check.run(flow)
                        print(f"PASS {flow} ({check.evidence['extension_id']})", flush=True)
                    except Exception as error:
                        check.evidence["failure"] = str(error)
                        failures.append(f"{flow}: {error}")
                        print(f"FAIL {flow}: {error}", flush=True)
                    finally:
                        (folder / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
                        context.close()
                faulthandler.cancel_dump_traceback_later()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert not failures, failures


if __name__ == "__main__":
    main()
