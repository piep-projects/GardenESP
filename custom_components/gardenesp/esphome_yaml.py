"""ESPHome-YAML generation per box (FDS §5.4 / FR-S7a) — pure, no HA imports.

Generates a **hardware-only** ESPHome configuration from a box's ``hw_type``
template plus its ``outputs``/``inputs`` (FDS §4.1). The result defines only
hardware *devices* — valves/pumps as switches (pins + polarity), sensors as
inputs, and the on-device **Emergency Shutdown** timer per output (FR-E1). It
contains **no assignments/mappings** (line↔valve, line↔source, …) — those live
in HA Storage, not in the firmware (FR-S9).

Lifted and reshaped from ``archive/v0-esphome-generator/generate.py``: the v0
generator emitted both devices *and* config; here we keep only the device side.

The two templates differ in how pins are addressed:

* ``gardencontrol`` — ESP32 + 2× MCP23017 (valves/pumps) + ADS1115 (4-20 mA
  pressure), PCF8575 reserved for status LEDs. Direct GPIO for rain/pulse.
* ``esp32_wroom`` — direct GPIO for everything (~8 channels).

The function works on plain dicts (``dataclasses.asdict(box)``) so it stays
decoupled from the model and trivially unit-testable.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

HW_GARDENCONTROL = "gardencontrol"
HW_ESP32_WROOM = "esp32_wroom"

# ESPHome ``project: name`` — the flashed device reports ``project.version`` back
# to HA as its device ``sw_version`` (firmware-drift detection, roadmap #9). HA's
# ESPHome integration also derives the device model from the part after the dot.
PROJECT_NAME = "gardenesp.steuergeraet"
_FRIENDLY_MARKER = "  friendly_name: ${friendly_name}"

OUTPUT_VALVE = "valve"
OUTPUT_PUMP = "pump"
OUTPUT_OTHER = "other"  # generic switched load (Steuerung) — wired like valve/pump

INPUT_PRESSURE = "pressure"
INPUT_SOIL_MOISTURE = "soil_moisture"
INPUT_RAIN = "rain"
INPUT_PULSE_METER = "pulse_meter"
INPUT_BUTTON = "button"  # generic binary input (Taster / Schalter) — FR-S14

# Pulse counters (CR-0001): the PCNT hardware glitch filter caps internal_filter
# at ~13 µs (1023 APB cycles @ 80 MHz), which the default already uses. Real meter
# lines (long/unshielded) ring well past that on each edge and get multi-counted
# (HIL: ~11.5× over-count), so fall back to the software counter (use_pcnt: false)
# with a larger debounce. Slow impulse/S0 meters (≤ a few hundred Hz) are
# unaffected by an 8 ms filter (rejects high/low times < 8 ms ⇒ pulse rates > ~60 Hz).
# HIL re-verify (Box A, FLOW 600 = 10 Hz): 2 ms cut the over-count from ~11.5× to
# only ~2.2× (ringing per edge outlasts 2 ms) — raised to 8 ms to reach ratio ≈ 1.0.
_PULSE_USE_PCNT = "false"
# HIL tuning (Box A, FLOW 600 = 10 Hz, 50 ms high/low): 2 ms → ~2.2× over, 8 ms →
# ~0.1× under + drifting (non-monotonic — likely dirty DUT input edges). 4 ms is the
# next bracketing candidate toward ratio ≈ 1.0; if it also misses, signal-integrity
# analysis is needed, not just a larger filter (CR-0001 stays open until HIL ≈ 1.0).
_PULSE_INTERNAL_FILTER = "4ms"
# Default pulse_counter update_interval is 60 s — too coarse for run-bracketed
# consumption (a line shorter than one window sees Δtotal=0 → 0 L; CR-0004 HIL).
# 10 s keeps the cumulative total current enough for start/end-of-run deltas.
_PULSE_UPDATE_INTERVAL = "10s"


class YamlGenError(ValueError):
    """Raised when a box cannot be mapped onto its hw_type template (e.g. more
    outputs than the platform has pins)."""


# --- pin pools per hw_type ----------------------------------------------------
# GardenControl connectors: 12 valve outputs (24 VAC) + 2 relay outputs (230 V);
# 2× 4-20 mA inputs (ADS1115, e.g. water level); 4× ADC 0-12 V inputs (humidity/
# pressure/temperature); 3× binary inputs (switches / S0 meter / rain sensor).
_GC_VALVE_PINS = 12
_GC_PUMP_CHANNELS = ["R1", "R2"]  # printed terminal labels
# The board **crosses** the relay outputs against the vendor firmware's pin naming:
# the screw printed **R1 is driven by MCP pin 13**, R2 by pin 12 (manufacturer-confirmed
# 2026-07-12 — the silkscreen stays, the pins swap). The LED assignment is *not* crossed
# (R1 → LED 3, R2 → LED 2 is correct as printed), so only the pin travels.
_GC_RELAY_PIN = {"R1": 13, "R2": 12}
_GC_RELAY_LED = {"R1": 3, "R2": 2}
# 4-20 mA inputs are addressed by their **printed terminal label** (IN1/IN2); the
# ADS1115 multiplexer is resolved only at generation time. The board crosses them:
# terminal IN1 sits on ADS **A1**, IN2 on **A0** — verified against the vendor
# firmware (`gardencontrol/GardenControl-main/ESPHome_Firmware/esp32-gardencontrol.yaml`,
# "4-20mA CH1" reads `A1_GND`, "CH2" reads `A0_GND`). Storing the mux name here is
# what made GardenESP read the *other* terminal than the one the user wired.
_GC_ADS_CHANNELS = ["IN1", "IN2"]  # 2× 4-20 mA (terminal labels)
_GC_ADS_MUX = {"IN1": "A1", "IN2": "A0"}
_GC_ADS_ID = {"IN1": "gc_in1", "IN2": "gc_in2"}
# Legacy configs stored the mux name, but the UI always *labelled* A0 as "IN1" —
# so the user wired by the label. Map the old key onto the label it displayed.
_GC_ADS_LEGACY = {"A0": "IN1", "A1": "IN2"}
_GC_ADC_PINS = ["GPIO32", "GPIO33", "GPIO34", "GPIO35"]  # 4× ADC 0-12 V
_GC_BINARY_PINS = ["GPIO14", "GPIO16", "GPIO17"]  # 3× binary (rain / S0 / switch)

# ESP32-WROOM: direct GPIO only.
_WROOM_OUTPUT_PINS = [
    "GPIO16", "GPIO17", "GPIO18", "GPIO19",
    "GPIO21", "GPIO22", "GPIO23", "GPIO25",
]
_WROOM_BINARY_PINS = ["GPIO26", "GPIO27"]
_WROOM_ADC_PINS = ["GPIO34", "GPIO35", "GPIO32", "GPIO33"]
_WROOM_PULSE_PIN = "GPIO13"


def gc_input_pin(pin: Any) -> str:
    """Canonical GardenControl input slot for a stored ``pin``.

    Normalises case and folds the legacy ADS-channel keys (``A0``/``A1``) onto the
    terminal labels the UI has always shown for them (``IN1``/``IN2``). Every other
    pin (``GPIO*``) passes through unchanged. GardenControl boxes only — a generic
    box may legitimately carry an ``A0`` pin for an external ADS1115.
    """
    return _GC_ADS_LEGACY.get(p := str(pin or "").strip().upper(), p)


# --- helpers ------------------------------------------------------------------
# German umlauts → ASCII-7 (ä→ae …, ß→ss) so the ESPHome-derived entity_ids are
# clean (e.g. ``switch.gardenesp_c_groesse``) instead of ESPHome dropping the
# non-ASCII bytes (which would yield ``…_gre``). Applied to both the emitted
# ``name:`` and the id sanitization so the HA object_id matches our derived guess.
#
# HA/ESPHome rewrite a plain ``/`` in a friendly name to the FRACTION SLASH
# (U+2044) — so a config output "Vierfach Ventil 1/4" surfaces in the entity
# registry as "Vierfach Ventil 1⁄4". Fold those unicode slash variants back to
# "/" on *both* sides so the resolver's name-match still succeeds.
_ASCII_MAP = {
    "ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss",
    "⁄": "/", "∕": "/", "／": "/",
}


def ascii_fold(name: str) -> str:
    """Transliterate German umlauts/ß to ASCII-7; leave the rest untouched."""
    for src, dst in _ASCII_MAP.items():
        name = name.replace(src, dst)
    return name


def sanitize(name: str) -> str:
    """A valid ESPHome id (lowercase, underscores), umlauts folded to ASCII."""
    return re.sub(r"[^a-zA-Z0-9]+", "_", ascii_fold(name)).strip("_").lower()


def _device_name(box: dict[str, Any]) -> str:
    """ESPHome ``name:`` — lowercase, hyphens only (no underscores allowed).

    Derived from the box **label** (``gardenesp-steuergeraet-<label>``) so the
    resulting HA entity_ids are stable and branded
    (``switch.gardenesp_steuergeraet_c_<output>``) and do **not** change when the
    free-text box name is edited. Falls back to the box name/id only when no label
    is set (legacy boxes)."""
    label = sanitize(box.get("label") or "")
    if label:
        return f"gardenesp-steuergeraet-{label}".replace("_", "-")
    base = sanitize(box.get("name") or box.get("id") or "garden-box")
    return base.replace("_", "-") or "garden-box"


def device_name(box: dict[str, Any]) -> str:
    """Public alias — the ESPHome node ``name:`` for a box (``gardenesp-steuergeraet-<label>``).
    Used by the coordinator to match a box to its ESPHome HA config entry (whose
    ``data["device_name"]`` equals exactly this)."""
    return _device_name(box)


def _friendly_name(box: dict[str, Any]) -> str:
    """ESPHome ``friendly_name`` — the human device name shown in HA, and the base
    HA derives the box entity_ids from. Prefixed with ``GardenESP Steuergerät <Kürzel>``
    so all box outputs/inputs share the ``gardenesp_steuergeraet_<x>_*`` entity_id
    prefix (consistent with the "Steuergerät" UI term) and multiple boxes stay
    distinguishable. The descriptive name is intentionally **not** part of it, to
    keep the entity_id prefix bounded. Falls back to ``GardenESP <name>`` when no
    label is set. NB: HA freezes an entity_id at first creation — existing boxes
    keep their old ``gardenesp_box_*`` ids until removed + re-added (resolver matches
    by entity name, so display is unaffected)."""
    name = box.get("name") or box.get("id") or "Box"
    label = str(box.get("label") or "").strip().upper()
    return f"GardenESP Steuergerät {label}" if label else f"GardenESP {name}"


def _is_inverted(output: dict[str, Any]) -> bool:
    """active-low relay module → ``inverted: true`` (``relais_off: HIGH``)."""
    return str(output.get("relais_off", "HIGH")).upper() == "HIGH"


def _switch_id(output: dict[str, Any]) -> str:
    return sanitize(output.get("name") or output.get("id") or "output")


def _sensor_id(inp: dict[str, Any]) -> str:
    return sanitize(inp.get("name") or inp.get("id") or "input")


# --- section builders ---------------------------------------------------------
def _header(box: dict[str, Any]) -> list[str]:
    dev = _device_name(box)
    friendly = _friendly_name(box)
    return [
        "# Generated by gardenesp — DO NOT EDIT.",
        "# Source: Steuergerät device definition (outputs/inputs) + hw_type template (FDS §5.4).",
        "# Hardware devices only — no assignments (those live in HA Storage, FR-S9).",
        "",
        "substitutions:",
        f"  device_name: {dev}",
        f'  friendly_name: "{friendly}"',
        "",
        "esphome:",
        "  name: ${device_name}",
        "  friendly_name: ${friendly_name}",
        "  on_boot:",
        "    priority: -100",
        "    then:",
        _DIAG_ON_BOOT,
        "",
        "esp32:",
        "  board: esp32dev",
        "  framework:",
        "    type: arduino",
        "",
        "logger:",
        "",
        "api:",
        "  encryption:",
        "    key: !secret api_encryption_key",
        "",
        "ota:",
        "  - platform: esphome",
        "    password: !secret ota_password",
        "",
        "wifi:",
        "  ssid: !secret wifi_ssid",
        "  password: !secret wifi_password",
        "  ap:",
        '    ssid: "${friendly_name} Fallback"',
        "    password: !secret wifi_ap_password",
        "",
        "captive_portal:",
        "",
    ]


def _emergency_script(output: dict[str, Any], sw_id: str) -> list[str]:
    """On-device Emergency Shutdown (FR-E1): a restart-mode timer that turns the
    output off after ``emergency_shutdown_min``, independent of WiFi/HA."""
    minutes = int(output.get("emergency_shutdown_min") or 0)
    if minutes <= 0:
        return []
    return [
        f"  - id: emergency_{sw_id}",
        "    mode: restart",
        "    then:",
        f"      - delay: {minutes}min",
        "      - lambda: 'id(emergency_count) += 1;'",  # CR-0011: report the backstop firing
        "      - component.update: emergency_total",  # push immediately when HA is online
        f"      - switch.turn_off: {sw_id}",
    ]


CoSwitch = list  # list[tuple[driven_switch_id, [driver_switch_ids]]]


def _co_switch_lines(items: CoSwitch | None) -> tuple[list[str], list[str]]:
    """ConnectedDevice/Shared-Pump (FR-E2): on_turn_on/off actions for a valve that
    co-switches ``items`` = [(driven_id, [all valve ids driving it]), …]. Each driven
    output is switched off only once **all** driving valves are off (on-device lambda)."""
    on_on: list[str] = []
    on_off: list[str] = []
    for sid, drivers in items or []:
        on_on.append(f"      - switch.turn_on: {sid}")
        cond = " && ".join(f"!id({d}).state" for d in drivers)
        on_off += [
            "      - if:",
            "          condition:",
            f"            lambda: 'return {cond};'",
            "          then:",
            f"            - switch.turn_off: {sid}",
        ]
    return on_on, on_off


def _gpio_switch(
    output: dict[str, Any], pin_lines: list[str], co: CoSwitch | None = None
) -> list[str]:
    """One ``platform: gpio`` switch with Emergency-Shutdown (FR-E1) + ConnectedDevice (FR-E2) hooks."""
    sw_id = _switch_id(output)
    minutes = int(output.get("emergency_shutdown_min") or 0)
    _t = output.get("type")
    icon = (
        "mdi:water-pump" if _t == OUTPUT_PUMP
        else "mdi:toggle-switch-variant" if _t == OUTPUT_OTHER
        else "mdi:pipe-valve"
    )
    lines = [
        "  - platform: gpio",
        f"    id: {sw_id}",
        f'    name: "{ascii_fold(output.get("name") or sw_id)}"',
        f"    icon: {icon}",
        "    pin:",
    ]
    lines += pin_lines
    if _is_inverted(output):
        lines.append("      inverted: true")
    co_on, co_off = _co_switch_lines(co)
    on_on = ([f"      - script.execute: emergency_{sw_id}"] if minutes > 0 else []) + co_on
    on_off = ([f"      - script.stop: emergency_{sw_id}"] if minutes > 0 else []) + co_off
    if on_on:
        lines += ["    on_turn_on:", *on_on]
    if on_off:
        lines += ["    on_turn_off:", *on_off]
    return lines


def _co_switch_map(box: dict[str, Any]) -> dict[str, CoSwitch]:
    """Map driver output id → [(driven switch id, [driving output ids]), …].

    A **valve** drives its source pump (``output['pump']``, set by the WS layer from
    ``source.pump_output``, same box only); **any** output (valve or pump) can also
    drive manual ``connected`` outputs (multi-stage chains). Each driven output stays
    on until all outputs driving it are off (shared)."""
    outs = box.get("outputs") or []
    by_id = {o.get("id"): o for o in outs}
    drives: dict[str, set[str]] = {}  # driver id -> driven output ids
    for o in outs:
        targets: set[str] = set()
        if o.get("type") == OUTPUT_VALVE:
            pump = o.get("pump")
            if pump and pump in by_id:
                targets.add(pump)
        for c in o.get("connected") or []:
            if c in by_id and c != o.get("id"):
                targets.add(c)
        if targets:
            drives[o.get("id")] = targets
    drivers: dict[str, list[str]] = {}  # driven id -> [driver ids]
    for vid, targets in drives.items():
        for t in targets:
            drivers.setdefault(t, []).append(vid)
    info: dict[str, CoSwitch] = {}
    for vid, targets in drives.items():
        info[vid] = [
            (_switch_id(by_id[t]), [_switch_id(by_id[d]) for d in drivers[t]])
            for t in sorted(targets)
        ]
    return info


def _wroom_output_pin(
    output: dict[str, Any], idx: dict[str, int]
) -> tuple[list[str], str]:
    # Generic/custom boxes: the user-assigned GPIO wins (free wiring).
    gpio = str(output.get("gpio") or "").strip()
    if gpio:
        return ([f"      number: {gpio}"], gpio)
    # No GPIO set → fall back to the generic pin pool by channel/order (legacy).
    channel = str(output.get("channel") or "").strip()
    if channel:
        if not (channel.isdigit() and 1 <= int(channel) <= len(_WROOM_OUTPUT_PINS)):
            raise YamlGenError(
                f"channel must be 1–{len(_WROOM_OUTPUT_PINS)} (or set a GPIO), got {channel!r}"
            )
        n = int(channel) - 1
    else:
        n = idx["out"]
        idx["out"] += 1
        if n >= len(_WROOM_OUTPUT_PINS):
            raise YamlGenError(
                f"generic template has only {len(_WROOM_OUTPUT_PINS)} default output pins — set a GPIO"
            )
    pin = _WROOM_OUTPUT_PINS[n]
    return ([f"      number: {pin}"], pin)


def _switches(box: dict[str, Any], hw: str) -> list[str]:
    """Generic (ESP32-WROOM / custom) outputs — GardenControl uses its own template."""
    outputs = box.get("outputs") or []
    if not outputs:
        return []
    lines = ["# ─── Outputs (valves & pumps) ───────────────────────────────────────────", "switch:"]
    idx = {"out": 0}
    used: set[Any] = set()
    co = _co_switch_map(box)
    for output in outputs:
        pin_lines, key = _wroom_output_pin(output, idx)
        if key in used:
            raise YamlGenError(f"output GPIO {key} used by more than one output")
        used.add(key)
        lines += _gpio_switch(output, pin_lines, co.get(output.get("id")))
    lines.append("")
    return lines


def _scripts(box: dict[str, Any]) -> list[str]:
    blocks: list[str] = []
    for output in box.get("outputs") or []:
        blocks += _emergency_script(output, _switch_id(output))
    if not blocks:
        return []
    return [
        "# ─── Emergency Shutdown timers (on-device, FR-E1) ───────────────────────",
        "script:",
        *blocks,
        "",
    ]


def _resolve_pin(
    inp: dict[str, Any], pool: list[str], idx: dict[str, int], key: str, strict: bool = True
) -> str:
    """Pick the input's pin: explicit ``inp['pin']`` if set, else the next free
    pool slot (legacy order-based). ``strict`` (GardenControl) validates the pin
    against ``pool``; generic/custom boxes accept any user-assigned pin."""
    pin = str(inp.get("pin") or "").strip()
    if pin:
        if strict and pin not in pool:
            raise YamlGenError(f"input pin {pin!r} not valid for this kind/platform")
        return pin
    n = idx[key]
    idx[key] += 1
    if n >= len(pool):
        raise YamlGenError("No free default input pin left — set a pin/GPIO")
    return pool[n]


# --- board diagnostics (FR-S13): WLAN signal + restart counter -----------------
# Entity names emitted into the YAML; the coordinator matches them (folded) in the
# registry to read the live values back (single source of truth for both sides).
DIAG_WIFI_NAME = "WLAN-Signal"
DIAG_BOOT_NAME = "Neustarts gesamt"
DIAG_RESTART_NAME = "Neustart"
DIAG_EMERGENCY_NAME = "Notabschaltungen gesamt"
# GardenControl-only board self-diagnostics (roadmap #1): supply-voltage error inputs
# and 4-20 mA loop-error detection, both driving the on-board Error-LED (GPIO2).
DIAG_ERR_5V_NAME = "Versorgungsfehler 5V"
DIAG_ERR_12V_NAME = "Versorgungsfehler 12V"
DIAG_ERR_24V_NAME = "Versorgungsfehler 24V"
DIAG_ERR_LOOP1_NAME = "4-20mA CH1 Loop-Fehler"
DIAG_ERR_LOOP2_NAME = "4-20mA CH2 Loop-Fehler"
# Under-range detection on the *signal* channels. The board's own error inputs
# (ADS A2/A3, > 2 V) only see an open/shorted loop on the supply side — they stay
# `off` while a mis-wired, unpowered or dead transmitter leaves the signal channel
# at ~0 mA instead of the 4 mA live-zero. Only emitted for configured terminals,
# otherwise an empty input would report a permanent fault.
DIAG_ERR_LOOP1_LOW_NAME = "4-20mA CH1 Unterbereich"
DIAG_ERR_LOOP2_LOW_NAME = "4-20mA CH2 Unterbereich"
_GC_LOOP_MIN_MA = 3.5  # below the 4 mA live-zero (with margin) = no valid loop


def _diag_button() -> list[str]:
    """A remote restart button (ESPHome ``button: restart``) so the box-ESP can be
    soft-rebooted from HA (CR-0008): GPIOs fall off + the NVS boot counter +1 — a
    realistic power-loss surrogate for the resilience suite (S1/S2) and a generally
    useful recovery handle. Top-level ``button:`` block, shared by both templates."""
    return [
        "# ─── Diagnostics: remote restart button (CR-0008) ───────────────────────",
        "button:",
        "  - platform: restart",
        f'    name: "{DIAG_RESTART_NAME}"',
        "",
    ]


def _diag_globals() -> list[str]:
    """Reboot-surviving NVS counters (``restore_value``): ``boot_count`` (incremented
    in ``on_boot``, source for "restarts today/yesterday", FR-S13) and
    ``emergency_count`` (incremented by each Emergency-Shutdown script before it cuts
    the output, so the firing survives WiFi/HA blindness — the coordinator derives an
    ``emergency`` run-result from its history, CR-0011). Shared by both templates."""
    return [
        "# ─── Diagnostics: counters persisted across reboots (FR-S13 / CR-0011) ──",
        "globals:",
        "  - id: boot_count",
        "    type: int",
        "    restore_value: true",
        "    initial_value: '0'",
        "  - id: emergency_count",
        "    type: int",
        "    restore_value: true",
        "    initial_value: '0'",
        "",
    ]


def _diag_sensor_entries() -> list[str]:
    """``sensor:`` list-items for WLAN signal + cumulative restart count (FR-S13),
    appended into the box's existing ``sensor:`` block. HA exposes both as native
    ESPHome diagnostic entities; the coordinator derives restarts today/yesterday
    from the boot-count history (like ``consumption_today``)."""
    return [
        "  - platform: wifi_signal",
        f'    name: "{DIAG_WIFI_NAME}"',
        "    update_interval: 60s",
        "  - platform: template",
        f'    name: "{DIAG_BOOT_NAME}"',
        "    lambda: 'return id(boot_count);'",
        "    accuracy_decimals: 0",
        "    state_class: total_increasing",
        "    update_interval: 60s",
        "  - platform: template",
        f'    name: "{DIAG_EMERGENCY_NAME}"',
        "    id: emergency_total",  # referenced by the emergency scripts for an instant push
        "    lambda: 'return id(emergency_count);'",
        "    accuracy_decimals: 0",
        "    state_class: total_increasing",
        "    update_interval: 60s",
    ]


def _gc_error_binsensors() -> list[str]:
    """GardenControl-only board self-diagnostics (roadmap #1): ``binary_sensor``
    list-items for the three supply-voltage error inputs (5/12/24 V, on
    ``mcp23017_top``) plus two 4-20 mA loop-error detectors (open/shorted current
    loop → the raw ADS A2/A3 voltage rises above ~2 V). All are ``device_class:
    problem`` diagnostic entities; together they drive the on-board Error-LED (see
    :func:`_gc_error_led_interval`). Pin polarity mirrors the manufacturer firmware
    (5 V inverted, 24 V no pull-up)."""
    L = ["# ─── Board self-diagnostics: supply + 4-20mA loop errors (roadmap #1) ──"]
    for name, sid, num, mode, inverted in [
        (DIAG_ERR_5V_NAME, "gc_err_5v", 10, "{ input: true }", "true"),
        (DIAG_ERR_12V_NAME, "gc_err_12v", 8, "{ input: true }", "false"),
        (DIAG_ERR_24V_NAME, "gc_err_24v", 9, "{ input: true, pullup: false }", "false"),
    ]:
        pin = f"{{ mcp23xxx: mcp23017_top, number: {num}, mode: {mode}, inverted: {inverted} }}"
        L += [
            "  - platform: gpio",
            f'    name: "{name}"',
            f"    id: {sid}",
            "    device_class: problem",
            "    entity_category: diagnostic",
            f"    pin: {pin}",
        ]
    for name, sid, raw in [
        (DIAG_ERR_LOOP1_NAME, "gc_loop1_err", "gc_loop1_v"),
        (DIAG_ERR_LOOP2_NAME, "gc_loop2_err", "gc_loop2_v"),
    ]:
        L += [
            "  - platform: template",
            f'    name: "{name}"',
            f"    id: {sid}",
            "    device_class: problem",
            "    entity_category: diagnostic",
            f"    lambda: 'return id({raw}).state > 2.0;'",
        ]
    return L


def _gc_loop_underrange_binsensors(inputs: dict[str, Any]) -> list[str]:
    """``binary_sensor:`` items flagging a 4-20 mA loop **below the 4 mA live-zero**.

    A healthy two-wire transmitter always sources ≥ 4 mA, even dry. Less than that
    means open loop, no supply, reversed polarity or a dead sensor. Emitted only for
    terminals that carry a configured input — see ``DIAG_ERR_LOOP*_LOW_NAME``.
    """
    L: list[str] = []
    for term, name in (("IN1", DIAG_ERR_LOOP1_LOW_NAME), ("IN2", DIAG_ERR_LOOP2_LOW_NAME)):
        if not inputs.get(term):
            continue
        sid = _GC_ADS_ID[term]
        L += [
            "  - platform: template",
            f'    name: "{name}"',
            "    device_class: problem",
            "    entity_category: diagnostic",
            f"    lambda: 'return !isnan(id({sid}).state) && id({sid}).state < {_GC_LOOP_MIN_MA};'",
        ]
    return L


def _gc_loop_error_adc_sensors() -> list[str]:
    """``sensor:`` list-items for the raw 4-20 mA loop-error voltages (ADS A2/A3).
    Kept ``internal`` (id only, not exposed) — the user-facing signal is the
    :func:`_gc_error_binsensors` ``problem`` binary_sensor, not a raw voltage."""
    L: list[str] = []
    for sid, mux in [("gc_loop1_v", "A2_GND"), ("gc_loop2_v", "A3_GND")]:
        L += [
            "  - platform: ads1115",
            f"    multiplexer: {mux}",
            "    gain: 2.048",
            f"    id: {sid}",
            "    internal: true",
            "    update_interval: 3s",
        ]
    return L


def _gc_error_led_interval() -> list[str]:
    """Top-level ``interval:`` that drives the on-board Error-LED (GPIO2) from the
    supply-voltage and 4-20 mA loop-error inputs, on-device and HA-independent
    (roadmap #1). Without this the Error-LED is emitted but never lit."""
    return [
        "",
        "# ─── Error-LED driver: supply / loop faults (roadmap #1) ────────────────",
        "interval:",
        "  - interval: 1s",
        "    then:",
        "      - lambda: |-",
        "          if (id(gc_err_5v).state || id(gc_err_12v).state || id(gc_err_24v).state ||",
        "              id(gc_loop1_v).state > 2.0 || id(gc_loop2_v).state > 2.0) {",
        "            id(gc_error_led).turn_on();",
        "          } else {",
        "            id(gc_error_led).turn_off();",
        "          }",
    ]


_DIAG_ON_BOOT = "      - lambda: 'id(boot_count) += 1;'"


def _sensors(box: dict[str, Any], hw: str) -> list[str]:
    inputs = box.get("inputs") or []
    sensor: list[str] = []
    binary: list[str] = []
    idx = {"ads": 0, "adc": 0, "binary": 0, "pulse": 0}
    used: set[str] = set()
    for inp in inputs:
        kind = inp.get("kind")
        sid = _sensor_id(inp)
        name = ascii_fold(inp.get("name") or sid)
        if kind == INPUT_PRESSURE:
            lines, pin = _pressure_sensor(inp, sid, name, hw, idx)
            sensor += lines
        elif kind == INPUT_SOIL_MOISTURE:
            lines, pin = _adc_sensor(inp, sid, name, hw, idx, "mdi:water-percent")
            sensor += lines
        elif kind == INPUT_PULSE_METER:
            lines, pin = _pulse_sensor(inp, sid, name, hw, idx)
            sensor += lines
        elif kind == INPUT_RAIN:
            lines, pin = _rain_sensor(inp, sid, name, hw, idx)
            binary += lines
        elif kind == INPUT_BUTTON:
            lines, pin = _button_sensor(inp, sid, name, hw, idx)
            binary += lines
        else:
            continue
        if pin in used:
            raise YamlGenError(f"input pin {pin} used by more than one input")
        used.add(pin)
    sensor += _diag_sensor_entries()  # WLAN + boot counter, always present (FR-S13)
    out: list[str] = []
    out += ["# ─── Analog / counting inputs ───────────────────────────────────────────", "sensor:", *sensor, ""]
    if binary:
        out += ["# ─── Binary inputs ──────────────────────────────────────────────────────", "binary_sensor:", *binary, ""]
    return out


def _filters_block(items: list[list[str]]) -> list[str]:
    """A ``filters:`` YAML block built from filter items (each item = its own list
    of lines, e.g. ``["      - multiply: 10"]``). Empty → no block emitted at all."""
    if not items:
        return []
    out = ["    filters:"]
    for it in items:
        out += it
    return out


def _smoothing_item(inp: dict[str, Any], interval_s: float) -> list[str]:
    """Optional on-device ``sliding_window_moving_average`` filter item derived from
    the input's ``smoothing_s`` (seconds; 0/absent = off → empty list). The window is
    computed from the sensor's own ``update_interval`` so the *time* constant is
    consistent across sensor types (GC 4-20 mA 3 s, GC ADC 2 s, WROOM 10 s). A moving
    average is the best fit for this level noise — it is Gaussian/low-frequency and
    spike-free, so averaging beats a median (measured on the live cisterns). FR-S16."""
    sec = int(inp.get("smoothing_s") or 0)
    if sec <= 0:
        return []
    window = max(2, round(sec / interval_s))
    return [
        "      - sliding_window_moving_average:",
        f"          window_size: {window}",
        "          send_every: 1",
    ]


def _pressure_sensor(
    inp: dict[str, Any], sid: str, name: str, hw: str, idx: dict[str, int]
) -> tuple[list[str], str]:
    # GardenControl never reaches here: `_sensors()` is only called from the generic
    # branch of `_base_yaml`, with `hw` hard-wired to HW_ESP32_WROOM. Its 4-20 mA
    # inputs live in `_generate_gardencontrol` (ADS1115, gain 2.048, mA). A stale
    # GardenControl branch used to sit here emitting `gain: 6.144` / `V` — dead code
    # that contradicted the real template and cost a long field debugging session.
    #
    # WROOM/custom: a median filter kills spikes on the noisy 4-20 mA / analog level
    # reading; an optional moving average (smoothing_s) smooths further. Raw ADC
    # voltage (NOT mbar) — the calibration table maps raw → liters (FR-S5a).
    return _adc_sensor(
        inp, sid, name, hw, idx, "mdi:gauge", unit="V",
        filter_items=[["      - median:", "          window_size: 5", "          send_every: 1"]],
    )


def _adc_sensor(
    inp: dict[str, Any], sid: str, name: str, hw: str, idx: dict[str, int], icon: str,
    unit: str | None = None, filter_items: list[list[str]] | None = None,
) -> tuple[list[str], str]:
    pool = _GC_ADC_PINS if hw == HW_GARDENCONTROL else _WROOM_ADC_PINS
    pin = _resolve_pin(inp, pool, idx, "adc", strict=hw == HW_GARDENCONTROL)
    lines = [
        "  - platform: adc",
        f"    id: {sid}",
        f'    name: "{name}"',
        f"    pin: {pin}",
        "    attenuation: 12db",
        f"    icon: {icon}",
        "    update_interval: 10s",
    ]
    if unit:
        lines.append(f"    unit_of_measurement: {unit}")
    items = list(filter_items or [])
    items += [_smoothing_item(inp, 10)] if _smoothing_item(inp, 10) else []
    lines += _filters_block(items)
    return (lines, pin)


def _pulse_sensor(
    inp: dict[str, Any], sid: str, name: str, hw: str, idx: dict[str, int]
) -> tuple[list[str], str]:
    # GardenControl S0/pulse uses one of the 3 shared binary inputs.
    pool = _GC_BINARY_PINS if hw == HW_GARDENCONTROL else [_WROOM_PULSE_PIN]
    pin = _resolve_pin(inp, pool, idx, "pulse", strict=hw == HW_GARDENCONTROL)
    return (
        [
            "  - platform: pulse_counter",
            f"    id: {sid}",
            f'    name: "{name}"',
            f"    pin: {pin}",
            f"    use_pcnt: {_PULSE_USE_PCNT}",  # CR-0001: SW counter, no PCNT 13µs cap
            f"    internal_filter: {_PULSE_INTERNAL_FILTER}",
            f"    update_interval: {_PULSE_UPDATE_INTERVAL}",  # CR-0004: current enough for run deltas
            "    unit_of_measurement: pulses",
            "    total:",
            f'      name: "{name} total"',
        ],
        pin,
    )


def _rain_sensor(
    inp: dict[str, Any], sid: str, name: str, hw: str, idx: dict[str, int]
) -> tuple[list[str], str]:
    pool = _GC_BINARY_PINS if hw == HW_GARDENCONTROL else _WROOM_BINARY_PINS
    pin = _resolve_pin(inp, pool, idx, "binary", strict=hw == HW_GARDENCONTROL)
    # `inverted` normalises NO/NC wiring here at the pin so the entity always
    # reads on=wet; the gate then trusts it (FP-0001). Default false → no key.
    inv = ["      inverted: true"] if inp.get("inverted") else []
    return (
        [
            "  - platform: gpio",
            f"    id: {sid}",
            f'    name: "{name}"',
            "    device_class: moisture",
            "    pin:",
            f"      number: {pin}",
            *inv,
            "      mode:",
            "        input: true",
            "        pullup: true",
        ],
        pin,
    )


def _button_sensor(
    inp: dict[str, Any], sid: str, name: str, hw: str, idx: dict[str, int]
) -> tuple[list[str], str]:
    # Generic binary input (Taster / Schalter / Kontakt, FR-S14): a plain
    # binary_sensor with no device_class / block semantics — just a named HA
    # entity to use in automations. `inverted` (default false) honours the
    # wiring (pull-up to GND → pressed reads on when inverted).
    pool = _GC_BINARY_PINS if hw == HW_GARDENCONTROL else _WROOM_BINARY_PINS
    pin = _resolve_pin(inp, pool, idx, "binary", strict=hw == HW_GARDENCONTROL)
    inv = ["      inverted: true"] if inp.get("inverted") else []
    return (
        [
            "  - platform: gpio",
            f"    id: {sid}",
            f'    name: "{name}"',
            "    pin:",
            f"      number: {pin}",
            *inv,
            "      mode:",
            "        input: true",
            "        pullup: true",
            "    filters: [ { delayed_on: 10ms } ]",
        ],
        pin,
    )


# --- GardenControl: full board-accurate template (matches Smart-MF fw) --
# Valve LED on PCF8575: Ventil_1→#15 … Ventil_12→#4, Relais_1→#3, Relais_2→#2.
def _gc_maps(box: dict[str, Any]) -> dict[str, Any]:
    valves: dict[int, dict] = {}
    relais: dict[str, dict] = {}
    for o in box.get("outputs") or []:
        ch = str(o.get("channel") or "").strip().upper()
        # Pumps and generic "other" loads (fountain, …) sit on the relais channels;
        # everything else maps onto a numbered valve channel.
        if o.get("type") in (OUTPUT_PUMP, OUTPUT_OTHER) and ch in _GC_PUMP_CHANNELS:
            relais[ch] = o
        elif ch.isdigit() and 1 <= int(ch) <= _GC_VALVE_PINS:
            valves[int(ch)] = o
    by_pin: dict[str, dict] = {}
    for i in box.get("inputs") or []:
        pin = gc_input_pin(i.get("pin"))  # legacy A0/A1 → terminal IN1/IN2
        if pin:
            by_pin[pin] = i
    return {"valves": valves, "relais": relais, "inputs": by_pin}


def _gc_output_block(
    o: dict | None, default_name: str, mcp_num: int, led_num: int, led_id: str,
    co: CoSwitch | None = None,
) -> tuple[list[str], list[str]]:
    """One GardenControl output (valve/relais) on mcp23017_bot + its PCF8575 LED.
    Returns (switch_lines, script_lines) — script for the Emergency Shutdown (FR-E1).
    ``co`` adds the ConnectedDevice/Shared-Pump hooks (FR-E2)."""
    name = ascii_fold((o or {}).get("name") or default_name)
    sid = _switch_id(o) if o else sanitize(default_name)
    minutes = int((o or {}).get("emergency_shutdown_min") or 0)
    on_on = [f"      - switch.turn_on: {led_id}"]
    on_off = [f"      - switch.turn_off: {led_id}"]
    scripts: list[str] = []
    if minutes > 0:
        on_on.append(f"      - script.execute: emergency_{sid}")
        on_off.append(f"      - script.stop: emergency_{sid}")
        scripts = [
            f"  - id: emergency_{sid}",
            "    mode: restart",
            "    then:",
            f"      - delay: {minutes}min",
            "      - lambda: 'id(emergency_count) += 1;'",  # CR-0011: report the backstop firing
            "      - component.update: emergency_total",  # push immediately when HA is online
            f"      - switch.turn_off: {sid}",
        ]
    co_on, co_off = _co_switch_lines(co)
    on_on += co_on
    on_off += co_off
    sw = [
        "  - platform: gpio",
        f'    name: "{name}"',
        f"    id: {sid}",
        "    restore_mode: ALWAYS_OFF",
        "    pin:",
        "      mcp23xxx: mcp23017_bot",
        f"      number: {mcp_num}",
        "      mode:",
        "        output: true",
        "      inverted: false",
        "    on_turn_on:",
        *on_on,
        "    on_turn_off:",
        *on_off,
    ]
    led = [
        "  - platform: gpio",
        f'    name: "{name} LED"',
        f"    id: {led_id}",
        "    internal: true",
        "    pin:",
        "      pcf8574: pcf8575",
        f"      number: {led_num}",
        "      mode:",
        "        output: true",
        "      inverted: true",
    ]
    return sw + led, scripts


def _generate_gardencontrol(box: dict[str, Any]) -> str:
    dev = _device_name(box)
    friendly = _friendly_name(box)
    m = _gc_maps(box)
    valves, relais, inputs = m["valves"], m["relais"], m["inputs"]
    # The 3 binary inputs (BIN1–3) are interchangeable: each is either a binary_sensor
    # (rain/switch) or a pulse_counter (S0), depending on the assigned input.
    pulse_pins = [p for p in _GC_BINARY_PINS if (inputs.get(p) or {}).get("kind") == INPUT_PULSE_METER]
    binary_pins = [p for p in _GC_BINARY_PINS if p not in pulse_pins]
    s0_id = {p: ("gc_s0_counter" if i == 0 else f"gc_s0_counter_{i + 1}") for i, p in enumerate(pulse_pins)}
    api_service = (
        [
            "  services:",
            "    - service: set_pulse_total",
            "      variables:",
            "        new_pulse_total: int",
            "      then:",
            "        - pulse_counter.set_total_pulses:",
            f"            id: {s0_id[pulse_pins[0]]}",
            "            value: !lambda 'return new_pulse_total;'",
        ]
        if pulse_pins
        else []
    )
    L: list[str] = [
        "# Generated by gardenesp — DO NOT EDIT (FDS §5.4). GardenControl board template.",
        "# Hardware devices only; assignments live in HA Storage (FR-S9).",
        "",
        "substitutions:",
        f"  device_name: {dev}",
        f'  friendly_name: "{friendly}"',
        "",
        "esphome:",
        "  name: ${device_name}",
        "  friendly_name: ${friendly_name}",
        "  on_boot:",
        "    priority: -100",
        "    then:",
        "      - switch.turn_on: gc_pwr_led",
        _DIAG_ON_BOOT,  # boot counter for restart diagnostics (FR-S13)
        "",
        "esp32:",
        "  board: esp32dev",
        "  framework:",
        "    type: arduino",
        "",
        "logger:",
        "",
        "api:",
        "  reboot_timeout: 15min",
        "  encryption:",
        "    key: !secret api_encryption_key",
        *api_service,
        "",
        "web_server:",
        "  port: 80",
        "",
        "ota:",
        "  - platform: esphome",
        "    password: !secret ota_password",
        "",
        "wifi:",
        "  ssid: !secret wifi_ssid",
        "  password: !secret wifi_password",
        "  on_connect:",
        "    - switch.turn_on: gc_status_led",
        "  on_disconnect:",
        "    - switch.turn_off: gc_status_led",
        '  ap: { ssid: "${friendly_name} Fallback", password: !secret wifi_ap_password }',
        "",
        "captive_portal:",
        "",
        *_diag_globals(),  # boot counter for restart diagnostics (FR-S13)
        *_diag_button(),  # remote restart button (CR-0008)
        "# ─── I²C buses & expanders ──────────────────────────────────────────────",
        "i2c: { id: bus_a, sda: GPIO21, scl: GPIO22, scan: true }",
        "mcp23017:",
        "  - { id: mcp23017_top, address: 0x26, i2c_id: bus_a }",
        "  - { id: mcp23017_bot, address: 0x27, i2c_id: bus_a }",
        "pcf8574:",
        "  - { id: pcf8575, address: 0x24, pcf8575: true }",
        "ads1115:",
        "  - { address: 0x49 }",
        "",
        "# ─── Housekeeping switches (LEDs + power/sensor enables) ─────────────────",
        "switch:",
        "  - { platform: gpio, id: gc_status_led, pin: GPIO12, name: 'Status LED', internal: true }",
        "  - { platform: gpio, id: gc_error_led, pin: GPIO2, name: 'Error LED', internal: true }",
        "  - { platform: gpio, id: gc_pwr_led, internal: true, name: '24VAC LED',",
        "      pin: { pcf8574: pcf8575, number: 0, mode: { output: true }, inverted: true } }",
    ]
    # Power / sensor-supply enables (always on) — incl. the 24V supply for the 4-20mA loops.
    for name, exp, num in [
        ("5V enable", "mcp23017_top", 3), ("12V enable", "mcp23017_top", 4),
        ("24V enable", "mcp23017_top", 5), ("24V 4-20mA CH1 enable", "mcp23017_bot", 14),
        ("24V 4-20mA CH2 enable", "mcp23017_bot", 15),
    ]:
        L += [
            "  - platform: gpio",
            f'    name: "{name}"',
            "    restore_mode: ALWAYS_ON",
            f"    pin: {{ mcp23xxx: {exp}, number: {num}, mode: {{ output: true }}, inverted: false }}",
        ]
    # 12 valves + 2 relais (fixed board channels; names from config where mapped).
    co = _co_switch_map(box)  # ConnectedDevice/Shared-Pump (FR-E2)
    scripts: list[str] = []
    for c in range(1, _GC_VALVE_PINS + 1):
        ov = valves.get(c)
        sw, sc = _gc_output_block(ov, f"Ventil {c}", c - 1, 16 - c, f"gc_led_valve_{c}", co.get(ov.get("id")) if ov else None)
        L += sw
        scripts += sc
    for idx, rid in enumerate(_GC_PUMP_CHANNELS):  # R1→pin13/LED3, R2→pin12/LED2 (crossed pins)
        sw, sc = _gc_output_block(
            relais.get(rid), f"Relais {idx + 1}", _GC_RELAY_PIN[rid], _GC_RELAY_LED[rid],
            f"gc_led_relais_{idx + 1}",
        )
        L += sw
        scripts += sc
    if scripts:
        L += ["", "# ─── Emergency Shutdown timers (on-device, FR-E1) ───────────────────────", "script:", *scripts]
    # Binary inputs (BIN1–3): each is a binary_sensor (rain/switch) unless an S0 input
    # is assigned to it (then a pulse_counter, emitted in the sensor section below).
    bin_label = {"GPIO14": "BIN1", "GPIO16": "BIN2", "GPIO17": "BIN3"}
    # The binary_sensor block is always present (board self-diagnostics live here),
    # optionally preceded by the assigned rain/switch inputs.
    L += ["", "binary_sensor:"]
    if binary_pins:
        L += ["# ─── Binary inputs (rain / switch) ──────────────────────────────────────"]
        for pin in binary_pins:
            ip = inputs.get(pin) or {}
            nm = ascii_fold(ip.get("name") or bin_label[pin])
            # Rain reads on=wet via a forced pin inversion (FP-0001); a generic
            # button (FR-S14) honours its own `inverted` flag (default false).
            inv = "true" if ip.get("inverted") else "false" if ip.get("kind") == INPUT_BUTTON else "true"
            L += [
                "  - platform: gpio",
                f"    pin: {{ number: {pin}, inverted: {inv} }}",
                f'    name: "{nm}"',
                "    filters: [ { delayed_on: 10ms } ]",
            ]
    L += _gc_error_binsensors()  # supply-voltage + 4-20mA loop errors (roadmap #1)
    L += _gc_loop_underrange_binsensors(inputs)  # signal channel below 4 mA live-zero
    L += ["", "# ─── Analog inputs (4× ADC 0-12V + 2× 4-20mA) ───────────────────────────", "sensor:"]
    adc_label = {"GPIO32": "ADC1", "GPIO33": "ADC2", "GPIO34": "ADC3", "GPIO35": "ADC4"}
    for pin in _GC_ADC_PINS:
        inp = inputs.get(pin) or {}
        nm = ascii_fold(inp.get("name") or adc_label[pin])
        L += [
            "  - platform: adc",
            f"    pin: {pin}",
            f'    name: "{nm}"',
            "    attenuation: 11db",
            "    accuracy_decimals: 2",
            "    update_interval: 2s",
        ]
        sm = _smoothing_item(inp, 2)  # ADC update_interval 2 s
        if sm:  # board divider (×4 → 0-12 V) + optional moving average (FR-S16)
            L += _filters_block([["      - multiply: 4"], sm])
        else:
            L += ["    filters: [ { multiply: 4 } ]"]  # board divider → 0-12 V range
    # Terminal IN1 → ADS A1, IN2 → A0 (board crossing, see _GC_ADS_MUX). The
    # `multiply: 10` turns the volts across the 100 Ω shunt into mA (20 mA = 2.000 V,
    # exactly the gain: 2.048 full scale).
    for term in _GC_ADS_CHANNELS:
        inp = inputs.get(term) or {}
        nm = ascii_fold(inp.get("name") or term)
        L += [
            "  - platform: ads1115",
            f"    multiplexer: {_GC_ADS_MUX[term]}_GND",
            "    gain: 2.048",
            f"    id: {_GC_ADS_ID[term]}",
            f'    name: "{nm}"',
            '    unit_of_measurement: "mA"',
            "    device_class: current",
            "    accuracy_decimals: 1",
            "    update_interval: 3s",
        ]
        sm = _smoothing_item(inp, 3)  # ADS update_interval 3 s
        if sm:  # 100 Ω shunt V→mA (×10) + optional moving average (FR-S16)
            L += _filters_block([["      - multiply: 10"], sm])
        else:
            L += ["    filters: [ { multiply: 10 } ]"]
    # S0 / pulse counters (on whichever binary inputs an S0 meter is assigned to).
    for pin in pulse_pins:
        nm = ascii_fold((inputs.get(pin) or {}).get("name") or "S0 Zähler")
        L += [
            "  - platform: pulse_counter",
            f"    pin: {pin}",
            f"    use_pcnt: {_PULSE_USE_PCNT}",  # CR-0001: SW counter, no PCNT 13µs cap
            f"    internal_filter: {_PULSE_INTERNAL_FILTER}",
            f"    update_interval: {_PULSE_UPDATE_INTERVAL}",  # CR-0004: current enough for run deltas
            f"    id: {s0_id[pin]}",
            f'    name: "{nm}"',
            "    unit_of_measurement: pulses",
            '    total: { name: "' + nm + ' total" }',
        ]
    L += _gc_loop_error_adc_sensors()  # raw A2/A3 loop-error voltages (roadmap #1)
    L += _diag_sensor_entries()  # WLAN + boot counter (FR-S13)
    L += _gc_error_led_interval()  # drive Error-LED from supply/loop faults (roadmap #1)
    return "\n".join(L).rstrip() + "\n"


# --- public API ---------------------------------------------------------------
def _base_yaml(box: dict[str, Any], base: str | None = None) -> str:
    """The hardware-only YAML **without** the ``project:`` block — the stable
    input the config hash is computed over (no circularity, roadmap #9a)."""
    hw_type = box.get("hw_type")
    if base is None:
        if hw_type == HW_GARDENCONTROL:
            base = "gardencontrol"
        elif hw_type == HW_ESP32_WROOM:
            base = "generic"
        else:
            raise YamlGenError(f"Unknown hw_type: {hw_type!r}")
    if base == "gardencontrol":
        return _generate_gardencontrol(box)  # full board-accurate template
    # Generic / custom platforms — free GPIO per output/input (ESP32-WROOM template).
    hw = HW_ESP32_WROOM
    lines = _header(box)
    lines += _diag_globals()  # boot counter for restart diagnostics (FR-S13)
    lines += _diag_button()  # remote restart button (CR-0008)
    lines += _switches(box, hw)
    lines += _scripts(box)
    lines += _sensors(box, hw)  # input sensors + WLAN/boot-count diagnostics
    return "\n".join(lines).rstrip() + "\n"


def _hash(yaml: str) -> str:
    """Short, stable fingerprint of a YAML string (12 hex of SHA-256)."""
    return hashlib.sha256(yaml.encode("utf-8")).hexdigest()[:12]


def _inject_project(yaml: str, version: str) -> str:
    """Embed ``esphome: project: {name, version}`` right after ``friendly_name``
    so the flashed device reports ``version`` back to HA as ``sw_version`` (#9b)."""
    block = f"  project:\n    name: {PROJECT_NAME}\n    version: \"{version}\""
    return yaml.replace(_FRIENDLY_MARKER, f"{_FRIENDLY_MARKER}\n{block}", 1)


def box_config_hash(box: dict[str, Any], base: str | None = None) -> str:
    """The firmware-relevant config fingerprint for ``box`` (drift detection #9).

    Computed over the YAML **without** the project block — so embedding it is not
    circular — and equal to the value the flashed device reports back to HA via
    ``project.version``. The caller must pass the same (pump-enriched) box dict it
    feeds to :func:`generate_box_yaml`, so the hash reflects the actual firmware."""
    return _hash(_base_yaml(box, base))


def generate_box_yaml(box: dict[str, Any], base: str | None = None) -> str:
    """Return the hardware-only ESPHome YAML for ``box`` (a box storage dict).

    ``base`` selects the template family: ``"gardencontrol"`` (fixed MCP/ADS
    profile) or ``"generic"`` (ESP32-WROOM / custom — free GPIO per output/input).
    Custom platforms pass ``base="generic"``. When ``base`` is omitted it is
    derived from ``hw_type`` (``gardencontrol``/``esp32_wroom``); an unknown
    ``hw_type`` then raises. Also raises when a box exceeds its template.

    The emitted YAML carries an ``esphome: project:`` block whose ``version`` is
    :func:`box_config_hash` — the flashed device echoes it back as ``sw_version``
    for firmware-drift detection (roadmap #9).
    """
    yaml = _base_yaml(box, base)
    return _inject_project(yaml, _hash(yaml))
