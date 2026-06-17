# Erste Box & erster Flash

Eine **Box** ist ein ESP-Controller, der die Ventile schaltet und Sensoren liest.
Dieser Ablauf führt von der leeren Installation zur ersten lauffähigen Box.

!!! info "Reihenfolge"
    GardenESP **generiert** die ESPHome-Firmware aus deinen Einstellungen. Du legst die
    Box also zuerst im Panel an, flasht sie dann und bindest sie zuletzt als
    ESPHome-Gerät in HA ein.

## Überblick der Schritte

1. Box anlegen (Panel)
2. Ausgänge & Eingänge definieren
3. ESPHome-YAML generieren & flashen
4. Box in Home Assistant einbinden
5. Entitäten abgleichen
6. Erste Linie anlegen

## 1. Box anlegen

GardenESP-Panel (Seitenleiste) → Tab **Boxen** → **+ Neu**:

| Feld | Bedeutung |
|------|-----------|
| **Kürzel** | Kurzes Label (z. B. `A`). Erscheint als Chip vor Linien/Ausgängen und prägt den Entity-Präfix `gardenesp_box_a_*`. |
| **Name** | Beschreibender Name der Box. |
| **Hardware-Typ** | *GardenControl* (festes Pin-Profil) oder *ESP32-WROOM* / eigene generische Plattform (freie GPIO). Siehe [Hardware](hardware.md). |
| **In Betrieb** | Schalter; eine deaktivierte Box ist voll außer Betrieb (kein Plan, kein manueller Start). |

## 2. Ausgänge & Eingänge definieren

**Ausgänge** (`outputs`) = was geschaltet wird:

- **Ventil** (`valve`) — ein Magnetventil = später eine Bewässerungslinie.
- **Pumpe** (`pump`) — z. B. Zisternenpumpe; kann einem Ventil als *verbundenes Gerät* zugeordnet werden (läuft mit).
- **Sonstiges** (`other`) — generischer Schaltausgang für [Steuerungen](linien.md#steuerungen) (Springbrunnen, Kamera …).

Pro Ausgang setzt du die **Not-Aus-Zeit** (`emergency_shutdown_min`) — die on-device-
Sicherheitsabschaltung (siehe [Linien](linien.md)). Bei GardenControl wählst du den
Kanal (CH1–12 / R1–R2) aus einer Liste; bei WROOM den **GPIO**.

**Eingänge** (`inputs`) = was gelesen wird:

- **Regen-/Bodensensor** (Sperr-Sensor) — blockiert die Automatik bei Nässe.
- **Füllstand** (`level`) — Drucksensor der Zisterne (Rohwert → Liter per [Kalibrierung](quellen.md)).
- **Literzähler** (`meter`) — Pulszähler für Festwasser.

!!! tip "Verdrahtung prüfen"
    In der Boxen-Übersicht öffnet **🔌 Verdrahtung** ein Pinout-Schaltbild, das zeigt,
    welcher Ausgang/Eingang auf welchem Pin liegt — hilfreich vor dem Anschließen.

## 3. ESPHome-YAML generieren & flashen

1. Boxen-Übersicht → **🔒 YAML** zeigt die generierte ESPHome-Konfiguration (Admin).
2. YAML in deine **ESPHome**-Installation (Add-on/CLI) übernehmen und um die nötigen
   `secrets` (WLAN-SSID/Passwort, API-Key, OTA) ergänzen.
3. Box **flashen** — beim ersten Mal per USB, danach OTA über WLAN.

!!! note "Firmware-Drift"
    Das generierte YAML trägt einen Konfig-Hash. Ändert sich die Box-Konfiguration
    nach dem Flashen, zeigt GardenESP eine **Drift-Warnung** (Banner/Chip) — Läufe
    laufen weiter, ein Reflash löst die Warnung. Siehe [Fehlersuche](fehlersuche.md).

## 4. Box in Home Assistant einbinden

1. ESPHome meldet die geflashte Box → **Einstellungen → Geräte & Dienste** zeigt sie
   zur Einrichtung an (du brauchst den **API-Key** aus deinen ESPHome-Secrets).
2. Nach dem Hinzufügen existieren die `switch.*`/`sensor.*`-Entitäten der Box.

!!! warning "Flashen ≠ Einbinden"
    Eine geflashte Box ist erst nutzbar, wenn sie auch als **ESPHome-Gerät in HA**
    hinzugefügt wurde. Erst dann gibt es die Schalt- und Sensor-Entitäten, die
    GardenESP ansteuert.

## 5. Entitäten abgleichen

GardenESP löst die echten Entity-IDs der Box automatisch über die HA-Registry auf und
heilt sich nach einem Flash selbst. Falls doch etwas nicht zugeordnet ist (`—` statt
einer Entity):

- Tab **Allgemein** → **Entities abgleichen** für die Box.

Voraussetzung: Ausgangs-/Eingangs-**Namen sind je Box eindeutig**. Umlaute/ß werden
ASCII-gefaltet (ä→ae, ö→oe, ü→ue, ß→ss).

## 6. Erste Linie anlegen

Jetzt steht die Hardware. Weiter mit:

- [Linien & Zeitpläne](linien.md) — Ventil → Linie, Zeitplan, manueller Start
- [Wasserquellen](quellen.md) — Zisterne kalibrieren / Festwasser
- [Dashboard](dashboard.md) — die Lovelace-Karte einrichten
