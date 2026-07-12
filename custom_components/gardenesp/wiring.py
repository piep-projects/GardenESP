"""Wiring lens (Verdrahtungs-Hilfe) — pure, no HA imports.

Projects a **box's outputs/inputs onto a physical board pinout** so the user gets a
print-ready wiring diagram (which device goes to which GPIO + GND). Read-only
**projection** of the stored config — nothing is stored (avoids drift, like
``topology.py`` / FDS §9.4).

Phase 1 supports the **ESP32-WROOM-32 DevKitC v4 (38-pin)** board only; GardenControl
(screw-terminal board behind MCP23017/PCF8575) returns ``supported: False`` with a
placeholder until its terminal-block renderer is built.

Works on the plain storage dict (not the dataclasses) so it stays importable
standalone for the unit tests, like the other pure modules. The pin *pools* used for
the order/channel fallback are imported from ``esphome_yaml`` (single source) so the
diagram shows exactly what the generator would flash.
"""

from __future__ import annotations

from typing import Any

try:  # package import in HA; flat import in the standalone unit tests (_path shim)
    from .esphome_yaml import (
        _WROOM_ADC_PINS,
        _WROOM_BINARY_PINS,
        _WROOM_OUTPUT_PINS,
        _WROOM_PULSE_PIN,
        gc_input_pin,
    )
except ImportError:  # pragma: no cover
    from esphome_yaml import (  # type: ignore[no-redef]
        _WROOM_ADC_PINS,
        _WROOM_BINARY_PINS,
        _WROOM_OUTPUT_PINS,
        _WROOM_PULSE_PIN,
        gc_input_pin,
    )

HW_WROOM = "esp32_wroom"
HW_GARDENCONTROL = "gardencontrol"

# --- pin capabilities ---------------------------------------------------------
CAP_POWER = "power"          # 3V3 / 5V / EN / GND — not a usable signal pin
CAP_IO = "io"                # freely usable digital GPIO
CAP_INPUT_ONLY = "input_only"  # GPIO34-39 — read-only (no output/pullup)
CAP_STRAPPING = "strapping"  # GPIO0/2/5/12/15 — usable with boot-time caveats
CAP_UART = "uart"            # GPIO1/3 (TX0/RX0) — serial console: logger drives the pin + boot glitches
CAP_FORBIDDEN = "forbidden"  # GPIO6-11 — wired to the SPI flash, do not use


def _pad(side: str, pin: int, gpio: int | None, label: str, cap: str) -> dict[str, Any]:
    return {"side": side, "pin": pin, "gpio": gpio, "label": label, "cap": cap}


