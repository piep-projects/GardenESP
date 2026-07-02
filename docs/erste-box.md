# Erstes Steuergerät & erster Flash

Ein **Steuergerät** ist ein ESP-Controller, der die Ventile schaltet und Sensoren liest.
Dieser Ablauf führt von der leeren Installation zum ersten lauffähigen Steuergerät.

!!! info "Reihenfolge"
    GardenESP **generiert** die ESPHome-Firmware aus deinen Einstellungen. Du legst das
    Steuergerät also zuerst im Panel an, flasht es dann und bindest es zuletzt als
    ESPHome-Gerät in HA ein.

## Überblick der Schritte

1. Steuergerät anlegen (Panel)
2. Ausgänge & Eingänge definieren
3. ESPHome-YAML generieren & flashen
4. Steuergerät in Home Assistant einbinden
5. Entitäten abgleichen
6. Erste Linie anlegen

## 1. Steuergerät anlegen

GardenESP-Panel (Seitenleiste) → Tab **Hardware** → **+ Neu**:

| Feld | Bedeutung |
|------|-----------|
| **Kürzel** | Kurzes Label (z. B. `A`). Erscheint als Chip vor Linien/Ausgängen und prägt den Entity-Präfix `gardenesp_steuergeraet_a_*`. |
| **Name** | Beschreibender Name des Steuergeräts. |
| **Hardware-Typ** | *GardenControl* (festes Pin-Profil) oder *ESP32-WROOM* / eigene generische Plattform (freie GPIO). Siehe [Hardware](hardware.md). |
| **In Betrieb** | Schalter; ein deaktiviertes Steuergerät ist voll außer Betrieb (kein Plan, kein manueller Start). |

!!! warning "Kürzel netzwerkweit eindeutig halten"
    Der ESPHome-Gerätename leitet sich aus dem Kürzel ab (`gardenesp-steuergeraet-<Kürzel>`).
    Innerhalb einer HA-Instanz vergibt das Panel automatisch freie Kürzel. Betreibst du
    aber **mehrere GardenESP-Instanzen im selben Netzwerk** (z. B. Test + Produktiv), dürfen
    sich deren Kürzel **nicht überschneiden** — sonst tragen zwei Geräte denselben mDNS-Namen,
    und HA verbindet sich zum falschen (Symptom: *„Invalid encryption key"* trotz korrektem
    Schlüssel, weil das andere Gerät antwortet). Gib solchen Steuergeräten unterschiedliche
    Kürzel (z. B. Produktiv `A`, Test `T`).

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
- **Taster / Schalter** (`button`) — ein generischer Binäreingang ohne Bewässerungs-
  Bedeutung; wird als normaler `binary_sensor` in HA sichtbar und lässt sich in
  [Automationen](automationen.md) frei verwenden (z. B. ein Taster startet eine Linie).

!!! tip "Verdrahtung prüfen"
    In der Hardware-Übersicht öffnet **🔌 Verdrahtung** ein Pinout-Schaltbild, das zeigt,
    welcher Ausgang/Eingang auf welchem Pin liegt — hilfreich vor dem Anschließen.

## 3. ESPHome-YAML generieren & flashen

In der Hardware-Übersicht zeigt **🔒 YAML** die generierte ESPHome-Konfiguration (Admin).
Diese übernimmst du in ESPHome, ergänzt einmalig deine **Secrets** (WLAN, API-Schlüssel,
OTA) und **flashst** das Steuergerät — beim ersten Mal per USB, danach drahtlos.

➡️ **Schritt für Schritt (einsteigerfreundlich):** [ESPHome: Secrets, Flashen & Einbinden](esphome.md)

!!! note "Firmware-Drift"
    Das generierte YAML trägt einen Konfig-Hash. Ändert sich die Steuergerät-Konfiguration
    nach dem Flashen, zeigt GardenESP eine **Drift-Warnung** (Banner/Chip) — Läufe
    laufen weiter, ein Reflash löst die Warnung. Siehe [Fehlersuche](fehlersuche.md).

## 4. Steuergerät in Home Assistant einbinden

Nach dem Flashen **entdeckt HA das Steuergerät automatisch** (Einstellungen → Geräte & Dienste);
beim Einrichten gibst du den **API-Verschlüsselungsschlüssel** aus deinen Secrets ein.
Danach existieren die `switch.*`/`sensor.*`-Entitäten des Steuergeräts. Ausführlich in der
[ESPHome-Anleitung](esphome.md).

!!! warning "Flashen ≠ Einbinden"
    Ein geflashtes Steuergerät ist erst nutzbar, wenn es auch als **ESPHome-Gerät in HA**
    hinzugefügt wurde. Erst dann gibt es die Schalt- und Sensor-Entitäten, die
    GardenESP ansteuert.

## 5. Entitäten abgleichen

GardenESP löst die echten Entity-IDs des Steuergeräts automatisch über die HA-Registry auf und
heilt sich nach einem Flash selbst. Falls doch etwas nicht zugeordnet ist (`—` statt
einer Entity):

- Tab **Allgemein** → **Entities abgleichen** für das Steuergerät.

Voraussetzung: Ausgangs-/Eingangs-**Namen sind je Steuergerät eindeutig**. Umlaute/ß werden
ASCII-gefaltet (ä→ae, ö→oe, ü→ue, ß→ss).

## 6. Erste Linie anlegen

Jetzt steht die Hardware. Weiter mit:

- [Linien & Zeitpläne](linien.md) — Ventil → Linie, Zeitplan, manueller Start
- [Wasserquellen](quellen.md) — Zisterne kalibrieren / Festwasser
- [Dashboard](dashboard.md) — die Lovelace-Karte einrichten
