"""WebSocket API — the panel's read/write side (FDS §5.2/§5.5).

Read: ``gardenesp/config/get`` returns the full config + current entity values.
Write: ``gardenesp/upsert`` / ``gardenesp/delete`` mutate config (Storage is the
single source of truth, §9.4). Actions: line start/stop.
``gardenesp/box/yaml`` is **admin-only** (FR-S8/P2, enforced server-side).

Configuration changes are not control entities (FR-X3) — they go through here.
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from . import topology, wiring
from .const import DOMAIN
from .coordinator import GardenESPCoordinator
from .esphome_yaml import YamlGenError

_KINDS = ["box", "line", "source"]


def _coordinator(hass: HomeAssistant) -> GardenESPCoordinator | None:
    data: dict[str, GardenESPCoordinator] = hass.data.get(DOMAIN, {})
    return next(iter(data.values()), None)


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register all GardenESP WebSocket commands (idempotent)."""
    for handler in (
        ws_config_get,
        ws_topology,
        ws_wiring,
        ws_history,
        ws_settings_set,
        ws_upsert,
        ws_delete,
        ws_line_start,
        ws_line_stop,
        ws_box_yaml,
        ws_box_exported,
        ws_box_sync,
    ):
        websocket_api.async_register_command(hass, handler)


@websocket_api.websocket_command({vol.Required("type"): "gardenesp/config/get"})
@callback
def ws_config_get(hass, connection, msg):
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    connection.send_result(
        msg["id"], {"config": coord.config.to_storage(), "values": coord.values}
    )


@websocket_api.websocket_command({vol.Required("type"): "gardenesp/topology"})
@callback
def ws_topology(hass, connection, msg):
    """Read-only Hydraulik-Lens (Roadmap #7): per-source strands derived from the
    config — Sensor → Pumpe (+ verbundene Ventile) → Ventil → Linie."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    connection.send_result(
        msg["id"], {"strands": topology.build(coord.config.to_storage())}
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/wiring", vol.Required("box_id"): str}
)
@callback
def ws_wiring(hass, connection, msg):
    """Read-only Verdrahtungs-Hilfe: a box's outputs/inputs projected onto the
    physical board pinout (Phase 1: ESP32-WROOM DevKitC 38-pin)."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    connection.send_result(
        msg["id"], wiring.build(coord.config.to_storage(), msg["box_id"])
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gardenesp/history",
        vol.Optional("line_id"): str,
        vol.Optional("source_id"): str,
    }
)
@websocket_api.async_response
async def ws_history(hass, connection, msg):
    """Irrigation history log for the Details overlay (FR-D6); newest first.

    Filterable by ``line_id`` (per line) or ``source_id`` (per water source —
    the same log, every entry carries its line's source)."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    history = await coord.store.async_load_history()
    entries = history.get("entries", [])
    line_id = msg.get("line_id")
    if line_id is not None:
        entries = [e for e in entries if e.get("line_id") == line_id]
    source_id = msg.get("source_id")
    if source_id is not None:
        entries = [e for e in entries if e.get("source_id") == source_id]
    connection.send_result(msg["id"], {"entries": list(reversed(entries))})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/settings/set", vol.Required("data"): dict}
)
@websocket_api.async_response
async def ws_settings_set(hass, connection, msg):
    """Merge global settings (e.g. history_months) — FDS Allgemein/§9.4."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    await coord.async_set_settings(msg["data"])
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gardenesp/upsert",
        vol.Required("kind"): vol.In(_KINDS),
        vol.Required("data"): dict,
    }
)
@websocket_api.async_response
async def ws_upsert(hass, connection, msg):
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    obj_id = await coord.async_upsert(msg["kind"], msg["data"])
    connection.send_result(msg["id"], {"id": obj_id})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gardenesp/delete",
        vol.Required("kind"): vol.In(_KINDS),
        # NB: ``id`` is reserved by the HA WS framework for the message id; the
        # object id must travel under a distinct key (``obj_id``).
        vol.Required("obj_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete(hass, connection, msg):
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    await coord.async_delete(msg["kind"], msg["obj_id"])
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gardenesp/line/start",
        vol.Required("line_id"): str,
        vol.Optional("duration_min"): vol.Coerce(float),  # fractional = sub-minute (e.g. 0.3 = 18 s)
        vol.Optional("force", default=False): bool,
    }
)
@callback
def ws_line_start(hass, connection, msg):
    """Manual start (panel only, FR-X3). Runs in the background."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    hass.async_create_task(
        coord.async_start_line(
            msg["line_id"], msg.get("duration_min"), force=msg["force"]
        )
    )
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/line/stop", vol.Required("line_id"): str}
)
@websocket_api.async_response
async def ws_line_stop(hass, connection, msg):
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    await coord.async_stop_line(msg["line_id"])
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/yaml", vol.Required("box_id"): str}
)
@callback
def ws_box_yaml(hass, connection, msg):
    """Read-only generated YAML view — admin only (FR-S8/P2, FR-S9)."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Admin required")
        return
    coord = _coordinator(hass)
    if coord is None or msg["box_id"] not in coord.config.boxes:
        connection.send_error(msg["id"], "not_found", "Box not found")
        return
    try:
        yaml = coord.box_yaml(msg["box_id"])
    except YamlGenError as err:
        connection.send_error(msg["id"], "yaml_error", str(err))
        return
    connection.send_result(msg["id"], {"yaml": yaml, "readonly": True})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/exported", vol.Required("box_id"): str}
)
@websocket_api.async_response
async def ws_box_exported(hass, connection, msg):
    """Mark a box's YAML as exported (copy/download) — records the current config
    hash as ``exported_yaml_hash`` (firmware-drift fallback, #9c). Admin only."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Admin required")
        return
    coord = _coordinator(hass)
    if coord is None or msg["box_id"] not in coord.config.boxes:
        connection.send_error(msg["id"], "not_found", "Box not found")
        return
    exported_hash = await coord.async_mark_box_exported(msg["box_id"])
    connection.send_result(msg["id"], {"exported_yaml_hash": exported_hash})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/sync", vol.Required("box_id"): str}
)
@websocket_api.async_response
async def ws_box_sync(hass, connection, msg):
    """Re-resolve a box's output/input refs to the live ESPHome entity_ids
    (entity-registry match, FR-S9). Returns how many of N were matched."""
    coord = _coordinator(hass)
    if coord is None or msg["box_id"] not in coord.config.boxes:
        connection.send_error(msg["id"], "not_found", "Box not found")
        return
    result = await coord.async_sync_box_entities(msg["box_id"])
    connection.send_result(msg["id"], result)
