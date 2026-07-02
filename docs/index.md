# GardenESP

**GardenESP** ist eine Home-Assistant-Custom-Integration mit eigenem Seitenleisten-Panel
zur Steuerung der Gartenbewässerung auf Basis von **ESPHome**-ESP32-Hardware.

## Auf einen Blick

- **Bewässerungslinien** — je eine Linie = ein Magnetventil, mit Status, Zeitplan und
  manuellem Start.
- **Wasserquellen** — Regenwasser-Zisterne (Drucksensor) oder Festwasser (Literzähler),
  je mit Verbrauchsauswertung.
- **Hardware** — mehrere ESP-Steuergeräte, gemischt (GardenControl oder ESP32-WROOM).
- **ESPHome-YAML wird generiert** — passend zur Hardware, direkt aus dem Panel.
- **Emergency-Shutdown am Gerät** — Sicherheitsabschaltung unabhängig von WLAN/HA.
- **Automatisierbar** — Linien aus HA-Automationen steuern (Dienste `gardenesp.start_line` /
  `stop_line`) und Binäreingänge als Taster nutzen. Siehe [Automationen & Dienste](automationen.md).

## Loslegen

1. [Installation](installation.md) — über HACS oder manuell
2. [Erstes Steuergerät & Flash](erste-box.md) — Steuergerät anlegen, YAML generieren, flashen, einbinden
3. [Hardware](hardware.md) — welches Board passt

!!! note "Feedback willkommen"
    Fehlt etwas oder ist eine Stelle unklar? Bitte ein
    [Issue](https://github.com/piep-projects/GardenESP/issues) öffnen.
