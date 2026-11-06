# Build gates: check:fields and check:ai

Both run inside `gjsify run check`.

- **`check:fields`** listet jedes schreibbare Schema-Feld ohne Oberfläche im Desktop-Frontend.
  Neues Feld im Manifest-Schema → entweder eine Zeile dafür bauen oder es in
  `app/dev/field-coverage.allow.json` mit Begründung eintragen; die Liste soll schrumpfen. Sie ist
  entstanden, weil jede bis dahin gefundene Lücke (Steuernummer, Klassifizierungsregeln,
  Gewerbesteuer, Kinder) dadurch gefunden wurde, dass jemand darüber gestolpert ist.
- **`check:ai`** listet jede Datei, die die KI erreicht (`getLLMProvider`, Agent-SDK), und verlangt je einen
  Weg ohne KI in `app/dev/ai-boundary.allow.json` (`ohneKi`, ggf. `idee`); veraltete Einträge sind rot.
