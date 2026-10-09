# Prozess: Jahresabschluss & EÜR

**Ziel:** Jährliche Gewinnermittlung und Steuererklärungen.

## Einnahmenüberschussrechnung (EÜR)

* **Prinzip:** Einnahmen - Ausgaben = Gewinn.
* Formular: Anlage EÜR in ELSTER.
* Wird zusammen mit der Einkommensteuererklärung abgegeben.

## Umsatzsteuererklärung

* Zusammenfassung aller Voranmeldungen des Jahres.
* Korrektur eventueller Fehler aus den Voranmeldungen.
* Berechnung der endgültigen Zahllast für das Jahr.

## Vorbereitung für den Steuerberater (falls vorhanden) oder Selbsterstellung

* Vollständigkeit aller Belege prüfen (Lückenlosigkeit).
* Bankkontoumsätze mit Belegen abgleichen.
* Anlagenverzeichnis führen (für Abschreibungen, z.B. Laptop, Server).

## Tooling-gestützter Ablauf (steuererklaerung-CLI)

Gewinnermittlung per EÜR aus Paperless-Belegen + Kontobewegungen. Funktioniert auch für
**geschlossene Konten** (aufgelöstes Unternehmen, gekündigtes Bankkonto), deren Verlauf nur noch
als CAMT-Export vorliegt und nicht mehr über die Qonto-API erreichbar ist.

### Datengrundlage

* **Belege:** Paperless-NGX (Ein-/Ausgangsrechnungen mit extrahierten Feldern + `accounting_category`).
* **Kontobewegungen:** lokaler Transaktions-Store (`cli/transactions-data/`, gitignored). Geschlossene
  Konten per `transactions import <camt-export>` als `camt:<iban>` einlesen.
* **Prinzip:** EÜR ist **Zufluss-/Abflussprinzip** (§11 EStG) — maßgeblich ist das **Zahldatum**
  (Bankbuchung), nicht das Rechnungsdatum. Deshalb muss jeder Beleg an seine Buchung gekoppelt sein.

### Ablauf

1. **CAMT importieren** (einmalig, nur bei geschlossenem/Fremdkonto):
   `gjsify run start transactions import <pfad-zum-camt-export>`
2. **KI-Felder + Buchungskategorie** über alle Jahres-Belege (überschreibend):
   `gjsify run start paperless extract-invoice-fields-incoming --auto --force --from <jahr>-01-01 --to <jahr>-12-31`
   (und `…-outgoing`). Füllt Beträge, Datum und `accounting_category` (SKR03).
3. **Beleg ↔ Zahlung abgleichen** (setzt das Zahldatum aus dem Store):
   `gjsify run start reconcile store --year <jahr> --dry-run` prüfen, dann ohne `--dry-run`.
   Der Matcher nutzt Betrag + Richtung + **Rechnungsnummer im Verwendungszweck** + **nächstes Datum**
   (wiederkehrende gleiche Beträge) und verknüpft jede Buchung nur einmal (Dedup).
   *Live-Qonto-Konto:* stattdessen der bestehende Qonto-Abgleich (`sync match-qonto-paperless`).
