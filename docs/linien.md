# Linien & Zeitpläne

Eine **Bewässerungslinie** entspricht genau einem Magnetventil und zieht aus genau
einer fest zugeordneten Wasserquelle.

## Linie anlegen

Panel → Tab **Linien** → **Hinzufügen**:

- **Ausgang** (Ventil) und **Quelle** wählen.
- Optional **Sperr-Sensor** (Regen/Boden) zuordnen.
- **Default-Dauer manuell** — akzeptiert `m:ss` (z. B. `0:18` = 18 s), sonst Minuten.

## Zeitplan

Pro Linie beliebig viele Einträge mit **Uhrzeit + Dauer** und einem **aktiv/inaktiv**-Schalter.
Die **Automatik** lässt sich je Linie ein-/ausschalten.

!!! warning "Laufzeit vs. Notabschaltung"
    Die Laufdauer sollte **mindestens 1 Minute vor** der `emergency_shutdown_min` des
    Ventil-Ausgangs enden. Sonst greift bei jedem vollen Lauf der on-device
    Emergency-Shutdown. Das Panel warnt automatisch.

## Manueller Start

Im [Dashboard](dashboard.md) per ▶-Icon. Ein manueller Start ignoriert den Sperr-Sensor
(der Pegel-/Trockenlaufschutz bleibt aktiv).

## Steuerungen

Generische Schaltausgänge (Springbrunnen, Kamera …) werden als **Steuerung** angelegt —
gleiche Lauf-Engine, ohne Quelle/Pegel/Verbrauch.
