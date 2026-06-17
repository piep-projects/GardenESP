# Installation

## Voraussetzungen

- Home Assistant **2024.6.0** oder neuer
- [ESPHome](https://esphome.io/) (Add-on oder CLI) zum Flashen der Box
- Eine unterstützte ESP32-Box → siehe [Hardware](hardware.md)

## Über HACS (empfohlen)

1. In HACS → **Integrationen** → ⋮-Menü → **Benutzerdefinierte Repositories**.
2. Repository `piep-projects/GardenESP` mit Kategorie **Integration** hinzufügen.
3. **GardenESP** installieren und Home Assistant neu starten.
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → GardenESP**.

Nach dem Hinzufügen erscheint **GardenESP** in der Seitenleiste (Panel) und die
Dashboard-Karte `custom:gardenesp-card` steht bereit.

## Manuell

1. Den Ordner `custom_components/gardenesp/` aus diesem Repository nach
   `config/custom_components/` deiner HA-Installation kopieren.
2. Home Assistant neu starten.
3. Integration wie oben hinzufügen.

## Nächster Schritt

➡️ [Erste Box & Flash](erste-box.md)
