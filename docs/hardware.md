# Hardware

GardenESP supports two platforms per controller, selected via `hw_type`. The type
determines which ESPHome YAML template is used.

## Smart-MF GardenControl

ESP32 + MCP23017 I/O expander, 12× 24 VAC solenoid valve outputs, 2× 230 V relays
(pumps), PCF8575 status LEDs, ADS1115 (4-20 mA inputs). A fixed, board-accurate template.

## ESP32-WROOM (self-built)

Direct GPIO (~8 channels), relays optionally integrated, no LEDs. Pins are assigned
freely per output/input in the controller editor.

## Sensors

- **Cistern fill level** — pressure sensor (4-20 mA via ADS1115 **or** analog), converted
  from raw to litres by a [support-point calibration](quellen.md).
  The sensor type is **not** tied to `hw_type`.
- **Mains water** — water meter (pulse counter).
- **Blocking sensors** — rain (e.g. RainClik) or soil moisture, as a controller input.

!!! tip "Wiring"
    The panel offers a read-only **wiring lens** per controller (a pinout diagram)
    showing which outputs and inputs sit on which pins.
