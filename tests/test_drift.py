"""Unit tests for the pure firmware-drift status decision (roadmap #9)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import drift


class TestFwStatus(unittest.TestCase):
    def test_no_config_hash_is_error(self):
        self.assertEqual(drift.fw_status(None, "abc", "abc", True), drift.ERROR)
        self.assertEqual(drift.fw_status("", "abc", "abc", True), drift.ERROR)

    def test_flashed_matches_online_is_current(self):
        self.assertEqual(drift.fw_status("abc", "abc", None, True), drift.CURRENT)

    def test_flashed_matches_offline_is_current_offline(self):
        self.assertEqual(drift.fw_status("abc", "abc", None, False), drift.CURRENT_OFFLINE)
        self.assertEqual(drift.fw_status("abc", "abc", None, None), drift.CURRENT_OFFLINE)

    def test_flashed_differs_online_is_drift(self):
        self.assertEqual(drift.fw_status("abc", "xyz", None, True), drift.DRIFT)

    def test_flashed_differs_offline_is_drift_offline(self):
        self.assertEqual(drift.fw_status("abc", "xyz", None, False), drift.DRIFT_OFFLINE)

    def test_no_flashed_export_matches_is_exported(self):
        self.assertEqual(drift.fw_status("abc", None, "abc", None), drift.EXPORTED)

    def test_no_flashed_export_differs_is_drift_export(self):
        self.assertEqual(drift.fw_status("abc", None, "old", None), drift.DRIFT_EXPORT)

    def test_no_flashed_no_export_is_never(self):
        self.assertEqual(drift.fw_status("abc", None, None, None), drift.NEVER)

    def test_attention_set_covers_drift_states(self):
        for s in (drift.DRIFT, drift.DRIFT_OFFLINE, drift.DRIFT_EXPORT):
            self.assertIn(s, drift.ATTENTION)
        for s in (drift.CURRENT, drift.EXPORTED, drift.NEVER):
            self.assertNotIn(s, drift.ATTENTION)


if __name__ == "__main__":
    unittest.main()
