# Troubleshooting

## The controller's entities are missing / `unavailable`

- Is the controller added as an **ESPHome device in HA** (not merely flashed)? See
  [First controller](erste-box.md).
- Is the controller online? The hardware overview shows online/offline plus the firmware state.

## Outputs/inputs are not assigned

- Panel → **General → Match entities** for that controller.
- Names must be **unique per controller**. Umlauts and ß are folded to ASCII
  (ä→ae, ö→oe, ü→ue, ß→ss).

## "Firmware drift" warning

The settings differ from the flashed firmware. This is **only a warning** — runs keep
working. Reflash the controller to clear the drift.

## A run is logged as `emergency`

The on-device emergency shutdown fired. The most common cause: the run duration ends too
close to `emergency_shutdown_min`. Reduce the run time to
**≤ emergency_shutdown_min − 1 min** (the panel warns about this).

## The cistern level is wrong

Check the [calibration](quellen.md) — the support points and the current raw value.

## The cistern level jitters at rest

That is normal — a pressure sensor is noisy. **Smoothing** on the input (tab Hardware) and a
**dead band** on the source calm the display down; both are explained under
[Water sources](quellen.md#steadying-the-level-smoothing-and-dead-band).

## GardenControl: the pump switches the wrong relay terminal

On the GardenControl board the two relay outputs are **crossed**: the screw terminal printed
**`R1` is driven internally by a different pin** than the name in the manufacturer's firmware
suggests (confirmed by the manufacturer — **the printed label is what counts**). GardenESP
takes this into account **from version 0.13.73**.

**After updating to 0.13.73 you have to reflash the controller** — until then it still
switches the *other* terminal. After the flash, check once which terminal actually pulls in:
if it is the wrong one, move the wire to the other relay terminal **or** change the output in
the settings from `R1` to `R2` (or vice versa).

## OTA flash fails: "Error resolving IP address … Is it connected to WiFi?"

This message appears when the **ESPHome device name** (the mDNS hostname
`gardenesp-steuergeraet-<short code>`) has changed — for example because you changed a
controller's **short code**. ESPHome then wants to send the new firmware to the **new** name
(`…-<new>.local`), which does not exist on the network yet: the running controller still
announces itself under its **previous** name. A chicken-and-egg problem — the new name only
comes into being *through* the flash.

**Solution — a one-off transitional flash to the current address:**

- **Flash over USB** (which bypasses name resolution entirely), **or**
- temporarily specify the still-valid address under `wifi:` in the YAML:

    ```yaml
    wifi:
      ssid: !secret wifi_ssid
      password: !secret wifi_password
      use_address: <previous-name>.local   # the controller's previously valid name, or its fixed IP
      ap:
        ssid: "${friendly_name} Fallback"
        password: !secret wifi_ap_password
    ```

    Then **Install → Wirelessly**: ESPHome connects to the old address and flashes the firmware
    carrying the new name. After the restart the controller is reachable under the new name →
    **remove** `use_address` again.

Because the mDNS name has changed, the controller may show up in HA under **Discovered** as a
"new" device → [add it again](esphome.md) once; you can remove the old device entry
afterwards. Your settings, lines and history are preserved (they do not hang off the device
name).

## "Invalid encryption key" when adding the device (even though the key is correct)

A message like `Invalid encryption key: received_name=gardenesp-steuergeraet-a, received_mac=…`.
First the ordinary case: the key you enter must match **exactly** the one the device was
flashed with (`api_encryption_key` from the ESPHome `secrets.yaml` **at the time of the
flash**). If you changed the key afterwards → reflash and enter the same value.

**A common trap with several instances:** check the **IP / the `received_mac`** in the
message. If the IP does **not** match your device, HA has connected to a **different** device
with **the same name** (an mDNS collision — two controllers with the same short code on the
same network, see [First controller](erste-box.md)). Then it is not the key that is wrong but
the target: give the controllers **different short codes** (unique across the network) and
reflash — or add the device temporarily **via its fixed IP** (Add integration → ESPHome →
host = IP).

## Further help

Please open an [issue](https://github.com/piep-projects/GardenESP/issues) — with your HA
version, your GardenESP version and (if possible) the relevant log excerpts.