# ESP32-WROOM-32 DevKitC v4, 38-pin. USB at the **bottom**; pins numbered 1 (bottom)
# → 19 (top) on each side, matching the physical board when held USB-down. Order and
# labels follow the official Espressif DevKitC-V4 pinout.
WROOM_DEVKITC_38: list[dict[str, Any]] = [
    # left column, bottom → top
    _pad("left", 1, None, "5V", CAP_POWER),
    _pad("left", 2, 11, "GPIO11 (CMD)", CAP_FORBIDDEN),
    _pad("left", 3, 10, "GPIO10 (SD3)", CAP_FORBIDDEN),
    _pad("left", 4, 9, "GPIO9 (SD2)", CAP_FORBIDDEN),
    _pad("left", 5, 13, "GPIO13", CAP_IO),
    _pad("left", 6, None, "GND", CAP_POWER),
    _pad("left", 7, 12, "GPIO12", CAP_STRAPPING),
    _pad("left", 8, 14, "GPIO14", CAP_IO),
    _pad("left", 9, 27, "GPIO27", CAP_IO),
    _pad("left", 10, 26, "GPIO26", CAP_IO),
    _pad("left", 11, 25, "GPIO25", CAP_IO),
    _pad("left", 12, 33, "GPIO33", CAP_IO),
    _pad("left", 13, 32, "GPIO32", CAP_IO),
    _pad("left", 14, 35, "GPIO35", CAP_INPUT_ONLY),
    _pad("left", 15, 34, "GPIO34", CAP_INPUT_ONLY),
    _pad("left", 16, 39, "GPIO39 (VN)", CAP_INPUT_ONLY),
    _pad("left", 17, 36, "GPIO36 (VP)", CAP_INPUT_ONLY),
    _pad("left", 18, None, "EN", CAP_POWER),
    _pad("left", 19, None, "3V3", CAP_POWER),
    # right column, bottom → top
    _pad("right", 1, 6, "GPIO6 (CLK)", CAP_FORBIDDEN),
    _pad("right", 2, 7, "GPIO7 (SD0)", CAP_FORBIDDEN),
    _pad("right", 3, 8, "GPIO8 (SD1)", CAP_FORBIDDEN),
    _pad("right", 4, 15, "GPIO15", CAP_STRAPPING),
    _pad("right", 5, 2, "GPIO2", CAP_STRAPPING),
    _pad("right", 6, 0, "GPIO0", CAP_STRAPPING),
    _pad("right", 7, 4, "GPIO4", CAP_IO),
    _pad("right", 8, 16, "GPIO16", CAP_IO),
    _pad("right", 9, 17, "GPIO17", CAP_IO),
    _pad("right", 10, 5, "GPIO5", CAP_STRAPPING),
    _pad("right", 11, 18, "GPIO18", CAP_IO),
    _pad("right", 12, 19, "GPIO19", CAP_IO),
    _pad("right", 13, None, "GND", CAP_POWER),
    _pad("right", 14, 21, "GPIO21", CAP_IO),
    _pad("right", 15, 3, "GPIO3 (RX0)", CAP_UART),
    _pad("right", 16, 1, "GPIO1 (TX0)", CAP_UART),
    _pad("right", 17, 22, "GPIO22", CAP_IO),
    _pad("right", 18, 23, "GPIO23", CAP_IO),
    _pad("right", 19, None, "GND", CAP_POWER),
]


def _gpio_num(value: Any) -> int | None:
    """Normalise ``"GPIO16"`` / ``"16"`` / ``16`` → ``16``; non-GPIO refs → None."""
    s = str(value or "").strip().upper()
    if s.startswith("GPIO"):
        s = s[4:]
    s = s.strip()
    return int(s) if s.isdigit() else None


# Input kind → WROOM default pin pool (mirrors esphome_yaml's generic branch); used
# only when an input carries no explicit ``pin``.
_INPUT_POOLS = {
    "pressure": _WROOM_ADC_PINS,
    "soil_moisture": _WROOM_ADC_PINS,
    "rain": _WROOM_BINARY_PINS,
    "pulse_meter": [_WROOM_PULSE_PIN],
    "button": _WROOM_BINARY_PINS,  # generic Taster/Schalter (FR-S14)
}

# GardenControl is a fixed screw-terminal board (no free GPIO): inputs map onto
# printed terminal labels by their ``pin``. Labels match the board silkscreen;
# mirrors ``GC_PIN_LABEL`` in the panel editor. 4-20 mA inputs already *are* the
# terminal label (``gc_input_pin`` folds the legacy ``A0``/``A1`` keys).
_GC_INPUT_TERMINAL = {
    "IN1": "IN1", "IN2": "IN2",
    "GPIO14": "BIN1", "GPIO16": "BIN2", "GPIO17": "BIN3",
    "GPIO32": "ADC1", "GPIO33": "ADC2", "GPIO34": "ADC3", "GPIO35": "ADC4",
}


def _output_gpio(output: dict[str, Any], order_idx: list[int]) -> int | None:
    """The GPIO an output drives, mirroring ``esphome_yaml._wroom_output_pin``:
    explicit ``gpio`` wins, else pool slot by 1-based ``channel``, else next free."""
    gpio = _gpio_num(output.get("gpio"))
    if gpio is not None:
        return gpio
    channel = str(output.get("channel") or "").strip()
    if channel.isdigit() and 1 <= int(channel) <= len(_WROOM_OUTPUT_PINS):
        return _gpio_num(_WROOM_OUTPUT_PINS[int(channel) - 1])
    n = order_idx[0]
    order_idx[0] += 1
    if n < len(_WROOM_OUTPUT_PINS):
        return _gpio_num(_WROOM_OUTPUT_PINS[n])
    return None


