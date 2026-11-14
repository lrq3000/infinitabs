"""Real-extension scroll regression; retains its isolated profile and evidence.

Run: python -B test/verify_sidebar_autoscroll.py --headless --artifacts-dir <existing-temp-dir>
Requires the existing Python Playwright/Chromium installation. Never uses a personal browser profile or mocks Chrome APIs.
"""

import argparse
import json
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright
from verify_active_tab_reload import ActiveTabReloadCheck


class ScrollFixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = parse_qs(urlparse(self.path).query).get("row", ["initial"])[0]
        body = f"<!doctype html><title>Scroll fixture {name}</title><h1>Local scroll fixture</h1>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class SidebarScrollCheck(ActiveTabReloadCheck):
    def url(self, index):
        return f"{self.base_url}?row={index}"

    def logical(self, index):
        return next(tab for tab in self.session()["logicalTabs"] if tab["url"] == self.url(index))

    def row(self, index):
        # Mounting refreshes ephemeral logical IDs. The generated bookmark URL remains stable through that refresh.
        return self.sidebar.locator("#tabs-container .tab-item[title=" + json.dumps(self.url(index)) + "]")

    def settle(self):
        # Smooth scrolling is browser-owned. Wait for an unchanged scroll position for 180ms rather than sleeping for an assumed animation length.
        self.sidebar.evaluate("""() => new Promise((resolve, reject) => {
            const container = document.getElementById('tabs-container');
            let previous = container.scrollTop, changed = performance.now(), started = changed;
            function frame(now) {
                if (container.scrollTop !== previous) { previous = container.scrollTop; changed = now; }
                if (now - changed >= 180) return resolve();
                if (now - started > 5000) return reject(new Error('Scroll did not settle'));
                requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        })""")

    def metrics(self, row):
        return row.evaluate("""element => {
            const container = document.getElementById('tabs-container');
            const bounds = container.getBoundingClientRect(), row = element.getBoundingClientRect();
            const top = bounds.top + container.clientTop, bottom = top + container.clientHeight;
            return {scrollTop: container.scrollTop, top: row.top, bottom: row.bottom,
                viewportTop: top, viewportBottom: bottom,
                fullyVisible: row.top >= top && row.bottom <= bottom,
                calls: globalThis.treeScrollCalls.slice(), outerScroll: scrollY};
        }""")

    def position(self, index, offset=180):
        self.settle()
        self.row(index).evaluate("""(element, offset) => {
            const container = document.getElementById('tabs-container');
            container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop - offset;
        }""", offset)
        self.settle()
        self.sidebar.evaluate("globalThis.treeScrollCalls = []")
        return self.metrics(self.row(index))

    def wait_active(self, index):
        def active_and_saved():
            logical = self.logical(index)
            active = self.active_tab()
            return (logical if logical["logicalId"] == self.session()["lastActiveLogicalTabId"]
                    and active["id"] in logical["liveTabIds"] and active["status"] == "complete"
                    and logical["lastSavedTitle"] == logical["title"] else None)

        self.wait_until(active_and_saved, f"row {index} active and saved")
        expect(self.row(index)).to_have_class(re.compile(r"\bactive-live\b"))
        self.settle()

    def activate(self, index):
        result = self.send_message({"type": "FOCUS_OR_MOUNT_TAB", "windowId": self.window_id,
                                    "logicalId": self.logical(index)["logicalId"]})
        assert result.get("success"), result
        self.wait_active(index)

    def record(self, name, before, row, stationary=False, require_scroll=True):
        self.settle()
        after = self.metrics(row)
        record = {"name": name, "mode": self.mode, "width": self.width, "before": before, "after": after}
        self.evidence["flows"].append(record)
        # Capture before raising so a red baseline has the same geometry and visual evidence as the green run.
        if stationary or name == "locate-collapsed-group":
            self.sidebar.screenshot(path=str(self.artifacts / f"{self.mode}-{name}.png"))
        assert after["fullyVisible"], f"{name}: selected row is still clipped: {after}"
        if stationary:
            assert after["scrollTop"] == before["scrollTop"], f"{name}: visible selection moved from {before['scrollTop']} to {after['scrollTop']}"
            assert after["calls"] == [], f"{name}: fully visible row requested scrolling: {after['calls']}"
        elif require_scroll:
            assert after["calls"], f"{name}: off-screen row was not revealed"
        assert after["outerScroll"] == 0, f"{name}: scrolled the outer page"
        print(f"PASS {self.mode}/{name}", flush=True)

    def prepare_rows(self, base_url):
        self.base_url = base_url
        self.mode = "compact"
        self.prepare(base_url)
        self.evidence["page_console"] = []
        self.sidebar.on("console", lambda message: self.evidence["page_console"].append({"type": message.type, "text": message.text}))
        session = self.session()
        self.sidebar.evaluate("""async ({sessionId, baseUrl}) => {
            await chrome.storage.local.set({confirmDeleteLogicalTab: false});
            for (let index = 0; index < 54; index++) {
                if (index === 50) globalThis.fixtureGroup = await chrome.bookmarks.create({parentId: sessionId, title: 'Scroll fixture group [blue]'});
                await chrome.bookmarks.create({parentId: index >= 50 ? fixtureGroup.id : sessionId,
                    title: `Scroll fixture ${index}`, url: `${baseUrl}?row=${index}`});
            }
        }""", {"sessionId": session["sessionId"], "baseUrl": base_url})
        # A normal native-tab creation uses the existing canonical bookmark reload, without calling background internals or fabricating STATE_UPDATED messages.
        self.sidebar.evaluate("windowId => chrome.tabs.create({windowId, url: 'about:blank', active: false})", self.window_id)
        self.wait_until(lambda: any(tab["url"] == self.url(53) for tab in self.session()["logicalTabs"]), "generated saved rows loaded")
        expect(self.row(53)).to_be_attached()
        self.sidebar.evaluate("""() => {
            globalThis.treeScrollCalls = [];
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function(options) {
                if (this.closest('#tabs-container')) treeScrollCalls.push({id: this.dataset.id, options});
                return Reflect.apply(original, this, arguments);
            };
        }""")
        self.fixture = self.sidebar  # All later native tab operations leave this observer open.

    def visible_selections(self):
        self.activate(20)
        self.activate(22)
        self.activate(20)
        before = self.position(22)
        assert before["fullyVisible"]
        self.row(22).click()
        self.wait_active(22)
        self.record("click-mounted-visible", before, self.row(22), stationary=True)

        assert not self.logical(21)["liveTabIds"]
        before = self.position(21)
        assert before["fullyVisible"]
        self.row(21).click()
        self.wait_active(21)
        self.record("click-unmounted-visible", before, self.row(21), stationary=True)

        before = self.position(21)
        self.sidebar.locator("#locate-current").click()
        self.record("locate-visible", before, self.row(21), stationary=True)

    def auto_selection(self):
        # Mount the target between the nearby native alternatives; the test observes Chrome's actual replacement rather than inventing an active-state message.
        for operation in ("unmount", "delete"):
            self.activate(22)
            before = self.position(21, offset=110)
            for index in (20, 21, 22):
                assert self.metrics(self.row(index))["fullyVisible"]
            control = ".live-indicator-wrapper" if operation == "unmount" else ".tab-delete-btn"
            self.row(22).locator(control).click()
            self.wait_until(lambda: self.sidebar.locator("#tabs-container .tab-item.active-live").count() == 1
                            and self.sidebar.locator("#tabs-container .tab-item.active-live").get_attribute("title") != self.url(22),
                            f"native replacement after {operation}")
            self.record(f"auto-select-visible-after-{operation}", before, self.sidebar.locator("#tabs-container .tab-item.active-live"), stationary=True)

        self.activate(30)
        self.activate(31)
        self.activate(30)
        self.position(0, offset=10)
        before = self.metrics(self.row(30))
        assert not before["fullyVisible"]
        self.sidebar.evaluate("globalThis.treeScrollCalls = []")
        self.send_message({"type": "UNMOUNT_LOGICAL_TAB", "windowId": self.window_id,
                           "logicalId": self.logical(30)["logicalId"]})
        self.wait_until(lambda: self.sidebar.locator("#tabs-container .tab-item.active-live").count() == 1
                        and self.sidebar.locator("#tabs-container .tab-item.active-live").get_attribute("title") != self.url(30),
                        "off-screen native replacement")
        self.record("auto-select-off-screen-after-unmount", before, self.sidebar.locator("#tabs-container .tab-item.active-live"))

    def clipped_selections(self):
        for edge in ("top", "bottom", "off-screen"):
            self.activate(20)
            height = self.row(21).evaluate("element => element.getBoundingClientRect().height")
            viewport = self.sidebar.locator("#tabs-container").evaluate("element => element.clientHeight")
            offset = -height / 2 if edge == "top" else viewport - height / 2 if edge == "bottom" else viewport + 100
            before = self.position(21, offset)
            assert not before["fullyVisible"]
            self.activate(21)  # Native activation, without Playwright scrolling the clipped click target first.
            self.record(f"select-{edge}", before, self.row(21))

        before = self.position(21, offset=700)
        assert not before["fullyVisible"]
        self.sidebar.locator("#locate-current").click()
        self.record("locate-off-screen", before, self.row(21))

    def collapsed_and_hidden(self):
        self.activate(51)
        group_id = self.logical(51)["groupId"]
        self.sidebar.locator(f'.group-header[data-id="{group_id}"] .group-toggle').click()
        expect(self.row(51)).to_have_count(0)
        self.sidebar.evaluate("globalThis.treeScrollCalls = []")
        self.sidebar.locator("#locate-current").click()
        expect(self.row(51)).to_be_attached()
        # Expanding can itself place the row fully inside the viewport; an extra scroll is neither needed nor allowed in that case.
        self.record("locate-collapsed-group", {}, self.row(51), require_scroll=False)

        self.sidebar.locator("#recent-tabs-btn").click()
        expect(self.sidebar.locator("#recent-tabs-container .mru-result").first).to_be_visible()
        self.sidebar.evaluate("globalThis.treeScrollCalls = []")
        self.activate(20)
        assert self.sidebar.evaluate("treeScrollCalls") == [], "hidden normal tree requested scrolling"
        assert self.sidebar.evaluate("scrollY") == 0
        self.evidence["flows"].append({"name": "hidden-tree-stays-stationary", "mode": self.mode})
        self.sidebar.locator("#recent-tabs-btn").click()

    def popup_smoke(self):
        with self.context.expect_page() as opened:
            self.send_message({"type": "MRU_OPEN", "sourceWindowId": self.window_id})
        popup = opened.value
        popup.on("pageerror", lambda error: self.evidence["page_errors"].append(str(error)))
        popup.on("console", lambda message: self.evidence["page_console"].append({"type": message.type, "text": message.text}))
        expect(popup.locator(".mru-result").first).to_be_visible()
        popup.set_viewport_size({"width": 420, "height": 700})
        selected = popup.locator('.mru-result[aria-selected="true"]')
        expect(selected).to_have_count(1)
        # The popup uses nearest-edge scrolling. Moving to another fully visible row must preserve its list's position.
        before = popup.locator(".mru-results").evaluate("element => element.scrollTop")
        popup.locator(".mru-search").press("ArrowDown")
        expect(selected).to_have_count(1)
        after = popup.locator(".mru-results").evaluate("element => element.scrollTop")
        assert after == before, f"Visible popup cursor jumped from {before} to {after}"
        popup.screenshot(path=str(self.artifacts / "popup-nearest-scroll.png"))
        self.evidence["flows"].append({"name": "popup-nearest-scroll", "before": before, "after": after})
        popup.close()

    def run(self, mode, width):
        self.mode, self.width = mode, width
        self.sidebar.set_viewport_size({"width": width, "height": 650})
        self.sidebar.evaluate("mode => chrome.storage.local.set({tabDisplayMode: mode})", mode)
        expect(self.sidebar.locator("body")).to_have_attribute("data-tab-display", mode)
        self.visible_selections()
        self.clipped_selections()
        self.auto_selection()
        self.collapsed_and_hidden()
        self.popup_smoke()
        assert not self.evidence["page_errors"], self.evidence["page_errors"]
        errors = [message for source in ("worker_console", "page_console") for message in self.evidence[source] if message["type"] == "error"]
        assert not errors, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--mode", choices=["all", "compact", "url", "domain"], default="all", help="Isolate a display mode for focused reruns")
    parser.add_argument("--executable-path", type=Path, help="Use an already installed Chromium when Playwright's pinned revision is absent")
    args = parser.parse_args()
    if not args.artifacts_dir.is_dir():
        parser.error("--artifacts-dir must already exist")
    artifacts = Path(tempfile.mkdtemp(prefix="sidebar-scroll-", dir=args.artifacts_dir))
    extension = Path(__file__).resolve().parents[1] / "src"
    server = ThreadingHTTPServer(("127.0.0.1", 0), ScrollFixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"Evidence/profile retained: {artifacts}", flush=True)
    try:
        with sync_playwright() as playwright:
            for mode, width in (("compact", 320), ("url", 420), ("domain", 320)):
                if args.mode not in ("all", mode):
                    continue
                mode_artifacts = artifacts / mode
                mode_artifacts.mkdir()
                profile = mode_artifacts / "profile"
                context = playwright.chromium.launch_persistent_context(str(profile), headless=args.headless,
                    channel="chromium", viewport={"width": 1100, "height": 800},
                    executable_path=str(args.executable_path) if args.executable_path else None,
                    ignore_default_args=["--disable-extensions"],
                    args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"])
                context.set_default_timeout(15000)
                check = SidebarScrollCheck(context, mode_artifacts)
                check.evidence.update(extension=str(extension), chromium=context.browser.version, isolated_profile=str(profile))
                try:
                    check.prepare_rows(f"http://127.0.0.1:{server.server_port}/fixture")
                    check.run(mode, width)
                    print(f"PASS {mode}: {len(check.evidence['flows'])} real-extension scroll flows", flush=True)
                except Exception as error:
                    check.evidence["failure"] = str(error)
                    if hasattr(check, "sidebar") and not check.sidebar.is_closed():
                        check.sidebar.screenshot(path=str(mode_artifacts / "failure.png"))
                    raise
                finally:
                    (mode_artifacts / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
                    context.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
