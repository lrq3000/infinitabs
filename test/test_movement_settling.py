"""Verify the actual browser waiter's success/timeout criteria with a virtual clock."""
import unittest
from unittest.mock import patch

from verify_move_logical_tabs import MovementCheck


class SettlingFixture(MovementCheck):
    def __init__(self, states, events=()):
        self.now = 0
        self.states = states
        self.events = events
        self.fixture = self.sidebar = self
        self.evidence = {}

    def snapshot(self):
        return next(state for at, state in reversed(self.states) if at <= self.now)

    def evaluate(self, expression):
        return [event for event in self.events if event <= self.now]

    def wait_for_timeout(self, milliseconds):
        self.now += milliseconds / 1000

    def run_wait(self, timeout_ms=1500):
        def validate(snapshot):
            assert snapshot['order'] == 'CABD', snapshot
        with patch('verify_move_logical_tabs.time.monotonic', lambda: self.now):
            return self.wait_for_settled(validate, 'native/bookmark order', quiet_ms=200, timeout_ms=timeout_ms)


class MovementSettlingTests(unittest.TestCase):
    def test_waits_for_expected_state_before_quiet_interval(self):
        fixture = SettlingFixture([(0, {'order': 'ABCD'}), (0.6, {'order': 'CABD'})])
        self.assertEqual(fixture.run_wait(), {'order': 'CABD'})
        self.assertGreaterEqual(fixture.now, 0.8)

    def test_late_event_resets_quiet_interval_even_without_state_change(self):
        fixture = SettlingFixture([(0, {'order': 'CABD'})], events=(0.15,))
        fixture.run_wait()
        self.assertGreaterEqual(fixture.now, 0.35)

    def test_transient_expected_state_is_not_success(self):
        fixture = SettlingFixture([(0, {'order': 'CABD'}), (0.1, {'order': 'ABCD'})])
        with self.assertRaisesRegex(AssertionError, 'Timed out'):
            fixture.run_wait(timeout_ms=500)
        self.assertEqual(fixture.evidence['settling_timeout']['snapshot'], {'order': 'ABCD'})
        self.assertLess(fixture.now, 0.6)

    def test_snapshot_change_restarts_observation(self):
        fixture = SettlingFixture([(0, {'order': 'CABD', 'group': 1}),
                                  (0.15, {'order': 'CABD', 'group': 2})])
        self.assertEqual(fixture.run_wait()['group'], 2)
        self.assertGreaterEqual(fixture.now, 0.35)


if __name__ == '__main__':
    unittest.main()
