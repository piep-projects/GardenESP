"""Home Assistant services for GardenESP (FR-X3b).

Exposes ``gardenesp.start_line`` / ``gardenesp.stop_line`` so external automations
— e.g. a user's own ET0/weather-based irrigation calculation — can drive a line
through the **full coordinator path** (source lock, gates, consumption logging,
Zisternen-Nachlauf/settling and result codes) instead of toggling the raw ESPHome
valve ``switch.*`` directly (which bypasses all of that; only the on-device
Emergency Shutdown would remain).

Same semantics as the panel's WebSocket ``line/start`` / ``line/stop`` (FR-X3):
a manual start skips the Automatik gate, ``force`` is the ad-hoc sensor override,
and ``duration_min`` accepts fractional minutes (0.3 = 18 s).
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .coordinator import GardenESPCoordinator

SERVICE_START_LINE = "start_line"
SERVICE_STOP_LINE = "stop_line"

ATTR_LINE_ID = "line_id"
ATTR_DURATION_MIN = "duration_min"
ATTR_FORCE = "force"

START_LINE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_LINE_ID): cv.string,
        # fractional = sub-minute (e.g. 0.3 = 18 s); omitted = line's manual default
        vol.Optional(ATTR_DURATION_MIN): vol.All(vol.Coerce(float), vol.Range(min=0)),
        vol.Optional(ATTR_FORCE, default=False): cv.boolean,
    }
)

STOP_LINE_SCHEMA = vol.Schema({vol.Required(ATTR_LINE_ID): cv.string})


def _coordinator(hass: HomeAssistant) -> GardenESPCoordinator | None:
    data: dict[str, GardenESPCoordinator] = hass.data.get(DOMAIN, {})
    return next(iter(data.values()), None)


def _resolve(hass: HomeAssistant, line_id: str) -> GardenESPCoordinator:
    """Return the coordinator, validating that ``line_id`` exists (raises a
    user-facing ``ServiceValidationError`` otherwise — the coordinator's own
    start/stop would just silently no-op on an unknown id)."""
    coord = _coordinator(hass)
    if coord is None:
        raise ServiceValidationError("GardenESP integration not loaded")
    if line_id not in coord.config.lines:
        raise ServiceValidationError(f"Unknown GardenESP line_id: {line_id}")
    return coord


@callback
def async_register_services(hass: HomeAssistant) -> None:
    """Register the GardenESP services (idempotent — survives entry reload)."""
    if hass.services.has_service(DOMAIN, SERVICE_START_LINE):
        return

    async def _start_line(call: ServiceCall) -> None:
        line_id = call.data[ATTR_LINE_ID]
        coord = _resolve(hass, line_id)
        await coord.async_start_line(
            line_id,
            call.data.get(ATTR_DURATION_MIN),
            force=call.data[ATTR_FORCE],
        )

    async def _stop_line(call: ServiceCall) -> None:
        line_id = call.data[ATTR_LINE_ID]
        coord = _resolve(hass, line_id)
        await coord.async_stop_line(line_id)

    hass.services.async_register(
        DOMAIN, SERVICE_START_LINE, _start_line, schema=START_LINE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_STOP_LINE, _stop_line, schema=STOP_LINE_SCHEMA
    )


@callback
def async_unregister_services(hass: HomeAssistant) -> None:
    """Remove the services (called when the last config entry is gone)."""
    hass.services.async_remove(DOMAIN, SERVICE_START_LINE)
    hass.services.async_remove(DOMAIN, SERVICE_STOP_LINE)
