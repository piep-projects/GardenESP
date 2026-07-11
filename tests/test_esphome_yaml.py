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
        # With a box label the device name is gardenesp-steuergeraet-<label>
        # (stable/branded), independent of the free-text box name → entity_ids like
        # switch.gardenesp_steuergeraet_c_*.
        yaml = gen.generate_box_yaml(_box(name="Testbox", label="C"))
        self.assertIn("device_name: gardenesp-steuergeraet-c", yaml)
        self.assertNotIn("device_name: testbox", yaml)

    def test_friendly_name_prefixed_with_box_label(self):
        # GardenESP prefix + Kürzel only → entity_ids become gardenesp_steuergeraet_a_*
        # (descriptive name intentionally dropped from the prefix).
        yaml = gen.generate_box_yaml(_box(name="Schreibtisch Test", label="A"))
        self.assertIn('friendly_name: "GardenESP Steuergerät A"', yaml)

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
    """GardenControl = fixed board template (matches the Smart-MF firmware)."""

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
        # (switch.gardenesp_steuergeraet_a_groessere_entnahme), not one with dropped bytes.
        box = _box(outputs=[{"id": "v1", "type": "valve", "name": "Größere Entnahme", "channel": "5"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn('name: "Groessere Entnahme"', yaml)
        self.assertNotIn("Größere", yaml)

    def test_pump_channel_maps_to_relay_pin(self):
        box = _box(outputs=[{"id": "p1", "type": "pump", "name": "Pumpe", "channel": "R2"}])
        self.assertIn("number: 13", gen.generate_box_yaml(box))

    def test_pressure_on_ads_with_name_and_gain(self):
        box = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("multiplexer: A1_GND", yaml)
        self.assertIn('name: "Zisterne"', yaml)
        self.assertIn("gain: 2.048", yaml)

    def _mux_of(self, yaml, name):
        """The `multiplexer:` of the ads1115 sensor carrying `name`."""
        lines = yaml.splitlines()
        i = lines.index(f'    name: "{name}"')
        for ln in reversed(lines[:i]):
            if ln.startswith("    multiplexer:"):
                return ln.split(":", 1)[1].strip()
        raise AssertionError(f"no multiplexer above {name!r}")

    def test_terminals_map_to_crossed_ads_channels(self):
        # The board crosses them: terminal IN1 sits on ADS A1, IN2 on A0. Verified
        # against the vendor firmware (esp32-gardencontrol.yaml: "4-20mA CH1" = A1_GND).
        # Reading the mux name as if it were the terminal made GardenESP sample the
        # *other* screw than the one the user wired.
        box = _box(inputs=[
            {"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1"},
            {"id": "i2", "kind": "pressure", "name": "Regentonne", "pin": "IN2"},
        ])
        yaml = gen.generate_box_yaml(box)
        self.assertEqual(self._mux_of(yaml, "Zisterne"), "A1_GND")
        self.assertEqual(self._mux_of(yaml, "Regentonne"), "A0_GND")

    def test_legacy_ads_pin_keeps_the_terminal_it_displayed(self):
        # Un-migrated config: "A0" was labelled IN1 in the editor, so the sensor hangs
        # on terminal IN1 → it must now be read from ADS A1.
        box = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "A0"}])
        self.assertEqual(self._mux_of(gen.generate_box_yaml(box), "Zisterne"), "A1_GND")

    def test_unconfigured_terminal_keeps_its_default_name(self):
        box = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN2"}])
        yaml = gen.generate_box_yaml(box)
        self.assertEqual(self._mux_of(yaml, "IN1"), "A1_GND")  # default-named, still A1

    def test_loop_underrange_binsensor_only_for_configured_terminals(self):
        box = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn(f'name: "{gen.DIAG_ERR_LOOP1_LOW_NAME}"', yaml)
        self.assertNotIn(f'name: "{gen.DIAG_ERR_LOOP2_LOW_NAME}"', yaml)  # IN2 empty → no fault
        self.assertIn("id(gc_in1).state < 3.5", yaml)
        self.assertIn("!isnan(id(gc_in1).state)", yaml)

    def test_no_loop_underrange_binsensor_without_inputs(self):
        yaml = gen.generate_box_yaml(_box())
        self.assertNotIn(gen.DIAG_ERR_LOOP1_LOW_NAME, yaml)
        self.assertNotIn(gen.DIAG_ERR_LOOP2_LOW_NAME, yaml)

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

    def test_button_input_is_named_binary_sensor_not_inverted(self):
        # FR-S14: a generic button on a BIN pin → plain binary_sensor with the
        # given name, not forced-inverted like rain, no S0 service.
        box = _box(inputs=[{"id": "i1", "kind": "button", "name": "Taster Terrasse", "pin": "GPIO16"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn('name: "Taster Terrasse"', yaml)
        self.assertIn("number: GPIO16, inverted: false", yaml)
        self.assertNotIn("platform: pulse_counter", yaml)
        self.assertNotIn("set_pulse_total", yaml)

    def test_button_inverted_flag_inverts_the_pin(self):
        box = _box(inputs=[{"id": "i1", "kind": "button", "name": "Taster", "pin": "GPIO16", "inverted": True}])
        self.assertIn("number: GPIO16, inverted: true", gen.generate_box_yaml(box))

    def test_emergency_shutdown_on_gc_valve(self):
        box = _box(outputs=[{"id": "v1", "type": "valve", "name": "Beeren", "channel": "1", "emergency_shutdown_min": 15}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("script:", yaml)
        self.assertIn("emergency_beeren", yaml)
        self.assertIn("delay: 15min", yaml)

    def test_supply_error_inputs_present(self):
        # roadmap #1: 5/12/24 V supply-error inputs as diagnostic problem sensors.
        yaml = gen.generate_box_yaml(_box())
        for needle in (
            'name: "Versorgungsfehler 5V"', 'name: "Versorgungsfehler 12V"',
            'name: "Versorgungsfehler 24V"', "id: gc_err_5v",
            "device_class: problem", "entity_category: diagnostic",
        ):
            self.assertIn(needle, yaml)
        # Pin polarity mirrors the manufacturer firmware (5 V inverted, 24 V no pull-up).
        self.assertIn("number: 10, mode: { input: true }, inverted: true", yaml)
        self.assertIn("number: 9, mode: { input: true, pullup: false }, inverted: false", yaml)

    def test_loop_error_channels_present(self):
        # roadmap #1: 4-20 mA loop-error on ADS A2/A3 → problem binary_sensors,
        # raw voltages kept internal (id only).
        yaml = gen.generate_box_yaml(_box())
        self.assertIn('name: "4-20mA CH1 Loop-Fehler"', yaml)
        self.assertIn("multiplexer: A2_GND", yaml)
        self.assertIn("multiplexer: A3_GND", yaml)
        self.assertIn("id: gc_loop1_v", yaml)
        self.assertIn("id(gc_loop1_v).state > 2.0", yaml)

    def test_error_led_driven_by_interval(self):
        # roadmap #1: the Error-LED (GPIO2) is actually driven, not just emitted.
        yaml = gen.generate_box_yaml(_box())
        self.assertIn("interval:", yaml)
        self.assertIn("interval: 1s", yaml)
        self.assertIn("id(gc_error_led).turn_on();", yaml)
        self.assertIn("id(gc_error_led).turn_off();", yaml)

    def test_diagnostics_present_without_assigned_inputs(self):
        # The binary_sensor block (and thus the diagnostics) exists even with no
        # rain/switch inputs assigned.
        yaml = gen.generate_box_yaml(_box(inputs=[]))
        self.assertIn("binary_sensor:", yaml)
        self.assertIn("id: gc_err_5v", yaml)


class TestEsp32Wroom(unittest.TestCase):
    def test_outputs_use_direct_gpio(self):
        box = _box(hw_type="esp32_wroom", outputs=[{"id": "v1", "type": "valve", "name": "Beeren"}])
        yaml = gen.generate_box_yaml(box)
        self.assertNotIn("mcp23017", yaml)
        self.assertIn("number: GPIO16", yaml)

    def test_no_gardencontrol_board_diagnostics(self):
        # roadmap #1 diagnostics are GardenControl-specific (board expanders/ADS) —
        # the generic WROOM template must not contain them.
        yaml = gen.generate_box_yaml(_box(hw_type="esp32_wroom"))
        for absent in ("Versorgungsfehler", "Loop-Fehler", "gc_err_5v", "gc_loop1_v", "gc_error_led"):
            self.assertNotIn(absent, yaml)

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


class TestSmoothing(unittest.TestCase):
    """Optional per-input on-device moving-average smoothing (FR-S16)."""

    def test_off_by_default_keeps_inline_gc_filter(self):
        # No smoothing_s → GC 4-20 mA keeps the exact inline filter (no hash change,
        # no forced reflash for existing boxes).
        yaml = gen.generate_box_yaml(_box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1"}]))
        self.assertIn("filters: [ { multiply: 10 } ]", yaml)
        self.assertNotIn("sliding_window_moving_average", yaml)

    def test_gc_4_20ma_window_from_seconds(self):
        # 60 s at the ADS 3 s update_interval → window 20.
        yaml = gen.generate_box_yaml(_box(inputs=[
            {"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1", "smoothing_s": 60}]))
        self.assertIn("sliding_window_moving_average:", yaml)
        self.assertIn("window_size: 20", yaml)
        self.assertIn("- multiply: 10", yaml)  # shunt conversion preserved

    def test_gc_soil_adc_window_from_seconds(self):
        # 60 s at the ADC 2 s update_interval → window 30.
        yaml = gen.generate_box_yaml(_box(inputs=[
            {"id": "i1", "kind": "soil_moisture", "name": "Beet", "pin": "GPIO32", "smoothing_s": 60}]))
        self.assertIn("sliding_window_moving_average:", yaml)
        self.assertIn("window_size: 30", yaml)
        self.assertIn("- multiply: 4", yaml)

    def test_wroom_pressure_keeps_median_and_adds_average(self):
        # 60 s at the WROOM 10 s update_interval → window 6, median spike filter stays.
        yaml = gen.generate_box_yaml(_box(hw_type="esp32_wroom", inputs=[
            {"id": "i1", "kind": "pressure", "name": "Tank", "smoothing_s": 60}]))
        self.assertIn("median:", yaml)
        self.assertIn("sliding_window_moving_average:", yaml)
        self.assertIn("window_size: 6", yaml)

    def test_only_configured_input_gets_filter(self):
        # Two 4-20 mA terminals; only the one with smoothing_s is affected.
        yaml = gen.generate_box_yaml(_box(inputs=[
            {"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1", "smoothing_s": 60},
            {"id": "i2", "kind": "pressure", "name": "Regentonne", "pin": "IN2"}]))
        self.assertEqual(yaml.count("sliding_window_moving_average"), 1)
        self.assertIn("filters: [ { multiply: 10 } ]", yaml)  # IN2 stays inline

    def test_window_never_below_two(self):
        # A tiny window (< one interval) is clamped to 2, never 0/1.
        yaml = gen.generate_box_yaml(_box(inputs=[
            {"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1", "smoothing_s": 1}]))
        self.assertIn("window_size: 2", yaml)

    def test_smoothing_changes_config_hash(self):
        # Turning smoothing on changes the firmware → drift → reflash (by design).
        off = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1"}])
        on = _box(inputs=[{"id": "i1", "kind": "pressure", "name": "Zisterne", "pin": "IN1", "smoothing_s": 60}])
        self.assertNotEqual(gen.box_config_hash(off), gen.box_config_hash(on))

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

    def test_button_is_plain_binary_sensor_without_device_class(self):
        # FR-S14: generic binary input → binary_sensor, named, no block device_class.
        box = _box(hw_type="esp32_wroom",
                   inputs=[{"id": "i1", "kind": "button", "name": "Klingel", "pin": "GPIO18"}])
        yaml = gen.generate_box_yaml(box)
        self.assertIn("binary_sensor:", yaml)
        self.assertIn('name: "Klingel"', yaml)
        self.assertIn("number: GPIO18", yaml)
        self.assertNotIn("device_class: moisture", yaml)
        self.assertNotIn("inverted: true", yaml)  # default polarity

    def test_button_inverted_flag_inverts_the_pin_wroom(self):
        box = _box(hw_type="esp32_wroom",
                   inputs=[{"id": "i1", "kind": "button", "name": "Klingel", "pin": "GPIO18", "inverted": True}])
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


class TestGcInputPin(unittest.TestCase):
    """`gc_input_pin` is the whole of the coordinator's storage migration."""

    def test_legacy_ads_keys_fold_to_the_label_they_displayed(self):
        self.assertEqual(gen.gc_input_pin("A0"), "IN1")
        self.assertEqual(gen.gc_input_pin("A1"), "IN2")

    def test_case_and_whitespace_normalised(self):
        self.assertEqual(gen.gc_input_pin(" a0 "), "IN1")
        self.assertEqual(gen.gc_input_pin("in2"), "IN2")

    def test_terminal_labels_and_gpios_pass_through(self):
        for pin in ("IN1", "IN2", "GPIO14", "GPIO35"):
            self.assertEqual(gen.gc_input_pin(pin), pin)

    def test_empty_pin_stays_empty(self):
        for pin in (None, "", "   "):
            self.assertEqual(gen.gc_input_pin(pin), "")

    def test_mux_map_matches_vendor_firmware(self):
        # esp32-gardencontrol.yaml: "4-20mA CH1" → A1_GND, "CH2" → A0_GND
        self.assertEqual(gen._GC_ADS_MUX, {"IN1": "A1", "IN2": "A0"})


if __name__ == "__main__":
    unittest.main()
