# Dashboard

Das Dashboard ist eine Lovelace-Karte:

```yaml
type: custom:gardenesp-card
```

Die Karte wird mit der Integration ausgeliefert und automatisch registriert.

## Aufbau

- **Linien** — Name + Status-Badge, „Letzte"/„Nächste", Live-Restzeit-Countdown;
  rechts ein **▶/■**-Icon (manuell starten/stoppen). Die ganze Zeile öffnet die
  Detail-Ansicht.
- **Wasserquellen & Sensoren** — einzeilig, Wert rechtsbündig (Regen `trocken`/`nass`,
  Zisterne `<L>/<max> L`).
- **Störungen** — gestörte Läufe erscheinen inline an der „Letzte"-Zeile (gelb).

## Reihenfolge

Im Panel → Tab **Allgemein** lässt sich einstellen, ob **Wasserquellen** und
**Sperr-Sensoren** vor oder nach den Linien erscheinen (Steuerungen stehen zuletzt).

## Detail-Ansicht

Klick auf eine Zeile öffnet ein Overlay mit Verlauf, Verbrauchssummen und — bei
Zisternen — dem Füllstands-Verlauf (über den nativen HA-Verlaufsdialog).
