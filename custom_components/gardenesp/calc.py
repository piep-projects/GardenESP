"""Pure level/consumption maths — FDS §5.3/§5.7 (FR-S5a, FR-L1/L2).

No Home Assistant imports — unit-testable standalone.
"""

from __future__ import annotations

from typing import Any


def liters_from_pressure(
    pressure: float,
    multiplier: float,
    offset: float,
    max_volume_l: int | float | None = None,
) -> float:
    """Linear calibration ``liter = pressure * multiplier + offset`` (FR-L1),
    clamped to ``[0, max_volume_l]``."""
    liters = pressure * multiplier + offset
    if liters < 0:
        liters = 0.0
    if max_volume_l:
        liters = min(liters, float(max_volume_l))
    return float(liters)


def calibrate_two_point(
    p1: float, l1: float, p2: float, l2: float
) -> tuple[float, float]:
    """Derive ``(multiplier, offset)`` from two pressure/liter points (FR-S5a)."""
    if p1 == p2:
        raise ValueError("two calibration points need different pressures")
    multiplier = (l1 - l2) / (p1 - p2)
    offset = l1 - multiplier * p1
    return multiplier, offset


def liters_from_table(
    raw: float,
    points: list[Any],
    max_volume_l: int | float | None = None,
) -> float | None:
    """Piecewise-linear level from a calibration table (FR-S5a).

    ``points`` = list of ``{"raw":.., "liters":..}`` mappings (or ``(raw, liters)``
    tuples). Interpolates linearly between the points sorted by ``raw``; **below the
    first / above the last point the endpoint liters are held** (no extrapolation),
    then clamped to ``[0, max_volume_l]``. A table with **2** points is just the
    linear case; **N** points capture a non-linear tank. Returns ``None`` when fewer
    than 2 valid points exist (caller falls back to ``multiplier``/``offset``)."""
    pts: list[tuple[float, float]] = []
    for p in points:
        try:
            if isinstance(p, dict):
                pts.append((float(p["raw"]), float(p["liters"])))
            else:
                pts.append((float(p[0]), float(p[1])))
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    if len(pts) < 2:
        return None
    pts.sort(key=lambda q: q[0])
    if raw <= pts[0][0]:
        liters = pts[0][1]
    elif raw >= pts[-1][0]:
        liters = pts[-1][1]
    else:
        liters = pts[-1][1]
        for (r0, l0), (r1, l1) in zip(pts, pts[1:]):
            if r0 <= raw <= r1:
                span = r1 - r0
                liters = l0 if span == 0 else l0 + (raw - r0) / span * (l1 - l0)
                break
    if liters < 0:
        liters = 0.0
    if max_volume_l:
        liters = min(liters, float(max_volume_l))
    return float(liters)


def percent(liters: float, max_volume_l: int | float | None) -> float | None:
    """Fill percentage, clamped to 0..100; ``None`` if no capacity known."""
    if not max_volume_l:
        return None
    pct = liters / max_volume_l * 100.0
    return round(min(100.0, max(0.0, pct)), 1)


def consumption(start_l: float, end_l: float) -> int:
    """Consumed liters = max(0, start − end) (FR-L1/L2)."""
    return max(0, int(round(start_l - end_l)))


def run_consumption(
    start_l: float | None, end_l: float | None, *, is_cistern: bool
) -> int | None:
    """Liters drawn during a run, **correctly signed per source type** (CR-0003):
    a **cistern** level *drops* (start − end), a **metered** source (mains /
    Literzähler) *rises* (end − start). ``None`` if either reading is missing."""
    if start_l is None or end_l is None:
        return None
    return consumption(start_l, end_l) if is_cistern else consumption(end_l, start_l)


def counter_at(samples: list[tuple[Any, float]], t: Any) -> float | None:
    """Value of a cumulative counter (e.g. the firmware boot counter) **as of
    time ``t``** — the last sample at or before ``t`` (FR-S13). ``samples`` =
    ``(timestamp, value)`` pairs (any comparable timestamp type). If every sample
    is *after* ``t`` (device only started later), the earliest value is returned as
    the baseline so deltas don't go negative. ``None`` when there are no samples."""
    ordered = sorted(samples, key=lambda s: s[0])
    if not ordered:
        return None
    val: float | None = None
    for ts, v in ordered:
        if ts <= t:
            val = v
        else:
            break
    return val if val is not None else ordered[0][1]


def restart_counts(
    current: float | None,
    at_today_start: float | None,
    at_prev_day_start: float | None,
) -> tuple[int | None, int | None]:
    """Restarts **today** / **yesterday** from a cumulative boot counter (FR-S13):
    ``today = current − value@00:00-today``, ``yesterday = value@00:00-today −
    value@00:00-yesterday``. Negative diffs (counter reset / reflash) clamp to 0;
    a component is ``None`` when its inputs are missing."""
    today = (
        max(0, int(round(current - at_today_start)))
        if current is not None and at_today_start is not None
        else None
    )
    yesterday = (
        max(0, int(round(at_today_start - at_prev_day_start)))
        if at_today_start is not None and at_prev_day_start is not None
        else None
    )
    return today, yesterday
