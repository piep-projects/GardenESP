"""GardenESP coordinator — the integration's brain (FDS §5.6a).

Owns the scheduler, the per-source queue, the run-sequence and the run/history
state. The decision maths live in the pure, unit-tested modules
:mod:`.schedule`, :mod:`.gates` and :mod:`.calc`; this class wires them to HA
timers, services and storage.

Automatik runs entirely here (integration-internal, Entscheidung 17), **not** as
generated HA automations. On-device Emergency Shutdown and ConnectedDevice
(FR-E1/E2) are firmware concerns and are *not* implemented here.

Open wiring (marked TODO): mapping a box output/input ref to the concrete
ESPHome entity_id, and reading sensor/level state. Until those land,
``_sensor_blocking``/``_level_ok`` use safe defaults and ``_async_switch``/
``_async_read_level`` are no-ops.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.event import (
    async_call_later,
    async_track_point_in_time,
    async_track_state_change_event,
    async_track_time_change,
)
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from . import calc, drift, esphome_yaml, gates, ids, state
from .const import (
    DOMAIN,
    HISTORY_DEFAULT_MONTHS,
    INPUT_BUTTON,
    INPUT_PULSE_METER,
    LINE_KIND_SWITCH,
    INPUT_RAIN,
    INPUT_SOIL_MOISTURE,
    RESULT_COMPLETED,
    RESULT_EMERGENCY,
    RESULT_INTERRUPTED,
    RESULT_SKIPPED_UNREACHABLE,
    RESULT_STOPPED,
    RESULT_SUPERSEDED,
    SOURCE_CISTERN,
    STATUS_ACTIVE,
    STATUS_AUTOMATIC_OFF,
    STATUS_BLOCKED_LEVEL,
    STATUS_BLOCKED_SENSOR,
    STATUS_BOX_DISABLED,
    STATUS_IDLE,
    STATUS_SETTLING,
    STATUS_UNREACHABLE,
    STATUS_WAITING,
)
from .models import Box, Input, IrrigationConfig, Line, Output, Source
from .schedule import next_run_for_schedule
from .store import GardenESPStore

_LOGGER = logging.getLogger(__name__)

_GATE_TO_RESULT = {
    gates.SKIPPED_SENSOR: (STATUS_BLOCKED_SENSOR, gates.SKIPPED_SENSOR),
    gates.SKIPPED_LEVEL: (STATUS_BLOCKED_LEVEL, gates.SKIPPED_LEVEL),
}

_KIND_FROM_DICT = {
    "box": Box.from_dict,
    "line": Line.from_dict,
    "source": Source.from_dict,
}
_KIND_ATTR = {"box": "boxes", "line": "lines", "source": "sources"}

# Debounce window for the auto re-resolve triggered by ESPHome entity-registry
# changes (a flash that adds/renames entities fires a burst of create/update
# events on reconnect — coalesce them into a single resolve pass).
_RESOLVE_DEBOUNCE_S = 3.0


class GardenESPCoordinator(DataUpdateCoordinator[None]):
    """Event-driven coordinator (no polling)."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=None)
        self.entry = entry
        self.store = GardenESPStore(hass)
        self.config = IrrigationConfig()
        self.values: dict[str, Any] = {}  # keyed by entity unique_id (FDS §9.2)
        self._unsub: dict[str, Any] = {}  # line_id -> cancel timer
        self._unsub_state: Any = None  # ESPHome state tracking
        self._source_locks: dict[str, asyncio.Lock] = {}
        self._run_tasks: dict[str, asyncio.Task[Any]] = {}  # line_id -> in-flight run task
        self._run_ctx: dict[str, dict[str, Any]] = {}  # line_id -> run context (for stop-time consumption)
        self._next_duration: dict[str, int] = {}  # line_id -> armed entry's duration_min
        self._box_cfg_hash: dict[str, str] = {}  # box_id -> firmware config hash (#9)
        self._unsub_midnight: Any = None  # daily consumption_today reset (CR-0002)
        # box_id -> (boot_count@00:00-today, boot_count@00:00-yesterday) for restart
        # diagnostics (FR-S13); refreshed from the recorder at setup + midnight, and
        # lazily once the boot-count entity first appears (after a reflash/reconnect).
        self._boot_baseline: dict[str, tuple[float | None, float | None]] = {}
        self._baseline_refreshing = False  # dedupe the lazy self-heal refresh
        # box_id -> last-seen cumulative emergency-shutdown count; an increment is
        # logged as an ``emergency`` run-result on the box's most recent run (CR-0011).
        self._emergency_seen: dict[str, float] = {}
        self._last_run_line: dict[str, str] = {}  # box_id -> most recently started line
        # Auto re-resolve on ESPHome entity-registry changes (post-flash self-heal):
        self._unsub_registry: Any = None
        self._resolve_debounce: Any = None  # pending async_call_later cancel handle
        self._dirty_boxes: set[str] = set()  # box ids awaiting a debounced resolve

    # --- lifecycle ------------------------------------------------------------
    async def async_setup(self) -> None:
        raw = await self.store.async_load_config()
        self.config = IrrigationConfig.from_storage(raw)
        _LOGGER.debug(
            "GardenESP loaded: %d boxes, %d sources, %d lines",
            len(self.config.boxes),
            len(self.config.sources),
            len(self.config.lines),
        )
        self._resolve_all_boxes()  # self-heal entity refs against the live registry
        self._recompute_all_box_hashes()  # firmware config fingerprints (#9)
        self._ensure_line_seqs()  # backfill stable box-scoped L-numbers (FDS §3)
        await self.async_save_config()
        await self._async_recover_runtime()
        self._async_reschedule_all()
        self._async_setup_state_tracking()
        self._async_refresh_live()
        await self._async_refresh_consumption_today()  # recover today's total (CR-0002)
        await self._async_refresh_restart_baselines()  # boot-counter baselines (FR-S13)
        # Daily reset: recompute at midnight so the value drops to 0 for the new day.
        self._unsub_midnight = async_track_time_change(
            self.hass, self._async_on_midnight, hour=0, minute=0, second=10
        )
        # Auto-heal entity refs whenever a box's ESPHome entities change (a flash
        # that adds/renames entities, or the device being (re-)added) — so a manual
        # „Entities abgleichen" is no longer needed for the common case. The button
        # stays as a manual override / explicit recheck.
        self._unsub_registry = self.hass.bus.async_listen(
            er.EVENT_ENTITY_REGISTRY_UPDATED, self._async_on_registry_update
        )

    async def async_shutdown(self) -> None:
        for unsub in self._unsub.values():
            unsub()
        self._unsub.clear()
        if self._unsub_state is not None:
            self._unsub_state()
            self._unsub_state = None
        if self._unsub_midnight is not None:
            self._unsub_midnight()
            self._unsub_midnight = None
        if self._unsub_registry is not None:
            self._unsub_registry()
            self._unsub_registry = None
        if self._resolve_debounce is not None:
            self._resolve_debounce()
            self._resolve_debounce = None

    # --- value cache / listeners ---------------------------------------------
    def _set_value(self, obj_id: str, key: str, value: Any) -> None:
        self.values[f"{obj_id}__{key}"] = value
        self.async_update_listeners()

    def _set_status(self, line: Line, status: str) -> None:
        self._set_value(line.id, "status", status)

    # --- config mutation (WebSocket write side, FDS §5.5 / §9.4) --------------
    async def async_save_config(self) -> None:
        await self.store.async_save_config(self.config.to_storage())

    def _container(self, kind: str) -> dict[str, Any]:
        return getattr(self.config, _KIND_ATTR[kind])

    async def async_upsert(self, kind: str, data: dict[str, Any]) -> str:
        """Create or update an object; returns its id (generated if new)."""
        obj_id = data.get("id") or ids.new_id(kind)
        container = self._container(kind)
        is_new = obj_id not in container
        data = {**data, "id": obj_id}
        # Track create/modify timestamps (FR-S11) for boxes, lines and sources.
        now = dt_util.utcnow().isoformat()
        existing = container.get(obj_id)
        data["created_at"] = (
            now if is_new else (getattr(existing, "created_at", None) or now)
        )
        data["updated_at"] = now
        if kind == "line":
            data["seq"] = self._line_seq_for_upsert(data, existing, is_new)
        obj = _KIND_FROM_DICT[kind](data)
        if kind == "box":
            # Resolve outputs/inputs to real HA entity_ids (don't trust the
            # client's guessed `entity` field — see _resolve_box_entities).
            self._resolve_box_entities(obj)
        container[obj_id] = obj
        await self.async_save_config()
        if kind == "box" and not obj.enabled:
            # Deactivating a box takes it out of service immediately (FR-S).
            await self._async_stop_lines_for_box(obj_id)
        if is_new:
            self._schedule_reload()  # new object → (re)create its entities
        else:
            self._post_config_change()
        return obj_id

    def _line_seq_for_upsert(
        self, data: dict[str, Any], existing: Any, is_new: bool
    ) -> int:
        """Stable box-scoped L-number for a line on up­sert (FDS §3): switches
        carry none; existing lines keep theirs; a new line gets the next free."""
        if data.get("kind") == LINE_KIND_SWITCH:
            return 0
        if not is_new and getattr(existing, "seq", 0):
            return existing.seq
        return ids.next_line_seq(
            ln.seq
            for ln in self.config.lines.values()
            if ln.box_id == data.get("box_id") and ln.kind != LINE_KIND_SWITCH
        )

    def _ensure_line_seqs(self) -> bool:
        """Backfill stable L-numbers for irrigation lines that lack one (legacy
        data) — per box, in ``created_at`` order, after the box's current max.
        Returns ``True`` if anything changed so the caller persists."""
        changed = False
        by_box: dict[str, list[Line]] = {}
        for line in self.config.lines.values():
            if line.kind != LINE_KIND_SWITCH:
                by_box.setdefault(line.box_id, []).append(line)
        for lines in by_box.values():
            missing = sorted(
                (ln for ln in lines if not ln.seq),
                key=lambda ln: (ln.created_at or "", ln.id),
            )
            for line in missing:
                line.seq = ids.next_line_seq(ln.seq for ln in lines)
                changed = True
        return changed

    async def _async_stop_lines_for_box(self, box_id: str) -> None:
        """Stop every in-flight run that a (now deactivated) box takes out of
        service — its own lines AND lines drawing from a source on this box."""
        for line in self.config.lines.values():
            if line.id not in self._run_tasks:
                continue
            source = self.config.sources.get(line.source_id) if line.source_id else None
            if line.box_id == box_id or box_id in self._source_boxes(source):
                await self.async_stop_line(line.id)

    async def async_delete(self, kind: str, obj_id: str) -> None:
        self._container(kind).pop(obj_id, None)
        await self.async_save_config()
        self._schedule_reload()

    async def async_set_settings(self, data: dict[str, Any]) -> None:
        """Merge global settings (e.g. history_months) and persist (no reload)."""
        self.config.settings.update(data)
        await self.async_save_config()

    # --- entity resolution (FR-S9: map ref → real HA entity_id) ----------------
    # HA assigns ESPHome entity_ids from the device friendly-name (+ area at
    # creation, frozen afterwards), NOT from our node name — so deriving the id
    # by string is unreliable. Instead we look the real id up in the entity
    # registry, keyed on the stable (domain, ASCII-folded name) the firmware
    # emits, and store that. Immune to friendly-name/area/rename drift.
    def _esphome_entry_id_for_box(self, box: Box) -> str | None:
        node = esphome_yaml.device_name(
            {"label": box.label, "name": box.name, "id": box.id}
        )
        for entry in self.hass.config_entries.async_entries("esphome"):
            if entry.data.get("device_name") == node:
                return entry.entry_id
        return None

    def _resolve_box_entities(self, box: Box) -> tuple[int, int]:
        """Match each output/input of ``box`` to its live HA entity_id via the
        ESPHome device's registry entries. Returns ``(resolved, total)``."""
        total = len(box.outputs) + len(box.inputs)
        entry_id = self._esphome_entry_id_for_box(box)
        if entry_id is None:
            return 0, total  # device not added to HA yet → nothing to match
        reg = er.async_get(self.hass)
        # index: (domain, folded original_name) → entity_id
        index: dict[tuple[str, str], str] = {}
        for ent in er.async_entries_for_config_entry(reg, entry_id):
            if ent.original_name:
                key = (ent.domain, esphome_yaml.ascii_fold(ent.original_name))
                index.setdefault(key, ent.entity_id)
        resolved = 0
        for o in box.outputs:
            eid = index.get(("switch", esphome_yaml.ascii_fold(o.name)))
            if eid:
                o.entity = eid
                resolved += 1
        for inp in box.inputs:
            dom = "binary_sensor" if inp.kind in (INPUT_RAIN, INPUT_BUTTON) else "sensor"
            # A pulse_meter emits a rate sensor (= input name) *and* a cumulative
            # "… total" sub-sensor. Consumption needs the cumulative one, so resolve
            # pulse_meter inputs to the "… total" entity, not the rate (CR-0004).
            name = f"{inp.name} total" if inp.kind == INPUT_PULSE_METER else inp.name
            eid = index.get((dom, esphome_yaml.ascii_fold(name)))
            if eid:
                inp.entity = eid
                resolved += 1
        return resolved, total

    def _resolve_all_boxes(self) -> None:
        """Self-heal stored entity refs for every box (called once on setup)."""
        for box in self.config.boxes.values():
            self._resolve_box_entities(box)

    async def async_sync_box_entities(self, box_id: str) -> dict[str, int]:
        """Re-resolve a box's entity refs on demand (panel „Entities abgleichen")."""
        box = self.config.boxes.get(box_id)
        if box is None:
            return {"resolved": 0, "total": 0}
        resolved, total = self._resolve_box_entities(box)
        await self.async_save_config()
        self._post_config_change()
        return {"resolved": resolved, "total": total}

    # --- auto re-resolve on registry change (post-flash self-heal) -------------
    @staticmethod
    def _box_entity_snapshot(box: Box) -> tuple[str | None, ...]:
        """The box's current output+input entity refs, for change detection."""
        return tuple(o.entity for o in box.outputs) + tuple(i.entity for i in box.inputs)

    def _box_for_registry_entity(self, entity_id: str) -> str | None:
        """The box id owning ``entity_id`` (via its ESPHome config entry), or None
        when the entity isn't one of our boxes' ESPHome entities."""
        ent = er.async_get(self.hass).async_get(entity_id)
        if ent is None or ent.config_entry_id is None:
            return None
        for box in self.config.boxes.values():
            if self._esphome_entry_id_for_box(box) == ent.config_entry_id:
                return box.id
        return None

    @callback
    def _async_on_registry_update(self, event: Event) -> None:
        """Mark a box for a debounced re-resolve when its ESPHome entities change.

        ``remove`` is ignored: the entity is already gone (can't map it to a box),
        and the resolver only overwrites on a name match — it never clears a live
        mapping — so a removal needs no action."""
        if event.data.get("action") == "remove":
            return
        entity_id = event.data.get("entity_id")
        if not entity_id:
            return
        box_id = self._box_for_registry_entity(entity_id)
        if box_id is None:
            return
        self._dirty_boxes.add(box_id)
        if self._resolve_debounce is not None:
            self._resolve_debounce()
        self._resolve_debounce = async_call_later(
            self.hass, _RESOLVE_DEBOUNCE_S, self._async_flush_resolve
        )

    async def _async_flush_resolve(self, _now: datetime) -> None:
        """Re-resolve every box marked dirty since the last flush; persist + refresh
        only when a mapping actually changed (no churn on no-op registry events)."""
        self._resolve_debounce = None
        box_ids = self._dirty_boxes
        self._dirty_boxes = set()
        changed = False
        for box_id in box_ids:
            box = self.config.boxes.get(box_id)
            if box is None:
                continue
            before = self._box_entity_snapshot(box)
            self._resolve_box_entities(box)
            if self._box_entity_snapshot(box) != before:
                changed = True
                _LOGGER.info("GardenESP: auto-resolved entities for box %s", box_id)
        if changed:
            await self.async_save_config()
            self._post_config_change()

    # --- firmware-drift detection (roadmap #9) -------------------------------
    def _enrich_box_pumps(self, box: dict[str, Any], box_id: str) -> None:
        """Set ``pump`` on each valve from its line's source pump (same box only),
        so the generated YAML / hash include the ConnectedDevice link (FR-E2). The
        same enrichment the WS YAML view applies — kept here so YAML and hash agree."""
        by_id = {o["id"]: o for o in box.get("outputs", [])}
        for line in self.config.lines.values():
            vo = line.valve_output or ""
            if "#" not in vo:
                continue
            vbox, vlocal = vo.split("#", 1)
            if vbox != box_id or vlocal not in by_id:
                continue
            src = self.config.sources.get(line.source_id) if line.source_id else None
            po = (src.pump_output or "") if src else ""
            if "#" not in po:
                continue
            pbox, plocal = po.split("#", 1)
            if pbox == box_id and plocal in by_id:
                by_id[vlocal]["pump"] = plocal

    def _box_yaml_inputs(self, box: Box) -> tuple[dict[str, Any], str]:
        """The pump-enriched box dict + template base for YAML/hash generation."""
        box_dict = dataclasses.asdict(box)
        self._enrich_box_pumps(box_dict, box.id)
        base = "gardencontrol" if box.hw_type == "gardencontrol" else "generic"
        return box_dict, base

    def box_yaml(self, box_id: str) -> str:
        """Generated ESPHome YAML for a box (admin view + export). Raises
        ``esphome_yaml.YamlGenError`` when the box exceeds its template."""
        box = self.config.boxes[box_id]
        box_dict, base = self._box_yaml_inputs(box)
        return esphome_yaml.generate_box_yaml(box_dict, base=base)

    def box_node_name(self, box_id: str) -> str:
        """The ESPHome node ``name:`` for a box (``gardenesp-steuergeraet-<label>``).
        Used as the suggested YAML download filename so it matches the flashed
        device rather than the internal box_id."""
        box = self.config.boxes[box_id]
        return esphome_yaml.device_name(
            {"label": box.label, "name": box.name, "id": box.id}
        )

    def _recompute_box_hash(self, box: Box) -> None:
        try:
            box_dict, base = self._box_yaml_inputs(box)
            self._box_cfg_hash[box.id] = esphome_yaml.box_config_hash(box_dict, base=base)
        except esphome_yaml.YamlGenError:
            self._box_cfg_hash[box.id] = ""  # un-generatable → drift.ERROR status

    def _recompute_all_box_hashes(self) -> None:
        self._box_cfg_hash = {}
        for box in self.config.boxes.values():
            self._recompute_box_hash(box)

    def _box_device_sw_version(self, box: Box) -> str | None:
        """The flashed firmware's reported ``project.version``. HA's ESPHome
        integration stores it as the device ``sw_version`` (and derives model
        ``steuergeraet`` / manufacturer ``gardenesp`` from ``project.name``). None when the
        device isn't added to HA or never reported a project version.

        HA appends ``" (ESPHome <ver>)"`` to the project version (verified live on
        ha-test1: ``"c192e5d2aee9 (ESPHome 2026.5.3)"``), so we take the leading
        token — our config hash — before comparing."""
        entry_id = self._esphome_entry_id_for_box(box)
        if entry_id is None:
            return None
        dev_reg = dr.async_get(self.hass)
        for device in dr.async_entries_for_config_entry(dev_reg, entry_id):
            if device.sw_version:
                return device.sw_version.split(" (")[0].strip()
        return None

    def _box_online(self, box: Box) -> bool | None:
        """True if any of the box's mapped entities is currently reachable; None
        when nothing is mapped yet (device not added → status unknown)."""
        ents = [o.entity for o in box.outputs if o.entity]
        ents += [i.entity for i in box.inputs if i.entity]
        if not ents:
            return None
        for e in ents:
            st = self.hass.states.get(e)
            if st is not None and st.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                return True
        return False

    def _box_node_ip(self, box: Box) -> tuple[str | None, str | None]:
        """The box's ESPHome node name + host (IP/hostname) for the board zone
        (style-guide §4). Node is always known; host only once the device is added."""
        node = esphome_yaml.device_name(
            {"label": box.label, "name": box.name, "id": box.id}
        )
        entry_id = self._esphome_entry_id_for_box(box)
        entry = (
            self.hass.config_entries.async_get_entry(entry_id) if entry_id else None
        )
        ip = entry.data.get("host") if entry else None
        return node, ip

    def _refresh_box_fw_status(self) -> None:
        """Publish per-box firmware + device status into the value cache
        (#9d / style-guide §4: online · node · ip · firmware version)."""
        for box in self.config.boxes.values():
            cfg_hash = self._box_cfg_hash.get(box.id) or None
            flashed = self._box_device_sw_version(box)
            online = self._box_online(box)
            node, ip = self._box_node_ip(box)
            self._set_value(
                box.id,
                "fw_status",
                drift.fw_status(cfg_hash, flashed, box.exported_yaml_hash, online),
            )
            self._set_value(box.id, "fw_hash", cfg_hash)
            self._set_value(box.id, "fw_version", flashed)
            self._set_value(box.id, "online", online)
            self._set_value(box.id, "node", node)
            self._set_value(box.id, "ip", ip)
            self._refresh_box_diagnostics(box)

    def _box_diag_entities(
        self, box: Box
    ) -> tuple[str | None, str | None, str | None]:
        """``(wifi_signal, boot_count, emergency_count)`` entity_ids of a box's
        diagnostic sensors (FR-S13 / CR-0011), matched in the box's ESPHome
        config-entry registry by folded name — these sensors live in the generated
        YAML (§5.4), not in ``box.inputs``."""
        entry_id = self._esphome_entry_id_for_box(box)
        if entry_id is None:
            return None, None, None
        reg = er.async_get(self.hass)
        index: dict[str, str] = {}
        for ent in er.async_entries_for_config_entry(reg, entry_id):
            if ent.domain == "sensor" and ent.original_name:
                index.setdefault(esphome_yaml.ascii_fold(ent.original_name), ent.entity_id)
        return (
            index.get(esphome_yaml.ascii_fold(esphome_yaml.DIAG_WIFI_NAME)),
            index.get(esphome_yaml.ascii_fold(esphome_yaml.DIAG_BOOT_NAME)),
            index.get(esphome_yaml.ascii_fold(esphome_yaml.DIAG_EMERGENCY_NAME)),
        )

    def _refresh_box_diagnostics(self, box: Box) -> None:
        """Publish board diagnostics (FR-S13): live WLAN signal (dBm) and restarts
        today/yesterday (live boot counter vs. the recorder-derived day baselines)."""
        wifi, boot, emergency = self._box_diag_entities(box)
        self._check_emergency(box, emergency)
        self._set_value(box.id, "wifi_signal", self._state_float(wifi))
        current = self._state_float(boot)
        # Self-heal: if the boot-count entity has a value but no baseline yet (it
        # appeared after the last refresh, e.g. a reflash/reconnect), establish the
        # baselines once so restart counts show instead of staying blank.
        if (
            current is not None
            and box.id not in self._boot_baseline
            and not self._baseline_refreshing
        ):
            self._baseline_refreshing = True
            self.hass.async_create_task(self._async_refresh_restart_baselines())
        at_today, at_prev = self._boot_baseline.get(box.id, (None, None))
        today, yesterday = calc.restart_counts(current, at_today, at_prev)
        self._set_value(box.id, "restarts_today", today)
        self._set_value(box.id, "restarts_yesterday", yesterday)

    def _check_emergency(self, box: Box, entity: str | None) -> None:
        """Record an ``emergency`` when the box's NVS emergency-shutdown counter
        increments (CR-0011). Online the firmware pushes the increment instantly
        (``component.update``) and the counter sensor is tracked, so this fires within
        seconds; offline (WiFi/HA blind, S4) it is caught on reconnect. Attributed to
        the box's most recently started line (exact for single-valve boxes). The first
        reading only seeds the baseline so historical firings aren't replayed at setup.

        If that line still has an **active run** (online: the backstop cut it short),
        the run is ended now under ``emergency`` — so HA's own timer can't later log a
        phantom ``completed`` over the full planned duration. Otherwise (the run was
        already closed, e.g. as ``interrupted`` at a disconnect) a standalone entry is
        logged. ``_emergency_seen`` is advanced before acting, so the near-simultaneous
        valve-off and counter-push events can't double-log."""
        current = self._state_float(entity)
        if current is None:  # box unavailable / no such sensor → keep last baseline
            return
        prev = self._emergency_seen.get(box.id)
        self._emergency_seen[box.id] = current
        if prev is None or current <= prev:  # seed, or no new firing (or NVS reset)
            return
        line_id = self._last_run_line.get(box.id)
        line = self.config.lines.get(line_id) if line_id else None
        if line is None:
            return
        task = self._run_tasks.get(line.id)
        if task is not None and not task.done():
            self.hass.async_create_task(
                self.async_stop_line(line.id, result=RESULT_EMERGENCY)
            )
        else:
            self.hass.async_create_task(
                self._async_log(line, 0, None, "auto", RESULT_EMERGENCY)
            )

    async def _recorder_samples(
        self, entity_id: str, start: datetime, end: datetime
    ) -> list[tuple[datetime, float]]:
        """``(timestamp, float-value)`` samples of ``entity_id`` from the recorder
        over ``[start, end]`` (incl. the state at ``start``). Non-numeric states are
        skipped. Runs in the recorder executor."""
        from homeassistant.components.recorder import get_instance, history

        def _query() -> list[tuple[datetime, float]]:
            states = history.state_changes_during_period(
                self.hass, start, end, entity_id, include_start_time_state=True
            )
            out: list[tuple[datetime, float]] = []
            for st in states.get(entity_id, []):
                try:
                    out.append((st.last_changed, float(st.state)))
                except (ValueError, TypeError):
                    continue
            return out

        return await get_instance(self.hass).async_add_executor_job(_query)

    async def _async_refresh_restart_baselines(self) -> None:
        """Establish each box's boot-counter value at the start of today and
        yesterday from the recorder, so restart counts derive live (FR-S13). When
        the recorder has no samples yet (entity just appeared), fall back to the
        live value as the baseline → restarts read 0 until real history accrues."""
        now = dt_util.now()
        today_start = dt_util.as_utc(dt_util.start_of_local_day(now))
        prev_start = today_start - timedelta(days=1)
        try:
            for box in self.config.boxes.values():
                _, boot, _ = self._box_diag_entities(box)
                if not boot:
                    self._boot_baseline.pop(box.id, None)
                    continue
                samples = await self._recorder_samples(boot, prev_start, now)
                live = self._state_float(boot)
                at_today = calc.counter_at(samples, today_start)
                at_prev = calc.counter_at(samples, prev_start)
                if at_today is None:  # no history yet → live value is today's baseline
                    at_today = live
                if at_prev is None:
                    at_prev = at_today
                if at_today is None:  # neither history nor a live value → unknown
                    self._boot_baseline.pop(box.id, None)
                else:
                    self._boot_baseline[box.id] = (at_today, at_prev)
        finally:
            self._baseline_refreshing = False
        self._async_refresh_live()  # republish restart counts from fresh baselines

    async def async_mark_box_exported(self, box_id: str) -> str | None:
        """Record that the admin fetched a box's YAML (copy/download) — stores the
        current config hash as ``exported_yaml_hash`` (fallback drift signal #9c)."""
        box = self.config.boxes.get(box_id)
        if box is None:
            return None
        h = self._box_cfg_hash.get(box_id) or None
        if h and box.exported_yaml_hash != h:
            box.exported_yaml_hash = h
            await self.async_save_config()
        self._refresh_box_fw_status()
        return h

    def _post_config_change(self) -> None:
        """Re-arm scheduler + state tracking after an in-place edit."""
        self._recompute_all_box_hashes()
        self._async_reschedule_all()
        if self._unsub_state is not None:
            self._unsub_state()
            self._unsub_state = None
        self._async_setup_state_tracking()
        self._async_refresh_live()

    def _schedule_reload(self) -> None:
        self.hass.config_entries.async_schedule_reload(self.entry.entry_id)

    # --- restart safety (FR-A5) ----------------------------------------------
    async def _async_recover_runtime(self) -> None:
        runtime = await self.store.async_load_runtime()
        active = runtime.get("active", [])
        if not active:
            return
        _LOGGER.warning(
            "GardenESP: %d run(s) interrupted by restart — turning off + logging",
            len(active),
        )
        for run in active:
            line = self.config.lines.get(run.get("line_id"))
            if line is not None:
                await self._async_switch(line, False)
                # TODO (FR-A5): optionally resume remaining time instead of stop;
                #               write a `stopped` protocol entry.
        await self.store.async_save_runtime({"active": []})

    # --- scheduler (FDS §5.6a / FR-A4) ---------------------------------------
    def _async_reschedule_all(self) -> None:
        for unsub in self._unsub.values():
            unsub()
        self._unsub.clear()
        now = dt_util.now()
        for line in self.config.lines.values():
            self._async_schedule_line(line, now)

    def _async_schedule_line(self, line: Line, now: datetime) -> None:
        self._unsub.pop(line.id, lambda: None)()  # cancel previous if any
        if self._line_out_of_service(line):
            # Box (or its source's box) out of service → never schedule.
            self._set_value(line.id, "next_run", None)
            self._next_duration.pop(line.id, None)
            self._set_status(line, STATUS_BOX_DISABLED)
            return
        # Box (re)enabled: clear a stale resting status for a line that isn't running.
        if line.id not in self._run_tasks:
            self._set_status(line, STATUS_IDLE if line.automatic else STATUS_AUTOMATIC_OFF)
        if not line.automatic:
            self._set_value(line.id, "next_run", None)
            self._next_duration.pop(line.id, None)
            return
        result = next_run_for_schedule(line.schedule, now)
        self._set_value(line.id, "next_run", result[0] if result else None)
        if result is None:
            self._next_duration.pop(line.id, None)
            return
        nxt, self._next_duration[line.id] = result

        @callback
        def _fire(_fire_time: datetime, line_id: str = line.id) -> None:
            self.hass.async_create_task(self._async_on_schedule(line_id))

        self._unsub[line.id] = async_track_point_in_time(self.hass, _fire, nxt)

    async def _async_on_schedule(self, line_id: str) -> None:
        line = self.config.lines.get(line_id)
        if line is None:
            return
        # Capture the firing entry's duration before re-arming overwrites it.
        duration = self._next_duration.get(line_id, 0)
        self._async_schedule_line(line, dt_util.now())  # arm the *next* occurrence
        await self.async_trigger_scheduled(line_id, duration)

    # --- gate-checked entry points -------------------------------------------
    async def async_trigger_scheduled(self, line_id: str, duration_min: int = 0) -> None:
        line = self.config.lines.get(line_id)
        if line is None:
            return
        if self._line_out_of_service(line):
            self._set_status(line, STATUS_BOX_DISABLED)
            return
        if self._switch_unavailable(line):  # #9e — can't reach the valve, don't run
            self._set_status(line, STATUS_UNREACHABLE)
            await self._async_log(line, 0, None, "auto", RESULT_SKIPPED_UNREACHABLE)
            return
        result = gates.evaluate_gates(
            manual=False,
            automatic=line.automatic,
            sensor_blocking=self._sensor_blocking(line),
            sensor_override=line.sensor_override,
            level_ok=self._level_ok(line),
        )
        await self._async_apply_gate(line, result, duration_min, "auto")

    async def async_start_line(
        self, line_id: str, duration_min: float | None = None, *, force: bool = False
    ) -> None:
        """Manual start (panel only, FR-X3). Skips the Automatik gate (FR-D5);
        ``force`` is the ad-hoc 'Start trotzdem' sensor override."""
        line = self.config.lines.get(line_id)
        if line is None:
            return
        if self._line_out_of_service(line):
            self._set_status(line, STATUS_BOX_DISABLED)
            return
        if self._switch_unavailable(line):  # #9e — can't reach the valve, don't run
            self._set_status(line, STATUS_UNREACHABLE)
            await self._async_log(line, 0, None, "manual", RESULT_SKIPPED_UNREACHABLE)
            return
        result = gates.evaluate_gates(
            manual=True,
            automatic=line.automatic,
            sensor_blocking=self._sensor_blocking(line),
            sensor_override=line.sensor_override or force,
            level_ok=self._level_ok(line),
        )
        duration = duration_min if duration_min is not None else line.manual_default_min
        await self._async_apply_gate(line, result, duration, "manual")

    async def async_stop_line(self, line_id: str, *, result: str = RESULT_STOPPED) -> None:
        """Stop a line's run, logging the watered portion under ``result``. Defaults to
        the deliberate ``stopped``; the unreachable guard passes ``interrupted`` and an
        online on-device backstop passes ``emergency`` (CR-0011) so they surface as
        disturbances rather than a normal manual stop."""
        stop_result = result
        line = self.config.lines.get(line_id)
        if line is None:
            return
        # Take the run context first so the run task (cancelled below) can't also
        # finalize it — whoever holds the context books the consumption.
        ctx = self._run_ctx.pop(line_id, None)
        # Cancel the in-flight run task so it stops sleeping and releases the
        # source lock (otherwise the next start would queue as "waiting").
        task = self._run_tasks.get(line_id)
        if task is not None and not task.done():
            task.cancel()
        await self._async_switch(line, False)
        self._set_value(line.id, "started", None)
        self._set_value(line.id, "until", None)
        self._set_status(line, STATUS_IDLE)
        await self._async_remove_runtime(line)
        if ctx is None:
            return  # nothing was running → no spurious log entry
        if ctx.get("started") is None:
            # Stopped while still queued (never actually watered) — log a 0-min stop
            # so the trigger isn't a silent drop, but book no consumption.
            await self._async_log(line, 0, None, ctx.get("trigger", "manual"), stop_result)
            return
        # Book the Δ-consumption up to the stop, like the natural end (CR-0005).
        source = ctx["source"]
        end_l = self._read_level(source)
        liters = calc.run_consumption(
            ctx["start_l"], end_l, is_cistern=source is not None and source.type == SOURCE_CISTERN
        )
        if ctx["watering_done"]:
            # Stopped during the settle/measurement — the watering ran in full.
            duration, result = ctx["planned_min"], RESULT_COMPLETED
        else:
            # Actual elapsed minutes (fractional → sub-minute stops aren't rounded
            # away to 0; the UI shows seconds below 1 min).
            elapsed = (dt_util.utcnow() - ctx["started"]).total_seconds() / 60
            duration, result = round(max(0.0, elapsed), 2), stop_result
        # A stop never settles → a cistern's measured liters are an estimate (~).
        approx = liters is not None and source is not None and source.type == SOURCE_CISTERN
        self._set_value(line.id, "last_liters", liters)
        await self._async_log(line, duration, liters, ctx["trigger"], result, approx=approx,
                              start=ctx["started"], end=dt_util.utcnow())

    async def _async_apply_gate(
        self, line: Line, result: str, duration_min: int, trigger: str
    ) -> None:
        if result == gates.PROCEED:
            await self._async_enqueue_and_run(line, duration_min, trigger)
        elif result in _GATE_TO_RESULT:
            status, log_result = _GATE_TO_RESULT[result]
            self._set_status(line, status)
            await self._async_log(line, 0, None, trigger, log_result)
        elif result == gates.AUTOMATIC_OFF:
            self._set_status(line, STATUS_AUTOMATIC_OFF)

    # --- queue + run-sequence (FDS §5.6a) ------------------------------------
    @staticmethod
    def _is_switch(line: Line) -> bool:
        """A Steuerung (generic switched output) vs. an irrigation line (FR-SW)."""
        return line.kind == LINE_KIND_SWITCH

    def _source_lock(self, source_id: str | None) -> asyncio.Lock:
        key = source_id or "_none"
        return self._source_locks.setdefault(key, asyncio.Lock())

    async def _async_enqueue_and_run(
        self, line: Line, duration_min: int, trigger: str
    ) -> None:
        # A line runs at most once at a time: cancel any in-flight run of THIS
        # line first (manual restart / auto+manual overlap) so it can't queue
        # behind itself and hold its own source lock.
        await self._async_cancel_run(line.id)
        task = asyncio.current_task()
        self._run_tasks[line.id] = task  # type: ignore[assignment]
        # Pre-context (started=None) so a run that is superseded *while still queued*
        # still leaves a trace (CR-0006 A). _async_run_line/_switch overwrite this
        # with the full context once watering actually begins.
        self._run_ctx[line.id] = {
            "start_l": None, "started": None,
            "source": self.config.sources.get(line.source_id) if line.source_id else None,
            "planned_min": duration_min, "trigger": trigger, "watering_done": False,
        }
        try:
            # Steuerungen have no water source → no shared queue/lock; they run
            # independently (single-run-per-line is already enforced above).
            if self._is_switch(line):
                await self._async_run_line(line, duration_min, trigger)
                return
            lock = self._source_lock(line.source_id)
            if lock.locked():
                self._set_status(line, STATUS_WAITING)  # FR-A2: another line on this source
            async with lock:
                await self._async_run_line(line, duration_min, trigger)
        finally:
            if self._run_tasks.get(line.id) is task:
                self._run_tasks.pop(line.id, None)

    async def _async_cancel_run(self, line_id: str) -> None:
        """Cancel the in-flight run task for ``line_id`` (if any) and wait for it
        to unwind — its ``finally`` turns the valve off and releases the source
        lock — so a follow-up start won't queue as 'waiting'."""
        task = self._run_tasks.get(line_id)
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 — the run task logs its own failures
            pass
        # The cancelled run unwound without logging (its finally only turns the valve
        # off). Book a `superseded` entry so a restart-superseded auto/queued run is
        # not a silent drop (CR-0006 A). The dashboard ■ path logs via async_stop_line.
        ctx = self._run_ctx.pop(line_id, None)
        line = self.config.lines.get(line_id)
        if ctx is not None and line is not None:
            await self._async_book_interrupted(line, ctx)

    async def _async_book_interrupted(self, line: Line, ctx: dict[str, Any]) -> None:
        """Log a run that was cancelled by a same-line restart (CR-0006 A) as
        ``superseded`` — with the elapsed duration + Δ-consumption if it had already
        started watering, else a 0-min trace (it was still queued)."""
        self._set_value(line.id, "started", None)
        self._set_value(line.id, "until", None)
        started = ctx.get("started")
        if started is None:  # superseded while queued — never watered
            await self._async_log(line, 0, None, ctx.get("trigger", "auto"), RESULT_SUPERSEDED)
            return
        source = ctx.get("source")
        is_cistern = source is not None and source.type == SOURCE_CISTERN
        liters = calc.run_consumption(ctx.get("start_l"), self._read_level(source), is_cistern=is_cistern)
        elapsed = (dt_util.utcnow() - started).total_seconds() / 60
        self._set_value(line.id, "last_liters", liters)
        await self._async_log(
            line, round(max(0.0, elapsed), 2), liters, ctx.get("trigger", "auto"),
            RESULT_SUPERSEDED, approx=liters is not None and is_cistern,
            start=started, end=dt_util.utcnow(),
        )

    async def _async_run_line(
        self, line: Line, duration_min: int, trigger: str
    ) -> None:
        if self._is_switch(line):
            await self._async_run_switch(line, duration_min, trigger)
            return
        source = self.config.sources.get(line.source_id) if line.source_id else None
        start_l = self._read_level(source)
        await self._async_add_runtime(line, duration_min, trigger)
        started = dt_util.utcnow()  # live remaining-time counter (FR-D2)
        # Context so a manual stop can book the same Δ-consumption (CR-0005).
        self._run_ctx[line.id] = {
            "start_l": start_l, "started": started, "source": source,
            "planned_min": duration_min, "trigger": trigger, "watering_done": False,
        }
        self._last_run_line[line.box_id] = line.id  # attribute on-device emergency (CR-0011)
        self._set_value(line.id, "started", started.isoformat())
        self._set_value(line.id, "until", (started + timedelta(minutes=duration_min)).isoformat())
        self._set_status(line, STATUS_ACTIVE)
        await self._async_switch(line, True)
        try:
            await asyncio.sleep(max(0, duration_min) * 60)
        finally:
            await self._async_switch(line, False)
        # Watering finished; the cistern settle/measurement is a separate phase —
        # show it as „Nachlauf" (not a stuck Aktiv 00:00:00) and drop the countdown.
        self._run_ctx[line.id]["watering_done"] = True
        # Cistern settle (FR-A3) for accurate level measurement — skipped for a
        # manual draw on a line flagged `manual_skip_settle` (hose: no wait; the
        # cistern consumption is then only approximate).
        settle = (
            source is not None and source.type == SOURCE_CISTERN and source.tank_settle_min
            and not (trigger == "manual" and line.manual_skip_settle)
        )
        if settle:
            self._set_value(line.id, "until", None)
            self._set_status(line, STATUS_SETTLING)
            await asyncio.sleep(source.tank_settle_min * 60)
        end_l = self._read_level(source)
        # Cistern level drops, mains meter rises — sign per source type (CR-0003).
        liters = calc.run_consumption(
            start_l, end_l, is_cistern=source is not None and source.type == SOURCE_CISTERN
        )
        self._run_ctx.pop(line.id, None)
        # Cistern level measured without the settle pause → only an estimate (~).
        approx = (
            liters is not None and source is not None
            and source.type == SOURCE_CISTERN and not settle
        )
        self._set_value(line.id, "last_liters", liters)
        self._set_value(line.id, "started", None)
        self._set_value(line.id, "until", None)
        self._set_status(line, STATUS_IDLE)
        await self._async_remove_runtime(line)
        await self._async_log(line, duration_min, liters, trigger, RESULT_COMPLETED,
                              approx=approx, start=started, end=dt_util.utcnow())

    async def _async_run_switch(
        self, line: Line, duration_min: int, trigger: str
    ) -> None:
        """Run a Steuerung (FR-A4a): turn on → (optional) wait duration → off. No
        source/level/settle/consumption. ``duration_min`` ≤ 0 = stay on until the
        run is stopped (manual ■) or cancelled (Dauerbetrieb)."""
        await self._async_add_runtime(line, duration_min, trigger)
        started = dt_util.utcnow()
        # Context so a manual stop logs the actual elapsed duration (liters stay None).
        self._run_ctx[line.id] = {
            "start_l": None, "started": started, "source": None,
            "planned_min": duration_min, "trigger": trigger, "watering_done": False,
        }
        self._last_run_line[line.box_id] = line.id  # attribute on-device emergency (CR-0011)
        self._set_value(line.id, "started", started.isoformat())
        timed = duration_min and duration_min > 0
        self._set_value(
            line.id, "until",
            (started + timedelta(minutes=duration_min)).isoformat() if timed else None,
        )
        self._set_status(line, STATUS_ACTIVE)
        await self._async_switch(line, True)
        try:
            if timed:
                await asyncio.sleep(duration_min * 60)
            else:
                await asyncio.Event().wait()  # Dauerbetrieb: until stopped/cancelled
        finally:
            await self._async_switch(line, False)
        # Natural end (only reached for a fixed duration; Dauerbetrieb ends via stop).
        self._run_ctx.pop(line.id, None)
        self._set_value(line.id, "started", None)
        self._set_value(line.id, "until", None)
        self._set_status(line, STATUS_IDLE)
        await self._async_remove_runtime(line)
        await self._async_log(line, duration_min, None, trigger, RESULT_COMPLETED,
                              start=started, end=dt_util.utcnow())

    # --- runtime store helpers (FR-A5) ---------------------------------------
    async def _async_add_runtime(
        self, line: Line, duration_min: int, trigger: str
    ) -> None:
        runtime = await self.store.async_load_runtime()
        runtime.setdefault("active", []).append(
            {
                "line_id": line.id,
                "source_id": line.source_id,
                "start": dt_util.utcnow().isoformat(),
                "planned_duration_min": duration_min,
                "trigger": trigger,
            }
        )
        await self.store.async_save_runtime(runtime)

    async def _async_remove_runtime(self, line: Line) -> None:
        runtime = await self.store.async_load_runtime()
        runtime["active"] = [
            r for r in runtime.get("active", []) if r.get("line_id") != line.id
        ]
        await self.store.async_save_runtime(runtime)

    # --- history (FDS §4.6 / §9.4) -------------------------------------------
    async def _async_log(
        self,
        line: Line,
        duration_min: float,
        liters: int | None,
        trigger: str,
        result: str,
        approx: bool = False,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> None:
        # ``start``/``end`` = the run's actual window; default to now for
        # instantaneous skips. A completed/stopped run passes its real start so the
        # logged timestamp matches the scheduled time, not the completion time (CR-0006 B).
        now = dt_util.utcnow()
        history = await self.store.async_load_history()
        entries = history.setdefault("entries", [])
        entries.append(
            {
                "line_id": line.id,
                "source_id": line.source_id,  # source history is the same log, filtered
                "start": (start or now).isoformat(),
                "end": (end or now).isoformat(),
                "duration_min": duration_min,
                "liters": liters,
                "approx": approx,  # cistern measured without settle → estimate (~)
                "trigger": trigger,
                "result": result,
            }
        )
        history["entries"] = self._trim_history(entries)
        await self.store.async_save_history(history)
        await self._async_refresh_consumption_today(history["entries"])  # CR-0002

    async def _async_refresh_consumption_today(
        self, entries: list[dict[str, Any]] | None = None
    ) -> None:
        """Publish each source's ``consumption_today`` from the irrigation history
        (sum of today's logged liters, local time). ``0`` when nothing was drawn
        today — so the sensor reads a value instead of ``unavailable`` (CR-0002).
        Recovered at setup, refreshed after every run-log, reset at midnight."""
        if entries is None:
            history = await self.store.async_load_history()
            entries = history.get("entries", [])
        today = dt_util.now().date()
        totals: dict[str, int] = {sid: 0 for sid in self.config.sources}
        for e in entries:
            sid = e.get("source_id")
            liters = e.get("liters")
            if sid not in totals or liters is None:
                continue
            start = dt_util.parse_datetime(e.get("start") or "")
            if start is not None and dt_util.as_local(start).date() == today:
                totals[sid] += int(liters)
        for sid, total in totals.items():
            self._set_value(sid, "consumption_today", total)

    @callback
    def _async_on_midnight(self, _now: datetime) -> None:
        self.hass.async_create_task(self._async_refresh_consumption_today())
        self.hass.async_create_task(self._async_refresh_restart_baselines())

    def _trim_history(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Drop entries older than the configured retention (settings.history_months)."""
        try:
            months = int(self.config.settings.get("history_months") or HISTORY_DEFAULT_MONTHS)
        except (TypeError, ValueError):
            months = HISTORY_DEFAULT_MONTHS
        if months <= 0:
            return entries
        cutoff = dt_util.utcnow() - timedelta(days=months * 30)
        kept = []
        for e in entries:
            start = dt_util.parse_datetime(e.get("start") or "")
            # keep if undated or newer than the cutoff
            if start is None or start >= cutoff:
                kept.append(e)
        return kept

    # --- ESPHome entity mapping (FDS §9.1: ref = "{box_id}#{local_id}") --------
    def _output_of(self, ref: str | None) -> Output | None:
        if not ref or "#" not in ref:
            return None
        box_id, local = ref.split("#", 1)
        box = self.config.boxes.get(box_id)
        if box is None:
            return None
        return next((o for o in box.outputs if o.id == local), None)

    def _input_of(self, ref: str | None) -> Input | None:
        if not ref or "#" not in ref:
            return None
        box_id, local = ref.split("#", 1)
        box = self.config.boxes.get(box_id)
        if box is None:
            return None
        return next((i for i in box.inputs if i.id == local), None)

    def _box_enabled(self, box_id: str | None) -> bool:
        """A deactivated box is fully out of service (no schedule/run, sensors
        ignored). Missing/unknown box → treat as enabled (forward-compatible)."""
        box = self.config.boxes.get(box_id) if box_id else None
        return box is None or box.enabled

    def _source_boxes(self, source: Source | None) -> set[str]:
        """Box ids a source's hardware (level sensor / meter / pump) sits on."""
        if source is None:
            return set()
        refs = (source.level_input, source.meter_input, source.pump_output)
        return {r.split("#", 1)[0] for r in refs if r and "#" in r}

    def _source_out_of_service(self, source: Source | None) -> bool:
        """A source follows its hardware: out of service as soon as ANY box it
        references (pump/sensor/meter) is deactivated — cistern can't deliver,
        mains loses metering (treated alike, deliberate)."""
        return any(not self._box_enabled(b) for b in self._source_boxes(source))

    def _line_out_of_service(self, line: Line) -> bool:
        """Line can't run: its own box is deactivated, or its source's box is."""
        if not self._box_enabled(line.box_id):
            return True
        source = self.config.sources.get(line.source_id) if line.source_id else None
        return self._source_out_of_service(source)

    def _switch_entity(self, ref: str | None) -> str | None:
        out = self._output_of(ref)
        return out.entity if out else None

    def _switch_unavailable(self, line: Line) -> bool:
        """True only when the line's valve switch is *mapped* but currently
        ``unavailable``/``unknown`` — the per-line safety gate (#9e), separate
        from firmware drift. An unmapped valve (no entity yet) is **not** a safety
        stop (handled elsewhere); only a known-but-unreachable switch blocks."""
        entity = self._switch_entity(line.valve_output)
        if not entity:
            return False
        st = self.hass.states.get(entity)
        return st is not None and st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN)

    def _input_entity(self, ref: str | None) -> str | None:
        inp = self._input_of(ref)
        return inp.entity if inp else None

    def _state_raw(self, entity_id: str | None) -> str | None:
        if not entity_id:
            return None
        st = self.hass.states.get(entity_id)
        if st is None or st.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return None
        return st.state

    def _state_float(self, entity_id: str | None) -> float | None:
        raw = self._state_raw(entity_id)
        if raw is None:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    # --- reads & actuation (FR-L1/L2, FR-R1) ---------------------------------
    def _read_raw(self, source: Source | None) -> float | None:
        """Uncalibrated cistern sensor reading (the raw value the calibration
        table maps to liters, FR-S5a). ``None`` for non-cisterns/no reading."""
        if source is None or source.type != SOURCE_CISTERN:
            return None
        return self._state_float(self._input_entity(source.level_input))

    def _read_level(self, source: Source | None) -> float | None:
        """Current level in liters (cistern: raw→liters; mains: meter)."""
        if source is None:
            return None
        if source.type == SOURCE_CISTERN:
            raw = self._read_raw(source)
            if raw is None:
                return None
            # ≥2 calibration points → piecewise-linear table; else linear shortcut.
            liters = calc.liters_from_table(
                raw, source.calibration_points, source.max_volume_l
            )
            if liters is not None:
                return liters
            return calc.liters_from_pressure(
                raw, source.multiplier, source.offset, source.max_volume_l
            )
        meter = self._state_float(self._input_entity(source.meter_input))
        return None if meter is None else meter * source.pulse_factor

    def _sensor_blocking(self, line: Line) -> bool:
        inp = self._input_of(line.sensor_input)
        if inp is None:
            return False
        # A sensor on a deactivated box is out of service → never blocks.
        box_id = line.sensor_input.split("#", 1)[0] if line.sensor_input else None
        if not self._box_enabled(box_id):
            return False
        raw = self._state_raw(self._input_entity(line.sensor_input))
        if raw is None:
            return False
        if inp.kind == INPUT_RAIN:
            return state.rain_is_blocking(raw)
        return state.soil_is_blocking(raw, inp.threshold_pct)

    def _level_ok(self, line: Line) -> bool:
        source = self.config.sources.get(line.source_id) if line.source_id else None
        if source is None or source.type != SOURCE_CISTERN:
            return True
        return state.level_ok(
            self._read_level(source), source.max_volume_l, source.min_fill_pct
        )

    async def _async_switch(self, line: Line, on: bool) -> None:
        """Switch the line's valve. The source pump follows on-device via the
        ConnectedDevice lambda (FR-E2) — the integration only toggles the valve."""
        entity = self._switch_entity(line.valve_output)
        if not entity:
            _LOGGER.debug("Line %s: no switch entity mapped (%s)", line.id, line.valve_output)
            return
        await self.hass.services.async_call(
            "switch",
            "turn_on" if on else "turn_off",
            {"entity_id": entity},
            blocking=False,
        )

    # --- live values via ESPHome state tracking ------------------------------
    def _tracked_entities(self) -> set[str]:
        ents: set[str] = set()
        for src in self.config.sources.values():
            ref = src.level_input if src.type == SOURCE_CISTERN else src.meter_input
            if (ent := self._input_entity(ref)) is not None:
                ents.add(ent)
        for box in self.config.boxes.values():
            for inp in box.inputs:
                if inp.kind in (INPUT_RAIN, INPUT_SOIL_MOISTURE) and inp.entity:
                    ents.add(inp.entity)
        # Valve switches too — drives the firmware-online flag and the per-line
        # unreachable safety stop (#9d/#9e).
        for line in self.config.lines.values():
            if (ent := self._switch_entity(line.valve_output)) is not None:
                ents.add(ent)
        # Emergency-shutdown counter per box — so an on-device backstop firing is
        # picked up the instant the box pushes it (online case, CR-0011).
        for box in self.config.boxes.values():
            if (emerg := self._box_diag_entities(box)[2]) is not None:
                ents.add(emerg)
        return ents

    def _async_setup_state_tracking(self) -> None:
        entities = self._tracked_entities()
        if entities:
            self._unsub_state = async_track_state_change_event(
                self.hass, list(entities), self._async_on_state_event
            )

    @callback
    def _async_on_state_event(self, event: Event) -> None:
        self._async_refresh_live()
        self._async_guard_unreachable()

    @callback
    def _async_guard_unreachable(self) -> None:
        """Stop any active run whose valve switch went ``unavailable`` (#9e). The
        on-device Emergency Shutdown (FR-E1) stays the hardware safety net; this
        only cleans up HA-side state + logs. Restricted to ``unavailable`` (device
        gone), not ``unknown``, to avoid flapping on transient reconnects."""
        for line_id, task in list(self._run_tasks.items()):
            line = self.config.lines.get(line_id)
            if line is None or task.done():
                continue
            entity = self._switch_entity(line.valve_output)
            if not entity:
                continue
            st = self.hass.states.get(entity)
            if st is not None and st.state == STATE_UNAVAILABLE:
                _LOGGER.warning("Line %s: valve %s unavailable — stopping run", line_id, entity)
                self.hass.async_create_task(self.async_stop_line(line_id, result=RESULT_INTERRUPTED))

    @callback
    def _async_refresh_live(self) -> None:
        """Push current ESPHome readings into the entity value cache (§9.2)."""
        for source in self.config.sources.values():
            if source.type != SOURCE_CISTERN:
                continue
            level = self._read_level(source)
            self._set_value(source.id, "level", level)
            self._set_value(source.id, "level_raw", self._read_raw(source))
            self._set_value(
                source.id,
                "level_pct",
                calc.percent(level, source.max_volume_l) if level is not None else None,
            )
        # Blocking sensors are rain/soil box inputs; publish keyed by their ref.
        for box in self.config.boxes.values():
            for inp in box.inputs:
                ref = f"{box.id}#{inp.id}"
                if inp.kind == INPUT_RAIN:
                    raw = self._state_raw(inp.entity)
                    self._set_value(
                        ref, "state", state.rain_is_blocking(raw) if raw is not None else None
                    )
                elif inp.kind == INPUT_SOIL_MOISTURE:
                    self._set_value(ref, "moisture", self._state_float(inp.entity))
        self._refresh_box_fw_status()  # firmware-drift status per box (#9d)
