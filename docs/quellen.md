# Water sources

A **water source** is either a **cistern** (rainwater, with a level sensor) or **mains
water** (with a water meter). Every source tracks its own consumption.

## Calibrating a cistern

The conversion **raw value → litres** uses a **support-point table** (`{raw, litres}`)
with piecewise linear interpolation:

- **2 points** = a linear conversion.
- **N points** = non-linear (a horizontal or widening tank).

In the source editor:

1. Enter the support points as rows `raw → litres`.
2. **Capture the current reading** fetches the live raw value for the current row.
3. On the right, the **calibration curve** shows the polyline together with the current
   working point.

!!! info "What is the raw value?"
    The raw value is the **uncomputed electrical reading** of the level sensor — on
    ESP32-WROOM/generic the **ADC voltage** (`V`), on GardenControl the **4-20 mA current**
    (`mA`). It is not a pressure or a height.

!!! warning "Calibrate the whole range — otherwise the value freezes"
    Outside the entered support points the litre value is **clamped to the nearest point**
    (it is **not** extrapolated — that protects you from nonsense at the odd-shaped ends of a
    tank). If the level rises **above** your highest support point, the display **sticks** at
    that point's litre value even though the raw value keeps climbing (and likewise at the
    bottom). So calibrate up to your **real maximum level** *and* down to **empty**.

    On top of that the value is limited to **`[0, max volume]`** (no negative or
    over-full litres). Set the source's **max volume** to the **real** maximum — with a
    self-fitted overflow or drain that is often **less** than the tank's nominal volume.

## Steadying the level: smoothing and dead band

A pressure sensor is noisy — the fill level shown then jitters by a few litres even at rest.
There are **two independent adjustments** against this, and they can be combined. They act
at different places:

| | **Smoothing** | **Dead band** |
|---|---|---|
| Where it is set | on the controller **input** (tab Hardware) | on the **water source** |
| Unit | seconds (off / 30 / 60 / 90 s) | litres (0 = off) |
| Works against | **measurement noise** | **a restless display** |
| How | The sensor averages on the device, sliding over the time window. | The value shown holds until the reading differs from it by at least that amount. |
| Reflash needed | **yes** (firmware change) | **no** |

**Recommendation:** first set smoothing to 60 s (that takes out the fast jitter), and if the
display still wanders by a few litres, set a **dead band** of about 5 L. The dead band acts
uniformly — on the level display, on the minimum-fill gate and on the consumption
measurement.

!!! tip "Why not simply round?"
    Rounding has **fixed** step boundaries. If the level happens to sit right on one, the
    display flips back and forth by a **whole step** on the tiniest bit of noise. A dead band
    has no fixed boundaries: it remembers the value last shown, and the boundary moves with it.

!!! info "When neither helps any more"
    If a slow drift of a few litres over **hours** remains after smoothing, that is usually
    **not noise any more** but real: sun and temperature act on the tank and the sensor. No
    filter helps against that — such deviations are typically **within the accuracy** of the
    sensor (often ~0.5 % of the measuring range). A dead band still makes the display calm.

## Mains water

Consumption is measured with the **water meter** (pulse counter). On the dashboard the
source shows the **consumption today**.

## Consumption analysis

In the dashboard detail view, per source and per line: totals for **today · month ·
previous month · year · previous year** (derived from the HA history).
