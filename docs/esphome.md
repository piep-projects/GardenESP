# ESPHome: secrets, flashing & adding to HA

This is the part beginners tend to find most daunting. Don't worry — you do it **once per
controller**, and after that updates happen wirelessly. This page explains every step from
the ground up.

!!! info "What actually happens here?"
    From your panel settings GardenESP **produces** a ready-made **ESPHome configuration
    (YAML)**. ESPHome turns that configuration into **firmware** and puts it onto the ESP32
    (your "controller"). Afterwards you add the controller as a device in Home Assistant —
    only then can GardenESP switch the valves.

## The terms in one sentence each

| Term | Meaning |
|---------|-----------|
| **ESPHome** | The tool that builds and flashes firmware for ESP32/ESP8266 from YAML. Most conveniently run as an **add-on** inside Home Assistant. |
| **Firmware** | The program that runs directly on the ESP32 (here built by ESPHome). |
| **Flashing** | Transferring the firmware onto the ESP32 — over a USB cable the first time, wirelessly (OTA) after that. |
| **Secrets** | Confidential values (Wi-Fi password, keys …) kept **separately** from the YAML in a `secrets.yaml`, so they don't sit in plain text in every configuration. |
| **API key** | An encryption key that lets Home Assistant talk to the controller **encrypted**. You need it when adding the device to HA. |
| **OTA** | "Over the air" — wireless firmware updates over Wi-Fi, after the first USB flash. |

## 1. Install ESPHome

Easiest as an add-on (for Home Assistant OS / Supervised):

1. **Settings → Add-ons → Add-on store**.
2. Search for **ESPHome Device Builder** (formerly "ESPHome") and **install** it.
3. **Start** it and enable **"Show in sidebar"** → an **ESPHome** entry appears in the
   sidebar with its own interface (the "dashboard").

!!! note "Not running Home Assistant OS?"
    On a Container/Core installation you use ESPHome as a
    [CLI or via Docker](https://esphome.io/guides/installing_esphome.html). The steps below
    (secrets, YAML, flashing) are identical, only the web interface is missing.

## 2. Create your secrets

The YAML produced by GardenESP contains **no** passwords in plain text, only references like
`!secret wifi_password`. You define those values **once**, centrally. In the ESPHome
dashboard: top right **⋮ → Secrets** (i.e. the file `secrets.yaml`).

GardenESP controllers need exactly these **five** secrets:

```yaml
# secrets.yaml  (editable in the ESPHome dashboard)
wifi_ssid: "MyWiFi"
wifi_password: "my-wifi-password"
wifi_ap_password: "fallback-password"   # for the controller's emergency Wi-Fi
ota_password: "a-password-of-your-choice"
api_encryption_key: "REPLACE — see step 3"
```

!!! tip "Set once, valid for every controller"
    `secrets.yaml` applies to **all** ESPHome devices. Once you have set these five values,
    every further GardenESP controller works without setting secrets again.

## 3. Generate the API encryption key

The `api_encryption_key` is a random 32-byte key (Base64). You need it in **two** places with
**the same** value: in `secrets.yaml` and later when adding the device to HA.

How to get one:

- **Easiest:** in the ESPHome dashboard, create a **new device** through the wizard as a test
  — ESPHome generates a key along the way, which you can copy into `secrets.yaml` as
  `api_encryption_key`.
- **Or** have one generated, e.g. via the
  [ESPHome API docs](https://esphome.io/components/api.html) (section "Encryption").

!!! warning "Write the key down"
    Copy the finished key somewhere safe. When adding the device to HA (step 6) you must
    enter **exactly this** value.

## 4. Take over the GardenESP YAML

In the **GardenESP panel** → tab **Hardware** → open **🔒 YAML** on your controller. From
there two routes lead into the ESPHome dashboard (there is no "upload YAML" button over there):

- **Copy → paste:** **copy** the YAML, create a new device or configuration file in the
  ESPHome dashboard, open the **YAML editor** and paste → save.
- **Download → drop in:** **download** the YAML (the file is named
  `gardenesp-steuergeraet-<short code>.yaml`) and put it into the ESPHome config folder
  **`/config/esphome/`** — for example via the add-ons **File Editor**, **Studio Code Server**
  or **Samba**. The file then shows up in the ESPHome dashboard automatically.

The `!secret …` references then pick up your `secrets.yaml`.

!!! note "The device name must stay as it is"
    The YAML sets the device name itself (`gardenesp-steuergeraet-<short code>`). Don't change
    it — the name is part of the GardenESP logic.

## 5. Flash the controller

- **First time: over USB.** Connect the ESP32 to your computer, then in the ESPHome dashboard
  choose **Install → Plug into this computer** on your controller (browser flasher), or pick
  the appropriate port.
- **After that: wirelessly (OTA).** As soon as the controller is on Wi-Fi, ESPHome offers
  **Install → Wirelessly** — no cable needed any more.

Details and driver notes: [ESPHome flashing guide](https://esphome.io/guides/getting_started_hassio.html).

!!! tip "Is the controller on Wi-Fi?"
    After a successful flash the controller connects to your Wi-Fi (from the secrets). If that
    fails, it opens a **fallback Wi-Fi** `… Fallback` (password `wifi_ap_password`) through
    which you can correct the Wi-Fi credentials.

!!! warning "Changed the device name? The first flash goes to the old address"
    If the ESPHome **device name** has changed (for example after you changed a controller's
    **short code**), the OTA flash fails with *"Error resolving IP address … Is it connected
    to WiFi?"* — the new name is not on the network yet. Then flash once over **USB**, or set
    `use_address: <previous-name>.local` (or a fixed IP) under `wifi:` and remove it again
    afterwards. Details: [Troubleshooting](fehlersuche.md).

## 6. Add the controller to Home Assistant

As soon as the flashed controller is on the network, **HA discovers it automatically**:

1. **Settings → Devices & services** → the ESPHome controller appears under **Discovered** →
   **Configure**.
2. HA asks for the **encryption key** → enter the `api_encryption_key` from step 3.
3. Confirm → the controller is added as an **ESPHome device**, and its `switch.*` and
   `sensor.*` entities now exist.

!!! warning "Flashing ≠ adding"
    A flashed controller only becomes usable once it has also been added as an **ESPHome
    device in HA**. Only then do the switch and sensor entities exist that GardenESP drives.

## Done

Back in the GardenESP panel: the controller is online, and you can
[match the entities](erste-box.md) and create your [first line](linien.md).

!!! question "Stuck somewhere?"
    Common stumbling blocks (controller offline, entity showing `—`, drift warning) are
    covered in [Troubleshooting](fehlersuche.md).
