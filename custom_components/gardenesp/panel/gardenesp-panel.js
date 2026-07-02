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
 * Labels are German per the project convention; identifiers stay English.
 * Editing is draft-based: `_draft` is a working copy committed only on Save (FR-S4).
 */

const SOURCE_TYPE = { cistern: "Zisterne", mains: "Festwasser" };
const HW_LABEL = { gardencontrol: "GardenControl", esp32_wroom: "ESP32-WROOM" };
// rain/soil are configured as box inputs (no separate sensor object).
const SENSOR_INPUT_KINDS = ["rain", "soil_moisture"];
// Firmware-drift status per box (#9) — keys match coordinator drift.fw_status().
const FW_STATUS = {
  current: { label: "Firmware aktuell", cls: "ok" },
  current_offline: { label: "aktuell (offline)", cls: "" },
  drift: { label: "Flashen ausstehend", cls: "warn" },
  drift_offline: { label: "Flashen ausstehend (offline)", cls: "warn" },
  exported: { label: "YAML exportiert", cls: "" },
  drift_export: { label: "Änderung seit Export", cls: "warn" },
  never: { label: "YAML nie exportiert", cls: "" },
  error: { label: "YAML-Fehler", cls: "estop" },
};
const FW_ATTENTION = ["drift", "drift_offline", "drift_export"];
const OUTPUT_TYPE = { valve: "Ventil", pump: "Pumpe", other: "Sonstiges" };
const INPUT_KIND = {
  pressure: "Drucksensor",
  soil_moisture: "Bodenfeuchte",
  rain: "Regensensor",
  pulse_meter: "Literzähler",
  button: "Taster / Schalter",
};
const BOX_LABELS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)); // A…Z
// Channel inventory per hw_type (drives the A5 id + the ESPHome pin, FDS §4.1/§5.4):
// GardenControl = 12 valve channels + 2 relay channels; ESP32-WROOM = 8 shared GPIO channels.
const CHANNELS = {
  gardencontrol: { valve: Array.from({ length: 12 }, (_, i) => String(i + 1)), pump: ["R1", "R2"] },
  // generic/custom: channel is just the short A5 number; the real pin is `gpio`.
  generic: { valve: Array.from({ length: 24 }, (_, i) => String(i + 1)), pump: Array.from({ length: 24 }, (_, i) => String(i + 1)) },
};
// GardenControl board terminal labels (display only; pin values unchanged).
const GC_PIN_LABEL = {
  A0: "IN1", A1: "IN2",
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
    pressure: ["A0", "A1"], // 2× 4-20 mA (ADS1115)
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
// Keys MUST match schedule.py WEEKDAY_KEYS (mo..su) or weekly never fires.
const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const WEEKDAY_LABEL = { mo: "Mo", tu: "Di", we: "Mi", th: "Do", fr: "Fr", sa: "Sa", su: "So" };
const REPEAT = { daily: "Täglich", weekly: "Wöchentlich", monthly: "Monatlich" };
const ICON = "mdi:sprout"; // shared with sidebar + card (const.py PANEL_ICON)
// Online-Hilfe (GitHub Pages). Single source of truth ist die Doku-Site — das Panel
// verlinkt nur dorthin (Header-„? Hilfe" + Onboarding), statt die Anleitung zu duplizieren.
const DOCS_URL = "https://piep-projects.github.io/GardenESP/";

const TABS = [
  { id: "lines", label: "Linien" },
  { id: "controls", label: "Steuerungen" },
  { id: "sources", label: "Quellen" },
  { id: "boxes", label: "Hardware" },
  { id: "topology", label: "Topologie" },
  { id: "general", label: "Allgemein" },
];

const POLL_MS = 10000;

class GardenEspPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._data = null;
    this._history = []; // irrigation log (for consumption summaries in the overviews)
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
      const [data, hist, topo] = await Promise.all([
        this._ws({ type: "gardenesp/config/get" }),
        this._ws({ type: "gardenesp/history" }),
        this._ws({ type: "gardenesp/topology" }),
      ]);
      this._data = data;
      this._history = (hist && hist.entries) || [];
      this._topology = (topo && topo.strands) || [];
      this._error = null;
    } catch (err) {
      this._error = err && err.message ? err.message : String(err);
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
      this._toast(`${label} fehlgeschlagen: ${err.message || err}`);
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
          this._toast(`Name „${dup}" ist doppelt — Aus-/Eingangsnamen müssen je Steuergerät eindeutig sein.`);
          return;
        }
      }
      await this._ws({ type: "gardenesp/upsert", kind: this._wsKind(this._editing.kind), data: this._draft });
      this._editing = null;
      this._draft = null;
      await this._load();
    } catch (err) {
      this._toast(`Speichern fehlgeschlagen: ${err.message || err}`);
    }
  }

  // A Steuerung is a kind=switch line → it lives in the "line" WS collection.
  _wsKind(kind) {
    return kind === "control" ? "line" : kind;
  }

  async _delete(kind, id) {
    if (!confirm("Wirklich löschen?")) return;
    await this._action({ type: "gardenesp/delete", kind: this._wsKind(kind), obj_id: id }, "Löschen");
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
        calibration_points: [], max_volume_l: 0, min_fill_pct: 0, pump_output: "",
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
    const opts = [["", "— wählen —"]];
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
    const relais = (t) => t === "pump" || t === "other";
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
    const opts = [["", "— Kanal —"]];
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
    const opts = [["", "— Pin —"]];
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
    const opts = [["", "— GPIO —"]];
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
    const opts = `<option value="">— kein —</option>` + others
      .map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? "selected" : ""}>${esc(this._channelLabel(d, x))}</option>`)
      .join("");
    return `<input class="ro" disabled value="${esc(autoLabel)}" title="ConnectedDevice automatisch (Quellen-Pumpe)">
      <select data-conn="${i}" title="zusätzlich schalten (manuell)">${opts}</select>`;
  }
  // Polarity: fixed by the platform for GardenControl (read-only), editable for generic.
  _polaritySelect(d, o, i) {
    if (d.hw_type === "gardencontrol")
      return `<input class="ro" disabled value="aktiv-HIGH" title="durch Plattform vorgegeben">`;
    return select(`outputs.${i}.relais_off`, o.relais_off || "HIGH", [["HIGH", "aktiv-LOW"], ["LOW", "aktiv-HIGH"]]);
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
    if (this._loading) return void (root.innerHTML = `<div class="empty">Lade…</div>`);
    if (this._error)
      return void (root.innerHTML = `<div class="empty err">Fehler: ${esc(this._error)}</div>`);

    let body;
    if (this._editing) body = this._form();
    else body = this._listView(this._view);

    root.innerHTML = `${this._nav()}${body}`;
    if (this._yaml) root.insertAdjacentHTML("beforeend", this._yamlModal());
    if (this._wiring) root.insertAdjacentHTML("beforeend", this._wiringModal());
    this._bind();
  }

  _nav() {
    const tabs = TABS.map(
      (t) => `<button class="tab ${t.id === this._view ? "on" : ""}" data-tab="${t.id}">${t.label}</button>`
    ).join("");
    return `<div class="head"><h1><ha-icon icon="${ICON}"></ha-icon> GardenESP</h1>
      <div class="headbtns">
        <button class="btn ghost" data-act="back" title="Zurück zum Dashboard">← Dashboard</button>
        <button class="btn ghost" data-act="refresh" title="Aktualisieren">⟳</button>
        <a class="btn ghost" href="${DOCS_URL}" target="_blank" rel="noopener" title="Online-Hilfe öffnen">? Hilfe</a>
      </div></div>
      <nav class="tabs">${tabs}${this._fwBanner()}</nav>`;
  }

  // Link to a page of the online docs, styled as a button (opens in a new tab).
  _docsBtn(path, label, cls = "ghost") {
    return `<a class="btn ${cls}" href="${DOCS_URL}${path}" target="_blank" rel="noopener">${label}</a>`;
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
    const intro = `<p class="sub topo-intro">Abgeleitete Sicht (read-only) aus Quellen · Linien · Steuergeräte — kein eigener Speicher. Strecke je Quelle: Steuergerät → Quelle (+Sensor) → Pumpe (+verbundenes Ventil) → Ventil → Linie.</p>`;
    const printBtn = groups.length ? `<button class="btn" data-printtopo>Drucken</button>` : "";
    const head = `<div class="listhead"><h2>Topologie</h2>${printBtn}</div>${intro}`;
    if (!groups.length) return `${head}<div class="empty">Keine Wasserquellen angelegt.</div>`;
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
    const CWT = 7.0, CWM = 6.0, PAD = 9, ROWH = 64, TOP = 28, GAP = 38;

    // --- text-width estimates (no DOM measuring; mirrors the wiring legend) ---
    const idW = (id) => (id ? id.length * 7.2 + 12 : 0);
    const tagW = (t) => (t ? t.length * 5.8 + 14 : 0);
    const titleW = (n) =>
      idW(n.id) + (n.id ? 5 : 0) + (n.text || "").length * CWT + (n.tag ? tagW(n.tag) + 6 : 0);
    const nodeW = (n) => {
      let w = titleW(n);
      (n.meta || []).forEach((m) => { w = Math.max(w, m.length * CWM); });
      return Math.ceil(w + PAD * 2);
    };
    const nodeH = (n) => 18 + 14 * (n.meta || []).length + 14;

    // --- node descriptors per column ----------------------------------------
    const outNode = (o, acc) => {
      if (!o) return { text: "—", meta: [], muted: true };
      const pin = o.gpio || o.channel || "";
      const meta = [];
      if (pin || o.emergency_min) meta.push(`${pin}${o.emergency_min ? ` · ⏱ ${o.emergency_min} min` : ""}`);
      return { id: o.short_id || null, idColor: acc, text: o.name || "", meta };
    };
    const srcNode = (s) => {
      const meta = [s.sensor ? `Sensor: ${s.sensor.name}${s.sensor.pin ? ` · ${s.sensor.pin}` : ""}` : "kein Sensor"];
      if (s.type === "cistern") meta.push(`Max ${s.max_volume_l || "?"} L · Mindest ${s.min_fill_pct || 0} %`);
      return { text: s.name, tag: SOURCE_TYPE[s.type] || s.type || "", meta };
    };
    const pumpNode = (p) => {
      if (!p) return { text: "keine Pumpe", meta: ["Druck/Schwerkraft"], muted: true };
      const n = outNode(p, ACC.pump);
      (p.connected || []).forEach((c) => n.meta.push(`↳ ${c.short_id ? c.short_id + " " : ""}${c.name}`));
      return n;
    };
    const lineNode = (ln) => {
      if (!ln || !ln.id) return { text: "keine Linie", meta: [], muted: true };
      return {
        id: ln.line_id || null, idColor: ACC.line, text: ln.name || "",
        tag: ln.automatic ? null : "Auto aus",
        meta: [`Automatik: ${ln.automatic ? "ein" : "aus"}${ln.sensor_name ? ` · Sperre: ${ln.sensor_name}` : ""}`],
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
    let w1 = 90, w2 = 90, w3 = 90, w4 = 90;
    const w0 = nodeW(boxN);
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
        const tgx = tx + (n.text || "").length * CWT + 6, tgw = tagW(n.tag);
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
    const heads = [["Steuergerät", x0, w0], ["Quelle", x1, w1], ["Pumpe", x2, w2], ["Ventil", x3, w3], ["Linie", x4, w4]];
    let svg = heads.map(([t, x, w]) => `<text x="${(x + w / 2).toFixed(1)}" y="13" class="tn-h" text-anchor="middle">${t}</text>`).join("");

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
    if (!win) { this._toast("Pop-up blockiert — Druck nicht möglich."); return; }
    const cfg = this._cfg();
    const body = groups
      .map((g) => {
        const box = (cfg.boxes || {})[g.box_id];
        const cap = `${g.label ? g.label + " · " : ""}${box ? box.name : g.box_id}`;
        return `<h2>${esc(cap)}</h2>${this._topoSvg(g, box, box ? (HW_LABEL[box.hw_type] || box.hw_type) : "")}`;
      })
      .join("");
    win.document.write(`<!doctype html><html><head><title>Topologie</title>
      <style>${this._topoStyle()} body{margin:16px;font-family:sans-serif}h1{font-size:16px}
      h2{font-size:13px;margin:16px 0 4px;color:#444}.toposvg{page-break-inside:avoid}</style></head><body>
      <h1>GardenESP — Topologie</h1>
      ${body}
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  }
  // Topology SVG node/connector styling — embedded in the print window (hardcoded
  // colours so it renders without the panel theme vars; mirrors the .toposvg rules).
  _topoStyle() {
    return `.toposvg{display:block;width:100%;height:auto;font-family:sans-serif}
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
      <button class="btn primary" data-add="${kind}">+ Neu</button></div>`;
  }

  _linesList(cfg) {
    const lines = Object.values(cfg.lines || {}).filter((ln) => ln.kind !== "switch");
    const body = lines.length
      ? lines.map((ln) => {
          const box = (cfg.boxes || {})[ln.box_id];
          const src = (cfg.sources || {})[ln.source_id];
          return `<div class="row"><div class="grow">
            <div class="title"><span class="chip">${esc(this._lineId(cfg, ln))}</span> ${esc(ln.name || ln.id)} ${this._autoChip(ln)}</div>
            <div class="sub">${box ? esc(box.name) : "keine Box"} · ${src ? esc(src.name) : "ohne Quelle"}</div>
            <div class="schedchips">${this._scheduleChips(ln)}</div>
            ${this._stamps(ln)}
            ${this._idLine(ln.id)}
            ${this._consumptionSummary((e) => e.line_id === ln.id)}</div>
            ${this._autoToggle(ln)}
            <button class="btn" data-editline="${esc(ln.id)}">Bearbeiten</button></div>`;
        }).join("")
      : Object.keys(cfg.boxes || {}).length
        ? `<div class="empty">Noch keine Linien. „+ Neu" ordnet einem Ventil-Ausgang eine Linie zu.</div>`
        : `<div class="empty">Noch keine Linien — lege zuerst im Tab „Hardware" ein Steuergerät an. ${this._docsBtn("erste-box/", "📖 Erste Schritte")}</div>`;
    return this._listHeader("Bewässerungslinien", "line") + `<section class="cardbox">${body}</section>`;
  }

  // Steuerungen = kind=switch lines (fountain, camera, …); same store, own tab (FR-SW1).
  _controlsList(cfg) {
    const ctrls = Object.values(cfg.lines || {}).filter((ln) => ln.kind === "switch");
    const body = ctrls.length
      ? ctrls.map((ln) => {
          const box = (cfg.boxes || {})[ln.box_id];
          const out = this._outputName(cfg, ln.box_id, ln.valve_output);
          const dash = ln.show_on_dashboard !== false
            ? `<span class="chip ok">Dashboard</span>`
            : `<span class="chip">nicht im Dashboard</span>`;
          return `<div class="row"><div class="grow">
            <div class="title">${esc(ln.name || ln.id)} ${this._autoChip(ln)} ${dash}</div>
            <div class="sub">${box ? esc(box.name) : "keine Box"} · ${out ? esc(out) : "kein Ausgang"}</div>
            ${this._controlEntity(ln)}
            <div class="schedchips">${this._scheduleChips(ln)}</div>
            ${this._stamps(ln)}
            ${this._idLine(ln.id)}</div>
            ${this._autoToggle(ln)}
            <button class="btn" data-editcontrol="${esc(ln.id)}">Bearbeiten</button></div>`;
        }).join("")
      : `<div class="empty">Noch keine Steuerungen. „+ Neu" legt einen schaltbaren Ausgang an (Springbrunnen, Kamera …).</div>`;
    return this._listHeader("Steuerungen", "control") + `<section class="cardbox">${body}</section>`;
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
    return `<div class="srcents"><span class="srcent"><span class="cl">Ausgang</span> ` +
      `<span class="ent">${eid ? esc(eid) : "—"}</span></span></div>`;
  }

  _sourcesList(cfg) {
    const sources = Object.values(cfg.sources || {});
    const body = sources.length
      ? sources.map((s) => `<div class="row"><div class="grow">
          <div class="title">${esc(s.name || s.id)}<span class="tag muted">${SOURCE_TYPE[s.type] || s.type}</span>${this._sourceDisabled(s) ? `<span class="chip estop">Steuergerät deaktiviert</span>` : ""}</div>
          <div class="sub">${s.type === "cistern" ? `Max ${s.max_volume_l || "?"} L · min ${s.min_fill_pct || 0} %` : `${s.pulse_factor} L/Impuls`}${this._sourceLevel(s)}</div>
          ${this._sourceEntities(s)}
          ${this._stamps(s)}
          ${this._consumptionSummary((e) => e.source_id === s.id)}</div>
          <button class="btn" data-editsource="${esc(s.id)}">Bearbeiten</button></div>`).join("")
      : `<div class="empty">Noch keine Quellen.</div>`;
    return this._listHeader("Wasserquellen", "source") + `<section class="cardbox">${body}</section>`;
  }
  // A source follows its hardware: out of service if any referenced box
  // (Pegel-Sensor / Zähler / Pumpe) is deactivated.
  _sourceDisabled(s) {
    const boxes = this._cfg().boxes || {};
    return [s.level_input, s.meter_input, s.pump_output]
      .filter((r) => r && r.includes("#"))
      .some((r) => { const b = boxes[r.split("#")[0]]; return b && b.enabled === false; });
  }
  // Resolve a "{box_id}#{input_id}" ref to its Input object (for live meter reads).
  _inputByRef(ref) {
    if (!ref || !ref.includes("#")) return null;
    const [boxId, local] = ref.split("#");
    const box = (this._cfg().boxes || {})[boxId];
    return box ? (box.inputs || []).find((i) => i.id === local) || null : null;
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
      return `<span class="srcval ${low ? "low" : ""}">${esc(Math.round(level))} L${low ? " ⚠" : ""}</span>`;
    }
    const inp = this._inputByRef(s.meter_input);
    const st = inp && this._entityState(inp.entity);
    const liters = st ? parseFloat(st.state) : NaN;
    if (isNaN(liters)) return "";
    return `<span class="srcval">${esc(Math.round(liters * (s.pulse_factor || 1)))} L</span>`;
  }

  _fmtStamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
  }
  _stamps(o) {
    if (!o.created_at && !o.updated_at) return "";
    return `<div class="boxstamp">Erstellt: ${esc(this._fmtStamp(o.created_at))}` +
      ` · Letzte Änderung: ${esc(this._fmtStamp(o.updated_at))}</div>`;
  }
  // Raw storage id — needed for the gardenesp.start_line / stop_line services
  // (own irrigation logic from HA automations, FR-X3b).
  _idLine(id) {
    return `<div class="objid">ID (für Dienst): <code>${esc(id)}</code></div>`;
  }
  // Consumption period-sums (liters) from the history — same buckets as the Card
  // detail view (Heute · Monat · Vormonat · Jahr · Vorjahr); shown under the stamps
  // in the Quellen/Linien overviews (per source_id / line_id). Empty when no data.
  _consumptionSummary(filterFn) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const pm = m === 0 ? 11 : m - 1, pmy = m === 0 ? y - 1 : y; // Vormonat
    let day = 0, month = 0, prevMonth = 0, year = 0, prevYear = 0, any = false;
    for (const e of this._history) {
      if (!filterFn(e) || e.liters == null) continue;
      const t = new Date(e.start);
      if (isNaN(t)) continue;
      any = true;
      const L = Number(e.liters) || 0;
      if (t.getFullYear() === y) {
        year += L;
        if (t.getMonth() === m) { month += L; if (t.getDate() === d) day += L; }
      } else if (t.getFullYear() === y - 1) {
        prevYear += L;
      }
      if (t.getFullYear() === pmy && t.getMonth() === pm) prevMonth += L;
    }
    if (!any) return "";
    const cell = (label, v) => `<span class="csum"><span class="cl">${esc(label)}</span> ${esc(fmtVol(v))}</span>`;
    return `<div class="consum"><span class="chead">Verbrauch</span>${
      cell("Heute", day) + cell("Monat", month) + cell("Vormonat", prevMonth) +
      cell("Jahr", year) + cell("Vorjahr", prevYear)}</div>`;
  }
  // Resolved HA entity_ids of a source's referenced box in-/outputs (FR-X1): the
  // level/meter sensor and the pump switch — shown read-only in the Quellen overview.
  _sourceEntities(s) {
    const rows = [];
    const inRef = s.type === "cistern" ? s.level_input : s.meter_input;
    const inp = this._inputByRef(inRef);
    const inLabel = s.type === "cistern" ? "Pegel" : "Zähler";
    if (inRef) rows.push([inLabel, inp && inp.entity]);
    if (s.pump_output) {
      const out = this._outputByRef(s.pump_output);
      rows.push(["Pumpe", out && out.entity]);
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
    if (md > limit) bad.push(`manuell ${fmtDur(md)}`);
    (d.schedule || []).forEach((e) => {
      if (e.enabled === false) return;
      const dm = Number(e.duration_min) || 0;
      if (dm > limit) bad.push(`Zeitplan ${e.time || "—"} ${fmtDur(dm)}`);
    });
    if (!bad.length) return "";
    return `<div class="formwarn">⚠ <b>Laufzeit kollidiert mit der Notabschaltung.</b> ` +
      `Das Ventil „${esc(out.name || out.id)}“ schaltet nach <b>${emerg} min</b> per Notabschaltung ab. ` +
      `Diese Dauer(n) lassen unter 1 min Reserve (> ${limit} min) und werden als „Notabschaltung“ geloggt: ` +
      `<b>${esc(bad.join(", "))}</b>. Dauer unter ${limit} min setzen oder die Notabschaltung des ` +
      `Ausgangs im Steuergerät-Editor erhöhen.</div>`;
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
      ? `<span class="chip ok">Automatik ein</span>`
      : `<span class="chip estop">Automatik aus</span>`;
  }
  // Interactive on/off switch at the row's right end — toggles `automatic` and
  // persists immediately (no need to open the editor).
  _autoToggle(ln) {
    return `<label class="lineauto ${ln.automatic ? "on" : "off"}" title="Automatik ein/aus">
      <input type="checkbox" data-toggleauto="${esc(ln.id)}" ${ln.automatic ? "checked" : ""}>
      <span>Automatik</span></label>`;
  }
  _toggleLineAuto(id, checked) {
    const ln = (this._cfg().lines || {})[id];
    if (!ln) return;
    this._action({ type: "gardenesp/upsert", kind: "line", data: { ...ln, automatic: checked } }, "Automatik");
  }
  // One small chip per schedule entry, each tagged with a coloured aktiv/inaktiv box.
  _scheduleChips(ln) {
    const entries = ln.schedule || [];
    if (!entries.length) return `<span class="muted">kein Zeitplan</span>`;
    return entries.map((e) => {
      const days = e.repeat === "weekly"
        ? (e.weekdays || []).map((w) => WEEKDAY_LABEL[w] || w).join(",")
        : e.repeat === "monthly"
          ? `${(e.monthdays || []).join(",")}.`
          : "tägl.";
      const txt = `${days} ${e.time || "—"} · ${e.duration_min || 0}′`;
      const active = e.enabled !== false;
      const state = `<span class="schedstate ${active ? "on" : "off"}">${active ? "aktiv" : "inaktiv"}</span>`;
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
              <div class="title">Steuergerät ${b.label ? `<span class="chip">${esc(String(b.label).toUpperCase())}</span> ` : ""}${esc(b.name || b.id)}</div>
              <div class="headacts">
                <button class="btn" data-editbox="${esc(b.id)}">Bearbeiten</button>
                ${admin ? `<button class="btn ghost" data-yaml="${esc(b.id)}" title="ESPHome-YAML (Admin)">🔒 YAML</button>` : ""}
              </div>
            </div>
            <div class="zone">
              <div class="zonebody">
                <div class="zonestat">${this._boxEnabledToggle(b)}<span class="muted">${valves} Ventile · ${pumps} Pumpen · ${(b.inputs || []).length} Eingänge</span></div>
                ${this._stamps(b)}
              </div>
            </div>
            <div class="zone">
              <div class="zonelabel"><ha-icon icon="mdi:chip"></ha-icon> ${esc(this._platformName(b.hw_type))}
                <button class="btn ghost wirebtn" data-wiring="${esc(b.id)}" title="Verdrahtung anzeigen">🔌 Verdrahtung</button></div>
              <div class="zonebody">
                <div class="zonestat">${this._onlineChip(b)}${this._fwChip(b)}</div>
                ${this._boxDeviceMeta(b)}
                ${this._boxDiag(b)}
                ${outs ? `<div class="grouplabel">Ausgänge</div>${outs}` : ""}
                ${ins ? `<div class="grouplabel">Eingänge</div>${ins}` : ""}
              </div>
            </div>
          </div>`;
        }).join("")
      : `<div class="empty onboard">
          <p><strong>Willkommen bei GardenESP 🌱</strong></p>
          <p>Lege zuerst ein <strong>Steuergerät</strong> (deinen ESP-Controller) mit seinen Ein-/Ausgängen an,
             generiere das ESPHome-YAML und flashe es. Die Schritt-für-Schritt-Anleitung inkl. erstem
             Flash steht in der Online-Hilfe.</p>
          <p>${this._docsBtn("erste-box/", "📖 Anleitung: Erstes Steuergerät & Flash", "primary")}</p>
        </div>`;
    return this._listHeader("", "box") +
      `<section class="cardbox boxlist">${body}</section>`;
  }
  // --- System A status chips (style-guide §3.1) ------------------------------
  // Board reachability — context-dependent severity: Offline is red only when the
  // box should be running (Steuerung in Betrieb), else neutral grey; no device = gelb.
  _onlineChip(b) {
    const online = this._val(b.id, "online");
    if (online === true) return `<span class="chip ok">● Online</span>`;
    if (online == null) return `<span class="chip warn" title="Steuergerät ist in HA nicht als ESPHome-Gerät eingebunden">○ kein Gerät</span>`;
    const cls = b.enabled === false ? "" : "estop";
    return `<span class="chip ${cls}">○ Offline</span>`;
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
    const parts = [];
    if (sig != null)
      parts.push(
        `<ha-icon class="diagicon" icon="${this._wifiIcon(sig)}" title="WLAN-Signal"></ha-icon>${Math.round(sig)} dBm`
      );
    if (rt != null || ry != null)
      parts.push(
        `<ha-icon class="diagicon" icon="mdi:restart" title="Neustarts heute / gestern"></ha-icon>heute ${rt ?? "–"} · gestern ${ry ?? "–"}`
      );
    return parts.length ? `<div class="zonemeta diagrow">${parts.join(" · ")}</div>` : "";
  }
  // Firmware-drift status chip per box (#9) — read from the value cache.
  _fwChip(b) {
    if (b.enabled === false) return "";  // außer Betrieb → Firmware irrelevant, keine Warnung
    const st = this._val(b.id, "fw_status");
    if (!st) return "";
    const f = FW_STATUS[st] || { label: st, cls: "" };
    return `<span class="chip ${f.cls}" title="Firmware-Status (Generator-Hash ↔ geflashte Box)">${esc(f.label)}</span>`;
  }
  // Firmware-drift banner in the tab bar (right of the tabs, centered in the
  // remaining space; ellipsized with the full text on hover). Click → Boxen tab (#9d).
  _fwBanner() {
    const names = Object.values(this._cfg().boxes || {})
      .filter((b) => b.enabled !== false && FW_ATTENTION.includes(this._val(b.id, "fw_status")))
      .map((b) => b.label ? `Steuergerät ${String(b.label).toUpperCase()}` : (b.name || b.id));
    if (!names.length) return "";
    const txt = `⚠ Flashen ausstehend: ${names.join(" · ")}`;
    return `<span class="fwslot"><span class="fwbanner" data-tab="boxes" title="${esc(txt)}">${esc(txt)}</span></span>`;
  }
  // Labeled in-service toggle — state + colour + control in one (System A §3.1):
  // grün „In Betrieb" / grau „Außer Betrieb". Replaces a separate state chip.
  _boxEnabledToggle(b) {
    const on = b.enabled !== false;
    return `<label class="boxswitch ${on ? "on" : "off"}" title="In Betrieb / Außer Betrieb umschalten">
      <input type="checkbox" data-toggleboxen="${esc(b.id)}" ${on ? "checked" : ""}>
      <span>${on ? "In Betrieb" : "Außer Betrieb"}</span></label>`;
  }
  _toggleBoxEnabled(id, checked) {
    const b = (this._cfg().boxes || {})[id];
    if (!b) return;
    this._action({ type: "gardenesp/upsert", kind: "box", data: { ...b, enabled: checked } }, "Box");
  }
  _polarityLabel(b, o) {
    if (b.hw_type === "gardencontrol") return "aktiv-HIGH";
    return o.relais_off === "LOW" ? "aktiv-HIGH" : "aktiv-LOW";
  }
  _drivenList(b, o) {
    const out = [];
    if (o.type === "valve") {
      const pump = this._autoPumpOutput(b, o);
      if (pump) out.push({ label: this._channelLabel(b, pump), name: pump.name || pump.id, kind: "auto" });
    }
    for (const cid of o.connected || []) {
      const t = (b.outputs || []).find((x) => x.id === cid);
      if (t) out.push({ label: this._channelLabel(b, t), name: t.name || t.id, kind: "manuell" });
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
      <span class="muted">${esc(OUTPUT_TYPE[o.type] || o.type)}</span>
      ${this._outState(b, o)}
      <span class="ent">${o.entity ? esc(o.entity) : "—"}</span>
      <span class="muted">${esc(this._polarityLabel(b, o))}</span>
      ${o.emergency_shutdown_min ? `<span class="chip estop" title="Emergency Shutdown (Not-Aus)">Not-Aus ${esc(String(o.emergency_shutdown_min))} min</span>` : ""}
    </div>${conn}`;
  }
  _boxInRow(b, inp) {
    let param = "";
    if (inp.kind === "rain") param = inp.inverted ? "Schließer (NO)" : "Öffner (NC)";
    else if (inp.kind === "soil_moisture") param = `Schwelle ${inp.threshold_pct || 0} %`;
    else if (inp.kind === "button" && inp.inverted) param = "invertiert";
    return `<div class="devrow">
      <span class="chip">${esc(this._inputPinLabel(inp.pin, b.hw_type))}</span>
      <span class="dname">${esc(inp.name || inp.id)}</span>
      <span class="muted">${esc(INPUT_KIND[inp.kind] || inp.kind)}</span>
      ${this._inState(b, inp)}
      <span class="ent">${inp.entity ? esc(inp.entity) : "—"}</span>
      ${param ? `<span class="muted">${esc(param)}</span>` : ""}
    </div>`;
  }
  // Live output switch state (on/off) from the resolved ESPHome entity.
  _outState(b, o) {
    if (!b.enabled) return `<span class="live off">deaktiviert</span>`;
    const st = this._entityState(o.entity);
    if (!st) return `<span class="live muted">—</span>`;
    const on = st.state === "on";
    return `<span class="live ${on ? "on" : "off"}" title="aktueller Schaltzustand">${on ? "● an" : "○ aus"}</span>`;
  }
  // Live input value: rain → nass/trocken, sensors → number + unit.
  _inState(b, inp) {
    if (!b.enabled) return `<span class="live muted">deaktiviert</span>`;
    const st = this._entityState(inp.entity);
    if (!st) return `<span class="live muted">—</span>`;
    if (inp.kind === "rain") {
      const wet = st.state === "on";
      return `<span class="live ${wet ? "wet" : ""}" title="aktueller Wert">${wet ? "nass" : "trocken"}</span>`;
    }
    if (inp.kind === "button") {
      const on = st.state === "on";
      return `<span class="live ${on ? "on" : "off"}" title="aktueller Wert">${on ? "● an" : "○ aus"}</span>`;
    }
    const unit = (st.attributes && st.attributes.unit_of_measurement) || "";
    const num = parseFloat(st.state);
    const val = isNaN(num) ? st.state : Math.round(num * 10) / 10;
    return `<span class="live" title="aktueller Wert">${esc(val)}${unit ? " " + esc(unit) : ""}</span>`;
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
              `<button class="btn ghost small" data-sync="${esc(b.id)}">⟳ ${b.label ? `[${esc(String(b.label).toUpperCase())}] ` : ""}${esc(b.name || b.id)} abgleichen</button>`,
          )
          .join(" ")
      : `<span class="sub muted">Noch keine Steuergeräte angelegt.</span>`;
    const builtin = `
      <div class="row"><div class="grow"><div class="title">GardenControl<span class="tag muted">eingebaut</span></div>
        <div class="sub">festes Profil: 12 Ventile (24 VAC) · 2 Relais (R1/R2, 230 V) · 2× 4-20 mA (ADS A0/A1) · 4× ADC 0-12 V · 3× Binär (Regen/S0/Schalter)</div></div></div>
      <div class="row"><div class="grow"><div class="title">ESP32-WROOM<span class="tag muted">eingebaut</span></div>
        <div class="sub">generisch: GPIO je Aus-/Eingang frei zuweisbar</div></div></div>`;
    const customRows = custom
      .map((p, i) => `<div class="subrow">
        <input data-platname="${i}" value="${esc(p.name || "")}" placeholder="Plattform-Name">
        <span class="sub">generisch (freie GPIO)</span>
        <button class="btn danger small" data-delplat="${i}">✕</button></div>`)
      .join("");
    return (
      `<div class="listhead"><h2>Allgemein</h2></div>` +
      `<section class="cardbox">` +
      field("History-Aufbewahrung (Monate, 0 = unbegrenzt)", `<input type="number" min="0" data-setting="history_months" value="${esc(months)}">`) +
      `<div class="field"><label>Deaktivierte Steuergeräte im Dashboard</label>
        <div class="sub">Aus: Linien & Sensoren eines deaktivierten Steuergeräts werden ausgeblendet; stattdessen erscheint eine Zeile „Steuergerät deaktiviert". Ein: sie bleiben sichtbar (ausgegraut).</div>
        <label class="chk"><input type="checkbox" data-setting-bool="show_disabled_box_entities" ${s.show_disabled_box_entities ? "checked" : ""}> Entities trotzdem anzeigen</label></div>` +
      `<div class="field"><label>Reihenfolge im Dashboard</label>
        <div class="sub">Position von Quellen und Sperr-Sensoren relativ zu den Linien. Steuerungen bleiben immer unten.</div>
        <div class="subrow"><span class="grow">Quellen</span>
          <select data-setting-select="sources_pos">
            <option value="before" ${(s.sources_pos || "before") === "before" ? "selected" : ""}>vor Linien</option>
            <option value="after" ${s.sources_pos === "after" ? "selected" : ""}>nach Linien</option></select></div>
        <div class="subrow"><span class="grow">Sperr-Sensoren</span>
          <select data-setting-select="sensors_pos">
            <option value="after" ${(s.sensors_pos || "after") === "after" ? "selected" : ""}>nach Linien</option>
            <option value="before" ${s.sensors_pos === "before" ? "selected" : ""}>vor Linien</option></select></div></div>` +
      `<div class="field"><label>Plattformen</label>
        <div class="sub">GardenControl & ESP32-WROOM sind eingebaut. Eigene (generische) Plattformen kannst du benennen — sie verhalten sich wie WROOM (GPIO frei).</div>
        ${builtin}
        ${customRows}
        <button class="btn ghost small" data-addplat>+ Eigene Plattform</button></div>` +
      `<div class="actions"><button class="btn primary" data-savesettings>Speichern</button></div>` +
      `</section>` +
      `<section class="cardbox">` +
      `<div class="field"><label>Entities abgleichen</label>
        <div class="sub">Ordnet die Aus-/Eingänge eines Steuergeräts den echten ESPHome-Entities in HA zu (Abgleich über den Entity-<b>Namen</b>, nicht die <code>entity_id</code> — eine <code>entity_id</code> wird dabei <b>nie</b> geändert).
        <b>Normalerweise nicht nötig:</b> der Abgleich läuft automatisch beim Speichern eines Steuergeräts, beim Start der Integration und nach jeder Änderung der ESPHome-Entities eines Steuergeräts (z. B. selbstheilend nach einem Flash, der Entities hinzufügt/umbenennt).
        Manuell anstoßen ist sinnvoll, wenn:
        <ul style="margin:.4em 0 0 1.1em;padding:0">
          <li>ein Steuergerät gerade <b>neu in HA als ESPHome-Gerät hinzugefügt</b> wurde und die Zuordnung in der Hardware-Übersicht noch leer (<code>—</code>) ist;</li>
          <li>du eine <b>Entity in HA umbenannt</b> hast und die Auflösung nicht sofort folgen soll/folgt;</li>
          <li>etwas <b>nicht aufgelöst</b> aussieht (Dashboard/Übersicht zeigt <code>—</code>) und du eine sofortige Rückmeldung <code>x/y abgeglichen</code> willst.</li>
        </ul></div>
        <div class="syncbtns" style="display:flex;flex-wrap:wrap;gap:.4em;margin-top:.5em">${syncButtons}</div></div>` +
      `</section>`
    );
  }

  // --- forms -----------------------------------------------------------------
  _form() {
    const kind = this._editing.kind;
    const d = this._draft;
    const isNew = !d.id;
    const titleMap = { line: "Linie", control: "Steuerung", source: "Quelle", box: "Steuergerät" };
    let fields = "";
    if (kind === "line") fields = this._lineForm(d);
    else if (kind === "control") fields = this._controlForm(d);
    else if (kind === "source") fields = this._sourceForm(d);
    else if (kind === "box") fields = this._boxForm(d);
    return `<section class="cardbox form">
      <div class="listhead"><h2>${isNew ? "Neue" : ""} ${titleMap[kind]}${isNew ? "" : ` „${esc(d.name || "")}"`}</h2></div>
      ${fields}
      <div class="actions">
        <button class="btn" data-cancel>Abbrechen</button>
        ${!isNew ? `<button class="btn danger" data-del="${esc(d.id)}">Löschen</button>` : ""}
        <button class="btn primary" data-savebtn>Speichern</button>
      </div></section>`;
  }

  // Box dropdown options "Kürzel · Name" — Kürzel prefixed like the dashboard chip
  // and the other ref selections, so the box is unambiguous (FR-D1/§4.1).
  _boxOptions() {
    return [["", "— wählen —"], ...Object.values(this._cfg().boxes || {})
      .map((b) => [b.id, `${b.label ? b.label + " · " : ""}${b.name}`])];
  }
  _lineForm(d) {
    const cfg = this._cfg();
    // Only offer valves of the line's selected box (pick the box first).
    const valveOpts = this._outputRefs("valve", d.box_id);
    const srcOpts = [["", "— ohne Quelle —"], ...Object.values(cfg.sources || {}).map((s) => [s.id, s.name])];
    const senOpts = [["", "— kein Sensor —"], ...this._sensorInputRefs()];
    return (
      field("Name", text("name", d.name)) +
      field("Steuergerät", select("box_id", d.box_id, this._boxOptions())) +
      field("Ventil-Ausgang", select("valve_output", d.valve_output, [["", "— wählen —"], ...valveOpts])) +
      field("Wasserquelle", select("source_id", d.source_id, srcOpts)) +
      field("Automatik", checkbox("automatic", d.automatic)) +
      field("Sperr-Sensor", select("sensor_input", d.sensor_input, senOpts),
        "Ohne Sensor wird die Linie nie gesperrt (bewässert immer).") +
      field("Bewässern trotz Sperre (Automatik)", checkbox("sensor_override", d.sensor_override),
        "Nur für Automatik/Zeitplan: wässert auch automatisch trotz nass/feucht. Manueller Start ignoriert den Sperr-Sensor ohnehin.") +
      field("Default-Dauer manuell (min)", dur("manual_default_min", d.manual_default_min),
        "Standard: Minuten (z. B. 5). Für Sekunden m:ss eingeben (z. B. 0:18 = 18 s, Gießkanne füllen).") +
      field("Manuelle Entnahme: Nachlauf überspringen", checkbox("manual_skip_settle", d.manual_skip_settle),
        "Für Schlauch-/Direktentnahme: bei manuellem Start kein Beruhigungs-Nachlauf der Quelle (sofort frei). Zisternen-Verbrauch dann nur ungefähr, Festwasser exakt.") +
      this._scheduleEditor(d.schedule || []) +
      `<div data-runtimewarn>${this._runtimeWarning(d)}</div>`
    );
  }

  // Steuerung form (kind=switch): generic on/off output — no source/sensor/consumption.
  _controlForm(d) {
    // A Steuerung drives an "other"/"pump"-type output (relais/GPIO load).
    const outOpts = this._outputRefs(["other", "pump"], d.box_id);
    return (
      field("Name", text("name", d.name)) +
      field("Steuergerät", select("box_id", d.box_id, this._boxOptions())) +
      field("Ausgang", select("valve_output", d.valve_output, [["", "— wählen —"], ...outOpts]),
        "Ein Steuergerät-Ausgang vom Typ „Sonstiges“ oder „Pumpe“ (z. B. Relais für Springbrunnen/Kamera). Im Steuergerät-Editor anlegen.") +
      field("Automatik", checkbox("automatic", d.automatic)) +
      field("Im Dashboard zeigen", checkbox("show_on_dashboard", d.show_on_dashboard),
        "Aus = nur in den Einstellungen, nicht auf dem Dashboard.") +
      field("Default-Dauer manuell (min)", dur("manual_default_min", d.manual_default_min),
        "Standard: Minuten (z. B. 5). Für Sekunden m:ss eingeben (z. B. 0:18 = 18 s, Gießkanne füllen).") +
      `<div class="sub" style="margin:-4px 0 8px">Zeitplan-Dauer <b>leer/0</b> = „an bis manuell gestoppt" (Dauerbetrieb). Für ein geplantes Aus eine reguläre Dauer setzen (an 20:00 für 600 min = aus 06:00).</div>` +
      this._scheduleEditor(d.schedule || []) +
      `<div data-runtimewarn>${this._runtimeWarning(d)}</div>`
    );
  }

  _scheduleEditor(entries) {
    const rows = entries
      .map((e, i) => {
        let extra = "";
        if (e.repeat === "weekly")
          extra = `<div class="weekdays">${WEEKDAYS.map(
            (w) => `<label class="wd ${(e.weekdays || []).includes(w) ? "on" : ""}">
              <input type="checkbox" data-wd="${i}:${w}" ${(e.weekdays || []).includes(w) ? "checked" : ""}>${WEEKDAY_LABEL[w]}</label>`
          ).join("")}</div>`;
        else if (e.repeat === "monthly")
          extra = field("Tag(e) im Monat", `<input data-path="schedule.${i}.monthdays" data-type="intlist" value="${esc((e.monthdays || []).join(", "))}" placeholder="1, 15">`);
        return `<div class="schedrow${e.enabled === false ? " disabled" : ""}">
          <div class="schedline">
            <label class="chk schedon" title="Eintrag aktiv/inaktiv"><input type="checkbox" data-path="schedule.${i}.enabled" data-type="bool" ${e.enabled === false ? "" : "checked"}> aktiv</label>
            ${select(`schedule.${i}.repeat`, e.repeat, Object.entries(REPEAT))}
            <input type="time" data-path="schedule.${i}.time" data-type="str" value="${esc(e.time || "")}" title="Startzeit">
            ${numInline(`schedule.${i}.duration_min`, e.duration_min, "Dauer min")}
            <button class="btn danger small" data-delsched="${i}">✕</button>
          </div>${extra}</div>`;
      })
      .join("");
    return `<div class="field"><label>Zeitplan</label>
      <div class="sub">Pro Eintrag: Wiederholung · Startzeit · Dauer. Mehrere Zeiten = mehrere Einträge.</div>
      <div class="sched">${rows || `<div class="empty">Keine Einträge.</div>`}
      <button class="btn ghost small" data-addsched>+ Eintrag</button></div></div>`;
  }

  _sourceForm(d) {
    const isC = d.type === "cistern";
    let body =
      field("Name", text("name", d.name)) +
      field("Typ", select("type", d.type, Object.entries(SOURCE_TYPE)));
    if (isC) {
      body +=
        field("Pegel-Eingang", select("level_input", d.level_input, [["", "— wählen —"], ...this._inputRefs("pressure")])) +
        this._calEditor(d) +
        field("Max-Volumen (L)", num("max_volume_l", d.max_volume_l)) +
        field("Mindest-Füllstand (%)", num("min_fill_pct", d.min_fill_pct)) +
        field("Pumpe", select("pump_output", d.pump_output, [["", "— keine —"], ...this._outputRefs("pump")])) +
        field("Beruhigungszeit (min)", num("tank_settle_min", d.tank_settle_min)) +
        field("Linear-Shortcut: Multiplier (L/Rohwert)", num("multiplier", d.multiplier, true),
          "Nur wirksam, wenn KEINE Stützpunkt-Tabelle (≥ 2 Punkte) gesetzt ist.") +
        field("Linear-Shortcut: Offset (L)", num("offset", d.offset, true));
    } else {
      body +=
        field("Literzähler-Eingang", select("meter_input", d.meter_input, [["", "— wählen —"], ...this._inputRefs("pulse_meter")])) +
        field("Faktor (L/Impuls)", num("pulse_factor", d.pulse_factor, true));
    }
    return body;
  }

  // Calibration table editor (FR-S5a): rows of raw→liter + live-capture.
  _calEditor(d) {
    const pts = d.calibration_points || [];
    const raw = d.id ? this._val(d.id, "level_raw") : null;
    const rawTxt = raw == null ? "—" : Math.round(raw * 1000) / 1000;
    const rows = pts
      .map((p, i) => `<div class="calrow">
        <input type="number" step="any" data-path="calibration_points.${i}.raw" data-type="float" value="${p.raw == null || p.raw === "" ? "" : esc(p.raw)}" placeholder="Rohwert">
        <span class="calarrow">→</span>
        <input type="number" step="any" data-path="calibration_points.${i}.liters" data-type="float" value="${p.liters == null || p.liters === "" ? "" : esc(p.liters)}" placeholder="Liter">
        <button class="btn danger small" data-delcal="${i}">✕</button></div>`)
      .join("");
    const active = pts.filter((p) => p.raw !== "" && p.raw != null && p.liters !== "" && p.liters != null).length >= 2;
    const inp = this._inputByRef(d.level_input);
    const ent = inp && inp.entity ? inp.entity : "Pegel-Sensor";
    return `<div class="field"><label>Kalibrierung — Stützpunkte (Rohwert → Liter)</label>
      <div class="hint">Der <b>Rohwert</b> ist der ungerechnete Live-Wert des Pegel-Sensors
        (<code>${esc(ent)}</code>, bei generierter Firmware der rohe elektrische Messwert — ADC-Spannung
        bzw. 4-20-mA-Strom, kein Druck/cm).
        Ein Punkt verknüpft „Sensor zeigt X" mit „Tank hat Y Liter"; die Tabelle interpoliert
        stückweise linear und faltet Sensor-Kennlinie + Tankform in eine Kurve.
        ${active
          ? "<b>Tabelle aktiv</b> (≥ 2 vollständige Punkte)."
          : "Erst ab 2 vollständigen Punkten aktiv — sonst gilt der Linear-Shortcut unten."}
        Aktueller Rohwert: <b>${esc(rawTxt)}</b></div>
      <div class="calwrap">
        <div class="calcol">
          <div class="caltable">${rows || `<div class="empty">Keine Stützpunkte. Tabelle eintippen oder Messwert übernehmen.</div>`}</div>
          <div class="calbtns"><button class="btn ghost small" data-addcal>+ Punkt</button>${
            raw != null ? `<button class="btn ghost small" data-capcal>Aktuellen Messwert übernehmen (${esc(rawTxt)})</button>` : ""
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
      note = "Linear-Shortcut (keine Tabelle)";
    } else {
      note = `Stützpunkt-Tabelle (${pts.length} Punkte)`;
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
    return `<div class="calcurve"><div class="calcap">Kalibrierkurve — ${esc(note)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="calsvg" preserveAspectRatio="xMidYMid meet">
        <line x1="${pad}" y1="${H - pad}" x2="${W - 10}" y2="${H - pad}" class="calaxis"/>
        <line x1="${pad}" y1="8" x2="${pad}" y2="${H - pad}" class="calaxis"/>
        <text x="4" y="14" class="callbl">${esc(Math.round(y1))} L</text>
        <text x="4" y="${H - pad}" class="callbl">0</text>
        <text x="${pad}" y="${H - 8}" class="callbl">${esc(r2(x0))}</text>
        <text x="${W - 10}" y="${H - 8}" class="callbl" text-anchor="end">Rohwert ${esc(r2(x1))}</text>
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
        ${text(`outputs.${i}.name`, o.name, "Name", "wide")}
        ${select(`outputs.${i}.type`, o.type, Object.entries(OUTPUT_TYPE))}
        ${select(`outputs.${i}.channel`, o.channel, this._channelOptions(d, o, i))}
        ${generic ? select(`outputs.${i}.gpio`, o.gpio, this._outputGpioOptions(d, o, i)) : ""}
        ${numInline(`outputs.${i}.emergency_shutdown_min`, o.emergency_shutdown_min, "Not-Aus min")}
        ${this._connDevFields(d, o, i)}
        ${this._polaritySelect(d, o, i)}
        <button class="btn danger small" data-delout="${i}">✕</button></div>`)
      .join("");
    const ins = (d.inputs || [])
      .map((inp, i) => {
        // rain/soil inputs double as blocking sensors → extra param; same column for all (FR-UX).
        let extra;
        if (inp.kind === "rain")
          // inverted=false = Öffner/NC (öffnet bei Regen, z. B. RainClik) → keine Pin-Invertierung;
          // inverted=true = Schließer/NO (schließt bei Regen) → Pin invertiert. Entity stets on=nass.
          extra = boolSelect(`inputs.${i}.inverted`, inp.inverted, "Schließer (NO)", "Öffner (NC) · RainClik");
        else if (inp.kind === "soil_moisture")
          extra = numInline(`inputs.${i}.threshold_pct`, inp.threshold_pct, "Schwelle %");
        else if (inp.kind === "button")
          // generic binary input (FR-S14): polarity only, no block semantics
          extra = boolSelect(`inputs.${i}.inverted`, inp.inverted, "invertiert (Ruhe = an)", "normal (Ruhe = aus)");
        else
          extra = `<select disabled title="kein Parameter"><option>—</option></select>`;
        return `<div class="subrow inrow">
        ${text(`inputs.${i}.name`, inp.name, "Name", "wide")}
        ${select(`inputs.${i}.kind`, inp.kind, Object.entries(INPUT_KIND))}
        ${select(`inputs.${i}.pin`, inp.pin, this._inputPinOptions(d, inp, i))}
        ${extra}
        <button class="btn danger small" data-delin="${i}">✕</button></div>`;
      })
      .join("");
    return (
      field("Name", text("name", d.name)) +
      field("Plattform", select("hw_type", d.hw_type, this._platforms().map((p) => [p.id, p.name]))) +
      field("Kürzel (z. B. A → A5)", select("label", d.label, this._boxLabelOptions(d))) +
      field("Aktiviert (deaktiviert = außer Betrieb)", checkbox("enabled", d.enabled !== false)) +
      `<div class="field"><label>Ausgänge (Ventile & Pumpen)</label>
        <div class="sub">Kanal = Ausgang-ID (A5).${generic ? " GPIO = physischer ESP-Pin (frei)." : " ESP-Pin fest aus dem GardenControl-Profil."} Entity wird automatisch abgeleitet (s. Hardware-Übersicht).</div>
        ${outs || `<div class="empty">Keine Ausgänge.</div>`}
        <button class="btn ghost small" data-addout>+ Ausgang</button></div>` +
      `<div class="field"><label>Eingänge (Sensoren)</label>
        <div class="sub">Pin = ESP-Eingang${generic ? " (frei wählbar)" : ""}; Regen/Bodenfeuchte tragen ihren Sperr-Parameter. Entity wird automatisch abgeleitet (s. Hardware-Übersicht).</div>
        ${ins || `<div class="empty">Keine Eingänge.</div>`}
        <button class="btn ghost small" data-addin>+ Eingang</button></div>`
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
    const match = (t) => !type || (Array.isArray(type) ? type.includes(t) : t === type);
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
      if (!r.total) this._toast("Keine Ein-/Ausgänge zum Abgleichen.");
      else if (!r.resolved)
        this._toast("Keine Entities gefunden — Steuergerät flashen und in HA als ESPHome-Gerät hinzufügen.");
      else this._toast(`${r.resolved}/${r.total} Entities abgeglichen.`);
    } catch (err) {
      this._toast(`Abgleich: ${err.message || err}`);
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
      this._toast(`YAML: ${err.message || err}`);
      return;
    }
    this._render();
  }
  _yamlModal() {
    return `<div class="overlay" data-closeyaml>
      <div class="modal" data-stop-prop>
        <div class="modalhead"><h2>ESPHome-YAML 🔒</h2>
          <button class="btn ghost" data-closeyaml>✕</button></div>
        <pre class="yaml">${esc(this._yaml.text)}</pre>
        <div class="actions">
          <button class="btn" data-copyyaml>Kopieren</button>
          <button class="btn primary" data-dlyaml>Herunterladen</button></div>
      </div></div>`;
  }

  // --- Verdrahtung modal (read-only wiring lens, FR-WI1) --------------------
  async _openWiring(boxId) {
    try {
      const data = await this._ws({ type: "gardenesp/wiring", box_id: boxId });
      this._wiring = { box_id: boxId, data };
    } catch (err) {
      this._toast(`Verdrahtung: ${err.message || err}`);
      return;
    }
    this._render();
  }
  _wiringModal() {
    const d = this._wiring.data || {};
    const box = d.box || {};
    const title = `Verdrahtung — Steuergerät ${esc(box.label ? String(box.label).toUpperCase() + " " : "")}${esc(box.name || "")}`;
    const inner = d.supported
      ? this._wireDiagram(d)
      : `<div class="empty">${esc((d.notes && d.notes[0]) || "Kein Diagramm verfügbar.")}</div>`;
    const notes = d.supported && d.notes
      ? `<ul class="wirenotes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : "";
    return `<div class="overlay" data-closewiring>
      <div class="modal wiremodal" data-stop-prop>
        <div class="modalhead"><h2>🔌 ${title}</h2>
          <button class="btn ghost" data-closewiring>✕</button></div>
        <div class="wirebody">${inner}${notes}</div>
        <div class="actions">
          ${d.supported ? `<button class="btn primary" data-printwiring>Drucken</button>` : ""}
          <button class="btn" data-closewiring>Schließen</button></div>
      </div></div>`;
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
    const W = 700, H = 490, MX = 20, GAP = 36, COLW = 52;          // 5:3.5 landscape
    const colCX = (i) => MX + i * COLW + (i >= 6 ? GAP : 0) + COLW / 2;
    const yU = 142, yL = 166;                                       // top screw rows
    const bodyTop = yL + 18, BODYH = 120, bodyBot = bodyTop + BODYH;
    const yB = bodyBot + 20;                                        // bottom valve screws
    const topName = 128, botName = yB + 14;                         // card baselines
    const colOf = (a, c) => c.power || !a ? "" : (a.role === "sensor" ? "#1565c0" : "#2e7d32");
    const screw = (cx, cy, col) =>
      `<circle cx="${cx}" cy="${cy}" r="6" class="gcscrew"${col ? ` style="stroke:${col};stroke-width:2"` : ""}/>` +
      `<line x1="${cx - 3}" y1="${cy - 3}" x2="${cx + 3}" y2="${cy + 3}" class="gcslot"/>`;
    // Boxed device label (analogous to the WROOM card) drawn in a rotated frame so it
    // reads vertically off the narrow terminal column; ``px/py`` is the screw-side end.
    const card = (px, py, rot, a) => {
      const cls = a.role === "sensor" ? "in" : "out";
      const label = (a.short_id ? a.short_id + " " : "") + trunc(a.name, 16);
      const w = Math.round(label.length * 6.3 + 10);
      return `<g transform="rotate(${rot} ${px} ${py})">` +
        `<rect x="${px + 3}" y="${py - 9}" width="${w}" height="17" rx="3" class="gccard ${cls}"/>` +
        `<text x="${px + 9}" y="${py + 3}" class="gcdev ${cls}">${esc(label)}</text></g>`;
    };

    // body
    let svg = `<rect x="${MX}" y="${bodyTop}" width="${W - 2 * MX}" height="${BODYH}" rx="12" class="chip"/>`;
    const midX = W / 2, midY = bodyTop + BODYH / 2;
    svg += `<text x="${midX}" y="${midY - 4}" class="chiplbl" text-anchor="middle">GardenControl</text>`;
    for (let n = 1; n <= 12; n++) {
      const cx = midX - 12 * 9 + (n - 0.5) * 18;
      svg += `<text x="${cx}" y="${midY + 16}" class="gclednum" text-anchor="middle">${n}</text><circle cx="${cx}" cy="${midY + 24}" r="3" class="gcled"/>`;
    }
    svg += `<text x="${midX}" y="${midY + 40}" class="gccap" text-anchor="middle">Ventile</text>`;

    // top screw rows: assigned terminals get a wire up to a boxed label; unassigned
    // (incl. power) just the screw + terminal label. Per-row x-offset avoids collisions.
    const drawTop = (c, i, row) => {
      if (!c || !c.label) return;
      const cx = colCX(i), a = c.assignment, cy = row === "U" ? yU : yL;
      svg += screw(cx, cy, colOf(a, c));
      svg += `<text x="${cx}" y="${cy + 14}" class="gctlbl${a ? " on" : ""}" text-anchor="middle">${esc(c.label)}</text>`;
      if (!a) return;
      const px = cx + (row === "U" ? -13 : 13);
      svg += `<line x1="${cx}" y1="${cy - 6}" x2="${px}" y2="${topName}" class="gcwire"/>` + card(px, topName, -90, a);
    };
    (g.top_upper || []).forEach((c, i) => drawTop(c, i, "U"));
    (g.top_lower || []).forEach((c, i) => drawTop(c, i, "L"));

    // bottom valve screw row (single row): wire down to a boxed label
    (g.bottom || []).forEach((c, i) => {
      if (!c || !c.label) return;
      const cx = colCX(i), a = c.assignment;
      svg += screw(cx, yB, colOf(a, c));
      svg += `<text x="${cx}" y="${yB - 10}" class="gctlbl${a ? " on" : ""}" text-anchor="middle">${esc(c.label)}</text>`;
      if (!a) return;
      svg += `<line x1="${cx}" y1="${yB + 6}" x2="${cx}" y2="${botName}" class="gcwire"/>` + card(cx, botName, 90, a);
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="wiresvg" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
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
      const role = { valve: "Ventil", pump: "Pumpe", other: "Ausgang", sensor: "Sensor" }[dev.role] || dev.role;
      const idTag = dev.short_id ? `<tspan class="cardid">${esc(dev.short_id)}</tspan> ` : "";
      svg += `<g class="card"><rect x="${cx}" y="${y - 11}" width="${CARDW}" height="22" rx="4"/>` +
        `<text x="${cx + 8}" y="${y + 4}" class="cardlbl">${idTag}${esc(trunc(dev.name, 22))} <tspan class="cardrole">(${esc(role)})</tspan></text></g>`;
    });

    // legend
    const leg = [["io", "frei nutzbar"], ["input_only", "nur Eingang (34–39)"], ["strapping", "Strapping (Vorsicht)"], ["uart", "UART/Konsole (1·3)"], ["forbidden", "belegt/Flash (6–11)"], ["power", "Power/GND"]];
    let lx = 8; const ly = H + 44;
    let legend = leg.map(([c, t]) => { const s = `<rect x="${lx}" y="${ly - 9}" width="11" height="11" fill="${COL[c]}"/><text x="${lx + 16}" y="${ly}" class="legtxt">${t}</text>`; lx += 30 + t.length * 6.4; return s; }).join("");

    return `<svg viewBox="0 0 ${W} ${ly + 10}" class="wiresvg" xmlns="http://www.w3.org/2000/svg">${svg}${legend}</svg>`;
  }
  _printWiring() {
    if (!this._wiring || !this._wiring.data || !this._wiring.data.supported) return;
    const d = this._wiring.data, box = d.box || {};
    const win = window.open("", "_blank");
    if (!win) { this._toast("Pop-up blockiert — Druck nicht möglich."); return; }
    win.document.write(`<!doctype html><html><head><title>Verdrahtung ${esc(box.name || "")}</title>
      <style>${this._wireStyle()} body{margin:16px;font-family:sans-serif}h1{font-size:16px}
      ul{font-size:12px;color:#444}</style></head><body>
      <h1>🔌 Verdrahtung — Steuergerät ${esc(box.label ? String(box.label).toUpperCase() + " " : "")}${esc(box.name || "")}</h1>
      ${this._wireDiagram(d)}
      <ul>${(d.notes || []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
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
      .gcdev{font-size:11px;font-weight:600}.gcdev.out{fill:#2e7d32}.gcdev.in{fill:#1565c0}`;
  }

  // --- event binding ---------------------------------------------------------
  _bind() {
    const root = this.shadowRoot.getElementById("root");
    const q = (s) => root.querySelectorAll(s);
    const on = (s, ev, fn) => q(s).forEach((el) => (el[ev] = fn));

    const ref = root.querySelector('[data-act="refresh"]');
    if (ref) ref.onclick = () => this._load();
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
    on("[data-addin]", "onclick", () => this._addRow("inputs", { id: this._localId("i", this._draft.inputs), kind: "pressure", name: "", pin: this._firstFreeInputPin(this._draft.hw_type, "pressure"), inverted: false, threshold_pct: 40, entity: "", calibration: {} }));
    on("[data-delout]", "onclick", (e) => this._delRow("outputs", +e.currentTarget.dataset.delout));
    on("[data-delin]", "onclick", (e) => this._delRow("inputs", +e.currentTarget.dataset.delin));
    on("[data-addsched]", "onclick", () => this._addRow("schedule", { repeat: "daily", time: "06:00", duration_min: 10, weekdays: [], monthdays: [], enabled: true }));
    on("[data-delsched]", "onclick", (e) => this._delRow("schedule", +e.currentTarget.dataset.delsched));
    on("[data-addcal]", "onclick", () => this._addRow("calibration_points", { raw: "", liters: "", captured_at: new Date().toISOString() }));
    on("[data-delcal]", "onclick", (e) => this._delRow("calibration_points", +e.currentTarget.dataset.delcal));
    on("[data-capcal]", "onclick", () => this._captureCal());

    // Allgemein tab (global settings + custom platforms)
    on("[data-setting]", "oninput", (e) => { this._settingsDraft[e.currentTarget.dataset.setting] = e.currentTarget.value === "" ? "" : parseInt(e.currentTarget.value, 10) || 0; });
    on("[data-setting-bool]", "onchange", (e) => { this._settingsDraft[e.currentTarget.dataset.settingBool] = e.currentTarget.checked; });
    on("[data-setting-select]", "onchange", (e) => { this._settingsDraft[e.currentTarget.dataset.settingSelect] = e.currentTarget.value; });
    on("[data-platname]", "oninput", (e) => { this._settingsDraft.platforms[+e.currentTarget.dataset.platname].name = e.currentTarget.value; });
    on("[data-addplat]", "onclick", () => {
      (this._settingsDraft.platforms = this._settingsDraft.platforms || []).push({ id: "plat_" + Math.random().toString(36).slice(2, 8), name: "Neue Plattform" });
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
    if (type === "bool") v = el.type === "checkbox" ? el.checked : el.value === "true";
    else if (type === "num") v = el.value === "" ? 0 : parseInt(el.value, 10) || 0;
    else if (type === "float") v = el.value === "" ? 0 : parseFloat(el.value) || 0;
    else if (type === "dur") v = parseDur(el.value);
    else if (type === "strlist") v = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (type === "intlist") v = el.value.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
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
      this._toast("Einstellungen gespeichert");
    } catch (err) {
      this._toast(`Speichern fehlgeschlagen: ${err.message || err}`);
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
    const t = this._yaml.text;
    // navigator.clipboard needs a secure context (https/localhost) — HA over http
    // on the LAN often has it undefined, so fall back to a hidden textarea + execCommand.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t)
        .then(() => this._toast("YAML kopiert"))
        .catch(() => this._fallbackCopy(t));
    } else {
      this._fallbackCopy(t);
    }
  }
  _fallbackCopy(t) {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    (this.shadowRoot || document.body).appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    this._toast(ok ? "YAML kopiert" : "Kopieren nicht möglich — bitte manuell markieren");
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
  return `<input data-path="${path}" data-type="dur" value="${esc(fmtDur(val))}" placeholder="z. B. 5 oder 0:18">`;
}
// "0:18" / "1:30" → fractional minutes; a plain number is taken as minutes.
function parseDur(str) {
  const t = String(str == null ? "" : str).trim();
  if (t === "") return 0;
  if (t.includes(":")) {
    const [mm, ss] = t.split(":");
    return (parseInt(mm, 10) || 0) + (parseInt(ss, 10) || 0) / 60;
  }
  return parseFloat(t) || 0;
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

// --- generic helpers ---------------------------------------------------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Consumption volume: liters, switching to m³ above 1000 L (mirrors the Card).
function fmtVol(liters) {
  const v = Number(liters) || 0;
  if (v >= 1000) return `${(v / 1000).toLocaleString("de-DE", { maximumFractionDigits: 2 })} m³`;
  return `${Math.round(v)} L`;
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
.head { display: flex; align-items: center; justify-content: space-between; }
.headbtns { display: inline-flex; align-items: center; gap: 6px; }
h1 { font-size: 22px; margin: 8px 0 12px; color: var(--primary-text-color);
  display: inline-flex; align-items: center; gap: 8px; }
h1 ha-icon { --mdc-icon-size: 26px; color: var(--primary-color); }
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
/* consumption period-sums under the stamps (Quellen/Linien overview) */
.consum { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 4px; font-size: 12px; }
.consum .chead { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  color: var(--secondary-text-color); }
.csum { white-space: nowrap; }
.csum .cl { color: var(--secondary-text-color); }
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
.wiresvg .gcdev { font-size: 11px; font-weight: 600; }
.wiresvg .gcdev.out { fill: #2e7d32; }
.wiresvg .gcdev.in { fill: #1565c0; }
.wirenotes { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: var(--secondary-text-color); }
/* Topologie tab (read-only hydraulic lens) — inline-SVG schematic
   (text-sized nodes per column Box·Quelle·Pumpe·Ventil·Linie, elbow-wired,
   echoing the Verdrahtungs-Lens). */
.topo-intro { margin: 0 0 12px; }
.topo-group { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px;
  padding: 8px; margin-bottom: 12px; overflow-x: auto; }
.toposvg { display: block; width: 100%; height: auto; min-width: 520px; font-family: inherit; }
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
