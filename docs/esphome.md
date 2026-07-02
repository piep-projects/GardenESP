# ESPHome: Secrets, Flashen & Einbinden

Dies ist der Teil, der Einsteiger erfahrungsgemäß am meisten Respekt kostet. Keine Sorge —
du machst ihn **einmal pro Box**, danach laufen Updates drahtlos. Diese Seite erklärt jeden
Schritt von Grund auf.

!!! info "Was passiert hier eigentlich?"
    GardenESP **erzeugt** aus deinen Panel-Einstellungen eine fertige **ESPHome-Konfiguration
    (YAML)**. ESPHome verwandelt diese Konfiguration in **Firmware** und spielt sie auf den
    ESP32 (deine „Box"). Anschließend bindest du die Box als Gerät in Home Assistant ein —
    erst dann kann GardenESP die Ventile schalten.

## Begriffe in einem Satz

| Begriff | Bedeutung |
|---------|-----------|
| **ESPHome** | Werkzeug, das aus YAML die Firmware für ESP32/ESP8266 baut und flasht. Läuft am bequemsten als **Add-on** in Home Assistant. |
| **Firmware** | Das Programm, das direkt auf dem ESP32 läuft (hier von ESPHome gebaut). |
| **Flashen** | Die Firmware auf den ESP32 übertragen — beim ersten Mal per USB-Kabel, danach drahtlos (OTA). |
| **Secrets** | Vertrauliche Werte (WLAN-Passwort, Schlüssel …), die **getrennt** vom YAML in einer `secrets.yaml` liegen, damit sie nicht im Klartext in jeder Konfiguration stehen. |
| **API-Schlüssel** | Ein Verschlüsselungsschlüssel, mit dem Home Assistant **verschlüsselt** mit der Box spricht. Brauchst du beim Einbinden in HA. |
| **OTA** | „Over the Air" — drahtlose Firmware-Updates über WLAN, nach dem ersten USB-Flash. |

## 1. ESPHome installieren

Am einfachsten als Add-on (für Home Assistant OS / Supervised):

1. **Einstellungen → Add-ons → Add-on-Store**.
2. **ESPHome Device Builder** (früher „ESPHome") suchen und **installieren**.
3. **Starten** und **„Im Seitenmenü anzeigen"** aktivieren → es erscheint ein **ESPHome**-
   Eintrag in der Seitenleiste mit einer eigenen Oberfläche (dem „Dashboard").

!!! note "Kein Home Assistant OS?"
    Bei einer Container-/Core-Installation nutzt du ESPHome als
    [CLI oder Docker](https://esphome.io/guides/installing_esphome.html). Die Schritte unten
    (Secrets, YAML, Flashen) sind identisch, nur die Oberfläche fehlt.

## 2. Secrets anlegen

Das von GardenESP erzeugte YAML enthält **keine** Passwörter im Klartext, sondern Verweise
wie `!secret wifi_password`. Diese Werte definierst du **einmal** zentral. Im ESPHome-
Dashboard: oben rechts **⋮ → Secrets** (bzw. die Datei `secrets.yaml`).

GardenESP-Boxen brauchen genau diese **fünf** Secrets:

```yaml
# secrets.yaml  (im ESPHome-Dashboard editierbar)
wifi_ssid: "MeinWLAN"
wifi_password: "mein-wlan-passwort"
wifi_ap_password: "fallback-passwort"   # für das Notfall-WLAN der Box
ota_password: "ein-frei-waehlbares-passwort"
api_encryption_key: "ERSETZEN — siehe Schritt 3"
```

!!! tip "Einmal anlegen, für alle Boxen gültig"
    `secrets.yaml` gilt für **alle** ESPHome-Geräte. Hast du die fünf Werte einmal gesetzt,
    funktioniert jede weitere GardenESP-Box ohne erneutes Secrets-Setzen.

## 3. API-Verschlüsselungsschlüssel erzeugen

Der `api_encryption_key` ist ein zufälliger 32-Byte-Schlüssel (Base64). Du brauchst ihn an
**zwei** Stellen mit **demselben** Wert: in `secrets.yaml` und später beim Einbinden in HA.

So kommst du an einen Schlüssel:

- **Am einfachsten:** Lege im ESPHome-Dashboard testweise ein **neues Gerät** über den
  Assistenten an — ESPHome generiert dabei automatisch einen Schlüssel, den du kopieren und
  in `secrets.yaml` als `api_encryption_key` eintragen kannst.
- **Oder** einen erzeugen lassen, z. B. über die
  [ESPHome-API-Doku](https://esphome.io/components/api.html) (Abschnitt „Encryption").

!!! warning "Schlüssel notieren"
    Kopiere den fertigen Schlüssel an einen sicheren Ort. Beim Einbinden in HA (Schritt 6)
    musst du **exakt diesen** Wert eingeben.

## 4. GardenESP-YAML übernehmen

Im **GardenESP-Panel** → Tab **Hardware** → bei deinem Steuergerät **🔒 YAML** öffnen. Von
dort führen zwei Wege ins ESPHome-Dashboard (einen „YAML hochladen"-Button gibt es dort nicht):

- **Kopieren → einfügen:** YAML **kopieren**, im ESPHome-Dashboard ein neues Gerät bzw. eine
  Konfigurationsdatei anlegen, den **YAML-Editor** öffnen und einfügen → Speichern.
- **Herunterladen → ablegen:** YAML **herunterladen** (die Datei heißt passend
  `gardenesp-steuergeraet-<kürzel>.yaml`) und in den ESPHome-Konfig-Ordner
  **`/config/esphome/`** legen — z. B. über die Add-ons **File Editor**, **Studio Code Server**
  oder **Samba**. Die Datei erscheint dann automatisch im ESPHome-Dashboard.

Die `!secret …`-Verweise greifen anschließend auf deine `secrets.yaml`.

!!! note "Gerätename muss passen"
    Das YAML setzt den Gerätenamen selbst (`gardenesp-steuergeraet-<kürzel>`). Ändere ihn nicht —
    der Name ist Teil der GardenESP-Logik.

## 5. Box flashen

- **Erstes Mal: per USB.** ESP32 mit dem Rechner verbinden, im ESPHome-Dashboard bei der
  Box **Install → Plug into this computer** (Browser-Flasher) bzw. den passenden Port wählen.
- **Danach: drahtlos (OTA).** Sobald die Box im WLAN ist, bietet ESPHome **Install →
  Wirelessly** an — kein Kabel mehr nötig.

Details und Treiber-Hinweise: [ESPHome-Flashing-Guide](https://esphome.io/guides/getting_started_hassio.html).

!!! tip "Box im WLAN?"
    Nach erfolgreichem Flash verbindet sich die Box mit deinem WLAN (aus den Secrets). Klappt
    das nicht, spannt sie ein **Fallback-WLAN** `… Fallback` auf (Passwort `wifi_ap_password`),
    über das du die WLAN-Daten korrigieren kannst.

!!! warning "Gerätenamen geändert? Erster Flash an die alte Adresse"
    Hat sich der ESPHome-**Gerätename** geändert (z. B. nachdem du das **Kürzel** eines
    Steuergeräts geändert hast), scheitert der OTA-Flash mit *„Error resolving IP address …
    Is it connected to WiFi?"* — der neue Name ist noch nicht im Netz. Dann einmalig per
    **USB** flashen oder unter `wifi:` `use_address: <bisheriger-name>.local` (oder feste IP)
    setzen und danach wieder entfernen. Details: [Fehlersuche](fehlersuche.md).

## 6. Box in Home Assistant einbinden

Sobald die geflashte Box im Netzwerk ist, **entdeckt HA sie automatisch**:

1. **Einstellungen → Geräte & Dienste** → unter **Entdeckt** erscheint die ESPHome-Box →
   **Konfigurieren**.
2. HA fragt nach dem **Verschlüsselungsschlüssel** → den `api_encryption_key` aus Schritt 3
   eingeben.
3. Bestätigen → die Box ist als **ESPHome-Gerät** eingebunden, ihre `switch.*`/`sensor.*`-
   Entitäten existieren jetzt.

!!! warning "Flashen ≠ Einbinden"
    Eine geflashte Box ist erst nutzbar, wenn sie auch als **ESPHome-Gerät in HA** hinzugefügt
    wurde. Erst dann gibt es die Schalt- und Sensor-Entitäten, die GardenESP ansteuert.

## Geschafft

Zurück ins GardenESP-Panel: Die Box ist online, und du kannst die
[Entitäten abgleichen](erste-box.md) und deine [erste Linie](linien.md) anlegen.

!!! question "Hängt's irgendwo?"
    Häufige Stolpersteine (Box offline, Entity `—`, Drift-Warnung) findest du in der
    [Fehlersuche](fehlersuche.md).
