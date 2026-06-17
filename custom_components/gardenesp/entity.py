"""Shared entity base + device-grouping helpers (FDS §9.2 / §9.3)."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import GardenESPCoordinator

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
    obj_id: str, name: str, box_id: str | None, model: str
) -> DeviceInfo:
    """A HA device for a Line/Source/Sensor, linked to its Box via_device."""
    info = DeviceInfo(
        identifiers={(DOMAIN, obj_id)},
        name=_prefixed(name),
        model=model,
    )
    if box_id:
        info["via_device"] = (DOMAIN, box_id)
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
