"""Compatibility entrypoint for the shared real-extension header/settings verification.

Run: python -B test/verify_settings_btn.py --headless --artifacts-dir <existing-directory> [--executable <installed-chromium>].
The shared harness verifies actual options opening, responsive header controls and MRU behavior without Chrome API mocks or disabled browser security; profiles and screenshots are retained outside the repository.
"""
from verify_mru_switcher import main


def test_settings_btn():
    main()


if __name__ == "__main__":
    test_settings_btn()
