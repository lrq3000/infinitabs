"""Deterministic observer checks: no browser, wall-clock sleeps, or new framework."""

from pathlib import Path
import unittest
from unittest.mock import patch

from verify_move_logical_tabs import MovementCheck


class SimulatedMovement(MovementCheck):
    def __init__(self, corrupt_at=None, event_times=()):
        self.now = 0.0
        self.corrupt_at = corrupt_at
        self.event_times = event_times
        self.fixture = self.sidebar = self
        self.artifacts = Path("observer-test-evidence")  # Diagnostic label; never written.

    def snapshot(self):
        return {"parent": "root" if self.corrupt_at is not None and self.now >= self.corrupt_at else "group"}

    def evaluate(self, expression):
        assert expression == "movementEvents"
        return [{"type": "bookmark-moved", "at": at} for at in self.event_times if at <= self.now]

    def wait_for_timeout(self, milliseconds):
        self.now += milliseconds / 1000

    def observe(self, record, **kwargs):
        with patch("verify_move_logical_tabs.time.monotonic", lambda: self.now):
            return self.observe_expected_state(self.assert_grouped, record, timeout_ms=800, **kwargs)

    @staticmethod
    def assert_grouped(snapshot):
        assert snapshot["parent"] == "group", "late bookmark corruption"


class MovementObserverTests(unittest.TestCase):
    def test_initially_correct_state_is_not_accepted_before_delayed_corruption(self):
        check = SimulatedMovement(corrupt_at=0.1, event_times=(0.1,))
        record = {}
        with self.assertRaisesRegex(AssertionError, "late bookmark corruption"):
            check.observe(record)
        self.assertEqual(record["observation"]["first_expected_ms"], 0)
        self.assertTrue(record["observation"]["timed_out"])
        self.assertEqual(record["after"], {"parent": "root"})
        self.assertEqual(len(record["events"]), 1)

    def test_event_restarts_quiet_period_even_when_state_is_already_correct(self):
        check = SimulatedMovement(event_times=(0.2,))
        record = {}
        self.assertEqual(check.observe(record), {"parent": "group"})
        self.assertGreaterEqual(record["observation"]["elapsed_ms"], 500)
        self.assertGreaterEqual(record["observation"]["observed_quiet_ms"], 300)

    def test_explicit_observation_minimum_is_preserved(self):
        check = SimulatedMovement()
        record = {}
        check.observe(record, observe_ms=650)
        self.assertGreaterEqual(record["observation"]["elapsed_ms"], 650)

    def test_continuous_events_time_out_instead_of_extending_deadline(self):
        check = SimulatedMovement(event_times=tuple(index / 10 for index in range(1, 9)))
        record = {}
        with self.assertRaisesRegex(AssertionError, "state/events kept changing"):
            check.observe(record)
        self.assertTrue(record["observation"]["timed_out"])
        self.assertAlmostEqual(check.now, 0.8)


if __name__ == "__main__":
    unittest.main()
