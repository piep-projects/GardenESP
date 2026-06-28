# Hardware

GardenESP unterstützt pro Box zwei Plattformen, gewählt über `hw_type`. Der Typ bestimmt
das ESPHome-YAML-Template.

## Smart-MF GardenControl

ESP32 + MCP23017-I/O-Expander, 12× 24-VAC-Magnetventil-Ausgänge, 2× 230-V-Relais
(Pumpen), PCF8575-Status-LEDs, ADS1115 (4-20-mA-Eingänge). Board-genaues, festes Template.

## ESP32-WROOM (Eigenbau)

Direkte GPIO (~8 Kanäle), Relais optional integriert, keine LEDs. Pins werden im
Box-Editor frei je Ausgang/Eingang vergeben.

## Sensorik

- **Zisternen-Füllstand** — Drucksensor (4-20 mA via ADS1115 **oder** analog),
  Umrechnung roh → Liter über eine [Stützpunkt-Kalibrierung](quellen.md).
  Der Sensortyp ist **nicht** an `hw_type` gebunden.
- **Festwasser** — Literzähler (Pulszähler).
- **Sperr-Sensoren** — Regen (z. B. RainClik) oder Bodenfeuchte als Box-Eingang.

!!! tip "Verdrahtung"
    Das Panel bietet je Box eine read-only **Verdrahtungs-Lens** (Pinout-Schaltbild),
    die zeigt, welche Ausgänge/Eingänge auf welchen Pins liegen.
