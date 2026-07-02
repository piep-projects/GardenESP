# Automationen & Dienste

GardenESP lässt sich aus **Home-Assistant-Automationen** heraus steuern — zwei Wege:
die **Dienste** `gardenesp.start_line` / `gardenesp.stop_line` (eine Linie sauber starten/
stoppen) und **Binäreingänge** (Taster/Schalter) als Auslöser.

## Dienste: `gardenesp.start_line` / `stop_line`

Mit diesen Diensten steuerst du eine Bewässerungslinie aus eigener Logik (z. B. einer
**ET0-/Wetter-Bewässerung**) — über **denselben Pfad wie Panel und Karte** (Quellen-Sperre,
Regen-/Pegel-Gates, Verbrauchs-Logging, Zisternen-Nachlauf).

!!! tip "Warum nicht den Ventil-`switch` direkt schalten?"
    Ein direktes `switch.turn_on` am Ventil umgeht **alles** — Quellen-Lock, Sperren,
    Verbrauchsmessung und Nachlauf. Nur die on-device-Notabschaltung bliebe als Schutz.
    Die Dienste sind der vorgesehene Weg für externe Steuerung.

### `gardenesp.start_line`

| Feld | Pflicht | Bedeutung |
|------|---------|-----------|
| `line_id` | ja | Die **rohe Linien-ID** (z. B. `ln_ff3a7f58`). Im Panel in der Linien- und Steuerungs-Übersicht als **„ID (für Dienst)"** angezeigt — nicht zu verwechseln mit der Anzeige-ID `L<n>`. |
| `duration_min` | nein | Laufdauer in Minuten (Nachkommastellen = Sekunden, z. B. `0.5` = 30 s). Leer = manuelle Standarddauer der Linie. |
| `force` | nein | `true` = **„Start trotzdem"** — übersteuert einen Sperr-Sensor (Regen). Pegel-/Trockenlaufschutz der Quelle bleibt aktiv. |

### `gardenesp.stop_line`

| Feld | Pflicht | Bedeutung |
|------|---------|-----------|
| `line_id` | ja | Rohe Linien-ID der zu stoppenden Linie. |

!!! note "Unbekannte `line_id`"
    Eine unbekannte ID liefert über die Dienste-Aufrufe (Automation, Entwicklerwerkzeuge →
    Aktionen) einen sauberen Validierungsfehler.

### Beispiel: Linie zeitgesteuert mit eigener Dauer starten

```yaml
automation:
  - alias: "Tomaten morgens 6 Minuten"
    trigger:
      - platform: time
        at: "06:00:00"
    action:
      - service: gardenesp.start_line
        data:
          line_id: ln_ff3a7f58
          duration_min: 6
```

## Binäreingänge als Taster/Schalter

Jeder Binäreingang eines Steuergeräts ist als normaler **`binary_sensor`** in Home Assistant
sichtbar (`binary_sensor.gardenesp_steuergeraet_<x>_<name>`) und in jeder Automation als **Auslöser**
oder Bedingung nutzbar — unabhängig davon, ob GardenESP ihn intern verwendet.

Damit ein Eingang einen **sprechenden Namen** trägt und **nicht** als Sperr-Sensor
behandelt wird, richte ihn im Steuergerät-Editor als Typ **Taster / Schalter** (`button`) ein
(siehe [Erstes Steuergerät](erste-box.md)). Der Eingang wird dann als
schlichter `binary_sensor` geflasht — ohne Bewässerungs-Bedeutung, also auch **nicht** in der
Sperr-Sensor-Auswahl der Linien.

!!! info "GardenControl & WROOM"
    GardenControl hat **3 Binäreingänge** (BIN1–3), die sich Regen, S0-Literzähler und
    Taster **teilen** — ist einer als Literzähler belegt, steht er nicht mehr als Taster
    zur Verfügung. Bei ESP32-WROOM nimmst du einen freien GPIO. Die **Polarität** (Ruhe =
    an/aus) stellst du am Eingang über den Invertieren-Schalter ein.

### Beispiel: Taster startet eine Linie

```yaml
automation:
  - alias: "Taster Terrasse → Rasen 10 min"
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

!!! tip "Bewusste Trennung"
    GardenESP bietet **keine** eingebaute „Taster → Aktion"-Verknüpfung. Die Logik dahinter
    lebt in HA-Automationen auf der rohen `binary_sensor`-Entity — flexibler, und ohne die
    Bewässerungslogik zu duplizieren.
