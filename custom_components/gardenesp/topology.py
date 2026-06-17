"""Topology lens (Roadmap #7, Variante A) — pure, no HA imports.

Derives, **per water source**, the hydraulic strand
``Sensor → Pumpe (+ verbundene Ventile) → Ventil → Linie`` from the stored
config (``IrrigationConfig.to_storage()`` dict). Read-only **projection** — nothing
is stored (avoids drift, FDS §9.4). The output is JSON-serialisable and feeds the
panel's „Topologie"-Tab.

Works on the plain storage dict (not the dataclasses) so it stays importable
standalone for the unit tests, like the other pure modules.
"""

from __future__ import annotations

from typing import Any

KIND_SWITCH = "switch"


def _split(ref: str | None) -> tuple[str | None, str | None]:
    """Split an output/input ref ``"{box_id}#{local}"`` → ``(box_id, local)``."""
    if not ref or "#" not in ref:
        return None, None
    box_id, local = ref.split("#", 1)
    return box_id, local


def _box(config: dict[str, Any], box_id: str | None) -> dict[str, Any] | None:
    if not box_id:
        return None
    return config.get("boxes", {}).get(box_id)


def _output(config: dict[str, Any], ref: str | None) -> dict[str, Any] | None:
    box_id, local = _split(ref)
    box = _box(config, box_id)
    if not box:
        return None
    return next((o for o in box.get("outputs", []) if o.get("id") == local), None)


def _input(config: dict[str, Any], ref: str | None) -> dict[str, Any] | None:
    box_id, local = _split(ref)
    box = _box(config, box_id)
    if not box:
        return None
    return next((i for i in box.get("inputs", []) if i.get("id") == local), None)


def _box_label(config: dict[str, Any], box_id: str | None) -> str:
    box = _box(config, box_id)
    return (box or {}).get("label") or "?"


def short_id(config: dict[str, Any], ref: str | None) -> str:
    """Ausgang-ID ``A5`` = ``box.label`` + ``output.channel`` (FDS §3)."""
    box_id, _ = _split(ref)
    out = _output(config, ref)
    label = _box_label(config, box_id)
    channel = (out or {}).get("channel")
    return f"{label}{channel}" if out and channel else label


def line_id(line: dict[str, Any]) -> str:
    """Linien-ID ``L<n>`` from the stable box-scoped ``seq`` (FDS §3); empty for
    switch lines (Steuerungen carry their Ausgang-ID instead)."""
    seq = line.get("seq") or 0
    return f"L{seq}" if seq and line.get("kind") != KIND_SWITCH else ""


def _output_view(config: dict[str, Any], ref: str | None) -> dict[str, Any] | None:
    out = _output(config, ref)
    if not out:
        return None
    return {
        "ref": ref,
        "short_id": short_id(config, ref),
        "name": (out.get("name") or "").strip() or out.get("id"),
        "channel": out.get("channel", ""),
        "gpio": out.get("gpio", ""),
        "emergency_min": out.get("emergency_shutdown_min", 0),
    }


def _source_box_id(source: dict[str, Any]) -> str | None:
    """The hardware box a source lives on — pump first, then sensor refs."""
    for key in ("pump_output", "level_input", "meter_input"):
        box_id, _ = _split(source.get(key))
        if box_id:
            return box_id
    return None


def build(config: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return one strand per water source (insertion order):

    ``{source: {...sensor...}, pump: {...connected...}|None, valves: [{output, line}]}``
    """
    config = config or {}
    sources = config.get("sources", {})
    lines = config.get("lines", {})
    strands: list[dict[str, Any]] = []

    for sid, source in sources.items():
        box_id = _source_box_id(source)

        # Sensor: cistern → level_input (pressure), mains → meter_input (pulse).
        sensor_ref = source.get("level_input") or source.get("meter_input")
        sensor_in = _input(config, sensor_ref)
        sensor = (
            {
                "name": (sensor_in.get("name") or "").strip() or sensor_in.get("id"),
                "pin": sensor_in.get("pin", ""),
                "kind": sensor_in.get("kind", ""),
            }
            if sensor_in
            else None
        )

        # Pump (+ co-switched connected valves, e.g. a pre-/master valve, FR-E2).
        pump = _output_view(config, source.get("pump_output"))
        if pump:
            pump_box_id, _ = _split(source.get("pump_output"))
            out = _output(config, source.get("pump_output")) or {}
            pump["connected"] = [
                cv
                for cid in out.get("connected", [])
                if (cv := _output_view(config, f"{pump_box_id}#{cid}"))
            ]

        # Valves = irrigation lines drawing from this source, by stable L-number.
        src_lines = [
            ln
            for ln in lines.values()
            if ln.get("kind") != KIND_SWITCH and ln.get("source_id") == sid
        ]
        src_lines.sort(key=lambda ln: (ln.get("seq") or 0, (ln.get("name") or "")))
        valves = []
        for ln in src_lines:
            sensor_inp = _input(config, ln.get("sensor_input"))
            valves.append(
                {
                    "output": _output_view(config, ln.get("valve_output")),
                    "line": {
                        "id": ln.get("id"),
                        "line_id": line_id(ln),
                        "name": ln.get("name") or ln.get("id"),
                        "automatic": bool(ln.get("automatic", True)),
                        "sensor_name": (sensor_inp.get("name") if sensor_inp else ""),
                    },
                }
            )

        strands.append(
            {
                "source": {
                    "id": sid,
                    "name": source.get("name") or sid,
                    "type": source.get("type", ""),
                    "box_id": box_id,
                    "box_label": _box_label(config, box_id) if box_id else "",
                    "min_fill_pct": source.get("min_fill_pct", 0),
                    "max_volume_l": source.get("max_volume_l", 0),
                    "sensor": sensor,
                },
                "pump": pump,
                "valves": valves,
            }
        )

    return strands
