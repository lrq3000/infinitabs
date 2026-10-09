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
            chrome.tabs.onRemoved.addListener((id, info) => record('tab-removed', {id, info}));
            chrome.tabGroups.onCreated.addListener(group => record('group-created', group));
            chrome.tabGroups.onRemoved.addListener(group => record('group-removed', group));
            chrome.bookmarks.onMoved.addListener((id, info) => record('bookmark-moved', {id, info}));
            chrome.bookmarks.onRemoved.addListener((id, info) => record('bookmark-removed', {id, info}));
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
        session = self.session()
        return {"session": session, "native": self.sidebar.evaluate(
            "windowId => chrome.tabs.query({windowId})", self.window_id),
            "native_groups": self.sidebar.evaluate("windowId => chrome.tabGroups.query({windowId})", self.window_id),
            "bookmarks": self.sidebar.evaluate("id => chrome.bookmarks.getSubTree(id)", session["sessionId"])}

    @staticmethod
    def bookmark_nodes(snapshot):
        # Preserve bookmark traversal order for comparison with the session and
        # native strip; checking only the session can miss delayed persistence.
        nodes = {}
        pending = list(reversed(snapshot["bookmarks"]))
        while pending:
            node = pending.pop()
            nodes[node["id"]] = node
            pending.extend(reversed(node.get("children", [])))
        return nodes

    def observe_expected_state(self, assert_expected, record, observe_ms=0, timeout_ms=15000, quiet_ms=500):
        # Correctness must persist through an event-free period longer than the
        # production 100ms delayed ungroup callback (and 50ms move queue). Explicit
        # long observations remain minimum durations, not substitutes for polling.
        started = time.monotonic()
        deadline = started + timeout_ms / 1000
        quiet_since = None
        previous = None
        event_count = None
        observation = {"timeout_ms": timeout_ms, "quiet_ms": quiet_ms,
                       "minimum_observe_ms": observe_ms, "polls": 0}
        record["observation"] = observation
        while time.monotonic() < deadline:
            snapshot = self.snapshot()
            events = self.sidebar.evaluate("movementEvents")
            now = time.monotonic()
            observation["polls"] += 1
            observation["elapsed_ms"] = round((now - started) * 1000)
            record.update(after=snapshot, events=events)
            record.setdefault("immediate", snapshot)
            try:
                assert_expected(snapshot)
            except (AssertionError, KeyError) as error:
                observation["last_mismatch"] = str(error)
                quiet_since = None
            else:
                observation.setdefault("first_expected_ms", observation["elapsed_ms"])
                if quiet_since is None or len(events) != event_count or snapshot != previous:
                    quiet_since = now
                if now < deadline and now - quiet_since >= quiet_ms / 1000 and now - started >= observe_ms / 1000:
                    observation["observed_quiet_ms"] = round((now - quiet_since) * 1000)
                    return snapshot
            previous, event_count = snapshot, len(events)
            self.fixture.wait_for_timeout(min(50, max(0, (deadline - time.monotonic()) * 1000)))
        observation["timed_out"] = True
        raise AssertionError(
            f"Expected state did not remain quiet within {timeout_ms}ms: "
            f"{observation.get('last_mismatch', 'state/events kept changing')}. "
            f"Last snapshot and {len(record.get('events', []))} events: {self.artifacts / 'evidence.json'}")

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
        self.sidebar.evaluate("movementEvents.length = 0")
        response = self.send_message({"type": "DELETE_MOUNTED_TABS_IN_GROUP", "windowId": self.window_id,
                                      "groupId": self.group_bookmark_id})
        assert response.get("success"), response
        self.fixture = self.sidebar  # A was active and is now intentionally deleted.
        record = {"flow": "live_only_deletion_after_move", "before": before, "response": response}
        self.evidence["flows"].append(record)
        self.observe_expected_state(self.assert_live_only_deletion, record)

    def assert_live_only_deletion(self, after):
        retained = {tab["bookmarkId"]: tab for tab in after["session"]["logicalTabs"]}
        nodes = self.bookmark_nodes(after)
        native_ids = {tab["id"] for tab in after["native"]}
        for name in "ABC":
            assert self.bookmark_ids[name] not in retained, f"Mounted bookmark {name} not deleted"
            assert self.bookmark_ids[name] not in nodes, f"Bookmark tree still contains {name}"
            assert self.live_ids[name] not in native_ids, f"Native tab {name} not closed"
        assert self.bookmark_ids["D"] in retained, "Saved-only D must be retained"
        assert retained[self.bookmark_ids["D"]]["groupId"] == self.group_bookmark_id
        assert retained[self.bookmark_ids["D"]]["liveTabIds"] == []
        assert self.bookmark_ids["E"] in retained
        assert self.bookmark_ids["E"] in nodes and self.live_ids["E"] in native_ids
        assert self.group_bookmark_id in after["session"]["groups"], "Saved-only group must survive native removal"
        assert self.group_bookmark_id in nodes, "Saved-only bookmark folder must survive"
        children = nodes[self.group_bookmark_id].get("children", [])
        assert [child["id"] for child in children] == [self.bookmark_ids["D"]]
        assert not after["native_groups"], "No mounted group should remain"

    def move(self, names, target, position, order, grouped="", observe_ms=0):
        before = self.snapshot()
        self.sidebar.evaluate("movementEvents.length = 0")
        by_bookmark = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
        request = {"type": "MOVE_LOGICAL_TABS", "windowId": self.window_id,
            "logicalIds": [by_bookmark[self.bookmark_ids[name]]["logicalId"] for name in names],
            "targetLogicalId": self.group_bookmark_id if target == "group" else
                by_bookmark[self.bookmark_ids[target]]["logicalId"], "position": position}
        response = self.send_message(request)
        assert response.get("success"), response
        record = {"request": request, "response": response, "before": before, "expected_order": list(order)}
        self.observe_move(before, record, order, grouped, observe_ms)

    def native_move(self, name, index, order, grouped=""):
        before = self.snapshot()
        self.sidebar.evaluate("movementEvents.length = 0")
        request = {"tabId": self.live_ids[name], "index": index}
        response = self.sidebar.evaluate("({tabId, index}) => chrome.tabs.move(tabId, {index})", request)
        record = {"native_move": request, "response": response, "before": before, "expected_order": list(order)}
        self.observe_move(before, record, order, grouped, 2500)

    def observe_move(self, before, record, order, grouped, observe_ms):
        self.evidence["flows"].append(record)
        try:
            # Preserve both the minimum observation and the remote contribution's
            # stronger uninterrupted quiet interval for the long-observation cases.
            after = self.observe_expected_state(
                lambda snapshot: self.assert_move_state(before, snapshot, order, grouped), record,
                observe_ms=observe_ms, quiet_ms=max(500, observe_ms))
        finally:
            self.sidebar.screenshot(path=str(self.artifacts / f"move-{len(self.evidence['flows'])}.png"))
        if grouped and self.group_id is None:
            self.group_id = after["native_groups"][0]["id"]
        active_logical_id = after["session"]["lastActiveLogicalTabId"]
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_count(1)
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_attribute("data-id", active_logical_id)

    def assert_move_state(self, before, after, order, grouped):
        by_bookmark = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
        session = after["session"]
        assert session["sessionId"] == before["session"]["sessionId"]
        assert set(session["groups"]) == set(before["session"]["groups"]), "Retain group folders, including empty ones"
        current = {tab["bookmarkId"]: tab for tab in session["logicalTabs"]}
        assert set(current) == set(by_bookmark), "Move must retain every bookmark"
        nodes = self.bookmark_nodes(after)
        assert {node["id"] for node in nodes.values() if "url" in node} == set(current), "Bookmark tree/session mismatch"
        for name, bookmark_id in self.bookmark_ids.items():
            tab = current[bookmark_id]
            assert tab["logicalId"] != by_bookmark[bookmark_id]["logicalId"], "Logical IDs must refresh"
            assert tab["liveTabIds"] == ([self.live_ids[name]] if name in self.live_ids else []), f"Live identity changed: {name}"
            assert tab["groupId"] == (self.group_bookmark_id if name in grouped else None), f"Logical group: {name}"
            parent_id = self.group_bookmark_id if name in grouped else session["sessionId"]
            assert nodes[bookmark_id]["parentId"] == parent_id, f"Bookmark parent: {name}"
        names_by_bookmark = {value: key for key, value in self.bookmark_ids.items()}
        logical_order = [names_by_bookmark[tab["bookmarkId"]] for tab in session["logicalTabs"]
                         if tab["bookmarkId"] in names_by_bookmark]
        assert logical_order == list(order), f"Bookmark order: expected {order}, got {logical_order}"
        bookmark_order = [names_by_bookmark[node_id] for node_id in nodes if node_id in names_by_bookmark]
        assert bookmark_order == list(order), f"Bookmark tree order: expected {order}, got {bookmark_order}"
        names_by_live = {value: key for key, value in self.live_ids.items()}
        native = [tab for tab in after["native"] if tab["id"] in names_by_live]
        expected_group_id = getattr(self, "group_id", None)
        if grouped and expected_group_id is None:
            assert len(after["native_groups"]) == 1, "Saved-only destination must create exactly one native group"
            group = after["native_groups"][0]
            assert (group["title"], group["color"]) == ("Saved destination", "blue")
            expected_group_id = group["id"]
        for tab in native:
            name = names_by_live[tab["id"]]
            expected = expected_group_id if name in grouped else -1
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
        if flow == "root_boundaries":
            self.group("C")
            self.unmount("S")
            self.move("A", "D", "before", "BCSAD", "C", observe_ms=2500)
            # Real APIs exercise root-parent and saved-only boundaries. They do
            # not force Chrome's callback delivery order; Node covers the queued
            # old-A/immediate-D interleaving deterministically.
            self.native_move("D", 0, "DBCSA", "C")
            self.native_move("A", 1, "DABCS", "C")
            self.native_move("A", len(self.live_ids), "DBCAS", "C")
        elif flow == "group_entry_leading":
            # A/B are genuinely ungrouped before this first move, not members
            # returned to the front after an earlier successful group insertion.
            self.move("AB", "C", "before", "XABCD", "ABCD", observe_ms=2500)
        elif flow == "group_entry_trailing":
            self.move("AB", "D", "after", "XCDAB", "CDAB", observe_ms=2500)
        elif flow == "group_entry_mixed":
            self.move("AD", "C", "before", "XADCB", "ADC", observe_ms=2500)
            self.move("BC", "D", "after", "XADBC", "ADBC", observe_ms=2500)
        elif flow in ("saved_destination", "saved_destination_grouped"):
            self.saved_destination()
            if flow == "saved_destination_grouped":
                destination = self.group_bookmark_id
                self.group("AB")
                self.group_bookmark_id = destination
                self.group_id = None
            self.move("AB", "group", "inside", "CSABD", "SAB", observe_ms=2500)
            if flow == "saved_destination_grouped":
                self.move("A", "C", "before", "ACSBD", "SB", observe_ms=2500)
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
             "group_entry_leading", "group_entry_trailing", "group_entry_mixed", "root_boundaries"]
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
                        chromium=context.browser.version, headless=args.headless,
                        source_sha256={str(path.relative_to(extension)):
                            hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(extension.rglob("*")) if path.is_file()},
                        test_sha256={name: hashlib.sha256((extension.parent / "test" / name).read_bytes()).hexdigest()
                            for name in ("verify_move_logical_tabs.py", "verify_active_tab_reload.py")})
                    try:
                        print(f"Preparing {flow}", flush=True)
                        names = "ABCDS" if flow.startswith("saved_destination") else "ABCSD" if flow == "root_boundaries" else "ABCDE"
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
