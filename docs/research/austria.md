# Austria: feasibility for sole traders and freelancers

Question: how much work is it to support Austrian sole traders (Einzelunternehmer, freie Berufe) as a second country?

Data retrieved 2026-10-09. Primary sources: BMF, RIS (EStG 1988, UStG 1994, UGB), USP.gv.at. Facts I could not confirm at a primary source are marked **unverified** (collected in [Unverified](#unverified)). Tax constants change yearly, so this page names where a number lives instead of copying tariff tables.

## Verdict

Electronic filing is feasible without a vendor certification process or a native library. FinanzOnline (FON) exposes SOAP webservices and openly published XSDs, and has a test mode. It is simpler to integrate than ERiC, but it is a different protocol, so none of the ERiC client code carries over.

## 1. Profit determination

| Topic | Austria | Germany (this app) |
|---|---|---|
| Cash-basis profit | Einnahmen-Ausgaben-Rechnung, [§ 4 Abs. 3 EStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=4) | EÜR, § 4 Abs. 3 EStG |
| Flat-rate profit | Pauschalierung inside E/A, § 4 Abs. 3a EStG and § 17 EStG (Basispauschalierung) | Betriebsausgabenpauschale only for narrow groups |
| Bookkeeping duty | [§ 189 UGB](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10001702): above 700,000 € revenue in two consecutive years; BMF announced a raise to 1 Mio. € ([press release](https://www.bmf.gv.at/presse/pressemeldungen/2026/april-2026/buchfuehrungsgrenzen.html)), date **unverified** | Bilanzierung duty by § 140/141 AO |
| Form | E1a (Beilage zur E1) for E/A profit; E1 is the main form | Anlage EÜR + Anlage G/S |

- Basispauschalierung: rate 12% until 2024, 13.5% for 2025, 15% from 2026; turnover limit 320,000 € rises to 420,000 € on 1.1.2026 ([USP](https://www.usp.gv.at/aktuelles/newsliste/basispauschalierung-hoehere-grenzen-ab-2025-und-2026.html), WKO as [secondary](https://www.wko.at/steuern/neuerungen-basispauschalierung-2026)). The maximum flat-rate amount is **unverified**.
- Mapping to the EÜR: the cash-basis logic (Zufluss/Abfluss) is the same, so booking and category data models carry over. The Austrian line items (Kennzahlen on E1a) differ. The exact Kennzahlen list is **unverified**; the XSD and "Allgemeines" PDF per year are at [BMF Jahreserklärungen](https://www.bmf.gv.at/services/finanzonline/informationen-fuer-softwarehersteller/softwarehersteller-jahreserklaerungen.html), including "Prüfungen Gewinnfreibetrag E1a" and "Wertevorrat Branchenkennzahl".

## 2. VAT

| Topic | Austria | Germany |
|---|---|---|
| Return | UVA, form U30 | USt-VA |
| Period | Quarter if prior-year turnover ≤ 100,000 €, else month; month can be chosen by filing the first month ([§ 21 Abs. 1 UStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=21)) | Monthly/quarterly by prior-year tax amount |
| Due date | 15th of the second following month | 10th of the following month (+ Dauerfristverlängerung) |
| Annual return | U1 (with E1) | USt-Erklärung |
| Small business | Kleinunternehmer from 1.1.2025: 55,000 € gross, previous and current year, 10% tolerance in the year of exceeding; no UVA/U1 unless opted in; opt-out binds for 5 years ([§ 6 Abs. 1 Z 27 UStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=6), [USP](https://www.usp.gv.at/themen/steuern-finanzen/umsatzsteuer-ueberblick/weitere-informationen-zur-umsatzsteuer/weitere-steuertatbestaende-und-befreiungen/kleinunternehmen.html)) | § 19 UStG: 25,000 € / 100,000 € |
| Rates | 20% ([§ 10 Abs. 1](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=10)), 13%, 10%; 4.9% for Anlage 3 goods (§ 10 Abs. 1a) | 19% / 7% |
| Cash-basis VAT | Ist-Versteuerung for non-bookkeeping persons with turnover ≤ 110,000 € in one of the two prior years ([§ 17 Abs. 2 Z 1](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=17)) | § 20 UStG |

Two rates (13% and 10%) plus 4.9% need a rate model that is not hardcoded to 19/7. The UVA XSD "ab 07/2026" is listed on the [BMF Erklärungen page](https://www.bmf.gv.at/services/finanzonline/informationen-fuer-softwarehersteller/softwarehersteller-erklarungen-und-antraege.html) next to the older "ab 01/2022" version. Expect XSD versions to change, as with ERiC.

## 3. Income tax

- Forms: E1 plus E1a, filed together with U1 as `JAHR_ERKL` (see section 5). Obligation to file: [§ 42 EStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=42). Advance payments: § 45 EStG.
- Tariff: [§ 33 Abs. 1 EStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=33), progressive from 0% up to 50% in bands (bands are indexed; the RIS text of 2026-10-09 notes a different § 1 limit for 2027 under BGBl. II Nr. 260/2026). Which year each band belongs to is **unverified** in my extraction, so read the constants per year from RIS or the BMF tariff page and record them in a tax-sources registry like [references/tax-sources.md](../references/tax-sources.md).
- Gewinnfreibetrag ([§ 10 EStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=10)): 15% on the first 33,000 € of profit (Grundfreibetrag, max 4,950 €, no investment needed); 13% / 7% / 4.5% on the next 145,000 / 175,000 / 230,000 €; 46,400 € total cap. With § 17 flat rates only the Grundfreibetrag applies (§ 10 Abs. 1 Z 6). The investment-backed part needs asset tracking the app does not have.
- Income types: § 22 selbständige Arbeit (freie Berufe) and § 23 Gewerbebetrieb ([§ 2 Abs. 3](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=2)). Both file E1a, so the split matters little for the app.
- SVS (Sozialversicherung der Selbständigen): contributions are assessed on the income tax assessment. Relevant for a net-income estimate, not for filing. Details **unverified**.

## 4. Trade tax

Austria has no Gewerbesteuer. Employers pay Kommunalsteuer on payroll (KommStG); sole traders without employees do not. Both statements are **unverified** at a primary source (KommStG not fetched). Consequence: no equivalent of the German GewSt module is needed.

## 5. Electronic filing

Interface: FinanzOnline webservices, SOAP over TLS. Documentation: [BMF Datenstromübermittlung](https://www.bmf.gv.at/services/finanzonline/informationen-fuer-softwarehersteller/datenstromuebermittlung.html) and [Webservices](https://www.bmf.gv.at/services/finanzonline/informationen-fuer-softwarehersteller/softwarehersteller-sonstige-funktionen.html).

| Aspect | Finding |
|---|---|
| Flow | `login` ([Session WSDL](https://finanzonline.bmf.gv.at/fonws/ws/sessionService.wsdl)) → `upload` ([File Upload WSDL](https://finanzonline.bmf.gv.at/fon/ws/fileuploadService.wsdl)) → read result in the DataBox (Übermittlungsprotokoll) → `logout` |
| Authentication | `tid` (Teilnehmer-ID), `benid` and `pin` of a dedicated "Webservice" user the taxpayer creates in FON Benutzerverwaltung, plus `herstellerid` |
| `herstellerid` | UID number of the software vendor. No registration or certification step appears in the BMF docs; **unverified** whether one exists in practice |
| Test environment | Yes: `uebermittlung` = `T` (test) or `P` (production). Test data "gelten nicht als eingebracht". One submission at a time, one declaration type at a time |
| Payload | XML in CDATA, UTF-8, envelope `ERKLAERUNGS_UEBERMITTLUNG` with `INFO_DATEN` and `ERKLAERUNG art=…`. `art` values: `U30` (UVA), `JAHR_ERKL` (E1, E1a, U1, K1, …), `U13` (ZM), `FVAN` (extension), … Max ~5 MB and ≤ 50 declarations per package (recommended) |
| Checks | Formal check immediately; content check during processing, result in the DataBox |
| Schemas | XSDs and PDF specs published openly per year (2019–2025 for Jahreserklärungen). Licence terms **unverified** |
| Support | BMF hotline does not support webservice setup |

Compared to ERiC: no native library, no certificate files, no per-year binary. Instead, plain HTTPS/SOAP from GJS (libsoup) plus XSD-conformant XML generation. Per-user credentials live in the keyring like the Qonto key.

Manual alternative: upload the XML by hand in the FON web UI. Useful as a fallback for the first milestone.

## 6. E-invoicing

| Topic | Austria | Germany |
|---|---|---|
| Content rules | [§ 11 UStG](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=11): invoices over 10,000 € need the recipient's UID if the supplier is domestic and the recipient a business. Small-invoice limit (400 €) **unverified** | § 14 UStG, Kleinbetragsrechnung 250 € |
| B2G | ebInterface via USP or Peppol; paper still accepted ([USP](https://www.usp.gv.at/themen/steuern-finanzen/umsatzsteuer-ueberblick/weitere-informationen-zur-umsatzsteuer/vorsteuerabzug-und-rechnung/e-rechnung-an-die-oeffentliche-verwaltung.html), [ebInterface](https://www.erechnung.gv.at/erb/tec_formats_ebinterface)) | XRechnung/ZUGFeRD |
| B2B | No mandate found as of July 2026 (secondary source only, **unverified**) | Receive mandate since 2025 |
| ZUGFeRD/Factur-X | Acceptance **unverified** | Accepted |

Gap: an ebInterface writer is needed for B2G customers; B2B invoices can keep PDF/ZUGFeRD output.

## 7. Bank data

Not researched at a primary level; availability of CAMT.052/053 exports, EBICS and FinTS at Austrian banks is **unverified**. The existing Qonto and CAMT import is country-neutral, so it carries over. Only IBAN (AT) validation and the booking-text patterns need checks.

## 8. Effort estimate

| Area | Reuse | New work | Size |
|---|---|---|---|
| Bookings, receipts, categories, CAMT/Qonto import, Paperless link | high | Austrian category set (E1a lines) | S |
| Country abstraction (tax-profile per country: rates, thresholds, due dates, forms) | none | Today's code assumes DE constants; needs a profile layer | M |
| E/A profit + Gewinnfreibetrag + Pauschalierung | partial (EÜR logic) | E1a mapping, flat-rate variants | M |
| UVA (U30) generation and plausibility checks | partial (USt-VA logic) | Rates, Kleinunternehmer 55,000 € rule, XSD "ab 07/2026" | M |
| FON client (session, upload, DataBox, test mode) | none (ERiC client is DE-only) | SOAP client, credentials, result parsing | M |
| E1/E1a/U1 annual filing | none | XSD-conformant XML, Prüfungen PDFs per year | L |
| ebInterface invoices | partial (invoice model) | New serializer | S–M |
| Localisation (de-AT wording, UID, Steuernummer + Finanzamt format) | high | small | S |

Total: roughly **L** for a complete product (UVA + annual filing), **M** for UVA only.

**Biggest risk:** correctness of the annual returns. The E1/E1a/U1 XSDs change each year, content checks run asynchronously in the DataBox, and the tax constants (tariff, Gewinnfreibetrag, flat rates) move yearly. A second risk is that the FON webservice account setup is unsupported by the hotline, which hurts end-user onboarding.

**Recommended first milestone:** read-only E/A profit and UVA preview for one Kleinunternehmer-or-quarterly profile, computed from existing bookings, with the UVA XML generated and validated against the BMF XSD. Then test-mode upload (`uebermittlung=T`) before any production submission.

## Unverified

1. UGB § 189 raise to 1 Mio. € (date, entry into force)
2. Basispauschalierung maximum amount
3. § 11 UStG small-invoice limit (400 €)
4. E1a Kennzahlen list
5. XSD licence terms
6. Vendor registration for `herstellerid` (none found)
7. ZUGFeRD/Factur-X acceptance
8. No B2B e-invoice mandate (secondary source only)
9. Year assignment of the § 33 tariff bands
10. Kommunalsteuer / no Gewerbesteuer (KommStG not fetched)
11. SVS contribution details
12. Bank interface availability (CAMT, EBICS, FinTS) in Austria
