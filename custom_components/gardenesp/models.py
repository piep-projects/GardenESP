"""Typed data model for GardenESP.

Mirrors the storage schema in docs/fds.md §4 / §9.4. These dataclasses are the
in-memory representation the coordinator works with; (de)serialisation to the
``gardenesp.config`` store is handled here.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any


def _filter(cls: type, data: dict[str, Any]) -> dict[str, Any]:
    """Keep only keys that are fields of ``cls`` (forward-compatible loading)."""
    names = {f.name for f in dataclasses.fields(cls)}
    return {k: v for k, v in data.items() if k in names}


@dataclass(slots=True)
class Output:
    """A switchable output (valve or pump) — FDS §4.1 ``outputs``."""

    id: str
    type: str  # OUTPUT_VALVE | OUTPUT_PUMP
    name: str
    channel: str = ""  # short channel — the A5 id (GardenControl also → fixed pin)
    gpio: str = ""  # generic boxes: actual ESP GPIO driving the YAML pin (FDS §4.1)
    connected: list[str] = field(default_factory=list)  # extra outputs co-switched (FR-E2)
    emergency_shutdown_min: int = 0
    relais_off: str = "HIGH"  # HIGH = active-low module
    entity: str | None = None  # ESPHome switch.* entity_id

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Output":
        return cls(**_filter(cls, data))


@dataclass(slots=True)
class Input:
    """A sensor input — FDS §4.1 ``inputs``."""

    id: str
    kind: str  # INPUT_PRESSURE | INPUT_SOIL_MOISTURE | INPUT_RAIN | INPUT_PULSE_METER | INPUT_BUTTON
    name: str
    pin: str = ""  # physical pin / ADS channel — drives the ESPHome pin (FDS §4.1)
    inverted: bool = False  # (rain/button) NO/NC wiring — pin inversion at the ESPHome pin
    threshold_pct: int = 0  # (soil) ab hier „feucht genug" → Sperre
    smoothing_s: int = 0  # (analog: pressure/soil) on-device moving-average window in seconds; 0 = off (FR-S16)
    entity: str | None = None  # ESPHome sensor.*/binary_sensor.* entity_id
    calibration: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Input":
        return cls(**_filter(cls, data))


@dataclass(slots=True)
class Box:
    """An ESP controller — FDS §4.1."""

    id: str
    name: str
    hw_type: str
    label: str = ""  # short box id (A, B, …) — prefix of the A5 line id (FDS §4.1)
    enabled: bool = True  # deactivated box = fully out of service (no schedule/run, sensors ignored)
    outputs: list[Output] = field(default_factory=list)
    inputs: list[Input] = field(default_factory=list)
    # Last config hash the admin exported (copy/download YAML) — fallback drift
    # signal when the box is offline / never reported project.version (roadmap #9c).
    exported_yaml_hash: str | None = None
    created_at: str | None = None  # ISO-8601 UTC, set on first upsert (FR-S11)
    updated_at: str | None = None  # ISO-8601 UTC, refreshed on every upsert

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Box":
        base = _filter(cls, data)
        base["outputs"] = [Output.from_dict(o) for o in data.get("outputs", [])]
        base["inputs"] = [Input.from_dict(i) for i in data.get("inputs", [])]
        return cls(**base)


@dataclass(slots=True)
class ScheduleEntry:
    """One schedule entry — FDS §4.4. Each entry is a single start ``time`` with
    its own ``duration_min``; multiple times/durations = multiple entries."""

    repeat: str  # daily | weekly | monthly
    time: str = ""  # single "HH:MM" start time
    duration_min: int = 0  # per-entry run duration
    weekdays: list[str] = field(default_factory=list)  # weekly: mo|tu|we|th|fr|sa|su
    monthdays: list[int] = field(default_factory=list)
    enabled: bool = True  # disabled entries are kept but never scheduled (FR-S2a)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScheduleEntry":
        return cls(**_filter(cls, data))


@dataclass(slots=True)
class Line:
    """An irrigation line — or a generic switched output (Steuerung) — FDS §4.2.

    ``kind`` distinguishes the two: ``irrigation`` (default) uses a water source,
    sensor gates and consumption logging; ``switch`` is a bare scheduled on/off
    output (fountain, camera, …) that shares the run engine but skips all of that.
    """

    id: str
    name: str
    box_id: str
    valve_output: str
    kind: str = "irrigation"  # LINE_KIND_IRRIGATION | LINE_KIND_SWITCH
    show_on_dashboard: bool = True  # (switch) show in the dashboard's Steuerungen group
    source_id: str | None = None
    automatic: bool = True
    sensor_input: str | None = None  # ref to a rain/soil box input ("{box_id}#{input_id}")
    sensor_override: bool = False
    manual_skip_settle: bool = False  # manual draw (hose): skip the source settle/measurement
    manual_default_min: float = 0  # minutes; fractional allowed (e.g. 0.3 = 18 s)
    seq: int = 0  # box-scoped Linien-ID number → L<n>; assigned once, stable (FDS §3)
    schedule: list[ScheduleEntry] = field(default_factory=list)
    created_at: str | None = None  # ISO-8601 UTC, set on first upsert (FR-S11)
    updated_at: str | None = None  # ISO-8601 UTC, refreshed on every upsert

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Line":
        base = _filter(cls, data)
        base["schedule"] = [ScheduleEntry.from_dict(s) for s in data.get("schedule", [])]
        return cls(**base)


@dataclass(slots=True)
class Source:
    """A water source — FDS §4.3."""

    id: str
    name: str
    type: str  # SOURCE_CISTERN | SOURCE_MAINS
    level_input: str | None = None
    multiplier: float = 1.0
    offset: float = 0.0
    calibration_points: list[dict[str, Any]] = field(default_factory=list)
    max_volume_l: int = 0
    min_fill_pct: int = 0
    pump_output: str | None = None
    tank_settle_min: int = 0
    meter_input: str | None = None
    pulse_factor: float = 1.0
    created_at: str | None = None  # ISO-8601 UTC, set on first upsert (FR-S11)
    updated_at: str | None = None  # ISO-8601 UTC, refreshed on every upsert

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Source":
        return cls(**_filter(cls, data))


@dataclass(slots=True)
class IrrigationConfig:
    """Full configuration container (the ``gardenesp.config`` store, FDS §9.4)."""

    boxes: dict[str, Box] = field(default_factory=dict)
    sources: dict[str, Source] = field(default_factory=dict)
    lines: dict[str, Line] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)  # global settings (e.g. history_months)

    @classmethod
    def from_storage(cls, data: dict[str, Any] | None) -> "IrrigationConfig":
        data = data or {}
        return cls(
            boxes={k: Box.from_dict(v) for k, v in data.get("boxes", {}).items()},
            sources={k: Source.from_dict(v) for k, v in data.get("sources", {}).items()},
            lines={k: Line.from_dict(v) for k, v in data.get("lines", {}).items()},
            settings=dict(data.get("settings", {})),
        )

    def to_storage(self) -> dict[str, Any]:
        return {
            "boxes": {k: dataclasses.asdict(v) for k, v in self.boxes.items()},
            "sources": {k: dataclasses.asdict(v) for k, v in self.sources.items()},
            "lines": {k: dataclasses.asdict(v) for k, v in self.lines.items()},
            "settings": dict(self.settings),
        }
