"""Sensor entities (read-only) — FDS §5.12 / §9.2.

Created from the stored configuration: per source (level/consumption), per line
(status/next run/last amount) and per soil-moisture sensor. Values are served
from ``coordinator.values`` (empty until the run logic fills it).
"""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfVolume
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, INPUT_SOIL_MOISTURE, SIGNAL_ADD_ENTITIES, SOURCE_CISTERN
from .coordinator import GardenESPCoordinator
from .entity import GardenESPEntity, box_of_ref, child_device_info

# key -> description (FDS §9.2 table)
SOURCE_DESCRIPTIONS: dict[str, SensorEntityDescription] = {
    "level": SensorEntityDescription(
        key="level",
        translation_key="level",
        # Match the dashboard cistern icon (ICONS.cistern); otherwise the entity
        # falls back to the VOLUME_STORAGE default (mdi:storage-tank) and HA's
        # more-info dialog shows the old icon.
        icon="mdi:car-coolant-level",
        device_class=SensorDeviceClass.VOLUME_STORAGE,
        native_unit_of_measurement=UnitOfVolume.LITERS,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    "level_pct": SensorEntityDescription(
        key="level_pct",
        translation_key="level_pct",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    "consumption_today": SensorEntityDescription(
        key="consumption_today",
        translation_key="consumption_today",
        device_class=SensorDeviceClass.WATER,
        native_unit_of_measurement=UnitOfVolume.LITERS,
        state_class=SensorStateClass.TOTAL_INCREASING,
    ),
}

LINE_DESCRIPTIONS: dict[str, SensorEntityDescription] = {
    "status": SensorEntityDescription(
        key="status",
        translation_key="status",
        device_class=SensorDeviceClass.ENUM,
    ),
    "next_run": SensorEntityDescription(
        key="next_run",
        translation_key="next_run",
        device_class=SensorDeviceClass.TIMESTAMP,
    ),
    "last_liters": SensorEntityDescription(
        key="last_liters",
        translation_key="last_liters",
        device_class=SensorDeviceClass.WATER,
        native_unit_of_measurement=UnitOfVolume.LITERS,
        # No state_class: this is the last run's volume (a snapshot that jumps up/down
        # per run, not monotonic), and HA rejects 'measurement' for device_class water
        # (expects None/total/total_increasing). None = no long-term statistics, which
        # is correct here. consumption_today stays total_increasing (cumulative).
    ),
}

SOIL_DESCRIPTION = SensorEntityDescription(
    key="moisture",
    translation_key="moisture",
    device_class=SensorDeviceClass.HUMIDITY,
    native_unit_of_measurement=PERCENTAGE,
    state_class=SensorStateClass.MEASUREMENT,
)


def _build_entities(coordinator: GardenESPCoordinator) -> list[GardenESPSensor]:
    """The full desired sensor set derived from the current stored config."""
    cfg = coordinator.config
    entities: list[GardenESPSensor] = []

    for source in cfg.sources.values():
        box_id = box_of_ref(source.level_input) or box_of_ref(source.meter_input)
        dev = child_device_info(source.id, source.name, box_id, "source")
        keys = (
            ("level", "level_pct", "consumption_today")
            if source.type == SOURCE_CISTERN
            else ("consumption_today",)
        )
        for key in keys:
            entities.append(
                GardenESPSensor(coordinator, source.id, SOURCE_DESCRIPTIONS[key], dev)
            )

    for line in cfg.lines.values():
        dev = child_device_info(line.id, line.name, line.box_id, "line")
        for desc in LINE_DESCRIPTIONS.values():
            entities.append(GardenESPSensor(coordinator, line.id, desc, dev))

    for box in cfg.boxes.values():
        for inp in box.inputs:
            if inp.kind != INPUT_SOIL_MOISTURE:
                continue
            ref = f"{box.id}#{inp.id}"
            dev = child_device_info(ref, inp.name, box.id, "sensor")
            entities.append(GardenESPSensor(coordinator, ref, SOIL_DESCRIPTION, dev))

    return entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create read-only sensor entities from the stored configuration.

    Newly-created objects are added in place via ``SIGNAL_ADD_ENTITIES`` (so a
    save no longer needs a full entry reload); ``known`` guards against re-adding
    the existing ones.
    """
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


class GardenESPSensor(GardenESPEntity, SensorEntity):
    """A read-only GardenESP sensor."""

    def __init__(self, coordinator, obj_id, description, device_info) -> None:
        super().__init__(coordinator, obj_id, description.key, device_info)
        self.entity_description = description

    @property
    def native_value(self):  # noqa: ANN201
        return self._value
