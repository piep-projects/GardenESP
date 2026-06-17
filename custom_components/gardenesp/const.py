"""Constants for the GardenESP IrrigationController integration.

See docs/fds.md §9 (Implementierungs-Konventionen) for the rationale behind the
domain, ID scheme and storage layout.
"""

from __future__ import annotations

from typing import Final

from homeassistant.const import Platform

DOMAIN: Final = "gardenesp"

# Entity platforms the integration provides (read-only, FDS §5.12 / FR-X1).
PLATFORMS: Final[list[Platform]] = [Platform.SENSOR, Platform.BINARY_SENSOR]

# --- Sidebar panel (FDS §2 / §5.1) -------------------------------------------
# Custom panel served straight from the integration dir (no www/ copy needed).
PANEL_URL_PATH: Final = "gardenesp"               # sidebar route (/gardenesp)
PANEL_TITLE: Final = "GardenESP"
PANEL_ICON: Final = "mdi:sprout"
PANEL_FILENAME: Final = "gardenesp-panel.js"
PANEL_STATIC_URL: Final = f"/{DOMAIN}_panel/{PANEL_FILENAME}"
PANEL_CUSTOM_NAME: Final = "gardenesp-panel"      # custom element tag

# --- Lovelace card (FR-X / dashboard embedding) ------------------------------
# Deployed to config/www/ and registered as a Lovelace module resource (/local/).
CARD_FILENAME: Final = "gardenesp-card.js"
CARD_WWW_URL: Final = f"/local/{CARD_FILENAME}"

# --- Storage (FDS §9.4) -------------------------------------------------------
STORAGE_VERSION: Final = 1
STORE_CONFIG: Final = f"{DOMAIN}.config"      # Single source of truth (config)
STORE_HISTORY: Final = f"{DOMAIN}.history"    # Bewässerungs-Protokoll (§4.6)
STORE_RUNTIME: Final = f"{DOMAIN}.runtime"    # In-flight runs (restart safety, FR-A5)

# History retention (rolling, FDS §9.4). Default in months; user-configurable
# via settings.history_months (Allgemein tab).
HISTORY_DEFAULT_MONTHS: Final = 6

# --- ID prefixes (FDS §9.1) ---------------------------------------------------
ID_PREFIX_BOX: Final = "box_"
ID_PREFIX_LINE: Final = "ln_"
ID_PREFIX_SOURCE: Final = "src_"
ID_PREFIX_SENSOR: Final = "sen_"

# --- Enums (kept as plain strings to match the storage JSON) -------------------
HW_GARDENCONTROL: Final = "gardencontrol"
HW_ESP32_WROOM: Final = "esp32_wroom"

OUTPUT_VALVE: Final = "valve"
OUTPUT_PUMP: Final = "pump"
OUTPUT_OTHER: Final = "other"  # generic switched load (fountain, camera, …) — FR-SW

# Line kinds (FDS §4.2): irrigation line vs. generic switched output (Steuerung).
LINE_KIND_IRRIGATION: Final = "irrigation"
LINE_KIND_SWITCH: Final = "switch"

INPUT_PRESSURE: Final = "pressure"
INPUT_SOIL_MOISTURE: Final = "soil_moisture"
INPUT_RAIN: Final = "rain"
INPUT_PULSE_METER: Final = "pulse_meter"

SOURCE_CISTERN: Final = "cistern"
SOURCE_MAINS: Final = "mains"

# Line run results (FDS §4.6).
RESULT_COMPLETED: Final = "completed"
RESULT_STOPPED: Final = "stopped"
RESULT_SKIPPED_SENSOR: Final = "skipped_sensor"
RESULT_SKIPPED_LEVEL: Final = "skipped_level"
RESULT_SKIPPED_UNREACHABLE: Final = "skipped_unreachable"  # valve switch unavailable (#9e)
RESULT_SUPERSEDED: Final = "superseded"  # run cancelled by a restart of the same line (CR-0006)
RESULT_INTERRUPTED: Final = "interrupted"  # run aborted mid-run: valve went unavailable (reboot/WiFi loss, CR-0011)
RESULT_EMERGENCY: Final = "emergency"  # on-device Emergency Shutdown fired (FR-E1 backstop, NVS counter, CR-0011)

# Line status (FDS FR-D2).
STATUS_ACTIVE: Final = "active"
STATUS_IDLE: Final = "idle"
STATUS_WAITING: Final = "waiting"
STATUS_BLOCKED_SENSOR: Final = "blocked_sensor"
STATUS_BLOCKED_LEVEL: Final = "blocked_level"
STATUS_AUTOMATIC_OFF: Final = "automatic_off"
STATUS_SETTLING: Final = "settling"  # valve off, cistern settle/measurement running (FR-A3)
STATUS_BOX_DISABLED: Final = "box_disabled"  # line's box is deactivated (FR-S, out of service)
STATUS_UNREACHABLE: Final = "unreachable"  # valve switch unavailable/unknown (#9e safety gate)
