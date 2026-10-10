# Steuerrechtliche Quellen & Konstanten (zentrale Referenz)

Zentrale, **gegenprüfbare** Registrierung aller steuerrechtlichen Annahmen, Konstanten und
Formeln, die im Code (Kern-Berechnungen, ELSTER-Aufbereitung, Schätzungen) verwendet werden.
Diese App ist self-service Buchhaltung/Steuer ohne Steuerberater — jede rechtliche Zahl **muss**
hier mit **Quelle + Abrufdatum** hinterlegt sein, damit sie geprüft und (jährlich!) aktualisiert
werden kann.

> ⚠️ **Viele Werte ändern sich jährlich** (Grundfreibetrag, Tarif-Koeffizienten, Pauschbeträge).
> Jede Konstante trägt das **Jahr** (Veranlagungszeitraum) und den **Abrufstand**. Vor der Abgabe
> eines Steuerjahres die hier verlinkten Quellen gegen den aktuellen Stand prüfen.
>
> Die App-eigenen Berechnungen sind **Schätzungen/Vorbereitungen** — die verbindliche Festsetzung
> macht das Finanzamt; die ELSTER-Übermittlung validiert ERiC.

Verwendung im Code: Konstanten liegen in `app/src/core/elster/*` (z. B. `est-tarif.ts`) und
verweisen per Kommentar auf den passenden Abschnitt hier.

---

## §32a EStG — Einkommensteuertarif (Grundtabelle, Einzelveranlagung)

`x` = zu versteuerndes Einkommen (zvE), auf volle Euro abgerundet. Ergebnis auf volle Euro
abgerundet. **Splittingtarif** (Zusammenveranlagung): ESt = 2 × Tarif(zvE/2).

### VZ 2025 — Abrufstand 2026-07-08
Quelle: <https://www.finanz-tools.de/einkommensteuer/berechnung-formeln/2025> (mit dem amtlichen
BMF-Lohnsteuer-Handbuch LStH 2025 §32a abgeglichen: <https://lsth.bundesfinanzministerium.de/lsth/2025/A-Einkommensteuergesetz/IV-Tarif-31-34b/Paragraf-32a/inhalt.html>).

| Zone | zvE-Grenzen (€) | Formel |
|---|---|---|
| 1 | 0 – 12.096 | ESt = 0 (Grundfreibetrag 12.096) |
| 2 | 12.097 – 17.443 | `y = (zvE − 12.096)/10000`; ESt = (932,30 · y + 1.400) · y |
| 3 | 17.444 – 68.480 | `z = (zvE − 17.443)/10000`; ESt = (176,64 · z + 2.397) · z + 1.015,13 |
| 4 | 68.481 – 277.825 | ESt = 0,42 · zvE − 10.911,92 |
| 5 | ab 277.826 | ESt = 0,45 · zvE − 19.246,67 |

### VZ 2026 — Abrufstand 2026-07-08 (zum Vergleich; Grenzen/Koeffizienten weichen ab!)
Quelle: <https://www.gesetze-im-internet.de/estg/__32a.html> (Fassung „ab VZ 2026").

| Zone | zvE-Grenzen (€) | Formel |
|---|---|---|
| 1 | 0 – 12.348 | ESt = 0 (Grundfreibetrag 12.348) |
| 2 | 12.349 – 17.799 | `y = (zvE − 12.348)/10000`; ESt = (914,51 · y + 1.400) · y |
| 3 | 17.800 – 69.878 | `z = (zvE − 17.799)/10000`; ESt = (173,10 · z + 2.397) · z + 1.034,87 |
| 4 | 69.879 – 277.825 | ESt = 0,42 · zvE − 11.135,63 |
| 5 | ab 277.826 | ESt = 0,45 · zvE − 19.470,38 |

---

## Private ESt — Pauschbeträge, §35a, Vorsorge, Annexsteuern (VZ 2025)

Abrufstand 2026-07-08, sofern nicht anders vermerkt. **Vor Abgabe gegen die amtlichen 2025er
Vordrucke/EStH gegenprüfen** (v. a. die mit „prüfen" markierten stabilen Werte, die ich nicht
einzeln per Suche verifiziert habe).

| Größe | VZ 2025 | § | Quelle / Stand |
|---|---|---|---|
| Arbeitnehmer-Pauschbetrag (Werbungskosten §19) | 1.230 € | §9a S. 1 Nr. 1a | stabil seit 2023 — **prüfen** gg. Anlage N 2025 |
| Homeoffice-(Tages-)Pauschale | 6 €/Tag, max. 210 Tage = **1.260 €** | §4 Abs. 5 S. 1 Nr. 6c i. V. m. §9 Abs. 5 | seit 2023 — **prüfen** |
| Entfernungspauschale | 0,30 €/km (1.–20. km), **0,38 €/km ab 21. km** (einfache Strecke) | §9 Abs. 1 S. 3 Nr. 4 | seit 2022/24 — **prüfen** |
| §35a Handwerkerleistungen | 20 % der **Arbeits-/Fahrt-/Maschinenkosten** (kein Material), max. **1.200 €**; unbar | §35a Abs. 3 + Abs. 5 | **prüfen** |
| §35a haushaltsnahe Dienstleistungen | 20 %, max. **4.000 €**; unbar | §35a Abs. 2 | **prüfen** |
| §35a haushaltsnahe Beschäftigung (Minijob) | 20 %, max. **510 €** | §35a Abs. 1 | **prüfen** |
| Sonderausgaben-Pauschbetrag (Nicht-Vorsorge) | 36 € (Einzel) / 72 € (Zusammen) | §10c | **prüfen** |
| Schulgeld (Ersatz-/Privatschule) | **30 %** des Entgelts (ohne Beherbergung/Betreuung/Verpflegung), max. **5.000 €** je Kind; Höchstbetrag je Elternpaar, bei nicht zusammenveranlagten Eltern je zur Hälfte (abweichend nur auf gemeinsamen Antrag) | §10 Abs. 1 Nr. 9 | gesetze-im-internet §10 · 2026-07-15 |
| Kinderbetreuungskosten | **80 % der Aufwendungen, max. 4.800 €** je Kind (ab VZ 2025, JStG 2024 — vorher 2/3 / 4.000 €); Kind < 14 J., zum Haushalt gehörend; Rechnung + **unbare** Zahlung Pflicht | §10 Abs. 1 Nr. 5 | gesetze-im-internet §10 · 2026-07-15 |
| Kindergeld | **255 €/Monat je Kind** (2025; ab 2026: 259 €) — Jahres-Anspruch für Anlage Kind Zeile 6 (`E0500702`); bei nicht zusammenveranlagten Eltern mit halbem Kinderfreibetrag der **halbe** Anspruch (so auch in einer vom Finanzamt akzeptierten Vorjahreserklärung angesetzt) | §66 Abs. 1 EStG (SteuerfortentwicklungsG) | bundestag.de/Haufe · 2026-07-15 |
| Sparer-Pauschbetrag | 1.000 € (Einzel) / 2.000 € | §20 Abs. 9 | seit 2023 — Phase 1 nur Hinweis |
| Spenden-Höchstbetrag | 20 % des Gesamtbetrags der Einkünfte | §10b Abs. 1 | **prüfen** |
| **Altersvorsorge-Höchstbetrag** (Basisrente, voll abziehbar) | **29.344 €** (Einzel) / 58.688 € (Zusammen); AG-Anteil abziehen | §10 Abs. 3 | <https://www.finanztip.de/vorsorgeaufwendungen/> + Haufe · 2026-07-08 |
| Sonstige Vorsorgeaufw. Höchstbetrag | 1.900 € (AN mit steuerfreiem AG-Zuschuss) / 2.800 € | §10 Abs. 4 | ebd. — Basis-KV/PV verdrängen den Höchstbetrag |
| **Soli-Freigrenze** (festzusetzende ESt) | **19.950 €** (Einzel) / 39.900 € (Zusammen); Milderungszone **11,9 %**, dann 5,5 % | §3, §4 SolZG | <https://www.bundesfinanzministerium.de/Content/DE/Standardartikel/Themen/Steuern/das-aendert-sich-2025.html> + steuern.de · 2026-07-08 |
| Kirchensteuersatz | 8 % (BY, BW) / 9 % (übrige Länder); gezahlte KiSt = Sonderausgabe (§10 Abs. 1 Nr. 4) im Zahlungsjahr | KiStG der Länder | **prüfen** je Bundesland |
| Zumutbare Belastung (agB) | Staffel §33 Abs. 3 (Tabelle unten), **stufenweise** je GdE-Band (BFH VI R 75/14) | §33 Abs. 3 | gesetze-im-internet §33 + BFH VI R 75/14 · 2026-07-08 |

### VZ 2026 — geänderte Werte (Delta ggü. VZ 2025)

