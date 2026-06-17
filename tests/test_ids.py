"""Unit tests for the pure id helper (FDS §9.1)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import ids


class TestIds(unittest.TestCase):
    def test_prefix_per_kind(self):
        self.assertTrue(ids.new_id("box").startswith("box_"))
        self.assertTrue(ids.new_id("line").startswith("ln_"))
        self.assertTrue(ids.new_id("source").startswith("src_"))

    def test_unique(self):
        self.assertNotEqual(ids.new_id("line"), ids.new_id("line"))

    def test_unknown_kind_raises(self):
        with self.assertRaises(KeyError):
            ids.new_id("nope")


class TestNextLineSeq(unittest.TestCase):
    def test_first_line_is_one(self):
        self.assertEqual(ids.next_line_seq([]), 1)
        self.assertEqual(ids.next_line_seq([0, 0]), 1)  # only switches so far

    def test_monotonic_after_max(self):
        self.assertEqual(ids.next_line_seq([1, 2, 3]), 4)

    def test_does_not_reuse_gaps(self):
        # L2 deleted → next is still max+1, never the freed 2 (stable ids).
        self.assertEqual(ids.next_line_seq([1, 3]), 4)

    def test_ignores_zero_switch_entries(self):
        self.assertEqual(ids.next_line_seq([0, 1, 0, 2]), 3)


if __name__ == "__main__":
    unittest.main()
