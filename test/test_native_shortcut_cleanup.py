"""Verify owned-key cleanup using a fake Win32 boundary; never send real OS input."""
import unittest
from ctypes import POINTER, cast, wintypes
from native_shortcut_driver import NativeShortcutDriver


class WindowInputBoundary:
    def __init__(self):
        self.foreground_pid = 10
        self.events = []

    def GetForegroundWindow(self):
        return 1

    def GetWindowThreadProcessId(self, window, pointer):
        cast(pointer, POINTER(wintypes.DWORD))[0] = self.foreground_pid

    def keybd_event(self, key, scan, flags, extra):
        self.events.append((key, flags))


class NativeShortcutCleanupTest(unittest.TestCase):
    def driver(self):
        driver = NativeShortcutDriver.__new__(NativeShortcutDriver)
        driver.user32 = WindowInputBoundary()
        driver.pid = 10
        driver.injected_keys = set()
        return driver

    def test_owned_ctrl_is_released_after_focus_leaves_the_qa_process(self):
        driver = self.driver()
        driver.send(0x11)
        driver.user32.foreground_pid = 99
        self.assertTrue(callable(getattr(driver, 'release_owned_keys', None)), 'provide owned-key emergency cleanup')
        driver.release_owned_keys()
        self.assertEqual(driver.user32.events, [(0x11, 0), (0x11, 2)])
        self.assertEqual(driver.injected_keys, set())
        driver.release_owned_keys()
        self.assertEqual(len(driver.user32.events), 2, 'cleanup is idempotent')

    def test_focus_change_still_blocks_all_new_keydowns(self):
        driver = self.driver()
        driver.user32.foreground_pid = 99
        with self.assertRaises(AssertionError):
            driver.send(0x28)
        self.assertEqual(driver.user32.events, [])

    def test_cleanup_retains_ownership_if_injection_raises_after_sending_keydown(self):
        driver = self.driver()
        send = driver.user32.keybd_event
        def interrupted(key, scan, flags, extra):
            send(key, scan, flags, extra)
            if flags == 0:
                raise RuntimeError('Interrupted after injection')
        driver.user32.keybd_event = interrupted
        with self.assertRaises(RuntimeError):
            driver.send(0x11)
        driver.user32.foreground_pid = 99
        driver.release_owned_keys()
        self.assertEqual(driver.user32.events, [(0x11, 0), (0x11, 2)])
        self.assertEqual(driver.injected_keys, set())


if __name__ == '__main__':
    unittest.main()
