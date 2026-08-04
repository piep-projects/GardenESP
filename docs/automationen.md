# Automations & services

GardenESP can be driven from **Home Assistant automations** in two ways: the **services**
`gardenesp.start_line` / `gardenesp.stop_line` (starting and stopping a line cleanly) and
**binary inputs** (buttons/switches) as triggers.

## Services: `gardenesp.start_line` / `stop_line`

With these services you drive an irrigation line from your own logic (e.g. an
**ET0 / weather-based schedule**) — through **the same path as the panel and the card**
(source lock, rain and level gates, consumption logging, cistern settling time).

!!! tip "Why not switch the valve `switch` directly?"
    A plain `switch.turn_on` on the valve bypasses **everything** — the source lock, the
    blocking sensors, the consumption measurement and the settling time. Only the on-device
    emergency shutdown would remain as a safeguard. The services are the intended route for
    external control.

### `gardenesp.start_line`

| Field | Required | Meaning |
|------|---------|-----------|
| `line_id` | yes | The **raw line id** (e.g. `ln_ff3a7f58`). Shown in the panel's line and control overview as **"ID (for the service)"** — not to be confused with the display id `L<n>`. |
| `duration_min` | no | Run time in minutes (decimals are seconds, e.g. `0.5` = 30 s). Empty = the line's manual default duration. |
| `force` | no | `true` = **"start anyway"** — overrides a blocking sensor (rain). The source's level and dry-run protection stay active. |

### `gardenesp.stop_line`

| Field | Required | Meaning |
|------|---------|-----------|
| `line_id` | yes | The raw line id of the line to stop. |

!!! note "Unknown `line_id`"
    An unknown id produces a clean validation error through the service calls (automation,
    Developer tools → Actions).

### Example: start a line on a timer with your own duration

```yaml
automation:
  - alias: "Tomatoes, 6 minutes in the morning"
    trigger:
      - platform: time
        at: "06:00:00"
    action:
      - service: gardenesp.start_line
        data:
          line_id: ln_ff3a7f58
          duration_min: 6
```

## Binary inputs as buttons/switches

Every binary input of a controller is visible in Home Assistant as an ordinary
**`binary_sensor`** (`binary_sensor.gardenesp_steuergeraet_<x>_<name>`) and can be used in any
automation as a **trigger** or condition — regardless of whether GardenESP uses it internally.

So that an input carries a **meaningful name** and is **not** treated as a blocking sensor,
set it up in the controller editor with the type **Button / switch** (see
[First controller](erste-box.md)). The input is then flashed as a plain `binary_sensor` —
with no irrigation meaning, and therefore **not** offered in a line's blocking-sensor list.

!!! info "GardenControl & WROOM"
    GardenControl has **3 binary inputs** (BIN1–3) that rain, the S0 water meter and buttons
    **share** — if one is taken by a water meter, it is no longer available as a button. On
    ESP32-WROOM you take any free GPIO. The **polarity** (idle = on/off) is set on the input
    with the invert selector.

### Example: a button starts a line

```yaml
automation:
  - alias: "Patio button → lawn for 10 min"
    trigger:
      - platform: state
        entity_id: binary_sensor.gardenesp_steuergeraet_a_taster_terrasse
        to: "on"
    action:
      - service: gardenesp.start_line
        data:
          line_id: ln_ff3a7f58
          duration_min: 10
```

!!! tip "A deliberate separation"
    GardenESP offers **no** built-in "button → action" binding. That logic lives in HA
    automations on the raw `binary_sensor` entity — more flexible, and without duplicating the
    irrigation logic.
