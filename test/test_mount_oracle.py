"""Exercise the actual mounting oracle with minimal snapshots and a virtual clock.

These are test-oracle regressions, not Chrome mocks used as browser evidence.
Every negative case starts from a passing mount and corrupts only the property
under test; native navigation and logical state can diverge before bookmarks save.
"""

from copy import deepcopy
import unittest

from test_movement_observer import SimulatedMovement
from verify_mount_logical_tabs import MountingCheck


class MountOracleFixture(MountingCheck):
    def __init__(self, url="about:blank"):
        # Browser-free inputs for the same assertion invoked on EVERY live poll.
        self.bookmark_ids = {"A": "a", "B": "b"}
        self.before = {
            "session": {
                "sessionId": "s", "groups": {}, "lastActiveLogicalTabId": "logical-a",
                "logicalTabs": [
                    {"logicalId": "logical-a", "bookmarkId": "a", "url": "https://example.test/a",
                     "groupId": None, "liveTabIds": [101]},
                    {"logicalId": "logical-b", "bookmarkId": "b", "url": url,
                     "groupId": None, "liveTabIds": []},
                ],
            },
            "native": [{"id": 101, "windowId": 1, "index": 0, "groupId": -1,
                        "active": True, "url": "https://example.test/a"}],
            "native_groups": [],
            "bookmarks": [{"id": "s", "parentId": "root", "index": 0, "title": "Mount fixture",
                           "children": [
                               {"id": "a", "parentId": "s", "index": 0, "title": "A", "url": "https://example.test/a"},
                               {"id": "b", "parentId": "s", "index": 1, "title": "B", "url": url},
                           ]}],
        }
        self.after = deepcopy(self.before)
        self.after["session"]["logicalTabs"][1]["liveTabIds"] = [102]
        self.after["session"]["lastActiveLogicalTabId"] = "logical-b"
        self.after["native"][0]["active"] = False
        self.after["native"].append({"id": 102, "windowId": 1, "index": 1, "groupId": -1, "active": True, "url": url})

    def validate(self, snapshot=None):
        self.assert_mount(self.before, self.after if snapshot is None else snapshot, "B")

    def group_saved_tabs(self):
        # Keep native/session group metadata consistent while tests independently
        # corrupt only its persisted folder name or color-encoded title.
        for snapshot in (self.before, self.after):
            root = snapshot["bookmarks"][0]
            children = root["children"]
            for child in children:
                child["parentId"] = "g"
            root["children"] = [{"id": "g", "parentId": "s", "index": 0,
                                 "title": "Reading [blue]", "children": children}]
            snapshot["session"]["groups"] = {"g": {"groupId": "g", "title": "Reading [blue]"}}
            for tab in snapshot["session"]["logicalTabs"]:
                tab["groupId"] = "g"
            for tab in snapshot["native"]:
                tab["groupId"] = 700
            snapshot["native_groups"] = [{"id": 700, "windowId": 1, "title": "Reading", "color": "blue"}]


