"""Verify the actual browser waiter's success/timeout criteria with a virtual clock."""
import unittest
from test_movement_observer import SimulatedMovement


class SettlingFixture(SimulatedMovement):
    def __init__(self, states, events=()):
        super().__init__(states=states, event_times=events)
        self.record = {}

    def run_wait(self, timeout_ms=1500):
        def validate(snapshot):
            assert snapshot['order'] == 'CABD', snapshot
        return self.observe(self.record, validate=validate, quiet_ms=200, timeout_ms=timeout_ms)


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
        with self.assertRaisesRegex(AssertionError, 'within 500ms'):
            fixture.run_wait(timeout_ms=500)
        self.assertEqual(fixture.record['after'], {'order': 'ABCD'})
        self.assertTrue(fixture.record['observation']['timed_out'])
        self.assertLess(fixture.now, 0.6)

    def test_snapshot_change_restarts_observation(self):
        fixture = SettlingFixture([(0, {'order': 'CABD', 'group': 1}),
                                  (0.15, {'order': 'CABD', 'group': 2})])
        self.assertEqual(fixture.run_wait()['group'], 2)
        self.assertGreaterEqual(fixture.now, 0.35)


if __name__ == '__main__':
    unittest.main()
