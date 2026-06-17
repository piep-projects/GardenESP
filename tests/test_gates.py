"""Unit tests for the pure gate evaluation (FDS FR-A1, FR-R1, FR-D5)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import gates


def ev(**kw):
    base = dict(
        manual=False,
        automatic=True,
        sensor_blocking=False,
        sensor_override=False,
        level_ok=True,
    )
    base.update(kw)
    return gates.evaluate_gates(**base)


class TestGates(unittest.TestCase):
    def test_scheduled_all_clear_proceeds(self):
        self.assertEqual(ev(), gates.PROCEED)

    def test_scheduled_automatic_off(self):
        self.assertEqual(ev(automatic=False), gates.AUTOMATIC_OFF)

    def test_manual_bypasses_automatic_gate(self):
        self.assertEqual(ev(manual=True, automatic=False), gates.PROCEED)

    def test_level_blocks_even_manual(self):
        self.assertEqual(ev(manual=True, level_ok=False), gates.SKIPPED_LEVEL)

    def test_sensor_blocks_without_override(self):
        self.assertEqual(ev(sensor_blocking=True), gates.SKIPPED_SENSOR)

    def test_manual_bypasses_sensor(self):
        # Manual draw ignores the blocking sensor outright (no override needed).
        self.assertEqual(ev(manual=True, sensor_blocking=True), gates.PROCEED)

    def test_sensor_override_proceeds(self):
        self.assertEqual(ev(sensor_blocking=True, sensor_override=True), gates.PROCEED)

    def test_level_checked_before_sensor(self):
        # Both bad → level wins (hard safety first).
        self.assertEqual(
            ev(level_ok=False, sensor_blocking=True), gates.SKIPPED_LEVEL
        )


if __name__ == "__main__":
    unittest.main()
