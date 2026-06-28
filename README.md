# 🌱 GardenESP

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]
[![validate][validate-badge]][validate-url]

**Home-Assistant-Integration zur Gartenbewässerung** auf Basis von **ESPHome**-ESP32-Hardware —
mit eigenem Seitenleisten-Panel und Dashboard-Karte. Mehrere Bewässerungslinien (je ein
Magnetventil), Wasserquellen (Zisterne mit Füllstand oder Festwasser mit Literzähler), Zeitpläne,
Regen-/Boden-Sperren und ein **on-device Emergency-Shutdown** als Sicherheitsabschaltung.

> 📖 Ausführliche Doku (optional): **[piep-projects.github.io/GardenESP][docs-url]**

---

## Schnellstart

Vom leeren HA zur ersten laufenden Linie — die sechs Schritte im Überblick.

### 1 · Integration installieren

**HACS** (empfohlen): HACS → **⋮ → Benutzerdefinierte Repositories** → `piep-projects/GardenESP`,
Kategorie **Integration** → installieren → **Home Assistant neu starten**.

[![Add to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=piep-projects&repository=GardenESP&category=integration)

> _Alternativ manuell:_ `custom_components/gardenesp/` nach `config/custom_components/` kopieren und HA neu starten.

### 2 · Integration hinzufügen

**Einstellungen → Geräte & Dienste → Integration hinzufügen → GardenESP**.
Danach erscheint **GardenESP** in der Seitenleiste (Panel) und die Karte `custom:gardenesp-card` steht bereit.

### 3 · Erste Box anlegen

Panel → Tab **Boxen** → **+ Neu**: Kürzel + Name, **Hardware-Typ** wählen (*GardenControl* oder
*ESP32-WROOM*), dann **Ausgänge** (Ventile/Pumpen) und **Eingänge** (Regen-/Bodensensor, Füllstand,
Literzähler) anlegen. Pro Ventil eine sinnvolle **Not-Aus-Zeit** setzen.

### 4 · Firmware flashen

Boxen-Übersicht → **🔒 YAML** zeigt die generierte ESPHome-Konfiguration. In **ESPHome** übernehmen,
um deine `secrets` (WLAN, API-Key) ergänzen und die Box flashen (erst USB, später OTA).

### 5 · Box in Home Assistant einbinden

ESPHome meldet die geflashte Box → **Einstellungen → Geräte & Dienste** richtet sie ein (API-Key aus
den ESPHome-Secrets). Erst danach existieren die `switch.*`/`sensor.*`-Entitäten.

> ⚠️ **Flashen ≠ Einbinden** — eine geflashte Box ist erst nutzbar, wenn sie auch als ESPHome-Gerät in
> HA hinzugefügt wurde. Sind Aus-/Eingänge nicht zugeordnet: Panel → **Allgemein → Entities abgleichen**.

### 6 · Linie anlegen → fertig

Panel → Tab **Linien** → **+ Neu**: Ventil + Quelle wählen, optional Sperr-Sensor und Zeitplan.
Im **Dashboard** startest du Linien manuell (▶) und siehst Status, Restzeit und Verbrauch.

✅ Das war's. Alles Weitere (Kalibrierung, Steuerungen, Topologie/Verdrahtung, Fehlersuche) steht in der Doku.

---

## Voraussetzungen

- Home Assistant **2024.6.0+** (Brand-Icon ab **2026.3**), [ESPHome](https://esphome.io/) zum Flashen
- Eine unterstützte ESP32-Box → [Hardware][docs-hardware] (Smart-MF GardenControl oder ESP32-WROOM)

## Mehr erfahren (optional)

| Thema | |
|---|---|
| [Erste Box & Flash][docs-firstbox] | Ausführlich, mit Feld-Tabellen |
| [Linien & Zeitpläne][docs-lines] · [Wasserquellen][docs-sources] · [Dashboard][docs-dash] | Bedienung |
| [Hardware][docs-hardware] · [Fehlersuche][docs-trouble] | Referenz & Hilfe |

In der App führt der **„? Hilfe"-Link** (Panel-Kopfzeile) direkt in diese Doku.

## Mitwirken / Support

Fehler & Wünsche bitte als [Issue][issues-url]. Pull Requests willkommen.

## Lizenz

MIT © piep-projects

<!-- badges -->
[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[hacs-url]: https://hacs.xyz/
[release-badge]: https://img.shields.io/github/v/release/piep-projects/GardenESP
[release-url]: https://github.com/piep-projects/GardenESP/releases
[validate-badge]: https://github.com/piep-projects/GardenESP/actions/workflows/validate.yml/badge.svg
[validate-url]: https://github.com/piep-projects/GardenESP/actions/workflows/validate.yml
[docs-url]: https://piep-projects.github.io/GardenESP/
[docs-firstbox]: https://piep-projects.github.io/GardenESP/erste-box/
[docs-lines]: https://piep-projects.github.io/GardenESP/linien/
[docs-sources]: https://piep-projects.github.io/GardenESP/quellen/
[docs-dash]: https://piep-projects.github.io/GardenESP/dashboard/
[docs-hardware]: https://piep-projects.github.io/GardenESP/hardware/
[docs-trouble]: https://piep-projects.github.io/GardenESP/fehlersuche/
[issues-url]: https://github.com/piep-projects/GardenESP/issues
