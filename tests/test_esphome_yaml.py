"""Unit tests for the pure ESPHome-YAML generator (FDS §5.4 / FR-S7a)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import esphome_yaml as gen


def _box(**over):
    base = {
        "id": "box_abc",
        "name": "Box A — Gewächshaus",
        "hw_type": "gardencontrol",
        "host": "garden-a.local",
        "outputs": [],
        "inputs": [],
    }
    base.update(over)
    return base


class TestHeaderAndValidation(unittest.TestCase):
    def test_unknown_hw_type_raises(self):
        with self.assertRaises(gen.YamlGenError):
            gen.generate_box_yaml(_box(hw_type="nope"))

    def test_device_name_is_hyphenated_lowercase(self):
        yaml = gen.generate_box_yaml(_box(name="Box A Greenhouse"))
        self.assertIn("device_name: box-a-greenhouse", yaml)
        self.assertNotIn("_", yaml.split("device_name: ")[1].split("\n")[0])
        self.assertTrue(yaml.endswith("\n"))

    def test_device_name_from_label_is_branded(self):
        # With a box label the device name is gardenesp-box-<label> (stable/branded),
        # independent of the free-text box name → entity_ids like switch.gardenesp_box_c_*.
        yaml = gen.generate_box_yaml(_box(name="Testbox", label="C"))
        self.assertIn("device_name: gardenesp-box-c", yaml)
        self.assertNotIn("device_name: testbox", yaml)

    def test_friendly_name_prefixed_with_box_label(self):
        # GardenESP prefix + Kürzel only → entity_ids become gardenesp_box_a_*
        # (descriptive name intentionally dropped from the prefix).
        yaml = gen.generate_box_yaml(_box(name="Schreibtisch Test", label="A"))
        self.assertIn('friendly_name: "GardenESP Box A"', yaml)

    def test_friendly_name_without_label_is_plain(self):
        yaml = gen.generate_box_yaml(_box(name="Schreibtisch Test"))
        self.assertIn('friendly_name: "GardenESP Schreibtisch Test"', yaml)

    def test_header_present(self):
        yaml = gen.generate_box_yaml(_box())
        for needle in ("esphome:", "esp32:", "api:", "ota:", "wifi:", "captive_portal:"):
            self.assertIn(needle, yaml)


class TestAsciiFold(unittest.TestCase):
    def test_umlauts_folded(self):
        self.assertEqual(gen.ascii_fold("Größere"), "Groessere")

    def test_unicode_slash_folded_to_ascii(self):
        # HA/ESPHome rewrite "/" in an entity name to FRACTION SLASH (U+2044);
        # folding both forms to a plain "/" lets the resolver name-match succeed.
        self.assertEqual(gen.ascii_fold("Vierfach Ventil 1⁄4"), "Vierfach Ventil 1/4")
        self.assertEqual(
            gen.ascii_fold("Vierfach Ventil 1⁄4"),
            gen.ascii_fold("Vierfach Ventil 1/4"),
        )


class TestGardenControl(unittest.TestCase):
    """GardenControl = fixed board template (matches the FH-Engineering firmware)."""

    def test_board_skeleton(self):
        yaml = gen.generate_box_yaml(_box())
        for needle in (
            "i2c:", "mcp23017_top", "mcp23017_bot", "pcf8575", "ads1115:",
            "24V 4-20mA CH1 enable", "switch.turn_on: gc_pwr_led",
            "id: gc_status_led", "id: gc_error_led",
        ):
            self.assertIn(needle, yaml)

    def test_all_valve_and_relay_pins_present(self):
        yaml = gen.generate_box_yaml(_box())
        for n in (0, 1, 11, 12, 13):  # 12 valves (0-11) + 2 relais (12,13)
            self.assertIn(f"number: {n}\n", yaml)

    def test_valve_name_and_led_by_channel(self):
        box = _box(outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "channel": "5"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn('name: "Beeren"', yaml)
        self.assertIn("switch.turn_on: gc_led_valve_5", yaml)  # PCF8575 LED feedback

    def test_umlauts_folded_to_ascii_in_name(self):
        # Umlauts/ß in the emitted name → ESPHome derives a clean object_id
        # (switch.gardenesp_box_a_groessere_entnahme), not one with dropped bytes.
        box = _box(outputs=[{"id": "v1", "type": "valve", "name": "Größere Entnahme", "channel": "5"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn('name: "Groessere Entnahme"', yaml)
        self.assertNotIn("Größere", yaml)

    def test_pump_channel_maps_to_relay_pin(self):
        box = _box(outputs=[{"id": "p1", "type": "pump", "name": "Pumpe", "channel": "R2"}])
        self.assertIn("number: 13", gen.generate_box_yaml(box))

    def test_pressure_on_ads_with_name_and_gain(self):
        box = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "A1"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("multiplexer: A1_GND", yaml)
        self.assertIn('name: "Zisterne"', yaml)
        self.assertIn("gain: 2.048", yaml)

    def test_adc_scaling(self):
        yaml = gen.generate_box_yaml(_box())
        self.assertIn("attenuation: 11db", yaml)
        self.assertIn("multiply: 4", yaml)

    def test_binary_inputs_default_to_binary_sensor(self):
        # No input assigned → all 3 BIN are binary_sensors, no pulse counter.
        yaml = gen.generate_box_yaml(_box())
        self.assertIn("number: GPIO14, inverted: true", yaml)
        self.assertIn("delayed_on: 10ms", yaml)
        self.assertNotIn("platform: pulse_counter", yaml)

    def test_s0_pulse_only_when_assigned(self):
        # Assigning a pulse-meter to a BIN pin turns it into a pulse_counter + service.
        box = _box(inputs=[{"id": "i1", "kind": "pulse_meter", "name": "Strom", "pin": "GPIO17"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("platform: pulse_counter", yaml)
        self.assertIn("pin: GPIO17", yaml)
        self.assertIn("set_pulse_total", yaml)  # service present when a counter exists

    def test_gc_pulse_counter_debounced(self):
        # CR-0001: software counter + 4ms filter (PCNT 13µs cap multi-counts ringing).
        box = _box(inputs=[{"id": "i1", "kind": "pulse_meter", "name": "Strom", "pin": "GPIO17"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("use_pcnt: false", yaml)
        self.assertIn("internal_filter: 4ms", yaml)
        self.assertIn("update_interval: 10s", yaml)  # CR-0004

    def test_rain_can_use_any_binary_pin(self):
        box = _box(inputs=[{"id": "i1", "kind": "rain", "name": "RainClik", "pin": "GPIO17"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn('name: "RainClik"', yaml)
        self.assertNotIn("set_pulse_total", yaml)  # no S0 → no service

    def test_emergency_shutdown_on_gc_valve(self):
        box = _box(outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "channel": "1", "emergency_shutdown_min": 15}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("script:", yaml)
        self.assertIn("emergency_beeren", yaml)
        self.assertIn("delay: 15min", yaml)


class TestEsp32Wroom(unittest.TestCase):
    def test_outputs_use_direct_gpio(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren"}])
        yaml = gen.generate_box_yaml(box)
        self.assertNotIn("mcp23017", yaml)
        self.assertIn("number: GPIO16", yaml)

    def test_pressure_falls_back_to_adc(self):
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("platform: adc", yaml)
        self.assertNotIn("ads1115", yaml)

    def test_wroom_pressure_has_median_filter(self):
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("median:", yaml)
        self.assertIn("window_size: 5", yaml)

    def test_wroom_humidity_adc_has_no_median_filter(self):
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "soil_moisture", "name": "Beet"}])
        self.assertNotIn("median:", gen.generate_box_yaml(box))

    def test_wroom_pulse_counter_debounced(self):
        # CR-0001: software counter + 4ms filter against edge multi-counting.
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "pulse_meter", "name": "Wasserzaehler"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("platform: pulse_counter", yaml)
        self.assertIn("use_pcnt: false", yaml)
        self.assertIn("internal_filter: 4ms", yaml)
        self.assertIn("update_interval: 10s", yaml)  # CR-0004

    def test_output_pin_exhaustion_raises(self):
        outs = [{"id": f"v{i}", "type": "valve", "name": f"V{i}"} for i in range(9)]
        with self.assertRaises(gen.YamlGenError):
            gen.generate_box_yaml(_box(hw_type="esp32_wroom", outputs=outs))

    def test_explicit_gpio_drives_output(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "gpio": "GPIO23"}])
        self.assertIn("number: GPIO23", gen.generate_box_yaml(box))

    def test_chosen_gpio_for_soil_and_rain(self):
        box = _box(hw_type="esp32_wroom", inputs=[
            {"id": "i1", "kind": "soil_moisture", "name": "Beet", "pin": "GPIO32"},
            {"id": "i2", "kind": "rain", "name": "Regen", "pin": "GPIO27"},
        ])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("pin: GPIO32", yaml)
        self.assertIn("number: GPIO27", yaml)

    def test_duplicate_input_pin_raises(self):
        box = _box(hw_type="esp32_wroom", inputs=[
            {"id": "i1", "kind": "soil_moisture", "name": "A", "pin": "GPIO34"},
            {"id": "i2", "kind": "pressure", "name": "B", "pin": "GPIO34"},
        ])
        with self.assertRaises(gen.YamlGenError):
            gen.generate_box_yaml(box)

    def test_rain_is_binary_sensor_with_device_class(self):
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "rain", "name": "Regen"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("binary_sensor:", yaml)
        self.assertIn("device_class: moisture", yaml)

    def test_rain_pin_not_inverted_by_default(self):
        # FP-0001: gate trusts the entity; wiring polarity lives at the pin.
        box = _box(hw_type="esp32_wroom", inputs=[{"id": "i1", "kind": "rain", "name": "Regen"}])
        self.assertNotIn("inverted: true", gen.generate_box_yaml(box))

    def test_rain_inverted_flag_inverts_the_pin(self):
        box = _box(hw_type="esp32_wroom",
                   inputs=[{"id": "i1", "kind": "rain", "name": "Regen", "inverted": True}])
        self.assertIn("inverted: true", gen.generate_box_yaml(box))


class TestGenericBase(unittest.TestCase):
    def test_custom_platform_uses_generic_base_and_gpio(self):
        box = _box(hw_type="plat_custom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "gpio": "GPIO23"}])
        yaml = gen.generate_box_yaml(box, base="generic")
        self.assertNotIn("mcp23017", yaml)
        self.assertIn("number: GPIO23", yaml)

    def test_generic_input_accepts_free_gpio(self):
        box = _box(hw_type="plat_custom", inputs=[{"id": "i1", "kind": "soil_moisture", "name": "Beet", "pin": "GPIO36"}])
        self.assertIn("pin: GPIO36", gen.generate_box_yaml(box, base="generic"))

    def test_unknown_hw_type_without_base_still_raises(self):
        with self.assertRaises(gen.YamlGenError):
            gen.generate_box_yaml(_box(hw_type="nope"))


class TestPolarityAndEmergency(unittest.TestCase):
    def test_relais_off_high_is_inverted(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "V", "relais_off": "HIGH"}])
        self.assertIn("inverted: true", gen.generate_box_yaml(box))

    def test_relais_off_low_not_inverted(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "V", "relais_off": "LOW"}])
        self.assertNotIn("inverted: true", gen.generate_box_yaml(box))

    def test_emergency_shutdown_emits_script_and_hooks(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "emergency_shutdown_min": 30}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("script:", yaml)
        self.assertIn("emergency_beeren", yaml)
        self.assertIn("delay: 30min", yaml)
        self.assertIn("script.execute: emergency_beeren", yaml)

    def test_no_emergency_when_zero(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "V", "emergency_shutdown_min": 0}])
        self.assertNotIn("script:", gen.generate_box_yaml(box))

    def test_emergency_script_increments_counter_before_cutting(self):
        # CR-0011: the backstop firing must be recorded (NVS counter) before the
        # output is turned off, so it survives WiFi/HA blindness.
        for hw, ch in (("esp32_wroom", None), ("gardencontrol", "1")):
            out = {"id": "v1", "type": "valve", "name": "Beeren", "emergency_shutdown_min": 30}
            if ch:
                out["channel"] = ch
            yaml = gen.generate_box_yaml(_box(hw_type=hw, outputs=[out]))
            self.assertIn("id(emergency_count) += 1;", yaml)
            inc = yaml.index("id(emergency_count) += 1;")
            push = yaml.index("component.update: emergency_total")
            off = yaml.index("switch.turn_off: beeren")
            # increment → instant push → cut, in that order (CR-0011)
            self.assertLess(inc, push, f"{hw}: increment before push")
            self.assertLess(push, off, f"{hw}: push before turn_off")


class TestConnectedDevice(unittest.TestCase):
    """Shared-Pump / ConnectedDevice on-device lambdas (FR-E2). The valve's
    ``pump`` (box-local pump output id) is set by the WS layer from the source."""

    def test_generic_valve_drives_pump(self):
        box = _box(hw_type="esp32_wroom", outputs=[
            {"id": "v1", "type": "valve", "name": "Beeren", "gpio": "GPIO16", "pump": "p1"},
            {"id": "p1", "type": "pump", "name": "Pumpe", "gpio": "GPIO17"},
        ])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("switch.turn_on: pumpe", yaml)
        self.assertIn("switch.turn_off: pumpe", yaml)
        self.assertIn("!id(beeren).state", yaml)

    def test_gardencontrol_valve_drives_pump(self):
        box = _box(outputs=[
            {"id": "v1", "type": "valve", "name": "Beeren", "channel": "5", "pump": "p1"},
            {"id": "p1", "type": "pump", "name": "Pumpe", "channel": "R1"},
        ])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("switch.turn_on: pumpe", yaml)
        self.assertIn("!id(beeren).state", yaml)

    def test_shared_pump_lists_all_sibling_valves(self):
        box = _box(hw_type="esp32_wroom", outputs=[
            {"id": "v1", "type": "valve", "name": "A", "gpio": "GPIO16", "pump": "p1"},
            {"id": "v2", "type": "valve", "name": "B", "gpio": "GPIO18", "pump": "p1"},
            {"id": "p1", "type": "pump", "name": "P", "gpio": "GPIO19"},
        ])
        self.assertIn("!id(a).state && !id(b).state", gen.generate_box_yaml(box))

    def test_no_pump_no_hooks(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "gpio": "GPIO16"}])
        self.assertNotIn("switch.turn_on:", gen.generate_box_yaml(box))


    def test_pump_can_drive_connected_output(self):
        box = _box(hw_type="esp32_wroom", outputs=[
            {"id": "p1", "type": "pump", "name": "Pumpe", "gpio": "GPIO17", "connected": ["v2"]},
            {"id": "v2", "type": "valve", "name": "Vorventil", "gpio": "GPIO16"},
        ])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("switch.turn_on: vorventil", yaml)
        self.assertIn("!id(pumpe).state", yaml)


class TestConfigHashAndProject(unittest.TestCase):
    """Firmware-drift fingerprint + project block (roadmap #9a/#9b)."""

    def test_project_block_emitted_with_hash(self):
        box = _box(name="Box A", label="A")
        yaml = gen.generate_box_yaml(box)
        self.assertIn("project:", yaml)
        self.assertIn(f"name: {gen.PROJECT_NAME}", yaml)
        self.assertIn(f'version: "{gen.box_config_hash(box)}"', yaml)

    def test_hash_excludes_project_line_no_circularity(self):
        # The emitted version equals box_config_hash, which is computed over the
        # YAML *without* the project block — so embedding it isn't circular.
        box = _box(label="A")
        h = gen.box_config_hash(box)
        self.assertNotIn(h, gen._base_yaml(box))  # base has no version line
        self.assertIn(h, gen.generate_box_yaml(box))

    def test_hash_is_stable_and_deterministic(self):
        box = _box(label="A", outputs=[{"id": "v1", "type": "valve", "name": "Beet", "channel": "5"}])
        self.assertEqual(gen.box_config_hash(box), gen.box_config_hash(box))

    def test_hash_changes_on_firmware_relevant_edit(self):
        a = _box(label="A", outputs=[{"id": "v1", "type": "valve", "name": "Beet", "channel": "5"}])
        b = _box(label="A", outputs=[{"id": "v1", "type": "valve", "name": "Beet", "channel": "6"}])
        self.assertNotEqual(gen.box_config_hash(a), gen.box_config_hash(b))

    def test_hash_matches_embedded_version_generic(self):
        box = _box(hw_type="esp32_wroom", label="B",
                   outputs=[{"id": "v1", "type": "valve", "name": "Beet", "gpio": "GPIO16"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn(f'version: "{gen.box_config_hash(box)}"', yaml)


class TestOtherOutput(unittest.TestCase):
    """`other` output type (Steuerung load: fountain/camera) — FR-SW."""

    def test_generic_other_is_a_gpio_switch(self):
        box = _box(hw_type="esp32_wroom", label="B", outputs=[
            {"id": "o1", "type": "other", "name": "Kamera", "gpio": "GPIO23"},
        ])
        y = gen.generate_box_yaml(box)
        self.assertIn('name: "Kamera"', y)
        self.assertIn("number: GPIO23", y)
        self.assertIn("mdi:toggle-switch-variant", y)

    def test_gardencontrol_other_maps_onto_a_relais_channel(self):
        box = _box(hw_type="gardencontrol", label="A", outputs=[
            {"id": "o1", "type": "other", "name": "Springbrunnen", "channel": "R1"},
        ])
        y = gen.generate_box_yaml(box)
        self.assertIn('name: "Springbrunnen"', y)  # took the Relais 1 channel

    def test_gardencontrol_other_emergency_shutdown(self):
        box = _box(hw_type="gardencontrol", label="A", outputs=[
            {"id": "o1", "type": "other", "name": "Brunnen", "channel": "R2",
             "emergency_shutdown_min": 20},
        ])
        y = gen.generate_box_yaml(box)
        self.assertIn("delay: 20min", y)


class TestBoardDiagnostics(unittest.TestCase):
    """WLAN signal + reboot counter in both templates — FR-S13."""

    def _both(self):
        return [
            gen.generate_box_yaml(_box(hw_type="gardencontrol", label="A")),
            gen.generate_box_yaml(_box(hw_type="esp32_wroom", label="B")),
        ]

    def test_wifi_signal_sensor_present(self):
        for y in self._both():
            self.assertIn("platform: wifi_signal", y)
            self.assertIn(f'name: "{gen.DIAG_WIFI_NAME}"', y)

    def test_boot_counter_global_and_sensor(self):
        for y in self._both():
            self.assertIn("globals:", y)
            self.assertIn("id: boot_count", y)
            self.assertIn("restore_value: true", y)
            self.assertIn(f'name: "{gen.DIAG_BOOT_NAME}"', y)
            self.assertIn("return id(boot_count);", y)
            self.assertIn("state_class: total_increasing", y)

    def test_on_boot_increments_counter(self):
        for y in self._both():
            self.assertIn("id(boot_count) += 1;", y)

    def test_single_sensor_block_even_without_inputs(self):
        # Diagnostics must not introduce a duplicate top-level `sensor:` key.
        for y in self._both():
            self.assertEqual(sum(1 for ln in y.splitlines() if ln == "sensor:"), 1)

    def test_generic_with_inputs_keeps_single_sensor_block(self):
        box = _box(hw_type="esp32_wroom", label="B", inputs=[
            {"id": "i1", "kind": "pressure", "name": "Druck", "pin": "A0"},
        ])
        y = gen.generate_box_yaml(box)
        self.assertEqual(sum(1 for ln in y.splitlines() if ln == "sensor:"), 1)
        self.assertIn(f'name: "{gen.DIAG_WIFI_NAME}"', y)

    def test_restart_button_present(self):
        # CR-0008: a remote restart button so the resilience suite can soft-reboot.
        for y in self._both():
            self.assertEqual(sum(1 for ln in y.splitlines() if ln == "button:"), 1)
            self.assertIn("platform: restart", y)
            self.assertIn(f'name: "{gen.DIAG_RESTART_NAME}"', y)

    def test_emergency_counter_global_and_sensor(self):
        # CR-0011: NVS emergency-shutdown counter, reported as a diagnostic sensor
        # with an id so the emergency scripts can push it instantly.
        for y in self._both():
            self.assertIn("id: emergency_count", y)
            self.assertIn("id: emergency_total", y)
            self.assertIn(f'name: "{gen.DIAG_EMERGENCY_NAME}"', y)
            self.assertIn("return id(emergency_count);", y)

    def test_single_globals_block(self):
        # Both counters share one top-level `globals:` key.
        for y in self._both():
            self.assertEqual(sum(1 for ln in y.splitlines() if ln == "globals:"), 1)


if __name__ == "__main__":
    unittest.main()
