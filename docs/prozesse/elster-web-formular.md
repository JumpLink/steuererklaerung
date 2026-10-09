# ELSTER-Web-Formular ausfüllen — Ablauf, Fallen, offene Lücken

Wie ein Jahresformular aus unserem Prüf-Datenblatt in **Mein ELSTER** eingetragen wird, was das
Tooling dabei *nicht* liefert, und welche Werte man **nicht** blind aus der Config übernehmen darf.

Warum überhaupt von Hand: der Portal-XML-Import kann nur die USt-VA, und der direkte ERiC-Versand
ist mangels **Hersteller-ID** gesperrt (siehe [jahresabschluss.md](jahresabschluss.md) und Memory
`elster-manual-xml-upload`). Das XML dient als Plausi-Prüfung (`validate-eric`) und als Grundlage
des Prüfblatts — eingetragen wird im Browser.

## Ablauf

1. **Immer zuerst neu bauen.** `dist/*.mjs` sind Artefakte und veralten still — ein altes Bundle
   liefert plausible, falsche Zahlen (siehe „Stale-Bundle" unten).
   ```
   cd app && npx gjsify build src/index.ts --app node --outfile dist/steuer.node.mjs --external koffi
   ```
2. **Prüfblätter erzeugen** (PDF braucht den `--app gjs`-Build wegen Cairo/Pango):
   ```
   npx gjsify run dist/steuer.gjs.mjs elster <form> report --entity <entity-id> --year <jahr> --pdf elster/<jahr>-abgabe/<n>-<form>-<entity>.pdf
   ```
   Die Nummerierung in `app/elster/<jahr>-abgabe/` ist die Abgabereihenfolge.
3. **Eintragen** in Mein ELSTER, **prüfen lassen**, Übersicht gegenlesen, absenden.
4. **Übertragungsprotokoll** als PDF in denselben Ordner legen — es ist der einzige belastbare
   Nachweis dessen, was tatsächlich übermittelt wurde.

> Bei einer GbR fährt die **Anlage EÜR innerhalb der Feststellung (ESt 1 B)** mit — sie ist kein
> eigener Vorgang.

## Fallen, die Zeit gekostet haben

### Stale-Bundle (kostet fast eine Berichtigung)
Ein 5 Tage altes `dist/steuer.node.mjs` kannte eine erst danach ergänzte Klassifizierungsregel
nicht → eine Gruppe von Spenden fiel in `4670 Reisekosten` → der Gewinn wich um einen dreistelligen
Betrag von der bereits abgegebenen Feststellung ab. Es sah nach einem Rechenfehler aus; Ursache war
nur das Bundle. **Vor jeder Zahl neu bauen.**

Warum die Regel nötig ist: die Bank schreibt die **Kartennetz-Kategorie** wörtlich in den
Verwendungszweck — `NONREF Travel Expenses Sonstige Reisekosten 7128 ‹GNOME.ORG* DONATION GN›`.
Keyword-Regeln matchen darauf, obwohl es eine Spende ist. Solche Merchant-Category-Texte sind
generell Gift für die Klassifizierung.

### Nicht im Formular per URL navigieren
Ein `goto` auf eine Teilseite löst „Website verlassen?" aus und verwirft die Eingaben. Nur die
formulareigenen Elemente benutzen:
- **„Nächste Seite"** / Breadcrumb für den linearen Weg;
- die **Navigation „Navigationsbereich"** (linke Seitenleiste) springt direkt zu einer Teilseite,
  z. B. `nav[aria-label*="Navigationsbereich"] >> text=12 - K. Berechnung …`;
- von der Absenden-Seite zurück: **„Angabe bearbeiten"** öffnet einen Modal-Dialog („Um Angaben zu
  bearbeiten, werden Sie zum Eingabemodus weitergeleitet") → dort **„Weiter zum Eingabemodus"**.
  Der Button selbst navigiert nicht, der Dialog blockiert danach alle anderen Klicks.

### Rechenfelder aktualisieren sich nur bei echter Interaktion
Ein `fill()` plus manuell dispatchtes `change` reicht **nicht** — die Summen bleiben alt. Nach einer
Eingabe mit einem echten Playwright-`click()` in ein anderes Feld wechseln, dann rechnet ELSTER nach.

### Config-Werte sind nicht automatisch korrekt
Vor der Übernahme gegen das **letzte Übertragungsprotokoll** prüfen — die Config ist von Hand
gepflegt und driftet still. Zwei Fälle, die genau so aufgetreten sind: `betrieb.art` (die
Tätigkeitsbezeichnung) wich von der in der zuletzt abgegebenen Erklärung verwendeten ab, und
`betrieb.widnr` enthielt die **USt-IdNr** statt der W-IdNr — zwei verschiedene Nummern, die sich
zum Verwechseln ähnlich sehen. Das Schema unterscheidet sie inzwischen ausdrücklich.

## Was das Tooling (noch) nicht liefert

| Lücke | Wirkung | Wo |
|---|---|---|
| **Prüfblatt rechnet nicht wie das Formular.** Wir summieren die tatsächlichen USt-Beträge je Beleg; die Jahreserklärung leitet die Steuer aus der **auf volle Euro abgerundeten** Bemessungsgrundlage je Steuersatz ab. | Cent-Differenz in Zahllast + Abschlusszahlung. Maßgeblich ist das Formular. | `elster uste report` sollte BMG (abgerundet) **und** die daraus abgeleitete Steuer je Satz ausweisen. |
| ~~**Kz 81 ist ein Sammelposten**~~ — **GESCHLOSSEN.** Der Report weist jetzt Zeile 22 / 23 / 24 getrennt aus (`lieferungenSonstLeistungen_19` / `wertabgabeLieferung_19` / `wertabgabeSonstige_19`), und das XML emittiert `Unent_Wertabgaben`. | — | — |
| ~~**Betriebsaufgabe fehlte umsatzsteuerlich**~~ — **GESCHLOSSEN.** Die Entnahme ins Privatvermögen ist eine Lieferung nach §3 Abs. 1b Nr. 1 UStG; BMG = Wiederbeschaffungswert (§10 Abs. 4 Nr. 1) = der gemeine Wert des Aufgabegewinns. `uste-aggregate` kannte die Aufgabe nicht → die USt darauf fehlte still. | Die Abschlusszahlung des Aufgabejahres war um die USt auf den Entnahmewert zu niedrig. | Neu: `usteEntnahme()` + `anlageverzeichnis.vorsteuerabzug` (ohne Vorsteuerabzug beim Kauf keine Entnahmebesteuerung). |
| **§13b-Steuer wird im Formular nicht berechnet.** ELSTER rechnet Zeile 22 automatisch, Zeile 65/67 aber nicht — die Steuer muss man selbst eintragen. | Beide §13b-Seiten (geschuldete USt + Vorsteuer) müssen **denselben** Betrag tragen, sonst verschiebt sich die Zahllast. §13b ist sonst ein Nullsummenspiel. | Prüfblatt sollte die §13b-Steuer je Zeile aus der gerundeten BMG ausweisen. |
| ~~**Vorauszahlungssoll ist geraten.**~~ — **ADRESSIERT.** Der Report beschriftet die Herkunft von Z119 klar („aus UNSEREM Filing-Register … gegen das ELSTER-Steuerkonto abgleichen"), und `elster crosscheck` markiert automatisch jede Abweichung zwischen dem im Register Σ-angemeldeten und den berechneten Quartalen (steuererklaerung b974cfe). | Weiterhin manuell: der Abgleich gegen das **amtliche Soll des Finanzamts** (ELSTER-Steuerkonto) ist NICHT automatisch — der Report weist nur das eigene Register aus. | — |
| ~~**Filing-Register wird nicht gepflegt.**~~ — **ADRESSIERT.** Das Register führt jetzt die 2025er Feststellung/GewSt/USt-Jahr-Abgaben mit Transfertickets; `list_filings` und die Crosschecks laufen gegen den aktuellen Stand. | — | Nach jeder Abgabe Transferticket + Status erfassen. |
| **W-IdNr fehlt.** Die UStE 2025 gibt einen (advisorischen) Hinweis „Bitte geben Sie Ihre Wirtschafts-Identifikationsnummer an". | Kein Fehler, senden geht. Die W-IdNr muss man beim BZSt / in Mein ELSTER nachsehen — **nicht** die USt-IdNr eintragen (siehe „Config-Werte" oben). | — |

## Fehlende Werkzeuge (damit man die Config nicht von Hand lesen muss)

Beim Ausfüllen brauchte es Daten, die weder CLI noch MCP herausgeben — sie mussten mit `python3`
direkt aus `elster-config-gbr.json` gelesen werden. Das ist umständlich und fehleranfällig:

- **Stammdaten-Abruf**: `elster stammdaten --entity <e>` bzw. ein MCP-Tool, das Name, Art,
  Anschrift (getrennt!), Steuernummer, Finanzamt, USt-IdNr/W-IdNr, Rechtsform,
  `business_end_date` und Versteuerungsart (ist/soll) liefert.
- **Anpassungen sichtbar machen** — **ERLEDIGT.** `elster uste report --vordruck` zeigt jetzt einen
  Abschnitt „Stille Anpassungen": `adjustments.privatanteile` → UStE Zeile 24 (§3 Abs. 9a UStG,
  sonstige Leistung), die Betriebsaufgabe-Entnahme aus dem `anlageverzeichnis` → Zeile 23
  (§3 Abs. 1b UStG, Lieferung) und die `sonderbetriebsausgaben` → Feststellung (Anlage FE, kein
  USt-Bezug) — je mit betroffener Zeile und §-Grund. Beispiel: ein Telefon-Privatanteil steht
  in **Zeile 24** (sonstige Leistung §3 Abs. 9a) — eine *Lieferung* müsste in Zeile 23. Nur Anzeige;
  die Beträge stecken bereits in den berechneten Zahlen.
- **Formularzeilen-Mapping** — **ERLEDIGT.** `elster uste report --vordruck` (auch `--vordruck --json`)
  gibt je Zahl die **Vordruckzeile** des Jahresformulars aus (Zeile 22/23/24/25/37/65/67/68/79/83/87/
  118/119/120) statt der USt-VA-Kennzahlen. Die Zeilen sind eine reine, jahres-geschlüsselte Tabelle
  im Kern (`app/src/core/elster/vordruck-lines.ts`), **maschinell aus der lokalen ERiC-
  `Jahresdokumentation_50_2025.xml`** (Worksheet „USt2A - Felder", Spalte „Vordruckzeile") extrahiert
  — keine geratenen Nummern. Siehe [../references/elster-schemas.md](../references/elster-schemas.md).

## Verwandtes

- [jahresabschluss.md](jahresabschluss.md) — der Jahresablauf + Formular-Status.
- [../references/elster-schemas.md](../references/elster-schemas.md) — DatenArt/Root/Kennzahlen je Formular.
- [../references/tax-sources.md](../references/tax-sources.md) — die steuerrechtlichen Konstanten.
