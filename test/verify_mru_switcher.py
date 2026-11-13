"""Exercise the unpacked MRU extension in a retained, isolated Chromium profile; never touch the ordinary browser profile."""
import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from http.server import ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError
from verify_move_logical_tabs import MovementCheck
from verify_active_tab_reload import FixtureHandler, ActiveTabReloadCheck


class MruCheck(MovementCheck):
    def open_popup(self):
        with self.context.expect_page() as opened:
            self.sidebar.locator("#open-switcher-btn").click()
        popup = opened.value
        popup.set_viewport_size({"width": 520, "height": 480})
        popup.on("pageerror", lambda error: self.evidence["page_errors"].append(str(error)))
        expect(popup.locator("h1")).to_have_text("Recent tabs")
        return popup

    def query(self, **options):
        response = self.send_message({"type": "MRU_QUERY", "sourceWindowId": self.window_id, **options})
        assert "error" not in response, response
        return response

    def select_native(self, name):
        self.sidebar.evaluate("async id => { const tab = await chrome.tabs.get(id); await chrome.windows.update(tab.windowId, {focused:true}); await chrome.tabs.update(id, {active:true}); }", self.live_ids[name])
        self.wait_until(lambda: self.query().get("context", {}).get("excludeBookmarkId") == self.bookmark_ids[name], "native focus")

    def appearance(self, selector):
        return self.sidebar.locator(selector).evaluate("""element => {
            const style = getComputedStyle(element);
            return Object.fromEntries(['fontSize', 'padding', 'borderRadius', 'borderColor', 'backgroundColor', 'color', 'height'].map(key => [key, style[key]]));
        }""")

    def sidebar_toolbar(self):
        # These checks fail if Recent gets a separate toolbar/input layout again, or if the shared arrows still navigate the hidden normal tree.
        recent_button = self.sidebar.locator("#recent-tabs-btn")
        normal_input = self.sidebar.locator("#search-input")
        recent_input = self.sidebar.get_by_role("combobox", name="Search recent tabs")
        rows = self.sidebar.locator("#recent-tabs-container [role=option]")
        selected = self.sidebar.locator("#recent-tabs-container [aria-selected=true]")
        arrow = self.sidebar.locator("#open-switcher-btn")
        assert recent_button.evaluate("button => button.previousElementSibling?.id") == "show-live-only-btn", "Recent is not immediately after Live Only"
        expect(arrow).to_be_hidden()
        self.sidebar.mouse.move(0, 0)
        assert self.appearance("#recent-tabs-btn") == self.appearance("#show-live-only-btn") == self.appearance("#unmount-others-btn")

        # Both clicks run before the first mount's asynchronous query can finish. Its completion must not re-show or focus the now-hidden Recent search.
        normal_input.focus()
        recent_button.evaluate("button => { button.click(); button.click(); }")
        expect(rows).to_have_count(2)
        expect(self.sidebar.locator("#recent-tabs-container")).to_be_hidden()
        expect(normal_input).to_be_visible()
        focus = self.sidebar.evaluate("document.activeElement.id || document.activeElement.tagName")
        assert focus == "search-input", f"Rapid mode restoration left focus on {focus} instead of visible search"
        expect(arrow).to_be_hidden()

        active_before = self.active_tab()["id"]
        for dark in (False, True):
            if self.sidebar.locator("body").evaluate("body => body.classList.contains('dark-mode')") != dark:
                self.sidebar.locator("#theme-toggle-btn").click()
            for width in (420, 320):
                self.sidebar.set_viewport_size({"width": width, "height": 780})
                normal_input.fill("PR40 active")
                normal_bounds = normal_input.bounding_box()
                normal_style = self.appearance("#search-input")
                self.sidebar.screenshot(path=str(self.artifacts / f"toolbar-normal-{'dark' if dark else 'light'}-{width}.png"))
                recent_button.click()
                expect(recent_input).to_be_visible()
                expect(recent_input).to_have_attribute("placeholder", "Search recent tabs...")
                expect(normal_input).to_be_hidden()
                expect(self.sidebar.locator("#locate-current")).to_be_hidden()
                expect(self.sidebar.locator(".search-input-wrapper input:visible")).to_have_count(1)
                recent_bounds = recent_input.bounding_box()
                assert recent_bounds == normal_bounds, f"Recent search moved or resized: normal={normal_bounds}, recent={recent_bounds}"
                assert self.appearance(".search-input-wrapper .mru-search") == normal_style, "Recent search style differs from normal search"
                expect(arrow).to_be_visible()
                expect(arrow).to_have_text("↗")
                expect(arrow).to_have_attribute("title", "Open recent tabs switcher in a separate window")
                expect(arrow).to_have_accessible_name("Open recent tabs switcher in a separate window")
                assert arrow.evaluate("button => button.previousElementSibling.id") == "search-next"
                self.sidebar.mouse.move(0, 0)
                icon_styles = {selector: self.appearance(selector) for selector in ("#open-switcher-btn", "#search-next", "#search-prev")}
                assert len({json.dumps(style, sort_keys=True) for style in icon_styles.values()}) == 1, f"Search icon styles differ: {icon_styles}"
                self.sidebar.locator("#show-live-only-btn").click()
                self.wait_until(lambda: self.query()["context"]["liveOnly"], "Live Only active toolbar styling")
                self.sidebar.mouse.move(0, 0)
                assert self.appearance("#recent-tabs-btn") == self.appearance("#show-live-only-btn"), "Recent active style differs from Live Only"
                self.sidebar.locator("#show-live-only-btn").click()
                self.wait_until(lambda: not self.query()["context"]["liveOnly"], "restore shared filter")
                recent_input.fill("PR40")
                expect(rows).to_have_count(2)
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
                self.sidebar.locator("#search-next").click()
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
                self.sidebar.locator("#search-prev").click()
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
                self.sidebar.locator("#search-prev").click()
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
                self.sidebar.locator("#search-next").click()
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
                self.sidebar.keyboard.press("Control+Shift+f")
                expect(recent_input).to_be_focused()
                recent_input.press("ArrowDown")
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
                recent_input.press("ArrowUp")
                expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
                assert self.active_tab()["id"] == active_before, "Result navigation activated a tab"
                assert self.sidebar.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Toolbar overflows horizontally"
                self.sidebar.screenshot(path=str(self.artifacts / f"toolbar-recent-{'dark' if dark else 'light'}-{width}.png"))
                recent_button.click()
                expect(normal_input).to_have_value("PR40 active")
                expect(arrow).to_be_hidden()
                expect(self.sidebar.locator("#locate-current")).to_be_visible()

        # A real background title update rerenders the hidden normal tree. Reapplying its preserved query must not advance the Recent selection through the shared arrows.
        recent_button.click()
        recent_input.press("ArrowDown")
        expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
        normal_title = self.sidebar.locator(".tab-item[data-id='" + self.logical("A")["logicalId"] + "'] .tab-title")
        self.fixture.evaluate("document.title = 'PR40 toolbar update'")
        expect(normal_title).to_have_text("PR40 toolbar update")
        expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
        self.fixture.evaluate("document.title = 'PR40 active tab'")
        expect(normal_title).to_have_text("PR40 active tab")
        expect(selected).to_have_attribute("data-key", "tab:" + self.bookmark_ids["A"])
        recent_button.click()

        # Normal/hover styles remain shared after toggling, and clear acts on the visible input without destroying the other mode's query.
        for selector in ("#recent-tabs-btn", "#show-live-only-btn", "#unmount-others-btn"):
            self.sidebar.locator(selector).hover()
            style = self.appearance(selector)
            if selector == "#recent-tabs-btn":
                hover_style = style
            else:
                assert style == hover_style, "Recent hover style differs from the other actions"
        recent_button.click()
        expect(recent_input).to_have_value("PR40")
        recent_input.fill("no-such-recent-tab-987654")
        expect(rows).to_have_count(0)
        self.sidebar.locator("#search-next").click()
        self.sidebar.locator("#search-prev").click()
        assert self.active_tab()["id"] == active_before
        self.sidebar.locator("#search-clear").click()
        expect(recent_input).to_have_value("")
        expect(rows).to_have_count(2)
        expect(self.sidebar.locator("#search-clear")).to_be_hidden()
        recent_button.click()
        expect(normal_input).to_have_value("PR40 active")
        self.sidebar.locator("#search-clear").click()
        expect(normal_input).to_have_value("")
        recent_button.click()
        expect(recent_input).to_have_value("")
        # Leave the existing end-to-end scenarios in their original light, wide, unfiltered Recent state.
        self.sidebar.locator("#theme-toggle-btn").click()
        self.sidebar.set_viewport_size({"width": 1100, "height": 800})
        self.evidence["flows"].append({"name": "shared-sidebar-toolbar-layout-navigation-and-mode-state", "status": "pass", "widths": [320, 420], "themes": ["light", "dark"]})

    def run(self):
        self.select_native("A")
        self.select_native("B")
        self.select_native("C")
        self.sidebar_toolbar()
        expect(self.sidebar.locator("#recent-tabs-btn")).to_be_visible()
        expect(self.sidebar.locator("#recent-tabs-container")).to_be_visible()
        expect(self.sidebar.locator("#recent-tabs-container [role=option]").first).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
        self.sidebar.screenshot(path=str(self.artifacts / "recent-sidebar.png"))
        self.evidence["flows"].append({"name": "sidebar-mru", "status": "pass"})
        sessions_before = self.send_message({"type": "GET_SESSION_LIST"})["sessions"]
        bookmarks_before = self.snapshot()["bookmarks"]
        popup = self.open_popup()
        expect(popup.locator("[role=option]").first).to_have_attribute("data-key", "tab:" + self.bookmark_ids["B"])
        assert popup.get_by_role("combobox", name="Search recent tabs").evaluate("input => input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,cancelable:true,bubbles:true}))"), "IME confirmation was intercepted instead of being left to composition"
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
        self.bookmark_ids["B"] = children[-1]["id"]
        self.live_ids["B"] = self.logical("B")["liveTabIds"][0]
        self.shared_filter_and_mount()
        self.inert_title_and_restart()
        self.saved_session_and_concurrent_window()
        self.external_canonical_changes()
        self.benchmark_large_history()

    def saved_session_and_concurrent_window(self):
        source_session = self.session()["sessionId"]
        saved_url = self.fixture.url.split("?")[0] + "?saved-session"
        window = self.sidebar.evaluate("url => chrome.windows.create({url, focused:false})", saved_url)
        window_id = window["id"]
        self.wait_until(lambda: str(window_id) in self.sidebar.evaluate("async () => (await chrome.storage.local.get('windowToSession')).windowToSession"), "saved session window binding")
        saved = self.send_message({"type": "GET_CURRENT_SESSION_STATE", "windowId": window_id})["session"]
        target = self.wait_until(lambda: next((tab for tab in self.send_message({"type": "GET_CURRENT_SESSION_STATE", "windowId": window_id})["session"]["logicalTabs"] if tab["url"] == saved_url and tab["liveTabIds"]), None), "saved-session logical target")
        self.sidebar.evaluate("async ids => { await chrome.windows.update(ids.windowId,{focused:true}); await chrome.tabs.update(ids.tabId,{active:true}); }", {"windowId": window_id, "tabId": target["liveTabIds"][0]})
        self.wait_until(lambda: any(row.get("bookmarkId") == target["bookmarkId"] for row in self.query(allSessions=True)["items"]), "viewed cross-session target")
        self.sidebar.evaluate("id => chrome.windows.remove(id)", window_id)
        self.wait_until(lambda: not self.sidebar.evaluate("id => chrome.windows.get(id).catch(() => null)", window_id) and any(row.get("bookmarkId") == target["bookmarkId"] and not row["liveTabIds"] for row in self.query(allSessions=True)["items"]), "saved session unbound")
        self.select_native("A")
        assert not any(row.get("bookmarkId") == target["bookmarkId"] for row in self.query()["items"]), "Default scope leaked another session"
        count_before = len(self.send_message({"type": "GET_SESSION_LIST"})["sessions"])
        result, unrelated = self.sidebar.evaluate("""async args => Promise.all([
            chrome.runtime.sendMessage({type:'MRU_ACTIVATE',sourceWindowId:args.sourceWindowId,sourceSessionId:args.sourceSessionId,key:'tab:'+args.bookmarkId}),
            chrome.windows.create({url:args.url,focused:false})
        ])""", {"sourceWindowId": self.window_id, "sourceSessionId": source_session, "bookmarkId": target["bookmarkId"], "url": saved_url + "-unrelated"})
        assert result.get("success"), result
        bindings = self.wait_until(lambda: (lambda value: value if str(unrelated["id"]) in value and saved["sessionId"] in value.values() else None)(self.sidebar.evaluate("async () => (await chrome.storage.local.get('windowToSession')).windowToSession")), "both independent windows tracked")
        assert bindings[str(self.window_id)] == source_session, "Cross-session MRU replaced the caller's session"
        assert len(self.send_message({"type": "GET_SESSION_LIST"})["sessions"]) == count_before + 1, "Bridge created a phantom session or unrelated window was lost"
        destination = next(int(id) for id, session_id in bindings.items() if session_id == saved["sessionId"])
        assert self.sidebar.evaluate("id => chrome.windows.get(id)", destination)["focused"], "Mounted saved-session result did not focus its destination window"
        tree = self.sidebar.evaluate("async () => chrome.bookmarks.getSubTree((await chrome.bookmarks.search({title:'InfiniTabs Sessions'}))[0].id)")
        assert "mru/popup.html" not in json.dumps(tree), "Internal bridge became a canonical bookmark"
        self.evidence["flows"].append({"name": "saved-session-bridge-and-unrelated-window", "status": "pass"})
        self.restart_bookmarks = [self.bookmark_ids["A"], self.bookmark_ids["B"], target["bookmarkId"]]
        self.unrelated_window_id = unrelated["id"]

    def external_canonical_changes(self):
        self.unmount("B")
        edited_url = self.fixture.url.split("?")[0] + "?canonical-edit"
        self.sidebar.evaluate("value => chrome.bookmarks.update(value.id,{url:value.url})", {"id": self.bookmark_ids["B"], "url": edited_url})
        source_session = self.session()["sessionId"]
        result = self.send_message({"type": "MRU_ACTIVATE", "sourceWindowId": self.window_id, "sourceSessionId": source_session, "key": "tab:" + self.bookmark_ids["B"]})
        assert result.get("success"), result
        assert self.active_tab()["url"] == edited_url, "MRU mounted stale URL after canonical bookmark edit"
        self.live_ids["B"] = self.logical("B")["liveTabIds"][0]
        self.unmount("B")
        destination = self.send_message({"type": "GET_CURRENT_SESSION_STATE", "windowId": self.unrelated_window_id})["session"]["sessionId"]
        self.sidebar.evaluate("value => chrome.bookmarks.move(value.id,{parentId:value.parentId})", {"id": self.bookmark_ids["B"], "parentId": destination})
        result = self.send_message({"type": "MRU_ACTIVATE", "sourceWindowId": self.window_id, "sourceSessionId": source_session, "key": "tab:" + self.bookmark_ids["B"]})
        assert result.get("success"), result
        tabs = self.sidebar.evaluate("windowId => chrome.tabs.query({windowId,active:true})", self.unrelated_window_id)
        assert tabs[0]["url"] == edited_url, "Externally moved logical tab did not mount in its canonical destination"
        assert self.sidebar.evaluate("id => chrome.windows.get(id)", self.unrelated_window_id)["focused"], "Existing destination window was not focused"
        self.evidence["flows"].append({"name": "external-url-edit-and-canonical-session-move", "status": "pass"})

    def benchmark_large_history(self):
        self.evidence["benchmark"] = self.sidebar.evaluate("""async () => {
            const {RecencyStore,RecoveryStore}=await import(chrome.runtime.getURL('mru/store.js'));
            const {MruService}=await import(chrome.runtime.getURL('mru/service.js'));
            const {MruView,MruClient}=await import(chrome.runtime.getURL('mru/view.js'));
            // Isolated synthetic inputs exercise the real production service/view without fabricating 10,000 browser visits or adding test backdoors to the worker.
            const values={}, tabs=[];
            for(let i=0;i<10000;i++) { const id=String(i); values['mru.v1.visit.'+id]={bookmarkId:id,lastViewedAt:i,sequence:i}; tabs.push({bookmarkId:id,sessionId:'fixture',title:'Fixture '+i,url:'about:blank#'+i,liveTabIds:[]}); }
            const storage={get:async()=>values,set:async()=>{},remove:async()=>{}};
            const recencyStore=new RecencyStore({storage}), recoveryStore=new RecoveryStore({storage});
            await Promise.all([recencyStore.ready(),recoveryStore.ready()]);
            const service=new MruService({recencyStore,recoveryStore}); service.setCatalog(tabs);
            const durations=[];
            for(let i=0;i<20;i++) { const start=performance.now(); const result=await service.query({allSessions:true,query:'fixture 9876'}); durations.push(performance.now()-start); if(result.items[0]?.bookmarkId!=='9876') throw Error('Wrong benchmark search result'); }
            const root=document.createElement('div');root.style.height='400px'; document.body.append(root);
            const nativeClient=new MruClient(chrome);
            const client={request:message=>service.query({...message,allSessions:true}),faviconUrl:url=>nativeClient.faviconUrl(url)};
            const view=new MruView({root,client,context:{sourceWindowId:1,sourceSessionId:'fixture'}});
            const start=performance.now(); await view.mount(); const renderMs=performance.now()-start;
            const rendered=root.querySelectorAll('[role=option]').length;
            if(rendered!==50 || view.controller.total!==10000) throw Error('Unbounded or incomplete result rendering');
            view.dispose();root.remove();durations.sort((a,b)=>a-b);
            return {candidates:10000,iterations:20,medianQueryMs:durations[10],p95QueryMs:durations[18],initialRenderMs:renderMs,renderedRows:rendered,fixture:'synthetic production service/view; not 10,000 native tabs'};
        }""")
        self.evidence["flows"].append({"name": "large-history-cached-search-and-paged-dom", "status": "pass"})

    def shared_filter_and_mount(self):
        self.select_native("A")
        self.unmount("B")
        saved_structure = self.snapshot()["bookmarks"]
        key = "tab:" + self.bookmark_ids["B"]
        self.wait_until(lambda: any(row["key"] == key for row in self.query()["items"]), "unmounted B in logical MRU")
        self.sidebar.locator("#show-live-only-btn").click()
        self.wait_until(lambda: self.query()["context"]["liveOnly"] and not any(row["key"] == key for row in self.query()["items"]), "Live Only filters unmounted B")
        popup = self.open_popup()
        expect(popup.locator(".mru-live-toggle")).to_have_attribute("aria-pressed", "true")
        popup.locator(".mru-live-toggle").click()
        self.wait_until(lambda: not self.query()["context"]["liveOnly"], "popup changed shared filter")
        expect(self.sidebar.locator("#show-live-only-btn")).not_to_have_class("active")
        popup.locator("[data-key='" + key + "']").click()
        self.wait_until(lambda: popup.is_closed() and bool(self.logical("B")["liveTabIds"]), "transparent remount")
        self.live_ids["B"] = self.logical("B")["liveTabIds"][0]
        assert self.active_tab()["id"] == self.live_ids["B"]
        assert self.snapshot()["bookmarks"] == saved_structure, "Mounting from MRU changed canonical layout"
        self.evidence["flows"].append({"name": "shared-live-filter-and-transparent-mount", "status": "pass"})

    def inert_title_and_restart(self):
        title = '<img src=x onerror="globalThis.mruInjected=true">'
        self.sidebar.evaluate("value => chrome.bookmarks.update(value.id, {title:value.title})", {"id": self.bookmark_ids["A"], "title": title})
        row = self.sidebar.locator("#recent-tabs-container [data-key='tab:" + self.bookmark_ids["A"] + "'] .mru-result-title")
        expect(row).to_have_text(title)
        assert row.locator("img").count() == 0, "Bookmark markup was parsed as HTML"
        assert self.sidebar.evaluate("globalThis.mruInjected === undefined")
        self.sidebar.set_viewport_size({"width": 360, "height": 780})
        self.sidebar.locator("#theme-toggle-btn").click()
        assert self.sidebar.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Narrow sidebar overflows horizontally"
        self.sidebar.screenshot(path=str(self.artifacts / "recent-sidebar-dark-narrow.png"))
        popup = self.open_popup()
        expect(popup.locator("body")).to_have_class("dark-mode")
        before = self.send_message({"type": "GET_SESSION_LIST"})["sessions"]
        _, restart = self.cold_worker()
        assert len(self.send_message({"type": "GET_SESSION_LIST"})["sessions"]) == len(before), "Worker restart imported popup as session"
        expect(popup.locator("[role=option]")).not_to_have_count(0)
        popup.screenshot(path=str(self.artifacts / "switcher-popup-dark.png"))
        try:
            popup.get_by_role("combobox", name="Search recent tabs").press("Escape")
        except PlaywrightError:
            # A native popup can close before CDP acknowledges the key press; closure and the still-responsive source context are the behavior being asserted.
            if not popup.is_closed():
                raise
        self.wait_until(popup.is_closed, "Escape closes popup")
        assert self.query()["context"]["sourceSessionId"] == self.session()["sessionId"]
        self.evidence["flows"].append({"name": "inert-title-narrow-dark-worker-restart", "status": "pass", "restart": restart})


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
            launch = dict(channel="chromium", executable_path=str(args.executable) if args.executable else None, headless=args.headless,
                viewport={"width": 1100, "height": 800}, ignore_default_args=["--disable-extensions"],
                args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
            context = playwright.chromium.launch_persistent_context(str(profile), **launch)
            try:
                context.set_default_timeout(10000)
                check = MruCheck(context, artifacts)
                check.evidence.update(extension_path=str(extension), isolated_profile=str(profile), chromium=context.browser.version, headless=args.headless, executable=str(args.executable) if args.executable else "Playwright bundled Chromium")
                check.prepare(f"http://127.0.0.1:{server.server_port}/fixture", names="ABC")
                check.run()
                assert not check.evidence["page_errors"], check.evidence["page_errors"]
                # Reopen only the fresh profile created by THIS run: this is a real process restart, not another worker evaluation or the user's browser.
                context.close()
                context = playwright.chromium.launch_persistent_context(str(profile), **launch)
                restarted = ActiveTabReloadCheck(context, artifacts)
                restarted.worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                restarted.fixture = context.pages[0]
                extension_id = urlparse(restarted.worker.url).netloc
                restarted.sidebar_url = f"chrome-extension://{extension_id}/sidebar.html"
                native = restarted.worker.evaluate("async () => (await chrome.tabs.query({active:true}))[0]")
                restarted.window_id = native["windowId"]
                restarted.open_sidebar()
                result = restarted.send_message({"type": "MRU_QUERY", "sourceWindowId": restarted.window_id, "allSessions": True, "limit": 100})
                assert "error" not in result, result
                retained = {item.get("bookmarkId") for item in result["items"]} | {result["context"].get("excludeBookmarkId")}
                assert set(check.restart_bookmarks) <= retained, (check.restart_bookmarks, retained)
                restarted.sidebar.locator("#recent-tabs-btn").click()
                restarted.sidebar.get_by_label("Recent tab scope").select_option("all")
                visible_id = next(bookmark for bookmark in check.restart_bookmarks if bookmark != result["context"].get("excludeBookmarkId"))
                expect(restarted.sidebar.locator("[data-key='tab:" + visible_id + "']")).to_be_visible()
                check.evidence["flows"].append({"name": "browser-process-restart-retains-bookmark-identities", "status": "pass"})
                check.evidence["page_errors"].extend(restarted.evidence["page_errors"])
                check.evidence["worker_console"].extend(restarted.evidence["worker_console"])
                assert not check.evidence["page_errors"], check.evidence["page_errors"]
                errors = [entry for entry in check.evidence["worker_console"] if entry["type"] == "error"]
                assert not errors, errors
                print("MRU browser checks passed", flush=True)
            finally:
                if check:
                    (artifacts / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
                context.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
