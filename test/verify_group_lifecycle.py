"""Native group creation/recreation and background links in disposable Chromium.

Shares the existing runner, source/script fingerprints and state/event observer.
Every lifecycle assertion remains quiet for 1500ms, beyond the rename debounce.
"""

from verify_move_logical_tabs import MovementCheck, main


class GroupLifecycleCheck(MovementCheck):
    def run(self, flow):
        name = "Amazon.fr : livres, DVD, jeux vidéo, musique, high-tech, informatique, jouets, vêtements, chaussures, sport, bricolage, maison, beauté, puériculture, épicerie et plus encore !"
        title = name + " [blue]"
        before = self.snapshot()
        session_id = before["session"]["sessionId"]
        saved = []
        for _ in range(2 if flow == "ambiguous" else 1 if flow == "metadata_recreation" else 0):
            folder = self.sidebar.evaluate("""async ({parentId, title}) => {
                const folder = await chrome.bookmarks.create({parentId, title});
                await chrome.bookmarks.create({parentId: folder.id, title: 'Saved history', url: 'https://example.test/history'});
                return (await chrome.bookmarks.getSubTree(folder.id))[0];
            }""", {"parentId": session_id, "title": title})
            saved.append(folder)
        self.sidebar.evaluate("""() => {
            movementEvents.length = 0;
            chrome.tabs.onCreated.addListener(tab => movementEvents.push({type: 'tab-created', detail: tab, at: Date.now()}));
            chrome.bookmarks.onCreated.addListener((id, node) => movementEvents.push({type: 'bookmark-created', detail: {id, node}, at: Date.now()}));
        }""")
        group_id = self.sidebar.evaluate("ids => chrome.tabs.group({tabIds: ids})", [self.live_ids["A"]])
        self.sidebar.evaluate("({id, title}) => chrome.tabGroups.update(id, {title, color: 'blue'})", {"id": group_id, "title": name})
        record = {"flow": flow, "before": before, "saved": saved, "native_group_id": group_id}
        self.evidence["flows"].append(record)
        if flow == "same_name":
            second = self.sidebar.evaluate("ids => chrome.tabs.group({tabIds: ids})", [self.live_ids["B"]])
            self.sidebar.evaluate("({id, title}) => chrome.tabGroups.update(id, {title, color: 'blue'})", {"id": second, "title": name})
        else:
            # A middle-click is an actual browser background-link action. Chromium
            # decides initial groupId/openerTabId; the test does not replace APIs.
            self.fixture.evaluate("""() => {
                const a = document.createElement('a'); a.id = 'background-link';
                a.href = location.pathname + '?background-link'; a.textContent = 'Open background';
                document.body.append(a);
            }""")
            with self.context.expect_page() as opened:
                self.fixture.locator("#background-link").click(button="middle")
            record["opened_url"] = opened.value.url

        def expected(after):
            nodes = self.bookmark_nodes(after)
            folders = [node for node in nodes.values() if node.get("parentId") == session_id and "url" not in node]
            count = 3 if flow == "ambiguous" else 2 if flow == "same_name" else 1
            assert len(folders) == count, f"Expected {count} folders, got {[(f['id'], f['title']) for f in folders]}"
            by_live = {live_id: logical for logical in after["session"]["logicalTabs"] for live_id in logical["liveTabIds"]}
            a = by_live[self.live_ids["A"]]
            assert a["groupId"] in {folder["id"] for folder in folders}
            assert nodes[a["groupId"]]["title"] == title
            assert a["bookmarkId"] == self.bookmark_ids["A"]
            for native in after["native"]:
                assert native["id"] in by_live, f"Unmapped native tab {native['id']}"
                if native["groupId"] == group_id:
                    logical = by_live[native["id"]]
                    assert logical["groupId"] == a["groupId"]
                    assert nodes[logical["bookmarkId"]]["parentId"] == a["groupId"]
                    assert logical["url"] == native["url"]
                    assert nodes[logical["bookmarkId"]]["url"] == native["url"]
            if flow == "same_name":
                assert by_live[self.live_ids["B"]]["groupId"] != a["groupId"]
            else:
                created = [event["detail"] for event in self.sidebar.evaluate("movementEvents") if event["type"] == "tab-created"]
                assert any(tab["groupId"] == group_id for tab in created), "Background link did not exercise native grouped creation"
            if flow == "metadata_recreation":
                assert a["groupId"] == saved[0]["id"], "Unique saved folder identity must be reused despite different contents"
            if flow == "ambiguous":
                assert a["groupId"] not in {folder["id"] for folder in saved}
            for folder in saved:
                assert nodes[folder["id"]]["title"] == folder["title"]
                for child in folder["children"]:
                    assert nodes[child["id"]] == child, "Original saved-tab history changed"

        try:
            self.observe_expected_state(expected, record, observe_ms=2500, quiet_ms=1500)
        finally:
            self.sidebar.screenshot(path=str(self.artifacts / "group-lifecycle.png"))
        assert not self.evidence["page_errors"], self.evidence["page_errors"]
        errors = [msg for msg in self.evidence["worker_console"] if msg["type"] == "error"]
        assert not errors, errors


if __name__ == "__main__":
    main(check_class=GroupLifecycleCheck, flows=["native_background", "metadata_recreation", "ambiguous", "same_name"],
         names_for_flow=lambda _flow: "AB", evidence_prefix="group-lifecycle")
