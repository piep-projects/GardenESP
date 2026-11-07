"""Reboot-banner acknowledgement (roadmap #20 follow-up): an ack hides the
banner for exactly the boot it was given for."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import calc

WD = "Interrupt watchdog"


class RebootAckTest(unittest.TestCase):
    def test_no_reason_nothing_to_ack(self):
        self.assertIsNone(calc.reboot_ack_token(31, None))
        self.assertIsNone(calc.reboot_ack_token(31, ""))
        self.assertFalse(calc.reboot_acked(None, 31, None))

    def test_token_rounds_counter(self):
        self.assertEqual(calc.reboot_ack_token(31.0, WD), {"boot": 31, "reason": WD})

    def test_ack_matches_same_boot(self):
        ack = calc.reboot_ack_token(31.0, WD)
        self.assertTrue(calc.reboot_acked(ack, 31.0, WD))

    def test_reconnect_keeps_ack(self):
        # ESPHome re-reports the reason on reconnect; the counter stays → still acked
        ack = calc.reboot_ack_token(31.0, WD)
        self.assertTrue(calc.reboot_acked(ack, 31, WD))

    def test_new_boot_shows_again(self):
        ack = calc.reboot_ack_token(31.0, WD)
        self.assertFalse(calc.reboot_acked(ack, 32.0, WD))

    def test_other_reason_shows_again(self):
        ack = calc.reboot_ack_token(31.0, WD)
        self.assertFalse(calc.reboot_acked(ack, 31.0, "Brownout"))

    def test_no_ack_stored(self):
        self.assertFalse(calc.reboot_acked(None, 31.0, WD))

    def test_unknown_counter_falls_back_to_reason(self):
        ack = calc.reboot_ack_token(None, WD)
        self.assertTrue(calc.reboot_acked(ack, None, WD))
        self.assertFalse(calc.reboot_acked(ack, 31.0, WD))


if __name__ == "__main__":
    unittest.main()
