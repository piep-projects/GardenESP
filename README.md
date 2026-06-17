# 🌱 GardenESP

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]
[![validate][validate-badge]][validate-url]

**GardenESP** ist eine [Home Assistant](https://www.home-assistant.io/)
**Custom-Integration** mit eigenem Seitenleisten-Panel zur Steuerung der
**Gartenbewässerung** auf Basis von **ESPHome**-ESP32-Hardware.

Mehrere Bewässerungslinien (je ein Magnetventil), Wasserquellen (Zisterne mit
Füllstandssensor oder Festwasser mit Literzähler), Zeitpläne, Regen-/Boden-Sperren
und ein **on-device Emergency-Shutdown** als Sicherheitsabschaltung — zentral in HA
verwaltet, lauffähig auch ohne WLAN/HA-Verbindung.

> 📖 **Vollständige Dokumentation:** **[piep-projects.github.io/GardenESP][docs-url]**

---

## Funktionen

- **Bewässerungslinien** — je eine Linie = ein Magnetventil; Status, Zeitplan und
  manueller Start, Live-Restzeit-Countdown.
- **Wasserquellen** — Regenwasser-Zisterne (Drucksensor, Stützpunkt-Kalibrierung) und
  Festwasser (Literzähler), je mit Verbrauchsauswertung (Heute/Monat/Jahr …).
- **Boxen** — beliebig viele ESP-Controller, gemischt: FH-Engineering *GardenControl*
  oder selbstgebautes *ESP32-WROOM*-Board.
- **ESPHome-YAML wird generiert** — passend zur gewählten Hardware, direkt aus dem Panel.
- **Sicherheit** — Emergency-Shutdown am Gerät (unabhängig von WLAN/HA), getrennter
  Sicherheits-Stopp pro Linie, Firmware-Drift-Erkennung.
- **Dashboard-Karte** (`custom:gardenesp-card`) — mobile-first, plus Einstellungs-Panel
  mit Topologie- und Verdrahtungs-Ansicht.

## Voraussetzungen

- Home Assistant **2024.6.0** oder neuer
- [ESPHome](https://esphome.io/) (Add-on oder CLI) zum Flashen der Box
- Eine unterstützte ESP32-Box → siehe [Hardware][docs-hardware]

## Installation

### Über HACS (empfohlen)

1. HACS → **Integrationen** → ⋮ → **Benutzerdefinierte Repositories**
2. Repository `piep-projects/GardenESP`, Kategorie **Integration** hinzufügen
3. **GardenESP** installieren und Home Assistant neu starten
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → GardenESP**

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=piep-projects&repository=GardenESP&category=integration)

### Manuell

`custom_components/gardenesp/` in das `config/custom_components/`-Verzeichnis deiner
HA-Installation kopieren und HA neu starten.

## Erste Schritte

Nach der Installation legst du im **GardenESP-Panel** (Seitenleiste) deine erste Box an,
generierst das ESPHome-YAML, flasht die Box und bindest sie in HA ein. Der vollständige
Ablauf inkl. erstem Flash steht in der Doku:

➡️ **[Erste Box & erster Flash][docs-firstbox]**

## Dokumentation

| Thema | |
|---|---|
| [Installation][docs-url] | HACS & manuell |
| [Erste Box & Flash][docs-firstbox] | Onboarding-Schritt für Schritt |
| [Hardware][docs-hardware] | GardenControl vs. ESP32-WROOM |
| [Linien & Zeitpläne][docs-url] · [Quellen][docs-url] · [Dashboard][docs-url] · [Fehlersuche][docs-url] | Referenz |

## Mitwirken / Support

Fehler und Wünsche bitte als [Issue][issues-url]. Pull Requests willkommen.

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
[docs-hardware]: https://piep-projects.github.io/GardenESP/hardware/
[issues-url]: https://github.com/piep-projects/GardenESP/issues
