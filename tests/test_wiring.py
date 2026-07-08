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

    def test_custom_placeholder(self):
        out = wiring.build(_config({"id": "c", "hw_type": "custom_xyz"}), "c")
        self.assertFalse(out["supported"])
        self.assertIsNone(out["layout"])
        self.assertTrue(out["notes"])

    def test_wroom_layout_flag(self):
        out = wiring.build(_config(_wroom_box()), "box_w")
        self.assertEqual(out["layout"], "pinout")
        self.assertEqual(out["groups"], [])

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


def _gc_box():
    return {
        "id": "box_g",
        "label": "G",
        "name": "GardenControl-Box",
        "hw_type": "gardencontrol",
        "outputs": [
            {"id": "o1", "type": "valve", "name": "Tomaten", "channel": "5"},
            {"id": "o2", "type": "pump", "name": "Eheim Pumpe", "channel": "R1"},
            {"id": "o3", "type": "other", "name": "Springbrunnen", "channel": "R2"},
        ],
        "inputs": [
            {"id": "i1", "kind": "pressure", "name": "Zisterne Pegel", "pin": "IN1"},
            {"id": "i2", "kind": "rain", "name": "RainClik", "pin": "GPIO14"},
            {"id": "i3", "kind": "soil_moisture", "name": "Beet", "pin": "GPIO33"},
        ],
    }