4. **Lückenlosigkeit prüfen** (= „Bankkontoumsätze mit Belegen abgleichen"):
   `gjsify run start reconcile status --year <jahr>` → Buchungen ohne Beleg / Belege ohne Zahlung,
   inkl. belegfreier Buchungen (Übertrag, Gebühren, Privatentnahme).
5. **EÜR-Zahlen + Vollständigkeit:**
   `gjsify run start elster euer report --year <jahr>` (beleg-getrieben) → Summen je Kategorie + Kennzahlen-Blatt.
   `gjsify run start elster euer report --year <jahr> --by transactions` (**transaktions-getrieben**) → summiert
   **jede** Bankbuchung (Beleg liefert Netto/USt, EUR-Betrag aus der Buchung → Fremdwährung gelöst),
   kategorisiert beleglose Posten per Regel und weist **unklassifizierte Buchungen als echte Lücken** aus.
   Der transaktions-getriebene Modus ist die eigentliche **Vollständigkeitsprüfung**: erst wenn dort keine
   Buchung mehr „unklar" ist, ist die EÜR vollständig. Abgrenzung der Firma über die Konten
   (`--account-key`, Default: alle `camt:`-Konten = das geschlossene Unternehmen).

### Formular-Output — Stand

Jedes Formular hat `report` (Zusammenfassung, `--pdf` = Prüf-Datenblatt), `generate-xml` und
`validate-eric`. Stand 2026-07-15: **alle fünf sind ERiC-validiert**.

| Erklärung | XML | Abgabeweg |
|-----------|-----|-----------|
| **USt-VA** (Voranmeldung) | ✅ `elster ustva generate-xml` | **XML-Upload** in Mein ELSTER (als einziges Formular unterstützt das Portal den Import). |
| **Anlage EÜR** | ✅ `elster euer generate-xml` (`EUER_2025`) | Web-Formular; bei einer GbR fährt sie *innerhalb* der Feststellung mit. |
| **USt-Jahreserklärung** | ✅ `elster uste generate-xml` (`USt_2025`) | Web-Formular aus dem Prüf-Datenblatt. |
| **Gewerbesteuererklärung** | ✅ `elster gewst generate-xml` (`GewSt_2025`) | Web-Formular. |
| **Feststellungserklärung** (GbR) | ✅ `elster feststellung generate-xml` (`FEIN_90_2025`) | Web-Formular (ESt 1 B). |
| **Einkommensteuer** (privat) | ❌ offen (Schema `E10`, siehe [references/elster-schemas.md](../references/elster-schemas.md)) | Web-Formular; `elster est report` liefert die Schätzung. |

> ⚠ **Warum trotz XML das Web-Formular?** Der Portal-Import akzeptiert nur die USt-VA; der direkte
> ERiC-Versand (`elster submit`) ist mangels **Hersteller-ID** gesperrt. Das XML dient daher als
> *Plausibilitätsprüfung* (`validate-eric`) und Grundlage des Prüf-Datenblatts — eingetragen wird
> von Hand. Siehe Memory `elster-manual-xml-upload`.

> ⚠ Die Kz-Zuordnung der Anlage EÜR (SKR03 → Kennzahl) in `elster euer report` ist **Best-Effort** —
> vor Abgabe gegen das offizielle Anlage-EÜR-Formular prüfen.

> ⚠ **Zahlen immer aus einem frischen Build.** `app/dist/*.mjs` sind Artefakte und veralten still;
> ein altes Bundle liefert plausibel aussehende, falsche Beträge. Vor jeder Abgabe neu bauen
> (`npx gjsify build src/index.ts --app node --outfile dist/steuer.node.mjs --external koffi`;
> die `--pdf`-Prüfblätter brauchen den `--app gjs`-Build wegen Cairo/Pango).

### Anlagenverzeichnis (AfA)

GWG (`0420 Büroeinrichtung/GWG`) und der AfA-Betrag (`4830 Abschreibungen (AfA)`) erscheinen als
eigene Kategorien im EÜR-Report. Der **AfA-Betrag selbst** (Anlagenverzeichnis, Nutzungsdauer,
mehrjährige Verteilung für Laptop/Server …) wird **nicht** vom Tool berechnet — Anlagenverzeichnis
manuell führen und den Jahres-AfA-Betrag als Buchung/Beleg mit Kategorie `4830` einstellen.

Die `accounting_category` deckt einen vollständigen SKR03-Satz für eine Dienstleistungs-GbR ab
(Einnahmen 19/7 %/§13b/steuerfrei/sonstige; Ausgaben inkl. Personal, Miete/Raumkosten, Versicherung,
Künstlersozialkasse, Werbung, Reise/Bewirtung, Fortbildung, AfA; neutral inkl. USt-Zahllast und
Gewerbesteuer) — siehe `ACCOUNTING_CATEGORY_OPTIONS` in der CLI.
