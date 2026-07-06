"""Binary sensor entities (read-only) — FDS §5.12 / §9.2.

One per digital rain sensor; ``on`` = wet (device_class MOISTURE).
"""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, INPUT_RAIN, SIGNAL_ADD_ENTITIES
from .coordinator import GardenESPCoordinator
from .entity import GardenESPEntity, child_device_info


def _build_entities(coordinator: GardenESPCoordinator) -> list[GardenESPRainSensor]:
    """One binary sensor per rain input (rain/soil sensors live on the box)."""
    entities: list[GardenESPRainSensor] = []
    for box in coordinator.config.boxes.values():
        for inp in box.inputs:
            if inp.kind != INPUT_RAIN:
                continue
            ref = f"{box.id}#{inp.id}"
            dev = child_device_info(ref, inp.name, box.id, "sensor")
            entities.append(GardenESPRainSensor(coordinator, ref, dev))
    return entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create binary sensors; newly-created ones are added in place via
    ``SIGNAL_ADD_ENTITIES`` (no full reload on save)."""
    coordinator: GardenESPCoordinator = hass.data[DOMAIN][entry.entry_id]
    known: set[str] = set()

    @callback
    def _sync() -> None:
        new = [e for e in _build_entities(coordinator) if e.unique_id not in known]
        if new:
            known.update(e.unique_id for e in new)
            async_add_entities(new)

    _sync()
    entry.async_on_unload(
        async_dispatcher_connect(
            hass, SIGNAL_ADD_ENTITIES.format(entry.entry_id), _sync
        )
    )


class GardenESPRainSensor(GardenESPEntity, BinarySensorEntity):
    """Rain sensor state (wet/dry)."""

    _attr_device_class = BinarySensorDeviceClass.MOISTURE
    _attr_translation_key = "rain"

    def __init__(self, coordinator, obj_id, device_info) -> None:
        super().__init__(coordinator, obj_id, "state", device_info)

    @property
    def is_on(self) -> bool | None:
        return self._value
