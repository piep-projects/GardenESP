# Dashboard

The dashboard is a Lovelace card:

```yaml
type: custom:gardenesp-card
```

The card ships with the integration and is registered automatically.

## Layout

- **Lines** — name + status badge, "Last"/"Next", a live remaining-time countdown, and a
  **▶/■** icon on the right (start/stop manually). Clicking anywhere on the row opens the
  detail view.
- **Water sources & sensors** — a single line each, value right-aligned (rain `dry`/`wet`,
  cistern `<L>/<max> L`).
- **Faults** — a disturbed run appears inline on the "Last" line (in yellow).

## Order

The panel → tab **General** lets you choose whether **water sources** and **blocking
sensors** appear before or after the lines (controls always come last).

## Detail view

Clicking a row opens an overlay with the history, consumption totals and — for cisterns —
the fill-level history (via Home Assistant's native history dialog).
