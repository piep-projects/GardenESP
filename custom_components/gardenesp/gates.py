"""Pure gate evaluation — FDS §5.6a / §5.8 (FR-A1, FR-R1).

Decides whether a (scheduled or manual) start may proceed. No Home Assistant
imports — unit-testable standalone. Return values match the result/status codes
in :mod:`.const`.
"""

from __future__ import annotations

PROCEED = "proceed"
AUTOMATIC_OFF = "automatic_off"      # scheduled run, but Automatik off
SKIPPED_SENSOR = "skipped_sensor"    # blocking sensor wet / "feucht genug"
SKIPPED_LEVEL = "skipped_level"      # source below minimum fill level


def evaluate_gates(
    *,
    manual: bool,
    automatic: bool,
    sensor_blocking: bool,
    sensor_override: bool,
    level_ok: bool,
) -> str:
    """Gate order: Automatik (scheduled only) → Level (hard safety) → Sensor.

    - A **manual** start bypasses the Automatik gate (FR-D5) **and the blocking
      Sensor** — a manual draw is a deliberate action, additional to the
      rule-based watering, so rain/soil never blocks it (no "Start trotzdem"
      needed). The **Level** safety (dry-run protection) always applies.
    - For scheduled runs the Sensor still blocks unless ``sensor_override``.
    """
    if not manual and not automatic:
        return AUTOMATIC_OFF
    if not level_ok:
        return SKIPPED_LEVEL
    if sensor_blocking and not sensor_override and not manual:
        return SKIPPED_SENSOR
    return PROCEED
