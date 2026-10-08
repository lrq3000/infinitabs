"""Real MV3 regression: reconstruct active state without a later tab activation.

Run: python test/verify_active_tab_reload.py --artifacts-dir <existing-temp-dir>
Use --flow cold_worker or --flow extension_reload to isolate either boundary.
Requires Python Playwright and its bundled Chromium (`playwright install chromium`).
Loads this checkout's src directly, with its unmodified manifest and no Chrome mocks.
Screenshots/evidence remain in the artifact directory; the disposable profile is removed.
"""

import argparse
import json
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        title = "PR40 inactive tab" if "?inactive" in self.path else "PR40 active tab"
        body = f"<!doctype html><title>{title}</title><h1>{title}</h1>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass  # Keep the regression output focused on extension evidence.


class ActiveTabReloadCheck:
    def __init__(self, context, artifacts):
        self.context = context
        self.artifacts = artifacts
        self.evidence = {"flows": [], "worker_console": [], "page_errors": []}
        self.context.on("serviceworker", self.observe_worker)
        for worker in context.service_workers:
            self.observe_worker(worker)

    def observe_worker(self, worker):
        worker.on("console", lambda msg: self.evidence["worker_console"].append(
            {"type": msg.type, "text": msg.text}
        ))

    def wait_until(self, predicate, description):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            self.fixture.wait_for_timeout(50)
        raise AssertionError(f"Timed out: {description}")

    def session(self):
        # Same public message used by the shipped sidebar; its handler awaits init.
        response = self.sidebar.evaluate("""async windowId => {
            let timer;
            try {
                return await Promise.race([
                    chrome.runtime.sendMessage({type: 'GET_CURRENT_SESSION_STATE', windowId}),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Session message timed out')), 15000);
                    })
                ]);
            } finally { clearTimeout(timer); }
        }""", self.window_id)
        self.evidence["last_session_response"] = response
        assert response and response.get("session"), f"Missing session: {response}"
        return response["session"]

    def active_tab(self):
        tabs = self.sidebar.evaluate("""windowId => chrome.tabs.query({
            windowId, active: true
        })""", self.window_id)
        assert len(tabs) == 1, f"Expected one active tab: {tabs}"
        return tabs[0]

    def open_sidebar(self):
        # Chrome closes extension tabs on runtime.reload. Recreate the shipped page
        # in the background rather than context.new_page(), which would steal focus.
        # CDP also works when no extension worker is running yet after a reload.
        cdp = self.context.new_cdp_session(self.fixture)
        try:
            with self.context.expect_page() as opened:
                cdp.send("Target.createTarget", {"url": self.sidebar_url, "background": True})
        finally:
            cdp.detach()
        self.sidebar = opened.value
        self.sidebar.on("pageerror", lambda error: self.evidence["page_errors"].append(str(error)))
        self.sidebar.wait_for_url(self.sidebar_url)
        self.sidebar.wait_for_load_state()

    def prepare(self, fixture_url):
        self.worker = (self.context.service_workers or [None])[0]
        if self.worker is None:
            self.worker = self.context.wait_for_event("serviceworker")
        extension_id = urlparse(self.worker.url).netloc
        assert self.worker.url == f"chrome-extension://{extension_id}/background.js"
        self.evidence["extension_id"] = extension_id
        self.fixture = self.context.pages[0]
        # Command-line loading works initially without Developer mode, but Chromium
        # disables the unpacked extension as unsupported on runtime.reload without it.
        # Set it through the real browser UI in this disposable profile only.
        self.fixture.goto("chrome://extensions")
        developer_mode = self.fixture.locator("#devMode")
        if not developer_mode.evaluate("toggle => toggle.checked"):
            developer_mode.click()
        target = self.worker.evaluate("""async () => {
            const [tab] = await chrome.tabs.query({active: true});
            return tab;
        }""")
        self.tab_id, self.window_id = target["id"], target["windowId"]
        self.sidebar_url = f"chrome-extension://{extension_id}/sidebar.html"
        self.open_sidebar()
        self.session()  # Finish first-install initialization before fixture mutations.
        self.fixture.goto(fixture_url)
        self.fixture.bring_to_front()  # Setup only: never activate a tab after a trigger.
        # Navigation updates are debounced to bookmarks. Wait for persistence before
        # another tab creation reloads the bookmark model or a cold worker rebuilds it.
        self.wait_until(lambda: any(tab["lastSavedUrl"] == fixture_url and self.tab_id in tab["liveTabIds"]
            for tab in self.session()["logicalTabs"]), "fixture navigation to be saved")

        # Put an inactive tab before the target so choosing the first tab cannot pass.
        # Let onCreated attach its bookmark before navigating: fast navigation can
        # otherwise outrun the existing asynchronous tab-creation handler.
        with self.context.expect_page() as decoy:
            decoy_tab = self.worker.evaluate("""windowId => chrome.tabs.create({
                url: 'about:blank', windowId, active: false, index: 0
            })""", self.window_id)
        self.wait_until(lambda: any(decoy_tab["id"] in tab["liveTabIds"]
            for tab in self.session()["logicalTabs"]), "inactive tab to be mounted")
        decoy_url = fixture_url + "?inactive"
        decoy.value.goto(decoy_url)

        def mapped_session():
            session = self.session()
            mounted = [tab for tab in session["logicalTabs"] if tab["lastSavedUrl"] in (fixture_url, decoy_url)
                       and tab["liveTabIds"]]
            return session if len(mounted) == 2 else None

        initial = self.wait_until(mapped_session, "both fixture bookmarks to be saved")
        self.session_id = initial["sessionId"]
        self.bookmark_id = next(tab["bookmarkId"] for tab in initial["logicalTabs"]
                                if self.tab_id in tab["liveTabIds"])
        self.evidence["target"] = {"tab_id": self.tab_id, "window_id": self.window_id,
                                   "bookmark_id": self.bookmark_id, "url": fixture_url}
        assert self.active_tab()["id"] == self.tab_id

    def cold_worker(self):
        # The sidebar survives worker termination, so it can observe EVERY activation
        # over this boundary. No injected code changes production state or Chrome APIs.
        self.sidebar.evaluate("""() => {
            globalThis.activationEvents = [];
            chrome.tabs.onActivated.addListener(info => activationEvents.push(info));
        }""")
        cdp = self.context.new_cdp_session(self.fixture)
        versions = {}
        cdp.on("ServiceWorker.workerVersionUpdated", lambda event: versions.update(
            {version["versionId"]: version for version in event["versions"]}
        ))
        cdp.send("ServiceWorker.enable")
        version = self.wait_until(lambda: next((v for v in versions.values()
            if v["scriptURL"] == self.worker.url and v["runningStatus"] == "running"), None),
            "running extension service worker")
        try:
            cdp.send("ServiceWorker.stopWorker", {"versionId": version["versionId"]})
            self.wait_until(lambda: versions[version["versionId"]]["runningStatus"] == "stopped",
                            "extension worker to finish stopping")
            result = self.session()  # Wakes the cold worker via the real message.
            # Chromium can reuse the CDP worker target across a stop/start. The
            # stopped lifecycle event and regenerated logical IDs prove the restart.
            self.worker = self.context.service_workers[0]
            events = self.sidebar.evaluate("activationEvents")
            assert events == [], f"Later activation could mask initialization: {events}"
            return result, {"activation_events": events, "stopped_version": version["versionId"]}
        finally:
            cdp.detach()

    def extension_reload(self):
        closed = []
        self.worker.on("close", lambda *_: closed.append(True))
        cdp = self.context.new_cdp_session(self.fixture)
        registrations = []
        cdp.on("ServiceWorker.workerRegistrationUpdated", lambda event:
               registrations.extend(event["registrations"]))
        cdp.send("ServiceWorker.enable")
        scope = self.worker.url.rsplit("/", 1)[0] + "/"
        self.wait_until(lambda: registrations, "initial worker registration")
        registrations.clear()
        try:
            # Returning before reload avoids relying on a destroyed execution context.
            self.worker.evaluate("() => { setTimeout(() => chrome.runtime.reload(), 0); }")
            self.wait_until(lambda: closed, "old worker to close on runtime.reload")
            self.wait_until(lambda: any(reg["scopeURL"] == scope and not reg["isDeleted"]
                for reg in registrations), "extension to re-register before opening its sidebar")
            self.open_sidebar()  # Its public messages wake the reloaded extension.
            result = self.session()
            self.worker = self.context.service_workers[0]
            return result, {"old_worker_closed": bool(closed), "registrations": registrations}
        finally:
            self.evidence["reload_registrations"] = registrations
            cdp.detach()

    def verify(self, flow):
        before = self.session()
        before_tab = next(tab for tab in before["logicalTabs"] if self.tab_id in tab["liveTabIds"])
        assert self.active_tab()["id"] == self.tab_id
        session, trigger = getattr(self, flow)()
        active = self.active_tab()
        mapped = [tab for tab in session["logicalTabs"] if self.tab_id in tab["liveTabIds"]]
        record = {"flow": flow, "trigger": trigger, "session_id": session["sessionId"],
                  "actual_active_tab_id": active["id"], "active_tab_index": active["index"],
                  "mapped_tabs": mapped,
                  "last_active_logical_id": session["lastActiveLogicalTabId"]}
        self.evidence["flows"].append(record)
        assert active["id"] == self.tab_id, "Fixture stopped being active across reload"
        assert active["index"] > 0, "Inactive decoy must precede the active tab"
        assert session["sessionId"] == self.session_id, "Reload changed the bound session"
        assert len(mapped) == 1, f"Expected exactly one mounted logical identity: {mapped}"
        logical = mapped[0]
        assert logical["bookmarkId"] == self.bookmark_id, "Reload changed bookmark identity"
        assert logical["liveTabIds"] == [self.tab_id], "Active tab lost its mounted mapping"
        assert logical["logicalId"] != before_tab["logicalId"], "Worker did not reconstruct state"
        # Capture the rendered sidebar even on the expected red baseline.
        row = self.sidebar.locator(f'.tab-item[data-id="{logical["logicalId"]}"]')
        expect(row).to_be_attached()
        record["sidebar_active_ids"] = self.sidebar.locator(".tab-item.active-live").evaluate_all(
            "rows => rows.map(row => row.dataset.id)")
        self.sidebar.screenshot(path=str(self.artifacts / f"{flow}.png"))
        assert session["lastActiveLogicalTabId"] == logical["logicalId"], (
            f"{flow}: active logical mismatch after initialization: expected "
            f"{logical['logicalId']}, got {session['lastActiveLogicalTabId']!r}"
        )
        expect(self.sidebar.locator(".tab-item.active-live")).to_have_count(1)
        expect(self.sidebar.locator(".tab-item.active-live.live")).to_have_attribute(
            "data-id", logical["logicalId"])
        assert self.active_tab()["id"] == self.tab_id, "Sidebar verification activated another tab"
        assert self.evidence["page_errors"] == [], f"Sidebar errors: {self.evidence['page_errors']}"
        errors = [msg for msg in self.evidence["worker_console"] if msg["type"] == "error"]
        assert errors == [], f"Worker errors: {errors}"
        record["sidebar_highlight"] = logical["logicalId"]
        print(f"PASS {flow}: mounted active identity and real sidebar highlight", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, default=Path(tempfile.gettempdir()) / "opencode")
    parser.add_argument("--flow", choices=["both", "cold_worker", "extension_reload"], default="both")
    args = parser.parse_args()
    if not args.artifacts_dir.is_dir():
        parser.error("--artifacts-dir must be an existing temporary artifact directory")
    extension = Path(__file__).resolve().parents[1] / "src"
    artifacts = Path(tempfile.mkdtemp(prefix="pr40-evidence-", dir=args.artifacts_dir))
    print(f"Extension: {extension}\nEvidence: {artifacts}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="pr40-profile-", dir=args.artifacts_dir) as profile:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    profile, headless=False, viewport={"width": 1100, "height": 800},
                    ignore_default_args=["--disable-extensions"],
                    args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
                )
                context.set_default_timeout(15000)
                check = ActiveTabReloadCheck(context, artifacts)
                check.evidence.update(extension_path=str(extension), isolated_profile=profile,
                                      chromium=context.browser.version)
                try:
                    check.prepare(f"http://127.0.0.1:{server.server_port}/active")
                    print(f"Extension ID: {check.evidence['extension_id']}", flush=True)
                    flows = ["cold_worker", "extension_reload"] if args.flow == "both" else [args.flow]
                    for flow in flows:
                        check.verify(flow)
                except Exception as error:
                    check.evidence["failure"] = str(error)
                    # Browser-internal diagnostics after a failed run do not influence
                    # the tested flow. This helps distinguish reload/load failures from
                    # the product's active-state assertion when Chromium versions vary.
                    try:
                        diagnostic = context.pages[-1]
                        diagnostic.goto("chrome://extensions")
                        check.evidence["extension_diagnostics"] = diagnostic.evaluate("""async () =>
                            (await chrome.developerPrivate.getExtensionsInfo({
                                includeDisabled: true, includeTerminated: true
                            })).map(({id, state, path, disableReasons, manifestErrors, runtimeErrors}) =>
                                ({id, state, path, disableReasons, manifestErrors, runtimeErrors}))""")
                    except Exception as diagnostic_error:
                        check.evidence["diagnostic_failure"] = str(diagnostic_error)
                    raise
                finally:
                    check.evidence["page_urls"] = [page.url for page in context.pages]
                    (artifacts / "evidence.json").write_text(
                        json.dumps(check.evidence, indent=2), encoding="utf-8")
                    context.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
