"""Optional guarded Win32 input for isolated browser QA; no browser-package dependency."""
import ctypes
from ctypes import wintypes


class NativeShortcutDriver:
    """Restrict keydowns to the QA process; always permit release-only cleanup of owned injections."""

    def __init__(self, expected_title):
        self.injected_keys = set()
        self.user32 = ctypes.WinDLL('user32', use_last_error=True)
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
        self.user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        self.user32.keybd_event.argtypes = (wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t)
        # CDP bringToFront selects a Chrome tab but does not necessarily acquire Windows foreground focus. Target only this run's unique fixture title, never the current unrelated application.
        targets = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def find_window(window, _):
            text = ctypes.create_unicode_buffer(512)
            self.user32.GetWindowTextW(window, text, len(text))
            if expected_title in text.value:
                targets.append(window)
            return True
        self.user32.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
        self.user32.EnumWindows(callback_type(find_window), 0)
        assert len(targets) == 1, f'Native input stopped: expected exactly one isolated QA window, found {len(targets)}'
        self.user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
        self.user32.SetForegroundWindow(targets[0])
        window = self.user32.GetForegroundWindow()
        title = ctypes.create_unicode_buffer(512)
        self.user32.GetWindowTextW(window, title, len(title))
        assert expected_title in title.value, f'Native input stopped: expected isolated QA title, found {title.value!r}'
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        self.pid = pid.value

    def send(self, key, release=False):
        if release:
            # A keyup for an owned injection is emergency cleanup, not new input. It must remain possible after focus changes or an assertion fails; otherwise Ctrl could remain logically pressed globally.
            if key in self.injected_keys:
                self.user32.keybd_event(key, 0, 2, 0)
                self.injected_keys.remove(key)
            return
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(self.user32.GetForegroundWindow(), ctypes.byref(pid))
        assert pid.value == self.pid, 'Native input stopped: focus left the isolated QA browser process'
        self.injected_keys.add(key)
        self.user32.keybd_event(key, 0, 0, 0)

    def press(self, key):
        self.send(key)
        self.send(key, release=True)

    def release_owned_keys(self):
        for key in sorted(self.injected_keys, reverse=True):
            self.send(key, release=True)
