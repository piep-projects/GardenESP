# Fehlersuche

## Die Steuergerät-Entitäten fehlen / sind `unavailable`

- Ist das Steuergerät als **ESPHome-Gerät in HA** eingebunden (nicht nur geflasht)? Siehe
  [Erstes Steuergerät](erste-box.md).
- Steuergerät online? In der Hardware-Übersicht steht Online/Offline + Firmware-Stand.

## Ausgänge/Eingänge sind nicht zugeordnet

- Panel → **Allgemein → Entities abgleichen** für das Steuergerät ausführen.
- Namen müssen **je Steuergerät eindeutig** sein. Umlaute/ß werden ASCII-gefaltet
  (ä→ae, ö→oe, ü→ue, ß→ss).

## „Firmware-Drift"-Warnung

Die Einstellungen unterscheiden sich von der geflashten Firmware. Das ist **nur eine
Warnung** — Läufe laufen weiter. Steuergerät neu flashen, um den Drift aufzulösen.

## Ein Lauf wird als `emergency` protokolliert

Der on-device Emergency-Shutdown hat ausgelöst. Häufigste Ursache: die Laufdauer endet
zu nah an `emergency_shutdown_min`. Laufzeit auf **≤ emergency_shutdown_min − 1 min**
reduzieren (das Panel warnt).

## Zisternen-Füllstand stimmt nicht

[Kalibrierung](quellen.md) prüfen — Stützpunkte und aktuellen Rohwert.

## OTA-Flash schlägt fehl: „Error resolving IP address … Is it connected to WiFi?"

Diese Meldung erscheint, wenn sich der **ESPHome-Gerätename** (der mDNS-Hostname
`gardenesp-steuergeraet-<Kürzel>`) geändert hat — z. B. weil du das **Kürzel** eines
Steuergeräts geändert hast. ESPHome will die neue Firmware dann an den **neuen** Namen
schicken (`…-<neu>.local`), den es im Netz aber noch nicht gibt: Das laufende Steuergerät
meldet sich ja weiterhin unter dem **bisherigen** Namen. Henne-Ei — der neue Name entsteht
erst *durch* den Flash.

**Lösung — einmaliger Übergangs-Flash an die aktuelle Adresse:**

- **Per USB flashen** (umgeht die Namensauflösung komplett), **oder**
- im YAML vorübergehend unter `wifi:` die noch gültige Adresse vorgeben:

    ```yaml
    wifi:
      ssid: !secret wifi_ssid
      password: !secret wifi_password
      use_address: <bisheriger-name>.local   # bisher gültiger Name des Steuergeräts, oder seine feste IP
      ap:
        ssid: "${friendly_name} Fallback"
        password: !secret wifi_ap_password
    ```

    Dann **Install → Wirelessly**: ESPHome verbindet zur alten Adresse und flasht die Firmware
    mit dem neuen Namen. Nach dem Neustart ist das Steuergerät unter dem neuen Namen erreichbar →
    `use_address` wieder **entfernen**.

Weil sich der mDNS-Name geändert hat, taucht das Steuergerät in HA unter **Entdeckt** ggf. als „neues"
Gerät auf → einmal [neu einbinden](esphome.md); den alten Geräte-Eintrag kannst du danach
entfernen. Deine Einstellungen, Linien und Verläufe bleiben erhalten (sie hängen nicht am
Gerätenamen).

## „Invalid encryption key" beim Einbinden (obwohl der Schlüssel stimmt)

Meldung à la `Invalid encryption key: received_name=gardenesp-steuergeraet-a, received_mac=…`.
Zuerst der Normalfall: Der eingegebene Schlüssel muss **exakt** dem entsprechen, mit dem das
Gerät geflasht wurde (`api_encryption_key` aus der ESPHome-`secrets.yaml` **zum Flash-Zeitpunkt**).
Hast du den Schlüssel danach geändert → neu flashen und denselben Wert eingeben.

**Häufige Falle bei mehreren Instanzen:** Prüfe die **IP/den `received_mac`** in der Meldung. Passt
die IP **nicht** zu deinem Gerät, hat HA sich zu einem **anderen** Gerät mit **demselben
Namen** verbunden (mDNS-Kollision — zwei Steuergeräte mit gleichem Kürzel im selben Netz, siehe
[Erstes Steuergerät](erste-box.md)). Dann ist nicht der Schlüssel falsch, sondern das Ziel: Gib den
Steuergeräten **unterschiedliche Kürzel** (netzwerkweit eindeutig) und flashe neu — oder binde das
Gerät vorübergehend **über seine feste IP** ein (Integration hinzufügen → ESPHome → Host = IP).

## Weiter Hilfe

Bitte ein [Issue](https://github.com/piep-projects/GardenESP/issues) öffnen — mit
HA-Version, GardenESP-Version und (wenn möglich) den relevanten Log-Ausschnitten.
