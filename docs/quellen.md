# Wasserquellen

Eine **Wasserquelle** ist entweder eine **Zisterne** (Regenwasser, Füllstandssensor)
oder **Festwasser** (Mains, Literzähler). Jede Quelle verfolgt ihren Verbrauch.

## Zisterne kalibrieren

Die Umrechnung **Rohwert → Liter** erfolgt über eine **Stützpunkt-Tabelle**
(`{roh, liter}`) mit stückweise-linearer Interpolation:

- **2 Punkte** = lineare Umrechnung.
- **N Punkte** = nicht-linear (liegender/sich weitender Tank).

Im Quellen-Editor:

1. Stützpunkte als Zeilen `roh → Liter` eintragen.
2. **Aktuellen Messwert übernehmen** holt den Live-Rohwert für die aktuelle Zeile.
3. Rechts zeigt die **Kalibrierkurve** den Polygonzug samt aktuellem Arbeitspunkt.

!!! info "Was ist der Rohwert?"
    Der Rohwert ist der **ungerechnete elektrische Messwert** des Pegelsensors —
    bei ESP32-WROOM/Generic die **ADC-Spannung** (`V`), bei GardenControl der
    **4-20-mA-Strom** (`mA`). Es ist kein Druck/cm.

## Festwasser

Verbrauch wird über den **Literzähler** (Pulszähler) gemessen. Die Quelle zeigt im
Dashboard den **Tagesverbrauch**.

## Verbrauchsauswertung

Im Dashboard-Detail je Quelle und je Linie: Summen für **Heute · Monat · Vormonat ·
Jahr · Vorjahr** (aus der HA-History abgeleitet).
