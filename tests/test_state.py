"""Unit tests for the pure state interpretation (FDS §5.7/§5.8)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import state


class TestRain(unittest.TestCase):
    # FP-0001: the gate trusts the (firmware-normalised) entity — on=wet=blocking,
    # off=dry=free — and must NOT re-invert. Wiring polarity lives in the YAML pin.
    def test_on_is_wet_blocks(self):
        self.assertTrue(state.rain_is_blocking("on"))
        self.assertTrue(state.rain_is_blocking("nass"))

    def test_off_is_dry_allows(self):
        self.assertFalse(state.rain_is_blocking("off"))


class TestSoil(unittest.TestCase):
    def test_at_or_above_threshold_blocks(self):
        self.assertTrue(state.soil_is_blocking(40, 40))
        self.assertTrue(state.soil_is_blocking(55.5, 40))

    def test_below_threshold_ok(self):
        self.assertFalse(state.soil_is_blocking(28, 40))

    def test_unparsable_does_not_block(self):
        self.assertFalse(state.soil_is_blocking("unknown", 40))


class TestLevel(unittest.TestCase):
    def test_above_minimum_ok(self):
        self.assertTrue(state.level_ok(820, 1000, 10))

    def test_below_minimum_blocks(self):
        self.assertFalse(state.level_ok(80, 1000, 10))

    def test_disabled_when_no_threshold(self):
        self.assertTrue(state.level_ok(0, 1000, 0))

    def test_unknown_level_does_not_block(self):
        self.assertTrue(state.level_ok(None, 1000, 10))


if __name__ == "__main__":
    unittest.main()
