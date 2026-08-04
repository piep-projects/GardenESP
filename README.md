# 🌱 GardenESP

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]
[![validate][validate-badge]][validate-url]

**Home Assistant integration for garden irrigation** on **ESPHome**-based ESP32 hardware —
with its own sidebar panel and a dashboard card. Multiple irrigation lines (one solenoid valve
each), water sources (a cistern with a level sensor, or mains water with a meter), schedules,
rain/soil blocking sensors and an **on-device emergency shutdown** as a safety cut-off.

The interface follows your Home Assistant language — **English and German** are both fully
supported.

> 📖 Full documentation: **[piep-projects.github.io/GardenESP][docs-url]**
> · 🇩🇪 [Deutsche Fassung][docs-url-de]

---

## Quick start

From an empty HA to your first running line — the six steps at a glance.

### 1 · Install the integration

**HACS** (recommended): HACS → **⋮ → Custom repositories** → `piep-projects/GardenESP`,
category **Integration** → install → **restart Home Assistant**.

[![Add to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=piep-projects&repository=GardenESP&category=integration)

> _Or manually:_ copy `custom_components/gardenesp/` into `config/custom_components/` and restart HA.

### 2 · Add the integration

**Settings → Devices & services → Add integration → GardenESP**.
**GardenESP** then appears in the sidebar (the panel) and the card `custom:gardenesp-card` is ready.

### 3 · Create your first controller

Panel → tab **Hardware** → **+ New**: short code + name, pick the **platform** (*GardenControl* or
*ESP32-WROOM*), then add **outputs** (valves/pumps) and **inputs** (rain/soil sensor, level sensor,
water meter). Set a sensible **emergency shutdown time** per valve.

### 4 · Flash the firmware

Hardware overview → **🔒 YAML** shows the generated ESPHome configuration. Take it over into
**ESPHome**, add your `secrets` (Wi-Fi, API key) and flash the controller (USB first, OTA later).

### 5 · Add the controller to Home Assistant

ESPHome announces the flashed controller → **Settings → Devices & services** sets it up (API key from
your ESPHome secrets). Only after that do the `switch.*` / `sensor.*` entities exist.

> ⚠️ **Flashing ≠ adding** — a flashed controller only becomes usable once it has also been added as
> an ESPHome device in HA. If outputs/inputs stay unassigned: panel → **General → Match entities**.

### 6 · Create a line → done

Panel → tab **Lines** → **+ New**: pick the valve and the source, optionally a blocking sensor and a
schedule. On the **dashboard** you start lines manually (▶) and see status, remaining time and
consumption.

✅ That's it. Everything else (calibration, controls, topology/wiring, troubleshooting) is in the docs.

---

## Requirements

- Home Assistant **2024.6.0+** (brand icon from **2026.3**), [ESPHome](https://esphome.io/) for flashing
- A supported ESP32 controller → [Hardware][docs-hardware] (Smart-MF GardenControl or ESP32-WROOM)

## Learn more (optional)

| Topic | |
|---|---|
| [First controller & flash][docs-firstbox] | In detail, with field tables |
| [Lines & schedules][docs-lines] · [Water sources][docs-sources] · [Dashboard][docs-dash] | Using GardenESP |
| [Hardware][docs-hardware] · [Troubleshooting][docs-trouble] | Reference & help |

Inside the app, the **"? Help"** link (panel header) leads straight into these docs.

## Contributing / support

Please report bugs and ideas as an [issue][issues-url]. Pull requests are welcome.

## License

MIT © piep-projects

<!-- badges -->
[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[hacs-url]: https://hacs.xyz/
[release-badge]: https://img.shields.io/github/v/release/piep-projects/GardenESP
[release-url]: https://github.com/piep-projects/GardenESP/releases
[validate-badge]: https://github.com/piep-projects/GardenESP/actions/workflows/validate.yml/badge.svg
[validate-url]: https://github.com/piep-projects/GardenESP/actions/workflows/validate.yml
[docs-url]: https://piep-projects.github.io/GardenESP/
[docs-url-de]: https://piep-projects.github.io/GardenESP/de/
[docs-firstbox]: https://piep-projects.github.io/GardenESP/erste-box/
[docs-lines]: https://piep-projects.github.io/GardenESP/linien/
[docs-sources]: https://piep-projects.github.io/GardenESP/quellen/
[docs-dash]: https://piep-projects.github.io/GardenESP/dashboard/
[docs-hardware]: https://piep-projects.github.io/GardenESP/hardware/
[docs-trouble]: https://piep-projects.github.io/GardenESP/fehlersuche/
[issues-url]: https://github.com/piep-projects/GardenESP/issues
