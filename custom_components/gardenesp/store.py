"""Persistence layer for GardenESP (FDS §9.4).

Three versioned ``Store`` files under ``.storage/``:
  * ``gardenesp.config``  — configuration (single source of truth)
  * ``gardenesp.history`` — Bewässerungs-Protokoll (rolling)
  * ``gardenesp.runtime`` — in-flight runs (restart safety, FR-A5)

The coordinator is the only writer (writes are debounced by the caller).
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_VERSION, STORE_CONFIG, STORE_HISTORY, STORE_RUNTIME


class GardenESPStore:
    """Thin wrapper around the three HA stores."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._config: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORE_CONFIG)
        self._history: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORE_HISTORY)
        self._runtime: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORE_RUNTIME)

    # --- config ---------------------------------------------------------------
    async def async_load_config(self) -> dict[str, Any]:
        return await self._config.async_load() or {}

    async def async_save_config(self, data: dict[str, Any]) -> None:
        await self._config.async_save(data)

    # --- history --------------------------------------------------------------
    async def async_load_history(self) -> dict[str, Any]:
        return await self._history.async_load() or {"entries": []}

    async def async_save_history(self, data: dict[str, Any]) -> None:
        await self._history.async_save(data)

    # --- runtime --------------------------------------------------------------
    async def async_load_runtime(self) -> dict[str, Any]:
        return await self._runtime.async_load() or {"active": []}

    async def async_save_runtime(self, data: dict[str, Any]) -> None:
        await self._runtime.async_save(data)
