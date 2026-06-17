"""Unit tests for the pure level/consumption maths (FDS FR-S5a, FR-L1/L2)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import calc


class TestLevel(unittest.TestCase):
    def test_linear(self):
        self.assertEqual(calc.liters_from_pressure(100, 2, 10), 210.0)

    def test_clamped_to_max(self):
        self.assertEqual(calc.liters_from_pressure(100, 2, 10, max_volume_l=200), 200.0)

    def test_negative_clamped_to_zero(self):
        self.assertEqual(calc.liters_from_pressure(0, 1, -50), 0.0)


class TestTwoPoint(unittest.TestCase):
    def test_reproduces_points(self):
        p1, l1, p2, l2 = 162.0, 820.0, 1180.0, 600.0
        mult, offset = calc.calibrate_two_point(p1, l1, p2, l2)
        self.assertAlmostEqual(calc.liters_from_pressure(p1, mult, offset), 820.0, places=3)
        self.assertAlmostEqual(calc.liters_from_pressure(p2, mult, offset), 600.0, places=3)

    def test_equal_pressures_raises(self):
        with self.assertRaises(ValueError):
            calc.calibrate_two_point(100, 1, 100, 2)


class TestLevelTable(unittest.TestCase):
    # Non-linear cistern (widens with height): liters/raw rises from ~20 to ~52.
    PTS = [
        {"raw": 4, "liters": 80}, {"raw": 20, "liters": 600},
        {"raw": 60, "liters": 3000}, {"raw": 95.5, "liters": 4980},
    ]

    def test_reproduces_points(self):
        for p in self.PTS:
            self.assertAlmostEqual(
                calc.liters_from_table(p["raw"], self.PTS), float(p["liters"]), places=6
            )

    def test_interpolates_between(self):
        # Midpoint of segment 20→60 (600..3000): raw 40 → 1800.
        self.assertAlmostEqual(calc.liters_from_table(40, self.PTS), 1800.0, places=6)

    def test_clamps_below_first_point(self):
        self.assertEqual(calc.liters_from_table(0, self.PTS), 80.0)

    def test_clamps_above_last_point(self):
        self.assertEqual(calc.liters_from_table(120, self.PTS), 4980.0)

    def test_clamped_to_max_volume(self):
        self.assertEqual(calc.liters_from_table(60, self.PTS, max_volume_l=2000), 2000.0)

    def test_unsorted_input(self):
        pts = [{"raw": 20, "liters": 600}, {"raw": 4, "liters": 80}]
        self.assertAlmostEqual(calc.liters_from_table(12, pts), 340.0, places=6)

    def test_two_points_is_linear(self):
        pts = [{"raw": 0, "liters": 0}, {"raw": 100, "liters": 1000}]
        self.assertAlmostEqual(calc.liters_from_table(30, pts), 300.0, places=6)

    def test_inverted_sensor(self):  # top-down: liters fall as raw rises
        pts = [{"raw": 10, "liters": 1000}, {"raw": 90, "liters": 0}]
        self.assertAlmostEqual(calc.liters_from_table(50, pts), 500.0, places=6)

    def test_tuple_points(self):
        self.assertAlmostEqual(calc.liters_from_table(40, [(20, 600), (60, 3000)]), 1800.0, places=6)

    def test_fewer_than_two_points_returns_none(self):
        self.assertIsNone(calc.liters_from_table(50, []))
        self.assertIsNone(calc.liters_from_table(50, [{"raw": 4, "liters": 80}]))

    def test_skips_malformed_points(self):
        pts = [{"raw": 0, "liters": 0}, {"bogus": 1}, {"raw": 100, "liters": 1000}]
        self.assertAlmostEqual(calc.liters_from_table(30, pts), 300.0, places=6)

    def test_duplicate_raw_no_div_by_zero(self):
        pts = [{"raw": 10, "liters": 100}, {"raw": 10, "liters": 200}, {"raw": 20, "liters": 400}]
        self.assertEqual(calc.liters_from_table(10, pts), 100.0)  # clamps to first endpoint


class TestPercent(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(calc.percent(820, 1000), 82.0)

    def test_no_capacity(self):
        self.assertIsNone(calc.percent(820, 0))

    def test_clamped(self):
        self.assertEqual(calc.percent(1200, 1000), 100.0)


class TestConsumption(unittest.TestCase):
    def test_delta(self):
        self.assertEqual(calc.consumption(820, 800), 20)

    def test_non_negative(self):
        self.assertEqual(calc.consumption(800, 820), 0)

    def test_rounds(self):
        self.assertEqual(calc.consumption(820.4, 800.0), 20)


class TestRunConsumption(unittest.TestCase):
    """Signed per source type — CR-0003."""

    def test_cistern_level_drops(self):
        # Cistern: start > end → consumed = start − end.
        self.assertEqual(calc.run_consumption(820, 800, is_cistern=True), 20)

    def test_cistern_rise_is_zero(self):
        self.assertEqual(calc.run_consumption(800, 820, is_cistern=True), 0)

    def test_mains_meter_rises(self):
        # Mains/metered: end > start → consumed = end − start.
        self.assertEqual(calc.run_consumption(800, 820, is_cistern=False), 20)

    def test_mains_drop_is_zero(self):
        self.assertEqual(calc.run_consumption(820, 800, is_cistern=False), 0)

    def test_missing_reading_is_none(self):
        self.assertIsNone(calc.run_consumption(None, 800, is_cistern=True))
        self.assertIsNone(calc.run_consumption(800, None, is_cistern=False))


class TestCounterAt(unittest.TestCase):
    """Boot-counter value as of a boundary — FR-S13."""

    def test_empty(self):
        self.assertIsNone(calc.counter_at([], 10))

    def test_last_value_at_or_before(self):
        samples = [(1, 5.0), (4, 6.0), (9, 8.0)]
        self.assertEqual(calc.counter_at(samples, 4), 6.0)
        self.assertEqual(calc.counter_at(samples, 5), 6.0)
        self.assertEqual(calc.counter_at(samples, 100), 8.0)

    def test_only_after_boundary_uses_earliest(self):
        # Device only started after t → earliest value is the baseline (no negatives).
        samples = [(10, 3.0), (20, 4.0)]
        self.assertEqual(calc.counter_at(samples, 5), 3.0)

    def test_unordered_input(self):
        self.assertEqual(calc.counter_at([(9, 8.0), (1, 5.0), (4, 6.0)], 4), 6.0)


class TestRestartCounts(unittest.TestCase):
    """Restarts today/yesterday from a cumulative counter — FR-S13."""

    def test_basic(self):
        # current 10, today-start 7, yesterday-start 5 → today 3, yesterday 2.
        self.assertEqual(calc.restart_counts(10, 7, 5), (3, 2))

    def test_no_reboots(self):
        self.assertEqual(calc.restart_counts(7, 7, 7), (0, 0))

    def test_counter_reset_clamps_today_to_zero(self):
        # Reflash reset the counter below today's baseline → today clamps to 0
        # (no negative); yesterday stays the pre-reset baseline delta (9−5).
        self.assertEqual(calc.restart_counts(2, 9, 5), (0, 4))

    def test_missing_inputs_are_none(self):
        self.assertEqual(calc.restart_counts(None, 7, 5), (None, 2))
        self.assertEqual(calc.restart_counts(10, None, 5), (None, None))
        self.assertEqual(calc.restart_counts(10, 7, None), (3, None))

    def test_rounds_floats(self):
        self.assertEqual(calc.restart_counts(10.0, 7.0, 5.0), (3, 2))


if __name__ == "__main__":
    unittest.main()
