"""Real browser-process restarts with Chrome session restore and InfiniTabs auto-reload enabled; retain only this run's disposable profile/evidence."""

import argparse
import io
import json
import subprocess
import tempfile
import time
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
from verify_active_tab_reload import ActiveTabReloadCheck, FixtureHandler


class StartupRestoreCheck:
    def __init__(self, artifacts):
        self.artifacts = artifacts
        self.evidence = {"flows": [], "worker_console": []}

    def attach(self, context):
        self.context = context
        self.worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        self.worker.on("console", lambda message: self.evidence["worker_console"].append(
            {"type": message.type, "text": message.text}))
        self.extension_id = urlparse(self.worker.url).netloc
        self.evidence["extension_id"] = self.extension_id

    def wait(self, predicate, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(0.05)
        raise AssertionError(f"Timed out: {description}")

    def saved(self):
        # Exclude only the session folder's mutable window suffix. Bookmark IDs, parents, order, URLs and group metadata must remain exactly unchanged.
        return self.worker.evaluate("""async id => {
            const [root] = await chrome.bookmarks.getSubTree(id);
            const rows = [];
            function visit(node) {
                rows.push({id:node.id, parentId:node.parentId, index:node.index, title:node.title, url:node.url || null});
                for (const child of node.children || []) visit(child);
            }
            for (const child of root.children || []) visit(child);
            return rows;
        }""", self.session_id)

    def persist_test_installation(self, profile):
        # Both --load-extension and CDP Extensions.loadUnpacked create location=8 (COMMAND_LINE) entries: reinstall on launch, or disappear without flags.
        # Seed the installation precondition before EACH launch in this OWNED, CLOSED synthetic profile: location=4 (UNPACKED), as Chrome's Load unpacked UI does. Chromium can scrub a synthetic command-line entry during shutdown, so retain its original installation record, not its extension storage. No source, bookmarks or extension storage is patched; this does not test Chromium's installation persistence/security machinery.
        for name in ('Secure Preferences', 'Preferences'):
            file = profile / 'Default' / name
            if not file.exists():
                continue
            preferences = json.loads(file.read_text(encoding='utf-8'))
            settings = preferences.get('extensions', {}).get('settings', {})
            installed = settings.get(self.extension_id)
            if hasattr(self, 'installation_entry') or installed and installed.get('path'):
                if not hasattr(self, 'installation_entry'):
                    assert Path(installed['path']).resolve() == self.extension.resolve()
                    assert installed['location'] == 8
                    self.installation_entry = {**installed, 'location': 4}
                settings[self.extension_id] = self.installation_entry
                file.write_text(json.dumps(preferences), encoding='utf-8')
                self.evidence['installation'] = 'Disposable profile installation record seeded as UNPACKED before each restart; extension storage untouched'
                return
        raise AssertionError('Chromium did not record the test extension installation')

    def prepare(self, fixture_url):
        page = self.context.pages[0] if self.context.pages else self.context.new_page()
        page.goto(fixture_url)
        self.worker.evaluate("""async url => {
            const [native] = await chrome.tabs.query({active:true, lastFocusedWindow:true});
            await chrome.tabs.create({windowId:native.windowId, url:url + '?inactive', active:false});
            await chrome.tabs.create({windowId:native.windowId, url, active:false});
        }""", fixture_url)
        self.wait(lambda: self.worker.evaluate("""async () => {
            const value = await chrome.storage.local.get('windowToSession');
            return Object.values(value.windowToSession || {})[0];
        }"""), "initial session binding")
        self.session_id = self.worker.evaluate("async () => Object.values((await chrome.storage.local.get('windowToSession')).windowToSession)[0]")
        self.wait(lambda: len([row for row in self.saved() if row["url"] and row["url"].startswith(fixture_url)]) == 3,
                  "three native tabs saved, including an intentional same-URL pair")
        self.wait(lambda: sorted(row['title'] for row in self.saved() if row['url'] and row['url'].startswith(fixture_url)) ==
                  ['PR40 active tab', 'PR40 active tab', 'PR40 inactive tab'], 'debounced tab metadata persisted')
        # An unmounted saved blank must not become the startup placeholder's logical owner. This also makes the browser test catch URL-wide blank exclusions.
        self.worker.evaluate("async id => chrome.bookmarks.create({parentId:id, title:'Saved blank', url:'about:blank'})", self.session_id)
        self.before = self.saved()
        self.evidence["before"] = self.before
        self.worker.evaluate("""async id => {
            const window = (await chrome.windows.getAll()).find(win => win.type === 'normal');
            const snapshot = {id:'startup-regression', sessions:[{sessionId:id, windowId:window.id}], isTrivial:false};
            // Observe the configuration event, not merely the storage write ACK: the production preference listener must run before closing Chrome.
            await new Promise((resolve, reject) => {
                const listener = (changes, area) => {
                    if (area === 'local' && changes.reloadOnRestart) {
                        chrome.storage.onChanged.removeListener(listener); resolve();
                    }
                };
                chrome.storage.onChanged.addListener(listener);
                chrome.storage.local.set({reloadOnRestart:true, lastKnownWorkspace:snapshot, workspaceHistory:[snapshot]}).catch(reject);
            });
        }""", self.session_id)

    def check_restart(self, number):
        def restored_window():
            return self.worker.evaluate("""async sessionId => {
                const {windowToSession} = await chrome.storage.local.get('windowToSession');
                for (const win of await chrome.windows.getAll({populate:true})) {
                    if (win.type !== 'normal' || windowToSession?.[win.id] !== sessionId) continue;
                    if (win.tabs.length && win.tabs.every(tab => tab.url?.startsWith(chrome.runtime.getURL('mru/')))) return win.id;
                }
                return null;
            }""", self.session_id)
        window_id = self.wait(restored_window, "automatic unmounted workspace restoration")
        assert self.saved() == self.before, "Browser restart changed saved bookmark identities/content/order"
        bridge = next(page for page in self.context.pages if page.url.startswith(f"chrome-extension://{self.extension_id}/mru/"))
        session = bridge.evaluate("""async windowId => (await chrome.runtime.sendMessage({type:'GET_CURRENT_SESSION_STATE', windowId})).session""", window_id)
        assert session and session["sessionId"] == self.session_id
        assert all(not tab["liveTabIds"] for tab in session["logicalTabs"]), "Startup must not mount any saved tab, even a saved blank"
        windows = self.worker.evaluate("() => chrome.windows.getAll()")
        assert [win['id'] for win in windows if win['type'] == 'normal'] == [window_id], 'Obsolete originals must all disappear, not merely coexist with a matching replacement'

        # Reuse the existing real stop/wake oracle, with the production bridge as its observer/message source. No injected tab mappings or simulated worker restart.
        cold = ActiveTabReloadCheck(self.context, self.artifacts)
        cold.fixture = cold.sidebar = bridge
        cold.window_id, cold.worker = window_id, self.worker
        awake, lifecycle = cold.cold_worker()
        assert awake['sessionId'] == self.session_id
        assert all(not tab['liveTabIds'] for tab in awake['logicalTabs'])
        assert {tab['logicalId'] for tab in awake['logicalTabs']}.isdisjoint(tab['logicalId'] for tab in session['logicalTabs'])
        self.attach(self.context)
        self.evidence['worker_console'].extend(cold.evidence['worker_console'])

        # Exercise shipped MRU context/open/activate messages before opening an ordinary tab. Activation comes from the real switcher popup so closing the workspace bridge cannot destroy its pending response.
        source = bridge.evaluate("async sourceWindowId => chrome.runtime.sendMessage({type:'MRU_CONTEXT', sourceWindowId})", window_id)
        assert 'error' not in source, source
        with self.context.expect_page() as opened:
            response = bridge.evaluate("async sourceWindowId => chrome.runtime.sendMessage({type:'MRU_OPEN', sourceWindowId})", window_id)
        assert response.get('success'), response
        popup = opened.value
        popup.wait_for_url('**/mru/popup.html?sourceWindowId=*')
        target = next(row for row in self.before if row['url'] and row['url'].startswith('http://127.0.0.1:'))
        response = popup.evaluate("async request => chrome.runtime.sendMessage(request)",
            {'type': 'MRU_ACTIVATE', **source, 'key': 'tab:' + target['id']})
        assert response.get('success'), response
        mounted = popup.evaluate("async windowId => (await chrome.runtime.sendMessage({type:'GET_CURRENT_SESSION_STATE', windowId})).session", window_id)
        assert [tab['bookmarkId'] for tab in mounted['logicalTabs'] if tab['liveTabIds']] == [target['id']]
        assert self.saved() == self.before
        popup.close()
        # Leave a mounted saved URL for the NEXT process restart, rather than testing only bridge-only restart input on the second pass.
        self.evidence["flows"].append({"name": f"browser-restart-{number}", "status": "pass", "window_id": window_id,
            "saved": self.saved(), 'worker_wake': lifecycle, 'mru_mounted_bookmark': target['id']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--baseline-ref", help="Read-only git archive of a revision into this run's artifacts for a negative check")
    args = parser.parse_args()
    artifacts = Path(tempfile.mkdtemp(prefix="startup-restore-", dir=args.artifacts_dir))
    profile = artifacts / "profile"
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Preferences").write_text(json.dumps({"session": {"restore_on_startup": 1}}), encoding="utf-8")
    extension = Path(__file__).resolve().parents[1] / "src"
    if args.baseline_ref:
        archive = subprocess.check_output(['git', 'archive', '--format=zip', args.baseline_ref, 'src'], cwd=extension.parent)
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            source.extractall(artifacts / 'baseline')
        extension = artifacts / 'baseline' / 'src'
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    check = StartupRestoreCheck(artifacts)
    check.extension = extension
    print(f"Startup evidence/profile retained: {artifacts}", flush=True)
    try:
        with sync_playwright() as playwright:
            launch = dict(channel="chromium", executable_path=str(args.executable) if args.executable else None,
                headless=args.headless, ignore_default_args=["--disable-extensions", "about:blank"],
                args=["--restore-last-session"])
            context = playwright.chromium.launch_persistent_context(str(profile), **{**launch, 'args': [*launch['args'], f'--load-extension={extension}']})
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto('chrome://extensions')
                developer_mode = page.locator('#devMode')
                if not developer_mode.evaluate('toggle => toggle.checked'):
                    developer_mode.click()
                check.attach(context)
                check.evidence.update(extension_path=str(extension), profile=str(profile), chromium=context.browser.version)
                check.prepare(f"http://127.0.0.1:{server.server_port}/fixture")
                for number in (1, 2):
                    context.close()
                    check.persist_test_installation(profile)
                    context = playwright.chromium.launch_persistent_context(str(profile), **launch)
                    check.attach(context)
                    check.check_restart(number)
                print("Startup restoration browser checks passed (two process restarts)", flush=True)
            finally:
                try:
                    check.evidence['last_state'] = check.worker.evaluate("async () => ({storage:await chrome.storage.local.get(), windows:await chrome.windows.getAll({populate:true})})")
                    if hasattr(check, 'session_id'):
                        check.evidence['last_saved'] = check.saved()
                except Exception as error:
                    check.evidence['diagnostic_error'] = str(error)
                context.close()
    finally:
        (artifacts / "evidence.json").write_text(json.dumps(check.evidence, indent=2), encoding="utf-8")
        server.shutdown()


if __name__ == "__main__":
    main()
