"""Unit tests for the pure schedule maths (FDS §4.4 / FR-A4)."""

from __future__ import annotations

import unittest
from datetime import datetime
from types import SimpleNamespace

import _path  # noqa: F401  (adds the package dir to sys.path)
import schedule


def entry(repeat, time, duration_min=10, weekdays=None, monthdays=None, enabled=True):
    return SimpleNamespace(
        repeat=repeat, time=time, duration_min=duration_min,
        weekdays=weekdays or [], monthdays=monthdays or [], enabled=enabled,
    )


# Wednesday 2026-06-03 12:00
NOW = datetime(2026, 6, 3, 12, 0)


class TestParse(unittest.TestCase):
    def test_parse_hhmm(self):
        self.assertEqual(schedule.parse_hhmm("05:00"), (5, 0))
        self.assertEqual(schedule.parse_hhmm("18:45"), (18, 45))


class TestDaily(unittest.TestCase):
    def test_passed_time_rolls_to_tomorrow(self):
        nxt = schedule.next_occurrence("daily", ["05:00"], None, None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 4, 5, 0))

    def test_upcoming_time_today(self):
        nxt = schedule.next_occurrence("daily", ["18:00"], None, None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 3, 18, 0))

    def test_multiple_times_picks_earliest_upcoming(self):
        nxt = schedule.next_occurrence("daily", ["05:00", "18:00"], None, None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 3, 18, 0))

    def test_no_times_returns_none(self):
        self.assertIsNone(schedule.next_occurrence("daily", [], None, None, NOW))


class TestWeekly(unittest.TestCase):
    def test_next_matching_weekday(self):
        nxt = schedule.next_occurrence("weekly", ["05:00"], ["fr"], None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 5, 5, 0))  # Fri

    def test_today_if_weekday_matches_and_time_upcoming(self):
        nxt = schedule.next_occurrence("weekly", ["18:00"], ["we"], None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 3, 18, 0))

    def test_same_weekday_next_week_if_time_passed(self):
        nxt = schedule.next_occurrence("weekly", ["05:00"], ["we"], None, NOW)
        self.assertEqual(nxt, datetime(2026, 6, 10, 5, 0))


class TestMonthly(unittest.TestCase):
    def test_this_month_day(self):
        nxt = schedule.next_occurrence("monthly", ["05:00"], None, [15], NOW)
        self.assertEqual(nxt, datetime(2026, 6, 15, 5, 0))

    def test_next_month_if_day_passed(self):
        nxt = schedule.next_occurrence("monthly", ["05:00"], None, [1], NOW)
        self.assertEqual(nxt, datetime(2026, 7, 1, 5, 0))

    def test_skips_months_without_day_31(self):
        # June has 30 days → next 31st is in July.
        nxt = schedule.next_occurrence("monthly", ["05:00"], None, [31], NOW)
        self.assertEqual(nxt, datetime(2026, 7, 31, 5, 0))


class TestNextRunForSchedule(unittest.TestCase):
    def test_min_across_entries_returns_dt_and_duration(self):
        entries = [entry("daily", "18:00", duration_min=20), entry("daily", "06:00", duration_min=5)]
        # 18:00 today vs 06:00 tomorrow → today 18:00, with that entry's duration (20)
        result = schedule.next_run_for_schedule(entries, NOW)
        self.assertEqual(result, (datetime(2026, 6, 3, 18, 0), 20))

    def test_empty_returns_none(self):
        self.assertIsNone(schedule.next_run_for_schedule([], NOW))

    def test_disabled_entry_is_skipped(self):
        # The earlier 06:00 entry is disabled → the 18:00 entry wins (FR-S2a).
        entries = [
            entry("daily", "06:00", duration_min=5, enabled=False),
            entry("daily", "18:00", duration_min=20),
        ]
        result = schedule.next_run_for_schedule(entries, NOW)
        self.assertEqual(result, (datetime(2026, 6, 3, 18, 0), 20))

    def test_all_disabled_returns_none(self):
        entries = [entry("daily", "06:00", enabled=False)]
        self.assertIsNone(schedule.next_run_for_schedule(entries, NOW))

    def test_entry_without_enabled_attr_still_fires(self):
        # Back-compat: entries predating the `enabled` flag default to enabled.
        legacy = SimpleNamespace(repeat="daily", time="18:00", duration_min=10,
                                 weekdays=[], monthdays=[])
        result = schedule.next_run_for_schedule([legacy], NOW)
        self.assertEqual(result, (datetime(2026, 6, 3, 18, 0), 10))


if __name__ == "__main__":
    unittest.main()