class MountOracleTests(unittest.TestCase):
    def setUp(self):
        self.fixture = MountOracleFixture()
        self.fixture.validate()  # Positive control for every single-property mutation.

    def assert_rejected(self, reason):
        with self.assertRaisesRegex(AssertionError, reason):
            self.fixture.validate()

    def test_valid_blank_and_http_mounts(self):
        for url in ("about:blank", "https://example.test/b"):
            with self.subTest(url=url):
                MountOracleFixture(url).validate()

    def test_logical_ids_may_regenerate_without_changing_bookmark_order(self):
        for tab in self.fixture.after["session"]["logicalTabs"]:
            tab["logicalId"] += "-reloaded"
        self.fixture.after["session"]["lastActiveLogicalTabId"] = "logical-b-reloaded"
        self.fixture.validate()

    def test_rejects_persisted_group_name_or_color_rewrite(self):
        for title in ("Renamed [blue]", "Reading [red]"):
            with self.subTest(title=title):
                self.fixture = MountOracleFixture()
                self.fixture.group_saved_tabs()
                self.fixture.validate()
                self.fixture.after["bookmarks"][0]["children"][0]["title"] = title
                self.assert_rejected("Mount rewrote canonical bookmark structure")

    def test_rejects_empty_saved_folder_title_rewrite(self):
        for snapshot in (self.fixture.before, self.fixture.after):
            snapshot["bookmarks"][0]["children"].append(
                {"id": "empty", "parentId": "s", "index": 2, "title": "Empty [blue]", "children": []})
            snapshot["session"]["groups"]["empty"] = {"groupId": "empty", "title": "Empty [blue]"}
        self.fixture.validate()
        self.fixture.after["bookmarks"][0]["children"][2]["title"] = "Changed [blue]"
        self.assert_rejected("Mount rewrote canonical bookmark structure")

    def test_tab_titles_may_update_with_or_without_children_field(self):
        # Chrome omits children on URL bookmarks; mock_chrome.js includes an
        # empty array. Neither representation makes a tab bookmark a folder.
        for with_children in (False, True):
            with self.subTest(with_children=with_children):
                fixture = MountOracleFixture()
                if with_children:
                    for snapshot in (fixture.before, fixture.after):
                        for node in snapshot["bookmarks"][0]["children"]:
                            node["children"] = []
                fixture.validate()
                for node in fixture.after["bookmarks"][0]["children"]:
                    node["title"] = "Updated page " + node["id"]
                fixture.validate()

    def test_rejects_wrong_native_url_before_bookmark_save(self):
        self.fixture.after["native"][1]["url"] = "https://example.test/wrong-native"
        self.assert_rejected("Mounted native URL differs from saved bookmark")

    def test_rejects_wrong_logical_url_before_bookmark_save(self):
        self.fixture.after["session"]["logicalTabs"][1]["url"] = "https://example.test/wrong-logical"
        self.assert_rejected("Mounted logical URL differs from saved bookmark")

    def test_saved_bookmark_url_is_authoritative_over_stale_premount_logical_url(self):
        self.fixture.before["session"]["logicalTabs"][1]["url"] = "https://example.test/stale-logical"
        self.fixture.validate()
        self.fixture.after["session"]["logicalTabs"][1]["url"] = "https://example.test/stale-logical"
        self.assert_rejected("Mounted logical URL differs from saved bookmark")

    def test_rejects_reordered_logical_records(self):
        self.fixture.after["session"]["logicalTabs"].reverse()
        self.assert_rejected("Mount changed logical bookmark order or multiplicity")

    def test_rejects_duplicate_unrelated_bookmark_with_distinct_logical_id(self):
        duplicate = deepcopy(self.fixture.after["session"]["logicalTabs"][0])
        duplicate["logicalId"] = "duplicate-logical-a"
        self.fixture.after["session"]["logicalTabs"].append(duplicate)
        self.assert_rejected("Mount changed logical bookmark order or multiplicity")

    def test_wrong_urls_cannot_settle_before_debounced_bookmark_corruption(self):
        wrong = deepcopy(self.fixture.after)
        wrong["native"][1]["url"] = wrong["session"]["logicalTabs"][1]["url"] = "https://example.test/wrong"
        persisted = deepcopy(wrong)
        persisted["bookmarks"][0]["children"][1]["url"] = "https://example.test/wrong"
        clock = SimulatedMovement(states=[(0, wrong), (2, persisted)])
        record = {}
        # The ordinary 500ms quiet interval would falsely pass before the 2s
        # bookmark debounce. Correctness must be rejected now, without sleeping.
        with self.assertRaisesRegex(AssertionError, "Mounted (native|logical) URL differs from saved bookmark"):
            clock.observe(record, validate=self.fixture.validate, timeout_ms=800)
        self.assertNotIn("first_expected_ms", record["observation"])
        self.assertEqual(record["after"]["bookmarks"], self.fixture.before["bookmarks"])
        self.assertLess(clock.now, 2)

    def test_url_corruption_on_later_poll_cannot_complete_quiet_interval(self):
        wrong = deepcopy(self.fixture.after)
        wrong["native"][1]["url"] = "https://example.test/late-wrong"
        clock = SimulatedMovement(states=[(0, self.fixture.after), (0.1, wrong)])
        record = {}
        with self.assertRaisesRegex(AssertionError, "Mounted native URL differs from saved bookmark"):
            clock.observe(record, validate=self.fixture.validate, timeout_ms=800)
        self.assertEqual(record["observation"]["first_expected_ms"], 0)
        self.assertTrue(record["observation"]["timed_out"])


if __name__ == "__main__":
    unittest.main()
