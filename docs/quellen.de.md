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

!!! warning "Ganzen Bereich kalibrieren — sonst „friert" der Wert ein"
    Außerhalb der eingetragenen Stützpunkte wird der Liter-Wert an den **nächsten
    Punkt geklemmt** (er wird **nicht** extrapoliert — das schützt vor Unsinn an den
    krummen Tank-Enden). Steigt der Pegel **über** deinen obersten Stützpunkt, bleibt
    die Anzeige auf dessen Liter-Wert **stehen**, obwohl der Rohwert weiter steigt (und
    umgekehrt unten). Kalibriere daher bis zu deinem **echten Höchststand** *und* bis
    **leer**.

    Zusätzlich wird der Wert auf **`[0, Max-Volumen]`** begrenzt (keine negativen /
    über-vollen Liter). Setz das **Max-Volumen** der Quelle auf die **reale**
    Maximalmenge — bei selbst gesetztem Überlauf/Ablauf ist das oft **weniger** als das
    Nennvolumen des Tanks.

## Ruhiger Füllstand: Glättung und Totband

Ein Drucksensor rauscht — der angezeigte Füllstand zappelt dann auch im Ruhezustand um
ein paar Liter. Dagegen gibt es **zwei unabhängige Stellschrauben**, die man kombinieren
kann. Sie greifen an verschiedenen Stellen an:

| | **Glättung** | **Totband** |
|---|---|---|
| Wo eingestellt | am **Eingang** des Steuergeräts (Tab Hardware) | an der **Wasserquelle** |
| Einheit | Sekunden (aus / 30 / 60 / 90 s) | Liter (0 = aus) |
| Wogegen | **Messrauschen** | **Unruhe der Anzeige** |
| Wie | Der Sensor mittelt auf dem Gerät gleitend über das Zeitfenster. | Der angezeigte Wert bleibt stehen, bis der Messwert um mindestens den Betrag davon abweicht. |
| Reflash nötig | **ja** (Firmware-Änderung) | **nein** |

**Empfehlung:** erst die Glättung auf 60 s stellen (das nimmt das schnelle Zittern), und
wenn die Anzeige dann noch um wenige Liter wandert, ein **Totband** von etwa 5 L setzen.
Das Totband wirkt einheitlich — auf die Füllstands-Anzeige, auf die Mindestfüllstand-Sperre
und auf die Verbrauchsmessung.

!!! tip "Warum kein Runden?"
    Runden hat **feste** Stufengrenzen. Liegt der Pegel zufällig genau auf einer, kippt die
    Anzeige schon bei minimalem Rauschen um eine **volle Stufe** hin und her. Das Totband hat
    keine festen Grenzen: es merkt sich den zuletzt gezeigten Wert, und die Grenze wandert mit.

!!! info "Wenn beides nichts mehr bringt"
    Bleibt nach der Glättung eine langsame Wanderung von wenigen Litern über **Stunden**, ist
    das meist **kein Rauschen mehr**, sondern echt: Sonne und Temperatur wirken auf Tank und
    Sensor. Dagegen hilft kein Filter — solche Abweichungen liegen typisch **innerhalb der
    Genauigkeit** des Sensors (oft ~0,5 % vom Messbereich). Ein Totband macht die Anzeige dann
    trotzdem ruhig.

## Festwasser

Verbrauch wird über den **Literzähler** (Pulszähler) gemessen. Die Quelle zeigt im
Dashboard den **Tagesverbrauch**.

## Verbrauchsauswertung

Im Dashboard-Detail je Quelle und je Linie: Summen für **Heute · Monat · Vormonat ·
Jahr · Vorjahr** (aus der HA-History abgeleitet).
