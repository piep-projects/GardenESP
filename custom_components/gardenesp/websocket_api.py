"""WebSocket API — the panel's read/write side (FDS §5.2/§5.5).

Read: ``gardenesp/config/get`` returns the full config + current entity values.
Write: ``gardenesp/upsert`` / ``gardenesp/delete`` mutate config (Storage is the
single source of truth, §9.4). Actions: line start/stop.
``gardenesp/box/yaml`` is **admin-only** (FR-S8/P2, enforced server-side).

Configuration changes are not control entities (FR-X3) — they go through here.

**Authorisation (FR-P2).** Everything that writes configuration —
``settings/set``, ``upsert``, ``delete``, ``box/sync`` — and the two
config-exposing reads (``box/yaml``, ``box/exported``) require an **admin**
user; the sidebar panel that drives them is registered ``require_admin``.
The read commands the dashboard card needs (``config/get``, ``history``,
``topology``, ``wiring``) stay open to any authenticated user.

``line/start`` / ``line/stop`` are deliberately **not** admin-gated: a manual
run is *entity control*, not configuration — it toggles the line's valve
switch, an entity the same user may flip directly in HA. They are therefore
checked against HA's own permission model (``check_entity(..., control)``),
so a normal household user keeps the dashboard's ▶/■ while a read-only user
is refused.
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from . import topology, wiring
from .const import DOMAIN
from .coordinator import GardenESPCoordinator
from .esphome_yaml import YamlGenError
from .models import InvalidObject

_KINDS = ["box", "line", "source"]


def _coordinator(hass: HomeAssistant) -> GardenESPCoordinator | None:
    data: dict[str, GardenESPCoordinator] = hass.data.get(DOMAIN, {})
    return next(iter(data.values()), None)


def _require_admin(connection, msg) -> bool:
    """Guard the config-mutating (and config-exposing) commands.

    GardenESP's whole configuration — boxes, lines, sources, schedules — is
    HA *configuration*, so writing it is an admin act, exactly like editing an
    integration's options. Sends the error itself and returns ``False`` when
    the caller is not an admin, so a handler reads ``if not _require_admin(...)
    : return``.
    """
    if connection.user.is_admin:
        return True
    connection.send_error(msg["id"], "unauthorized", "Admin required")
    return False


def _require_control(connection, coord: GardenESPCoordinator, msg) -> bool:
    """Guard a manual line start/stop against HA's entity permissions.

    Running a line means switching its valve — the same ``switch.*`` entity the
    user can already toggle from a dashboard, governed by their entity policy.
    Admin-gating it would be *stricter* than the underlying entity and would
    take the card's ▶/■ away from non-admin household members, so the check is
    delegated to HA: the caller needs ``control`` on the resolved valve entity.

    An unmapped valve (no entity resolved yet, or an unknown line) has nothing
    to check against and is refused for non-admins.
    """
    if connection.user.is_admin:
        return True
    entity = coord.line_switch_entity(msg["line_id"])
    if entity is not None and connection.user.permissions.check_entity(
        entity, POLICY_CONTROL
    ):
        return True
    connection.send_error(
        msg["id"], "unauthorized", "Not allowed to control this line"
    )
    return False


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
        ws_box_reboot_ack,
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
    """Merge global settings (e.g. history_months) — FDS Allgemein/§9.4. Admin only."""
    if not _require_admin(connection, msg):
        return
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
    """Create or update a box/line/source — admin only (FR-P2)."""
    if not _require_admin(connection, msg):
        return
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    try:
        obj_id = await coord.async_upsert(msg["kind"], msg["data"])
    except InvalidObject as err:
        # Malformed object (e.g. a line without ``valve_output``): name the field
        # instead of letting the TypeError surface as an opaque ``unknown_error``.
        # Raised while building the object, i.e. before anything is stored.
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, str(err))
        return
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
    """Delete a box/line/source (and its HA devices) — admin only (FR-P2)."""
    if not _require_admin(connection, msg):
        return
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
    """Manual start (FR-X3). Runs in the background. Needs ``control`` on the
    line's valve entity (see ``_require_control``)."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    if not _require_control(connection, coord, msg):
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
    """Manual stop — same entity-permission check as the start (FR-X3)."""
    coord = _coordinator(hass)
    if coord is None:
        connection.send_error(msg["id"], "not_loaded", "Integration not loaded")
        return
    if not _require_control(connection, coord, msg):
        return
    await coord.async_stop_line(msg["line_id"])
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/yaml", vol.Required("box_id"): str}
)
@callback
def ws_box_yaml(hass, connection, msg):
    """Read-only generated YAML view — admin only (FR-S8/P2, FR-S9)."""
    if not _require_admin(connection, msg):
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
    connection.send_result(
        msg["id"],
        {"yaml": yaml, "readonly": True, "node_name": coord.box_node_name(msg["box_id"])},
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/exported", vol.Required("box_id"): str}
)
@websocket_api.async_response
async def ws_box_exported(hass, connection, msg):
    """Mark a box's YAML as exported (copy/download) — records the current config
    hash as ``exported_yaml_hash`` (firmware-drift fallback, #9c). Admin only."""
    if not _require_admin(connection, msg):
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
    (entity-registry match, FR-S9). Writes the resolved refs back to the config,
    so admin only (FR-P2). Returns how many of N were matched."""
    if not _require_admin(connection, msg):
        return
    coord = _coordinator(hass)
    if coord is None or msg["box_id"] not in coord.config.boxes:
        connection.send_error(msg["id"], "not_found", "Box not found")
        return
    result = await coord.async_sync_box_entities(msg["box_id"])
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {vol.Required("type"): "gardenesp/box/reboot_ack", vol.Required("box_id"): str}
)
@websocket_api.async_response
async def ws_box_reboot_ack(hass, connection, msg):
    """Acknowledge a box's last fault reboot → hide the dashboard banner for all
    users until the next boot. Open to every authenticated user by decision
    (2026-11-07): it only changes what the banner shows — no configuration, no
    output is touched — and non-admin household members see the banner too."""
    coord = _coordinator(hass)
    if coord is None or msg["box_id"] not in coord.config.boxes:
        connection.send_error(msg["id"], "not_found", "Box not found")
        return
    acked = await coord.async_ack_reboot(msg["box_id"])
    connection.send_result(msg["id"], {"acked": acked})
