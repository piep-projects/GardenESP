/**
 * GardenESP IrrigationController — sidebar panel (FDS §2, §5.1–5.5).
 *
 * A build-free custom (non-iframe) panel: Home Assistant injects `hass`, and we
 * talk to the integration's WebSocket API (custom_components/gardenesp/
 * websocket_api.py). The panel is **Einstellungen only** — monitoring/control
 * lives in the Lovelace card (gardenesp-card.js, FR-D1ff). Views:
 *   - Linien     — line CRUD incl. schedule editor (FR-S1..S4)
 *   - Quellen    — water-source CRUD (FR-S5..S7)
 *   - Boxen      — box CRUD incl. nested outputs/inputs (incl. rain/soil sensor params) + admin YAML view (FR-S11/S12/S8)
 *
 * UI language follows `hass.language` (FR-I1) — the wording lives in the shared
 * JSON catalogs (frontend_i18n/), identifiers stay English.
 * Editing is draft-based: `_draft` is a working copy committed only on Save (FR-S4).
 */

// Domain enumerations: the code keeps only the *keys*, the wording lives in the
// catalogs (i18n-concept §4). Everything here is evaluated at module load, i.e.
// long before `hass` and the catalogs exist — hence keys, never labels.
const SOURCE_TYPES = ["cistern", "mains"];
const sourceTypeLabel = (x) => (SOURCE_TYPES.includes(x) ? t(`enum.source_type.${x}`) : x || "");
const HW_LABEL = { gardencontrol: "GardenControl", esp32_wroom: "ESP32-WROOM" }; // product names — not translated
// rain/soil are configured as box inputs (no separate sensor object).
const SENSOR_INPUT_KINDS = ["rain", "soil_moisture"];
// Firmware-drift status per box (#9) — keys match coordinator drift.fw_status().
// Only the colour class stays in code; the wording is `panel.fw.<status>`.
const FW_STATUS_CLS = {
  current: "ok",
  current_offline: "",
  drift: "warn",
  drift_offline: "warn",
  exported: "",
  drift_export: "warn",
  never: "",
  error: "estop",
};
const FW_ATTENTION = ["drift", "drift_offline", "drift_export"];
const OUTPUT_TYPES = ["valve", "pump", "other"];
const INPUT_KINDS = ["pressure", "soil_moisture", "rain", "pulse_meter", "button"];
const BOX_LABELS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)); // A…Z
// Channel inventory per hw_type (drives the A5 id + the ESPHome pin, FDS §4.1/§5.4):
// GardenControl = 12 valve channels + 2 relay channels; ESP32-WROOM = 8 shared GPIO channels.
const CHANNELS = {
  gardencontrol: { valve: Array.from({ length: 12 }, (_, i) => String(i + 1)), pump: ["R1", "R2"] },
  // generic/custom: channel is just the short A5 number; the real pin is `gpio`.
  generic: { valve: Array.from({ length: 24 }, (_, i) => String(i + 1)), pump: Array.from({ length: 24 }, (_, i) => String(i + 1)) },
};
// GardenControl board terminal labels (display only; pin values unchanged). The
// 4-20 mA inputs are stored *as* their terminal label — the ADS multiplexer behind
// them is crossed on the board (IN1→A1, IN2→A0) and resolved server-side. A0/A1
// remain as legacy keys so a not-yet-migrated config still renders a label.
const GC_PIN_LABEL = {
  IN1: "IN1", IN2: "IN2", A0: "IN1", A1: "IN2",
  GPIO14: "BIN1", GPIO16: "BIN2", GPIO17: "BIN3",
  GPIO32: "ADC1", GPIO33: "ADC2", GPIO34: "ADC3", GPIO35: "ADC4",
};
// ESP32 GPIO pools for generic/custom boxes (free wiring). ADC-capable for analog inputs.
const ESP32_ADC = ["GPIO32", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO39"];
const ESP32_DIGITAL = ["GPIO4", "GPIO5", "GPIO13", "GPIO14", "GPIO16", "GPIO17", "GPIO18", "GPIO19",
  "GPIO21", "GPIO22", "GPIO23", "GPIO25", "GPIO26", "GPIO27", "GPIO32", "GPIO33"];
const ADS_CHANNELS = ["A0", "A1", "A2", "A3"]; // optional external ADS1115
// Input pin inventory per hw_type + kind. GardenControl = fixed; generic = free GPIO (+ADS).
const INPUT_PINS = {
  gardencontrol: {
    pressure: ["IN1", "IN2"], // 2× 4-20 mA (terminal labels; ADS mux resolved server-side)
    soil_moisture: ["GPIO32", "GPIO33", "GPIO34", "GPIO35"], // 4× ADC 0-12 V
    rain: ["GPIO14", "GPIO16", "GPIO17"], // 3 binary inputs (BIN1-3), shared with S0
    pulse_meter: ["GPIO14", "GPIO16", "GPIO17"],
    button: ["GPIO14", "GPIO16", "GPIO17"], // same 3 binary inputs (BIN1-3)
  },
  generic: {
    pressure: [...ESP32_ADC, ...ADS_CHANNELS],
    soil_moisture: ESP32_ADC,
    rain: ESP32_DIGITAL,
    pulse_meter: ESP32_DIGITAL,
    button: ESP32_DIGITAL,
  },
};
// Keys MUST match schedule.py WEEKDAY_KEYS (mo..su) or weekly never fires — this
// is *storage*, never display. The visible names come from Intl (weekdayLabel),
// their order from `hass.locale.first_weekday` (weekdayOrder).
const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const REPEATS = ["daily", "weekly", "monthly"];
const ICON = "mdi:sprout"; // shared with sidebar + card (const.py PANEL_ICON)
// Online help (GitHub Pages). The docs site is the single source of truth — the
// panel only links there (header „? Help" + onboarding) instead of duplicating it.
// The site serves English at the root and German under /de/ (FR-I1 §10), so the
// help links follow the UI language. Anything that is not German gets English:
// the site has no other translation, and English is the base everywhere.
const DOCS_BASE = "https://piep-projects.github.io/GardenESP/";
function docsUrl(path = "") {
  return `${DOCS_BASE}${(_i18n.lang || I18N_BASE_LANG) === "de" ? "de/" : ""}${path}`;
}

const TAB_IDS = ["lines", "controls", "sources", "boxes", "topology", "general"];
// Wiring-lens vocabularies (FR-I1 §4a): the code keeps the keys, the catalogs the
// wording. Silkscreen and pin labels (IN1, COM, V1, GPIO12) are NOT in here — they
// are the physical print on the board and stay verbatim in every language.
const WIRE_ROLES = ["valve", "pump", "other", "sensor"];
const WIRE_CAPS = ["io", "input_only", "strapping", "uart", "forbidden", "power"];

const POLL_MS = 10000;
const APP_NAME = "GardenESP";

// ---------------------------------------------------------------------------
// i18n / l10n (FR-I1, docs/i18n-concept.md §4/§7/§8)
//
// Same mechanism as the dashboard card, same catalogs: three independent axes —
// language from `hass.language`, number/date format from `hass.locale`, units
// from `hass.config.unit_system`. Translations are *data*: one flat JSON catalog
// per language, fetched at runtime. English is the base/fallback.
//
// The panel is the **editing** surface, so it carries one duty the card does not:
// every number it *displays* must stay re-editable. Output goes through fmtNum,
// input through parseNum (both decimal separators) — never parseFloat on a
// user-typed string, that silently turns "1,5" into 1 (i18n-concept §7).
// ---------------------------------------------------------------------------
const I18N_URL = "/gardenesp_i18n"; // static path (const.py I18N_STATIC_URL)
const I18N_BASE_LANG = "en";
// Our own module URL carries `?v=<manifest version>` (the panel is registered
// that way) — reuse it to cache-bust the catalogs in lockstep with the JS.
const VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "0";
  } catch (e) {
    return "0";
  }
})();
// Emergency catalog: if *no* catalog can be fetched (stale deploy, 404, offline)
// the fallback chain would end at the raw key. Scope = the frame the user always
// sees and needs to navigate out of: tab bar, header, the loading/error screen
// and the primary actions. Everything deeper degrades via humanizeKey() below.
const I18N_EMERGENCY = {
  "common.loading": "Loading…",
  "common.error": "Error: {msg}",
  "error.unknown": "Unknown error",
  "error.code": "Error {code}",
  "error.ws_connect": "Cannot connect to Home Assistant",
  "error.ws_auth": "Authentication invalid",
  "error.ws_disconnected": "Connection to Home Assistant lost",
  "panel.tab.lines": "Lines",
  "panel.tab.controls": "Controls",
  "panel.tab.sources": "Water sources",
  "panel.tab.boxes": "Hardware",
  "panel.tab.topology": "Topology",
  "panel.tab.general": "General",
  "panel.head.dashboard": "Dashboard",
  "panel.head.help": "? Help",
  // The section headings belong in here too: humanizeKey() would reduce
  // "panel.lines.title" to its last segment ("Title"), which is readable but says
  // nothing — the one place where the last-resort rule is not good enough.
  "panel.lines.title": "Irrigation lines",
  "panel.controls.title": "Controls",
  "panel.sources.title": "Water sources",
  "panel.general.title": "General",
  "panel.topo.title": "Topology",
  "panel.box.heading": "Controller",
  "panel.action.new": "+ New",
  "panel.action.edit": "Edit",
  "panel.action.save": "Save",
  "panel.action.cancel": "Cancel",
  "panel.action.delete": "Delete",
  "panel.action.close": "Close",
};
const _i18nFetches = new Map(); // lang -> Promise<catalog|null>
let _i18n = { lang: null, cat: {}, base: {}, degraded: false };
// Format/unit state, refreshed from `hass` on every load. Module-level so the
// formatters stay callable from the dozens of render helpers that have no `hass`
// at hand, while still following the two non-language axes.
const _fmt = { locale: I18N_BASE_LANG, us: false, firstWeekday: "language" };

function i18nLang(hass) {
  return String((hass && hass.language) || I18N_BASE_LANG).split("-")[0];
}

