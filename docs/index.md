# GardenESP

**GardenESP** is a Home Assistant custom integration with its own sidebar panel for
running your garden irrigation on **ESPHome**-based ESP32 hardware.

## At a glance

- **Irrigation lines** — one line = one solenoid valve, with status, schedule and
  manual start.
- **Water sources** — a rainwater cistern (pressure sensor) or mains water (water
  meter), each with consumption tracking.
- **Hardware** — several ESP controllers, mixed types (GardenControl or ESP32-WROOM).
- **ESPHome YAML is generated** — matching your hardware, straight from the panel.
- **On-device emergency shutdown** — a safety cut-off that works without Wi-Fi or HA.
- **Automatable** — drive lines from HA automations (services `gardenesp.start_line` /
  `stop_line`) and use binary inputs as buttons. See [Automations & services](automationen.md).

## Getting started

1. [Installation](installation.md) — via HACS or manually
2. [First controller & flash](erste-box.md) — create a controller, generate the YAML, flash it, add it to HA
3. [Hardware](hardware.md) — which board fits

!!! note "Feedback welcome"
    Something missing or unclear? Please open an
    [issue](https://github.com/piep-projects/GardenESP/issues).
