"""The GardenESP IrrigationController integration.

See docs/fds.md for the full specification. This package is the HA custom
integration (HACS); the on-device firmware is generated separately per box
(FDS §5.4).
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, Event, HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceEntry

from .const import (
    CARD_FILENAME,
    CARD_WWW_URL,
    DOMAIN,
    PANEL_CUSTOM_NAME,
    PANEL_FILENAME,
    PANEL_ICON,
    PANEL_STATIC_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PLATFORMS,
)
from .coordinator import GardenESPCoordinator
from .entity import box_device_info
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up GardenESP from a config entry."""
    coordinator = GardenESPCoordinator(hass, entry)
    await coordinator.async_setup()

    # Register each Box as a HA device (the "hub"). Boxes carry no entities of
    # their own, so they must be created explicitly — otherwise the Line/Source/
    # Sensor children's ``via_device`` links dangle and nothing groups under a
    # hub (recent HA no longer auto-creates a device from a via_device ref).
    dev_reg = dr.async_get(hass)
    for box in coordinator.config.boxes.values():
        dev_reg.async_get_or_create(
            config_entry_id=entry.entry_id,
            **box_device_info(box.id, box.name, box.hw_type),
        )

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    async_register_ws(hass)
    version = await hass.async_add_executor_job(_version)
    await _async_register_panel(hass, version)
    await _async_register_card(hass, version)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: ConfigEntry, device: DeviceEntry
) -> bool:
    """Allow deleting a device from the UI/API — but only stale ones.

    Each Line/Source/Sensor is its own HA device, identified by ``(DOMAIN,
    obj_id)`` (``"{box}#{inp}"`` for inputs). When a config object is deleted its
    device is left behind as an orphan; HA refuses removal unless the integration
    opts in here. We permit removal only when the device no longer maps to a live
    config object — live ones would just be recreated on the next reload.
    """
    coordinator: GardenESPCoordinator | None = hass.data.get(DOMAIN, {}).get(
        entry.entry_id
    )
    if coordinator is None:
        return True
    cfg = coordinator.config
    live: set[str] = set(cfg.lines) | set(cfg.sources) | set(cfg.boxes)
    for box in cfg.boxes.values():
        for inp in box.inputs:
            live.add(f"{box.id}#{inp.id}")
    obj_ids = {ident[1] for ident in device.identifiers if ident[0] == DOMAIN}
    return obj_ids.isdisjoint(live)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coordinator: GardenESPCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_shutdown()
        if not hass.data[DOMAIN]:
            frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return unloaded


_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


async def _async_register_panel(hass: HomeAssistant, version: str) -> None:
    """Serve the panel JS and register the sidebar entry (idempotent).

    A custom (non-iframe) panel: the ``gardenesp-panel`` custom element receives
    ``hass`` directly and talks to the WebSocket API (FDS §2). Served straight
    from the integration directory — no copy into ``www/`` needed.

    The static path can't be unregistered, so it is guarded by its own flag and
    survives a reload; the sidebar panel itself is (re)registered per setup and
    removed on the last unload.
    """
    if not hass.data.get(_STATIC_REGISTERED):
        panel_js = Path(__file__).parent / "panel" / PANEL_FILENAME
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, str(panel_js), False)]
        )
        hass.data[_STATIC_REGISTERED] = True

    if PANEL_URL_PATH in hass.data.get("frontend_panels", {}):
        return

    frontend.async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        require_admin=False,
        config={
            "_panel_custom": {
                "name": PANEL_CUSTOM_NAME,
                "embed_iframe": False,
                "trust_external": False,
                # cache-bust on version change (URL-Versioning, ha-integration-howto)
                "module_url": f"{PANEL_STATIC_URL}?v={version}",
            }
        },
    )
    _LOGGER.info("Registered GardenESP sidebar panel at /%s", PANEL_URL_PATH)


