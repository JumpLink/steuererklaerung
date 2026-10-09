# Prozess: Rechnungsstellung

Für ein regelbesteuertes (nicht kleinunternehmerisches) Unternehmen müssen Rechnungen die
formalen Anforderungen des § 14 UStG erfüllen. Die App erzeugt sie aus der `invoicing.self`-Sektion
der Entität in `steuererklaerung.json`; die Pflichtangaben unten sind die Prüfliste dahinter.

## Pflichtangaben auf der Rechnung

1. **Name & Anschrift des Leistenden** (aus `invoicing.self.issuer`)
2. **Name & Anschrift des Leistungsempfängers** (Kunde)
3. **Steuernummer oder USt-IdNr.** (`issuer.taxNumber` / `issuer.vatId`; eine von beiden ist
   Pflicht, damit eine Rechnung festgeschrieben werden kann)
4. **Ausstellungsdatum**
5. **Fortlaufende Rechnungsnummer** (einmalig vergeben)
6. **Menge und Art der Leistung** (Leistungsbeschreibung)
7. **Zeitpunkt der Leistung** (Lieferdatum oder Leistungszeitraum)
8. **Netto-Entgelt** (Betrag ohne Steuer)
9. **Steuersatz** (in der Regel 19%)
10. **Steuerbetrag** (der errechnete MwSt-Betrag)
11. **Brutto-Betrag** (Summe aus Netto + Steuer)

## Hinweise, die auf die Rechnung gehören

- **Ist-Versteuerung** (§ 20 UStG), sofern genehmigt — die App setzt den Satz als
  `DEFAULT_INVOICE_FOOTER`:
  > **„Es gilt die Besteuerung nach vereinnahmten Entgelten (§ 20 UStG)."**
- **Kleinunternehmer** (§ 19 UStG): dann keine USt ausweisen und stattdessen den §-19-Hinweis
  setzen — `invoicing.self.issuer.kleinunternehmer: true` erledigt beides.
- **Reverse Charge** (§ 13b UStG) bei Leistungen an Unternehmer im EU-Ausland: „Steuerschuldnerschaft
  des Leistungsempfängers", USt-IdNr. beider Seiten auf der Rechnung.

Wiederverwendbare Rechnungs- und E-Mail-Texte (Anschreiben, Hinweis auf eine geänderte
Bankverbindung, Mahntexte) sind Betriebsinterna und gehören in die eigene Ablage, nicht ins Repo.

## Workflow

1. Rechnung anlegen — `invoices create` bzw. in der Web-/App-Oberfläche; die Nummer kommt
   fortlaufend aus dem Nummernkreis (`invoicing.self.numberPrefix`).
2. Prüfen und **festschreiben** — danach ist sie unveränderlich, Korrekturen laufen über eine
   Storno-Rechnung.
3. PDF (+ XRechnung/CII-XML) erzeugen und an den Kunden senden.
4. Kopie ins DMS legen und mit der Zahlung verknüpfen (`reconcile store`), damit sie in der EÜR
   am Zahldatum landet (§ 11 EStG).
