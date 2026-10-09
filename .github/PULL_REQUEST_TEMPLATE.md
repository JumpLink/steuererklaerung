<!--
Keine echten Steuernummern, IBANs, Kundennamen oder Beträge — nicht im Text, nicht im
Diff, nicht in Screenshots. Screenshots immer aus der Demo-Entität (`--demo`).
-->

## Was und warum

<!-- Was ändert sich, und welches Problem löst das? Ein Absatz reicht. -->

## Steuerliche Auswirkung

<!--
Ändert sich eine berechnete Zahl, eine ELSTER-Kennzahl oder eine Frist?
Dann bitte die Quelle (Gesetz, BMF-Schreiben) nennen und in
docs/references/tax-sources.md mit Abrufdatum und Veranlagungszeitraum eintragen.
Sonst: „keine".
-->

## Geprüft

- [ ] `gjsify run check` (Typprüfung über alle Workspaces)
- [ ] `cd app && gjsify run format:check`
- [ ] `cd app && gjsify run test`
- [ ] Bei Änderungen an der Oberfläche: auf den Demo-Daten angesehen
