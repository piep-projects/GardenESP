/**
 * GardenESP IrrigationController — Lovelace dashboard card.
 *
 * This card *is* the Dashboard (FDS §5.1, FR-D1ff) — the sidebar panel holds only
 * Einstellungen. It renders one **mixed row list** of all entities (water sources,
 * irrigation lines and sensors), each row with a type icon, status, „Letzte"/„Nächste"
 * and a compact action icon; clicking the row opens a Details overlay with read-only
 * config (FR-D1a) and the irrigation history log (FR-D6). Manual start uses an inline
 * editable timer. Layout is mobile-first: name ellipsizes, status badge stays inline.
 *
 * Talks to the integration's WebSocket API (same as the panel). Add via:
 *     type: custom:gardenesp-card
 *     title: GardenESP          # optional
 */

// Glyph + colour stay in code (decoration); the wording lives in the language
// catalogs under `card.status.<state>` (i18n-concept §4).
const STATUS = {
  active: { glyph: "●", cls: "ok" },
  idle: { glyph: "○", cls: "muted" },
  waiting: { glyph: "○", cls: "warn" },
  blocked_sensor: { glyph: "⚠", cls: "info" },
  blocked_level: { glyph: "⚠", cls: "info" },
  automatic_off: { glyph: "◌", cls: "muted" },
  box_disabled: { glyph: "◌", cls: "muted" },
  unreachable: { glyph: "⚠", cls: "warn" },
  settling: { glyph: "◐", cls: "warn" },
};
// Label for a status badge: „● Aktiv" / „● Active". Unknown values fall back to
// the resting state, mirroring the `STATUS[status] || STATUS.idle` lookup.
function statusLabel(status) {
  const key = STATUS[status] ? status : "idle";
  return `${STATUS[key].glyph} ${t(`card.status.${key}`)}`;
}
// Pure resting states carry no information the row doesn't already show (Letzte/
// Nächste + ▶-Start button ⇒ „ruht gerade") → render no badge. „Automatik AUS" is
// already surfaced by the separate „Auto aus"-Tag, so it needn't repeat as a badge.
const RESTING_STATES = new Set(["idle", "automatic_off"]);
// Firmware-drift status per box (#9) — keys match coordinator drift.fw_status().
const FW_ATTENTION = ["drift", "drift_offline", "drift_export"];
// Reset reasons that signal a fault (roadmap #20): a brownout/watchdog/panic reboot
// is the kind that interrupts a run — surfaced on the dashboard. Benign reasons
// (power-on, restart button, OTA) stay hidden. The substring match covers ESPHome's
// variants (Task/Interrupt/RTC Watchdog, Software Panic).
const PROBLEM_RESET_RE = /brownout|watchdog|panic/i;
// Wording for these lives in the language catalogs (enum.source_type.* /
// card.sensor_kind.* / card.result.* / card.trigger.*); the code only keeps the keys.
const SOURCE_TYPES = ["cistern", "mains"];
const SENSOR_KINDS = ["rain", "soil_moisture"];
const RESULTS = ["completed", "stopped", "skipped_sensor", "skipped_level",
  "skipped_unreachable", "superseded", "interrupted", "emergency"];
const resultLabel = (r) => (RESULTS.includes(r) ? t(`card.result.${r}`) : r);
// Run results that count as a disturbance (Störung) surfaced on the dashboard
// (CR-0011). Deliberate outcomes (rain skip, planned supersede, manual stop) are
// excluded — those are normal operation, not a fault.
const FAULT_RESULTS = new Set([
  "skipped_unreachable", "skipped_level", "interrupted", "emergency",
]);
const triggerLabel = (x) => (x === "auto" || x === "manual" ? t(`card.trigger.${x}`) : x || "—");
// Type icons — mockup Ansicht 1 / ui-mockup.md.
const ICONS = {
  line: "mdi:water",
  control: "mdi:toggle-switch-variant",
  cistern: "mdi:car-coolant-level",
  mains: "mdi:faucet",
  rain: "mdi:weather-pouring",
  soil_moisture: "mdi:water-percent",
  box_off: "mdi:power-plug-off",
};
const POLL_MS = 10000;
const ICON = "mdi:sprout"; // shared with sidebar panel (const.py PANEL_ICON)
const APP_NAME = "GardenESP";

