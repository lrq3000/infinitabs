"""Native group creation/recreation and background links in disposable Chromium.

Shares the existing runner, source/script fingerprints and state/event observer.
Every lifecycle assertion remains quiet for 1500ms, beyond the rename debounce.
"""

from verify_move_logical_tabs import MovementCheck, main


class GroupLifecycleCheck(MovementCheck):
    def assert_metadata(self, snapshot):
        nodes = self.bookmark_nodes(snapshot)
        by_live = {live_id: logical for logical in snapshot['session']['logicalTabs'] for live_id in logical['liveTabIds']}
        for native in snapshot['native']:
            logical = by_live[native['id']]
            saved = nodes[logical['bookmarkId']]
            for field in ('url', 'title'):
                assert logical[field] == native[field], f"Logical {field} differs from native for bookmark {logical['bookmarkId']}"
                assert saved[field] == native[field], f"Saved {field} differs from native for bookmark {logical['bookmarkId']}"
            assert logical['lastSavedUrl'] == saved['url'], 'Deferred URL save not acknowledged in current logical record'
            assert logical['lastSavedTitle'] == saved['title'], 'Deferred title save not acknowledged in current logical record'

    def run(self, flow):
        if flow.startswith('startup_'):
            return self.startup_import(flow)
        if flow.startswith('removal_'):
            return self.removal(flow)
        name = "Amazon.fr : livres, DVD, jeux vidéo, musique, high-tech, informatique, jouets, vêtements, chaussures, sport, bricolage, maison, beauté, puériculture, épicerie et plus encore !"
        title = name + " [blue]"
        before = self.snapshot()
        session_id = before["session"]["sessionId"]
        saved = []
        for _ in range(2 if flow == "ambiguous" else 1 if flow in ("metadata_recreation", "external_reuse") else 0):
            folder = self.sidebar.evaluate("""async ({parentId, title}) => {
                const folder = await chrome.bookmarks.create({parentId, title});
                await chrome.bookmarks.create({parentId: folder.id, title: 'Saved history', url: 'https://example.test/history'});
                return (await chrome.bookmarks.getSubTree(folder.id))[0];
            }""", {"parentId": session_id, "title": title})
            saved.append(folder)
        if flow == 'external_reuse':
            self.sidebar.evaluate("""async ({bookmarkId, folderId}) => {
                globalThis.reuseNotifications = [];
                chrome.runtime.onMessage.addListener(message => {
                    if (message.type === 'STATE_UPDATED') reuseNotifications.push(message);
                });
                await chrome.bookmarks.move(bookmarkId, {parentId: folderId});
            }""", {'bookmarkId': self.bookmark_ids['A'], 'folderId': saved[0]['id']})
            stale = self.session()
            assert saved[0]['id'] not in stale['groups'], 'Fixture must edit the live tree behind the loaded model'
            assert self.logical('A')['groupId'] is None
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
        elif flow != 'external_reuse':
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
            self.assert_metadata(after)
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
            elif flow != 'external_reuse':
                created = [event["detail"] for event in self.sidebar.evaluate("movementEvents") if event["type"] == "tab-created"]
                assert any(tab["groupId"] == group_id for tab in created), "Background link did not exercise native grouped creation"
            if flow in ("metadata_recreation", "external_reuse"):
                assert a["groupId"] == saved[0]["id"], "Unique saved folder identity must be reused despite different contents"
            if flow == 'external_reuse':
                record['public_notifications'] = self.sidebar.evaluate('reuseNotifications')
                assert any(saved[0]['id'] in message['session']['groups'] and
                           any(tab['bookmarkId'] == self.bookmark_ids['A'] and tab['groupId'] == saved[0]['id']
                               for tab in message['session']['logicalTabs'])
                           for message in record['public_notifications']), 'Rare reuse must notify canonical sidebar state'
                assert any(tab['url'] == 'https://example.test/history' and tab['groupId'] == saved[0]['id']
                           for tab in after['session']['logicalTabs']), 'Externally added saved content must materialize too'
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

    def startup_import(self, flow):
        groups = self.sidebar.evaluate("""async ids => {
            const groups = [];
            for (const [index, id] of ids.entries()) {
                const groupId = await chrome.tabs.group({tabIds: [id]});
                groups.push(await chrome.tabGroups.update(groupId, {
                    title: ['First', 'Middle', 'Last'][index], color: ['red', 'blue', 'green'][index]
                }));
            }
            return groups;
        }""", [self.live_ids[name] for name in 'ABC'])
        if flow == 'startup_duplicate_urls':
            page = next(page for page in self.context.pages if page.url.endswith('?C'))
            page.goto(self.fixture.url)

        setup = {'flow': flow, 'native_groups': groups}
        self.evidence['startup_setup'] = setup

        def fixture_ready(snapshot):
            self.assert_metadata(snapshot)
            by_live = {live_id: tab for tab in snapshot['session']['logicalTabs'] for live_id in tab['liveTabIds']}
            parents = [by_live[self.live_ids[name]]['groupId'] for name in 'ABC']
            assert all(parents) and len(set(parents)) == 3

        before = self.observe_expected_state(fixture_ready, setup, observe_ms=2500, quiet_ms=1500)
        # Use actual saved-session/storage APIs, then stop/restart the real worker.
        # The next init has three established native groups and an EMPTY target
        # session, with no artificial production state or API replacement.
        target = self.sidebar.evaluate("""async ({rootId, windowId}) => {
            const target = await chrome.bookmarks.create({parentId: rootId, title: `Startup import [windowId:${windowId}]`});
            await chrome.storage.local.set({windowToSession: {[windowId]: target.id}, reloadOnRestart: false});
            return {folder: target, children: await chrome.bookmarks.getChildren(target.id)};
        }""", {'rootId': before['session']['rootFolderId'], 'windowId': self.window_id})
        assert target['children'] == []
        record = {'flow': flow, 'before': before, 'target': target}
        self.evidence['flows'].append(record)
        result, trigger = self.cold_worker()
        record.update(initial_state=result, trigger=trigger)
        expected_ids = [tab['id'] for tab in before['native']]

        def expected(after):
            session = after['session']
            assert session['sessionId'] == target['folder']['id']
            assert [tab['id'] for tab in after['native']] == expected_ids, 'Startup must retain the native strip order'
            assert len(session['logicalTabs']) == len(expected_ids), 'Every native tab requires a separate bookmark'
            assert [tab['liveTabIds'] for tab in session['logicalTabs']] == [[tab_id] for tab_id in expected_ids], 'Logical order and complete one-to-one native coverage'
            nodes = self.bookmark_nodes(after)
            folders = [node for node in nodes.values() if node.get('parentId') == session['sessionId'] and 'url' not in node]
            assert [folder['title'] for folder in folders] == ['First [red]', 'Middle [blue]', 'Last [green]'], 'Saved folders must follow native group order'
            by_live = {tab['liveTabIds'][0]: tab for tab in session['logicalTabs']}
            for index, name in enumerate('ABC'):
                logical = by_live[self.live_ids[name]]
                assert logical['groupId'] == folders[index]['id']
                assert [child['id'] for child in folders[index]['children']] == [logical['bookmarkId']]
            assert len({by_live[self.live_ids[name]]['groupId'] for name in 'ABC'}) == 3, 'Duplicate URLs must not merge distinct native groups'
            assert [(tab['id'], tab['groupId']) for tab in after['native']] == [(tab['id'], tab['groupId']) for tab in before['native']]
            self.assert_metadata(after)

        try:
            self.observe_expected_state(expected, record, observe_ms=2500, quiet_ms=1500)
        finally:
            self.sidebar.screenshot(path=str(self.artifacts / 'startup-import.png'))
            record['target_session_load_logs'] = [entry for entry in self.evidence['worker_console']
                if entry['text'] == f"loadSessionFromBookmarks: Loading {target['folder']['id']}"]
        assert not self.evidence['page_errors'], self.evidence['page_errors']
        errors = [entry for entry in self.evidence['worker_console'] if entry['type'] == 'error']
        assert not errors, errors

    def removal(self, flow):
        self.group('SC')
        group_id, folder_id = self.group_id, self.group_bookmark_id
        self.sidebar.evaluate("id => chrome.tabGroups.update(id, {title: 'Saved destination', color: 'blue'})", group_id)
        self.wait_until(lambda: self.session()['groups'][folder_id]['title'] == 'Saved destination [blue]', 'group metadata')
        self.unmount('S')
        before = self.snapshot()
        self.sidebar.evaluate('movementEvents.length = 0')
        record = {'flow': flow, 'before': before}
        self.evidence['flows'].append(record)
        if flow == 'removal_move_close':
            # Additive test-side observer uses actual Chrome APIs. It closes C
            # on the first selected native move; it does not delay/replace any
            # production API. Evidence must prove whether the intended race hit.
            self.sidebar.evaluate("""({selected, closeId, windowId}) => {
                globalThis.closeDuringMove = {};
                const listener = (id, info) => {
                    if (!selected.includes(id)) return;
                    chrome.tabs.onMoved.removeListener(listener);
                    closeDuringMove.trigger = {id, info, at: Date.now()};
                    chrome.tabs.query({windowId}).then(tabs => { closeDuringMove.nativeAtTrigger = tabs; });
                    chrome.tabs.remove(closeId).then(() => { closeDuringMove.closedAt = Date.now(); });
                };
                chrome.tabs.onMoved.addListener(listener);
            }""", {'selected': [self.live_ids[name] for name in 'AB'], 'closeId': self.live_ids['C'], 'windowId': self.window_id})
            record['response'] = self.send_message({'type': 'MOVE_LOGICAL_TABS', 'windowId': self.window_id,
                'logicalIds': [self.logical(name)['logicalId'] for name in 'AB'], 'targetLogicalId': folder_id, 'position': 'inside'})
            assert record['response'].get('success'), record['response']
        elif flow == 'removal_ungroup':
            self.sidebar.evaluate('id => chrome.tabs.ungroup(id)', self.live_ids['C'])
        elif flow == 'removal_live_only':
            record['response'] = self.send_message({'type': 'DELETE_MOUNTED_TABS_IN_GROUP', 'windowId': self.window_id, 'groupId': folder_id})
            assert record['response'].get('success'), record['response']
        else:
            self.sidebar.evaluate('id => chrome.tabs.remove(id)', self.live_ids['C'])

        def expected(after):
            self.assert_metadata(after)
            nodes = self.bookmark_nodes(after)
            logical = {tab['bookmarkId']: tab for tab in after['session']['logicalTabs']}
            native = {tab['id']: tab for tab in after['native']}
            if flow == 'removal_ungroup':
                assert folder_id not in nodes and folder_id not in after['session']['groups']
                assert native[self.live_ids['C']]['groupId'] == -1
                for name in 'SC':
                    assert nodes[self.bookmark_ids[name]]['parentId'] == before['session']['sessionId']
                    assert logical[self.bookmark_ids[name]]['groupId'] is None
            else:
                assert folder_id in nodes and folder_id in after['session']['groups'], 'Original saved folder lost'
                assert nodes[folder_id]['title'] == 'Saved destination [blue]'
                assert self.live_ids['C'] not in native
                names = 'SCAB' if flow == 'removal_move_close' else 'S' if flow == 'removal_live_only' else 'SC'
                assert [child['id'] for child in nodes[folder_id]['children']] == [self.bookmark_ids[name] for name in names]
                for name in names:
                    assert logical[self.bookmark_ids[name]]['groupId'] == folder_id
                    assert logical[self.bookmark_ids[name]]['liveTabIds'] == ([] if name in 'SC' else [self.live_ids[name]])
                if flow == 'removal_live_only':
                    assert self.bookmark_ids['C'] not in nodes and self.bookmark_ids['C'] not in logical
                if flow == 'removal_move_close':
                    assert native[self.live_ids['A']]['groupId'] == native[self.live_ids['B']]['groupId'] != -1
                    record['close_during_move'] = self.sidebar.evaluate('closeDuringMove')
                    assert record['close_during_move'].get('closedAt'), 'Native closure did not run'
                    at_trigger = {tab['id']: tab for tab in record['close_during_move']['nativeAtTrigger']}
                    assert all(at_trigger[self.live_ids[name]]['groupId'] == -1 for name in 'AB'), 'A/B must not yet be native G members'
                    assert at_trigger[self.live_ids['C']]['groupId'] == group_id, 'C must still be native G at the trigger'
                    assert any(event['type'] == 'group-removed' and event['detail']['id'] == group_id
                               for event in self.sidebar.evaluate('movementEvents')), 'C was not the last native group member when closed'
            for name in 'ABD':
                assert logical[self.bookmark_ids[name]]['liveTabIds'] == [self.live_ids[name]]
                assert self.live_ids[name] in native

        try:
            self.observe_expected_state(expected, record, observe_ms=2500, quiet_ms=1500)
        finally:
            if flow == 'removal_move_close':
                record['close_during_move'] = self.sidebar.evaluate('closeDuringMove')
            self.sidebar.screenshot(path=str(self.artifacts / 'group-removal.png'))
        assert not self.evidence['page_errors'], self.evidence['page_errors']
        errors = [msg for msg in self.evidence['worker_console'] if msg['type'] == 'error']
        assert not errors, errors


if __name__ == "__main__":
    main(check_class=GroupLifecycleCheck, flows=["native_background", "metadata_recreation", "ambiguous", "same_name", "external_reuse",
         "removal_move_close", "removal_close", "removal_ungroup", "removal_live_only", "startup_duplicate_urls", "startup_distinct_urls"],
         names_for_flow=lambda flow: "ABSCD" if flow.startswith('removal_') else "ABC" if flow.startswith('startup_') else "AB", evidence_prefix="group-lifecycle")
