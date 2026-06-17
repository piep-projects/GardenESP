# Erste Box & erster Flash

Eine **Box** ist ein ESP-Controller, der die Ventile schaltet und Sensoren liest.
Dieser Ablauf führt von der leeren Installation zur ersten lauffähigen Box.

!!! info "Reihenfolge"
    GardenESP **generiert** die ESPHome-Firmware aus deinen Einstellungen. Du legst die
    Box also zuerst im Panel an, flasht sie dann und bindest sie zuletzt als
    ESPHome-Gerät in HA ein.

## 1. Box anlegen

1. GardenESP-Panel (Seitenleiste) → Tab **Boxen** → **Hinzufügen**.
2. **Kürzel** (z. B. `A`) und Name vergeben.
3. **Hardware-Typ** wählen: *GardenControl* oder *ESP32-WROOM* → siehe [Hardware](hardware.md).
4. **Ausgänge** (Ventile/Pumpen) und **Eingänge** (Regen-/Bodensensor, Füllstand,
   Literzähler) anlegen.

## 2. ESPHome-YAML generieren & flashen

1. In der Boxen-Übersicht → **🔒 YAML** öffnet die generierte ESPHome-Konfiguration.
2. YAML in deine ESPHome-Installation übernehmen und mit den nötigen `secrets`
   (WLAN etc.) ergänzen.
3. Box per ESPHome **flashen** (USB beim ersten Mal, danach OTA).

## 3. Box in Home Assistant einbinden

1. ESPHome meldet die Box → **Einstellungen → Geräte & Dienste** zeigt sie zur
   Einrichtung an (API-Key aus deinen ESPHome-Secrets).
2. Nach dem Hinzufügen existieren die `switch.*`/`sensor.*`-Entitäten der Box.

!!! warning "Flashen ≠ Einbinden"
    Eine geflashte Box ist erst nutzbar, wenn sie auch als **ESPHome-Gerät in HA**
    hinzugefügt wurde. Erst dann gibt es die Schalt- und Sensor-Entitäten.

## 4. Entitäten abgleichen

GardenESP löst die echten Entity-IDs der Box automatisch über die HA-Registry auf.
Falls nach dem Flashen etwas nicht zugeordnet ist:

- Tab **Allgemein** → **Entities abgleichen** für die Box.

## Weiter

- [Linien & Zeitpläne](linien.md) anlegen
- [Wasserquellen](quellen.md) (Zisterne/Festwasser) einrichten
- [Dashboard](dashboard.md) einrichten
