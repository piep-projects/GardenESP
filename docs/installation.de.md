# Installation

## Voraussetzungen

- Home Assistant **2024.7.0** oder neuer
- [ESPHome](https://esphome.io/) (Add-on oder CLI) zum Flashen des Steuergeräts
- Ein unterstütztes ESP32-Steuergerät → siehe [Hardware](hardware.md)

## Über HACS (empfohlen)

1. In HACS nach **GardenESP** suchen.
2. **GardenESP** installieren und Home Assistant neu starten.
3. **Einstellungen → Geräte & Dienste → Integration hinzufügen → GardenESP**.

Nach dem Hinzufügen erscheint **GardenESP** in der Seitenleiste (Panel) und die
Dashboard-Karte `custom:gardenesp-card` steht bereit.

Findet HACS GardenESP noch nicht, das Repository vorher als benutzerdefiniertes hinzufügen:
HACS → ⋮-Menü → **Benutzerdefinierte Repositories** → `piep-projects/GardenESP`, Kategorie **Integration**.

## Manuell

1. Den Ordner `custom_components/gardenesp/` aus diesem Repository nach
   `config/custom_components/` deiner HA-Installation kopieren.
2. Home Assistant neu starten.
3. Integration wie oben hinzufügen.

## Nächster Schritt

➡️ [Erstes Steuergerät & Flash](erste-box.md)