def _input_gpio(inp: dict[str, Any], order_idx: dict[str, int]) -> int | None:
    """The GPIO an input reads, explicit ``pin`` first, else the kind's pool order."""
    gpio = _gpio_num(inp.get("pin"))
    if gpio is not None:
        return gpio
    pool = _INPUT_POOLS.get(inp.get("kind") or "", [])
    key = inp.get("kind") or "?"
    n = order_idx.get(key, 0)
    order_idx[key] = n + 1
    return _gpio_num(pool[n]) if n < len(pool) else None


def _empty(box_view: dict[str, Any] | None, notes: list[str]) -> dict[str, Any]:
    """Unsupported/placeholder result with the full (empty) key set."""
    return {
        "box": box_view, "supported": False, "layout": None,
        "pins": [], "groups": [], "devices": [], "gnd_pins": [], "notes": notes,
    }


def build(config: dict[str, Any] | None, box_id: str) -> dict[str, Any]:
    """Return the wiring projection for one box.

    Always carries ``{box, supported, layout, pins[], groups[], devices[],
    gnd_pins[], notes[]}``. ``layout`` selects the renderer: ``"pinout"`` (WROOM —
    a 38-pin header diagram in ``pins``) or ``"terminals"`` (GardenControl — a
    screw-terminal plan in ``groups``). Read-only projection of the stored config.
    """
    config = config or {}
    box = (config.get("boxes") or {}).get(box_id)
    if not box:
        return _empty(None, [])

    box_view = {
        "id": box_id,
        "label": box.get("label") or "",
        "name": box.get("name") or box_id,
        "hw_type": box.get("hw_type") or "",
    }

    if box.get("hw_type") == HW_WROOM:
        return _build_wroom(box, box_view)
    if box.get("hw_type") == HW_GARDENCONTROL:
        return _build_gardencontrol(box, box_view)
    return _empty(box_view, ["Verdrahtungsdiagramm aktuell nur für ESP32-WROOM und GardenControl verfügbar."])


def _build_wroom(box: dict[str, Any], box_view: dict[str, Any]) -> dict[str, Any]:
    """ESP32-WROOM-32 DevKitC: 38-pin header diagram (``layout="pinout"``)."""
    # Build the GPIO → device assignment map (and the right-hand device list).
    assign: dict[int, dict[str, Any]] = {}
    devices: list[dict[str, Any]] = []
    out_idx = [0]
    label = box_view["label"]
    for o in box.get("outputs") or []:
        gpio = _output_gpio(o, out_idx)
        channel = str(o.get("channel") or "").strip()
        dev = {
            "name": (o.get("name") or "").strip() or o.get("id"),
            "role": o.get("type") or "output",
            "kind": "output",
            "gpio": gpio,
            "short_id": f"{label}{channel}" if label and channel else "",  # Ausgang-ID A5 (FDS §3)
        }
        devices.append(dev)
        if gpio is not None and gpio not in assign:
            assign[gpio] = dev
    in_idx: dict[str, int] = {}
    for i in box.get("inputs") or []:
        gpio = _input_gpio(i, in_idx)
        dev = {
            "name": (i.get("name") or "").strip() or i.get("id"),
            "role": "sensor",
            "kind": i.get("kind") or "input",
            "gpio": gpio,
            "short_id": "",  # inputs have no Ausgang-ID
        }
        devices.append(dev)
        if gpio is not None and gpio not in assign:
            assign[gpio] = dev

    pins = []
    for p in WROOM_DEVKITC_38:
        a = assign.get(p["gpio"]) if p["gpio"] is not None else None
        pins.append({**p, "assignment": ({"name": a["name"], "role": a["role"], "kind": a["kind"]} if a else None)})

    gnd_pins = [
        {"side": p["side"], "pin": p["pin"]}
        for p in WROOM_DEVKITC_38
        if p["cap"] == CAP_POWER and p["label"] == "GND"
    ]

    notes = [
        "GND jedes Geräts an einen beliebigen GND-Pad (markiert).",
        "Ventile/Pumpen laufen über Relais/24 VAC — hier ist nur die Steuerleitung (GPIO) gezeigt.",
        "Diagramm ist eine Verdrahtungs-Hilfe (Vorschlag), kein Abbild der konkreten Platine.",
    ]
    return {
        "box": box_view, "supported": True, "layout": "pinout",
        "pins": pins, "groups": [], "devices": devices, "gnd_pins": gnd_pins, "notes": notes,
    }