def _version() -> str:
    """Integration version (manifest) for cache-busting the panel/card URLs."""
    import json

    try:
        manifest = json.loads(
            (Path(__file__).parent / "manifest.json").read_text(encoding="utf-8")
        )
        return str(manifest.get("version", "0"))
    except (OSError, ValueError):
        return "0"


_CARD_REGISTERED = f"{DOMAIN}_card_registered"


def _deploy_file(src: Path, dst: Path) -> bool:
    """Copy ``src`` to ``dst`` if content differs. Content-hash, not mtime —
    HACS unzips with stale timestamps (ha-integration-howto). Returns True if
    a copy happened."""
    src_bytes = src.read_bytes()
    if dst.exists() and dst.read_bytes() == src_bytes:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dst))
    return True


async def _async_register_card(hass: HomeAssistant, version: str) -> None:
    """Deploy the Lovelace card to ``www/`` and register it as a module resource
    so ``type: custom:gardenesp-card`` works on any dashboard (once per run)."""
    if hass.data.get(_CARD_REGISTERED):
        return
    src = Path(__file__).parent / CARD_FILENAME
    dst = Path(hass.config.path("www")) / CARD_FILENAME
    copied = await hass.async_add_executor_job(_deploy_file, src, dst)
    if copied:
        _LOGGER.info("Deployed %s to www/", CARD_FILENAME)
    hass.data[_CARD_REGISTERED] = True

    url = f"{CARD_WWW_URL}?v={version}"
    # Register only once HA has started: at boot ``async_get_info`` returns an
    # empty list, so the stale-version cleanup can't run and resources pile up
    # on every version bump (ha-integration-howto timing note). Defer if needed.
    if hass.state is CoreState.running:
        await _async_register_lovelace_resource(hass, url)
    else:
        async def _on_started(_event: Event) -> None:
            await _async_register_lovelace_resource(hass, url)

        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _on_started)


async def _async_register_lovelace_resource(hass: HomeAssistant, url: str) -> None:
    """Register (or update) the card as a Lovelace 'module' resource.

    Follows ha-integration-howto: ``async_get_info`` may return ``{id: dict}``
    or a list; we normalise, drop stale versions of the same base URL, and only
    create when missing. No-op in YAML-mode Lovelace (no resource store)."""
    base = CARD_WWW_URL
    try:
        ll = hass.data.get("lovelace")
        resources = getattr(ll, "resources", None) if ll else None
        if not resources or not hasattr(resources, "async_create_item"):
            _LOGGER.warning(
                "Lovelace resources unavailable (YAML mode?) — add %s manually", url
            )
            return
        if hasattr(resources, "async_load") and not getattr(resources, "loaded", True):
            await resources.async_load()
        # ``async_items()`` is the storage-collection API and returns the full
        # list of {id,url,type} dicts; ``async_get_info()`` does NOT (it varies
        # by HA version and returned no items here → duplicates piled up).
        items = list(resources.async_items())

        def _u(it):
            return it.get("url", "") if isinstance(it, dict) else getattr(it, "url", "")

        def _i(it):
            return it.get("id") if isinstance(it, dict) else getattr(it, "id", None)

        # Always drop stale versions of the same file first (do this *before* the
        # "already present" check, else an existing current version short-circuits
        # the cleanup and old ones linger).
        for it in items:
            if _u(it).split("?")[0] == base and _u(it) != url:
                try:
                    await resources.async_delete_item(_i(it))
                    _LOGGER.info("Removed stale Lovelace resource %s", _u(it))
                except Exception as exc:  # noqa: BLE001
                    _LOGGER.warning("Could not remove stale resource %s: %s", _u(it), exc)
        if any(_u(it) == url for it in items):
            return  # current version already registered
        await resources.async_create_item({"res_type": "module", "url": url})
        _LOGGER.info("Registered Lovelace resource %s", url)
    except Exception as exc:  # noqa: BLE001
        _LOGGER.warning("Lovelace resource registration failed for %s: %s", url, exc)