// ---------------------------------------------------------------------------
// i18n / l10n (FR-I1, docs/i18n-concept.md §4/§7/§8)
//
// Three independent axes, three signals — never coupled: language follows
// `hass.language`, number/date format follows `hass.locale`, units follow
// `hass.config.unit_system`. Translations are *data*: one flat JSON catalog per
// language, fetched at runtime, so a new language is a new file and no code
// change. English is the base/fallback across all subsystems.
// ---------------------------------------------------------------------------
const I18N_URL = "/gardenesp_i18n"; // static path (const.py I18N_STATIC_URL)
const I18N_BASE_LANG = "en";
// Our own module URL carries `?v=<manifest version>` (the Lovelace resource is
// registered that way) — reuse it to cache-bust the catalogs in lockstep.
const VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "0";
  } catch (e) {
    return "0";
  }
})();
// Emergency catalog: if *no* catalog can be fetched (stale deploy, 404, offline)
// the fallback chain would end at the raw key and the whole card would read
// „card.status.active" — worse than before i18n existed. These few English
// strings keep it usable; everything else still degrades to its key.
const I18N_EMERGENCY = {
  "common.loading": "Loading…",
  "common.error": "Error: {msg}",
  "error.unknown": "Unknown error",
  "error.code": "Error {code}",
  "error.ws_connect": "Cannot connect to Home Assistant",
  "error.ws_auth": "Authentication invalid",
  "error.ws_disconnected": "Connection to Home Assistant lost",
  // Scope of this list: the **always-visible row list** (status, units, the
  // Letzte/Nächste labels, row buttons, sensor states). Deeper surfaces (details
  // overlay, history table) fall back to humanizeKey() below — the user opens
  // those deliberately and a later poll heals the catalog anyway.
  "card.status.active": "Active",
  "card.status.idle": "Idle",
  "card.status.waiting": "Waiting",
  "card.status.blocked_sensor": "Blocked · sensor wet",
  "card.status.blocked_level": "Blocked · low water level",
  "card.status.automatic_off": "Automatic OFF",
  "card.status.box_disabled": "Controller disabled",
  "card.status.unreachable": "Unreachable",
  "card.status.settling": "Settling · measuring",
  "unit.liters": "L",
  "unit.cubic_meters": "m³",
  "unit.gallons": "gal",
  "unit.minutes": "min",
  "unit.seconds": "s",
  "card.label.last": "Last",
  "card.label.next": "Next",
  "common.tag.auto_off": "Auto off",
  "card.row.box_out_of_service": "Controller out of service",
  "card.row.box_disabled": "Controller disabled",
  "card.action.start": "Start",
  "card.action.start_anyway": "Start anyway (sensor blocks)",
  "card.action.stop": "Stop",
  "card.action.manual_start": "Start manually",
  "card.group.controls": "Controls",
  "card.source.low_level": "Low water level",
  "card.empty.unconfigured": "Nothing configured yet — see settings",
  "enum.sensor.dry": "dry",
  "enum.sensor.wet": "wet",
  "enum.sensor.moist": "moist",
};
const _i18nFetches = new Map(); // lang -> Promise<catalog|null>
let _i18n = { lang: null, cat: {}, base: {}, degraded: false };
// Format/unit state, refreshed from `hass` on every load. Kept module-level so
// the formatters stay callable from anywhere (they are used in dozens of places
// that have no `hass` at hand) while still following the two other axes.
const _fmt = { locale: I18N_BASE_LANG, us: false };

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
// existing async initial load, so the first render already has its strings —
// no flash of untranslated content.
async function i18nLoad(hass) {
  const lang = i18nLang(hass);
  // Number format and units are their own axes — refresh them every time, the
  // user may switch unit system without switching language.
  const units = (hass && hass.config && hass.config.unit_system) || {};
  _fmt.locale = (hass && hass.locale && hass.locale.language) || lang;
  _fmt.us = units.volume === "gal" || units.length === "mi";
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

// Three-step fallback: active language → en → emergency → key. Placeholders are
// named (`{n}`); values are substituted verbatim, so anything user-supplied must
// be esc()'d by the caller — t() does not escape.
function t(key, vars) {
  const s = _i18n.cat[key] ?? _i18n.base[key] ?? I18N_EMERGENCY[key] ?? humanizeKey(key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
}
// Last resort so a key never reaches the screen as „card.detail.max_volume":
// take its last segment and make it readable („Max volume"). Only reachable if
// no catalog loaded at all — the CI guard rules out genuinely missing keys.
function humanizeKey(key) {
  const last = String(key).split(".").pop().replace(/_/g, " ");
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// Number/date formatting follows `hass.locale` (falls back to the language) —
// never a hard-coded "de-DE".
function fmtNum(value, opts) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(_fmt.locale, opts).format(n);
  } catch (e) {
    return String(n);
  }
}
function fmtDateParts(date, opts) {
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

// Units are their own axis: storage/logic/calibration stay metric everywhere,
// only the *display* converts (FR-I1 (e)). HA's own sensors convert themselves;
// this is for the volumes we format by hand.
const L_PER_GAL = 3.785411784;
// Liters → display unit. `withUnit` false gives the bare number (for rows that
// print the unit themselves).
function vol(liters, withUnit = true) {
  const v = Number(liters);
  if (!isFinite(v)) return "—";
  if (_fmt.us)
    return `${fmtNum(v / L_PER_GAL, { maximumFractionDigits: 0 })}${withUnit ? ` ${t("unit.gallons")}` : ""}`;
  return `${fmtNum(Math.round(v), { maximumFractionDigits: 0 })}${withUnit ? ` ${t("unit.liters")}` : ""}`;
}

class GardenEspCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._data = null;
    this._history = [];
    this._error = null;
    this._loading = true;
    this._timer = null;
    this._tick = null;
    this._onVisible = () => { if (!document.hidden) this._load(); };
    this._built = false;
    this._inline = null; // {kind:"line", id, min, force} while a timer is open
    this._details = null; // {kind:"line"|"source"|"sensor", id} while overlay is open
  }

  setConfig(config) {
    this._config = config || {};
  }
  getCardSize() {
    const cfg = this._cfg();
    return (
      2 +
      Object.keys(cfg.lines || {}).length +
      Object.keys(cfg.sources || {}).length +
      this._sensorInputs(cfg).length
    );
  }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first) this._load();
  }

  connectedCallback() {
    this._build();
    // Remember the view this dashboard lives on so the panel's "← Dashboard" can
    // return here even when Einstellungen was opened from the sidebar (no card
    // click sets the per-trip sessionStorage return path). Persisted in
    // localStorage so it survives across page loads; updated on each view
    // activation (connect) → last view the card was shown on wins.
    try { localStorage.setItem("gardenesp:dashboard", location.pathname + location.search); } catch (e) { /* private mode */ }
    // Re-showing the card (view switch, back from Einstellungen) must not leave the
    // previous — possibly stale — data on screen until the poll fires: settings
    // saved in the panel would look like they hadn't taken effect.
    this._load();
    if (!this._timer) this._timer = setInterval(() => this._load(), POLL_MS);
    if (!this._tick) this._tick = setInterval(() => this._updateCountdown(), 1000);
    // A backgrounded (iOS) app freezes the poll and drops the WS — reload as soon
    // as it comes back to the foreground instead of waiting out the interval.
    document.addEventListener("visibilitychange", this._onVisible);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._tick) clearInterval(this._tick);
    this._timer = this._tick = null;
    document.removeEventListener("visibilitychange", this._onVisible);
  }

  async _ws(msg) {
    return this._hass.connection.sendMessagePromise(msg);
  }
  async _load() {
    if (!this._hass) return;
    try {
      // The language catalogs ride along with the data the card already awaits
      // before its first render — no flash of untranslated content, and a failed
      // catalog fetch never fails the load (i18nLoad resolves either way).
      const [cfg, hist] = await Promise.all([
        this._ws({ type: "gardenesp/config/get" }),
        this._ws({ type: "gardenesp/history" }),
        i18nLoad(this._hass),
      ]);
      this._data = cfg;
      this._history = (hist && hist.entries) || [];
      this._error = null;
    } catch (err) {
      // Keep the last good data on screen — a dropped WS (backgrounded iOS app)
      // self-heals on the next poll; only the very first load has nothing to show.
      this._error = errText(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }
  _cfg() {
    return (this._data && this._data.config) || {};
  }
  _val(id, key, dflt = null) {
    if (!this._data || !this._data.values) return dflt;
    const v = this._data.values[`${id}__${key}`];
    return v === undefined ? dflt : v;
  }
  async _action(msg, label) {
    try {
      await this._ws(msg);
    } catch (err) {
      this._toast(`${label} fehlgeschlagen: ${errText(err)}`);
    }
    await this._load();
  }

  // --- box/valve short id (A5 = box label A + valve channel 5; FDS §4.1) ------
  _output(cfg, ref) {
    if (!ref || !ref.includes("#")) return null;
    const [boxId, local] = ref.split("#");
    const box = (cfg.boxes || {})[boxId];
    return box ? (box.outputs || []).find((o) => o.id === local) || null : null;
  }
  _inputOf(cfg, ref) {
    if (!ref || !ref.includes("#")) return null;
    const [boxId, local] = ref.split("#");
    const box = (cfg.boxes || {})[boxId];
    return box ? (box.inputs || []).find((i) => i.id === local) || null : null;
  }
  // Blocking sensors = rain/soil box inputs → [{ref, inp}] for the mixed list.
  _sensorInputs(cfg) {
    const out = [];
    for (const box of Object.values(cfg.boxes || {}))
      for (const inp of box.inputs || [])
        if (inp.kind === "rain" || inp.kind === "soil_moisture")
          out.push({ ref: `${box.id}#${inp.id}`, inp });
    return out;
  }
  _valveLabel(cfg, ln) {
    return this._refLabel(cfg, ln.valve_output);
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
  _isBoxDisabled(cfg, boxId) {
    const box = (cfg.boxes || {})[boxId];
    return !!(box && box.enabled === false);
  }
  // A source follows its hardware: out of service if any box it references
  // (Pegel-Sensor / Zähler / Pumpe) is deactivated.
  _isSourceDisabled(cfg, s) {
    return [s && s.level_input, s && s.meter_input, s && s.pump_output]
      .filter((r) => r && r.includes("#"))
      .some((r) => this._isBoxDisabled(cfg, r.split("#")[0]));
  }
  // A line can't run if its own box — or its source's box — is deactivated.
  _lineOutOfService(cfg, ln) {
    if (this._isBoxDisabled(cfg, ln.box_id)) return true;
    const src = (cfg.sources || {})[ln.source_id];
    return !!(src && this._isSourceDisabled(cfg, src));
  }
  // One row standing in for a whole deactivated box (shown when its entities are hidden).
  _boxOffRow(b) {
    const label = esc(`${b.label ? b.label + " · " : ""}${b.name || b.id}`);
    const line1 = `<span class="nm">${label}</span>`;
    const right = `<span class="muted">deaktiviert</span>`;
    return this._row(ICONS.box_off, "", line1, t("card.row.box_out_of_service"), right, "");
  }
  // Short id (A5) for any output ref "{box_id}#{output_id}".
  _refLabel(cfg, ref) {
    if (!ref || !ref.includes("#")) return "—";
    const box = (cfg.boxes || {})[ref.split("#")[0]];
    if (!box) return "—";
    const letter = box.label || "?";
    const out = this._output(cfg, ref);
    return out && out.channel ? `${letter}${out.channel}` : letter;
  }

  // The settings panel is admin-only (FR-P2). Hide the entry points that would
  // otherwise send a non-admin to a route HA refuses to open — the dashboard
  // itself stays fully usable for them.
  _isAdmin() {
    return !!(this._hass && this._hass.user && this._hass.user.is_admin);
  }

  // Banner shown when one or more boxes need (re)flashing (#9). Click → Einstellungen.
  _fwBanner(cfg) {
    const names = Object.values(cfg.boxes || {})
      .filter((b) => b.enabled !== false && FW_ATTENTION.includes(this._val(b.id, "fw_status")))
      .map((b) => (b.label ? t("common.controller_x", { label: String(b.label).toUpperCase() }) : b.name || b.id));
    if (!names.length) return "";
    const txt = esc(t("common.banner.flash_pending", { names: names.join(" · ") }));
    // Non-admins see the same warning, just not as a link into the settings.
    return this._isAdmin()
      ? `<a class="fwbanner" href="/gardenesp" title="${esc(t("card.banner.flash_title"))}">${txt}</a>`
      : `<div class="fwbanner">${txt}</div>`;
  }

  // Banner shown when a box's last reboot had a fault cause (roadmap #20): a
  // brownout/watchdog/panic reset — the kind that interrupts a run. Benign reasons
  // (power-on, restart button, OTA) stay hidden to keep the dashboard quiet.
  _rebootBanner(cfg) {
    const names = Object.values(cfg.boxes || {})
      .filter((b) => b.enabled !== false)
      .map((b) => ({ b, r: this._val(b.id, "reset_reason") }))
      .filter(({ r }) => r && PROBLEM_RESET_RE.test(r))
      .map(({ b, r }) => `${b.label ? t("common.controller_x", { label: String(b.label).toUpperCase() }) : b.name || b.id} — ${r}`);
    if (!names.length) return "";
    return `<div class="fwbanner" title="${esc(t("card.banner.reboot_title"))}">${esc(t("card.banner.reboot", { names: names.join(" · ") }))}</div>`;
  }

  _build() {
    if (this._built) return;
    this._built = true;
    const style = document.createElement("style");
    style.textContent = CSS;
    const card = document.createElement("ha-card");
    card.id = "card";
    this.shadowRoot.append(style, card);
    this._render();
  }

  _render() {
    const card = this.shadowRoot && this.shadowRoot.getElementById("card");
    if (!card) return;
    // The whole card is rebuilt via innerHTML below; if the manual-timer input is
    // being edited, remember focus + caret so the poll re-render doesn't kick the
    // user out of the field (and dismiss the iOS keyboard) mid-edit.
    const active = this.shadowRoot.activeElement;
    const keepInput = !!(active && active.matches && active.matches("[data-mininput]"));
    const caret = keepInput ? [active.selectionStart, active.selectionEnd] : null;
    const title = this._config.title || APP_NAME;
    const hd = `<div class="hd"><span class="ttl"><ha-icon icon="${ICON}"></ha-icon>${esc(title)}</span>`;
    if (this._loading) {
      card.innerHTML = `${hd}</div><div class="empty">${esc(t("common.loading"))}</div>`;
      return;
    }
    // Only take over the whole card when we have nothing to show yet. A refresh
    // failure while data is already loaded keeps the dashboard visible (the poll
    // recovers on its own) instead of stranding the user on an error screen.
    if (this._error && !this._data) {
      card.innerHTML = `${hd}</div><div class="empty err">${esc(t("common.error", { msg: this._error }))}</div>`;
      return;
    }
    const cfg = this._cfg();
    // Deactivated boxes: hide their lines & sensors by default and show one
    // „Box deaktiviert" row instead; the Allgemein toggle keeps them visible.
    const showOff = !!((cfg.settings || {}).show_disabled_box_entities);
    const offBox = (boxId) => this._isBoxDisabled(cfg, boxId);
    let sources = Object.values(cfg.sources || {});
    const allLines = Object.values(cfg.lines || {});
    let lines = allLines.filter((ln) => ln.kind !== "switch");
    // Steuerungen (kind=switch) — own dashboard group, only if show_on_dashboard (FR-D3a).
    let controls = allLines.filter((ln) => ln.kind === "switch" && ln.show_on_dashboard !== false);
    let sensors = this._sensorInputs(cfg);
    if (!showOff) {
      // Hide entities whose own box is deactivated; sources follow their hardware box.
      sources = sources.filter((s) => !this._isSourceDisabled(cfg, s));
      lines = lines.filter((ln) => !offBox(ln.box_id));
      controls = controls.filter((ln) => !offBox(ln.box_id));
      sensors = sensors.filter(({ ref }) => !offBox(ref.split("#")[0]));
    }
    const offRows = !showOff
      ? Object.values(cfg.boxes || {}).filter((b) => b.enabled === false).map((b) => this._boxOffRow(b)).join("")
      : "";
    // One mixed list (no group headers — FR-D1): lines are the anchor; sources and
    // sensors sit before or after them per the Allgemein settings (defaults keep the
    // historical order sources → lines → sensors). Steuerungen stay last (FR-D3a).
    const st = cfg.settings || {};
    const sourcesHtml = sources.map((s) => this._sourceRow(cfg, s)).join("");
    const sensorsHtml = sensors.map(({ ref, inp }) => this._sensorRow(cfg, ref, inp)).join("");
    const before = [];
    const after = [];
    (st.sources_pos === "after" ? after : before).push(sourcesHtml);
    (st.sensors_pos === "before" ? before : after).push(sensorsHtml);
    const rows =
      before.join("") +
      lines.map((ln) => this._lineRow(cfg, ln)).join("") +
      after.join("") +
      (controls.length
        ? `<div class="grouphd">${esc(t("card.group.controls"))}</div>` +
          controls.map((ln) => this._controlRow(cfg, ln)).join("")
        : "") +
      offRows;
    card.innerHTML = `
      ${hd}${this._isAdmin() ? `<a class="open" href="/gardenesp" title="${esc(t("card.action.open_settings"))}">⚙</a>` : ""}</div>
      ${this._fwBanner(cfg)}
      ${this._rebootBanner(cfg)}
      ${rows || `<div class="empty">${esc(t("card.empty.unconfigured"))} ⚙</div>`}
      ${this._details ? this._detailsOverlay(cfg) : ""}`;
    this._bind();
    if (keepInput) {
      const inp = card.querySelector("[data-mininput]");
      if (inp) {
        inp.focus();
        try { inp.setSelectionRange(caret[0], caret[1]); } catch (e) { /* selection unsupported */ }
      }
    }
  }

  // detail = "kind:id" → the whole row is clickable and opens that Details overlay.
  // ``right`` = right-aligned value/status (sensors & sources); omit ``line2`` → single-line row.
  _row(icon, detail, line1, line2, right, action, actsClass = "") {
    return `<div class="row${detail ? " clickable" : ""}"${detail ? ` data-rowdetails="${detail}"` : ""}>
      <ha-icon class="ico" icon="${icon}"></ha-icon>
      <div class="grow"><div class="t">${line1}</div>${line2 ? `<div class="s">${line2}</div>` : ""}</div>
      <div class="rgt">${right || ""}</div>
      <div class="acts${actsClass ? " " + actsClass : ""}">${action || ""}</div>
    </div>`;
  }
  // The inline duration timer is much wider than the compact ▶/■ icon; kept in the
  // narrow action column it crushes the content column and the text wraps one word
  // per line. When it's open the row breaks it onto its own full-width line (.acts.full).
  _timerOpen(id) {
    return !!(this._inline && this._inline.kind === "line" && this._inline.id === id);
  }

  // --- line row --------------------------------------------------------------
  _lineRow(cfg, ln) {
    const id = ln.id;
    const boxOff = this._lineOutOfService(cfg, ln);
    let status = boxOff ? "box_disabled" : this._val(id, "status", ln.automatic ? "idle" : "automatic_off");
    // Low-cistern blocking is surfaced at the source (Zisterne) and in the „Letzte"
    // fault marker, not as a live badge on the line — fall back to the resting state.
    if (status === "blocked_level") status = ln.automatic ? "idle" : "automatic_off";
    const st = STATUS[status] || STATUS.idle;
    const label = esc(`${this._lineId(cfg, ln)} · ${ln.name || id}`);
    const auto = ln.automatic ? "" : ` <span class="tag">${esc(t("common.tag.auto_off"))}</span>`;
    const last = this._lastFor(id);
    const lastIsFault = last && last === this._faultFor(id);
    const lastTxt = `${t("card.label.last")}: ${last ? fmtLast(last, lastIsFault) : "—"}`;
    const nextTxt = `${t("card.label.next")}: ${fmtNext(this._val(id, "next_run"))}`;
    // Source/box belong in the Details overlay (FR-D1a), not the line row (FR-D1).
    const sub = `${lastTxt}${this._faultLine(id, status)} · ${nextTxt}`;
    let badge;
    if (RESTING_STATES.has(status)) {
      badge = "";
    } else if (status === "active") {
      const until = this._val(id, "until");
      badge = `<span class="badge ok">${statusLabel(status)} <span data-until="${esc(until || "")}">${fmtRemaining(until)}</span></span>`;
    } else {
      badge = `<span class="badge ${st.cls}">${statusLabel(status)}</span>`;
    }
    // Name (ellipsizes) + status badge stay together on line 1; click the row → Details.
    const line1 = `<span class="nm">${label}</span> ${badge}${auto}`;
    // A deactivated box is out of service — no manual start from the dashboard.
    const action = boxOff ? "" : this._lineActions(ln, status);
    return this._row(ICONS.line, `line:${esc(id)}`, line1, sub, "", action, this._timerOpen(id) ? "full" : "");
  }

  _lineActions(ln, status) {
    const id = ln.id;
    if (this._inline && this._inline.kind === "line" && this._inline.id === id) {
      return this._inlineTimer();
    }
    // Nachlauf/Messung: the watering is done, the run finishes on its own — no
    // stop (would discard nothing now) and no manual start (source still locked).
    if (status === "settling") {
      return "";
    }
    // Compact icon, far right (mobile-first). Tooltip carries the verb.
    if (status === "active") {
      return `<button class="iconbtn stop" title="${esc(t("card.action.stop"))}" data-stop="${esc(id)}"><ha-icon icon="mdi:stop"></ha-icon></button>`;
    }
    if (status === "blocked_sensor") {
      return `<button class="iconbtn warn" title="${esc(t("card.action.start_anyway"))}" data-manual="${esc(id)}" data-force="1"><ha-icon icon="mdi:play"></ha-icon></button>`;
    }
    return `<button class="iconbtn primary" title="${esc(t("card.action.manual_start"))}" data-manual="${esc(id)}"><ha-icon icon="mdi:play"></ha-icon></button>`;
  }

  // --- control row (Steuerung, kind=switch) — FR-D3a -------------------------
  _controlRow(cfg, ln) {
    const id = ln.id;
    const boxOff = this._lineOutOfService(cfg, ln);
    const status = boxOff ? "box_disabled" : this._val(id, "status", ln.automatic ? "idle" : "automatic_off");
    const st = STATUS[status] || STATUS.idle;
    const auto = ln.automatic ? "" : ` <span class="tag">${esc(t("common.tag.auto_off"))}</span>`;
    const last = this._lastFor(id);
    const lastIsFault = last && last === this._faultFor(id);
    const sub = `${t("card.label.last")}: ${last ? fmtLast(last, lastIsFault) : "—"}${this._faultLine(id, status)} · ${t("card.label.next")}: ${fmtNext(this._val(id, "next_run"))}`;
    let badge;
    if (RESTING_STATES.has(status)) {
      badge = "";
    } else if (status === "active") {
      const until = this._val(id, "until");
      if (until) {
        badge = `<span class="badge ok">${statusLabel(status)} <span data-until="${esc(until)}">${fmtRemaining(until)}</span></span>`;
      } else {
        // Dauerbetrieb: no fixed end → count elapsed up instead of a countdown.
        const since = this._val(id, "started");
        badge = `<span class="badge ok">${statusLabel(status)} <span data-since="${esc(since || "")}">${fmtElapsed(since)}</span></span>`;
      }
    } else {
      badge = `<span class="badge ${st.cls}">${statusLabel(status)}</span>`;
    }
    const line1 = `<span class="nm">${esc(ln.name || id)}</span> ${badge}${auto}`;
    const action = boxOff ? "" : this._lineActions(ln, status);  // ▶/■ shared with lines
    return this._row(ICONS.control, `line:${esc(id)}`, line1, sub, "", action, this._timerOpen(id) ? "full" : "");
  }

  // --- source row ------------------------------------------------------------
  _sourceRow(cfg, s) {
    const id = s.id;
    const isC = s.type === "cistern";
    const icon = isC ? ICONS.cistern : ICONS.mains;
    // Source on a deactivated box → out of service (shown only when entities are kept visible).
    if (this._isSourceDisabled(cfg, s)) {
      const line1 = `<span class="nm">${esc(s.name || id)}</span>`;
      return this._row(icon, `source:${esc(id)}`, line1, "", `<span class="muted">${esc(t("card.row.box_disabled"))}</span>`, "");
    }
    // Single line: name left, fill level right-aligned — just liters, like a box sensor
    // value (Max steht links neben Min in der Übersicht; Prozent nur im Detail). The icon
    // already says the type — no tag.
    let right = "";
    let low = false;
    if (isC) {
      const pct = this._val(id, "level_pct");
      const level = this._val(id, "level");
      low = pct != null && s.min_fill_pct && pct < s.min_fill_pct;
      const txt = `${level != null ? Math.round(level) : "—"} L`;
      right = `<span class="${low ? "warnText" : ""}">${esc(txt)}</span>`;
    } else {
      // Festwasser has no fill level — show today's consumption instead (consumption_today,
      // published per source by the coordinator; 0 when nothing was drawn today).
      const today = this._val(id, "consumption_today");
      right = `<span>${esc(today != null ? vol(today) : "—")}</span>`;
    }
    // Low water level is a property of the source — surfaced here (next to the
    // Zisterne name) rather than as a per-line „Gesperrt" badge.
    const badge = low ? ` <span class="badge warn">⚠ ${esc(t("card.source.low_level"))}</span>` : "";
    // Reading outside the calibration table: the level is frozen on an endpoint, so
    // „Wasserstand niedrig" can no longer fire and consumption books 0 L (FR-S5c).
    const rw = this._rangeWarn(cfg, s);
    const rbadge = rw ? ` <span class="badge warn" title="${esc(rw.text)}">${esc(rw.chip)}</span>` : "";
    const line1 = `<span class="nm">${esc(s.name || id)}</span>${badge}${rbadge}`;
    return this._row(icon, `source:${esc(id)}`, line1, "", right, "");
  }

  // --- sensor row (rain/soil box input) --------------------------------------
  _sensorRow(cfg, ref, inp) {
    const icon = ICONS[inp.kind] || ICONS.rain;
    const box = (cfg.boxes || {})[ref.split("#")[0]];
    const sid = `${(box && box.label) || "?"}${shortPin(inp.pin, box)}`; // e.g. A·BIN1 / A32
    // Rain = two states (trocken/nass); the "sperrt" consequence is shown via colour, not words.
    let state = "—";
    let cls = "muted";
    if (inp.kind === "rain") {
      const b = this._val(ref, "state");
      if (b != null) {
        state = t(b ? "enum.sensor.wet" : "enum.sensor.dry");
        cls = b ? "info" : "muted";
      }
    } else {
      const m = this._val(ref, "moisture");
      if (m != null) {
        const blocked = inp.threshold_pct && m >= inp.threshold_pct;
        state = `${fmtNum(Math.round(m))} % · ${t(blocked ? "enum.sensor.moist" : "enum.sensor.dry")}`;
        cls = blocked ? "info" : "muted";
      }
    }
    // Single line: name left, state right-aligned (no type tag — icon/name already say "Regen").
    const line1 = `<span class="nm">${esc(sid + " · " + (inp.name || ref))}</span>`;
    const right = `<span class="${cls === "muted" ? "" : "warnText"}">${esc(state)}</span>`;
    return this._row(icon, `sensor:${esc(ref)}`, line1, "", right, "");
  }

  // --- inline manual-start timer ---------------------------------------------
  _inlineTimer() {
    // Show what the user has typed (mirrored to _inline.raw on input), not the
    // preset — otherwise the 10 s poll re-render would overwrite their edit.
    const val = this._inline.raw != null ? this._inline.raw : fmtDurInput(this._inline.min);
    return `<div class="timer">
      <input type="text" class="mininput" value="${esc(val)}" data-mininput placeholder="5 / 0:18" title="${esc(t("card.timer.hint"))}">
      <span class="unit">${esc(t("card.timer.unit"))}</span>
      <button class="btn primary" data-go>${esc(t("card.action.start"))}</button>
      <button class="btn ghost" data-cancelinline>✕</button>
    </div>`;
  }

  // --- details overlay (FR-D1a config read-only + FR-D6 history) -------------
  _detailsOverlay(cfg) {
    const { kind, id } = this._details;
    let title = t("card.detail.title");
    let body = "";
    let icon = ICONS.line;
    if (kind === "line") {
      const ln = (cfg.lines || {})[id];
      if (ln) {
        icon = ICONS.line;
        title = esc(`${this._lineId(cfg, ln)} · ${ln.name || id}`);
        body = this._lineDetails(cfg, ln) + this._consumptionSummary((e) => e.line_id === id) + this._historyTable(id);
      }
    } else if (kind === "source") {
      const s = (cfg.sources || {})[id];
      if (s) {
        icon = ICONS[s.type] || ICONS.cistern;
        title = esc(s.name || id);
        body = this._sourceDetails(cfg, s)
          + this._consumptionSummary((e) => e.source_id === id) + this._sourceHistoryTable(id);
      }
    } else if (kind === "sensor") {
      const inp = this._inputOf(cfg, id);
      if (inp) {
        icon = ICONS[inp.kind] || ICONS.rain;
        title = esc(inp.name || id);
        body = this._sensorDetails(cfg, id, inp);
      }
    }
    return `<div class="overlay" data-closedetails>
      <div class="modal" data-stop-prop>
        <div class="modalhead"><h2><ha-icon class="ico" icon="${icon}"></ha-icon> ${title}</h2>
          <button class="btn ghost" data-closedetails>✕</button></div>
        ${body}
      </div></div>`;
  }

  _kv(rows) {
    return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  _lineDetails(cfg, ln) {
    const out = this._output(cfg, ln.valve_output);
    const src = (cfg.sources || {})[ln.source_id];
    const sensor = this._inputOf(cfg, ln.sensor_input);
    const es = out && out.emergency_shutdown_min
      ? fmtMinutes(out.emergency_shutdown_min) : t("common.off");
    return this._kv([
      [t("card.detail.controller_valve"), esc(this._valveLabel(cfg, ln))],
      [t("card.detail.switch_entity"), esc(out && out.entity ? out.entity : "—")],
      [t("card.detail.source"), src ? esc(src.name) : t("card.detail.no_source")],
      [t("card.detail.emergency_stop"), esc(es)],
      [t("card.detail.automatic"), t(ln.automatic ? "common.on" : "common.off")],
      [t("card.detail.sensor"), sensor
        ? `${esc(sensor.name)}${ln.sensor_override ? ` · ${esc(t("card.detail.override"))}` : ""}`
        : t("card.detail.none")],
      [t("card.label.next"), fmtNext(this._val(ln.id, "next_run"))],
    ]);
  }

  // Raw reading below the first / above the last calibration point (FR-S5c). The
  // level then sticks to that endpoint — runs log 0 L and the min-fill gate is blind.
  _rangeWarn(cfg, s) {
    if (s.type !== "cistern" || this._isSourceDisabled(cfg, s)) return null;
    const side = this._val(s.id, "level_range");
    if (side !== "below" && side !== "above") return null;
    const below = side === "below";
    return {
      side,
      chip: t(below ? "common.calib.chip_below" : "common.calib.chip_above"),
      text: t(below ? "card.calib.text_below" : "card.calib.text_above"),
    };
  }

  _sourceDetails(cfg, s) {
    if (s.type === "cistern") {
      const pump = this._output(cfg, s.pump_output);
      const level = this._val(s.id, "level");
      const pct = this._val(s.id, "level_pct");
      const rw = this._rangeWarn(cfg, s);
      // Open HA's native more-info dialog (with its history graph) on the level
      // sensor — no need to add the entity to the dashboard separately.
      const ent = this._entityId(s.id, "level");
      const histBtn = ent
        ? `<button class="btn ghost histbtn" data-moreinfo="${esc(ent)}"><ha-icon icon="mdi:chart-line"></ha-icon> ${esc(t("card.detail.level_history"))}</button>`
        : "";
      return (rw ? `<div class="faultbox">${esc(rw.chip)} — ${esc(rw.text)}</div>` : "")
        + this._kv([
          [t("card.detail.type"), t(`enum.source_type.${s.type}`)],
          [t("card.detail.level"), `${level != null ? vol(level) : "—"}${pct != null ? ` (${fmtNum(pct)} %)` : ""}`],
          [t("card.detail.max_volume"), s.max_volume_l ? vol(s.max_volume_l) : "—"],
          [t("card.detail.min_fill"), `${fmtNum(s.min_fill_pct || 0)} %`],
          [t("card.detail.pump"), pump ? esc(pump.name) : "—"],
          [t("card.detail.settle_time"), fmtMinutes(s.tank_settle_min || 0)],
        ]) + histBtn;
    }
    return this._kv([
      [t("card.detail.type"), t(`enum.source_type.${s.type}`)],
      [t("card.detail.factor"), t("card.detail.factor_value", { v: fmtNum(s.pulse_factor) })],
    ]);
  }

  // Resolve one of our own read-only sensors to its HA entity_id via the device
  // registry: the source/line/sensor is its own HA device (identifier
  // `(gardenesp, obj_id)`), the entity carries our `translation_key`. Avoids
  // guessing the (name-derived, frozen) entity_id. Returns null if unresolved.
  _entityId(objId, transKey) {
    const H = this._hass;
    if (!H || !H.devices || !H.entities) return null;
    let devId = null;
    for (const d of Object.values(H.devices)) {
      if ((d.identifiers || []).some((idf) => idf[0] === "gardenesp" && idf[1] === objId)) { devId = d.id; break; }
    }
    if (!devId) return null;
    for (const e of Object.values(H.entities)) {
      if (e.device_id === devId && e.platform === "gardenesp" && e.translation_key === transKey) return e.entity_id;
    }
    return null;
  }

  // FR-D3b: read-only calibration curve — polyline through the table points (or
  // the linear-shortcut segment when <2 points), with the current raw reading as
  // the live working point.
  _sensorDetails(cfg, ref, inp) {
    const box = (cfg.boxes || {})[ref.split("#")[0]];
    const used = Object.values(cfg.lines || {})
      .filter((ln) => ln.sensor_input === ref)
      .map((ln) => esc(ln.name || ln.id));
    return this._kv([
      [t("card.detail.kind"), SENSOR_KINDS.includes(inp.kind) ? t(`card.sensor_kind.${inp.kind}`) : inp.kind],
      [t("card.detail.controller"), esc(box ? box.name : "—")],
      [t("card.detail.entity"), esc(inp.entity || "—")],
      inp.kind === "soil_moisture"
        ? [t("card.detail.threshold"), `${fmtNum(inp.threshold_pct || 0)} %`]
        : [t("card.detail.inverted"), t(inp.inverted ? "card.detail.inverted_yes" : "card.detail.inverted_no")],
      [t("card.detail.assigned_to"), used.length ? used.join(" · ") : "—"],
    ]);
  }

  _lastFor(lineId) {
    return this._history.find((e) => e.line_id === lineId) || null;
  }
  // Most recent disturbance (Störung) for a line, still standing — i.e. no clean
  // ``completed`` run has happened since (CR-0011). History is newest-first.
  _faultFor(lineId) {
    for (const e of this._history) {
      if (e.line_id !== lineId) continue;
      if (e.result === "completed") return null; // a clean run clears the Störung
      // A manual run that actually watered also clears it: the user has since
      // intervened on this line, so the old disturbance is moot (CR-0011 follow-up).
      if (e.trigger === "manual" && !FAULT_RESULTS.has(e.result) && e.duration_min > 0) return null;
      if (FAULT_RESULTS.has(e.result)) return e;
    }
    return null;
  }
  // Störung marker appended inline to the Letzte/Nächste line (empty if none
  // standing): the date/time already shows in "Letzte", so we only flag the
  // disturbance with a yellow icon + reason (CR-0011).
  _faultLine(lineId, status) {
    // While the line is actively watering (or settling), the in-flight run is
    // resolving the disturbance — don't flag the stale Störung (CR-0011 follow-up).
    if (status === "active" || status === "settling") return "";
    const f = this._faultFor(lineId);
    if (!f) return "";
    const label = resultLabel(f.result);
    return ` <span class="fault">⚠ ${esc(label)}</span>`;
  }
  _lineName(lineId) {
    const ln = (this._cfg().lines || {})[lineId];
    return ln ? ln.name || lineId : lineId || "—";
  }
  // Kumulierte Verbrauchssummen (Liter) je Zeitfenster über die History — gezeigt
  // oberhalb der „Verlauf"-Tabelle, für Quelle (filter source_id) wie Linie (line_id).
  // Hinweis: die History ist rollierend getrimmt (history_months) → „Vorjahr" reicht nur
  // so weit zurück, wie das Aufbewahrungsfenster es hergibt.
  _consumptionSummary(filterFn) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const pm = m === 0 ? 11 : m - 1; // Vormonat (Jan → Dez Vorjahr)
    const pmy = m === 0 ? y - 1 : y;
    let day = 0, month = 0, prevMonth = 0, year = 0, prevYear = 0, any = false;
    for (const e of this._history) {
      if (!filterFn(e) || e.liters == null) continue;
      // `ts`, not `t` — the module-level t() translator must not be shadowed.
      const ts = new Date(e.start);
      if (isNaN(ts)) continue;
      any = true;
      const L = Number(e.liters) || 0;
      if (ts.getFullYear() === y) {
        year += L;
        if (ts.getMonth() === m) { month += L; if (ts.getDate() === d) day += L; }
      } else if (ts.getFullYear() === y - 1) {
        prevYear += L;
      }
      if (ts.getFullYear() === pmy && ts.getMonth() === pm) prevMonth += L;
    }
    if (!any) return "";
    // > 1000 L → m³ in the summary (the Verlauf table below stays in liters).
    const cell = (key, v) => `<div class="sum"><span class="sl">${esc(t(key))}</span><span class="sv">${esc(fmtVol(v))}</span></div>`;
    return `<h3>${esc(t("card.consumption.title"))}</h3><div class="sums">${
      cell("card.period.today", day) + cell("card.period.month", month) + cell("card.period.prev_month", prevMonth) +
      cell("card.period.year", year) + cell("card.period.prev_year", prevYear)}</div>`;
  }

  // Per-source Verlauf (same log, filtered by source_id) — like the line history,
  // but with the drawing line instead of the trigger (FR-D6 / Quellen-History).
  _sourceHistoryTable(sourceId) {
    const entries = this._history.filter((e) => e.source_id === sourceId).slice(0, 20);
    if (!entries.length)
      return `<h3>${esc(t("card.history.title"))}</h3><div class="empty">${esc(t("card.history.empty"))}</div>`;
    const rows = entries
      .map(
        (e) => `<tr${FAULT_RESULTS.has(e.result) ? ' class="fault"' : ""}><td>${esc(fmtDateTime(e.start))}</td><td>${esc(this._lineName(e.line_id))}</td>
          <td>${fmtDur(e.duration_min)}</td>
          <td>${e.liters != null ? (e.approx ? "~" : "") + vol(e.liters) : "—"}</td>
          <td>${esc(resultLabel(e.result))}</td></tr>`
      )
      .join("");
    return `<h3>${esc(t("card.history.title"))}</h3><table class="hist"><thead>
      <tr><th>${esc(t("card.history.col_datetime"))}</th><th>${esc(t("card.history.col_line"))}</th>
      <th>${esc(t("card.history.col_duration"))}</th><th>${esc(t("card.history.col_volume"))}</th>
      <th>${esc(t("card.history.col_result"))}</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  _historyTable(lineId) {
    const entries = this._history.filter((e) => e.line_id === lineId).slice(0, 20);
    if (!entries.length) return `<div class="empty">${esc(t("card.history.empty"))}</div>`;
    const rows = entries
      .map(
        (e) => `<tr${FAULT_RESULTS.has(e.result) ? ' class="fault"' : ""}><td>${esc(fmtDateTime(e.start))}</td><td>${fmtDur(e.duration_min)}</td>
          <td>${e.liters != null ? (e.approx ? "~" : "") + vol(e.liters) : "—"}</td>
          <td>${esc(triggerLabel(e.trigger))}</td>
          <td>${esc(resultLabel(e.result))}</td></tr>`
      )
      .join("");
    return `<h3>${esc(t("card.history.title"))}</h3><table class="hist"><thead>
      <tr><th>${esc(t("card.history.col_datetime"))}</th><th>${esc(t("card.history.col_duration"))}</th>
      <th>${esc(t("card.history.col_volume"))}</th><th>${esc(t("card.history.col_trigger"))}</th>
      <th>${esc(t("card.history.col_result"))}</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  _updateCountdown() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll("[data-until]").forEach((el) => {
      el.textContent = fmtRemaining(el.dataset.until);
    });
    this.shadowRoot.querySelectorAll("[data-since]").forEach((el) => {
      el.textContent = fmtElapsed(el.dataset.since);
    });
  }

  // --- event binding ---------------------------------------------------------
  _bind() {
    const card = this.shadowRoot.getElementById("card");
    const on = (sel, fn) => card.querySelectorAll(sel).forEach((el) => (el.onclick = fn));

    // Action area swallows clicks so they don't bubble up to the row's Details handler.
    card.querySelectorAll(".acts").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));

    // Remember this dashboard so the panel's "← Dashboard" returns here reliably
    // (history.back() is unpredictable — the panel may be opened from the sidebar too).
    on(".open", () => {
      try { sessionStorage.setItem("gardenesp:return", location.pathname + location.search); } catch (e) { /* private mode */ }
    });

    on("[data-stop]", (e) =>
      this._action({ type: "gardenesp/line/stop", line_id: e.currentTarget.dataset.stop }, t("card.action.stop")));
    on("[data-manual]", (e) => {
      const el = e.currentTarget;
      const ln = (this._cfg().lines || {})[el.dataset.manual] || {};
      this._inline = { kind: "line", id: el.dataset.manual, min: ln.manual_default_min || 10, force: !!el.dataset.force };
      this._render();
    });
    on("[data-cancelinline]", () => {
      this._inline = null;
      this._render();
    });
    // Mirror every keystroke into state so the periodic poll re-render keeps the
    // user's typed duration instead of snapping it back to the preset.
    const mininput = card.querySelector("[data-mininput]");
    if (mininput) mininput.addEventListener("input", (e) => { if (this._inline) this._inline.raw = e.target.value; });
    on("[data-go]", () => {
      const input = card.querySelector("[data-mininput]");
      const parsed = parseDurInput(input && input.value);
      const min = parsed > 0 ? parsed : this._inline.min; // empty/invalid → keep default
      const inl = this._inline;
      this._inline = null;
      this._action(
        { type: "gardenesp/line/start", line_id: inl.id, duration_min: min, force: !!inl.force },
        t("card.action.start")
      );
    });
    on("[data-rowdetails]", (e) => {
      const [kind, id] = e.currentTarget.dataset.rowdetails.split(":");
      this._details = { kind, id };
      this._render();
    });
    on("[data-closedetails]", () => {
      this._details = null;
      this._render();
    });
    on("[data-moreinfo]", (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: e.currentTarget.dataset.moreinfo },
        bubbles: true,
        composed: true,
      }));
    });
    const stop = card.querySelector("[data-stop-prop]");
    if (stop) stop.onclick = (e) => e.stopPropagation();
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  static getConfigElement() {
    return document.createElement("div");
  }
  static getStubConfig() {
    return { title: APP_NAME };
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Turn any thrown/rejected value into a readable message — never "[object
// Object]". HA rejects WS calls with {code,message} on command errors and with a
// bare numeric code (home-assistant-js-websocket) when the connection drops, which
// happens routinely when the iOS app is backgrounded.
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
// Volume for the consumption summary. Metric: liters, switching to m³ above
// 1000 L. US customary: gallons (`hass.config.unit_system`, FR-I1 (e)) — stored
// and computed values stay metric, only this display converts.
function fmtVol(liters) {
  const v = Number(liters) || 0;
  if (!_fmt.us && v >= 1000)
    return `${fmtNum(v / 1000, { maximumFractionDigits: 2 })} ${t("unit.cubic_meters")}`;
  return vol(v);
}
// Run duration: seconds below 1 min (so a quickly stopped run isn't shown as 0 min).
function fmtDur(min) {
  if (min == null) return "—";
  const m = Number(min);
  if (m < 1) return `${fmtNum(Math.round(m * 60))} ${t("unit.seconds")}`;
  return fmtMinutes(Math.round(m * 10) / 10);
}
// Minutes with their unit — used for durations and for the config values in the
// details overlay (emergency stop, settle time).
function fmtMinutes(min) {
  return `${fmtNum(min, { maximumFractionDigits: 1 })} ${t("unit.minutes")}`;
}
// Manual-start timer entry: fractional minutes ⇄ editable "m:ss"-or-minutes text.
// Plain number = minutes (Standardfall); "0:18" = 18 s (Gießkanne füllen).
function fmtDurInput(min) {
  if (min == null || min === "") return "";
  const totalSec = Math.round(Number(min) * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? String(m) : `${m}:${String(s).padStart(2, "0")}`;
}
function parseDurInput(str) {
  // `raw`, not `t` — the module-level t() translator must not be shadowed. The
  // minutes branch goes through parseNum() so a locale decimal comma works too.
  const raw = String(str == null ? "" : str).trim();
  if (raw === "") return 0;
  if (raw.includes(":")) {
    const [mm, ss] = raw.split(":");
    return (parseInt(mm, 10) || 0) + (parseInt(ss, 10) || 0) / 60;
  }
  return parseNum(raw) || 0;
}
function clampPct(p) {
  return Math.max(0, Math.min(100, Number(p) || 0));
}
const GC_PIN_LABEL = {
  A0: "IN1", A1: "IN2", GPIO14: "BIN1", GPIO16: "BIN2", GPIO17: "BIN3",
  GPIO32: "ADC1", GPIO33: "ADC2", GPIO34: "ADC3", GPIO35: "ADC4",
};
function shortPin(pin, box) {
  // GardenControl → board terminal label (BIN/ADC/IN); else drop "GPIO" prefix.
  if (box && box.hw_type === "gardencontrol" && GC_PIN_LABEL[pin]) return GC_PIN_LABEL[pin];
  const p = String(pin == null ? "" : pin);
  return p.startsWith("GPIO") ? p.slice(4) : p;
}
function fmtNext(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return fmtDateParts(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return fmtDateParts(d, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtLast(e, omitResult) {
  const when = fmtDateTime(e.start);
  // A run that actually watered always shows its time + consumption, regardless
  // of how it ended (stopped/emergency/interrupted included) — the *reason* is
  // carried by the yellow Störung marker, not repeated here (CR-0011).
  const parts = [];
  if (e.duration_min != null && e.duration_min > 0) parts.push(fmtDur(e.duration_min));
  if (e.liters != null) parts.push(`${e.approx ? "~" : ""}${vol(e.liters)}`);
  if (parts.length) return `${when} · ${parts.join("/")}`;
  // No watering recorded (instant skip). Show the reason label unless the yellow
  // fault marker already carries it (omitResult).
  if (!omitResult && e.result && e.result !== "completed") return `${when} · ${resultLabel(e.result)}`;
  return when;
}
function fmtRemaining(untilIso) {
  // Remaining run time (countdown), clamped at 0.
  if (!untilIso) return "00:00:00";
  const until = new Date(untilIso).getTime();
  if (isNaN(until)) return "00:00:00";
  return _hms(Math.max(0, Math.round((until - Date.now()) / 1000)));
}
function fmtElapsed(sinceIso) {
  // Elapsed run time (count-up) for Dauerbetrieb controls without a fixed end.
  if (!sinceIso) return "00:00:00";
  const since = new Date(sinceIso).getTime();
  if (isNaN(since)) return "00:00:00";
  return _hms(Math.max(0, Math.round((Date.now() - since) / 1000)));
}
function _hms(total) {
  let s = total;
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  s %= 3600;
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

const CSS = `
/* Brand green (= brand/icon.png), deliberately not the theme --primary-color. */
ha-card { padding: 12px 14px; position: relative;
  border: 1px solid #43A047; --ha-card-border-color: #43A047; }
.hd { font-size: 16px; font-weight: 500; color: #fff; margin-bottom: 8px;
  display: flex; align-items: center; justify-content: space-between;
  background: #43A047; padding: 6px 10px; border-radius: 8px; }
.ttl { display: inline-flex; align-items: center; gap: 6px; }
.hd ha-icon { --mdc-icon-size: 20px; color: #fff; }
.open { text-decoration: none; font-size: 18px; color: #fff; }
.grouphd { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  color: var(--secondary-text-color); margin: 12px 0 2px; padding-top: 8px;
  border-top: 1px solid var(--divider-color, #eee); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center;
  column-gap: 10px; padding: 8px 0; border-top: 1px solid var(--divider-color, #eee); }
.row:first-of-type { border-top: none; }
.row.clickable { cursor: pointer; }
.row.clickable:hover { background: var(--secondary-background-color); }
.ico { --mdc-icon-size: 22px; color: var(--primary-color); }
.grow { min-width: 0; }
.t { display: flex; align-items: center; gap: 6px; min-width: 0; }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto;
  color: var(--primary-text-color); font-weight: 500; }
.t .badge, .t .tag { flex: 0 0 auto; }
.s { color: var(--secondary-text-color); font-size: 12px; margin-top: 1px; }
/* Störung (System A · Achtung) — CR-0011: disturbance line + flagged history rows. */
.s .fault { color: var(--warning-color, #ff9800); font-weight: 500; white-space: nowrap; }
table.hist tr.fault td { color: var(--warning-color, #ff9800); }
.warnText { color: var(--info-color, #2196f3); }
.rgt { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; text-align: right; }
.acts { display: inline-flex; align-items: center; gap: 6px; }
/* Inline timer open → break it onto its own full-width line so the content column
   keeps its width and the Letzte/Nächste text stops wrapping one word per line. */
.acts.full { grid-column: 1 / -1; justify-content: flex-start; margin-top: 6px; padding-left: 32px; }
.acts.full .timer { flex-wrap: wrap; }
/* Visible 44px circular button + a pseudo-element that extends the *touch* target
   ~6px beyond the visual bounds (::after). The tinted circle gives an affordance
   (the bare 22px glyph was easy to miss) and the overlay captures near-misses —
   independent of how flex/grid sizes the transparent box. Apple HIG ≥44px. */
.iconbtn { border: none; cursor: pointer; padding: 0; border-radius: 50%; position: relative;
  width: 44px; height: 44px; min-width: 44px; min-height: 44px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--secondary-background-color); -webkit-tap-highlight-color: transparent; }
.iconbtn::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; }
.iconbtn ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
.iconbtn.primary { background: rgba(67, 160, 71, .16); }
.iconbtn.primary ha-icon { color: var(--primary-color); }
.iconbtn.warn { background: rgba(255, 152, 0, .18); }
.iconbtn.warn ha-icon { color: var(--warning-color, #ff9800); }
.iconbtn.stop { background: rgba(244, 67, 54, .16); }
.iconbtn.stop ha-icon { color: var(--error-color, #f44336); }
.iconbtn:active { filter: brightness(.9); }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.badge.ok { background: var(--success-color, #4caf50); color: #fff; }
.badge.warn { background: var(--warning-color, #ff9800); color: #fff; }
.badge.info { background: var(--info-color, #2196f3); color: #fff; }
.badge.muted { opacity: .7; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; margin-left: 2px;
  background: var(--secondary-background-color); color: var(--secondary-text-color); }
.btn { border: none; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px;
  background: var(--secondary-background-color); color: var(--primary-text-color); }
.btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.btn.warn { background: var(--warning-color, #ff9800); color: #fff; }
.btn.ghost { background: transparent; color: var(--primary-color); }
.btn:hover { filter: brightness(.95); }
.histbtn { display: inline-flex; align-items: center; gap: 6px; padding-left: 0; margin: 2px 0 4px; }
.histbtn ha-icon { --mdc-icon-size: 18px; }
.timer { display: inline-flex; align-items: center; gap: 6px; }
/* font-size must be >=16px: iOS Safari auto-zooms the whole page on focus of any
   smaller input (the HA app disables that, hence "app is fine, only Safari shifts"). */
.mininput { width: 64px; padding: 6px 6px; border-radius: 8px; font-size: 16px;
  border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color); color: var(--primary-text-color); }
.unit { font-size: 12px; color: var(--secondary-text-color); }
.bar { height: 5px; border-radius: 4px; margin-top: 6px; overflow: hidden; background: var(--divider-color, #eee); max-width: 260px; }
.bar > span { display: block; height: 100%; background: var(--primary-color); }
.empty { color: var(--secondary-text-color); padding: 6px 0; }
.empty.err { color: var(--error-color, #f44336); }
.fwbanner { display: block; margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; font-size: 13px;
  text-decoration: none; background: rgba(255, 152, 0, .16); color: var(--warning-color, #e65100); }
.faultbox { margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; line-height: 1.45;
  background: rgba(255, 152, 0, .16); color: var(--warning-color, #e65100); }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex;
  align-items: center; justify-content: center; z-index: 9; }
.modal { background: var(--card-background-color, #fff); color: var(--primary-text-color);
  border-radius: 12px; padding: 16px; width: min(520px, 92vw); max-height: 86vh; overflow: auto;
  box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.modalhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.modalhead h2 { font-size: 16px; margin: 0; display: inline-flex; align-items: center; gap: 6px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0 0 8px; }
.kv dt { color: var(--secondary-text-color); font-size: 13px; }
.kv dd { margin: 0; font-size: 13px; }
.modal h3 { font-size: 14px; margin: 12px 0 6px; }
.sums { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 6px; }
.sum { display: flex; flex-direction: column; text-align: center; min-width: 66px; flex: 1 0 auto;
  border-radius: 7px; overflow: hidden; border: 1px solid var(--divider-color, #eee); }
.sum .sl { font-size: 11px; color: var(--secondary-text-color); background: var(--secondary-background-color);
  padding: 2px 6px; }
.sum .sv { font-size: 14px; font-weight: 600; color: var(--primary-text-color); padding: 3px 6px; white-space: nowrap; }
table.hist { width: 100%; border-collapse: collapse; font-size: 12px; }
table.hist th, table.hist td { text-align: left; padding: 4px 6px; border-top: 1px solid var(--divider-color, #eee); }
table.hist th { color: var(--secondary-text-color); font-weight: 500; }
`;

if (!customElements.get("gardenesp-card")) {
  customElements.define("gardenesp-card", GardenEspCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "gardenesp-card")) {
  // English on purpose: the card picker is evaluated at module load, *before* the
  // element ever sees a `hass` object — there is no language signal here, and
  // guessing from navigator.language would contradict hass.language (§4c).
  window.customCards.push({
    type: "gardenesp-card",
    name: "GardenESP",
    description: "Dashboard: irrigation lines, water sources & sensors — status, control, history.",
  });
}