class GardenControlTest(unittest.TestCase):
    def setUp(self):
        self.out = wiring.build(_config(_gc_box()), "box_g")

    def _terminals(self):
        g = self.out["grid"]
        return {c["label"]: c for col in g.values() for c in col if c["label"]}

    def test_supported_terminal_layout(self):
        self.assertTrue(self.out["supported"])
        self.assertEqual(self.out["layout"], "terminals")
        self.assertEqual(self.out["pins"], [])
        self.assertTrue(self.out["notes"])

    def test_grid_inventory(self):
        labels = list(self._terminals())
        for n in range(1, 13):
            self.assertIn(f"V{n}", labels)  # board silkscreen: valves are V1–V12
        for lbl in ("R1", "R2", "IN1", "IN2", "BIN1", "BIN2", "BIN3",
                    "ADC1", "ADC2", "ADC3", "ADC4", "VCC", "COM", "24VAC", "GND"):
            self.assertIn(lbl, labels)
        # the three label rows of the real board
        g = self.out["grid"]
        self.assertEqual(len(g["top_upper"]), 12)
        self.assertEqual(len(g["top_lower"]), 12)
        self.assertEqual(len(g["bottom"]), 12)

    def test_valve_on_v_terminal_with_short_id(self):
        t = self._terminals()["V5"]
        self.assertEqual(t["assignment"]["name"], "Tomaten")
        self.assertEqual(t["assignment"]["role"], "valve")
        self.assertEqual(t["assignment"]["short_id"], "G5")  # label G + channel 5

    def test_pump_and_other_on_relais(self):
        terms = self._terminals()
        self.assertEqual(terms["R1"]["assignment"]["name"], "Eheim Pumpe")
        self.assertEqual(terms["R1"]["assignment"]["short_id"], "GR1")
        self.assertEqual(terms["R2"]["assignment"]["name"], "Springbrunnen")

    def test_inputs_on_terminals_by_pin(self):
        terms = self._terminals()
        self.assertEqual(terms["IN1"]["assignment"]["name"], "Zisterne Pegel")
        self.assertEqual(terms["BIN1"]["assignment"]["name"], "RainClik")       # GPIO14 → BIN1
        self.assertEqual(terms["ADC2"]["assignment"]["name"], "Beet")           # GPIO33 → ADC2
        self.assertEqual(terms["IN1"]["assignment"]["role"], "sensor")

    def test_legacy_ads_channel_pin_folds_to_terminal(self):
        # Un-migrated config: pin "A0" was always *displayed* as IN1 → keep it there.
        box = _gc_box()
        box["inputs"] = [{"id": "i1", "kind": "pressure", "name": "Alt-Pegel", "pin": "A0"}]
        out = wiring.build(_config(box), "box_g")
        terms = {c["label"]: c for col in out["grid"].values() for c in col if c["label"]}
        self.assertEqual(terms["IN1"]["assignment"]["name"], "Alt-Pegel")
        self.assertIsNone(terms["IN2"]["assignment"])

    def test_power_terminals_never_assigned(self):
        terms = self._terminals()
        for lbl in ("VCC", "COM", "24VAC", "GND", "+24V", "+12V", "+5V"):
            self.assertTrue(terms[lbl]["power"])
            self.assertIsNone(terms[lbl]["assignment"])

    def test_unassigned_terminals_empty(self):
        terms = self._terminals()
        self.assertIsNone(terms["V1"]["assignment"])
        self.assertIsNone(terms["IN2"]["assignment"])

    def test_devices_list_only_assigned(self):
        names = {d["name"] for d in self.out["devices"]}
        self.assertEqual(names, {"Tomaten", "Eheim Pumpe", "Springbrunnen",
                                 "Zisterne Pegel", "RainClik", "Beet"})

    def test_in_supply_pads_carry_silkscreen_vcc(self):
        # The board silkscreen prints "VCC" next to IN1/IN2 — only the vendor's
        # *connection drawing* annotates them functionally as "24V". The lens shows
        # silkscreen labels; the 24 V DC function lives in the cell's `fn` text.
        top = self.out["grid"]["top_upper"]
        self.assertEqual([c["label"] for c in top][:4], ["IN1", "VCC", "IN2", "VCC"])
        self.assertIn("24 V DC", top[1]["fn"])

    def test_device_return_pairing(self):
        by_name = {d["name"]: d for d in self.out["devices"]}
        self.assertEqual(by_name["Tomaten"]["ret"], "COM")          # valve → COM
        # Relay coils return to COM exactly like a valve (vendor AnschlussRelais
        # diagram): COM is one transformer pole, the board switches the other onto Rn.
        # 24VAC is the feed-in, never a load return.
        self.assertEqual(by_name["Eheim Pumpe"]["ret"], "COM")
        self.assertEqual(by_name["Springbrunnen"]["ret"], "COM")
        self.assertEqual(by_name["Zisterne Pegel"]["ret"], "VCC")   # 4-20 mA IN → VCC supply
        self.assertEqual(by_name["Beet"]["ret"], "GND")             # 0-12 V ADC → GND
        self.assertEqual(by_name["RainClik"]["ret"], "")            # binary → no drawn return

    def test_active_rails(self):
        terms = self._terminals()
        # box has a valve, relays and an ADC sensor → those rails are active…
        self.assertEqual(terms["COM"]["rail"], "com")
        self.assertTrue(terms["COM"]["active"])
        self.assertTrue(terms["GND"]["active"])
        # …and IN1 is used, IN2 is not → only IN1's supply pad is active
        self.assertTrue(self.out["grid"]["top_upper"][1]["active"])
        self.assertFalse(self.out["grid"]["top_upper"][3]["active"])

    def test_24vac_is_feed_in_not_a_rail(self):
        # 24VAC must never be emphasised as a return rail — wiring a coil there is wrong.
        terms = self._terminals()
        self.assertNotIn("rail", terms["24VAC"])
        self.assertTrue(terms["24VAC"]["power"])

    def test_relay_only_box_activates_com_rail(self):
        box = _gc_box()
        box["outputs"] = [{"id": "o2", "type": "pump", "name": "Eheim Pumpe", "channel": "R1"}]
        out = wiring.build(_config(box), "box_g")
        terms = {c["label"]: c for col in out["grid"].values() for c in col if c["label"]}
        self.assertTrue(terms["COM"]["active"])  # coil returns to COM → rail in use

    def test_rails_inactive_without_users(self):
        box = _gc_box()
        box["outputs"] = []   # no valves/relays
        box["inputs"] = []    # no ADC/IN
        out = wiring.build(_config(box), "box_g")
        terms = {c["label"]: c for col in out["grid"].values() for c in col if c["label"]}
        self.assertFalse(terms["COM"]["active"])
        self.assertFalse(terms["GND"]["active"])


if __name__ == "__main__":
    unittest.main()
