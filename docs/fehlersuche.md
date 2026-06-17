# Fehlersuche

## Die Box-Entitäten fehlen / sind `unavailable`

- Ist die Box als **ESPHome-Gerät in HA** eingebunden (nicht nur geflasht)? Siehe
  [Erste Box](erste-box.md).
- Box online? In der Boxen-Übersicht steht Online/Offline + Firmware-Stand.

## Ausgänge/Eingänge sind nicht zugeordnet

- Panel → **Allgemein → Entities abgleichen** für die Box ausführen.
- Namen müssen **je Box eindeutig** sein. Umlaute/ß werden ASCII-gefaltet
  (ä→ae, ö→oe, ü→ue, ß→ss).

## „Firmware-Drift"-Warnung

Die Einstellungen unterscheiden sich von der geflashten Firmware. Das ist **nur eine
Warnung** — Läufe laufen weiter. Box neu flashen, um den Drift aufzulösen.

## Ein Lauf wird als `emergency` protokolliert

Der on-device Emergency-Shutdown hat ausgelöst. Häufigste Ursache: die Laufdauer endet
zu nah an `emergency_shutdown_min`. Laufzeit auf **≤ emergency_shutdown_min − 1 min**
reduzieren (das Panel warnt).

## Zisternen-Füllstand stimmt nicht

[Kalibrierung](quellen.md) prüfen — Stützpunkte und aktuellen Rohwert.

## Weiter Hilfe

Bitte ein [Issue](https://github.com/piep-projects/GardenESP/issues) öffnen — mit
HA-Version, GardenESP-Version und (wenn möglich) den relevanten Log-Ausschnitten.
