"""Pure interpretation of raw sensor/level state — FDS §5.7/§5.8.

No Home Assistant imports. The coordinator reads raw HA states (strings/floats)
and passes them here for the actual decision, keeping it unit-testable.
"""

from __future__ import annotations

_ON_TOKENS = {"on", "true", "1", "wet", "nass", "open"}


def rain_is_blocking(raw_state: object) -> bool:
    """A digital rain sensor: ``on`` = wet = blocking (FDS §5.8).

    The entity polarity is normalised in the firmware (the ESPHome pin's
    ``inverted:`` handles NO/NC wiring, set from the input's ``inverted`` flag),
    so the gate trusts the entity as-is and must **not** invert again — doing so
    was FP-0001 (wässerte bei Regen, sperrte bei Trockenheit)."""
    return str(raw_state).strip().lower() in _ON_TOKENS


def soil_is_blocking(raw_value: object, threshold_pct: int) -> bool:
    """Analog soil moisture: blocks at/above the threshold (``feucht genug``)."""
    try:
        value = float(raw_value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return value >= threshold_pct


def level_ok(level_liters: float | None, max_volume_l: int, min_fill_pct: int) -> bool:
    """True if the source is at/above its minimum fill level (FR-D2/FR-L1).

    Disabled (always ok) if no threshold/capacity is configured. An **unknown**
    level does not block (avoids false stops on startup); the caller logs it.
    """
    if not max_volume_l or not min_fill_pct:
        return True
    if level_liters is None:
        return True
    return (level_liters / max_volume_l * 100.0) >= min_fill_pct
