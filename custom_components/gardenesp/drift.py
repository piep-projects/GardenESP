"""Firmware-drift status decision (roadmap #9) — pure, no HA imports.

Decides, from four inputs, whether a box's **flashed firmware** matches its
current **Settings-derived** config. The decision is intentionally a pure
function so it is unit-testable; the coordinator gathers the inputs (config hash,
the device's reported ``sw_version``, the last exported hash, online flag) and the
front-ends only render the resulting status string.

**Drift is a warning, never a global stop** (FDS §… / roadmap #9): the running
firmware is the wired, tested reality. The real safety stop is *separate* and
acts per line when its target ``switch`` is ``unavailable`` (see
``coordinator._switch_unavailable``), independent of any hash.
"""

from __future__ import annotations

# Status values (also the JS keys in gardenesp-card.js / gardenesp-panel.js).
CURRENT = "current"  # flashed == config, device online → grün
CURRENT_OFFLINE = "current_offline"  # last-known flashed matched, now offline
DRIFT = "drift"  # flashed != config, device online → gelb „Flashen ausstehend"
DRIFT_OFFLINE = "drift_offline"  # last-known flashed differs, now offline
EXPORTED = "exported"  # no project.version, but exported hash == config (YAML geholt)
DRIFT_EXPORT = "drift_export"  # exported hash differs from config (Änderung seit Export)
NEVER = "never"  # nothing known — YAML never exported, no project.version
ERROR = "error"  # config could not be generated (box exceeds template)

# States that warrant the „Box X prüfen" banner / attention badge.
ATTENTION = frozenset({DRIFT, DRIFT_OFFLINE, DRIFT_EXPORT})


def fw_status(
    config_hash: str | None,
    flashed: str | None,
    exported: str | None,
    online: bool | None,
) -> str:
    """Return the firmware-drift status for one box.

    - ``config_hash`` — :func:`esphome_yaml.box_config_hash` of the current box,
      or ``None`` when the box can't be generated.
    - ``flashed`` — the device's reported ``project.version`` (``sw_version`` in
      the HA device registry), or ``None`` if the device never reported one.
    - ``exported`` — the last hash the admin exported (copy/download), or ``None``.
    - ``online`` — whether the box's entities are currently reachable; ``None`` =
      unknown (no entities mapped yet).
    """
    if not config_hash:
        return ERROR
    if flashed:
        if flashed == config_hash:
            return CURRENT if online else CURRENT_OFFLINE
        return DRIFT if online else DRIFT_OFFLINE
    # Device never reported a project.version (old firmware / never flashed with
    # the project block) → fall back to the export hash.
    if exported and exported == config_hash:
        return EXPORTED
    if exported:
        return DRIFT_EXPORT
    return NEVER
