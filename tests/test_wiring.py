"""Unit tests for the pure wiring lens (Verdrahtungs-Hilfe, Phase 1 WROOM)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import wiring


def _wroom_box():
    return {
        "id": "box_w",
        "label": "W",
        "name": "WROOM-Box",
        "hw_type": "esp32_wroom",
        "outputs": [
            {"id": "o1", "type": "valve", "name": "Tomaten", "channel": "2", "gpio": "GPIO16"},
            {"id": "o2", "type": "pump", "name": "Pumpe", "channel": "7", "gpio": "19"},
            {"id": "o3", "type": "valve", "name": "Ohne GPIO", "channel": ""},  # order fallback
        ],
        "inputs": [
            {"id": "i1", "kind": "pressure", "name": "Drucksensor", "pin": "GPIO34"},
            {"id": "i2", "kind": "rain", "name": "RainClik"},  # pool fallback → GPIO26
        ],
    }


def _config(box):
    return {"boxes": {box["id"]: box}}


class PinoutIntegrityTest(unittest.TestCase):
    def test_38_pins_19_per_side(self):
        pads = wiring.WROOM_DEVKITC_38
        self.assertEqual(len(pads), 38)
        self.assertEqual(sum(1 for p in pads if p["side"] == "left"), 19)
        self.assertEqual(sum(1 for p in pads if p["side"] == "right"), 19)
        for side in ("left", "right"):
            nums = sorted(p["pin"] for p in pads if p["side"] == side)
            self.assertEqual(nums, list(range(1, 20)))

    def test_gpio_numbers_unique(self):
        gpios = [p["gpio"] for p in wiring.WROOM_DEVKITC_38 if p["gpio"] is not None]
        self.assertEqual(len(gpios), len(set(gpios)))

    def test_flash_pins_forbidden(self):
        for p in wiring.WROOM_DEVKITC_38:
            if p["gpio"] in (6, 7, 8, 9, 10, 11):
                self.assertEqual(p["cap"], wiring.CAP_FORBIDDEN)

    def test_input_only_pins(self):
        for p in wiring.WROOM_DEVKITC_38:
            if p["gpio"] in (34, 35, 36, 39):
                self.assertEqual(p["cap"], wiring.CAP_INPUT_ONLY)

    def test_strapping_pins(self):
        strapping = {p["gpio"] for p in wiring.WROOM_DEVKITC_38 if p["cap"] == wiring.CAP_STRAPPING}
        self.assertEqual(strapping, {0, 2, 5, 12, 15})

    def test_uart_pins(self):
        # TX0/RX0 carry the serial console (logger drives the pin + boot glitches) —
        # flagged as a caveat, not plain IO (and omitted from the panel GPIO dropdown).
        uart = {p["gpio"] for p in wiring.WROOM_DEVKITC_38 if p["cap"] == wiring.CAP_UART}
        self.assertEqual(uart, {1, 3})


class BuildTest(unittest.TestCase):
    def test_unknown_box(self):
        out = wiring.build({"boxes": {}}, "nope")
        self.assertFalse(out["supported"])
        self.assertIsNone(out["box"])

    def test_gardencontrol_placeholder(self):
        out = wiring.build(_config({"id": "g", "hw_type": "gardencontrol"}), "g")
        self.assertFalse(out["supported"])
        self.assertEqual(out["box"]["hw_type"], "gardencontrol")
        self.assertTrue(out["notes"])
        self.assertEqual(out["pins"], [])

    def test_custom_placeholder(self):
        out = wiring.build(_config({"id": "c", "hw_type": "custom_xyz"}), "c")
        self.assertFalse(out["supported"])
        self.assertTrue(out["notes"])

    def test_assignment_on_correct_pad(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        self.assertTrue(out["supported"])
        by_gpio = {p["gpio"]: p for p in out["pins"]}
        self.assertEqual(by_gpio[16]["assignment"]["name"], "Tomaten")
        self.assertEqual(by_gpio[16]["assignment"]["role"], "valve")
        self.assertEqual(by_gpio[19]["assignment"]["name"], "Pumpe")  # "19" normalised
        self.assertEqual(by_gpio[34]["assignment"]["name"], "Drucksensor")
        self.assertEqual(by_gpio[34]["assignment"]["role"], "sensor")

    def test_output_short_id(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        by_name = {d["name"]: d for d in out["devices"]}
        self.assertEqual(by_name["Tomaten"]["short_id"], "W2")  # label W + channel 2
        self.assertEqual(by_name["Pumpe"]["short_id"], "W7")
        self.assertEqual(by_name["Ohne GPIO"]["short_id"], "")  # no channel → no id
        self.assertEqual(by_name["Drucksensor"]["short_id"], "")  # inputs have none

    def test_input_pool_fallback(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        by_gpio = {p["gpio"]: p for p in out["pins"]}
        # rain without explicit pin → first WROOM binary pool slot GPIO26
        self.assertEqual(by_gpio[26]["assignment"]["name"], "RainClik")

    def test_output_order_fallback(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        # "Ohne GPIO" valve (no gpio/channel) → first free output pool slot GPIO16…
        # but GPIO16 is already taken by Tomaten's explicit gpio; the order index is
        # independent of explicit assignments, so slot 0 = GPIO16 is what it picks.
        names = [d["name"] for d in out["devices"]]
        self.assertIn("Ohne GPIO", names)
        fallback = next(d for d in out["devices"] if d["name"] == "Ohne GPIO")
        self.assertEqual(fallback["gpio"], 16)

    def test_gnd_pins_present(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        self.assertTrue(out["gnd_pins"])
        for g in out["gnd_pins"]:
            self.assertIn(g["side"], ("left", "right"))

    def test_devices_cover_all_io(self):
        box = _wroom_box()
        out = wiring.build(_config(box), box["id"])
        self.assertEqual(len(out["devices"]), 5)  # 3 outputs + 2 inputs


if __name__ == "__main__":
    unittest.main()