function i18nFetch(lang) {
  if (!_i18nFetches.has(lang)) {
    _i18nFetches.set(
      lang,
      fetch(`${I18N_URL}/${lang}.json?v=${encodeURIComponent(VERSION)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return _i18nFetches.get(lang);
}

// Load base (en) *and* the active language, then merge on read. Called from the
// existing async load, so the first render already has its strings.
async function i18nLoad(hass) {
  const lang = i18nLang(hass);
  const units = (hass && hass.config && hass.config.unit_system) || {};
  const locale = (hass && hass.locale) || {};
  _fmt.locale = locale.language || lang;
  _fmt.us = units.volume === "gal" || units.length === "mi";
  _fmt.firstWeekday = locale.first_weekday || "language";
  if (_i18n.lang === lang) return;
  const [base, cat] = await Promise.all([
    i18nFetch(I18N_BASE_LANG),
    lang === I18N_BASE_LANG ? null : i18nFetch(lang),
  ]);
  _i18n = {
    lang,
    base: base || {},
    cat: cat || (lang === I18N_BASE_LANG ? base || {} : {}),
    degraded: !base,
  };
  if (_i18n.degraded) console.warn(`${APP_NAME}: no translation catalog loaded — falling back to built-in English`);
}

// Three-step fallback: active language → en → emergency → humanized key.
// Placeholders are named (`{n}`); values are substituted verbatim, so anything
// user-supplied must be esc()'d by the caller — t() does not escape.
function t(key, vars) {
  const s = _i18n.cat[key] ?? _i18n.base[key] ?? I18N_EMERGENCY[key] ?? humanizeKey(key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
}
// Last resort so a key never reaches the screen as „panel.field.max_volume":
// take its last segment and make it readable („Max volume").
function humanizeKey(key) {
  const last = String(key).split(".").pop().replace(/_/g, " ");
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// Number/date formatting follows `hass.locale` — never a hard-coded "de-DE".
function fmtNum(value, opts) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(_fmt.locale, opts).format(n);
  } catch (e) {
    return String(n);
  }
}
function fmtDateTime(date, opts) {
  try {
    return new Intl.DateTimeFormat(_fmt.locale, opts).format(date);
  } catch (e) {
    return date.toISOString();
  }
}
// Counterpart to fmtNum: read a number the user typed. Accepts both decimal
// separators, because a localised display must stay re-editable (a de user types
// "1,5", an en user "1.5"). Never feed a formatted string back into an input.
function parseNum(text) {
  if (text == null) return NaN;
  const s = String(text).trim().replace(/\s/g, "");
  if (!s) return NaN;
  // "1.234,5" → thousands dot; "1,5" → decimal comma; "1.5" → decimal dot.
  const norm = /,\d{1,3}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  return Number(norm);
}

// Units are their own axis: storage, calibration and every *input* stay metric
// (FR-I1 (e)) — only read-only displays convert. That split is deliberate: a
// calibration table in gallons would silently corrupt the stored litres.
const L_PER_GAL = 3.785411784;
function vol(liters, withUnit = true) {
  const v = Number(liters);
  if (!isFinite(v)) return "—";
  if (_fmt.us)
    return `${fmtNum(v / L_PER_GAL, { maximumFractionDigits: 0 })}${withUnit ? ` ${t("unit.gallons")}` : ""}`;
  return `${fmtNum(Math.round(v), { maximumFractionDigits: 0 })}${withUnit ? ` ${t("unit.liters")}` : ""}`;
}

// --- weekdays ---------------------------------------------------------------
// Names come from Intl (so a new language needs no catalog entry), the week's
// start from `hass.locale.first_weekday`. 2024-01-01 was a Monday — index the
// storage keys off it and format in UTC so no time zone shifts the day.
const WEEKDAY_NAMES = new Map();
function weekdayLabel(w) {
  const i = WEEKDAYS.indexOf(w);
  if (i < 0) return w;
  const ck = `${_fmt.locale}|${w}`;
  if (!WEEKDAY_NAMES.has(ck)) {
    let s;
    try {
      s = new Intl.DateTimeFormat(_fmt.locale, { weekday: "short", timeZone: "UTC" })
        .format(new Date(Date.UTC(2024, 0, 1 + i)));
    } catch (e) {
      s = w;
    }
    WEEKDAY_NAMES.set(ck, s);
  }
  return WEEKDAY_NAMES.get(ck);
}
// Display order, rotated to the locale's first day. "language" (HA's default)
// asks the locale itself; browsers without `weekInfo` fall back to Monday.
function weekdayOrder() {
  const named = WEEKDAYS.indexOf(String(_fmt.firstWeekday).slice(0, 2).toLowerCase());
  let start = named;
  if (start < 0) {
    let firstDay = 1; // ISO Monday
    try {
      const li = new Intl.Locale(_fmt.locale);
      const wi = li.weekInfo || (typeof li.getWeekInfo === "function" ? li.getWeekInfo() : null);
      if (wi && wi.firstDay) firstDay = wi.firstDay;
    } catch (e) { /* no weekInfo → Monday */ }
    start = (firstDay - 1) % 7;
  }
  return WEEKDAYS.slice(start).concat(WEEKDAYS.slice(0, start));
}

class GardenEspPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._data = null;
    this._topology = []; // derived hydraulic strands (Topologie tab, gardenesp/topology)
    this._error = null;
    this._loading = true;
    this._timer = null;
    this._rendered = false;
    this._view = "lines";
    this._editing = null; // {kind} while a form is open
    this._draft = null; // working copy
    this._yaml = null; // {box_id, text} while YAML modal open
    this._wiring = null; // {box_id, data} while Verdrahtung modal open
    this._settingsDraft = null; // working copy of global settings (Allgemein tab)
  }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first) this._load();
  }
  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._renderShell();
    this._timer = setInterval(() => {
      if (!this._editing) this._load(); // don't clobber an open form
    }, POLL_MS);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // --- data ------------------------------------------------------------------
  async _ws(msg) {
    return this._hass.connection.sendMessagePromise(msg);
  }

  async _load() {
    if (!this._hass) return;
    try {
      // Catalogs load alongside the config, so the first render already has its
      // strings — no flash of untranslated content.
      const [data, topo] = await Promise.all([
        this._ws({ type: "gardenesp/config/get" }),
        this._ws({ type: "gardenesp/topology" }),
        i18nLoad(this._hass),
      ]);
      this._data = data;
      this._topology = (topo && topo.strands) || [];
      this._error = null;
    } catch (err) {
      this._error = errText(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _cfg() {
    return (this._data && this._data.config) || {};
  }
  // Live entity-value cache (same `{id}__{key}` keying as the card, FDS §9.2).
  _val(id, key, dflt = null) {
    if (!this._data || !this._data.values) return dflt;
    const v = this._data.values[`${id}__${key}`];
    return v === undefined ? dflt : v;
  }
  // Current state of a resolved ESPHome entity_id straight from HA (no cache).
  _entityState(entityId) {
    if (!entityId || !this._hass || !this._hass.states) return null;
    const st = this._hass.states[entityId];
    if (!st || st.state === "unavailable" || st.state === "unknown") return null;
    return st;
  }

  async _action(msg, label) {
    try {
      await this._ws(msg);
    } catch (err) {
      this._toast(t("panel.toast.action_failed", { action: label, msg: errText(err) }));
    }
    await this._load();
  }

  async _save() {
    try {
      // Box entity_ids are NOT guessed client-side — the server resolves them
      // against the live ESPHome registry on upsert (see coordinator._resolve_box_entities).
      // That match keys on the name, so names must be unique within outputs / inputs.
      if (this._editing.kind === "box") {
        const dup = this._dupName(this._draft.outputs) || this._dupName(this._draft.inputs);
        if (dup) {
          this._toast(t("panel.toast.dup_name", { name: dup }));
          return;
        }
      }
      await this._ws({ type: "gardenesp/upsert", kind: this._wsKind(this._editing.kind), data: this._draft });
      this._editing = null;
      this._draft = null;
      await this._load();
    } catch (err) {
      this._toast(t("panel.toast.save_failed", { msg: errText(err) }));
    }
  }

  // A Steuerung is a kind=switch line → it lives in the "line" WS collection.
  _wsKind(kind) {
    return kind === "control" ? "line" : kind;
  }

  async _delete(kind, id) {
    if (!confirm(t("panel.confirm.delete"))) return;
    await this._action({ type: "gardenesp/delete", kind: this._wsKind(kind), obj_id: id }, t("panel.action.delete"));
    this._editing = null;
    this._draft = null;
    this._render();
  }

  // --- navigation ------------------------------------------------------------
  _go(view) {
    this._view = view;
    this._editing = null;
    this._draft = null;
    // Fresh working copy of global settings when entering the Allgemein tab.
    this._settingsDraft =
      view === "general"
        ? JSON.parse(JSON.stringify(this._cfg().settings || {}))
        : null;
    this._render();
  }
  _edit(kind, obj) {
    this._editing = { kind };
    this._draft = obj ? JSON.parse(JSON.stringify(obj)) : this._blank(kind);
    this._render();
  }
  _blank(kind) {
    if (kind === "line")
      return { name: "", box_id: "", valve_output: "", source_id: "", automatic: true,
        sensor_input: "", sensor_override: false, manual_skip_settle: false,
        manual_default_min: 10, schedule: [] };
    if (kind === "control")  // a Steuerung = a kind=switch line (FR-SW)
      return { kind: "switch", name: "", box_id: "", valve_output: "", automatic: true,
        show_on_dashboard: true, manual_default_min: 10, schedule: [] };
    if (kind === "source")
      return { name: "", type: "cistern", level_input: "", multiplier: 1, offset: 0,
        calibration_points: [], max_volume_l: 0, min_fill_pct: 0, level_deadband_l: 0, pump_output: "",
        tank_settle_min: 0, meter_input: "", pulse_factor: 1 };
    if (kind === "box")
      return { name: "", hw_type: "gardencontrol", label: this._firstFreeBoxLabel(), enabled: true, outputs: [], inputs: [] };
    return {};
  }

  // --- box label / output channel options (FDS §4.1) -------------------------
  _firstFreeBoxLabel() {
    const used = new Set(Object.values(this._cfg().boxes || {}).map((b) => b.label).filter(Boolean));
    return BOX_LABELS.find((l) => !used.has(l)) || "";
  }
  _boxLabelOptions(d) {
    const used = new Set(
      Object.values(this._cfg().boxes || {}).filter((b) => b.id !== d.id).map((b) => b.label).filter(Boolean)
    );
    const opts = [["", t("panel.select.choose")]];
    for (const l of BOX_LABELS) if (!used.has(l) || l === d.label) opts.push([l, l]);
    return opts;
  }
  // Only GardenControl is a fixed profile; every other platform is generic.
  _isGeneric(hwType) {
    return hwType !== "gardencontrol";
  }
  _profile(hwType) {
    return this._isGeneric(hwType) ? "generic" : "gardencontrol";
  }
  _channelPool(hwType, type) {
    // "other" (Steuerung load) shares the relais pool with pumps (R1/R2 on GC).
    const relais = type === "pump" || type === "other";
    return CHANNELS[this._profile(hwType)][relais ? "pump" : "valve"];
  }
  // Generic shares one channel pool across all outputs; GardenControl keeps valve
  // and relais (pump + other) channels apart.
  _samePool(hwType, a, b) {
    if (hwType !== "gardencontrol") return true;
    const relais = (x) => x === "pump" || x === "other";
    return relais(a.type) ? relais(b.type) : a.type === b.type;
  }
  _firstFreeChannel(hwType, type) {
    const pool = this._channelPool(hwType, type);
    const used = new Set(
      (this._draft.outputs || [])
        .filter((x) => this._samePool(hwType, x, { type }))
        .map((x) => String(x.channel))
        .filter(Boolean)
    );
    return pool.find((c) => !used.has(c)) || "";
  }
  _channelOptions(d, o, i) {
    const pool = this._channelPool(d.hw_type, o.type);
    const used = new Set(
      (d.outputs || [])
        .filter((x, j) => j !== i && this._samePool(d.hw_type, x, o))
        .map((x) => String(x.channel))
        .filter(Boolean)
    );
    const gcValve = d.hw_type === "gardencontrol" && o.type !== "pump" && o.type !== "other";
    const opts = [["", t("panel.select.channel")]];
    for (const c of pool) if (!used.has(c) || c === String(o.channel)) opts.push([c, gcValve ? `CH${c}` : c]);
    return opts;
  }

  // --- input pins (Eingänge) — parallel to output channels -------------------
  _inputPinPool(hwType, kind) {
    return (INPUT_PINS[this._profile(hwType)] || INPUT_PINS.gardencontrol)[kind] || [];
  }
  _inputPinLabel(pin, hwType) {
    // GardenControl: board terminal labels (BIN/ADC/IN). Generic: full GPIO id
    // (e.g. "GPIO15") to match the output GPIO dropdown.
    if (hwType === "gardencontrol" && GC_PIN_LABEL[pin]) return GC_PIN_LABEL[pin];
    return String(pin);
  }
  _usedGpios(d, exceptOut, exceptIn) {
    // A physical pin serves at most one device. On generic/WROOM boxes outputs
    // drive a `gpio` and inputs read a `pin` off the *same* GPIO header, so a pin
    // taken by either must drop out of both dropdowns. (GardenControl outputs go
    // through the MCP23017 and carry no `gpio`, so they contribute nothing → its
    // input filtering stays input-only as before.)
    const used = new Set();
    (d.outputs || []).forEach((x, j) => { if (j !== exceptOut && x.gpio) used.add(String(x.gpio)); });
    (d.inputs || []).forEach((x, j) => { if (j !== exceptIn && x.pin) used.add(String(x.pin)); });
    return used;
  }
  _firstFreeInputPin(hwType, kind) {
    const used = this._usedGpios(this._draft, -1, -1);
    return this._inputPinPool(hwType, kind).find((p) => !used.has(p)) || "";
  }
  _inputPinOptions(d, inp, i) {
    const pool = this._inputPinPool(d.hw_type, inp.kind);
    const used = this._usedGpios(d, -1, i);
    const opts = [["", t("panel.select.pin")]];
    for (const p of pool) if (!used.has(p) || p === String(inp.pin)) opts.push([p, this._inputPinLabel(p, d.hw_type)]);
    return opts;
  }
  _normalizeInputPins() {
    const d = this._draft;
    for (const inp of d.inputs || []) {
      const pool = this._inputPinPool(d.hw_type, inp.kind);
      if (!inp.pin || !pool.includes(String(inp.pin))) inp.pin = this._firstFreeInputPin(d.hw_type, inp.kind);
    }
  }

  // --- platforms (built-in GardenControl/WROOM + custom, FDS Allgemein) ------
  _platforms() {
    const custom = (this._cfg().settings && this._cfg().settings.platforms) || [];
    return [
      { id: "gardencontrol", name: "GardenControl", builtin: true },
      { id: "esp32_wroom", name: "ESP32-WROOM", builtin: true },
      ...custom.map((p) => ({ id: p.id, name: p.name || p.id, builtin: false })),
    ];
  }
  _platformName(id) {
    const p = this._platforms().find((x) => x.id === id);
    return p ? p.name : id;
  }

  // --- generic-box output GPIO (free wiring) ---------------------------------
  _outputGpioOptions(d, o, i) {
    const used = this._usedGpios(d, i, -1);
    const opts = [["", t("panel.select.gpio")]];
    for (const g of ESP32_DIGITAL) if (!used.has(g) || g === String(o.gpio)) opts.push([g, g]);
    return opts;
  }

  // --- ConnectedDevice (FR-E2): auto-pump (from line→source) + manual co-switch ----
  _channelLabel(d, o) {
    const ch = o.channel || "";
    if (d.hw_type === "gardencontrol" && o.type === "valve" && ch) return `CH${ch}`;
    return ch || o.name || o.id;
  }
  _autoPumpOutput(d, o) {
    const cfg = this._cfg();
    if (!d.id) return null; // unsaved box
    const ref = `${d.id}#${o.id}`;
    for (const ln of Object.values(cfg.lines || {})) {
      if (ln.valve_output !== ref) continue;
      const src = (cfg.sources || {})[ln.source_id];
      const po = (src && src.pump_output) || "";
      if (!po.includes("#")) continue;
      const [pbox, plocal] = po.split("#");
      if (pbox !== d.id) continue;
      const pump = (d.outputs || []).find((x) => x.id === plocal);
      if (pump) return pump;
    }
    return null;
  }
  // Auto (read-only text, no dropdown; valves only) + manual extra output (channel only).
  _connDevFields(d, o, i) {
    const auto = o.type === "valve" ? this._autoPumpOutput(d, o) : null;
    const autoLabel = auto ? this._channelLabel(d, auto) : "—";
    const others = (d.outputs || []).filter((x, j) => j !== i && x.id);
    const cur = (o.connected || [])[0] || "";
    const opts = `<option value="">${esc(t("panel.select.none"))}</option>` + others
      .map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? "selected" : ""}>${esc(this._channelLabel(d, x))}</option>`)
      .join("");
    return `<input class="ro" disabled value="${esc(autoLabel)}" title="${esc(t("panel.conn.auto_title"))}">
      <select data-conn="${i}" title="${esc(t("panel.conn.manual_title"))}">${opts}</select>`;
  }
  // Polarity: fixed by the platform for GardenControl (read-only), editable for generic.
  _polaritySelect(d, o, i) {
    if (d.hw_type === "gardencontrol")
      return `<input class="ro" disabled value="${esc(t("panel.polarity.active_high"))}" title="${esc(t("panel.polarity.fixed"))}">`;
    return select(`outputs.${i}.relais_off`, o.relais_off || "HIGH",
      [["HIGH", t("panel.polarity.active_low")], ["LOW", t("panel.polarity.active_high")]]);
  }

  // Entity_ids are NOT derived client-side: HA assigns ESPHome entity_ids from
  // the device friendly-name (+ area, frozen at creation), not from our node
  // name. The server resolves the real ids against the entity registry on save
  // and via „Entities abgleichen" (gardenesp/box/sync). Shown in _boxOutRow/_boxInRow.

  // --- rendering -------------------------------------------------------------
  _renderShell() {
    if (this._rendered) return;
    this._rendered = true;
    const style = document.createElement("style");
    style.textContent = CSS;
    const root = document.createElement("div");
    root.className = "wrap";
    root.id = "root";
    this.shadowRoot.append(style, root);
    this._render();
  }

  _render() {
    const root = this.shadowRoot && this.shadowRoot.getElementById("root");
    if (!root) return;
    if (this._loading) return void (root.innerHTML = `<div class="empty">${esc(t("common.loading"))}</div>`);
    // Only take over the whole panel before the first successful load; a later
    // refresh failure (dropped WS on a backgrounded app) keeps the panel usable.
    if (this._error && !this._data)
      return void (root.innerHTML = `<div class="empty err">${esc(t("common.error", { msg: this._error }))}</div>`);

    let body;
    if (this._editing) body = this._form();
    else body = this._listView(this._view);

    root.innerHTML = `${this._nav()}${body}`;
    if (this._yaml) root.insertAdjacentHTML("beforeend", this._yamlModal());
    if (this._wiring) root.insertAdjacentHTML("beforeend", this._wiringModal());
    this._bind();
  }

  _nav() {
    const tabs = TAB_IDS.map(
      (id) => `<button class="tab ${id === this._view ? "on" : ""}" data-tab="${id}">${esc(t(`panel.tab.${id}`))}</button>`
    ).join("");
    return `<div class="head"><h1><ha-icon icon="${ICON}"></ha-icon> ${APP_NAME}</h1>
      <div class="headbtns">
        <button class="btn onbrand" data-act="back" title="${esc(t("panel.head.dashboard_title"))}">${esc(t("panel.head.dashboard"))}</button>
        <a class="btn onbrand" href="${esc(docsUrl())}" target="_blank" rel="noopener" title="${esc(t("panel.head.help_title"))}">${esc(t("panel.head.help"))}</a>
      </div></div>
      <nav class="tabs">${tabs}${this._fwBanner()}</nav>`;
  }

  // Link to a page of the online docs, styled as a button (opens in a new tab).
  _docsBtn(path, label, cls = "ghost") {
    return `<a class="btn ${cls}" href="${esc(docsUrl(path))}" target="_blank" rel="noopener">${esc(label)}</a>`;
  }

  // --- list views (settings) -------------------------------------------------
  _listView(view) {
    const cfg = this._cfg();
    if (view === "lines") return this._linesList(cfg);
    if (view === "controls") return this._controlsList(cfg);
    if (view === "sources") return this._sourcesList(cfg);
    if (view === "boxes") return this._boxesList(cfg);
    if (view === "topology") return this._topologyView();
    if (view === "general") return this._generalView(cfg);
    return "";
  }

  // --- Topologie (read-only Hydraulik-Lens, Roadmap #7) ----------------------
  // Abgeleitete Sicht aus Quellen · Linien · Boxen (Server: gardenesp/topology).
  // Wie das Mockup: ausgerichtete Strecke Box → Quelle → Pumpe → Ventil → Linie
  // (Desktop, CSS-Grid mit Spalten-Spans); auf schmalen Screens vertikal gestapelt.
  _topologyView() {
    const groups = this._topoGroups();
    const intro = `<p class="sub topo-intro">${esc(t("panel.topo.intro"))}</p>`;
    const printBtn = groups.length ? `<button class="btn" data-printtopo>${esc(t("panel.action.print"))}</button>` : "";
    const head = `<div class="listhead"><h2>${esc(t("panel.topo.title"))}</h2>${printBtn}</div>${intro}`;
    if (!groups.length) return `${head}<div class="empty">${esc(t("panel.topo.empty"))}</div>`;
    return head + groups.map((g) => this._topoGroup(g)).join("");
  }

  // Group strands by their (hardware) box → one box node spans its sources.
  // Shared by the tab view and the print window.
  _topoGroups() {
    const order = [], byBox = {};
    for (const st of this._topology || []) {
      const bid = st.source.box_id || "?";
      if (!byBox[bid]) { byBox[bid] = { box_id: bid, label: st.source.box_label, strands: [] }; order.push(bid); }
      byBox[bid].strands.push(st);
    }
    return order.map((bid) => byBox[bid]);
  }

  // One box group → an inline-SVG schematic (echoes the Verdrahtungs-Lens look):
  // text-sized nodes per column Box·Quelle·Pumpe·Ventil·Linie, wired with elbow
  // connectors (fan-out bus where a parent feeds several children).
  _topoGroup(g) {
    const cfg = this._cfg();
    const box = (cfg.boxes || {})[g.box_id];
    const hw = box ? (HW_LABEL[box.hw_type] || box.hw_type) : "";
    return `<div class="topo-group">${this._topoSvg(g, box, hw)}</div>`;
  }

  // Build the strand schematic for one box as a pure string → inline SVG.
  _topoSvg(g, box, hw) {
    const ACC = { box: "#6a4caf", src: "#1976d2", pump: "#d79b00", valve: "#2e7d32", line: "#455a64" };
    const TINT = { "#6a4caf": "#efeaf7", "#1976d2": "#e8f1fb", "#d79b00": "#fbf2dd", "#2e7d32": "#e9f4ea", "#455a64": "#eceff1" };
    const PAD = 9, ROWH = 64, TOP = 28, GAP = 38;

    // --- text widths: measured, not guessed -------------------------------
    // The old fixed px-per-char constants were tuned on German labels; English
    // ones are longer and the node boxes are sized from these numbers, so a
    // guess here shows up as text running out of its own box. Same approach as
    // the wiring lens (+6 % margin for renderers without Roboto, e.g. print).
    const tw = (str, font) => Math.ceil(textWidth(str, font) * 1.06);
    const idW = (id) => (id ? tw(id, TN_FONT.id) + 12 : 0);
    const tagW = (s2) => (s2 ? tw(s2, TN_FONT.tag) + 14 : 0);
    const titleW = (n) =>
      idW(n.id) + (n.id ? 5 : 0) + tw(n.text || "", TN_FONT.title) + (n.tag ? tagW(n.tag) + 6 : 0);
    const nodeW = (n) => {
      let w = titleW(n);
      (n.meta || []).forEach((m) => { w = Math.max(w, tw(m, TN_FONT.meta)); });
      return Math.ceil(w + PAD * 2);
    };
    const nodeH = (n) => 18 + 14 * (n.meta || []).length + 14;

    // --- node descriptors per column ----------------------------------------
    const outNode = (o, acc) => {
      if (!o) return { text: "—", meta: [], muted: true };
      const pin = o.gpio || o.channel || "";   // silkscreen/GPIO label — never translated
      const meta = [];
      if (pin || o.emergency_min)
        meta.push(`${pin}${o.emergency_min ? ` · ⏱ ${fmtNum(o.emergency_min)} ${t("unit.minutes")}` : ""}`);
      return { id: o.short_id || null, idColor: acc, text: o.name || "", meta };
    };
    const srcNode = (s) => {
      const meta = [s.sensor
        ? t("topology.sensor", { name: `${s.sensor.name}${s.sensor.pin ? ` · ${s.sensor.pin}` : ""}` })
        : t("topology.no_sensor")];
      if (s.type === "cistern")
        meta.push(t("topology.capacity", {
          max: s.max_volume_l ? vol(s.max_volume_l) : "?", pct: fmtNum(s.min_fill_pct || 0),
        }));
      return { text: s.name, tag: sourceTypeLabel(s.type), meta };
    };
    const pumpNode = (p) => {
      if (!p) return { text: t("topology.no_pump"), meta: [t("topology.gravity")], muted: true };
      const n = outNode(p, ACC.pump);
      (p.connected || []).forEach((c) => n.meta.push(`↳ ${c.short_id ? c.short_id + " " : ""}${c.name}`));
      return n;
    };
    const lineNode = (ln) => {
      if (!ln || !ln.id) return { text: t("topology.no_line"), meta: [], muted: true };
      const meta = t("topology.automatic", { state: t(ln.automatic ? "common.on" : "common.off") })
        + (ln.sensor_name ? " · " + t("topology.blocked_by", { name: ln.sensor_name }) : "");
      return {
        id: ln.line_id || null, idColor: ACC.line, text: ln.name || "",
        tag: ln.automatic ? null : t("common.tag.auto_off"),
        meta: [meta],
      };
    };
    const boxN = { id: g.label || "?", idColor: ACC.box, text: box ? box.name : g.box_id, meta: hw ? [hw] : [] };

    // --- row assignment: each source spans its valves (≥1); box over all ----
    let row = 0;
    const blocks = g.strands.map((st) => {
      const leaves = (st.valves && st.valves.length ? st.valves : [null]).map((v) => ({
        outN: outNode(v && v.output, ACC.valve), lineN: lineNode(v && v.line),
      }));
      const blk = { st, start: row, span: leaves.length, srcN: srcNode(st.source), pumpN: pumpNode(st.pump), leaves };
      row += blk.span;
      return blk;
    });
    const totalRows = row || 1;

    // --- column widths (text-sized) → x positions ---------------------------
    // Every column must be at least as wide as its own heading: the heading is
    // drawn centred over the column, so a narrow column pushes it out sideways —
    // and the first column has nothing to its left, so it gets clipped by the
    // viewBox. That bites whenever a box node is tiny (a source with no
    // controller renders as "?") and it gets worse with longer translations.
    const headLabel = (col) => t(`topology.col.${col}`).toUpperCase();
    const headW = (col) => {
      const lbl = headLabel(col);
      return tw(lbl, TN_FONT.head) + lbl.length * TN_HEAD_TRACKING + 8;
    };
    let w1 = Math.max(90, headW("source")), w2 = Math.max(90, headW("pump"));
    let w3 = Math.max(90, headW("valve")), w4 = Math.max(90, headW("line"));
    const w0 = Math.max(nodeW(boxN), headW("box"));
    blocks.forEach((b) => {
      w1 = Math.max(w1, nodeW(b.srcN)); w2 = Math.max(w2, nodeW(b.pumpN));
      b.leaves.forEach((l) => { w3 = Math.max(w3, nodeW(l.outN)); w4 = Math.max(w4, nodeW(l.lineN)); });
    });
    const x0 = 2, x1 = x0 + w0 + GAP, x2 = x1 + w1 + GAP, x3 = x2 + w2 + GAP, x4 = x3 + w3 + GAP;
    const W = x4 + w4 + 2, H = TOP + totalRows * ROWH + 8;
    const rowCenter = (r) => TOP + r * ROWH + ROWH / 2;
    const bandCenter = (start, span) => TOP + (start + span / 2) * ROWH;

    // --- draw helpers --------------------------------------------------------
    const drawNode = (x, cy, w, n, acc) => {
      const metas = n.meta || [], h = nodeH(n), y = cy - h / 2, yT = y + 19;
      let s = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="7" fill="${n.muted ? "#f6f6f6" : TINT[acc]}" stroke="${n.muted ? "#c0c0c0" : acc}" stroke-width="1.3"/>`;
      let tx = x + PAD;
      if (n.id) {
        const iw = idW(n.id);
        s += `<rect x="${tx.toFixed(1)}" y="${(yT - 12).toFixed(1)}" width="${iw.toFixed(1)}" height="16" rx="4" fill="${n.idColor || acc}"/>` +
          `<text x="${(tx + iw / 2).toFixed(1)}" y="${yT.toFixed(1)}" class="tn-id" text-anchor="middle">${esc(n.id)}</text>`;
        tx += iw + 5;
      }
      s += `<text x="${tx.toFixed(1)}" y="${yT.toFixed(1)}" class="tn-t${n.muted ? " mut" : ""}">${esc(n.text || "")}</text>`;
      if (n.tag) {
        const tgx = tx + tw(n.text || "", TN_FONT.title) + 6, tgw = tagW(n.tag);
        s += `<rect x="${tgx.toFixed(1)}" y="${(yT - 11).toFixed(1)}" width="${tgw.toFixed(1)}" height="15" rx="4" class="tn-tagbox"/>` +
          `<text x="${(tgx + tgw / 2).toFixed(1)}" y="${(yT - 0.5).toFixed(1)}" class="tn-tag" text-anchor="middle">${esc(n.tag)}</text>`;
      }
      metas.forEach((m, i) => { s += `<text x="${(x + PAD).toFixed(1)}" y="${(yT + 16 + i * 14).toFixed(1)}" class="tn-m">${esc(m)}</text>`; });
      return s;
    };
    // elbow connector: parent (xR,yP) → children at xL, ys[] (fan-out bus)
    const conn = (xR, yP, xL, ys, acc) => {
      const xm = xR + (xL - xR) / 2;
      let s = `<path d="M${xR.toFixed(1)} ${yP.toFixed(1)} H${xm.toFixed(1)}" class="tw" stroke="${acc}"/>`;
      if (ys.length > 1 || Math.abs(ys[0] - yP) > 0.5)
        s += `<path d="M${xm.toFixed(1)} ${Math.min(yP, ...ys).toFixed(1)} V${Math.max(yP, ...ys).toFixed(1)}" class="tw" stroke="${acc}"/>`;
      ys.forEach((y) => {
        s += `<path d="M${xm.toFixed(1)} ${y.toFixed(1)} H${xL.toFixed(1)}" class="tw" stroke="${acc}"/>` +
          `<path d="M${xL.toFixed(1)} ${y.toFixed(1)} l-6 -3.5 v7 z" fill="${acc}"/>`;
      });
      return s;
    };

    // --- assemble ------------------------------------------------------------
    const heads = [["box", x0, w0], ["source", x1, w1], ["pump", x2, w2], ["valve", x3, w3], ["line", x4, w4]];
    let svg = heads.map(([col, x, w]) =>
      `<text x="${(x + w / 2).toFixed(1)}" y="13" class="tn-h" text-anchor="middle">${esc(t(`topology.col.${col}`))}</text>`).join("");

    const boxCY = bandCenter(0, totalRows);
    svg += drawNode(x0, boxCY, w0, boxN, ACC.box);
    svg += conn(x0 + w0, boxCY, x1, blocks.map((b) => bandCenter(b.start, b.span)), ACC.box);

    blocks.forEach((b) => {
      const sy = bandCenter(b.start, b.span);
      svg += drawNode(x1, sy, w1, b.srcN, ACC.src);
      svg += drawNode(x2, sy, w2, b.pumpN, ACC.pump);
      svg += conn(x1 + w1, sy, x2, [sy], ACC.src);
      const leafYs = b.leaves.map((_, i) => rowCenter(b.start + i));
      svg += conn(x2 + w2, sy, x3, leafYs, ACC.pump);
      b.leaves.forEach((l, i) => {
        const ly = rowCenter(b.start + i);
        svg += drawNode(x3, ly, w3, l.outN, ACC.valve);
        svg += drawNode(x4, ly, w4, l.lineN, ACC.line);
        svg += conn(x3 + w3, ly, x4, [ly], ACC.valve);
      });
    });

    return `<svg viewBox="0 0 ${W} ${H}" class="toposvg" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  }

  // Open a standalone print window with every box schematic (analog _printWiring —
  // own window sidesteps shadow-DOM/iframe print quirks).
  _printTopology() {
    const groups = this._topoGroups();
    if (!groups.length) return;
    const win = window.open("", "_blank");
    if (!win) { this._toast(t("panel.toast.popup_blocked")); return; }
    const cfg = this._cfg();
    const body = groups
      .map((g) => {
        const box = (cfg.boxes || {})[g.box_id];
        const cap = `${g.label ? g.label + " · " : ""}${box ? box.name : g.box_id}`;
        return `<h2>${esc(cap)}</h2>${this._topoSvg(g, box, box ? (HW_LABEL[box.hw_type] || box.hw_type) : "")}`;
      })
      .join("");
    win.document.write(`<!doctype html><html><head><title>${esc(t("panel.topo.title"))}</title>
      <style>${this._topoStyle()} body{margin:16px;font-family:sans-serif}h1{font-size:16px}
      h2{font-size:13px;margin:16px 0 4px;color:#444}.toposvg{page-break-inside:avoid}</style></head><body>
      <h1>${esc(APP_NAME)} — ${esc(t("panel.topo.title"))}</h1>
      ${body}
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  }
  // Topology SVG node/connector styling — embedded in the print window (hardcoded
  // colours so it renders without the panel theme vars; mirrors the .toposvg rules).
  _topoStyle() {
    return `.toposvg{display:block;width:100%;height:auto;font-family:Roboto,"Helvetica Neue",Arial,sans-serif}
      .toposvg .tn-h{font-size:10px;font-weight:700;letter-spacing:.5px;fill:#888;text-transform:uppercase}
      .toposvg .tn-id{font-size:10.5px;font-weight:700;fill:#fff}
      .toposvg .tn-t{font-size:13px;font-weight:600;fill:#222}
      .toposvg .tn-t.mut{font-weight:500;fill:#888}
      .toposvg .tn-m{font-size:11px;fill:#666}
      .toposvg .tn-tag{font-size:10px;fill:#555}.toposvg .tn-tagbox{fill:#e0e0e0}
      .toposvg .tw{fill:none;stroke-width:1.4}`;
  }

  _listHeader(title, kind) {
    return `<div class="listhead${title ? "" : " nohead"}">${title ? `<h2>${esc(title)}</h2>` : ""}
      <button class="btn primary" data-add="${kind}">${esc(t("panel.action.new"))}</button></div>`;
  }

  _linesList(cfg) {
    const lines = Object.values(cfg.lines || {}).filter((ln) => ln.kind !== "switch");
    const body = lines.length
      ? lines.map((ln) => {
          const box = (cfg.boxes || {})[ln.box_id];
          const src = (cfg.sources || {})[ln.source_id];
          return `<div class="row"><div class="grow">
            <div class="title"><span class="chip">${esc(this._lineId(cfg, ln))}</span> ${esc(ln.name || ln.id)} ${this._autoChip(ln)}</div>
            <div class="sub">${box ? esc(box.name) : esc(t("panel.list.no_box"))} · ${src ? esc(src.name) : esc(t("panel.list.no_source"))}</div>
            <div class="schedchips">${this._scheduleChips(ln)}</div>
            ${this._stamps(ln)}
            ${this._idLine(ln.id)}</div>
            ${this._autoToggle(ln)}
            <button class="btn" data-editline="${esc(ln.id)}">${esc(t("panel.action.edit"))}</button></div>`;
        }).join("")
      : Object.keys(cfg.boxes || {}).length
        ? `<div class="empty">${esc(t("panel.lines.empty"))}</div>`
        : `<div class="empty">${esc(t("panel.lines.empty_no_box"))} ${this._docsBtn("erste-box/", t("panel.lines.docs_first_steps"))}</div>`;
    return this._listHeader(t("panel.lines.title"), "line") + `<section class="cardbox">${body}</section>`;
  }

  // Steuerungen = kind=switch lines (fountain, camera, …); same store, own tab (FR-SW1).
  _controlsList(cfg) {
    const ctrls = Object.values(cfg.lines || {}).filter((ln) => ln.kind === "switch");
    const body = ctrls.length
      ? ctrls.map((ln) => {
          const box = (cfg.boxes || {})[ln.box_id];
          const out = this._outputName(cfg, ln.box_id, ln.valve_output);
          const dash = ln.show_on_dashboard !== false
            ? `<span class="chip ok">${esc(t("panel.controls.on_dashboard"))}</span>`
            : `<span class="chip">${esc(t("panel.controls.not_on_dashboard"))}</span>`;
          return `<div class="row"><div class="grow">
            <div class="title">${esc(ln.name || ln.id)} ${this._autoChip(ln)} ${dash}</div>
            <div class="sub">${box ? esc(box.name) : esc(t("panel.list.no_box"))} · ${out ? esc(out) : esc(t("panel.controls.no_output"))}</div>
            ${this._controlEntity(ln)}
            <div class="schedchips">${this._scheduleChips(ln)}</div>
            ${this._stamps(ln)}
            ${this._idLine(ln.id)}</div>
            ${this._autoToggle(ln)}
            <button class="btn" data-editcontrol="${esc(ln.id)}">${esc(t("panel.action.edit"))}</button></div>`;
        }).join("")
      : `<div class="empty">${esc(t("panel.controls.empty"))}</div>`;
    return this._listHeader(t("panel.controls.title"), "control") + `<section class="cardbox">${body}</section>`;
  }

  _outputName(cfg, boxId, ref) {
    const b = (cfg.boxes || {})[boxId];
    const o = b && (b.outputs || []).find((x) => `${boxId}#${x.id}` === ref);
    return o ? o.name || o.id : "";
  }
  // Resolved HA entity_id of a Steuerung's switch output (FR-X1) — shown read-only
  // in the Steuerungen overview, like _sourceEntities does for sources.
  _controlEntity(ln) {
    const out = this._outputByRef(ln.valve_output);
    const eid = out && out.entity;
    return `<div class="srcents"><span class="srcent"><span class="cl">${esc(t("panel.controls.output"))}</span> ` +
      `<span class="ent">${eid ? esc(eid) : "—"}</span></span></div>`;
  }

  _sourcesList(cfg) {
    const sources = Object.values(cfg.sources || {});
    const body = sources.length
      ? sources.map((s) => `<div class="row"><div class="grow">
          <div class="title">${esc(s.name || s.id)}<span class="tag muted">${esc(sourceTypeLabel(s.type))}</span>${this._sourceDisabled(s) ? `<span class="chip estop">${esc(t("panel.sources.box_disabled"))}</span>` : ""}${this._rangeChip(s)}</div>
          <div class="sub">${esc(this._sourceSummary(s))}${this._sourceLevel(s)}</div>
          ${this._sourceEntities(s)}
          ${this._stamps(s)}</div>
          <button class="btn" data-editsource="${esc(s.id)}">${esc(t("panel.action.edit"))}</button></div>`).join("")
      : `<div class="empty">${esc(t("panel.sources.empty"))}</div>`;
    return this._listHeader(t("panel.sources.title"), "source") + `<section class="cardbox">${body}</section>`;
  }
  // A source follows its hardware: out of service if any referenced box
  // (Pegel-Sensor / Zähler / Pumpe) is deactivated.
  _sourceDisabled(s) {
    const boxes = this._cfg().boxes || {};
    return [s.level_input, s.meter_input, s.pump_output]
      .filter((r) => r && r.includes("#"))
      .some((r) => { const b = boxes[r.split("#")[0]]; return b && b.enabled === false; });
  }
  // Raw reading outside the calibration table (FR-S5c) — published by the
  // coordinator as `level_range` ("below"/"above"). Outside the table the level
  // freezes on the endpoint, so consumption logs 0 L and the min-fill gate goes
  // blind; both directions are worth a warning.
  _rangeWarn(s) {
    if (s.type !== "cistern" || this._sourceDisabled(s)) return null;
    const side = this._val(s.id, "level_range");
    if (side !== "below" && side !== "above") return null;
    const below = side === "below";
    return {
      side,
      chip: t(below ? "common.calib.chip_below" : "common.calib.chip_above"),
      text: t(below ? "panel.cal.range_below" : "panel.cal.range_above"),
    };
  }
  _rangeChip(s) {
    const w = this._rangeWarn(s);
    return w ? `<span class="chip warn" title="${esc(w.text)}">${esc(w.chip)}</span>` : "";
  }

  // Resolve a "{box_id}#{input_id}" ref to its Input object (for live meter reads).
  _inputByRef(ref) {
    if (!ref || !ref.includes("#")) return null;
    const [boxId, local] = ref.split("#");
    const box = (this._cfg().boxes || {})[boxId];
    return box ? (box.inputs || []).find((i) => i.id === local) || null : null;
  }
  // Left half of the sources sub-line: the configured facts. Cistern → capacity,
  // minimum fill and (if set) the dead band; mains → the pulse factor. Volumes go
  // through vol() so a US install reads gallons; the pulse factor stays metric —
  // it is a stored configuration value, not a reading.
  _sourceSummary(s) {
    if (s.type !== "cistern")
      return t("panel.sources.pulse_factor", { v: fmtNum(s.pulse_factor) });
    const max = s.max_volume_l ? vol(s.max_volume_l) : "?";
    let out = t("panel.sources.summary_cistern", { max, pct: fmtNum(s.min_fill_pct || 0) });
    if (Number(s.level_deadband_l) > 0)
      out += " · " + t("panel.sources.deadband", { v: vol(s.level_deadband_l) });
    return out;
  }
  // Current "Stand" for the sources overview: cistern → liters/Max + %, mains →
  // cumulative meter reading (entity × Faktor). Empty when no live value yet.
  _sourceLevel(s) {
    // Rendered as a grey pill right after „min %" in the sub-line, styled like the
    // live sensor values in the Boxen-Übersicht (.srcval mirrors .devrow .live, #11).
    if (this._sourceDisabled(s)) return `<span class="srcval muted">—</span>`;
    if (s.type === "cistern") {
      const level = this._val(s.id, "level");
      const pct = this._val(s.id, "level_pct");
      if (level == null) return `<span class="srcval muted">—</span>`;
      // Only the fill level (liters); Max/min stehen schon links davor, Prozent nur
      // im Detail. Low-Warnung bleibt (via pct).
      const low = pct != null && s.min_fill_pct && pct < s.min_fill_pct;
      return `<span class="srcval ${low ? "low" : ""}">${esc(vol(level))}${low ? " ⚠" : ""}</span>`;
    }
    const inp = this._inputByRef(s.meter_input);
    const st = inp && this._entityState(inp.entity);
    const liters = st ? parseFloat(st.state) : NaN;
    if (isNaN(liters)) return "";
    return `<span class="srcval">${esc(vol(liters * (s.pulse_factor || 1)))}</span>`;
  }

  _fmtStamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return fmtDateTime(d, { dateStyle: "short", timeStyle: "short" });
  }
  _stamps(o) {
    if (!o.created_at && !o.updated_at) return "";
    return `<div class="boxstamp">${esc(t("panel.stamp.created", { at: this._fmtStamp(o.created_at) }))}` +
      ` · ${esc(t("panel.stamp.updated", { at: this._fmtStamp(o.updated_at) }))}</div>`;
  }
  // Raw storage id — needed for the gardenesp.start_line / stop_line services
  // (own irrigation logic from HA automations, FR-X3b).
  _idLine(id) {
    return `<div class="objid">${esc(t("panel.label.service_id"))} <code>${esc(id)}</code></div>`;
  }
  // Resolved HA entity_ids of a source's referenced box in-/outputs (FR-X1): the
  // level/meter sensor and the pump switch — shown read-only in the Quellen overview.
  _sourceEntities(s) {
    const rows = [];
    const inRef = s.type === "cistern" ? s.level_input : s.meter_input;
    const inp = this._inputByRef(inRef);
    const inLabel = t(s.type === "cistern" ? "panel.sources.level" : "panel.sources.meter");
    if (inRef) rows.push([inLabel, inp && inp.entity]);
    if (s.pump_output) {
      const out = this._outputByRef(s.pump_output);
      rows.push([t("panel.sources.pump"), out && out.entity]);
    }
    if (!rows.length) return "";
    return `<div class="srcents">${rows.map(([k, e]) =>
      `<span class="srcent"><span class="cl">${esc(k)}</span> <span class="ent">${e ? esc(e) : "—"}</span></span>`).join("")}</div>`;
  }
  _outputByRef(ref) {
    if (!ref || !ref.includes("#")) return null;
    const [boxId, local] = ref.split("#");
    const box = (this._cfg().boxes || {})[boxId];
    return box ? (box.outputs || []).find((o) => o.id === local) || null : null;
  }
  // Warn if a planned/manual run duration is not safely below the valve's
  // on-device Emergency Shutdown: the run must finish ≥1 min before the backstop
  // (laufzeit ≤ notabschaltung − 1 min), otherwise every full run trips the
  // safety cutoff and is logged as „Notabschaltung". emerg=0 = backstop off → no
  // check. Shown live in the line/control editor (no save block — just a hint).
  _runtimeWarning(d) {
    const out = this._outputByRef(d.valve_output);
    const emerg = (out && Number(out.emergency_shutdown_min)) || 0;
    if (!emerg) return "";
    const limit = emerg - 1;
    const bad = [];
    const md = Number(d.manual_default_min) || 0;
    if (md > limit) bad.push(t("panel.warn.runtime_manual", { dur: fmtDur(md) }));
    (d.schedule || []).forEach((e) => {
      if (e.enabled === false) return;
      const dm = Number(e.duration_min) || 0;
      if (dm > limit) bad.push(t("panel.warn.runtime_schedule", { time: e.time || "—", dur: fmtDur(dm) }));
    });
    if (!bad.length) return "";
    // The catalog value carries the <b> emphasis, so the result is inserted raw —
    // every interpolated value is esc()'d here instead (t() does not escape).
    return `<div class="formwarn">${t("panel.warn.runtime", {
      valve: esc(out.name || out.id),
      emerg: fmtNum(emerg),
      limit: fmtNum(limit),
      list: esc(bad.join(", ")),
    })}</div>`;
  }
  // Short valve id (A5 = box label + valve channel; FDS §4.1) for a line's
  // valve_output ref — same label the dashboard card shows before the name.
  _valveLabel(cfg, ln) {
    const ref = ln.valve_output || "";
    if (!ref.includes("#")) return "—";
    const [boxId, local] = ref.split("#");
    const box = (cfg.boxes || {})[boxId];
    if (!box) return "—";
    const out = (box.outputs || []).find((o) => o.id === local);
    const letter = box.label || "?";
    return out && out.channel ? `${letter}${out.channel}` : letter;
  }
  // Box-scoped line short id <Box>-L<n> — stable, server-assigned (ln.seq, FDS §3).
  // The box letter prefix disambiguates identical L-numbers across boxes (A-L1 vs B-L1).
  // Steuerungen (kind=switch) carry no L-number → show their output id (A5).
  _lineId(cfg, ln) {
    if (!ln) return "—";
    if (ln.kind === "switch") return this._valveLabel(cfg, ln);
    if (!ln.seq) return "L?";
    const box = (cfg.boxes || {})[ln.box_id];
    const letter = box && box.label ? box.label : "?";
    return `${letter}-L${ln.seq}`;
  }
  // Compact "Automatik" state chip (green on / red off) — like the box Not-Aus chip.
  _autoChip(ln) {
    return ln.automatic
      ? `<span class="chip ok">${esc(t("panel.auto.on"))}</span>`
      : `<span class="chip estop">${esc(t("panel.auto.off"))}</span>`;
  }
  // Interactive on/off switch at the row's right end — toggles `automatic` and
  // persists immediately (no need to open the editor).
  _autoToggle(ln) {
    return `<label class="lineauto ${ln.automatic ? "on" : "off"}" title="${esc(t("panel.auto.toggle_title"))}">
      <input type="checkbox" data-toggleauto="${esc(ln.id)}" ${ln.automatic ? "checked" : ""}>
      <span>${esc(t("panel.label.automatic"))}</span></label>`;
  }
  _toggleLineAuto(id, checked) {
    const ln = (this._cfg().lines || {})[id];
    if (!ln) return;
    this._action({ type: "gardenesp/upsert", kind: "line", data: { ...ln, automatic: checked } }, t("panel.label.automatic"));
  }
  // One small chip per schedule entry, each tagged with a coloured aktiv/inaktiv box.
  _scheduleChips(ln) {
    const entries = ln.schedule || [];
    if (!entries.length) return `<span class="muted">${esc(t("panel.sched.none"))}</span>`;
    return entries.map((e) => {
      const days = e.repeat === "weekly"
        // Display order follows the locale's first weekday; the stored list keeps
        // its canonical mo..su order (schedule.py depends on the keys, not order).
        ? weekdayOrder().filter((w) => (e.weekdays || []).includes(w)).map(weekdayLabel).join(",")
        : e.repeat === "monthly"
          ? `${(e.monthdays || []).map((n) => fmtNum(n)).join(",")}.`
          : t("panel.sched.daily_short");
      const txt = `${days} ${e.time || "—"} · ${fmtNum(e.duration_min || 0)}′`;
      const active = e.enabled !== false;
      const state = `<span class="schedstate ${active ? "on" : "off"}">${esc(t(active ? "panel.sched.active" : "panel.sched.inactive"))}</span>`;
      return `<span class="schedchip">${state} ${esc(txt)}</span>`;
    }).join("");
  }
  _boxesList(cfg) {
    const boxes = Object.values(cfg.boxes || {});
    const admin = this._hass && this._hass.user && this._hass.user.is_admin;
    const body = boxes.length
      ? boxes.map((b) => {
          const valves = (b.outputs || []).filter((o) => o.type === "valve").length;
          const pumps = (b.outputs || []).filter((o) => o.type === "pump").length;
          const outs = (b.outputs || []).map((o) => this._boxOutRow(b, o)).join("");
          const ins = (b.inputs || []).map((inp) => this._boxInRow(b, inp)).join("");
          // Layout per docs/style-guide.md §4: Kopf (Identität + Aktionen) ·
          // Zone „Steuerung" (logisch) · Zone Plattformname (physisches Board).
          return `<div class="boxcard${b.enabled === false ? " off" : ""}">
            <div class="boxhead">
              <div class="title">${esc(t("panel.box.heading"))} ${b.label ? `<span class="chip">${esc(String(b.label).toUpperCase())}</span> ` : ""}${esc(b.name || b.id)}</div>
              <div class="headacts">
                <button class="btn" data-editbox="${esc(b.id)}">${esc(t("panel.action.edit"))}</button>
                ${admin ? `<button class="btn ghost" data-yaml="${esc(b.id)}" title="${esc(t("panel.box.yaml_title"))}">${esc(t("panel.box.yaml_btn"))}</button>` : ""}
              </div>
            </div>
            <div class="zone">
              <div class="zonebody">
                <div class="zonestat">${this._boxEnabledToggle(b)}<span class="muted">${esc(t("panel.box.io_summary", { valves: fmtNum(valves), pumps: fmtNum(pumps), inputs: fmtNum((b.inputs || []).length) }))}</span></div>
                ${this._stamps(b)}
              </div>
            </div>
            <div class="zone">
              <div class="zonelabel"><ha-icon icon="mdi:chip"></ha-icon> ${esc(this._platformName(b.hw_type))}
                <button class="btn ghost wirebtn" data-wiring="${esc(b.id)}" title="${esc(t("panel.box.wiring_title"))}">${esc(t("panel.box.wiring_btn"))}</button></div>
              <div class="zonebody">
                <div class="zonestat">${this._onlineChip(b)}${this._fwChip(b)}</div>
                ${this._boxDeviceMeta(b)}
                ${this._boardFaults(b)}
                ${this._boxDiag(b)}
                ${outs ? `<div class="grouplabel">${esc(t("panel.box.outputs"))}</div>${outs}` : ""}
                ${ins ? `<div class="grouplabel">${esc(t("panel.box.inputs"))}</div>${ins}` : ""}
              </div>
            </div>
          </div>`;
        }).join("")
      : `<div class="empty onboard">
          <p><strong>${esc(t("panel.box.onboard_title", { app: APP_NAME }))}</strong></p>
          <p>${t("panel.box.onboard_text")}</p>
          <p>${this._docsBtn("erste-box/", t("panel.box.onboard_docs"), "primary")}</p>
        </div>`;
    return this._listHeader("", "box") +
      `<section class="cardbox boxlist">${body}</section>`;
  }
  // --- System A status chips (style-guide §3.1) ------------------------------
  // Board reachability — context-dependent severity: Offline is red only when the
  // box should be running (Steuerung in Betrieb), else neutral grey; no device = gelb.
  _onlineChip(b) {
    const online = this._val(b.id, "online");
    if (online === true) return `<span class="chip ok">● ${esc(t("panel.box.online"))}</span>`;
    if (online == null) return `<span class="chip warn" title="${esc(t("panel.box.no_device_title"))}">○ ${esc(t("panel.box.no_device"))}</span>`;
    const cls = b.enabled === false ? "" : "estop";
    return `<span class="chip ${cls}">○ ${esc(t("panel.box.offline"))}</span>`;
  }
  // Board details line: node name · IP · flashed firmware version.
  _boxDeviceMeta(b) {
    const node = this._val(b.id, "node");
    const ip = this._val(b.id, "ip");
    const ver = this._val(b.id, "fw_version");
    const parts = [];
    if (node) parts.push(esc(node));
    if (ip) parts.push(esc(ip));
    if (ver) parts.push("v " + esc(ver));
    return parts.length ? `<div class="zonemeta">${parts.join(" · ")}</div>` : "";
  }
  // GardenControl board self-diagnostics (roadmap #1): the 5 fixed fault sensors
  // (supply 5/12/24 V + 4-20 mA loop CH1/CH2) as flowing text, each followed by a
  // green dot (ok) / red dot (fault) / grey dot (unavailable). Entity_ids come
  // pre-resolved from the coordinator; green/red is decided here from live state.
  _boardFaults(b) {
    if (b.enabled === false) return "";
    const faults = this._val(b.id, "board_faults");
    if (!faults || !faults.length) return "";
    const items = faults.map((f) => {
      const st = this._entityState(f.entity);
      const cls = !st ? "na" : st.state === "on" ? "bad" : "ok";
      const title = t(!st ? "panel.box.fault_unknown" : st.state === "on" ? "panel.box.fault_bad" : "panel.box.fault_ok");
      return `${esc(f.label)} <span class="faultdot ${cls}" title="${esc(title)}"></span>`;
    });
    return `<div class="zonemeta faultrow"><ha-icon class="diagicon" icon="mdi:alert-decagram-outline" title="${esc(t("panel.box.faults_title"))}"></ha-icon>${items.join(" · ")}</div>`;
  }
  // Board diagnostics (FR-S13): WLAN signal + restarts today/yesterday — neutral
  // live info (System B), not an Ampel status. Missing values are simply omitted.
  _wifiIcon(dbm) {
    // RSSI → signal-strength bars (dBm is negative; closer to 0 = stronger).
    const i = dbm >= -55 ? 4 : dbm >= -67 ? 3 : dbm >= -75 ? 2 : dbm >= -85 ? 1 : 0;
    return i === 0 ? "mdi:wifi-strength-outline" : `mdi:wifi-strength-${i}`;
  }
  _boxDiag(b) {
    const sig = this._val(b.id, "wifi_signal");
    const rt = this._val(b.id, "restarts_today");
    const ry = this._val(b.id, "restarts_yesterday");
    const reset = this._val(b.id, "reset_reason");
    const parts = [];
    if (sig != null)
      parts.push(
        `<ha-icon class="diagicon" icon="${this._wifiIcon(sig)}" title="${esc(t("panel.box.wifi_title"))}"></ha-icon>${esc(fmtNum(Math.round(sig)))} dBm`
      );
    if (rt != null || ry != null)
      parts.push(
        `<ha-icon class="diagicon" icon="mdi:restart" title="${esc(t("panel.box.restarts_title"))}"></ha-icon>${esc(t("panel.box.restarts", { today: rt == null ? "–" : fmtNum(rt), yesterday: ry == null ? "–" : fmtNum(ry) }))}`
      );
    // Last reset reason (roadmap #20) — neutral live text; the dashboard card only
    // flags fault causes (brownout/watchdog/panic), here we always show it. The
    // "zuletzt:" label disambiguates it from the per-day restart counts on the same
    // line — it is the cause of the *latest* boot, not a third day bucket.
    if (reset)
      parts.push(
        `<ha-icon class="diagicon" icon="mdi:restart-alert" title="${esc(t("panel.box.reset_title"))}"></ha-icon>${esc(t("panel.box.reset", { reason: reset }))}`
      );
    return parts.length ? `<div class="zonemeta diagrow">${parts.join(" · ")}</div>` : "";
  }
  // Firmware-drift status chip per box (#9) — read from the value cache.
  _fwChip(b) {
    if (b.enabled === false) return "";  // außer Betrieb → Firmware irrelevant, keine Warnung
    const st = this._val(b.id, "fw_status");
    if (!st) return "";
    const known = FW_STATUS_CLS[st] != null;
    return `<span class="chip ${known ? FW_STATUS_CLS[st] : ""}" title="${esc(t("panel.box.fw_title"))}">` +
      `${esc(known ? t(`panel.fw.${st}`) : st)}</span>`;
  }
  // Firmware-drift banner in the tab bar (right of the tabs, centered in the
  // remaining space; ellipsized with the full text on hover). Click → Boxen tab (#9d).
  _fwBanner() {
    const names = Object.values(this._cfg().boxes || {})
      .filter((b) => b.enabled !== false && FW_ATTENTION.includes(this._val(b.id, "fw_status")))
      .map((b) => b.label ? t("common.controller_x", { label: String(b.label).toUpperCase() }) : (b.name || b.id));
    if (!names.length) return "";
    const txt = t("common.banner.flash_pending", { names: names.join(" · ") });
    return `<span class="fwslot"><span class="fwbanner" data-tab="boxes" title="${esc(txt)}">${esc(txt)}</span></span>`;
  }
  // Labeled in-service toggle — state + colour + control in one (System A §3.1):
  // grün „In Betrieb" / grau „Außer Betrieb". Replaces a separate state chip.
  _boxEnabledToggle(b) {
    const on = b.enabled !== false;
    return `<label class="boxswitch ${on ? "on" : "off"}" title="${esc(t("panel.box.toggle_title"))}">
      <input type="checkbox" data-toggleboxen="${esc(b.id)}" ${on ? "checked" : ""}>
      <span>${esc(t(on ? "panel.box.in_service" : "panel.box.out_of_service"))}</span></label>`;
  }
  _toggleBoxEnabled(id, checked) {
    const b = (this._cfg().boxes || {})[id];
    if (!b) return;
    this._action({ type: "gardenesp/upsert", kind: "box", data: { ...b, enabled: checked } }, t("panel.kind.box"));
  }
  _polarityLabel(b, o) {
    if (b.hw_type === "gardencontrol" || o.relais_off === "LOW") return t("panel.polarity.active_high");
    return t("panel.polarity.active_low");
  }
  _drivenList(b, o) {
    const out = [];
    if (o.type === "valve") {
      const pump = this._autoPumpOutput(b, o);
      if (pump) out.push({ label: this._channelLabel(b, pump), name: pump.name || pump.id, kind: t("panel.conn.auto") });
    }
    for (const cid of o.connected || []) {
      const tgt = (b.outputs || []).find((x) => x.id === cid);
      if (tgt) out.push({ label: this._channelLabel(b, tgt), name: tgt.name || tgt.id, kind: t("panel.conn.manual") });
    }
    return out;
  }
  _boxOutRow(b, o) {
    const conn = this._drivenList(b, o)
      .map((d) => `<div class="connrow">↳ <span class="chip">${esc(d.label)}</span> ${esc(d.name)} <span class="muted">(${d.kind})</span></div>`)
      .join("");
    return `<div class="devrow">
      <span class="chip">${esc(this._channelLabel(b, o))}</span>
      <span class="dname">${esc(o.name || o.id)}</span>
      <span class="muted">${esc(OUTPUT_TYPES.includes(o.type) ? t(`panel.output_type.${o.type}`) : o.type)}</span>
      ${this._outState(b, o)}
      <span class="ent">${o.entity ? esc(o.entity) : "—"}</span>
      <span class="muted">${esc(this._polarityLabel(b, o))}</span>
      ${o.emergency_shutdown_min ? `<span class="chip estop" title="${esc(t("panel.box.emergency_title"))}">${esc(t("panel.box.emergency_chip", { min: fmtNum(o.emergency_shutdown_min) }))}</span>` : ""}
    </div>${conn}`;
  }
  _boxInRow(b, inp) {
    let param = "";
    if (inp.kind === "rain") param = t(inp.inverted ? "panel.input.contact_no" : "panel.input.contact_nc");
    else if (inp.kind === "soil_moisture") param = t("panel.input.threshold", { pct: fmtNum(inp.threshold_pct || 0) });
    else if (inp.kind === "button" && inp.inverted) param = t("panel.input.inverted");
    // analog inputs (pressure/soil) may carry an on-device smoothing window (FR-S16)
    if ((inp.kind === "pressure" || inp.kind === "soil_moisture") && Number(inp.smoothing_s) > 0)
      param = (param ? param + " · " : "") + t("panel.input.smoothing", { s: fmtNum(inp.smoothing_s) });
    return `<div class="devrow">
      <span class="chip">${esc(this._inputPinLabel(inp.pin, b.hw_type))}</span>
      <span class="dname">${esc(inp.name || inp.id)}</span>
      <span class="muted">${esc(INPUT_KINDS.includes(inp.kind) ? t(`panel.input_kind.${inp.kind}`) : inp.kind)}</span>
      ${this._inState(b, inp)}
      <span class="ent">${inp.entity ? esc(inp.entity) : "—"}</span>
      ${param ? `<span class="muted">${esc(param)}</span>` : ""}
    </div>`;
  }
  // Live output switch state (on/off) from the resolved ESPHome entity.
  _outState(b, o) {
    if (!b.enabled) return `<span class="live off">${esc(t("panel.box.disabled"))}</span>`;
    const st = this._entityState(o.entity);
    if (!st) return `<span class="live muted">—</span>`;
    const on = st.state === "on";
    return `<span class="live ${on ? "on" : "off"}" title="${esc(t("panel.box.state_title"))}">${on ? "●" : "○"} ${esc(t(on ? "panel.box.on" : "panel.box.off"))}</span>`;
  }
  // Live input value: rain → nass/trocken, sensors → number + unit.
  _inState(b, inp) {
    if (!b.enabled) return `<span class="live muted">${esc(t("panel.box.disabled"))}</span>`;
    const st = this._entityState(inp.entity);
    if (!st) return `<span class="live muted">—</span>`;
    if (inp.kind === "rain") {
      const wet = st.state === "on";
      return `<span class="live ${wet ? "wet" : ""}" title="${esc(t("panel.box.value_title"))}">${esc(t(wet ? "enum.sensor.wet" : "enum.sensor.dry"))}</span>`;
    }
    if (inp.kind === "button") {
      const on = st.state === "on";
      return `<span class="live ${on ? "on" : "off"}" title="${esc(t("panel.box.value_title"))}">${on ? "●" : "○"} ${esc(t(on ? "panel.box.on" : "panel.box.off"))}</span>`;
    }
    const unit = (st.attributes && st.attributes.unit_of_measurement) || "";
    const num = parseFloat(st.state);
    // 4-20 mA pressure sensor drifts by hundredths → 3 decimals; everything else 1.
    const val = isNaN(num)
      ? st.state
      : fmtNum(num, unit === "mA" ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { maximumFractionDigits: 1 });
    return `<span class="live" title="${esc(t("panel.box.value_title"))}">${esc(val)}${unit ? " " + esc(unit) : ""}</span>`;
  }

  _generalView(cfg) {
    const s = this._settingsDraft || cfg.settings || {};
    const months = s.history_months != null ? s.history_months : "";
    const custom = s.platforms || [];
    const boxes = Object.values(cfg.boxes || {});
    const syncButtons = boxes.length
      ? boxes
          .map(
            (b) =>
              `<button class="btn ghost small" data-sync="${esc(b.id)}">⟳ ${esc(t("panel.general.sync_btn", {
                name: `${b.label ? `[${String(b.label).toUpperCase()}] ` : ""}${b.name || b.id}`,
              }))}</button>`,
          )
          .join(" ")
      : `<span class="sub muted">${esc(t("panel.general.no_boxes"))}</span>`;
    const builtin = `
      <div class="row"><div class="grow"><div class="title">GardenControl<span class="tag muted">${esc(t("panel.general.builtin"))}</span></div>
        <div class="sub">${esc(t("panel.general.gc_profile"))}</div></div></div>
      <div class="row"><div class="grow"><div class="title">ESP32-WROOM<span class="tag muted">${esc(t("panel.general.builtin"))}</span></div>
        <div class="sub">${esc(t("panel.general.wroom_profile"))}</div></div></div>`;
    const customRows = custom
      .map((p, i) => `<div class="subrow">
        <input data-platname="${i}" value="${esc(p.name || "")}" placeholder="${esc(t("panel.general.platform_name_ph"))}">
        <span class="sub">${esc(t("panel.general.generic_free_gpio"))}</span>
        <button class="btn danger small" data-delplat="${i}">✕</button></div>`)
      .join("");
    const posSelect = (key, dflt) =>
      `<select data-setting-select="${key}">` +
      ["before", "after"]
        .map((v) => `<option value="${v}" ${(s[key] || dflt) === v ? "selected" : ""}>${esc(t(`panel.general.${v}_lines`))}</option>`)
        .join("") +
      `</select>`;
    return (
      `<div class="listhead"><h2>${esc(t("panel.general.title"))}</h2></div>` +
      `<section class="cardbox">` +
      field(t("panel.general.history_months"), `<input type="number" min="0" data-setting="history_months" value="${esc(months)}">`) +
      `<div class="field"><label>${esc(t("panel.general.disabled_boxes_label"))}</label>
        <div class="sub">${esc(t("panel.general.disabled_boxes_hint"))}</div>
        <label class="chk"><input type="checkbox" data-setting-bool="show_disabled_box_entities" ${s.show_disabled_box_entities ? "checked" : ""}> ${esc(t("panel.general.disabled_boxes_chk"))}</label></div>` +
      `<div class="field"><label>${esc(t("panel.general.order_label"))}</label>
        <div class="sub">${esc(t("panel.general.order_hint"))}</div>
        <div class="subrow"><span class="grow">${esc(t("panel.general.order_sources"))}</span>
          ${posSelect("sources_pos", "before")}</div>
        <div class="subrow"><span class="grow">${esc(t("panel.general.order_sensors"))}</span>
          ${posSelect("sensors_pos", "after")}</div></div>` +
      `<div class="field"><label>${esc(t("panel.general.platforms_label"))}</label>
        <div class="sub">${esc(t("panel.general.platforms_hint"))}</div>
        ${builtin}
        ${customRows}
        <button class="btn ghost small" data-addplat>${esc(t("panel.general.add_platform"))}</button></div>` +
      `<div class="actions"><button class="btn primary" data-savesettings>${esc(t("panel.action.save"))}</button></div>` +
      `</section>` +
      `<section class="cardbox">` +
      `<div class="field"><label>${esc(t("panel.general.sync_label"))}</label>
        <div class="sub">${t("panel.general.sync_hint")}</div>
        <div class="syncbtns" style="display:flex;flex-wrap:wrap;gap:.4em;margin-top:.5em">${syncButtons}</div></div>` +
      `</section>`
    );
  }

  // --- forms -----------------------------------------------------------------
  _form() {
    const kind = this._editing.kind;
    const d = this._draft;
    const isNew = !d.id;
    const kindLabel = t(`panel.kind.${kind}`);
    let fields = "";
    if (kind === "line") fields = this._lineForm(d);
    else if (kind === "control") fields = this._controlForm(d);
    else if (kind === "source") fields = this._sourceForm(d);
    else if (kind === "box") fields = this._boxForm(d);
    return `<section class="cardbox form">
      <div class="listhead"><h2>${esc(isNew
        ? t("panel.form.title_new", { kind: kindLabel })
        : t("panel.form.title_edit", { kind: kindLabel, name: d.name || "" }))}</h2></div>
      ${fields}
      <div class="actions">
        <button class="btn" data-cancel>${esc(t("panel.action.cancel"))}</button>
        ${!isNew ? `<button class="btn danger" data-del="${esc(d.id)}">${esc(t("panel.action.delete"))}</button>` : ""}
        <button class="btn primary" data-savebtn>${esc(t("panel.action.save"))}</button>
      </div></section>`;
  }

  // Box dropdown options "Kürzel · Name" — Kürzel prefixed like the dashboard chip
  // and the other ref selections, so the box is unambiguous (FR-D1/§4.1).
  _boxOptions() {
    return [["", t("panel.select.choose")], ...Object.values(this._cfg().boxes || {})
      .map((b) => [b.id, `${b.label ? b.label + " · " : ""}${b.name}`])];
  }
  _lineForm(d) {
    const cfg = this._cfg();
    // Only offer valves of the line's selected box (pick the box first).
    const valveOpts = this._outputRefs("valve", d.box_id);
    const srcOpts = [["", t("panel.select.no_source")], ...Object.values(cfg.sources || {}).map((s) => [s.id, s.name])];
    const senOpts = [["", t("panel.select.no_sensor")], ...this._sensorInputRefs()];
    return (
      field(t("panel.field.name"), text("name", d.name)) +
      field(t("panel.field.box"), select("box_id", d.box_id, this._boxOptions())) +
      field(t("panel.field.valve_output"), select("valve_output", d.valve_output, [["", t("panel.select.choose")], ...valveOpts])) +
      field(t("panel.field.source"), select("source_id", d.source_id, srcOpts)) +
      field(t("panel.field.automatic"), checkbox("automatic", d.automatic)) +
      field(t("panel.field.sensor"), select("sensor_input", d.sensor_input, senOpts),
        t("panel.field.sensor_hint")) +
      field(t("panel.field.override"), checkbox("sensor_override", d.sensor_override),
        t("panel.field.override_hint")) +
      field(t("panel.field.manual_default"), dur("manual_default_min", d.manual_default_min),
        t("panel.field.manual_default_hint")) +
      field(t("panel.field.skip_settle"), checkbox("manual_skip_settle", d.manual_skip_settle),
        t("panel.field.skip_settle_hint")) +
      this._scheduleEditor(d.schedule || []) +
      `<div data-runtimewarn>${this._runtimeWarning(d)}</div>`
    );
  }

  // Steuerung form (kind=switch): generic on/off output — no source/sensor/consumption.
  _controlForm(d) {
    // A Steuerung drives an "other"/"pump"-type output (relais/GPIO load).
    const outOpts = this._outputRefs(["other", "pump"], d.box_id);
    return (
      field(t("panel.field.name"), text("name", d.name)) +
      field(t("panel.field.box"), select("box_id", d.box_id, this._boxOptions())) +
      field(t("panel.field.output"), select("valve_output", d.valve_output, [["", t("panel.select.choose")], ...outOpts]),
        t("panel.field.output_hint")) +
      field(t("panel.field.automatic"), checkbox("automatic", d.automatic)) +
      field(t("panel.field.show_on_dashboard"), checkbox("show_on_dashboard", d.show_on_dashboard),
        t("panel.field.show_on_dashboard_hint")) +
      field(t("panel.field.manual_default"), dur("manual_default_min", d.manual_default_min),
        t("panel.field.manual_default_hint")) +
      `<div class="sub" style="margin:-4px 0 8px">${t("panel.control.duration_hint")}</div>` +
      this._scheduleEditor(d.schedule || []) +
      `<div data-runtimewarn>${this._runtimeWarning(d)}</div>`
    );
  }

  _scheduleEditor(entries) {
    const rows = entries
      .map((e, i) => {
        let extra = "";
        if (e.repeat === "weekly")
          // Order follows `hass.locale.first_weekday`; the checkbox value stays the
          // canonical storage key (schedule.py WEEKDAY_KEYS).
          extra = `<div class="weekdays">${weekdayOrder().map(
            (w) => `<label class="wd ${(e.weekdays || []).includes(w) ? "on" : ""}">
              <input type="checkbox" data-wd="${i}:${w}" ${(e.weekdays || []).includes(w) ? "checked" : ""}>${esc(weekdayLabel(w))}</label>`
          ).join("")}</div>`;
        else if (e.repeat === "monthly")
          extra = field(t("panel.sched.monthdays"), `<input data-path="schedule.${i}.monthdays" data-type="intlist" value="${esc((e.monthdays || []).join(", "))}" placeholder="1, 15">`);
        return `<div class="schedrow${e.enabled === false ? " disabled" : ""}">
          <div class="schedline">
            <label class="chk schedon" title="${esc(t("panel.sched.entry_title"))}"><input type="checkbox" data-path="schedule.${i}.enabled" data-type="bool" ${e.enabled === false ? "" : "checked"}> ${esc(t("panel.sched.active"))}</label>
            ${select(`schedule.${i}.repeat`, e.repeat, REPEATS.map((r) => [r, t(`panel.repeat.${r}`)]))}
            <input type="time" data-path="schedule.${i}.time" data-type="str" value="${esc(e.time || "")}" title="${esc(t("panel.sched.time_title"))}">
            ${numInline(`schedule.${i}.duration_min`, e.duration_min, t("panel.sched.duration_ph"))}
            <button class="btn danger small" data-delsched="${i}">✕</button>
          </div>${extra}</div>`;
      })
      .join("");
    return `<div class="field"><label>${esc(t("panel.sched.label"))}</label>
      <div class="sub">${esc(t("panel.sched.hint"))}</div>
      <div class="sched">${rows || `<div class="empty">${esc(t("panel.sched.empty"))}</div>`}
      <button class="btn ghost small" data-addsched>${esc(t("panel.sched.add"))}</button></div></div>`;
  }

  _sourceForm(d) {
    const isC = d.type === "cistern";
    // Every editable volume stays **metric** (litres) — the display axis converts,
 // the storage axis must not (i18n-concept §8); the labels say so explicitly.
    let body =
      field(t("panel.field.name"), text("name", d.name)) +
      field(t("panel.field.type"), select("type", d.type, SOURCE_TYPES.map((x) => [x, sourceTypeLabel(x)])));
    if (isC) {
      body +=
        field(t("panel.field.level_input"), select("level_input", d.level_input, [["", t("panel.select.choose")], ...this._inputRefs("pressure")])) +
        this._calEditor(d) +
        field(t("panel.field.max_volume"), num("max_volume_l", d.max_volume_l)) +
        field(t("panel.field.min_fill"), num("min_fill_pct", d.min_fill_pct)) +
        field(t("panel.field.deadband"), num("level_deadband_l", d.level_deadband_l, true),
          t("panel.field.deadband_hint")) +
        field(t("panel.field.pump"), select("pump_output", d.pump_output, [["", t("panel.select.none")], ...this._outputRefs("pump")])) +
        field(t("panel.field.settle"), num("tank_settle_min", d.tank_settle_min)) +
        field(t("panel.field.multiplier"), num("multiplier", d.multiplier, true),
          t("panel.field.multiplier_hint")) +
        field(t("panel.field.offset"), num("offset", d.offset, true));
    } else {
      body +=
        field(t("panel.field.meter_input"), select("meter_input", d.meter_input, [["", t("panel.select.choose")], ...this._inputRefs("pulse_meter")])) +
        field(t("panel.field.pulse_factor"), num("pulse_factor", d.pulse_factor, true));
    }
    return body;
  }

  // Calibration table editor (FR-S5a): rows of raw→liter + live-capture.
  _calEditor(d) {
    const pts = d.calibration_points || [];
    const raw = d.id ? this._val(d.id, "level_raw") : null;
    const rawTxt = raw == null ? "—" : fmtNum(Math.round(raw * 1000) / 1000, { maximumFractionDigits: 3 });
    const rows = pts
      .map((p, i) => `<div class="calrow">
        <input type="number" step="any" data-path="calibration_points.${i}.raw" data-type="float" value="${p.raw == null || p.raw === "" ? "" : esc(p.raw)}" placeholder="${esc(t("panel.cal.raw_ph"))}">
        <span class="calarrow">→</span>
        <input type="number" step="any" data-path="calibration_points.${i}.liters" data-type="float" value="${p.liters == null || p.liters === "" ? "" : esc(p.liters)}" placeholder="${esc(t("panel.cal.liters_ph"))}">
        <button class="btn danger small" data-delcal="${i}">✕</button></div>`)
      .join("");
    const active = pts.filter((p) => p.raw !== "" && p.raw != null && p.liters !== "" && p.liters != null).length >= 2;
    const inp = this._inputByRef(d.level_input);
    const ent = inp && inp.entity ? inp.entity : t("panel.cal.sensor_fallback");
    const warn = this._rangeWarn(d);
    return `<div class="field"><label>${esc(t("panel.cal.label"))}</label>
      ${warn ? `<div class="formwarn">${esc(warn.chip)} — ${esc(warn.text)}</div>` : ""}
      <div class="hint">${t("panel.cal.hint", { entity: esc(ent) })}
        ${t(active ? "panel.cal.table_active" : "panel.cal.table_inactive")}
        ${t("panel.cal.current_raw", { raw: esc(rawTxt) })}</div>
      <div class="calwrap">
        <div class="calcol">
          <div class="caltable">${rows || `<div class="empty">${esc(t("panel.cal.empty"))}</div>`}</div>
          <div class="calbtns"><button class="btn ghost small" data-addcal>${esc(t("panel.cal.add"))}</button>${
            raw != null ? `<button class="btn ghost small" data-capcal>${esc(t("panel.cal.capture", { raw: rawTxt }))}</button>` : ""
          }</div>
        </div>
        ${this._calCurve(d)}
      </div></div>`;
  }

  // Calibration curve — visual feedback for the support-point table right beside
  // it (raw → liters polyline, point markers, dashed live working-point at the
  // current raw reading). Mirrors the former dashboard curve (FR-D3b), but lives
  // where the calibration is actually edited (too technical for the dashboard).
  _calCurve(d) {
    const r2 = (x) => Math.round(Number(x) * 100) / 100;
    const pts = (d.calibration_points || [])
      .map((p) => [Number(p.raw), Number(p.liters)])
      .filter(([r, l]) => Number.isFinite(r) && Number.isFinite(l))
      .sort((a, b) => a[0] - b[0]);
    const raw = d.id ? this._val(d.id, "level_raw") : null;
    const curL = d.id ? this._val(d.id, "level") : null;
    let line = pts;
    let note;
    if (pts.length < 2) {
      const m = Number(d.multiplier), off = Number(d.offset) || 0, max = Number(d.max_volume_l);
      if (!m || !max) return ""; // nothing meaningful to draw
      line = [[(0 - off) / m, 0], [(max - off) / m, max]].sort((a, b) => a[0] - b[0]);
      note = t("panel.cal.note_linear");
    } else {
      note = t("panel.cal.note_table", { n: fmtNum(pts.length) });
    }
    const xs = line.map((p) => p[0]).concat(raw != null ? [Number(raw)] : []);
    const ys = line.map((p) => p[1]).concat(curL != null ? [Number(curL)] : []).concat([Number(d.max_volume_l) || 0]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y1 = Math.max(...ys, 0);
    if (x1 === x0) x1 = x0 + 1;
    if (y1 <= 0) y1 = 1;
    const W = 320, H = 180, pad = 30;
    const sx = (x) => pad + (x - x0) / (x1 - x0) * (W - pad - 10);
    const sy = (y) => H - pad - y / y1 * (H - pad - 12);
    const poly = line.map(([r, l]) => `${sx(r).toFixed(1)},${sy(l).toFixed(1)}`).join(" ");
    const dots = pts.map(([r, l]) => `<circle cx="${sx(r).toFixed(1)}" cy="${sy(l).toFixed(1)}" r="3.2" class="calpt"/>`).join("");
    let marker = "";
    if (raw != null) {
      const rx = sx(Number(raw)).toFixed(1);
      marker = `<line x1="${rx}" y1="8" x2="${rx}" y2="${H - pad}" class="calnow"/>`
        + (curL != null ? `<circle cx="${rx}" cy="${sy(Number(curL)).toFixed(1)}" r="4" class="calnowdot"/>` : "");
    }
    return `<div class="calcurve"><div class="calcap">${esc(t("panel.cal.curve_caption", { note }))}</div>
      <svg viewBox="0 0 ${W} ${H}" class="calsvg" preserveAspectRatio="xMidYMid meet">
        <line x1="${pad}" y1="${H - pad}" x2="${W - 10}" y2="${H - pad}" class="calaxis"/>
        <line x1="${pad}" y1="8" x2="${pad}" y2="${H - pad}" class="calaxis"/>
        <text x="4" y="14" class="callbl">${esc(fmtNum(Math.round(y1)))} ${esc(t("unit.liters"))}</text>
        <text x="4" y="${H - pad}" class="callbl">${esc(fmtNum(0))}</text>
        <text x="${pad}" y="${H - 8}" class="callbl">${esc(fmtNum(r2(x0)))}</text>
        <text x="${W - 10}" y="${H - 8}" class="callbl" text-anchor="end">${esc(t("panel.cal.axis_raw", { v: fmtNum(r2(x1)) }))}</text>
        <polyline points="${poly}" class="calline"/>
        ${dots}${marker}
      </svg></div>`;
  }

  // Refresh live values (without clobbering the open draft), then append a point
  // at the current raw reading — the user fills in the liters.
  async _captureCal() {
    try {
      const data = await this._ws({ type: "gardenesp/config/get" });
      if (data && data.values && this._data) this._data.values = data.values;
    } catch (e) { /* keep the snapshot value on error */ }
    const raw = this._draft.id ? this._val(this._draft.id, "level_raw") : null;
    if (raw == null) return;
    (this._draft.calibration_points = this._draft.calibration_points || []).push({
      raw: Math.round(raw * 1000) / 1000, liters: "", captured_at: new Date().toISOString(),
    });
    this._render();
  }

  _boxForm(d) {
    const generic = this._isGeneric(d.hw_type);
    const outs = (d.outputs || [])
      .map((o, i) => `<div class="subrow">
        ${text(`outputs.${i}.name`, o.name, t("panel.field.name"), "wide")}
        ${select(`outputs.${i}.type`, o.type, OUTPUT_TYPES.map((x) => [x, t(`panel.output_type.${x}`)]))}
        ${select(`outputs.${i}.channel`, o.channel, this._channelOptions(d, o, i))}
        ${generic ? select(`outputs.${i}.gpio`, o.gpio, this._outputGpioOptions(d, o, i)) : ""}
        ${numInline(`outputs.${i}.emergency_shutdown_min`, o.emergency_shutdown_min, t("panel.box.emergency_ph"))}
        ${this._connDevFields(d, o, i)}
        ${this._polaritySelect(d, o, i)}
        <button class="btn danger small" data-delout="${i}">✕</button></div>`)
      .join("");
    const ins = (d.inputs || [])
      .map((inp, i) => {
        // rain/soil inputs double as blocking sensors → extra param; same column for all (FR-UX).
        // Analog inputs (pressure/soil) additionally carry an on-device smoothing window (FR-S16).
        let extra;
        const smooth = (inp.kind === "pressure" || inp.kind === "soil_moisture")
          ? smoothingSelect(`inputs.${i}.smoothing_s`, inp.smoothing_s) : "";
        if (inp.kind === "rain")
          // inverted=false = Öffner/NC (öffnet bei Regen, z. B. RainClik) → keine Pin-Invertierung;
          // inverted=true = Schließer/NO (schließt bei Regen) → Pin invertiert. Entity stets on=nass.
          extra = boolSelect(`inputs.${i}.inverted`, inp.inverted, t("panel.input.contact_no"), t("panel.input.contact_nc_rainclik"));
        else if (inp.kind === "soil_moisture")
          extra = `<span class="inx">${numInline(`inputs.${i}.threshold_pct`, inp.threshold_pct, t("panel.input.threshold_ph"))}${smooth}</span>`;
        else if (inp.kind === "button")
          // generic binary input (FR-S14): polarity only, no block semantics
          extra = boolSelect(`inputs.${i}.inverted`, inp.inverted, t("panel.input.inverted_sel"), t("panel.input.normal_sel"));
        else if (inp.kind === "pressure")
          extra = smooth;
        else
          extra = `<select disabled title="${esc(t("panel.input.no_param"))}"><option>—</option></select>`;
        return `<div class="subrow inrow">
        ${text(`inputs.${i}.name`, inp.name, t("panel.field.name"), "wide")}
        ${select(`inputs.${i}.kind`, inp.kind, INPUT_KINDS.map((x) => [x, t(`panel.input_kind.${x}`)]))}
        ${select(`inputs.${i}.pin`, inp.pin, this._inputPinOptions(d, inp, i))}
        ${extra}
        <button class="btn danger small" data-delin="${i}">✕</button></div>`;
      })
      .join("");
    return (
      field(t("panel.field.name"), text("name", d.name)) +
      field(t("panel.field.platform"), select("hw_type", d.hw_type, this._platforms().map((p) => [p.id, p.name]))) +
      field(t("panel.field.label"), select("label", d.label, this._boxLabelOptions(d))) +
      field(t("panel.field.enabled"), checkbox("enabled", d.enabled !== false)) +
      `<div class="field"><label>${esc(t("panel.field.outputs"))}</label>
        <div class="sub">${esc(t(generic ? "panel.field.outputs_hint_generic" : "panel.field.outputs_hint_gc"))}</div>
        ${outs || `<div class="empty">${esc(t("panel.box.empty_outputs"))}</div>`}
        <button class="btn ghost small" data-addout>${esc(t("panel.box.add_output"))}</button></div>` +
      `<div class="field"><label>${esc(t("panel.field.inputs"))}</label>
        <div class="sub">${esc(t(generic ? "panel.field.inputs_hint_generic" : "panel.field.inputs_hint_gc"))}</div>
        ${ins || `<div class="empty">${esc(t("panel.box.empty_inputs"))}</div>`}
        <button class="btn ghost small" data-addin>${esc(t("panel.box.add_input"))}</button></div>`
    );
  }

  // ref helpers: build "{box_id}#{local_id}" options labelled "Kürzel · Box · Output"
  // (Kürzel = box label first, like the dashboard chip, so the box is unambiguous).
  _boxRefLabel(b, child) {
    const prefix = b.label ? `${b.label} · ${b.name || b.id}` : (b.name || b.id);
    return `${prefix} · ${child}`;
  }
  // ``boxId`` (optional) restricts outputs to a single box — used by the line editor
  // so the valve dropdown only offers valves of the line's selected box.
  _outputRefs(type, boxId) {
    const match = (x) => !type || (Array.isArray(type) ? type.includes(x) : x === type);
    const out = [];
    for (const b of Object.values(this._cfg().boxes || {})) {
      if (boxId && b.id !== boxId) continue;
      for (const o of b.outputs || [])
        if (match(o.type)) out.push([`${b.id}#${o.id}`, this._boxRefLabel(b, o.name || o.id)]);
    }
    return out;
  }
  _inputRefs(kind) {
    const out = [];
    for (const b of Object.values(this._cfg().boxes || {}))
      for (const i of b.inputs || [])
        if (!kind || i.kind === kind) out.push([`${b.id}#${i.id}`, this._boxRefLabel(b, i.name || i.id)]);
    return out;
  }
  // Blocking-sensor options for a line = rain/soil box inputs (no separate sensor object).
  _sensorInputRefs() {
    const out = [];
    for (const b of Object.values(this._cfg().boxes || {}))
      for (const i of b.inputs || [])
        if (SENSOR_INPUT_KINDS.includes(i.kind)) out.push([`${b.id}#${i.id}`, this._boxRefLabel(b, i.name || i.id)]);
    return out;
  }

  // Match this box's outputs/inputs to the real ESPHome entity_ids in HA
  // (server-side registry lookup, FR-S9). Then reload to show the resolved ids.
  async _syncBox(boxId) {
    try {
      const r = await this._ws({ type: "gardenesp/box/sync", box_id: boxId });
      if (!r.total) this._toast(t("panel.toast.sync_none"));
      else if (!r.resolved) this._toast(t("panel.toast.sync_not_found"));
      else this._toast(t("panel.toast.sync_ok", { resolved: fmtNum(r.resolved), total: fmtNum(r.total) }));
    } catch (err) {
      this._toast(t("panel.toast.sync_failed", { msg: errText(err) }));
      return;
    }
    await this._load();
  }

  // --- YAML modal (admin, FR-S8/S9) -----------------------------------------
  async _openYaml(boxId) {
    try {
      const res = await this._ws({ type: "gardenesp/box/yaml", box_id: boxId });
      this._yaml = { box_id: boxId, text: res.yaml, node: res.node_name };
    } catch (err) {
      this._toast(t("panel.toast.yaml_failed", { msg: errText(err) }));
      return;
    }
    this._render();
  }
  _yamlModal() {
    return `<div class="overlay" data-closeyaml>
      <div class="modal" data-stop-prop>
        <div class="modalhead"><h2>${esc(t("panel.yaml.title"))}</h2>
          <button class="btn ghost" data-closeyaml>✕</button></div>
        <pre class="yaml">${esc(this._yaml.text)}</pre>
        <div class="actions">
          <button class="btn" data-copyyaml>${esc(t("panel.action.copy"))}</button>
          <button class="btn primary" data-dlyaml>${esc(t("panel.action.download"))}</button></div>
      </div></div>`;
  }

  // --- Verdrahtung modal (read-only wiring lens, FR-WI1) --------------------
  async _openWiring(boxId) {
    try {
      const data = await this._ws({ type: "gardenesp/wiring", box_id: boxId });
      this._wiring = { box_id: boxId, data };
    } catch (err) {
      this._toast(t("panel.toast.wiring_failed", { msg: errText(err) }));
      return;
    }
    this._render();
  }
  // wiring.py hands out stable tokens instead of German sentences (FR-I1 §4a) —
  // the wording lives in the catalogs under `wiring.note.<token>`.
  _wireNote(token) {
    return token ? t(`wiring.note.${token}`) : "";
  }
  // "‹Kürzel› ‹Name›" for the wiring headings (modal + print window).
  _boxCaption(box) {
    return `${box.label ? String(box.label).toUpperCase() + " " : ""}${box.name || ""}`.trim();
  }
  _wiringModal() {
    const d = this._wiring.data || {};
    const box = d.box || {};
    const title = esc(t("panel.wiring.title", { name: this._boxCaption(box) }));
    const inner = d.supported
      ? this._wireDiagram(d)
      : `<div class="empty">${esc(this._wireNote((d.notes || [])[0]) || t("panel.wiring.none"))}</div>`;
    const notes = d.supported && d.notes
      ? `<ul class="wirenotes">${d.notes.map((n) => `<li>${esc(this._wireNote(n))}</li>`).join("")}</ul>`
      : "";
    return `<div class="overlay" data-closewiring>
      <div class="modal wiremodal" data-stop-prop>
        <div class="modalhead"><h2>🔌 ${title}</h2>
          <button class="btn ghost" data-closewiring>✕</button></div>
        <div class="wirebody">${this._wireDisclaimer()}${inner}${notes}</div>
        <div class="actions">
          ${d.supported ? `<button class="btn primary" data-printwiring>${esc(t("panel.action.print"))}</button>` : ""}
          <button class="btn" data-closewiring>${esc(t("panel.action.close"))}</button></div>
      </div></div>`;
  }
  // Legal/safety disclaimer shown on every wiring diagram (modal + print): the
  // lens is a generated overview aid, not an execution-ready plan.
  _wireDisclaimer() {
    return `<div class="wiredisclaimer">${esc(t("panel.wiring.disclaimer"))}</div>`;
  }
  // Pick the renderer by layout: WROOM = pin-header SVG, GardenControl = screw-
  // terminal board SVG. Both print cleanly (innerHTML copied into _printWiring).
  _wireDiagram(d) {
    return d.layout === "terminals" ? this._wireGcSvg(d) : this._wireSvg(d);
  }
  // GardenControl: faithful schematic of the real board (silkscreen photo), 5:7
  // portrait. Two screw rows on TOP (24 heads, left+right 6-way blocks, I/O +
  // power), one valve screw row on the BOTTOM (V1-V12), "GardenControl" + a Ventile
  // LED strip in the body. Each terminal is drawn as a schematic screw head; assigned
  // screws get a coloured ring + a vertical device label (Ausgang-ID A5 for outputs).
  _wireGcSvg(d) {
    const g = d.grid || { top_upper: [], top_lower: [], bottom: [] };
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
    const W = 700, MX = 20, GAP = 36, COLW = 52;
    const colCX = (i) => MX + i * COLW + (i >= 6 ? GAP : 0) + COLW / 2;
    const yU = 142, yL = 166;                                       // top screw rows
    const bodyTop = yL + 18, BODYH = 120, bodyBot = bodyTop + BODYH;
    const yB = bodyBot + 20;                                        // bottom valve screws
    const topName = 128, botName = yB + 14;                         // card baselines
    const RAIL = "#6d4c41";                                         // shared return/supply rail
    const colOf = (a, c) => c.power || !a ? "" : (a.role === "sensor" ? "#1565c0" : "#2e7d32");
    // `fn` is a token from wiring.py — resolved here so hovering a screw explains
    // what the terminal does in the user's language (the label stays silkscreen).
    const screw = (cx, cy, col, fn) =>
      `<circle cx="${cx}" cy="${cy}" r="6" class="gcscrew"${col ? ` style="stroke:${col};stroke-width:2"` : ""}>` +
      (fn ? `<title>${esc(t(`wiring.fn.${fn}`))}</title>` : "") + `</circle>` +
      `<line x1="${cx - 3}" y1="${cy - 3}" x2="${cx + 3}" y2="${cy + 3}" class="gcslot"/>`;
    // Boxed device label (analogous to the WROOM card) drawn in a rotated frame so it
    // reads vertically off the narrow terminal column; ``px/py`` is the screw-side end.
    // The box is sized from the *measured* text, so the name may run as long as it fits.
    const cardLabel = (a) => (a.short_id ? a.short_id + " " : "") + trunc(a.name, 24);
    const cwCache = new Map();
    const cardW = (a) => {
      if (!cwCache.has(a)) cwCache.set(a, Math.round(textWidth(cardLabel(a), GC_DEV_FONT) * 1.06) + 15);
      return cwCache.get(a);
    };
    const cardTopY = (a) => topName - 3 - cardW(a);   // far (narrow) end of a top card
    const card = (px, py, rot, a) => {
      const cls = a.role === "sensor" ? "in" : "out";
      const label = cardLabel(a), w = cardW(a);
      return `<g transform="rotate(${rot} ${px} ${py})">` +
        `<rect x="${px + 3}" y="${py - 9}" width="${w}" height="17" rx="3" class="gccard ${cls}"/>` +
        `<text x="${px + 9}" y="${py + 3}" class="gcdev ${cls}">${esc(label)}</text></g>`;
    };

    // Geometry depends on the label lengths: reserve head-room for the tallest top card
    // plus the return-bus lanes above it, and push the COM block below the longest valve
    // card. The canvas grows instead of the drawing colliding.
    const tuAll = g.top_upper || [], tlAll = g.top_lower || [], boAll = g.bottom || [];
    const assigned = (row) => row.filter((c) => c && c.label && c.assignment).map((c) => c.assignment);
    const topA = assigned(tuAll).concat(assigned(tlAll)), botA = assigned(boAll);
    const topMax = topA.length ? Math.max(...topA.map(cardW)) : 0;
    const nRet = topA.filter((a) => a.ret).length;
    const busTop = topName - 3 - topMax - 10;        // first return-bus lane, above every card
    const TOP = Math.max(28, 12 - (busTop - 4 * Math.max(0, nRet - 1)));
    const botMax = botA.length ? Math.max(...botA.map(cardW)) : 0;
    const maxTip = botA.length ? botName + botMax + 2 : botName;
    const fanY = maxTip + 10;                        // COM fan runs below every valve card
    const block = { x: W - 210, y: fanY + 14, w: 190, h: 82 };
    const contentBot = botA.length ? block.y + block.h : Math.max(yB + 24, maxTip);
    const H = TOP + contentBot + 26;

    // body — the silkscreen (caption + LED strip) is overlaid *after* the wires, so the
    // COM bus crossing the board passes behind the lettering instead of striking it out.
    let svg = `<rect x="${MX}" y="${bodyTop}" width="${W - 2 * MX}" height="${BODYH}" rx="12" class="chip"/>`;
    const midX = W / 2, midY = bodyTop + BODYH / 2;
    // halo copy under each caption (chip-coloured outline) so a wire passing behind the
    // lettering is interrupted — works in every renderer, unlike CSS ``paint-order``.
    const silkText = (x, y, cls, txt) =>
      `<text x="${x}" y="${y}" class="${cls}" text-anchor="middle" style="stroke:#eceff1;stroke-width:4;fill:none">${txt}</text>` +
      `<text x="${x}" y="${y}" class="${cls}" text-anchor="middle">${txt}</text>`;
    let silk = silkText(midX, midY - 4, "chiplbl", "GardenControl");
    for (let n = 1; n <= 12; n++) {
      const cx = midX - 12 * 9 + (n - 0.5) * 18;
      silk += `<text x="${cx}" y="${midY + 16}" class="gclednum" text-anchor="middle">${n}</text><circle cx="${cx}" cy="${midY + 24}" r="3" class="gcled"/>`;
    }
    // NOT translated: "GardenControl" and "Ventile" are the actual silkscreen print
    // on the board (verified against gardencontrol/gardencontrol bild.jpeg). An
    // English caption here would disagree with the hardware in the user's hand.
    silk += silkText(midX, midY + 40, "gccap", "Ventile");

    const tu = tuAll, tl = tlAll;
    const railPath = (d2, w) => `<path d="${d2}" style="stroke:${RAIL};stroke-width:${w || 1.5};fill:none;stroke-linejoin:round"/>`;

    // Both top screw rows are drawn. An assigned terminal gets a dark **signal** wire up to
    // its boxed label PLUS a brown **supply/return** lead from the card to the paired pad
    // (4-20 mA IN→VCC, relay coil R→COM, ADC→GND). Active rail pads get the rail colour.
    let retK = 0;
    const drawTop = (c, i, row) => {
      if (!c || !c.label) return;
      const cx = colCX(i), a = c.assignment, cy = row === "U" ? yU : yL;
      const railOn = c.rail && c.active;
      svg += screw(cx, cy, railOn ? RAIL : colOf(a, c), c.fn);
      svg += `<text x="${cx}" y="${cy + 14}" class="gctlbl${a || railOn ? " on" : ""}"${railOn ? ` style="fill:${RAIL}"` : ""} text-anchor="middle">${esc(c.label)}</text>`;
      if (!a) return;
      const px = cx + (row === "U" ? -13 : 13);
      svg += `<line x1="${cx}" y1="${cy - 6}" x2="${px}" y2="${topName}" class="gcwire"/>` + card(px, topName, -90, a);
      if (a.ret) {  // supply/return lead from the card to the paired pad carrying that label
        const cands = [];
        tu.forEach((cc, idx) => { if (cc && cc.label === a.ret) cands.push({ x: colCX(idx), y: yU, idx, row: "U" }); });
        tl.forEach((cc, idx) => { if (cc && cc.label === a.ret) cands.push({ x: colCX(idx), y: yL, idx, row: "L" }); });
        if (cands.length) {
          // The silkscreen prints VCC three times (2× IN supply, 1× BIN supply) and COM
          // four times, so column proximity alone is ambiguous. Rank: same row first, then
          // nearest column, then the pad to the right — IN1/IN2 each pair with the VCC
          // screw directly right of them, R1/R2 fall back to the COM block on their left.
          const rank = (p) => [p.row === row ? 0 : 1, Math.abs(p.idx - i), p.idx < i ? 1 : 0];
          const pad = cands.sort((p, q) => {
            const A = rank(p), B = rank(q);
            return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
          })[0];
          // Leave the card at its far (narrow) end, run over all cards on its own bus lane,
          // then drop onto the pad — never back down through the card body. A lower-row pad
          // is approached from the side so the drop misses the upper screw + its label.
          const by = busTop - 4 * retK++;
          let path = `M${px},${cardTopY(a) - 2} V${by} `;
          if (pad.row === "U") path += `H${pad.x} V${pad.y - 6}`;
          else {
            const lane = pad.x + 22 <= W - MX ? pad.x + 22 : pad.x - 26;
            path += `H${lane} V${pad.y} H${pad.x}`;
          }
          svg += railPath(path, 1.6);
        }
      }
    };
    tu.forEach((c, i) => drawTop(c, i, "U"));
    tl.forEach((c, i) => drawTop(c, i, "L"));

    // Bottom valve row: a dark signal wire to each card; the **COM return leaves the card**
    // (not the screw) into a COM distribution block bottom-right, then one diagonal line from
    // the block to a COM pad. Only assigned valves join the block.
    const vlist = [];
    boAll.forEach((c, i) => {
      if (!c || !c.label) return;
      const cx = colCX(i), a = c.assignment;
      svg += screw(cx, yB, colOf(a, c), c.fn);
      svg += `<text x="${cx}" y="${yB - 10}" class="gctlbl${a ? " on" : ""}" text-anchor="middle">${esc(c.label)}</text>`;
      if (!a) return;
      const cw = cardW(a);                              // card length (hangs down from botName)
      svg += `<line x1="${cx}" y1="${yB + 6}" x2="${cx}" y2="${botName}" class="gcwire"/>` + card(cx, botName, 90, a);
      vlist.push({ cx, tipY: botName + cw + 2 });        // COM lead starts at the card's far tip
    });
    if (vlist.length) {
      svg += `<rect x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" rx="6" style="fill:#efebe9;stroke:${RAIL};stroke-width:1.6"/>`;
      svg += `<text x="${block.x + block.w / 2}" y="${block.y + 20}" style="fill:${RAIL};font-weight:700;font-size:11px" text-anchor="middle">${esc(t("wiring.gc.com_block"))}</text>`;
      svg += `<text x="${block.x + block.w / 2}" y="${block.y + 36}" style="fill:${RAIL};font-size:9px" text-anchor="middle">${esc(t("wiring.gc.com_block_sub"))}</text>`;
      // Valves standing over the block drop straight onto its top edge; the rest fan in
      // from the left — each first dropping below the longest card, so no lead crosses a
      // neighbouring device box on its way.
      const fan = vlist.filter((v) => v.cx <= block.x + 8);
      vlist.forEach((v) => {
        if (v.cx > block.x + 8) { svg += railPath(`M${v.cx},${v.tipY} V${block.y}`); return; }
        const k = fan.indexOf(v);
        const ty = block.y + 14 + ((k + 1) * (block.h - 20)) / (fan.length + 1);
        const mx = (v.cx + block.x) / 2;
        svg += railPath(`M${v.cx},${v.tipY} V${fanY} C${mx},${fanY} ${mx},${ty} ${block.x},${ty}`);
      });
      // COM bus block → a COM pad, routed up the free corridor between the two 6-way
      // terminal blocks (never across a device box) and landing on the pad from the side.
      const corridor = colCX(5) + COLW / 2 + GAP / 2;
      const comIdx = [4, 5, 6, 7].filter((i) => tu[i] && tu[i].label === "COM")
        .sort((p, q) => Math.abs(colCX(p) - corridor) - Math.abs(colCX(q) - corridor))[0];
      if (comIdx != null) {
        const sx = colCX(comIdx), side = sx > corridor ? -7 : 7;
        svg += railPath(`M${block.x},${block.y + block.h / 2} H${corridor} V${yU} H${sx + side}`, 2.4);
        svg += `<text x="${corridor + 6}" y="${topName}" style="fill:${RAIL};font-weight:700;font-size:11px">→ COM</text>`;
      }
    }
    svg += silk;   // board lettering on top of the COM bus crossing the body

    // legend
    const gleg = [["#2e7d32", t("wiring.legend.output")], ["#1565c0", t("wiring.legend.input")],
      ["#37474f", t("wiring.legend.signal")], [RAIL, t("wiring.legend.supply")]];
    let gx = MX; const gy = H - 12;
    const glegend = gleg.map(([c, lbl]) => { const s = `<rect x="${gx}" y="${gy - 9}" width="11" height="11" fill="${c}"/><text x="${gx + 16}" y="${gy}" class="legtxt">${esc(lbl)}</text>`; gx += 30 + lbl.length * 6.4; return s; }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="wiresvg" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,${TOP})">${svg}</g>${glegend}</svg>`;
  }
  // Build the board schematic: faithful 38-pin chip (USB down, pins 1↓→19↑ per
  // side, cap-coloured) with assigned valves/sensors as cards wired to their GPIO
  // pad + the nearest GND. Pure string → inline SVG (prints cleanly via _printWiring).
  _wireSvg(d) {
    const ROW = 24, CHIPX = 300, CHIPW = 140, TOP = 24;
    const CHIPR = CHIPX + CHIPW, H = TOP + 19 * ROW;
    const W = 820, CARDR = 600, CARDL = 8, CARDW = 200;
    const COL = { io: "#2e7d32", input_only: "#1565c0", strapping: "#ef6c00", uart: "#bf360c", forbidden: "#9e9e9e", power: "#546e7a" };
    const pinY = (p) => TOP + (19 - p) * ROW + ROW / 2;
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
    const pins = d.pins || [];

    // chip body + USB
    let svg = `<rect x="${CHIPX}" y="${TOP}" width="${CHIPW}" height="${19 * ROW}" rx="10" class="chip"/>`;
    svg += `<rect x="${CHIPX + CHIPW / 2 - 26}" y="${H}" width="52" height="22" rx="3" class="usb"/>`;
    svg += `<text x="${CHIPX + CHIPW / 2}" y="${H + 15}" class="usblbl" text-anchor="middle">USB</text>`;
    svg += `<text x="${CHIPX + CHIPW / 2}" y="${TOP - 8}" class="chiplbl" text-anchor="middle">ESP32-WROOM</text>`;

    // pin rows: marker + number + name, both sides
    pins.forEach((p) => {
      const y = pinY(p.pin), col = COL[p.cap] || "#999";
      const onRight = p.side === "right";
      const mx = onRight ? CHIPR : CHIPX - 6;
      svg += `<rect x="${mx}" y="${y - 7}" width="6" height="14" fill="${col}"/>`;
      const tx = onRight ? CHIPR + 12 : CHIPX - 12;
      const anchor = onRight ? "start" : "end";
      const cls = "pinlbl" + (p.assignment ? " on" : "") + (p.cap === "forbidden" ? " bad" : "");
      // Number sits next to the chip on both sides → mirror the order on the left
      // (text-anchor end): "GPIO36 · 17" right-aligned vs. right side "17 · GPIO36".
      const lbl = onRight ? p.pin + " · " + p.label : p.label + " · " + p.pin;
      svg += `<text x="${tx}" y="${y + 4}" class="${cls}" text-anchor="${anchor}" fill="${col}">${esc(lbl)}</text>`;
    });

    // GND pads (emphasise) + remember per-side nearest GND for the device taps
    const gndR = (d.gnd_pins || []).filter((g) => g.side === "right").map((g) => g.pin);
    const gndL = (d.gnd_pins || []).filter((g) => g.side === "left").map((g) => g.pin);

    // device cards on their pin's own side, aligned to the pin row, wired to GPIO + GND
    const padOf = (gpio) => pins.find((p) => p.gpio === gpio);
    (d.devices || []).forEach((dev) => {
      const pad = padOf(dev.gpio);
      if (!pad) return; // unresolved / no GPIO → not drawn
      const y = pinY(pad.pin), onRight = pad.side === "right";
      const cx = onRight ? CARDR : CARDL;
      const cardEdge = onRight ? cx : cx + CARDW;
      // GPIO signal line card → outer edge of the pin label (NOT through to the
      // chip pad — that struck the "<pin> · GPIOxx" text out and was hard to read).
      const labelW = 12 + (pad.pin + " · " + (pad.label || "")).length * 6; // 11px label + the 12px text offset
      const tap = onRight ? CHIPR + labelW + 4 : CHIPX - labelW - 4;
      svg += `<line x1="${tap}" y1="${y}" x2="${cardEdge}" y2="${y}" class="wire"/>`;
      // GND line card→nearest same-side GND pad
      const gnd = (onRight ? gndR : gndL).sort((a, b) => Math.abs(a - pad.pin) - Math.abs(b - pad.pin))[0];
      if (gnd != null) svg += `<line x1="${cardEdge}" y1="${y + 6}" x2="${onRight ? CHIPR : CHIPX}" y2="${pinY(gnd)}" class="gndwire"/>`;
      // card
      const role = WIRE_ROLES.includes(dev.role) ? t(`wiring.role.${dev.role}`) : dev.role;
      const idTag = dev.short_id ? `<tspan class="cardid">${esc(dev.short_id)}</tspan> ` : "";
      svg += `<g class="card"><rect x="${cx}" y="${y - 11}" width="${CARDW}" height="22" rx="4"/>` +
        `<text x="${cx + 8}" y="${y + 4}" class="cardlbl">${idTag}${esc(trunc(dev.name, 22))} <tspan class="cardrole">(${esc(role)})</tspan></text></g>`;
    });

    // legend
    const leg = WIRE_CAPS.map((c) => [c, t(`wiring.cap.${c}`)]);
    let lx = 8; const ly = H + 44;
    let legend = leg.map(([c, lbl]) => { const s = `<rect x="${lx}" y="${ly - 9}" width="11" height="11" fill="${COL[c]}"/><text x="${lx + 16}" y="${ly}" class="legtxt">${esc(lbl)}</text>`; lx += 30 + lbl.length * 6.4; return s; }).join("");

    return `<svg viewBox="0 0 ${W} ${ly + 10}" class="wiresvg" xmlns="http://www.w3.org/2000/svg">${svg}${legend}</svg>`;
  }
  _printWiring() {
    if (!this._wiring || !this._wiring.data || !this._wiring.data.supported) return;
    const d = this._wiring.data, box = d.box || {};
    const win = window.open("", "_blank");
    if (!win) { this._toast(t("panel.toast.popup_blocked")); return; }
    win.document.write(`<!doctype html><html><head><title>${esc(t("panel.wiring.title", { name: box.name || "" }))}</title>
      <style>${this._wireStyle()} body{margin:16px;font-family:sans-serif}h1{font-size:16px}
      ul{font-size:12px;color:#444}
      .wiredisclaimer{margin:0 0 12px;padding:8px 10px;border:1px solid #e0a800;
        background:#fff8e1;color:#7a5c00;font-size:12px;border-radius:4px}</style></head><body>
      <h1>🔌 ${esc(t("panel.wiring.title", { name: this._boxCaption(box) }))}</h1>
      ${this._wireDisclaimer()}
      ${this._wireDiagram(d)}
      <ul>${(d.notes || []).map((n) => `<li>${esc(this._wireNote(n))}</li>`).join("")}</ul>
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  }
  // Shared SVG styling — embedded in both the modal (shadow) and the print window.
  _wireStyle() {
    return `.wiresvg{width:100%;height:auto;background:#fff}
      .chip{fill:#eceff1;stroke:#90a4ae;stroke-width:1.5}
      .usb{fill:#b0bec5;stroke:#78909c}.usblbl{font-size:10px;fill:#37474f}
      .chiplbl{font-size:12px;fill:#37474f;font-weight:600}
      .pinlbl{font-size:11px}.pinlbl.on{font-weight:700}.pinlbl.bad{text-decoration:line-through;opacity:.7}
      .wire{stroke:#37474f;stroke-width:1.6}
      .gndwire{stroke:#90a4ae;stroke-width:1;stroke-dasharray:3 2}
      .card rect{fill:#fff;stroke:#455a64;stroke-width:1.2}
      .cardlbl{font-size:11px;fill:#263238}.cardrole{fill:#78909c}.cardid{font-weight:700;fill:#37474f}
      .legtxt{font-size:10px;fill:#455a64}
      .gccap{font-size:11px;fill:#607d8b;font-weight:600}
      .gcscrew{fill:#e8eaed;stroke:#9aa0a6;stroke-width:1.2}.gcslot{stroke:#9aa0a6;stroke-width:1}
      .gctlbl{font-size:9px;fill:#546e7a}.gctlbl.on{font-weight:700;fill:#263238}
      .gclednum{font-size:9px;fill:#90a4ae}.gcled{fill:#cfd8dc}
      .termfree{font-size:9px;fill:#b0bec5}
      .gcwire{stroke:#90a4ae;stroke-width:1.2}
      .gccard{fill:#fff;stroke-width:1.2}.gccard.out{stroke:#2e7d32}.gccard.in{stroke:#1565c0}
      .gcdev{font-size:11px;font-weight:600;font-family:Roboto,"Helvetica Neue",Arial,sans-serif}
      .gcdev.out{fill:#2e7d32}.gcdev.in{fill:#1565c0}`;
  }

  // --- event binding ---------------------------------------------------------
  _bind() {
    const root = this.shadowRoot.getElementById("root");
    const q = (s) => root.querySelectorAll(s);
    const on = (s, ev, fn) => q(s).forEach((el) => (el[ev] = fn));

    const back = root.querySelector('[data-act="back"]');
    // Return to the dashboard the card recorded on its way here (sessionStorage:return,
    // set on an explicit card→settings click — most precise); else the last view the
    // card was shown on (localStorage:dashboard — covers opening Einstellungen straight
    // from the sidebar, where no return path was set); else the default dashboard "/".
    // history.back() is not reliable (the panel can be opened from the sidebar too).
    if (back)
      back.onclick = () => {
        let ret = null;
        try { ret = sessionStorage.getItem("gardenesp:return") || localStorage.getItem("gardenesp:dashboard"); } catch (e) { /* private mode */ }
        location.href = ret || "/";
      };
    on("[data-tab]", "onclick", (e) => this._go(e.currentTarget.dataset.tab));

    // list → edit/add
    on("[data-add]", "onclick", (e) => this._edit(e.currentTarget.dataset.add, null));
    on("[data-toggleauto]", "onchange", (e) => this._toggleLineAuto(e.currentTarget.dataset.toggleauto, e.currentTarget.checked));
    on("[data-toggleboxen]", "onchange", (e) => this._toggleBoxEnabled(e.currentTarget.dataset.toggleboxen, e.currentTarget.checked));
    on("[data-editline]", "onclick", (e) => this._edit("line", this._cfg().lines[e.currentTarget.dataset.editline]));
    on("[data-editcontrol]", "onclick", (e) => this._edit("control", this._cfg().lines[e.currentTarget.dataset.editcontrol]));
    on("[data-editsource]", "onclick", (e) => this._edit("source", this._cfg().sources[e.currentTarget.dataset.editsource]));
    on("[data-editbox]", "onclick", (e) => this._edit("box", this._cfg().boxes[e.currentTarget.dataset.editbox]));
    on("[data-yaml]", "onclick", (e) => this._openYaml(e.currentTarget.dataset.yaml));
    on("[data-wiring]", "onclick", (e) => this._openWiring(e.currentTarget.dataset.wiring));
    on("[data-sync]", "onclick", (e) => this._syncBox(e.currentTarget.dataset.sync));

    // form: field binding (draft-based)
    on("[data-path]", "oninput", (e) => this._onField(e));
    on("[data-path]", "onchange", (e) => this._onField(e, true));
    on("[data-wd]", "onchange", (e) => this._onWeekday(e));

    // form actions
    on("[data-cancel]", "onclick", () => { this._editing = null; this._draft = null; this._render(); });
    on("[data-savebtn]", "onclick", () => this._save());
    on("[data-del]", "onclick", (e) => this._delete(this._editing.kind, e.currentTarget.dataset.del));

    // nested row add/remove
    on("[data-addout]", "onclick", () => this._addRow("outputs", { id: this._localId("o", this._draft.outputs), type: "valve", name: "", channel: this._firstFreeChannel(this._draft.hw_type, "valve"), gpio: "", connected: [], entity: "", emergency_shutdown_min: 0, relais_off: "HIGH" }));
    on("[data-conn]", "onchange", (e) => {
      const el = e.currentTarget;
      this._draft.outputs[+el.dataset.conn].connected = el.value ? [el.value] : [];
    });
    on("[data-addin]", "onclick", () => this._addRow("inputs", { id: this._localId("i", this._draft.inputs), kind: "pressure", name: "", pin: this._firstFreeInputPin(this._draft.hw_type, "pressure"), inverted: false, threshold_pct: 40, smoothing_s: 0, entity: "", calibration: {} }));
    on("[data-delout]", "onclick", (e) => this._delRow("outputs", +e.currentTarget.dataset.delout));
    on("[data-delin]", "onclick", (e) => this._delRow("inputs", +e.currentTarget.dataset.delin));
    on("[data-addsched]", "onclick", () => this._addRow("schedule", { repeat: "daily", time: "06:00", duration_min: 10, weekdays: [], monthdays: [], enabled: true }));
    on("[data-delsched]", "onclick", (e) => this._delRow("schedule", +e.currentTarget.dataset.delsched));
    on("[data-addcal]", "onclick", () => this._addRow("calibration_points", { raw: "", liters: "", captured_at: new Date().toISOString() }));
    on("[data-delcal]", "onclick", (e) => this._delRow("calibration_points", +e.currentTarget.dataset.delcal));
    on("[data-capcal]", "onclick", () => this._captureCal());

    // Allgemein tab (global settings + custom platforms)
    on("[data-setting]", "oninput", (e) => { this._settingsDraft[e.currentTarget.dataset.setting] = e.currentTarget.value === "" ? "" : Math.round(parseNum(e.currentTarget.value)) || 0; });
    on("[data-setting-bool]", "onchange", (e) => { this._settingsDraft[e.currentTarget.dataset.settingBool] = e.currentTarget.checked; });
    on("[data-setting-select]", "onchange", (e) => { this._settingsDraft[e.currentTarget.dataset.settingSelect] = e.currentTarget.value; });
    on("[data-platname]", "oninput", (e) => { this._settingsDraft.platforms[+e.currentTarget.dataset.platname].name = e.currentTarget.value; });
    on("[data-addplat]", "onclick", () => {
      (this._settingsDraft.platforms = this._settingsDraft.platforms || []).push({ id: "plat_" + Math.random().toString(36).slice(2, 8), name: t("panel.general.new_platform") });
      this._render();
    });
    on("[data-delplat]", "onclick", (e) => { this._settingsDraft.platforms.splice(+e.currentTarget.dataset.delplat, 1); this._render(); });
    on("[data-savesettings]", "onclick", () => this._saveSettings());

    // YAML modal
    on("[data-closeyaml]", "onclick", () => { this._yaml = null; this._render(); });
    on("[data-closewiring]", "onclick", () => { this._wiring = null; this._render(); });
    on("[data-printwiring]", "onclick", () => this._printWiring());
    on("[data-printtopo]", "onclick", () => this._printTopology());
    on("[data-stop-prop]", "onclick", (e) => e.stopPropagation());
    on("[data-copyyaml]", "onclick", () => this._copyYaml());
    on("[data-dlyaml]", "onclick", () => this._downloadYaml());
  }

  _onField(e, isChange) {
    const el = e.currentTarget;
    const path = el.dataset.path;
    const type = el.dataset.type || "str";
    let v;
    // Numbers are read with parseNum, not parseFloat/parseInt: `<input type=number>`
    // normalises to a dot, but a plain text field (dur) or a browser that hands the
    // localised string through would otherwise turn "1,5" into 1 (i18n-concept §7).
    if (type === "bool") v = el.type === "checkbox" ? el.checked : el.value === "true";
    else if (type === "num") v = el.value === "" ? 0 : Math.round(parseNum(el.value)) || 0;
    else if (type === "float") v = el.value === "" ? 0 : parseNum(el.value) || 0;
    else if (type === "dur") v = parseDur(el.value);
    else if (type === "strlist") v = el.value.split(",").map((x) => x.trim()).filter(Boolean);
    else if (type === "intlist") v = el.value.split(",").map((x) => Math.round(parseNum(x))).filter((n) => !isNaN(n));
    else v = el.value;
    setPath(this._draft, path, v);
    // Live-update the runtime warning in place (no full re-render — that would
    // run on the duration field's blur and eat the Save-button click, FR-S2b).
    if (/(\.duration_min$|^manual_default_min$|^valve_output$|\.enabled$|\.time$)/.test(path)
        && this._editing && (this._editing.kind === "line" || this._editing.kind === "control")) {
      const slot = this.shadowRoot.getElementById("root").querySelector("[data-runtimewarn]");
      if (slot) slot.innerHTML = this._runtimeWarning(this._draft);
    }
    // re-render only when a structural select changed (type/kind/hw_type/repeat/box).
    // In the box editor, channel/gpio/label feed the derived Ausgang-ID (A5 =
    // label+channel) and the sibling channel/GPIO availability + ConnectedDevice
    // labels — re-render so those don't go stale (all <select>, so no Save-eating).
    const boxStructural = this._editing && this._editing.kind === "box"
      && /(\.channel$|\.gpio$|^label$)/.test(path);
    if (isChange && (/(\.type$|\.kind$|^type$|^kind$|^hw_type$|\.repeat$|^box_id$)/.test(path) || boxStructural)) {
      // a changed output type, input kind or box platform can invalidate the pin pools
      if (this._editing && this._editing.kind === "box" && /(\.type$|\.kind$|^hw_type$)/.test(path)) {
        this._normalizeChannels();
        this._normalizeInputPins();
      }
      // line: switching box invalidates a valve that belongs to the old box
      if (path === "box_id" && this._draft.valve_output && !this._draft.valve_output.startsWith(`${v}#`)) {
        this._draft.valve_output = "";
      }
      this._render();
    }
  }
  _normalizeChannels() {
    const d = this._draft;
    for (const o of d.outputs || []) {
      const pool = this._channelPool(d.hw_type, o.type);
      if (!o.channel || !pool.includes(String(o.channel))) o.channel = this._firstFreeChannel(d.hw_type, o.type);
    }
  }
  // First duplicate name (case-insensitive, trimmed) in a list of outputs/inputs,
  // or "" if all unique — names are the key the server matches entities on.
  _dupName(list) {
    const seen = new Set();
    for (const x of list || []) {
      const k = String(x.name || "").trim().toLowerCase();
      if (!k) continue;
      if (seen.has(k)) return x.name;
      seen.add(k);
    }
    return "";
  }
  async _saveSettings() {
    try {
      await this._ws({ type: "gardenesp/settings/set", data: this._settingsDraft });
      await this._load();
      this._toast(t("panel.toast.settings_saved"));
    } catch (err) {
      this._toast(t("panel.toast.save_failed", { msg: errText(err) }));
    }
  }
  _onWeekday(e) {
    const [i, w] = e.currentTarget.dataset.wd.split(":");
    const entry = this._draft.schedule[+i];
    const set = new Set(entry.weekdays || []);
    if (e.currentTarget.checked) set.add(w);
    else set.delete(w);
    entry.weekdays = WEEKDAYS.filter((d) => set.has(d));
    this._render();  // reflect the selected (filled) state — the checkbox itself is hidden
  }
  _addRow(key, row) {
    (this._draft[key] = this._draft[key] || []).push(row);
    this._render();
  }
  _delRow(key, i) {
    this._draft[key].splice(i, 1);
    this._render();
  }
  _localId(prefix, list) {
    const used = new Set((list || []).map((x) => x.id));
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  // Tell the server the YAML was fetched (copy/download) → exported_yaml_hash (#9c).
  _markExported() {
    const id = this._yaml && this._yaml.box_id;
    if (!id) return;
    this._ws({ type: "gardenesp/box/exported", box_id: id })
      .then(() => this._load())
      .catch(() => {});
  }
  _copyYaml() {
    this._markExported();
    const yaml = this._yaml.text;
    // navigator.clipboard needs a secure context (https/localhost) — HA over http
    // on the LAN often has it undefined, so fall back to a hidden textarea + execCommand.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(yaml)
        .then(() => this._toast(t("panel.toast.yaml_copied")))
        .catch(() => this._fallbackCopy(yaml));
    } else {
      this._fallbackCopy(yaml);
    }
  }
  _fallbackCopy(yaml) {
    const ta = document.createElement("textarea");
    ta.value = yaml;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    (this.shadowRoot || document.body).appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    this._toast(t(ok ? "panel.toast.yaml_copied" : "panel.toast.copy_failed"));
  }
  _downloadYaml() {
    this._markExported();
    const blob = new Blob([this._yaml.text], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this._yaml.node || this._yaml.box_id}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }
}

// --- field builders ----------------------------------------------------------
function field(label, control, hint) {
  return `<div class="field"><label>${esc(label)}</label>${control}${
    hint ? `<div class="hint">${esc(hint)}</div>` : ""}</div>`;
}
function text(path, val, ph = "", cls = "") {
  return `<input data-path="${path}" data-type="str"${cls ? ` class="${cls}"` : ""} value="${esc(val == null ? "" : val)}" placeholder="${esc(ph)}">`;
}
function num(path, val, float) {
  return `<input type="number" step="${float ? "any" : "1"}" data-path="${path}" data-type="${float ? "float" : "num"}" value="${val == null ? "" : esc(val)}">`;
}
// Duration in (fractional) minutes, entered as plain minutes (Standardfall) or as
// ``m:ss`` for sub-minute runs (e.g. 0:18 = 18 s, Gießkanne füllen). Stored as float.
function dur(path, val) {
  return `<input data-path="${path}" data-type="dur" value="${esc(fmtDur(val))}" placeholder="${esc(t("panel.field.duration_ph"))}">`;
}
// "0:18" / "1:30" → fractional minutes; a plain number is taken as minutes.
function parseDur(str) {
  const raw = String(str == null ? "" : str).trim();
  if (raw === "") return 0;
  if (raw.includes(":")) {
    const [mm, ss] = raw.split(":");
    return (parseInt(mm, 10) || 0) + (parseInt(ss, 10) || 0) / 60;
  }
  // Locale-aware: a de user types "1,5" for 1½ minutes — parseFloat would read 1
  // and silently shorten every run (i18n-concept §7, the one real data risk).
  return parseNum(raw) || 0;
}
// Fractional minutes → editable text: whole minutes as a plain number, otherwise m:ss.
function fmtDur(min) {
  if (min == null || min === "") return "";
  const totalSec = Math.round(Number(min) * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? String(m) : `${m}:${String(s).padStart(2, "0")}`;
}
function numInline(path, val, ph) {
  return `<input type="number" data-path="${path}" data-type="num" value="${val == null ? "" : esc(val)}" placeholder="${esc(ph)}" title="${esc(ph)}" class="narrow">`;
}
function checkbox(path, val) {
  return `<label class="chk"><input type="checkbox" data-path="${path}" data-type="bool" ${val ? "checked" : ""}> </label>`;
}
function select(path, val, options) {
  const opts = options
    .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`)
    .join("");
  return `<select data-path="${path}" data-type="str">${opts}</select>`;
}
function boolSelect(path, val, trueLabel, falseLabel) {
  return `<select data-path="${path}" data-type="bool">
    <option value="false" ${!val ? "selected" : ""}>${esc(falseLabel)}</option>
    <option value="true" ${val ? "selected" : ""}>${esc(trueLabel)}</option></select>`;
}
// On-device measurement smoothing (moving average) in seconds; 0 = off (FR-S16). The
// window is derived from the sensor's update_interval server-side, so seconds is the
// portable unit. Changing it re-flashes the box (config-hash changes).
function smoothingSelect(path, val) {
  const cur = Number(val) || 0;
  const opts = [0, 30, 60, 90].map((v) =>
    [v, v === 0 ? t("panel.smoothing.none") : t("panel.smoothing.s", { s: fmtNum(v) })]);
  const o = opts.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  return `<select data-path="${path}" data-type="num" title="${esc(t("panel.smoothing.title"))}">${o}</select>`;
}

// --- generic helpers ---------------------------------------------------------
// Real text width (canvas) — used to size the wiring-diagram device boxes so they hug
// their label instead of the old 7.2px/char guess, which over-reserved ~1px per char
// and therefore truncated names while the frame still had room. The +6% margin covers
// renderers that fall back to a wider sans-serif (print window, headless rsvg).
const GC_DEV_FONT = '600 11px Roboto, "Helvetica Neue", Arial, sans-serif';
// Topology node fonts — must match the .tn-* rules in BOTH CSS copies (shadow DOM
// + print window), otherwise the measurement and the rendering disagree.
const TN_STACK = 'Roboto, "Helvetica Neue", Arial, sans-serif';
const TN_FONT = {
  title: `600 13px ${TN_STACK}`,
  meta: `11px ${TN_STACK}`,
  id: `700 10.5px ${TN_STACK}`,
  tag: `10px ${TN_STACK}`,
  head: `700 10px ${TN_STACK}`,   // .tn-h — rendered uppercase, see TN_HEAD_TRACKING
};
// .tn-h carries `letter-spacing: .5px`, which canvas measureText does not know
// about — add it per character or the heading measures narrower than it renders.
const TN_HEAD_TRACKING = 0.5;
let _measureCtx = null;
function textWidth(s, font) {
  const str = String(s == null ? "" : s);
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  // No 2D context (headless test runner, exotic browser): estimate from the font
  // *size and weight* rather than a flat 6.6 px/char, which happened to be right
  // for 11px semibold and wrong for everything else — it under-sized the 13px
  // topology titles (text ran out of its box) and over-sized the 10px tags.
  if (!_measureCtx) {
    const px = parseFloat((String(font).match(/([\d.]+)px/) || [0, 12])[1]);
    const bold = /(^|\s)(600|700|800|900|bold)(\s|$)/.test(String(font));
    return str.length * px * (bold ? 0.6 : 0.55);
  }
  _measureCtx.font = font;
  return _measureCtx.measureText(str).width;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Turn any thrown/rejected value into a readable message — never "[object Object]".
// HA rejects WS calls with {code,message}, or a bare numeric code when the connection
// drops (routine when the iOS app is backgrounded). Mirrors the Card.
const WS_ERROR_KEY = { 1: "error.ws_connect", 2: "error.ws_auth", 3: "error.ws_disconnected" };
function errText(err) {
  if (err == null) return t("error.unknown");
  if (typeof err === "string") return err;
  if (typeof err === "number")
    return WS_ERROR_KEY[err] ? t(WS_ERROR_KEY[err]) : t("error.code", { code: err });
  if (typeof err === "object") {
    if (err.message) return String(err.message);
    if (err.error && err.error.message) return String(err.error.message);
    if (err.code != null) return t("error.code", { code: err.code });
    try { return JSON.stringify(err); } catch (e) { /* circular */ }
  }
  return String(err);
}
function setPath(obj, path, val) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i];
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? +last : last] = val;
}

const CSS = `
:host { display: block; }
.wrap { max-width: 880px; margin: 0 auto; padding: 16px; }
/* Header bar in brand green (= brand/icon.png), deliberately not the theme
   --primary-color; the scoping to .head keeps modal/print headings unaffected. */
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  flex-wrap: wrap; background: #43A047; border-radius: 10px; padding: 6px 12px; margin-bottom: 12px; }
.headbtns { display: inline-flex; align-items: center; gap: 6px; }
h1 { font-size: 22px; margin: 8px 0 12px; color: var(--primary-text-color);
  display: inline-flex; align-items: center; gap: 8px; }
.head h1 { color: #fff; margin: 4px 0; }
h1 ha-icon { --mdc-icon-size: 26px; color: #43A047; }
.head h1 ha-icon { color: #fff; }
/* Label-style buttons that sit *on* the green bar (outlined, white). */
.btn.onbrand { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.7);
  border-radius: 999px; padding: 5px 12px; }
.btn.onbrand:hover { background: rgba(255,255,255,.16); border-color: #fff; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); margin: 0 0 8px; }
.tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.tab { border: none; background: transparent; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  color: var(--secondary-text-color); font-size: 14px; }
.tab.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.cardbox { background: var(--card-background-color, #fff); border-radius: 12px; padding: 14px 16px;
  margin-bottom: 16px; box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.12)); }
.listhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.listhead.nohead { justify-content: flex-end; }
.row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--divider-color, #eee); }
.row:first-of-type { border-top: none; }
.grow { flex: 1; min-width: 0; }
.title { color: var(--primary-text-color); font-weight: 500; }
.row .title { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub { color: var(--secondary-text-color); font-size: 13px; margin-top: 2px; }
/* generic chip (line overview: Automatik state) */
.chip { font-size: 11px; padding: 1px 7px; border-radius: 6px; white-space: nowrap;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.chip.ok { background: rgba(76, 175, 80, .16); color: var(--success-color, #2e7d32); }
.chip.estop { background: rgba(244, 67, 54, .14); color: var(--error-color, #c62828); }
.chip.warn { background: rgba(255, 152, 0, .16); color: var(--warning-color, #e65100); }
/* firmware-drift banner: the slot fills the space right of the tabs and centers
   the pill; the yellow pill hugs its text and ellipsizes when too narrow (full
   text via title on hover), click → Boxen */
.fwslot { flex: 1 1 auto; min-width: 0; display: flex; justify-content: center; }
.fwbanner { min-width: 0; max-width: 100%; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; padding: 5px 10px; border-radius: 8px;
  background: rgba(255, 152, 0, .14); color: var(--warning-color, #e65100); }
/* schedule summary chips in the line overview */
.schedchips { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
.schedchip { font-size: 11px; padding: 1px 7px; border-radius: 6px; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--secondary-background-color); color: var(--secondary-text-color); }
.schedstate { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px;
  padding: 0 5px; border-radius: 4px; line-height: 1.6; }
.schedstate.on { background: rgba(76, 175, 80, .18); color: var(--success-color, #2e7d32); }
.schedstate.off { background: rgba(244, 67, 54, .14); color: var(--error-color, #c62828); }
/* per-line Automatik on/off switch (right end of the line row) */
.lineauto { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--divider-color, #ddd); white-space: nowrap; }
.lineauto input { width: auto; margin: 0; transform: scale(1.1); cursor: pointer; }
.lineauto.on { background: rgba(76, 175, 80, .14); border-color: rgba(76, 175, 80, .5); color: var(--success-color, #2e7d32); }
.lineauto.off { background: rgba(244, 67, 54, .10); border-color: rgba(244, 67, 54, .4); color: var(--error-color, #c62828); }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; margin-left: 6px;
  background: var(--secondary-background-color); color: var(--secondary-text-color); }
.btn { border: none; border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 13px;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.btn.ghost { background: transparent; color: var(--primary-color); }
.btn.danger { background: transparent; color: var(--error-color, #f44336); }
.btn.small { padding: 4px 9px; font-size: 12px; }
.btn:hover { filter: brightness(.95); }
a.btn { text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.empty { color: var(--secondary-text-color); padding: 8px 0; }
.empty.err { color: var(--error-color, #f44336); }
.empty.onboard { padding: 12px 0; max-width: 560px; line-height: 1.45; }
.empty.onboard p { margin: 6px 0; }
.empty.onboard strong { color: var(--primary-text-color); }
.caltable { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; }
.calrow { display: flex; align-items: center; gap: 8px; }
.calrow input { flex: 1; min-width: 0; }
.calarrow { color: var(--secondary-text-color); }
.calbtns { display: flex; gap: 8px; flex-wrap: wrap; }
.calwrap { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.calcol { flex: 1 1 260px; min-width: 240px; }
.calcurve { flex: 1 1 300px; min-width: 260px; }
.calcap { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 2px; }
.calsvg { width: 100%; height: auto; display: block; max-width: 360px; }
.calaxis { stroke: var(--divider-color, #ddd); stroke-width: 1; }
.calline { fill: none; stroke: var(--primary-color); stroke-width: 2; stroke-linejoin: round; }
.calpt { fill: var(--primary-color); }
.calnow { stroke: var(--warning-color, #ffa600); stroke-width: 1.5; stroke-dasharray: 3 3; }
.calnowdot { fill: var(--warning-color, #ffa600); }
.callbl { fill: var(--secondary-text-color); font-size: 10px; }
.field { margin-bottom: 12px; }
.field > label { display: block; font-size: 13px; color: var(--secondary-text-color); margin-bottom: 4px; }
.field input:not([type=checkbox]), .field select {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff);
  color: var(--primary-text-color); font-size: 14px; }
.field input.narrow { width: 110px; }
.field .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; opacity: .85; }
.formwarn { font-size: 13px; line-height: 1.45; margin: 4px 0 12px; padding: 9px 11px; border-radius: 8px;
  background: rgba(255, 152, 0, .14); color: var(--warning-color, #e65100); }
.chk input { width: auto; transform: scale(1.2); }
.subrow { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: nowrap; }
.subrow input, .subrow select, .subrow .ph { flex: 1 1 0; min-width: 0; }
/* input rows have a fixed column set (Name · Art · Pin · Parameter · ✕) → grid so the
   columns line up across rows regardless of the per-kind parameter control width.
   Grid items stretch to their track by default; min-width:0 (above) keeps selects from
   overflowing on long option labels. */
.subrow.inrow { display: grid; grid-template-columns: 2.2fr 1.4fr 1fr 1.6fr auto; }
.subrow .inx { display: flex; gap: 6px; min-width: 0; }   /* soil: threshold + smoothing share one cell */
.subrow .inx > * { flex: 1 1 0; min-width: 0; }
.subrow input.wide { flex-grow: 2.2; }      /* name column — wider */
.subrow input.narrow { width: auto; flex-grow: 0.66; }  /* Not-Aus min — ~1/3 shorter */
.subrow input.ro { flex-grow: 0.5;          /* read-only (auto-conn / polarity) — ~50% shorter */
  background: var(--secondary-background-color); color: var(--secondary-text-color);
  border-style: dashed; cursor: default; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
/* Boxen overview (read-only outputs/inputs + ConnectedDevice connectors) */
.boxlist .boxcard { border-top: 1px solid var(--divider-color, #eee); padding: 10px 0; }
.boxlist .boxcard:first-child { border-top: none; padding-top: 0; }
.boxhead { display: flex; align-items: flex-start; gap: 10px; }
.boxhead .title { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0;
  font-size: 15px; font-weight: 600; }
.boxhead .chip { font-size: 11px; padding: 1px 7px; border-radius: 6px; font-weight: 600;
  background: var(--primary-color); color: var(--text-primary-color, #fff); white-space: nowrap; }
.headacts { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
.grouplabel { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--secondary-text-color); margin: 10px 0 2px; }
.devrow { display: flex; align-items: center; gap: 8px; padding: 2px 0; flex-wrap: wrap; font-size: 13px; }
.devrow .chip { font-size: 11px; padding: 1px 7px; border-radius: 6px; white-space: nowrap;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.devrow .dname { font-weight: 500; color: var(--primary-text-color); }
.devrow .muted { color: var(--secondary-text-color); font-size: 12px; }
.devrow .ent { color: var(--secondary-text-color); font-family: monospace; font-size: 12px;
  word-break: break-all; }
.devrow .chip.estop { background: rgba(244, 67, 54, .14); color: var(--error-color, #c62828); }
.boxstamp { color: var(--secondary-text-color); font-size: 11px; margin-top: 1px; }
.objid { color: var(--secondary-text-color); font-size: 11px; margin-top: 1px; }
.objid code { font-family: var(--code-font-family, monospace); user-select: all; }
/* resolved HA entity_ids of a source (Quellen overview) */
.srcents { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 3px; font-size: 12px; }
.srcent .cl { color: var(--secondary-text-color); margin-right: 3px; }
.srcent .ent { font-family: var(--code-font-family, monospace); font-size: 11px; color: var(--secondary-text-color); }
/* live values in the Boxen overview (output switch state / input reading) */
.devrow .live { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; white-space: nowrap;
  background: var(--secondary-background-color); color: var(--secondary-text-color); }
/* System B (style-guide §3.2): aktiv = blau (nicht grün — grün ist „ok"-reserviert) */
.devrow .live.on { background: rgba(33, 150, 243, .16); color: var(--info-color, #1976d2); }
.devrow .live.off { color: var(--secondary-text-color); }
.devrow .live.wet { background: rgba(33, 150, 243, .16); color: var(--info-color, #1976d2); }
.devrow .live.muted { opacity: .6; font-weight: 400; }
/* a deactivated box's card is dimmed in the overview */
.boxlist .boxcard.off { opacity: .6; }
/* Boxen-Karte: Zonen „Steuerung" / Plattformname, gestapelt (style-guide §4) */
.zone { margin-top: 12px; }
.zonelabel { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--secondary-text-color); display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.zonelabel ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); }
.zonestat { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zonestat .muted { color: var(--secondary-text-color); font-size: 13px; }
.zonemeta { color: var(--secondary-text-color); font-size: 12px; margin-top: 3px; word-break: break-word; }
.diagrow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.diagicon { --mdc-icon-size: 15px; color: var(--secondary-text-color); vertical-align: -3px; margin-right: 1px; }
.faultrow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.faultdot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: 0; margin-left: 1px; }
.faultdot.ok { background: var(--success-color, #43a047); }
.faultdot.bad { background: var(--error-color, #e53935); }
.faultdot.na { background: var(--disabled-text-color, #9e9e9e); }
/* In-Betrieb-Schalter: beschriftetes Pill (Zustand + Farbe + Bedienung in einem) */
.boxswitch { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.boxswitch input { width: auto; margin: 0; transform: scale(1.1); cursor: pointer; }
.boxswitch.on { background: rgba(76, 175, 80, .16); color: var(--success-color, #2e7d32); }
.boxswitch.off { background: var(--secondary-background-color); color: var(--secondary-text-color); }
/* current "Stand" in the Quellen overview — grey pill next to „min %",
   styled like the live sensor values in the Boxen-Übersicht (.devrow .live) */
.srcval { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; white-space: nowrap;
  margin-left: 8px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
.srcval.low { background: rgba(244, 67, 54, .14); color: var(--error-color, #c62828); }
.srcval.muted { opacity: .6; font-weight: 400; }
.connrow { margin: 1px 0 1px 16px; padding: 1px 0 1px 10px; font-size: 12px;
  color: var(--secondary-text-color); border-left: 2px solid var(--primary-color); }
.connrow .chip { font-size: 10px; padding: 0 5px; border-radius: 5px;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.sched { border: 1px solid var(--divider-color, #eee); border-radius: 8px; padding: 8px; }
.schedrow { padding: 6px 0; border-top: 1px solid var(--divider-color, #eee); }
.schedrow:first-child { border-top: none; }
.schedline { display: flex; gap: 6px; align-items: center; }
.schedline select { flex: 0 0 130px; }
.schedline input { flex: 1; }
.schedline .schedon { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
.schedline .schedon input { flex: 0 0 auto; }
.schedrow.disabled { opacity: .55; }
.weekdays { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.wd { font-size: 12px; padding: 3px 7px; border-radius: 6px; cursor: pointer;
  background: var(--secondary-background-color); color: var(--secondary-text-color); }
.wd.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.wd input { display: none; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex;
  align-items: center; justify-content: center; z-index: 10; padding: 16px; }
.modal { background: var(--card-background-color, #fff); border-radius: 12px; padding: 16px;
  max-width: 760px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; }
.modalhead { display: flex; align-items: center; justify-content: space-between; }
.yaml { flex: 1; overflow: auto; background: var(--code-editor-background-color, #1e1e1e);
  color: var(--code-editor-text-color, #d4d4d4); padding: 12px; border-radius: 8px;
  font-family: monospace; font-size: 12px; white-space: pre; }
/* Verdrahtung modal (read-only wiring lens) */
.wirebtn { margin-left: auto; }
.zonelabel { display: flex; align-items: center; gap: 6px; }
.wiremodal { max-width: 880px; }
.wirebody { flex: 1; overflow: auto; }
.wiresvg { width: 100%; height: auto; background: #fff; border-radius: 8px; }
.wiresvg .chip { fill: #eceff1; stroke: #90a4ae; stroke-width: 1.5; }
.wiresvg .usb { fill: #b0bec5; stroke: #78909c; }
.wiresvg .usblbl { font-size: 10px; fill: #37474f; }
.wiresvg .chiplbl { font-size: 12px; fill: #37474f; font-weight: 600; }
.wiresvg .pinlbl { font-size: 11px; }
.wiresvg .pinlbl.on { font-weight: 700; }
.wiresvg .pinlbl.bad { text-decoration: line-through; opacity: .7; }
.wiresvg .wire { stroke: #37474f; stroke-width: 1.6; }
.wiresvg .gndwire { stroke: #90a4ae; stroke-width: 1; stroke-dasharray: 3 2; }
.wiresvg .card rect { fill: #fff; stroke: #455a64; stroke-width: 1.2; }
.wiresvg .cardlbl { font-size: 11px; fill: #263238; }
.wiresvg .cardrole { fill: #78909c; }
.wiresvg .cardid { font-weight: 700; fill: #37474f; }
.wiresvg .legtxt { font-size: 10px; fill: #455a64; }
/* GardenControl terminal board (must mirror _wireStyle() so the modal isn't
   black-on-black — SVG defaults to fill:black for unstyled elements). */
.wiresvg .gccap { font-size: 11px; fill: #607d8b; font-weight: 600; }
.wiresvg .gcscrew { fill: #e8eaed; stroke: #9aa0a6; stroke-width: 1.2; }
.wiresvg .gcslot { stroke: #9aa0a6; stroke-width: 1; }
.wiresvg .gctlbl { font-size: 9px; fill: #546e7a; }
.wiresvg .gctlbl.on { font-weight: 700; fill: #263238; }
.wiresvg .gclednum { font-size: 9px; fill: #90a4ae; }
.wiresvg .gcled { fill: #cfd8dc; }
.wiresvg .termfree { font-size: 9px; fill: #b0bec5; }
.wiresvg .gcwire { stroke: #90a4ae; stroke-width: 1.2; }
.wiresvg .gccard { fill: #fff; stroke-width: 1.2; }
.wiresvg .gccard.out { stroke: #2e7d32; }
.wiresvg .gccard.in { stroke: #1565c0; }
.wiresvg .gcdev { font-size: 11px; font-weight: 600; font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
.wiresvg .gcdev.out { fill: #2e7d32; }
.wiresvg .gcdev.in { fill: #1565c0; }
.wirenotes { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: var(--secondary-text-color); }
.wiredisclaimer { margin: 0 0 12px; padding: 8px 10px; border: 1px solid #e0a800;
  background: rgba(255, 193, 7, .12); color: var(--primary-text-color); font-size: 12px;
  border-radius: 4px; line-height: 1.4; }
/* Topologie tab (read-only hydraulic lens) — inline-SVG schematic
   (text-sized nodes per column Box·Quelle·Pumpe·Ventil·Linie, elbow-wired,
   echoing the Verdrahtungs-Lens). */
.topo-intro { margin: 0 0 12px; }
.topo-group { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px;
  padding: 8px; margin-bottom: 12px; overflow-x: auto; }
.toposvg { display: block; width: 100%; height: auto; min-width: 520px;
  font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
.toposvg .tn-h { font-size: 10px; font-weight: 700; letter-spacing: .5px;
  fill: var(--secondary-text-color, #888); text-transform: uppercase; }
.toposvg .tn-id { font-size: 10.5px; font-weight: 700; fill: #fff; }
.toposvg .tn-t { font-size: 13px; font-weight: 600; fill: var(--primary-text-color, #222); }
.toposvg .tn-t.mut { font-weight: 500; fill: var(--secondary-text-color, #888); }
.toposvg .tn-m { font-size: 11px; fill: var(--secondary-text-color, #666); }
.toposvg .tn-tag { font-size: 10px; fill: #555; }
.toposvg .tn-tagbox { fill: #e0e0e0; }
.toposvg .tw { fill: none; stroke-width: 1.4; }
/* Mobile: action buttons stack BELOW the content instead of squeezing the text.
   Linien/Quellen-Zeilen (.row): Inhalt volle Breite, Aktionen wrappen darunter.
   Boxen-Kopf (.boxhead): Titel volle Breite, dann die Buttons darunter. */
@media (max-width: 600px) {
  .row { flex-wrap: wrap; }
  .row > .grow { flex-basis: 100%; }
  .boxhead { flex-direction: column; align-items: stretch; }
  .headacts { flex-wrap: wrap; }
}
`;

if (!customElements.get("gardenesp-panel")) {
  customElements.define("gardenesp-panel", GardenEspPanel);
}
