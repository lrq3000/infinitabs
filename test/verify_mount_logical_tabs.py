"""Real saved-tab mounts via FOCUS_OR_MOUNT_TAB, sharing the movement harness.

Each flow uses a fresh profile, real bookmarks/native groups, the shipped sidebar,
and event-quiet verification. No Chrome API or production listener is replaced.
"""

from playwright.sync_api import expect
from verify_move_logical_tabs import MovementCheck, main


class MountingCheck(MovementCheck):
    @staticmethod
    def structure(snapshot):
        # Dates/titles may settle after navigation; mounting must never edit the
        # canonical bookmark parent/order, URL, or the set of saved identities.
        return {key: (node.get("parentId"), node.get("index"), node.get("url"),
                      [child["id"] for child in node.get("children", [])])
                for key, node in MovementCheck.bookmark_nodes(snapshot).items()}

    def assert_mount(self, before, after, name):
        assert self.structure(after) == self.structure(before), "Mount rewrote canonical bookmark structure"
        old = {tab["bookmarkId"]: tab for tab in before["session"]["logicalTabs"]}
        current = {tab["bookmarkId"]: tab for tab in after["session"]["logicalTabs"]}
        assert set(old) == set(current), "Mount duplicated/lost a saved identity"
        target = current[self.bookmark_ids[name]]
        assert len(target["liveTabIds"]) == 1, "Saved tab must have exactly one native instance"
        mounted_id = target["liveTabIds"][0]
        for bookmark_id, tab in current.items():
            assert tab["groupId"] == old[bookmark_id]["groupId"], "Logical group changed"
            if bookmark_id != target["bookmarkId"]:
                assert tab["liveTabIds"] == old[bookmark_id]["liveTabIds"], "Unrelated live identity changed"
        expected_ids = [live_id for tab in before["session"]["logicalTabs"]
                        for live_id in ([mounted_id] if tab["bookmarkId"] == target["bookmarkId"] else tab["liveTabIds"])]
        assert [tab["id"] for tab in after["native"]] == expected_ids, "Native order differs from saved order"
        native = {tab["id"]: tab for tab in after["native"]}
        old_groups = {group["id"]: group for group in before["native_groups"]}
        new_groups = {group["id"]: group for group in after["native_groups"]}
        for group_id, group in old_groups.items():
            assert new_groups.get(group_id) == group, "Unrelated native group metadata changed"
        for tab in before["native"]:
            assert native[tab["id"]]["groupId"] == tab["groupId"], "Mount split/joined an unrelated native group"
        expected_group = -1
        if target["groupId"]:
            # An existing group keeps its native ID; saved-only groups are recreated
            # with their saved metadata and without adopting the active group.
            peer = next((tab for tab in old.values() if tab["groupId"] == target["groupId"] and tab["liveTabIds"]), None)
            expected_group = native[peer["liveTabIds"][0]]["groupId"] if peer else native[mounted_id]["groupId"]
            assert expected_group != -1
            if not peer:
                restored = next(group for group in after["native_groups"] if group["id"] == expected_group)
                assert (restored["title"], restored["color"]) == ("Saved mount", "blue")
        assert native[mounted_id]["groupId"] == expected_group, "Mounted native group differs from saved parent"
        assert set(new_groups) == set(old_groups) | ({expected_group} if expected_group != -1 else set()), "Unexpected native group"
        assert [tab["id"] for tab in after["native"] if tab["active"]] == [mounted_id]
        assert after["session"]["lastActiveLogicalTabId"] == target["logicalId"]

    def run(self, flow):
        target = "A" if flow == "existing_first" else "C" if flow == "existing_last" else "X" if flow == "root_first" else "B"
        if flow.startswith("existing_"):
            self.group("ABC")
        elif flow.startswith("saved_group"):
            self.group("B")
            self.sidebar.evaluate("id => chrome.tabGroups.update(id, {title: 'Saved mount', color: 'blue'})", self.group_id)
            self.wait_until(lambda: self.session()["groups"][self.group_bookmark_id]["title"] == "Saved mount [blue]",
                            "saved group metadata")
        if flow == "root_blank":
            page = next(page for page in self.context.pages if page.url.endswith("?B"))
            page.goto("about:blank")
            self.wait_until(lambda: self.logical("B")["lastSavedUrl"] == "about:blank", "saved blank URL")
        saved_parent = self.logical(target)["groupId"]
        # Also cover the sticky-group boundary specifically: a root/saved-group
        # mount immediately after the active group's last native member.
        adjacent = flow.endswith("after_active_group")
        active_name = "A" if adjacent else "U"
        self.group("XA" if adjacent else "UV")
        self.sidebar.evaluate("id => chrome.tabs.update(id, {active: true})", self.live_ids[active_name])
        self.unmount(target)
        self.fixture = self.sidebar  # root_first closes the original fixture page.
        self.wait_until(lambda: self.session()["lastActiveLogicalTabId"] == self.logical(active_name)["logicalId"], "unrelated active group")
        before = self.snapshot()
        # Fail setup explicitly if a group-removal regression flattened the saved
        # destination; such a fixture would silently test a root mount instead.
        assert self.logical(target)["groupId"] == saved_parent
        if flow.startswith("saved_group"):
            assert saved_parent and saved_parent in before["session"]["groups"]
            assert not any(tab["groupId"] == saved_parent and tab["liveTabIds"] for tab in before["session"]["logicalTabs"])
        elif flow.startswith("existing_"):
            assert saved_parent and sum(tab["groupId"] == saved_parent and bool(tab["liveTabIds"])
                                        for tab in before["session"]["logicalTabs"]) == 2
        else:
            assert saved_parent is None
        record = {"flow": flow, "before": before}
        self.evidence["flows"].append(record)
        self.sidebar.evaluate("movementEvents.length = 0")
        record["request"] = {"type": "FOCUS_OR_MOUNT_TAB", "windowId": self.window_id,
                             "logicalId": self.logical(target)["logicalId"]}
        record["response"] = self.send_message(record["request"])
        assert record["response"].get("success"), record["response"]
        try:
            after = self.observe_expected_state(lambda snapshot: self.assert_mount(before, snapshot, target), record)
        finally:
            self.sidebar.screenshot(path=str(self.artifacts / "mount.png"))
        active_id = after["session"]["lastActiveLogicalTabId"]
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_count(1)
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_attribute("data-id", active_id)
        assert not self.evidence["page_errors"], self.evidence["page_errors"]
        errors = [msg for msg in self.evidence["worker_console"] if msg["type"] == "error"]
        assert not errors, errors


if __name__ == "__main__":
    main(check_class=MountingCheck,
         flows=["existing_middle", "existing_first", "existing_last", "saved_group", "root_middle", "root_first", "root_blank",
                "root_after_active_group", "saved_group_after_active_group"],
         names_for_flow=lambda _flow: "XABCYUVZ", evidence_prefix="mounting")
