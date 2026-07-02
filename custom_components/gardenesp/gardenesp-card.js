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

const STATUS = {
  active: { label: "● Aktiv", cls: "ok" },
  idle: { label: "○ Inaktiv", cls: "muted" },
  waiting: { label: "○ Wartend", cls: "warn" },
  blocked_sensor: { label: "⚠ Gesperrt · Sensor nass", cls: "info" },
  blocked_level: { label: "⚠ Gesperrt · Wasserstand niedrig", cls: "info" },
  automatic_off: { label: "◌ Automatik AUS", cls: "muted" },
  box_disabled: { label: "◌ Steuergerät deaktiviert", cls: "muted" },
  unreachable: { label: "⚠ Nicht erreichbar", cls: "warn" },
  settling: { label: "◐ Nachlauf · Messung", cls: "warn" },
};
// Firmware-drift status per box (#9) — keys match coordinator drift.fw_status().
const FW_ATTENTION = ["drift", "drift_offline", "drift_export"];
const SOURCE_TYPE = { cistern: "Zisterne", mains: "Festwasser" };
const SENSOR_KIND = { rain: "Regen", soil_moisture: "Bodenfeuchte" };
const RESULT_LABEL = {
  completed: "fertig",
  stopped: "gestoppt",
  skipped_sensor: "übersprungen (Sensor)",
  skipped_level: "Wasserstand niedrig",
  skipped_unreachable: "übersprungen (nicht erreichbar)",
  superseded: "abgelöst (Neustart)",
  interrupted: "abgebrochen (Steuergerät weg)",
  emergency: "Notabschaltung",
};
// Run results that count as a disturbance (Störung) surfaced on the dashboard
// (CR-0011). Deliberate outcomes (rain skip, planned supersede, manual stop) are
// excluded — those are normal operation, not a fault.
const FAULT_RESULTS = new Set([
  "skipped_unreachable", "skipped_level", "interrupted", "emergency",
]);
const TRIGGER_LABEL = { auto: "Automatik", manual: "manuell" };
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
    if (!this._timer) this._timer = setInterval(() => this._load(), POLL_MS);
    if (!this._tick) this._tick = setInterval(() => this._updateCountdown(), 1000);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._tick) clearInterval(this._tick);
    this._timer = this._tick = null;
  }

  async _ws(msg) {
    return this._hass.connection.sendMessagePromise(msg);
  }
  async _load() {
    if (!this._hass) return;
    try {
      const [cfg, hist] = await Promise.all([
        this._ws({ type: "gardenesp/config/get" }),
        this._ws({ type: "gardenesp/history" }),
      ]);
      this._data = cfg;
      this._history = (hist && hist.entries) || [];
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
  _val(id, key, dflt = null) {
    if (!this._data || !this._data.values) return dflt;
    const v = this._data.values[`${id}__${key}`];
    return v === undefined ? dflt : v;
  }
  async _action(msg, label) {
    try {
      await this._ws(msg);
    } catch (err) {
      this._toast(`${label} fehlgeschlagen: ${err.message || err}`);
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
    return this._row(ICONS.box_off, "", line1, "Steuergerät außer Betrieb", right, "");
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

  // Banner shown when one or more boxes need (re)flashing (#9). Click → Einstellungen.
  _fwBanner(cfg) {
    const names = Object.values(cfg.boxes || {})
      .filter((b) => b.enabled !== false && FW_ATTENTION.includes(this._val(b.id, "fw_status")))
      .map((b) => (b.label ? `Steuergerät ${String(b.label).toUpperCase()}` : b.name || b.id));
    if (!names.length) return "";
    return `<a class="fwbanner" href="/gardenesp" title="Einstellungen → Hardware">⚠ Flashen ausstehend: ${esc(names.join(" · "))}</a>`;
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
    const title = this._config.title || APP_NAME;
    const hd = `<div class="hd"><span class="ttl"><ha-icon icon="${ICON}"></ha-icon>${esc(title)}</span>`;
    if (this._loading) {
      card.innerHTML = `${hd}</div><div class="empty">Lade…</div>`;
      return;
    }
    if (this._error) {
      card.innerHTML = `${hd}</div><div class="empty err">Fehler: ${esc(this._error)}</div>`;
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
        ? `<div class="grouphd">Steuerungen</div>` +
          controls.map((ln) => this._controlRow(cfg, ln)).join("")
        : "") +
      offRows;
    card.innerHTML = `
      ${hd}<a class="open" href="/gardenesp" title="Einstellungen öffnen">⚙</a></div>
      ${this._fwBanner(cfg)}
      ${rows || `<div class="empty">Noch nichts konfiguriert — siehe Einstellungen ⚙</div>`}
      ${this._details ? this._detailsOverlay(cfg) : ""}`;
    this._bind();
  }

  // detail = "kind:id" → the whole row is clickable and opens that Details overlay.
  // ``right`` = right-aligned value/status (sensors & sources); omit ``line2`` → single-line row.
  _row(icon, detail, line1, line2, right, action) {
    return `<div class="row${detail ? " clickable" : ""}"${detail ? ` data-rowdetails="${detail}"` : ""}>
      <ha-icon class="ico" icon="${icon}"></ha-icon>
      <div class="grow"><div class="t">${line1}</div>${line2 ? `<div class="s">${line2}</div>` : ""}</div>
      <div class="rgt">${right || ""}</div>
      <div class="acts">${action || ""}</div>
    </div>`;
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
    const auto = ln.automatic ? "" : ` <span class="tag">Auto aus</span>`;
    const last = this._lastFor(id);
    const lastIsFault = last && last === this._faultFor(id);
    const lastTxt = last ? `Letzte: ${fmtLast(last, lastIsFault)}` : "Letzte: —";
    const nextTxt = `Nächste: ${fmtNext(this._val(id, "next_run"))}`;
    // Source/box belong in the Details overlay (FR-D1a), not the line row (FR-D1).
    const sub = `${lastTxt}${this._faultLine(id, status)} · ${nextTxt}`;
    let badge;
    if (status === "active") {
      const until = this._val(id, "until");
      badge = `<span class="badge ok">${st.label} <span data-until="${esc(until || "")}">${fmtRemaining(until)}</span></span>`;
    } else {
      badge = `<span class="badge ${st.cls}">${st.label}</span>`;
    }
    // Name (ellipsizes) + status badge stay together on line 1; click the row → Details.
    const line1 = `<span class="nm">${label}</span> ${badge}${auto}`;
    // A deactivated box is out of service — no manual start from the dashboard.
    const action = boxOff ? "" : this._lineActions(ln, status);
    return this._row(ICONS.line, `line:${esc(id)}`, line1, sub, "", action);
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
      return `<button class="iconbtn stop" title="Stopp" data-stop="${esc(id)}"><ha-icon icon="mdi:stop"></ha-icon></button>`;
    }
    if (status === "blocked_sensor") {
      return `<button class="iconbtn warn" title="Start trotzdem (Sensor sperrt)" data-manual="${esc(id)}" data-force="1"><ha-icon icon="mdi:play"></ha-icon></button>`;
    }
    return `<button class="iconbtn primary" title="Manuell starten" data-manual="${esc(id)}"><ha-icon icon="mdi:play"></ha-icon></button>`;
  }

  // --- control row (Steuerung, kind=switch) — FR-D3a -------------------------
  _controlRow(cfg, ln) {
    const id = ln.id;
    const boxOff = this._lineOutOfService(cfg, ln);
    const status = boxOff ? "box_disabled" : this._val(id, "status", ln.automatic ? "idle" : "automatic_off");
    const st = STATUS[status] || STATUS.idle;
    const auto = ln.automatic ? "" : ` <span class="tag">Auto aus</span>`;
    const last = this._lastFor(id);
    const lastIsFault = last && last === this._faultFor(id);
    const sub = `${last ? `Letzte: ${fmtLast(last, lastIsFault)}` : "Letzte: —"}${this._faultLine(id, status)} · Nächste: ${fmtNext(this._val(id, "next_run"))}`;
    let badge;
    if (status === "active") {
      const until = this._val(id, "until");
      if (until) {
        badge = `<span class="badge ok">${st.label} <span data-until="${esc(until)}">${fmtRemaining(until)}</span></span>`;
      } else {
        // Dauerbetrieb: no fixed end → count elapsed up instead of a countdown.
        const since = this._val(id, "started");
        badge = `<span class="badge ok">${st.label} <span data-since="${esc(since || "")}">${fmtElapsed(since)}</span></span>`;
      }
    } else {
      badge = `<span class="badge ${st.cls}">${st.label}</span>`;
    }
    const line1 = `<span class="nm">${esc(ln.name || id)}</span> ${badge}${auto}`;
    const action = boxOff ? "" : this._lineActions(ln, status);  // ▶/■ shared with lines
    return this._row(ICONS.control, `line:${esc(id)}`, line1, sub, "", action);
  }

  // --- source row ------------------------------------------------------------
  _sourceRow(cfg, s) {
    const id = s.id;
    const isC = s.type === "cistern";
    const icon = isC ? ICONS.cistern : ICONS.mains;
    // Source on a deactivated box → out of service (shown only when entities are kept visible).
    if (this._isSourceDisabled(cfg, s)) {
      const line1 = `<span class="nm">${esc(s.name || id)}</span>`;
      return this._row(icon, `source:${esc(id)}`, line1, "", `<span class="muted">Steuergerät deaktiviert</span>`, "");
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
      right = `<span>${esc(today != null ? Math.round(today) + " L" : "—")}</span>`;
    }
    // Low water level is a property of the source — surfaced here (next to the
    // Zisterne name) rather than as a per-line „Gesperrt" badge.
    const badge = low ? ` <span class="badge warn">⚠ Wasserstand niedrig</span>` : "";
    const line1 = `<span class="nm">${esc(s.name || id)}</span>${badge}`;
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
        state = b ? "nass" : "trocken";
        cls = b ? "info" : "muted";
      }
    } else {
      const m = this._val(ref, "moisture");
      if (m != null) {
        const blocked = inp.threshold_pct && m >= inp.threshold_pct;
        state = `${Math.round(m)} % · ${blocked ? "feucht" : "trocken"}`;
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
    const min = this._inline.min;
    return `<div class="timer">
      <input type="text" class="mininput" value="${esc(fmtDurInput(min))}" data-mininput placeholder="5 / 0:18" title="Minuten (z. B. 5) oder m:ss (z. B. 0:18 = 18 s)">
      <span class="unit">min / m:ss</span>
      <button class="btn primary" data-go>Start</button>
      <button class="btn ghost" data-cancelinline>✕</button>
    </div>`;
  }

  // --- details overlay (FR-D1a config read-only + FR-D6 history) -------------
  _detailsOverlay(cfg) {
    const { kind, id } = this._details;
    let title = "Details";
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
    const es = out && out.emergency_shutdown_min ? `${out.emergency_shutdown_min} min` : "aus";
    return this._kv([
      ["Steuergerät/Ventil", esc(this._valveLabel(cfg, ln))],
      ["Schalt-Entity", esc(out && out.entity ? out.entity : "—")],
      ["Quelle", src ? esc(src.name) : "ohne Quelle"],
      ["Notstop", esc(es)],
      ["Automatik", ln.automatic ? "ein" : "aus"],
      ["Sensor", sensor ? `${esc(sensor.name)}${ln.sensor_override ? " · Override (trotz Regen)" : ""}` : "— kein —"],
      ["Nächste", fmtNext(this._val(ln.id, "next_run"))],
    ]);
  }

  _sourceDetails(cfg, s) {
    if (s.type === "cistern") {
      const pump = this._output(cfg, s.pump_output);
      const level = this._val(s.id, "level");
      const pct = this._val(s.id, "level_pct");
      // Open HA's native more-info dialog (with its history graph) on the level
      // sensor — no need to add the entity to the dashboard separately.
      const ent = this._entityId(s.id, "level");
      const histBtn = ent
        ? `<button class="btn ghost histbtn" data-moreinfo="${esc(ent)}"><ha-icon icon="mdi:chart-line"></ha-icon> Füllstand-Verlauf</button>`
        : "";
      return this._kv([
        ["Typ", SOURCE_TYPE[s.type]],
        ["Füllstand", `${level != null ? Math.round(level) + " L" : "—"}${pct != null ? ` (${pct} %)` : ""}`],
        ["Max-Volumen", `${s.max_volume_l || "—"} L`],
        ["Mindest-Füllstand", `${s.min_fill_pct || 0} %`],
        ["Pumpe", pump ? esc(pump.name) : "—"],
        ["Beruhigungszeit", `${s.tank_settle_min || 0} min`],
      ]) + histBtn;
    }
    return this._kv([
      ["Typ", SOURCE_TYPE[s.type]],
      ["Faktor", `${s.pulse_factor} L/Impuls`],
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
      if ((d.identifiers || []).some((t) => t[0] === "gardenesp" && t[1] === objId)) { devId = d.id; break; }
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
      ["Art", SENSOR_KIND[inp.kind] || inp.kind],
      ["Box", esc(box ? box.name : "—")],
      ["Entity", esc(inp.entity || "—")],
      inp.kind === "soil_moisture"
        ? ["Schwellwert", `${inp.threshold_pct || 0} %`]
        : ["Invertiert", inp.inverted ? "ja (Öffner)" : "nein"],
      ["Zugeordnet zu", used.length ? used.join(" · ") : "—"],
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
    const label = RESULT_LABEL[f.result] || f.result;
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
    // > 1000 L → m³ in the summary (the Verlauf table below stays in liters).
    const cell = (label, v) => `<div class="sum"><span class="sl">${esc(label)}</span><span class="sv">${esc(fmtVol(v))}</span></div>`;
    return `<h3>Verbrauch</h3><div class="sums">${
      cell("Heute", day) + cell("Monat", month) + cell("Vormonat", prevMonth) +
      cell("Jahr", year) + cell("Vorjahr", prevYear)}</div>`;
  }

  // Per-source Verlauf (same log, filtered by source_id) — like the line history,
  // but with the drawing line instead of the trigger (FR-D6 / Quellen-History).
  _sourceHistoryTable(sourceId) {
    const entries = this._history.filter((e) => e.source_id === sourceId).slice(0, 20);
    if (!entries.length) return `<h3>Verlauf</h3><div class="empty">Kein Verlauf.</div>`;
    const rows = entries
      .map(
        (e) => `<tr${FAULT_RESULTS.has(e.result) ? ' class="fault"' : ""}><td>${esc(fmtDateTime(e.start))}</td><td>${esc(this._lineName(e.line_id))}</td>
          <td>${fmtDur(e.duration_min)}</td>
          <td>${e.liters != null ? (e.approx ? "~" : "") + e.liters + " L" : "—"}</td>
          <td>${esc(RESULT_LABEL[e.result] || e.result || "")}</td></tr>`
      )
      .join("");
    return `<h3>Verlauf</h3><table class="hist"><thead>
      <tr><th>Datum/Zeit</th><th>Linie</th><th>Dauer</th><th>Liter</th><th>Ergebnis</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  _historyTable(lineId) {
    const entries = this._history.filter((e) => e.line_id === lineId).slice(0, 20);
    if (!entries.length) return `<div class="empty">Kein Verlauf.</div>`;
    const rows = entries
      .map(
        (e) => `<tr${FAULT_RESULTS.has(e.result) ? ' class="fault"' : ""}><td>${esc(fmtDateTime(e.start))}</td><td>${fmtDur(e.duration_min)}</td>
          <td>${e.liters != null ? (e.approx ? "~" : "") + e.liters + " L" : "—"}</td>
          <td>${esc(TRIGGER_LABEL[e.trigger] || e.trigger || "")}</td>
          <td>${esc(RESULT_LABEL[e.result] || e.result || "")}</td></tr>`
      )
      .join("");
    return `<h3>Verlauf</h3><table class="hist"><thead>
      <tr><th>Datum/Zeit</th><th>Dauer</th><th>Liter</th><th>Auslöser</th><th>Ergebnis</th></tr></thead>
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
      this._action({ type: "gardenesp/line/stop", line_id: e.currentTarget.dataset.stop }, "Stopp"));
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
    on("[data-go]", () => {
      const input = card.querySelector("[data-mininput]");
      const parsed = parseDurInput(input && input.value);
      const min = parsed > 0 ? parsed : this._inline.min; // empty/invalid → keep default
      const inl = this._inline;
      this._inline = null;
      this._action(
        { type: "gardenesp/line/start", line_id: inl.id, duration_min: min, force: !!inl.force },
        "Start"
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
// Volume for the consumption summary: liters, switching to m³ above 1000 L.
function fmtVol(liters) {
  const v = Number(liters) || 0;
  if (v >= 1000) return `${(v / 1000).toLocaleString("de-DE", { maximumFractionDigits: 2 })} m³`;
  return `${Math.round(v)} L`;
}
// Run duration: seconds below 1 min (so a quickly stopped run isn't shown as 0 min).
function fmtDur(min) {
  if (min == null) return "—";
  const m = Number(min);
  if (m < 1) return `${Math.round(m * 60)} s`;
  return `${Math.round(m * 10) / 10} min`;
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
  const t = String(str == null ? "" : str).trim();
  if (t === "") return 0;
  if (t.includes(":")) {
    const [mm, ss] = t.split(":");
    return (parseInt(mm, 10) || 0) + (parseInt(ss, 10) || 0) / 60;
  }
  return parseFloat(t) || 0;
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
  return d.toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtLast(e, omitResult) {
  const when = fmtDateTime(e.start);
  // A run that actually watered always shows its time + consumption, regardless
  // of how it ended (stopped/emergency/interrupted included) — the *reason* is
  // carried by the yellow Störung marker, not repeated here (CR-0011).
  const parts = [];
  if (e.duration_min != null && e.duration_min > 0) parts.push(fmtDur(e.duration_min));
  if (e.liters != null) parts.push(`${e.approx ? "~" : ""}${e.liters} L`);
  if (parts.length) return `${when} · ${parts.join("/")}`;
  // No watering recorded (instant skip). Show the reason label unless the yellow
  // fault marker already carries it (omitResult).
  if (!omitResult && e.result && e.result !== "completed") return `${when} · ${RESULT_LABEL[e.result] || e.result}`;
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
ha-card { padding: 12px 14px; position: relative; }
.hd { font-size: 16px; font-weight: 500; color: var(--primary-text-color); margin-bottom: 8px;
  display: flex; align-items: center; justify-content: space-between;
  background: var(--secondary-background-color); padding: 6px 10px; border-radius: 8px; }
.ttl { display: inline-flex; align-items: center; gap: 6px; }
.hd ha-icon { --mdc-icon-size: 20px; color: var(--primary-color); }
.open { text-decoration: none; font-size: 18px; color: var(--secondary-text-color); }
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
.iconbtn { border: none; background: transparent; cursor: pointer; padding: 4px; border-radius: 8px;
  display: inline-flex; align-items: center; }
.iconbtn ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
.iconbtn.primary ha-icon { color: var(--primary-color); }
.iconbtn.warn ha-icon { color: var(--warning-color, #ff9800); }
.iconbtn.stop ha-icon { color: var(--error-color, #f44336); }
.iconbtn:hover { background: var(--secondary-background-color); }
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
.mininput { width: 56px; padding: 5px 6px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color); color: var(--primary-text-color); }
.unit { font-size: 12px; color: var(--secondary-text-color); }
.bar { height: 5px; border-radius: 4px; margin-top: 6px; overflow: hidden; background: var(--divider-color, #eee); max-width: 260px; }
.bar > span { display: block; height: 100%; background: var(--primary-color); }
.empty { color: var(--secondary-text-color); padding: 6px 0; }
.empty.err { color: var(--error-color, #f44336); }
.fwbanner { display: block; margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; font-size: 13px;
  text-decoration: none; background: rgba(255, 152, 0, .16); color: var(--warning-color, #e65100); }
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
  window.customCards.push({
    type: "gardenesp-card",
    name: "GardenESP",
    description: "Dashboard: Bewässerungslinien, Quellen & Sensoren — Status, Steuerung, Verlauf.",
  });
}
