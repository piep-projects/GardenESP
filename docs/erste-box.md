# First controller & first flash

A **controller** is an ESP board that switches the valves and reads the sensors. This
walk-through takes you from an empty installation to your first working controller.

!!! info "The order matters"
    GardenESP **generates** the ESPHome firmware from your settings. So you create the
    controller in the panel first, then flash it, and only then add it to HA as an ESPHome
    device.

## The steps at a glance

1. Create the controller (panel)
2. Define outputs & inputs
3. Generate the ESPHome YAML & flash it
4. Add the controller to Home Assistant
5. Match the entities
6. Create your first line

## 1. Create the controller

GardenESP panel (sidebar) → tab **Hardware** → **+ New**:

| Field | Meaning |
|------|-----------|
| **Short code** | A short label (e.g. `A`). It appears as a chip in front of lines and outputs and shapes the entity prefix `gardenesp_steuergeraet_a_*`. |
| **Name** | A descriptive name for the controller. |
| **Platform** | *GardenControl* (fixed pin profile) or *ESP32-WROOM* / your own generic platform (free GPIO). See [Hardware](hardware.md). |
| **Enabled** | A toggle; a disabled controller is fully out of service (no schedule, no manual start). |

!!! warning "Keep the short code unique across your network"
    The ESPHome device name is derived from the short code
    (`gardenesp-steuergeraet-<short code>`). Within one HA instance the panel assigns free
    short codes automatically. But if you run **several GardenESP instances on the same
    network** (for example test + production), their short codes must **not** overlap —
    otherwise two devices carry the same mDNS name and HA connects to the wrong one (symptom:
    *"Invalid encryption key"* despite a correct key, because the other device answered).
    Give such controllers different short codes (e.g. production `A`, test `T`).

## 2. Define outputs & inputs

**Outputs** = what gets switched:

- **Valve** (`valve`) — one solenoid valve, which later becomes an irrigation line.
- **Pump** (`pump`) — e.g. a cistern pump; it can be attached to a valve as a *connected
  device* (running alongside it).
- **Other** (`other`) — a generic switched output for [controls](linien.md#controls)
  (a fountain, a camera …).

For every output you set the **emergency shutdown time** (`emergency_shutdown_min`) — the
on-device safety cut-off (see [Lines](linien.md)). On GardenControl you pick the channel
(CH1–12 / R1–R2) from a list; on WROOM you pick the **GPIO**.

**Inputs** = what gets read:

- **Rain / soil sensor** (blocking sensor) — blocks the automatic schedule while wet.
- **Pressure sensor** — the cistern's level sensor (raw value → litres via
  [calibration](quellen.md)).
- **Water meter** — a pulse counter for mains water.
- **Button / switch** — a generic binary input with no irrigation meaning; it shows up as an
  ordinary `binary_sensor` in HA and can be used freely in
  [automations](automationen.md) (a button starting a line, for instance).

!!! tip "Check the wiring"
    In the hardware overview, **🔌 Wiring** opens a pinout diagram showing which output or
    input sits on which pin — handy before you connect anything.

## 3. Generate the ESPHome YAML & flash it

In the hardware overview, **🔒 YAML** shows the generated ESPHome configuration (admin only).
You take that over into ESPHome, add your **secrets** once (Wi-Fi, API key, OTA) and **flash**
the controller — over USB the first time, wirelessly after that.

➡️ **Step by step (beginner-friendly):** [ESPHome: secrets, flashing & adding to HA](esphome.md)

!!! note "Firmware drift"
    The generated YAML carries a configuration hash. If the controller's configuration
    changes after flashing, GardenESP shows a **drift warning** (banner/chip) — runs keep
    working, and a reflash clears the warning. See [Troubleshooting](fehlersuche.md).

## 4. Add the controller to Home Assistant

After flashing, **HA discovers the controller automatically** (Settings → Devices & services);
during setup you enter the **API encryption key** from your secrets. From then on the
controller's `switch.*` and `sensor.*` entities exist. In detail in the
[ESPHome guide](esphome.md).

!!! warning "Flashing ≠ adding"
    A flashed controller only becomes usable once it has also been added as an **ESPHome
    device in HA**. Only then do the switch and sensor entities exist that GardenESP drives.

## 5. Match the entities

GardenESP resolves the controller's real entity ids automatically against the HA registry and
heals itself after a flash. If something is still unassigned (`—` instead of an entity):

- Tab **General** → **Match entities** for that controller.

Prerequisite: output and input **names are unique per controller**. Umlauts and ß are folded
to ASCII (ä→ae, ö→oe, ü→ue, ß→ss).

## 6. Create your first line

The hardware is in place. Carry on with:

- [Lines & schedules](linien.md) — valve → line, schedule, manual start
- [Water sources](quellen.md) — calibrate a cistern / set up mains water
- [Dashboard](dashboard.md) — set up the Lovelace card