Abrufstand 2026-07-24. Nur die **jahresabhängigen** Größen, die sich von VZ 2025 auf VZ 2026 ändern,
sind hier gelistet; alle übrigen Werte der 2025er Tabelle (Arbeitnehmer-Pauschbetrag 1.230 €,
Homeoffice 6 €/1.260 €, Sparer-Pauschbetrag 1.000 €, §35a-Deckel, Schulgeld, Kinderbetreuung,
§34g, §24b, Sonderausgaben-Pauschbetrag, sonstige Vorsorge 1.900/2.800 €, Zumutbare Belastung,
Soli-Sätze 11,9 %/5,5 %) gelten **unverändert** weiter (jeweils im Code-Kommentar als
„unverändert ggü. VZ 2025 (statutorisch)" bestätigt).

| Größe | VZ 2025 | **VZ 2026** | § | Quelle / Stand (VZ 2026) |
|---|---|---|---|---|
| **Entfernungspauschale** | 0,30 €/km (1.–20. km), 0,38 €/km ab 21. km | **0,38 €/km ab dem 1. km** (einheitlich; die 0,30-€-Staffel entfällt) | §9 Abs. 1 S. 3 Nr. 4 | **Steueränderungsgesetz 2025** (Bundestag 04.12.2025, Bundesrat 19.12.2025, im BGBl. verkündet, gilt ab 01.01.2026). <https://www.haufe.de/personal/entgelt/erhoehung-der-entfernungspauschale_78_532080.html> · <https://www.bundestag.de/dokumente/textarchiv/2025/kw49-de-steueraenderungsgesetz-1128142> · 2026-07-24. Im Code: `satzBis20` und `satzAb21` beide 0,38 → die Bandformel ergibt 0,38 · km. |
| **Altersvorsorge-Höchstbetrag** (Basisrente, voll abziehbar) | 29.344 € (Einzel) / 58.688 € | **30.826 €** (Einzel) / 61.652 € (Zusammen) | §10 Abs. 3 | Höchstbeitrag zur knappschaftlichen RV, aufgerundet: **BBG knappschaftlich 2026 = 124.800 €/Jahr** (10.400 €/Monat, SVBezGrV 2026) × **24,7 %** = 30.825,60 € → **30.826 €**. BBG: <https://www.deutsche-rentenversicherung.de/KnappschaftBahnSee/DE/Aktuelles/Meldungen/2026/2026_01_02_Sozialversicherungsrechengroessen2026> · Spiegel Betrag: <https://rentenbescheid24.de/rentenbeitraege-absetzen-2026-bis-30-826-e-hoechstbetrag-ausnutzen/> · 2026-07-24 |
| **Soli-Freigrenze** (festzusetzende ESt) | 19.950 € (Einzel) / 39.900 € | **20.350 €** (Einzel) / **40.700 €** (Zusammen); Milderungszone 11,9 %, dann 5,5 % (unverändert) | §3 Abs. 3 SolZG | Gesetzestext (aktuell in Kraft): <https://www.gesetze-im-internet.de/solzg_1995/__3.html> („in den Fällen des §32a Abs. 5/6 EStG 40 700 Euro, in anderen Fällen 20 350 Euro") · 2026-07-24 |

Nicht geändert (geprüft, VZ 2026 = VZ 2025): Arbeitnehmer-Pauschbetrag **1.230 €**
(<https://helferkasten.de/tools/arbeitnehmer-pauschbetrag.html> · 2026-07-24), Homeoffice-Pauschale
**6 €/Tag · max. 210 Tage · 1.260 €** und Sparer-Pauschbetrag **1.000 €**
(<https://www.finanzamt24.de/ratgeber/steuern-sparen-pauschalen/pauschbetraege-2026-diese-betraege-solltest-du-kennen/> · 2026-07-24).

### Zumutbare Belastung — Staffel §33 Abs. 3 EStG (stufenweise, BFH VI R 75/14)

Prozentsatz des **Gesamtbetrags der Einkünfte (GdE)**, je Band nur auf den in das Band fallenden
GdE-Anteil (nicht der Gesamtsatz auf den vollen GdE — das ist die stufenweise Ermittlung nach
BFH VI R 75/14 vom 19.01.2017, seither Verwaltungspraxis). Bandgrenzen **15.340 €** / **51.130 €**.

| Personenkreis | ≤ 15.340 € | 15.340 – 51.130 € | > 51.130 € |
|---|---|---|---|
| ohne Kinder, Grundtarif (§32a Abs. 1) | 5 % | 6 % | 7 % |
| ohne Kinder, Splitting (§32a Abs. 5/6) | 4 % | 5 % | 6 % |
| 1 – 2 Kinder | 2 % | 3 % | 4 % |
| ≥ 3 Kinder | 1 % | 1 % | 2 % |

Quellen: <https://www.gesetze-im-internet.de/estg/__33.html> (§33 Abs. 3 Wortlaut) ·
BFH VI R 75/14 (stufenweise) <https://www.bundesfinanzhof.de/en/entscheidungen/entscheidungen-online/decision-detail/STRE201710072/> ·
Spiegel: <https://www.haufe.de/steuern/finanzverwaltung/stufenweise-berechnung-der-zumutbaren-belastung-nach-33-estg_164_414052.html> · Abrufstand 2026-07-08.

Hinweis: Werbungskosten/Sonderausgaben/Vorsorge/agB mindern das **zvE** (Wirkung = Grenzsteuersatz);
**§35a** mindert die **tarifliche ESt** direkt (Wirkung 100 % bis zum Deckel, nicht erstattungsfähig,
kein Vortrag — verfallener Betrag ausweisen); Lohnsteuer/Soli/KiSt-Einbehalt sind **Vorauszahlungen**.
**Keine Vorsorgepauschale** in der Veranlagung (die gibt es nur im LSt-Abzug §39b).

---

## §2 Abs. 5 EStG — zu versteuerndes Einkommen (zvE) als *erfasster* Wert

Keine Konstante und keine Formel, sondern eine **Definition + eine Belegregel**: das zvE ist die
Bemessungsgrundlage der tariflichen ESt (§32a, oben) — Einkommen abzüglich Kinderfreibeträge und
sonstiger vom Einkommen abzuziehender Beträge. Einkommensabhängige Programme (Baufinanzierung,
Förderungen mit Einkommensgrenze) verlangen genau diese Zahl.

Quelle: <https://www.gesetze-im-internet.de/estg/__2.html> · Abrufstand 2026-08-13.

**Wo sie steht:** im **Einkommensteuerbescheid**, in der Zeile „zu versteuerndes Einkommen" der
Besteuerungsgrundlagen. Der Bescheid ist verbindlich.

**Umsetzung im Code** (`core/actions/zve.ts` + Store-Tabelle `tax_assessments`, Schema v13): der
Bescheidwert wird **erfasst, nicht hergeleitet** — mit Belegverweis auf das Bescheid-Dokument und
Erfassungsdatum. Die App-eigene Berechnung (`elster/est-berechnung.ts`) liefert für dasselbe Jahr ein
zvE, das aber **immer nur Schätzung** ist; jeder Rückgabewert trägt deshalb ein `herkunft`-Feld
(`bescheid` vs. `schaetzung`), und die Schätzung wird nur auf ausdrückliche Anforderung geliefert.
Ein Bescheidwert ohne Belegverweis wird als nicht nachprüfbar markiert.

**Nicht hier:** Mittelung mehrerer Jahre, Familien-Zuschläge und die Stufenlogik einzelner
Förderprogramme (z. B. eine Einkommensgrenze der BEG-Heizungsförderung) sind Förderrecht, kein
Steuerrecht — sie gehören in das konsumierende Projekt, nicht in diese Registry und nicht in den
Buchhaltungs-Kern.

---

## §18 UStG, §19 UStG, §§46–48 UStDV — USt-Voranmeldung: Zeitraum, Befreiung, Dauerfrist

Abrufstand aller Quellen dieses Abschnitts: **2026-10-10**. Gilt für die Besteuerungszeiträume
2025 und 2026; die Neugründer-Ausnahme läuft nach dem Gesetzestext mit 2026 aus (Zeile „Neugründer").

| Fall | Regel | Norm | Quelle |
|---|---|---|---|
| Regelfall | Voranmeldungszeitraum ist das **Kalendervierteljahr**; Abgabe und Zahlung bis zum **10. Tag** nach Ablauf des Zeitraums. | §18 Abs. 1 S. 1 und 4, Abs. 2 S. 1 UStG | [§18 UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html) |
| Monatszahler | Steuer des Vorjahres **> 9.000 €** → Kalendermonat. Ein Vorsteuer-Überschuss **> 9.000 €** im Vorjahr erlaubt den Monat auf Wahl (Voranmeldung Januar bis 10. Februar, bindet für das Jahr). | §18 Abs. 2 S. 2, Abs. 2a UStG | wie oben |
| Befreiung (Jahreszahler) | Steuer des Vorjahres **≤ 2.000 €** → das Finanzamt **kann** von Voranmeldungen und Vorauszahlungen befreien. Es entscheidet, nicht die Person; danach bleibt nur die USt-Jahreserklärung. App-Feld: `elster.ust_va_befreit`. | §18 Abs. 2 S. 3 UStG | wie oben; Spiegel: [Finanzamt NRW, USt-Voranmeldungen](https://www.finanzamt.nrw.de/steuerinfos/unternehmen/umsatzsteuer/umsatzsteuer-voranmeldungen) |
| Neugründer | Im Gründungsjahr und im Folgejahr grundsätzlich **monatlich**. Für **2021–2026** gilt stattdessen die voraussichtliche (Gründungsjahr) bzw. auf ein Jahr hochgerechnete (Folgejahr) Steuer mit den Grenzen oben — meist also vierteljährlich. Ab **2027** gilt nach dem Gesetzestext wieder die Monatspflicht, falls der Gesetzgeber nicht verlängert: vor jeder Einrichtung für 2027 neu prüfen. Vorratsgesellschaften und Firmenmäntel: immer monatlich. | §18 Abs. 2 S. 4–6 UStG | wie oben; Spiegel: [IHK Düsseldorf](https://www.ihk.de/duesseldorf/existenzgruendung/aktuelles/aussetzung-der-pflicht-zur-monatlichen-uebermittlung-voranmeldungen-in-neugruendungsfaellen-4996474) |
| Kleinunternehmer | Steuerfrei, wenn der Gesamtumsatz im Vorjahr **≤ 25.000 €** war und im laufenden Jahr **≤ 100.000 €** bleibt (VZ ab 2025; bis 2024: 22.000 € / 50.000 €). §18 Abs. 1–4 gilt nicht: **keine Voranmeldung**, und ab VZ **2024 keine USt-Jahreserklärung** mehr (außer auf Aufforderung, §149 Abs. 1 S. 2 AO). Ausnahme §18 Abs. 4a: Voranmeldung nur für Zeiträume, in denen er z. B. Steuer nach §13b schuldet. App-Feld: `invoicing.self.issuer.kleinunternehmer`. | §19 Abs. 1 UStG | [§19 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html); [BMF 18.03.2025, Sonderregelung für Kleinunternehmer](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-03-18-sonderregelung-kleinunternehmer.pdf?__blob=publicationFile&v=3); Spiegel: [IHK Köln](https://www.ihk.de/koeln/hauptnavigation/recht-steuern/steuern/kleinunternehmer-im-umsatzsterrecht-5695056) |
| Dauerfristverlängerung | Auf Antrag verlängert das Finanzamt Abgabe- und Zahlungsfrist um **einen Monat**. Antrag bis zur Frist der ersten betroffenen Voranmeldung, elektronisch. Monatszahler leisten eine **Sondervorauszahlung von 1/11** der Vorauszahlungen des Vorjahres (bis zur Frist der ersten Voranmeldung, jedes Jahr neu); sie wird mit der Dezember-Vorauszahlung verrechnet. App-Feld: `elster.ust_dauerfristverlaengerung`. | §§46, 47, 48 UStDV | [§46](https://www.gesetze-im-internet.de/ustdv_1980/__46.html) · [§47](https://www.gesetze-im-internet.de/ustdv_1980/__47.html) · [§48](https://www.gesetze-im-internet.de/ustdv_1980/__48.html) |

**Umsetzung im Code:** `core/actions/steuertermine.ts` (`toSteuerTerminEntity`) zeigt keine USt-VA-Termine
für Kleinunternehmer und befreite Jahreszahler und keine USt-Jahreserklärung für Kleinunternehmer. Das
Kennzeichen gilt für alle angezeigten Jahre; die Liste reicht höchstens zwei Jahre zurück, also nicht vor
VZ 2024. Wer vorher noch regelbesteuert war, prüft ältere Jahreserklärungen selbst.
Die Grenzen 9.000 € und 2.000 € rechnet die App nicht nach — welcher Zeitraum gilt, legt das Finanzamt fest,
und die Person trägt ihn ein (Einrichtung → Betrieb, Einstellungen → Umsatzsteuer). Die
Kleinunternehmer-Grenzen prüft `core/elster/hinweise.ts` (`kleinunternehmerGrenzen`).

---

## §14 UStG — E-Rechnung (Empfang, Ausstellung, Übergangsfristen)

Gilt für Umsätze nach dem 31.12.2024 (Wachstumschancengesetz, BGBl. 2024 I Nr. 108). Abrufstand aller
Quellen dieses Abschnitts: **2026-10-08**.

| Regel | Inhalt | Norm | Quelle |
|---|---|---|---|
| Begriff | **E-Rechnung** = in einem strukturierten elektronischen Format ausgestellt, übermittelt und empfangen, elektronisch verarbeitbar; Format nach EN 16931 oder vereinbart, wenn die Angaben verlustfrei in ein EN-16931-Format extrahierbar sind. Alles andere (Papier, PDF ohne Datensatz, Bild, Mailtext) ist eine **sonstige Rechnung**. | §14 Abs. 1 S. 3–6 UStG | [gesetze-im-internet §14](https://www.gesetze-im-internet.de/ustg_1980/__14.html) |
| Formate | XRechnung und ZUGFeRD **ab 2.0.1** erfüllen die Anforderungen — **außer den ZUGFeRD-Profilen MINIMUM und BASIC-WL**. | Verwaltungsauffassung | [BMF-FAQ E-Rechnung, Frage 7](https://www.bundesfinanzministerium.de/Content/DE/FAQ/e-rechnung.html) |
| Empfang | Seit **1.1.2025** muss jedes inländische Unternehmen E-Rechnungen empfangen können, **ohne Übergangsfrist und ohne Ausnahme — auch Kleinunternehmer**. Ein E-Mail-Postfach genügt. Eine E-Rechnung braucht keine Zustimmung des Empfängers; eine sonstige *elektronische* Rechnung (z. B. PDF) schon. | §14 Abs. 1 S. 5 UStG | BMF-FAQ, Fragen 8 und 12 |
| Ausstellungspflicht | Inländische B2B-Umsätze, Aussteller und Empfänger im Inland ansässig, nicht nach §4 Nr. 8–29 steuerfrei. | §14 Abs. 2 S. 2 Nr. 1 UStG | gesetze-im-internet §14 |
| Leistungszeitraum | Die Rechnung nennt „den Zeitpunkt der Lieferung oder sonstigen Leistung"; bei Rechnungen aus erfassten Zeiten setzt die App den Zeitraum **erster bis letzter übernommener Zeiteintrag** (lokaler Kalendertag) — ein Vorschlag, den die Person im Entwurf ändern kann. Abgerechnet gelten die Zeiten erst beim Festschreiben. | §14 Abs. 4 Nr. 6 UStG; abgerufen 2026-10-09 | [gesetze-im-internet §14](https://www.gesetze-im-internet.de/ustg_1980/__14.html) |
| Übergang | Umsätze **2025–2026**: sonstige Rechnung zulässig (Papier immer, PDF nur mit Zustimmung). Umsätze **2027**: nur noch, wenn der Gesamtumsatz des Ausstellers im **Vorjahr ≤ 800.000 €** war (oder EDI). **Ab 2028** keine Übergangsregel mehr. | §27 Abs. 38 UStG | [gesetze-im-internet §27](https://www.gesetze-im-internet.de/ustg_1980/__27.html) |
| Ausnahmen (Ausstellung) | Kleinbetragsrechnungen (Gesamtbetrag **≤ 250 €**), Fahrausweise und Rechnungen von **Kleinunternehmern** dürfen immer sonstige Rechnungen sein. | §33, §34, §34a S. 2 UStDV | [§33](https://www.gesetze-im-internet.de/ustdv_1980/__33.html) · [§34a](https://www.gesetze-im-internet.de/ustdv_1980/__34a.html) |
| Hybride Formate | Bei PDF + XML (ZUGFeRD) ist der **strukturierte Teil maßgeblich**; weicht das PDF ab, zählt das XML. | BMF 15.10.2025 (UStAE-Änderung) | [BMF-Schreiben 15.10.2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-10-15-einfuehrung-obligatorische-e-rechnung.html); Spiegel: [Baker Tilly](https://www.bakertilly.de/beitrag/e-rechnung-zweites-bmf-schreiben-sorgt-fuer-mehr-klarheit), [Ecovis](https://de.ecovis.com/unternehmensberatung/e-rechnung-bmf-klarstellungen-2025) |
| Fehler und Vorsteuer | Formatfehler → keine E-Rechnung, sondern sonstige Rechnung; besteht E-Rechnungspflicht und endet die Übergangszeit, ist der Vorsteuerabzug gefährdet. Validieren wird empfohlen, ersetzt aber nicht die inhaltliche Prüfung. | BMF 15.10.2025 | wie oben; Spiegel: [FGS](https://www.fgs.de/news-and-insights/blog/detail/e-rechnung-zweites-bmf-schreiben-veroeffentlicht) |
| Aufbewahrung | Der strukturierte Teil (XML) genügt umsatzsteuerlich, wenn er unverändert bleibt. | §14b UStG, BMF 15.10.2025 | Spiegel: FGS |

Grundlagenschreiben: BMF 15.10.2024, III C 2 – S 7287-a/23/10001 :007, BStBl I S. 1320
(Übergangsregeln Rn. 62–65). Zeilen mit „BMF 15.10.2025" stützen sich auf Fachbeiträge, die das
Schreiben zusammenfassen; vor einer Verwendung im Code die Randnummer im PDF selbst nachschlagen.

### Leitfaden-IDs (Guideline-URN) — woran der Leser E-Rechnung und sonstige Rechnung trennt

Die Einstufung hängt an der Leitfaden-ID des Datensatzes (CII: `GuidelineSpecifiedDocumentContextParameter/ID`,
UBL: `CustomizationID`). Abrufstand: **2026-10-08**. Quelle der URN-Zeichenketten: die Profil-Tabelle der
quelloffenen Bibliothek [ZUGFeRD-csharp, `Profile.cs`](https://github.com/stephanstapel/ZUGFeRD-csharp/blob/master/ZUGFeRD/Profile.cs)
(Spiegel, Apache-2.0); die Primärquelle ist die FeRD-/FNFE-Spezifikation (ZUGFeRD 2.x = Factur-X 1.0.x) und der
XRechnung-Standard der KoSIT — vor einer Änderung der Tabelle dort gegenlesen.

| Leitfaden-ID | Profil | Einstufung (Code: `core/invoices/e-rechnung/classify.ts`) |
|---|---|---|
| `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0` | XRechnung 3.0 (CII und UBL) | E-Rechnung |
| `urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.0` … `_2.3`, `_1.2` | frühere XRechnung-Versionen | E-Rechnung (Code: jede ID mit „xrechnung“) |
| `urn:cen.eu:en16931:2017` | EN 16931 (ZUGFeRD „COMFORT“) | E-Rechnung |
| `urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic` | BASIC (ZUGFeRD 2.1–2.3, Factur-X) | E-Rechnung |
| `urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended` | EXTENDED | E-Rechnung |
| `urn:factur-x.eu:1p0:minimum` | MINIMUM | **sonstige Rechnung** (BMF-FAQ, Frage 7) |
| `urn:factur-x.eu:1p0:basicwl` | BASIC-WL | **sonstige Rechnung** (BMF-FAQ, Frage 7) |
| `urn:zugferd.de:2p0:minimum`, `urn:zugferd.de:2p0:basicwl` | MINIMUM / BASIC-WL in ZUGFeRD 2.0.x | **sonstige Rechnung** |
| `urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic`, `…#conformant#urn:zugferd.de:2p0:extended` | BASIC / EXTENDED in ZUGFeRD 2.0.x | E-Rechnung — mit Hinweis: die URN `2p0` gilt für 2.0.0 **und** 2.0.1, die Verwaltung verlangt „ab 2.0.1“; die Version steht nicht im XML |
| `urn:ferd:CrossIndustryDocument:invoice:1p0:basic` · `…:comfort` · `…:extended` (Wurzelelement `CrossIndustryDocument`) | ZUGFeRD 1.x | **sonstige Rechnung** („ab 2.0.1“) |
| jede andere ID mit Präfix `urn:cen.eu:en16931:2017` | EN-16931-konformes Format (z. B. eine CIUS) | E-Rechnung (§14 Abs. 1: „Format nach EN 16931“) |
| keine oder unbekannte ID | — | **sonstige Rechnung** — vorsichtige Entscheidung der App, kein Rechtssatz; die Begründungszeile sagt, dass von Hand zu prüfen ist |

Ein PDF ohne eingebetteten Datensatz, ein Bild oder Scan und ein unlesbarer Datensatz (Formatfehler) sind
sonstige Rechnungen (Zeilen „Begriff“ und „Fehler und Vorsteuer“ oben).

**Umsetzung im Code:** `core/invoices/cii-xml.ts` erzeugt XRechnung 3.0 (CII) für eigene Rechnungen.
Der Leser für eingehende E-Rechnungen ist `core/invoices/e-rechnung/` (CII und UBL, Anhang eines hybriden
PDFs, Einstufung nach obiger Tabelle); CLI `invoices e-rechnung lesen <datei>`, MCP-Werkzeug
`invoices_e_rechnung_lesen`. Nicht geprüft wird gegen die KoSIT-Regeln (siehe `docs/ideen-nutzerfuehrung.md`, Idee 2).

---

## Frei verfügbar + Steuerrücklage — App-Rechnung, keine Rechtsgröße

Code: `app/src/core/elster/frei-verfuegbar.ts`. Abrufstand: **2026-10-08**. Die Formel ist eine Rechnung der
App, keine steuerliche Größe; sie verwendet nur Fristen, die an anderer Stelle schon belegt sind.

| Annahme | Wert | Art | Grundlage |
|---|---|---|---|
| Fälligkeits-Fenster `FAELLIG_FENSTER_TAGE` | **30 Tage** | **App-Wahl, keine Rechtsnorm** | Eine eingereichte, unbezahlte Steuer zählt als „fällig", wenn sie überfällig ist, kein Datum hat (Fälligkeit laut Bescheid) oder binnen 30 Tagen fällig wird. Später fällige Beträge stehen in der Herleitung, ohne abgezogen zu werden. |
| Fälligkeit der Steuerzahlungen | USt-VA: Regelfrist der Voranmeldung · USt-Jahr: 1 Monat nach Eingang · GewSt/ESt: laut Bescheid | Gesetz | §18 Abs. 1 S. 4 und Abs. 4 UStG, §220 AO, §108 Abs. 3 AO — wie in `elster/steuerzahlungen.ts`, siehe [§18 UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html) |
| Beginn „USt seit der letzten Voranmeldung" | Tag nach dem Ende des letzten im Register eingereichten USt-VA-Zeitraums; ohne Register-Eintrag der erste Zeitraum, dessen Abgabefrist (10. des Folgemonats, mit Dauerfristverlängerung +1 Monat) noch läuft | App-Regel auf Gesetzesfrist | §18 Abs. 1 UStG, §46–48 UStDV ([§46](https://www.gesetze-im-internet.de/ustdv_1980/__46.html)) |
| USt im Zeitraum | vereinnahmte USt − gezahlte Vorsteuer aus den Buchungen der EÜR (Zahlungsdatum) | Ist-Versteuerung exakt, Soll-Versteuerung nur Näherung (die App sagt es) | §13 Abs. 1 Nr. 1 a/b UStG ([§13](https://www.gesetze-im-internet.de/ustg_1980/__13.html)) |
| Laufende Kosten (zweite Fassung, Idee 8) | bestätigte Serien, erwartete Zahlungen nach der letzten bis Stichtag + 30 Tage | **App-Rechnung, keine Rechtsnorm** | Schwellen der Erkennung im Abschnitt „Geld-Prüfungen" unten (Abruf 2026-10-09). Die Herleitung nennt den Betrag ohne sie (erste Fassung). |
| Steuerrücklage | ESt-Schätzung (`est-berechnung.ts`) − Lohnsteuer/Soli/KiSt einbehalten − ESt-Vorauszahlungen (Config) + GewSt-Schätzung (`gewst.ts`) − im Jahr gebuchte GewSt-Zahlungen | Schätzung, dieselbe wie die Steuer-Prognose | Tarif und Messzahl: Abschnitte oben bzw. §11 GewStG; Vorauszahlungen §37 EStG, §19 GewStG |

---

## Geld-Prüfungen (Idee 7) — App-Schwellen und „Lieferant doppelt bezahlt"

Code: `app/src/core/elster/{serie,iban-wechsel,doppelte-rechnung,lieferant-doppelt-bezahlt,laufende-kosten,erstattung}.ts`.
Abrufstand: **2026-10-08**; laufende Kosten (Idee 8) und Erstattungen (Idee 9) **2026-10-09**. Die Prüfungen sind Hinweise; sie ändern keine Zahl der EÜR.

| Annahme | Wert | Art | Grundlage |
|---|---|---|---|
| `DOPPELTE_RECHNUNG_FENSTER_TAGE` | **30 Tage** | **App-Wahl, keine Rechtsnorm** | Zwei Rechnungen eines Absenders über denselben Betrag binnen 30 Tagen gelten als vermutlich dieselbe Forderung. |
| `SERIE_MIN_TREFFER` / `SERIE_TOLERANZ_TAGE` | **3** Treffer, **± 5 Tage** | **App-Wahl, keine Rechtsnorm** | Ab drei gleichen Beträgen im Monats-, Quartals-, Halbjahres- oder Jahresabstand: vermutlich ein Abo, keine Doppelung. |
| `LAUFENDE_KOSTEN_MIN_TREFFER` (Idee 8, `laufende-kosten.ts`) | monatlich/vierteljährlich **3**, halbjährlich/jährlich **2** | **App-Wahl, keine Rechtsnorm** | Ab so vielen Abbuchungen wird eine Serie als laufende Kosten **vorgeschlagen**. Jährlich reichen zwei (ein beobachteter Abstand): drei hießen zwei volle Jahre Vorlauf, eine Versicherung käme erst im dritten Jahr. Ein Vorschlag ändert nichts, bis er bestätigt ist. |
| `LAUFENDE_KOSTEN_DRIFT_ANTEIL` | **25 %** je Zahlung | **App-Wahl, keine Rechtsnorm** | So weit darf sich der Betrag von einer Zahlung zur nächsten ändern (Preisänderung) und die Serie bleibt dieselbe; darüber beginnt eine eigene. |
| `LAUFENDE_KOSTEN_STOP_FAKTOR` | **1,5** Abstände | **App-Wahl, keine Rechtsnorm** | Liegt die neueste Buchung der Entität mehr als 1,5 Abstände nach der letzten Zahlung, gilt die Serie als „beendet?" und wird in Frei verfügbar nicht abgezogen. Gemessen am Datenstand, nicht am heutigen Tag. |
| Fenster der laufenden Kosten in Frei verfügbar | **30 Tage** (`FAELLIG_FENSTER_TAGE`) | **App-Wahl, keine Rechtsnorm** | Abgezogen werden die nach der letzten Zahlung erwarteten Zahlungen bestätigter Serien bis 30 Tage nach dem Stichtag — dasselbe Fenster wie bei den fälligen Steuerzahlungen. |
| `ERSTATTUNG_FENSTER_TAGE` (Idee 9, `erstattung.ts`) | **365 Tage** | **App-Wahl, keine Rechtsnorm** | So weit zurück sucht ein Zahlungseingang seine Ursprungsbuchung. Ein Jahr deckt eine zurückerstattete Jahresgebühr ab; ältere Erstattungen ordnet man über „Umbuchen" zu. |
| Vorsteuer je Rechnung nur einmal | — | Gesetz | § 15 Abs. 1 Satz 1 Nr. 1 UStG: abziehbar ist die gesetzlich geschuldete Steuer für die **Leistung**, Voraussetzung ist die **Rechnung** — nicht die Zahlung. Eine zweite Zahlung auf dieselbe Rechnung begründet keinen zweiten Abzug. [§ 15 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html) |

**Zweite Abbuchung an den Lieferanten in der EÜR — nicht abschließend geklärt, darum keine Neutralisierung.**
Geprüft (Abruf 2026-10-08/09):

- [§ 4 Abs. 3 und 4 EStG](https://www.gesetze-im-internet.de/estg/__4.html): Betriebsausgaben sind Aufwendungen, die durch
  den Betrieb veranlasst sind. [§ 11 Abs. 2 Satz 1 EStG](https://www.gesetze-im-internet.de/estg/__11.html): Ausgaben sind in
  dem Jahr abzusetzen, in dem sie geleistet worden sind (Abflussprinzip).
- Die Kundenseite (Idee 5, „Doppelzahlung") ist die Gegenrichtung: zurückgezahlte Über- oder Doppelzahlungen mindern beim
  Empfänger die Bemessungsgrundlage (§ 17 UStG) — Haufe, „Umsatzsteuer bei Doppelzahlung einer Rechnung",
  <https://www.haufe.de/id/kommentar/umsatzsteuer-bei-doppelzahlung-einer-rechnung-HI1918985.html>.
- Für den **Zahlenden** in der EÜR fand sich weder im Gesetz noch in EStH/BMF eine ausdrückliche Regel. Vertretbar sind
  zwei Lesarten: (a) die irrtümliche Zahlung ist betrieblich veranlasst, also Betriebsausgabe im Abflussjahr, die Erstattung
  später Betriebseinnahme; (b) sie begründet nur einen Rückforderungsanspruch und ist als Geldverkehr erfolgsneutral.
  Nach beiden Lesarten ist die **Vorsteuer** nur einmal abziehbar (Zeile oben).

Die App bietet deshalb nur „Rechnung öffnen" und „Als in Ordnung markieren" an, rechnet die zweite Abbuchung **nicht**
heraus und weist auf die einmalige Vorsteuer hin. Vor einer Neutralisierung wie in Idee 5 braucht es eine zitierbare
Quelle (BFH-Urteil, EStH-Hinweis oder BMF-Schreiben).

---

## Erstattungen (Idee 9) — Ausgabe und Vorsteuer mindern im Jahr und Zeitraum des Eingangs

Code: `app/src/core/elster/erstattung.ts` (Vorschlag), `EuerErstattung` in `euer-transactions.ts` (EÜR),
`VorsteuerKorrektur` in `ustva-aggregate.ts` (USt-VA). Abrufstand: **2026-10-09**, gilt ab VZ 2025 unverändert.

| Annahme | Regel der App | Art | Grundlage |
|---|---|---|---|
| Zeitpunkt in der EÜR | im **Jahr des Eingangs**, nie rückwirkend im Jahr der Ursprungsbuchung | Gesetz | [§ 4 Abs. 3 EStG](https://www.gesetze-im-internet.de/estg/__4.html), [§ 11 Abs. 1 Satz 1 EStG](https://www.gesetze-im-internet.de/estg/__11.html) (Zuflussprinzip); die EÜR ist eine reine Geldrechnung, eine Rückabwicklung wirkt erst bei Zahlung — BFH, Urteil vom 12.11.2014, X R 39/13 (Rz. 11, 18), [bundesfinanzhof.de](https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE201550020/); BFH vom 29.04.1982, IV R 95/79, BStBl II 1982, 593 (Gegenrichtung: Rückzahlung mindert erst im Abflussjahr) |
| Darstellung | **Minderung der Ausgabe** in der Kategorie der Ursprungsbuchung (netto), statt eigener Einnahme | App-Wahl zwischen zwei gewinngleichen Lesarten | Der Gewinn ist bei beiden gleich. Für eine Einnahme spricht die Verwaltung (AEAO zu § 64 Nr. 19 zählt „erstattete Betriebsausgaben" ausdrücklich nicht zu den leistungsbezogenen Einnahmen — sie sind dort also Einnahmen); für die Minderung die Anleitung zur Anlage EÜR, nach der Betriebsausgaben netto und Vorsteuer gesondert (Zeile 57) anzusetzen sind — eine Gutschrift auf die Rechnung ist eine Minderung desselben Aufwands. Gewählt ist die Minderung, weil sie zur USt-Seite passt (unten) und die Kategorie richtig bleibt. Siehe „Offen" unten. |
| Vorsteuer | der im Erstattungsbetrag steckende Anteil mindert die **Vorsteuer** (nicht: zusätzliche Umsatzsteuer) im **Voranmeldungszeitraum des Eingangs** | Gesetz | [§ 17 Abs. 1 Satz 2 und Satz 8 UStG](https://www.gesetze-im-internet.de/ustg_1980/__17.html): Ändert sich die Bemessungsgrundlage, ist der Vorsteuerabzug beim Leistungsempfänger zu berichtigen, und zwar für den Besteuerungszeitraum, in dem die Änderung eingetreten ist. Bei Rückgabe: § 17 Abs. 2 Nr. 3 UStG. |
| Steuersatz der Erstattung | der Satz der Ursprungsbuchung (USt ÷ Netto, auf 7/19 % gerundet, sonst exakt), beim „Ja" eingefroren | App-Regel auf Gesetz | Die Berichtigung folgt dem ursprünglichen Abzug (§ 17 Abs. 1 Satz 2 UStG). Eingefroren, damit eine Erstattung in einem späteren Jahr ein bereits abgegebenes Jahr nicht neu ableiten muss. |
| Jahresübergreifend (Ursprung 2025, Erstattung 2026) | Minderung 2026 in der Kategorie und Vorsteuer 2026; **2025 bleibt unverändert** | Gesetz | Abschnittsbesteuerung (§ 2 Abs. 7 EStG) und § 11 EStG; § 17 Abs. 1 Satz 8 UStG — die Vorsteuer 2025 war richtig, die Änderung tritt 2026 ein. Konservativ: kein Eingriff in ein abgeschlossenes Jahr. |
| USt-VA aus Belegen (Paperless) | Abzug nur, wenn die Ursprungsbuchung ihre Vorsteuer aus einem **Beleg** hatte | App-Regel | Die belegbasierte USt-VA hat für eine Buchung ohne Beleg nie Vorsteuer angesetzt; dort darf auch keine zurückgenommen werden. Die EÜR (und daraus die USt-Jahreserklärung) rechnet die Erstattung immer. |
| Mehrere Erstattungen zu einer Zahlung | Summe ≤ Betrag der Ursprungsbuchung | App-Regel | Mehr als bezahlt kann nicht erstattet werden; ein Rest darüber wäre keine Erstattung. |

| Kategorie im Folgejahr negativ (Anlage EÜR) | Zeile bleibt negativ, wo das Schema ein Vorzeichen zulässt; **GWG** (E6002301) rückt ihren negativen Rest nach „übrige" (E6004901); **Bewirtung nicht abziehbar** (E6004101) zeigt 0 | ERiC-Schema + App-Regel | ERiC 43.4.6.0, Schemadokumentation E77-2024/E77-2025: E6004901, E6004102, E6005001, E6001701, E6003201 sind `DezimalzahlOhneFuehrNull` (mit Vorzeichen), E6002301, E6001901, E6005101, E6004101 sind `DezimalzahlNichtNegOhneFuehrNull`. Gegengeprüft am 2026-10-09 mit ERiC `EUER_2025`: negative übrige BA, negative abziehbare Bewirtung und negative Vorsteuer bestehen, eine negative E6004101 scheitert (Zeile 63). Die nicht abziehbare Bewirtung hat den Gewinn nie gemindert, ihre Erstattung ändert ihn auch nicht — darum 0. Der Gewinn bleibt in jedem Fall gleich (`euerLinesFromAggregate`). |
| USt-VA aus den Buchungen (integriertes DMS) | Entität mit `dms.type: "builtin"`: Umsätze nach Satz und Vorsteuer aus den EÜR-Zeilen des Zeitraums, nach Zahlungsdatum; verknüpfte Erstattungen und Splitteile wie in der EÜR | App-Regel auf Gesetz | Ist-Versteuerung: [§ 20 UStG](https://www.gesetze-im-internet.de/ustg_1980/__20.html), Voranmeldungszeitraum [§ 18 Abs. 1 und 2 UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html); Berichtigung bei Erstattung wie oben (§ 17 UStG). Die Quartale ergeben in Summe die vereinnahmte USt und die Vorsteuer der USt-Jahreserklärung. § 13b und steuerfreie Umsätze rechnet dieser Weg nicht (`ustva-buchungen.ts`). |

**Entschieden (2026-10-09):** Es bleibt bei der Minderung der Ausgabe. Keine Primärquelle legt eine Einnahme fest, und
ERiC nimmt die negativen Zeilen, die dabei entstehen können — bis auf die drei Zeilen mit `NichtNeg`-Typ, die die
Tabelle oben behandelt. Wer die Lesart „Einnahme" will, bucht die Erstattung per „Umbuchen" als Betriebseinnahme.

---

## Splitbuchung (Idee 13) — Teile mit eigener Kategorie, Privatanteil, Bewirtung

Code: `app/src/core/elster/splitbuchung.ts` (Teile, Rest, Vorlage Bewirtung, Abgabe-Schutz), `aufteilungen` in
`euer-transactions.ts` (EÜR), `VorsteuerKorrektur` mit `art: 'aufteilung'` in `ustva-aggregate.ts` (USt-VA),
`NEUTRAL_MIT_VORSTEUER` in `euer-aggregate.ts`. Abrufstand: **2026-10-09**, gilt ab VZ 2025 unverändert.

| Annahme | Regel der App | Art | Grundlage |
|---|---|---|---|
| Jeder Teil zählt für sich | Netto und USt je Teil aus seinem Bruttobetrag und Steuersatz; der Teil geht in die EÜR-Kategorie, die er trägt | App-Regel auf Gesetz | Betriebsausgaben sind die betrieblich veranlassten Aufwendungen ([§ 4 Abs. 4 EStG](https://www.gesetze-im-internet.de/estg/__4.html)); eine gemischte Rechnung wird nach Posten aufgeteilt. |
| Privater Teil (`1800 Privatentnahme`) | **keine Betriebsausgabe**, neutral als Entnahme (Anlage EÜR Zeile Entnahmen); **keine Vorsteuer** | Gesetz | Entnahme: [§ 4 Abs. 1 Satz 2 EStG](https://www.gesetze-im-internet.de/estg/__4.html); Kosten der Lebensführung: [§ 12 Nr. 1 EStG](https://www.gesetze-im-internet.de/estg/__12.html). Vorsteuer nur für Leistungen „für sein Unternehmen": [§ 15 Abs. 1 Satz 1 Nr. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html); ein Gegenstand, der zu weniger als 10 % unternehmerisch genutzt wird, gilt nicht als für das Unternehmen bezogen (§ 15 Abs. 1 Satz 2 UStG). |
| Privater Teil in der belegbasierten USt-VA | die USt des privaten Teils (Steuersatz des Teils) wird von der Vorsteuer **abgezogen**, im Zeitraum des Belegs, der die Buchung nennt; ohne Beleg nichts | App-Regel | Die USt-VA zählt die Vorsteuer aus Eingangsbelegen voll; den privaten Anteil darf sie nicht abziehen (§ 15 Abs. 1 UStG). Ohne Beleg hat sie nie Vorsteuer angesetzt. |
| Bewirtung, Vorlage 70/30 | **70 %** in `4654 Bewirtungskosten` (abziehbar), **30 %** (der Rest) in `4654 Nicht abziehbare Bewirtungskosten`: neutral, mindert den Gewinn nicht | Gesetz | [§ 4 Abs. 5 Satz 1 Nr. 2 EStG](https://www.gesetze-im-internet.de/estg/__4.html): Bewirtung aus geschäftlichem Anlass mindert den Gewinn nicht, „soweit sie 70 Prozent der Aufwendungen übersteigen", die angemessen und nachgewiesen sind (Ort, Tag, Teilnehmer, Anlass, Höhe; in der Gaststätte Anlass, Teilnehmer und Rechnung). Getrennt aufzuzeichnen: § 4 Abs. 7 EStG. Die Vorlage prüft Angemessenheit und Nachweis nicht. |
| Vorsteuer der Bewirtung | **voll** abziehbar, auch auf die nicht abziehbaren 30 % (`NEUTRAL_MIT_VORSTEUER`) | Gesetz | [§ 15 Abs. 1a UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html): nicht abziehbar ist Vorsteuer auf Aufwendungen nach § 4 Abs. 5 Satz 1 Nr. 1–4, 7 EStG — „Dies gilt nicht für Bewirtungsaufwendungen, soweit § 4 Abs. 5 Satz 1 Nr. 2 des Einkommensteuergesetzes einen Abzug angemessener und nachgewiesener Aufwendungen ausschließt." Unangemessene oder nicht nachgewiesene Bewirtung fällt nicht darunter — dann nicht die Vorlage nehmen. |
| Steuersätze eines Teils | 0, 7 oder 19 % | Gesetz | [§ 12 Abs. 1 und 2 UStG](https://www.gesetze-im-internet.de/ustg_1980/__12.html). Ohne Angabe: der Satz des Belegs, sonst der der Kategorie. |
| Rundung | Teile in Cent; **ein Teil nimmt den Rest**, die Summe ist exakt der Buchungsbetrag | App-Regel | — |
| Verhältnis zum pauschalen Privatanteil (`adjustments.privatanteile`) | zwei Wege für dieselbe Frage: der pauschale Privatanteil setzt eine unentgeltliche Wertabgabe als Einnahme an (Bruttomethode, mit USt), die Aufteilung nimmt den privaten Teil einer einzelnen Buchung gar nicht erst als Ausgabe | App-Regel auf Gesetz | Wertabgabe: [§ 3 Abs. 9a UStG](https://www.gesetze-im-internet.de/ustg_1980/__3.html), Entnahme § 4 Abs. 1 Satz 2 EStG. Für **dieselben Kosten** nur einen Weg nehmen — sonst ist der private Teil doppelt erfasst. Die App warnt beim Aufteilen mit privatem Teil, wenn für die Firma ein pauschaler Privatanteil eingetragen ist; welche Kosten er abdeckt, weiß sie nicht. |
| Schon eingereichter Zeitraum | Aufteilen oder Aufheben in einem Monat/Quartal mit eingereichter Voranmeldung oder einem Jahr mit eingereichter EÜR, USt-Jahreserklärung, Feststellung oder GewSt-Erklärung (Register mit Abgabedatum) nur nach **ausdrücklicher Bestätigung**; die Werte im Register bleiben unverändert | App-Regel auf Gesetz | Erkennt der Steuerpflichtige nachträglich, dass eine abgegebene Erklärung unrichtig ist, muss er sie berichtigen: [§ 153 Abs. 1 AO](https://www.gesetze-im-internet.de/ao_1977/__153.html). Die Voranmeldung ist eine Steueranmeldung unter Vorbehalt der Nachprüfung ([§ 168 Satz 1 AO](https://www.gesetze-im-internet.de/ao_1977/__168.html)) und wird als berichtigte Anmeldung neu übermittelt. |
| Erstattung zu einer aufgeteilten Zahlung | erbt Kategorie und Satz des **größten betrieblichen Teils**, höchstens dessen Betrag; ein ganz privater Teil bekommt keine Erstattung zugeordnet | App-Regel | Wie „Erstattungen" oben (§ 17 Abs. 1 UStG folgt dem ursprünglichen Abzug); eine Rücksendung privater Posten ist keine betriebliche Sache. Eine schon verknüpfte Erstattung lässt sich erst nach „Verknüpfung lösen" aufteilen. |

### Bewirtung in der Anlage EÜR — Zeile 63, Kz 165 / Kz 175 (VZ 2024 und 2025)

Code: `EXPENSE_LINE` und `euerLinesFromAggregate` in `app/src/core/elster/euer-xml.ts`, `SKR03_TO_EUER` in
`euer-aggregate.ts`. Abrufstand: **2026-10-09**.

| Annahme | Regel der App | Art | Grundlage |
|---|---|---|---|
| Zeile | Bewirtung in Zeile 63 „Bewirtungsaufwendungen" der beschränkt abziehbaren Betriebsausgaben, nicht in „übrige" (Zeile 60) | Vordruck | Anlage EÜR 2025, Zeilen 62–67 mit den Spalten „nicht abziehbar" / „abziehbar": [BMF-Schreiben vom 29.08.2025, Anlage EÜR 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.pdf?__blob=publicationFile&v=3); Anleitung: „Die in den Zeilen 62 bis 67 genannten Betriebsausgaben sind auch dann dort einzutragen, wenn diese letztlich vollständig abziehbar oder vollständig nicht abziehbar sind" ([ELSTER, Anleitung zur EÜR 2025](https://www.elster.de/eportal/helpGlobal?themaGlobal=help_euer_ufa_77_2025)). Vordruck 2024 gleich (ERiC 43.4.6.0, `Vordrucke_archive/…/2024/…/EUER_E77_2024_Delta…pdf`, Zeile 63). |
| Kennzahlen | **Kz 165** = nicht abziehbar (30 %, `4654 Nicht abziehbare Bewirtungskosten`, XML `BAus/Beschr_abziehbar/Nicht_abziehbar/Bewirtung/Sum/E6004101`); **Kz 175** = abziehbar (70 %, `4654 Bewirtungskosten`, XML `…/Abziehbar/Bewirtung/Sum/E6004102`) | Vordruck + ERiC-Schema | Vordruck 2025 und 2024, Zeile 63: „Bewirtungsaufwendungen 165 … 175"; Schemadokumentation E77-2024/E77-2025 (ERiC 43.4.6.0): E6004101 / E6004102 „Bewirtungsaufwendungen" unter `Beschr_abziehbar`, das im `BAus` zwischen `Sonst_unbeschraenkt` und `KFZ_u_Fahrtkosten` steht. |
| Summe Betriebsausgaben | nur die Spalte **abziehbar** geht in Zeile 75 (E6005301); die Spalte nicht abziehbar steht nur da | Vordruck | Anleitung zur EÜR 2025, Zeile 63: Bewirtung „zu 70 % abziehbar und zu 30 % nicht abziehbar"; § 4 Abs. 5 Satz 1 Nr. 2 EStG (oben). ERiC `EUER_2025` prüft die Summe: die Demodaten mit einer 70/30-Bewirtung bestehen (`app/dev/eric-demo-check.sh`, 2026-10-09). |
| Vorsteuer der Bewirtung | voll in Zeile 57 (E6005001), auch auf die 30 % | Gesetz | Anleitung zur EÜR 2025, Zeile 63: „Die hierauf entfallende Vorsteuer ist allerdings abziehbar … und insoweit in Zeile 57 zu erfassen"; § 15 Abs. 1a Satz 2 UStG (oben). |
| Bewirtung ohne Aufteilung | eine Buchung, die ganz als `4654 Bewirtungskosten` gebucht ist, steht ganz in Kz 175 | App-Regel | Die App teilt nicht von selbst (Vorlage „Bewirtung 70/30" ist eine Handlung); ERiC beanstandet eine Kz 175 ohne Kz 165 nicht (geprüft 2026-10-09). |

---

## Prüfungen vor der Abgabe (Idee 10) — GWG-Grenze, § 13b, App-Schwellen

Code: `app/src/core/elster/{ust-abweichung,ust-ohne-angabe,reverse-charge-kandidat,anlagegut-kandidat,vor-abgabe}.ts`.
Abrufstand: **2026-10-09**. Die Prüfungen sind Hinweise; sie ändern keine Zahl der EÜR oder Voranmeldung.

| Annahme | Wert | Art | Grundlage |
|---|---|---|---|
| GWG-Grenze (`abschreibungsGrenzen`) | **800 €** je Wirtschaftsgut, **genau 800 € ist noch GWG** („nicht übersteigen"); Wirtschaftsjahre **ab 2018** | Gesetz | [§ 6 Abs. 2 Satz 1 EStG](https://www.gesetze-im-internet.de/estg/__6.html): abnutzbare bewegliche, selbständig nutzbare Wirtschaftsgüter, AHK „vermindert um einen darin enthaltenen Vorsteuerbetrag (§ 9b Absatz 1)" bis 800 € sofort abziehbar. Für Jahre vor 2018 ist kein Wert hinterlegt — die Prüfung sagt dann „nicht prüfbar". |
| Sammelposten | **über 250 € bis 1.000 €**, ein Fünftel je Jahr, für alle Güter des Wirtschaftsjahres einheitlich | Gesetz | [§ 6 Abs. 2a EStG](https://www.gesetze-im-internet.de/estg/__6.html) Satz 1–2 und 5. Der Hinweis nennt die Möglichkeit nur (bis 1.000 €), er rechnet nichts. |
| Netto oder brutto | netto bei Vorsteuerabzug, **brutto ohne** (Kleinunternehmer) | Gesetz | [§ 9b Abs. 1 EStG](https://www.gesetze-im-internet.de/estg/__9b.html): Vorsteuer gehört nur zu den AHK, soweit sie nicht abziehbar ist. |
| Raten an denselben Händler | eine Serie (`serie.ts`: gleiche Gegenseite, gleicher Betrag, fester Abstand, ab 3 Treffern) = **ein** Gut mit der Summe | App-Regel | Bei Ratenkauf sind die AHK der Kaufpreis, nicht die einzelne Rate. Bestätigte laufende Kosten (Idee 8) sind Abos und zählen nicht. |
| `ANLAGE_KATEGORIEN` | 0420 Büroeinrichtung/GWG, 4930 Bürobedarf, 4650 Sonstige, unklassifiziert | **App-Wahl, keine Rechtsnorm** | Nur dort landen Anschaffungen; Miete, Werbung, Software-Abos über 800 € sind kein Anlagegut. |
| `ANLAGE_ABGLEICH_ANTEIL` / `ANLAGE_ABGLEICH_TAGE` | **1 %** (mind. 1 €) / **90 Tage** | **App-Wahl, keine Rechtsnorm** | Ein Eintrag im Anlageverzeichnis gilt als diese Ausgabe, wenn er ihre Buchung nennt (`buchung_ids`) oder AHK und Anschaffungsdatum so nah liegen. |
| § 13b — wer schuldet | der Leistungsempfänger, wenn er **Unternehmer** ist | Gesetz | [§ 13b Abs. 5 Satz 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__13b.html); Abs. 1: sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 3a Abs. 2); Abs. 2 Nr. 1: Werklieferungen und andere sonstige Leistungen eines im Ausland ansässigen Unternehmers (Abs. 7: weder Wohnsitz noch Sitz im Inland). |
| § 13b beim **Kleinunternehmer** | **wird geprüft** — er schuldet die Steuer auch, ohne Vorsteuerabzug; Voranmeldung nur für die betroffenen Zeiträume | Gesetz | § 13b Abs. 5 UStG (Unternehmer); [§ 19 Abs. 1 Satz 2 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html) („§ 18 Absatz 4a … bleibt unberührt"); [§ 18 Abs. 4a UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html); kein Abzug, weil seine Umsätze steuerfrei sind: [§ 15 Abs. 2 Satz 1 Nr. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html), so auch BMF-Schreiben vom 18.03.2025 zur Kleinunternehmerregelung (UStAE 15.13). Spiegel: IHK Hannover, „Kleinunternehmer im Umsatzsteuerrecht" (<https://www.ihk.de/hannover/hauptnavigation/recht/steuerrecht/umsatzsteuer/kleinunternehmer-im-ust-5213920>). |
| Signale „ausländischer Lieferant" | Gegenkonto-IBAN nicht DE · USt-IdNr. am Beleg nicht DE · Kontakt mit Land/USt-IdNr. nicht DE · andere Buchung derselben Gegenseite als § 13b eingeordnet | **App-Wahl, keine Rechtsnorm** | Maßgeblich ist der Sitz des Leistenden (§ 13b Abs. 7 UStG); die App sieht ihn nur über diese Spuren. Ausgenommen: Belege mit USt (im Inland registrierter Lieferant), USt-freie Kategorien, Beleg mit Lieferantenland DE. |
| Buchungen ohne USt-Angabe | Ausgabe mit Beleg, der weder USt-Betrag noch Netto + Brutto nennt → Vorsteuer aus Belegen ist eine **Untergrenze** | App-Regel auf Gesetz | Vorsteuer nur aus einer Rechnung mit gesondert ausgewiesener Steuer, [§ 15 Abs. 1 Satz 1 Nr. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html). Ein Beleg mit 0 € USt ist eine Angabe, keine Lücke. |
| `UST_ABWEICHUNG_ANTEIL` / `UST_ABWEICHUNG_MIN_EUR` | **50 %** des Vergleichswerts **und** mindestens **250 €** | **App-Wahl, keine Rechtsnorm** | Ab dieser Abweichung der Zahllast markiert der Hinweis einen Zeitraum — ohne Wertung. |
| `UST_VERGLEICH_PERIODEN` / `UST_VERGLEICH_MIN` | Median der bis zu **4** Zeiträume davor, mindestens **2** | **App-Wahl, keine Rechtsnorm** | Erklärte Werte aus dem Register (Anmeldungssoll) gehen vor berechneten; ein laufender Zeitraum wird nicht geprüft. |

---

## Offene Forderungen (Idee 12) — Verjährung, Verzug, App-Schwellen

Code: `app/src/core/invoices/forderungen.ts` (Zahlungsverhalten, Alter, Mahnstufe, Verjährung),
`mahnung-text.ts` (Entwurfstexte), `forderungen-hinweis.ts` (Hinweis). Abrufstand: **2026-10-09**
(Gesetzestexte auf gesetze-im-internet.de, Stand der dort veröffentlichten Fassung am Abrufdatum). Das ist Zivilrecht,
keine Steuer; die App rechnet **nur die Regelverjährung** und nennt das Ergebnis „vermutlich" — keine Rechtsberatung.

| Annahme | Regel der App | Art | Grundlage |
|---|---|---|---|
| Länge der Verjährung | **drei Jahre** (`VERJAEHRUNG_JAHRE`) | Gesetz | [§ 195 BGB](https://www.gesetze-im-internet.de/bgb/__195.html): „Die regelmäßige Verjährungsfrist beträgt drei Jahre." |
| Beginn | mit dem **Schluss des Jahres**, in dem der Anspruch entstanden ist — „Handeln bis" ist also der **31.12. des dritten Jahres danach**; der 31.12. selbst gilt noch als „Handeln bis" (vorsichtig gelesen: Fristende ist der 31.12.). Eine Forderung vom 15.01.2023 und eine vom 31.12.2023 haben beide „Handeln bis 31.12.2026" | Gesetz | [§ 199 Abs. 1 BGB](https://www.gesetze-im-internet.de/bgb/__199.html): „… beginnt … mit dem Schluss des Jahres, in dem 1. der Anspruch entstanden ist und 2. der Gläubiger von den den Anspruch begründenden Umständen und der Person des Schuldners Kenntnis erlangt …". Bei einer Ausgangsrechnung kennt der Gläubiger beides; Nr. 2 ist damit erfüllt. |
| Jahr der Entstehung | das **frühere** von Rechnungs- und Fälligkeitsdatum | **App-Wahl, konservativ** | § 199 Abs. 1 Nr. 1 BGB sagt nur „entstanden"; bei einer Entgeltforderung ist das in der Regel die Fälligkeit. Die App nimmt das frühere Datum, damit „Handeln bis" nie **später** ausfällt als das wirkliche. Fällt die Fälligkeit ins Folgejahr der Rechnung, kann die Frist ein Jahr länger laufen — dann warnt die App zu früh, nie zu spät. |
| Hemmung, Neubeginn | **nicht verfolgt**; der Hinweis sagt es jedes Mal | Gesetz, bewusst ausgeklammert | [§ 203 BGB](https://www.gesetze-im-internet.de/bgb/__203.html) (Hemmung bei Verhandlungen: Verjährung „frühestens drei Monate nach dem Ende der Hemmung"), [§ 212 BGB](https://www.gesetze-im-internet.de/bgb/__212.html) (Neubeginn bei Anerkenntnis, z. B. Abschlagszahlung, und bei Vollstreckungshandlung); weitere Hemmungsgründe in §§ 204 ff. BGB. Eine Teilzahlung des Kunden kann ein Anerkenntnis sein und die Frist neu beginnen lassen — die App rechnet sie nicht ein. |
| `VERJAEHRUNG_WARNFENSTER_TAGE` | **180 Tage** vor dem 31.12. des Fristjahres; danach „vermutlich verjährt seit …" | **App-Wahl, keine Rechtsnorm** | Zeit für Mahnung, Mahnbescheid oder eine Vereinbarung. Wird geändert, ändert sich nur, ab wann der Hinweis erscheint. |
| Mahnung und Verzug | Die Texte nennen **Fakten** (Rechnung, Fälligkeit, Betrag, Frist) — kein Verzug, keine Zinsen, keine Gebühren | Gesetz, bewusst nicht berechnet | [§ 286 BGB](https://www.gesetze-im-internet.de/bgb/__286.html): Verzug durch Mahnung **nach** Fälligkeit (Abs. 1); ohne Mahnung bei kalendermäßig bestimmter Zeit (Abs. 2 Nr. 1) und bei Entgeltforderungen spätestens **30 Tage nach Fälligkeit und Zugang der Rechnung** (Abs. 3, gegenüber Verbrauchern nur bei besonderem Hinweis in der Rechnung). [§ 288 BGB](https://www.gesetze-im-internet.de/bgb/__288.html): Verzugszins fünf Prozentpunkte über dem Basiszinssatz (Abs. 1), bei Geschäften ohne Verbraucher neun (Abs. 2), dazu 40 € Pauschale (Abs. 5). Der Basiszinssatz (§ 247 BGB, Bundesbank) ändert sich halbjährlich und ist hier **nicht** hinterlegt — darum nennt die App keine Zinsbeträge. Wer Zinsen oder Pauschale verlangen will, schreibt das selbst in den Entwurf. |
| `MAHNUNG_FRIST_TAGE` | Zahlungsfrist im Entwurf: **7 Tage** ab Entwurfsdatum | **App-Wahl, keine Rechtsnorm** | § 286 verlangt keine bestimmte Frist; sieben Tage sind üblich und im Text änderbar. |
| `MAHNUNG_ABSTAND_TAGE` | die nächste Stufe gilt erst **14 Tage** nach der bestätigten letzten als fällig | **App-Wahl, keine Rechtsnorm** | Verhindert, dass drei Stufen in einer Woche anfallen. |
| Alter (Altersstufen) | nicht fällig · 1–30 · 31–60 · 61–90 · über 90 Tage nach Fälligkeit; Fälligkeitstag selbst = noch nicht überfällig | **App-Wahl, keine Rechtsnorm** | Übliche Staffel einer Offene-Posten-Liste; gerechnet auf den **offenen Rest** nach Teilzahlungen. |
| Zahlungsverhalten, Trend | Tage = Zahlungsdatum − Fälligkeit (negativ = früher). Trend: Mittel der letzten **2** bezahlten Rechnungen gegen das Mittel aller früheren, ab **4** bezahlten Rechnungen, Schwelle **3 Tage** (`TREND_LETZTE`, `TREND_FRUEHER_MIN`, `TREND_SCHWELLE_TAGE`) | **App-Wahl, keine Rechtsnorm** | Rein beschreibend. Als bezahlt zählt das Datum, an dem die Rechnung als bezahlt markiert wurde; fehlt es, die Zahlung, mit der die Summe der zugeordneten Eingänge den Rechnungsbetrag erreicht. Eine **Teilzahlung** allein schließt eine Rechnung nicht ab. |

---

## Weitere maßgebliche Quellen (allgemein)

- **ELSTER / ERiC**: die verbindliche Übermittlung + Plausibilitätsprüfung; lokale Schemata unter
  `app/elster/` (ERiC 43.4.6.0 + 2025er Formular-XSDs), siehe Memory `eric-local-schemas`.
- **Gesetze**: <https://www.gesetze-im-internet.de/estg/> (EStG), `/ustg/` (UStG), `/gewstg/`.
- **Amtliche Handbücher (BMF)**: EStH/LStH unter `esth.bundesfinanzministerium.de` /
  `lsth.bundesfinanzministerium.de` (jahresgenau; teils hinter Bot-Schutz — dann Spiegel wie
  finanz-tools.de/nwb/haufe/dejure gegenprüfen).
- **USt / BMF-Umrechnungskurse** (§16 Abs. 6 UStG, monatliche Durchschnittskurse): siehe
  `bmf-umrechnungskurse.json` + Memory `reverse-charge-13b-status`.

**Prüf-Reihenfolge bei jeder neuen Konstante:** Gesetzestext (gesetze-im-internet) → amtliches
BMF-Handbuch (EStH/LStH, jahresgenau) → seriöser Spiegel (nwb, haufe, dejure, finanz-tools) zur
Bestätigung. Nie eine steuerliche Zahl ohne Quelle + Abrufdatum + VZ in den Code.