def _build_gardencontrol(box: dict[str, Any], box_view: dict[str, Any]) -> dict[str, Any]:
    """GardenControl: fixed screw-terminal plan (``layout="terminals"``).

    Outputs land on ``CH1–12`` (valves) / ``Relais1·2`` (pumps & ``other``) by
    ``channel``; inputs on ``IN1/2`` · ``BIN1-3`` · ``ADC1-4`` by ``pin``
    (``_GC_INPUT_TERMINAL``). Labels follow the Smart-MF README diagrams.
    """
    label = box_view["label"]
    # Outputs → board silkscreen terminal: valves on V1–V12, pumps/other on R1/R2.
    out_by_term: dict[str, dict[str, Any]] = {}
    for o in box.get("outputs") or []:
        ch = str(o.get("channel") or "").strip()
        if ch.upper() in ("R1", "R2"):
            term = ch.upper()
        elif ch.isdigit():
            term = "V" + ch
        else:
            continue
        out_by_term.setdefault(term, {
            "name": (o.get("name") or "").strip() or o.get("id"),
            "role": o.get("type") or "output",
            "kind": "output",
            "short_id": f"{label}{ch}" if label and ch else "",  # Ausgang-ID A5 (FDS §3)
            # Shared return is COM for *both* valves and relay coils: COM is one pole
            # of the 24 VAC transformer, the board switches the other onto Vn/Rn (see
            # the vendor's AnschlussRelais diagram — the coil's second wire lands on a
            # COM screw, not on the 24VAC feed-in). Relay contact/load side not drawn.
            "ret": "COM",
        })
    in_by_term: dict[str, dict[str, Any]] = {}
    for i in box.get("inputs") or []:
        term = _GC_INPUT_TERMINAL.get(gc_input_pin(i.get("pin")))
        if not term:
            continue
        # return/supply pairing: 4-20 mA loop (IN) needs its adjacent VCC supply pad
        # (24 V DC), 0-12 V analog (ADC) needs GND; binary inputs (BIN) draw no return.
        ret = "VCC" if term in ("IN1", "IN2") else ("GND" if term.startswith("ADC") else "")
        in_by_term.setdefault(term, {
            "name": (i.get("name") or "").strip() or i.get("id"),
            "role": "sensor",
            "kind": i.get("kind") or "input",
            "short_id": "",
            "ret": ret,
        })

    def _c(lbl: str, fn: str, power: bool = False) -> dict[str, Any]:
        """One terminal cell; power pads carry no assignment, blanks have empty label."""
        a = None if (power or not lbl) else (out_by_term.get(lbl) or in_by_term.get(lbl))
        return {"label": lbl, "fn": fn, "power": power, "assignment": a}

    # Exact board grid (photo silkscreen). Two stacked terminal rows on the TOP edge
    # (each split into a left + right 6-way block) and one valve row on the BOTTOM.
    grid = {
        "top_upper": [
            _c("IN1", "4-20 mA Signal 1"), _c("VCC", "Sensor-Versorgung (24 V DC)", True),
            _c("IN2", "4-20 mA Signal 2"), _c("VCC", "Sensor-Versorgung (24 V DC)", True),
            _c("COM", "Ventil-COM", True), _c("COM", "Ventil-COM", True),
            _c("COM", "Ventil-COM", True), _c("COM", "Ventil-COM", True),
            # Field-verified board order: R2 sits LEFT of R1. The silkscreen print is
            # reversed vs the pin naming (R2 = MCP pin 13, R1 = pin 12); LED/function
            # are correct, only the printed label is swapped. Match the real board so
            # the lens points at the right screw.
            _c("R2", "Relais 2 (24 VAC-Ausgang → Koppelrelais)"),
            _c("R1", "Relais 1 (24 VAC-Ausgang → Koppelrelais)"),
            _c("24VAC", "Versorgung 24 VAC", True), _c("24VAC", "Versorgung 24 VAC", True),
        ],
        "top_lower": [
            _c("VCC", "Sensor-Versorgung", True), _c("BIN1", "Binär 24 V (Regen/S0/Schalter)"),
            _c("BIN2", "Binär 24 V (Regen/S0/Schalter)"), _c("BIN3", "Binär 24 V (Regen/S0/Schalter)"),
            _c("+24V", "Sensor-Versorgung", True), _c("+12V", "Sensor-Versorgung", True),
            _c("+5V", "Sensor-Versorgung", True), _c("ADC1", "Analog 0–12 V"),
            _c("ADC2", "Analog 0–12 V"), _c("ADC3", "Analog 0–12 V"),
            _c("ADC4", "Analog 0–12 V"), _c("GND", "Masse", True),
        ],
        "bottom": [_c(f"V{n}", f"Ventil {n} (24 VAC)") for n in range(1, 13)],
    }

    # Mark the shared return/supply rails that are actually in use so the renderer can
    # draw a bus + emphasise the pads: valves **and relay coils**→COM, 4-20 mA IN→VCC,
    # 0-12 V ADC→GND. ``active`` gates the emphasis; unused rails stay neutral.
    # 24VAC is the transformer feed-in, never a load return → no rail.
    any_valve = any(c["assignment"] for c in grid["bottom"])
    any_relay = "R1" in out_by_term or "R2" in out_by_term
    any_adc = any(t in in_by_term for t in ("ADC1", "ADC2", "ADC3", "ADC4"))
    rail_kind = {"COM": "com", "GND": "gnd"}
    rail_active = {"COM": any_valve or any_relay, "GND": any_adc}
    for c in grid["top_upper"] + grid["top_lower"]:
        if c["label"] in rail_kind:
            c["rail"] = rail_kind[c["label"]]
            c["active"] = rail_active[c["label"]]
    # The two IN supply pads pair with their adjacent IN1/IN2 by position. They carry
    # the silkscreen label VCC — as does the BIN supply pad at top_lower[0], so the
    # renderer must pick the pad by row+proximity, not by label alone.
    grid["top_upper"][1]["rail"] = grid["top_upper"][3]["rail"] = "insupply"
    grid["top_upper"][1]["active"] = "IN1" in in_by_term
    grid["top_upper"][3]["active"] = "IN2" in in_by_term

    devices = [c["assignment"] for col in grid.values() for c in col if c["assignment"]]
    notes = [
        "Klemmenplan nach dem echten GardenControl-Board (Silkscreen-Labels).",
        "Ventile V1–V12: geschaltete Ader an Vn, gemeinsamer Rückleiter an COM (Sammelschiene).",
        "Relais R1/R2 (Koppelrelais): Spule an Relais-Ausgang + COM (wie ein Ventil); die "
        "beiden 24VAC-Klemmen sind die Trafo-Einspeisung, kein Anschlusspunkt für die Spule. "
        "Die potentialfreie Kontaktseite (z. B. 230-V-Pumpe) ist NICHT dargestellt — "
        "extern, Elektrofachkraft.",
        "4-20-mA-Sensoren an IN1/IN2: 2-Draht — Signal an INx, Versorgung (+) an das "
        "nebenstehende VCC (24 V DC). Kein GND (Stromschleife schließt intern).",
        "Analog-/DC-Sensoren an ADC1–4 (0–12 V): Sensor-Minus/GND an die GND-Klemme, "
        "Versorgung von +5V/+12V/+24V.",
        "BIN1–3 = Binär 24 V (Regen/S0/Schalter). Versorgung: 24-VAC-Trafo (≥ 3 A), externe "
        "3-A-Sicherung Pflicht.",
    ]
    return {
        "box": box_view, "supported": True, "layout": "terminals",
        "pins": [], "grid": grid, "groups": [], "devices": devices, "gnd_pins": [], "notes": notes,
    }
