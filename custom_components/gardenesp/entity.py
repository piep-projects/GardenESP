"""Shared entity base + device-grouping helpers (FDS §9.2 / §9.3)."""

from __future__ import annotations

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import GardenESPCoordinator

# HA 2026.8 replaced ``DeviceInfo.via_device`` (an identifier tuple) by
# ``via_device_id`` (a device-registry id) and deprecated the old field — it
# stops working in 2027.8. The lookup helper arrived together with the new field,
# so its presence is the switch: newer HA gets ``via_device_id``, older HA (down to
# the ``hacs.json`` floor) keeps ``via_device``. Drop the fallback once the floor
# reaches 2026.8.
_HAS_VIA_DEVICE_ID = hasattr(dr, "async_get_device_id_by_identifier")

# Device names are prefixed with the app name so every derived ``entity_id``
# carries it (e.g. ``sensor.gardenesp_rasen_status``), grouping all GardenESP
# entities and keeping them recognizable (FDS §9.2).
APP_PREFIX = "GardenESP"


def _prefixed(name: str) -> str:
    return f"{APP_PREFIX} {name}".strip()


def box_device_info(box_id: str, name: str, hw_type: str) -> DeviceInfo:
    """A HA device for a Box (the physical controller)."""
    return DeviceInfo(
        identifiers={(DOMAIN, box_id)},
        name=_prefixed(name),
        manufacturer="GardenESP",
        model=hw_type,
    )


def child_device_info(
    coordinator: GardenESPCoordinator,
    obj_id: str,
    name: str,
    box_id: str | None,
    model: str,
) -> DeviceInfo:
    """A HA device for a Line/Source/Sensor, linked to its Box (hub) device.

    The Box device must already be registered (``async_setup_entry`` and
    ``_add_new_entities`` do that before any entity is built). A reference to an
    unknown Box gets no link — the same outcome HA produced for a dangling
    ``via_device``.
    """
    info = DeviceInfo(
        identifiers={(DOMAIN, obj_id)},
        name=_prefixed(name),
        model=model,
    )
    if not box_id:
        return info
    if not _HAS_VIA_DEVICE_ID:
        info["via_device"] = (DOMAIN, box_id)
        return info
    try:
        info["via_device_id"] = dr.async_get_device_id_by_identifier(
            coordinator.hass,
            (DOMAIN, box_id),
            config_entry_id=coordinator.entry.entry_id,
        )
    except ValueError:
        pass  # unknown Box: leave the device unlinked
    return info


def box_of_ref(ref: str | None) -> str | None:
    """Extract the box id from a ``"{box_id}#{local_id}"`` reference (FDS §9.1)."""
    if ref and "#" in ref:
        return ref.split("#", 1)[0]
    return None


class GardenESPEntity(CoordinatorEntity[GardenESPCoordinator]):
    """Base for all read-only GardenESP entities (FDS §5.12 / FR-X1).

    ``unique_id = "{obj_id}__{key}"`` is stable and name-independent (FDS §9.2).
    Concrete value access goes through ``coordinator.values[self.unique_id]``.
    """

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: GardenESPCoordinator,
        obj_id: str,
        key: str,
        device_info: DeviceInfo,
    ) -> None:
        super().__init__(coordinator)
        self._obj_id = obj_id
        self._key = key
        self._attr_unique_id = f"{obj_id}__{key}"
        self._attr_device_info = device_info

    @property
    def _value(self):  # noqa: ANN202 - varies per platform
        return self.coordinator.values.get(self._attr_unique_id)

    @property
    def available(self) -> bool:
        return self._value is not None
