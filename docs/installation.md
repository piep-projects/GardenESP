# Installation

## Requirements

- Home Assistant **2024.7.0** or newer
- [ESPHome](https://esphome.io/) (add-on or CLI) to flash the controller
- A supported ESP32 controller → see [Hardware](hardware.md)

## Via HACS (recommended)

1. Search for **GardenESP** in HACS.
2. Install **GardenESP** and restart Home Assistant.
3. **Settings → Devices & services → Add integration → GardenESP**.

Once added, **GardenESP** appears in the sidebar (the panel) and the dashboard card
`custom:gardenesp-card` becomes available.

If HACS doesn't find GardenESP yet, add it as a custom repository first:
HACS → ⋮ menu → **Custom repositories** → `piep-projects/GardenESP`, category **Integration**.

## Manually

1. Copy the folder `custom_components/gardenesp/` from this repository into
   `config/custom_components/` of your HA installation.
2. Restart Home Assistant.
3. Add the integration as described above.

## Next step

➡️ [First controller & flash](erste-box.md)
