# GardenESP

**GardenESP** ist eine Home-Assistant-Custom-Integration mit eigenem Seitenleisten-Panel
zur Steuerung der Gartenbewässerung auf Basis von **ESPHome**-ESP32-Hardware.

## Auf einen Blick

- **Bewässerungslinien** — je eine Linie = ein Magnetventil, mit Status, Zeitplan und
  manuellem Start.
- **Wasserquellen** — Regenwasser-Zisterne (Drucksensor) oder Festwasser (Literzähler),
  je mit Verbrauchsauswertung.
- **Boxen** — mehrere ESP-Controller, gemischt (GardenControl oder ESP32-WROOM).
- **ESPHome-YAML wird generiert** — passend zur Hardware, direkt aus dem Panel.
- **Emergency-Shutdown am Gerät** — Sicherheitsabschaltung unabhängig von WLAN/HA.

## Loslegen

1. [Installation](installation.md) — über HACS oder manuell
2. [Erste Box & Flash](erste-box.md) — Box anlegen, YAML generieren, flashen, einbinden
3. [Hardware](hardware.md) — welches Board passt

!!! note "Feedback willkommen"
    Fehlt etwas oder ist eine Stelle unklar? Bitte ein
    [Issue](https://github.com/piep-projects/GardenESP/issues) öffnen.
