# Linien & Zeitpläne

Eine **Bewässerungslinie** entspricht genau einem Magnetventil und zieht aus genau
einer fest zugeordneten Wasserquelle (kein Quellen-Umschalten pro Linie).

## Linie anlegen

Panel → Tab **Linien** → **+ Neu**:

| Feld | Bedeutung |
|------|-----------|
| **Box + Ventil** | Der Ventil-Ausgang (Ausgang-ID `A5`). |
| **Wasserquelle** | Zisterne oder Festwasser, aus der die Linie zieht. |
| **Sperr-Sensor** (optional) | Regen-/Bodensensor; blockiert die **Automatik** bei Nässe. |
| **Default-Dauer manuell** | Vorgabe für den manuellen Start. Akzeptiert `m:ss` (z. B. `0:18` = 18 s, Gießkanne), sonst Minuten (`5`). |
| **Nachlauf überspringen** | Bei Zisternen: manueller Start ohne Mess-Nachlauf (Schlauch-Direktentnahme → sofort frei). |

Jede Linie bekommt eine stabile **Linien-ID `L<n>`** (pro Box fortlaufend), getrennt von
der Ausgang-ID `A5` des Ventils.

## Zeitplan

Pro Linie beliebig viele Einträge mit **Uhrzeit + Dauer** und einem **aktiv/inaktiv**-
Schalter; zusätzlich lässt sich die **Automatik** je Linie ganz ein-/ausschalten.

!!! warning "Laufzeit vs. Notabschaltung"
    Die Laufdauer (Zeitplan **oder** manuelle Default-Dauer) sollte **mindestens 1 Minute
    vor** der `emergency_shutdown_min` des Ventil-Ausgangs enden — Regel
    **`Laufzeit ≤ emergency_shutdown_min − 1`**. Sonst greift bei *jedem* vollen Lauf die
    on-device-Notabschaltung quasi zeitgleich mit dem regulären Ende, und der Lauf wird als
    Störung (`emergency`) protokolliert. Das Panel zeigt dazu eine gelbe Warnung (blockiert
    das Speichern aber nicht).

## Manueller Start & Stopp

Im [Dashboard](dashboard.md) per **▶**-Icon (Stopp per **■**). Ein manueller Start
**ignoriert den Sperr-Sensor** (Regen) generell — der Pegel-/Trockenlaufschutz der Quelle
bleibt aber aktiv. Ein manueller Stopp bucht die tatsächliche (sekundengenaue) Dauer und
den gemessenen Verbrauch.

## Was im Hintergrund schützt

- **Emergency-Shutdown (Notabschaltung)** — läuft **on-device** in der ESPHome-Firmware,
  unabhängig von WLAN/HA. Erreicht ein Ventil seine `emergency_shutdown_min`, schaltet die
  Box selbst ab. Ein Zähler „Notabschaltungen gesamt" wird hochgezählt.
- **Quellen-Sperre (Queue)** — eine Quelle wird zur Laufzeit gesperrt; weitere Läufe aus
  derselben Quelle warten (kein Überlasten von Pumpe/Druck).
- **Sicherheits-Stopp pro Linie** — wird der Ziel-`switch` `unavailable` (Box-Reboot/
  WLAN-Verlust), stoppt der Lauf und wird als `interrupted` markiert.

## Status & Störungen

Eine Linie zeigt im Dashboard ihren Live-Status (Ruhe, aktiv mit Restzeit, „Nachlauf ·
Messung" bei Zisternen, gesperrt). Ein gestörter Lauf erscheint **inline an der „Letzte"-
Zeile** (gelb) und wird abgeräumt, sobald ein sauberer Lauf folgt. Details in der
[Fehlersuche](fehlersuche.md).

## Steuerungen

Generische Schaltausgänge (Springbrunnen, Kamera …) werden als **Steuerung** im eigenen
Tab angelegt — gleiche Lauf-Engine, aber **ohne** Quelle/Pegel/Nachlauf/Verbrauch. Dauer
leer/0 = Dauerbetrieb (an bis Stopp).
