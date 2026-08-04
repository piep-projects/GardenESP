# Lines & schedules

An **irrigation line** corresponds to exactly one solenoid valve and draws from exactly
one fixed water source (no per-line source switching).

## Creating a line

Panel → tab **Lines** → **+ New**:

| Field | Meaning |
|------|-----------|
| **Controller + valve** | The valve output (output id `A5`). |
| **Water source** | The cistern or mains supply the line draws from. |
| **Blocking sensor** (optional) | Rain/soil sensor; blocks the **automatic** schedule while wet. |
| **Default manual duration** | Preset for a manual start. Accepts `m:ss` (e.g. `0:18` = 18 s, filling a watering can), otherwise minutes (`5`). |
| **Skip settling time** | For cisterns: a manual start without the measuring settling time (drawing from a hose → immediately free again). |

Every line gets a stable **line id `L<n>`** (numbered per controller), separate from the
valve's output id `A5`.

## Schedule

Any number of entries per line, each with **time + duration** and an **active/inactive**
toggle; on top of that, the **automatic** mode can be switched on or off per line.

!!! warning "Run time vs. emergency shutdown"
    A run's duration (from the schedule **or** the manual default) should end **at least one
    minute before** the valve output's `emergency_shutdown_min` — the rule is
    **`run time ≤ emergency_shutdown_min − 1`**. Otherwise the on-device emergency shutdown
    fires on *every* full run, practically at the same moment as the regular end, and the run
    is logged as a fault (`emergency`). The panel shows a yellow warning for this (but does
    not block saving).

## Manual start & stop

From the [dashboard](dashboard.md) via the **▶** icon (stop with **■**). A manual start
**always ignores the blocking sensor** (rain) — the source's level and dry-run protection
stay active. A manual stop logs the actual duration (to the second) and the measured
consumption.

## What protects you in the background

- **Emergency shutdown** — runs **on the device**, in the ESPHome firmware, independently of
  Wi-Fi and HA. When a valve reaches its `emergency_shutdown_min`, the controller switches
  off by itself. A counter "emergency shutdowns total" is incremented.
- **Source lock (queue)** — a source is locked while a run is in progress; further runs from
  the same source wait (no overloading the pump or the pressure).
- **Per-line safety stop** — if the target `switch` goes `unavailable` (controller reboot,
  Wi-Fi loss), the run stops and is marked `interrupted`.

## Status & faults

On the dashboard a line shows its live status (resting, active with remaining time,
"Settling · measuring" for cisterns, blocked). A disturbed run appears **inline on the
"Last" line** (in yellow) and is cleared as soon as a clean run follows. Details in
[Troubleshooting](fehlersuche.md).

## Controls

Generic switched outputs (a fountain, a camera …) are created as a **control** on their own
tab — same run engine, but **without** source, level, settling time or consumption. An empty
or `0` duration means continuous operation (on until stopped).
