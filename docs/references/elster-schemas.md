# ELSTER-Formulare & Schemata (verifizierte Fakten)

Welches ELSTER-Verfahren, welche `DatenArt`, welcher Nutzdaten-Root und welches ERiC-
`datenartVersion`-Token zu welchem Formular gehören — direkt aus der **lokalen ERiC-Distribution**
verifiziert (nicht aus dem Gedächtnis). Gegenstück zu [tax-sources.md](tax-sources.md), das die
steuerrechtlichen *Zahlen* belegt; hier stehen die *technischen* Fakten der Übermittlung.

> Die ERiC-Distribution selbst wird **nie committet** (nicht weiterverteilbar, siehe Memory
> `eric-lib-not-redistributable` / `eric-local-schemas`). Sie liegt lokal unter `app/elster/`.

## Wo die Wahrheit steht

| Was | Pfad (lokal, unter `app/elster/`) |
|---|---|
| XSDs je Formular/Jahr | `ERiC-<ver>-Dokumentation/…/Schnittstellenbeschreibungen/Erklaerungssteuern/<FORM>_<n>_<jahr>/Schema/` |
| **Amtliche Beispiel-XMLs** | dieselben Ordner, `Beispiele/` — **immer zuerst lesen**, sie zeigen die echte Verschachtelung |
| HTML-Schemadoku | `ERiC-<ver>-Schemadokumentation/…/<FORM>_<n>_<jahr>/SchemaDokumentation/` |
| Plausibilitätsregeln | `ERiC-<ver>-Dokumentation/…/Plausipruefungen/Erklaerungssteuern/<FORM>/` |
| Vordrucke (PDF) | `Vordrucke_<jahr>_ERiC-<ver>/<jahr>/Erklaerungssteuern/<FORM>/` |

Die XSDs tragen die amtlichen Vordruck-Zeilentexte als `xs:documentation` an jeder Kennzahl — das
ist die zuverlässigste Quelle dafür, was ein Feld `E…` bedeutet.

## Formular → Verfahren / DatenArt / Root (VZ 2025)

Alle Erklärungen laufen über `Verfahren = ElsterErklaerung`; die USt-VA über `ElsterAnmeldung`.
Namespace-Präfix durchgängig `http://finkonsens.de/elster/elstererklaerung/`.

| Formular | Schema-Ordner | DatenArt | `datenartVersion` | Nutzdaten-Root | `Unterfallart` | Kompression |
|---|---|---|---|---|---|---|
| Anlage EÜR | `EUER_77_2025` | `EUER` | `EUER_2025` | `<E77 …/euer/e77/v2025>` | 77 | GZIP |
| USt-Jahreserklärung | `USt_50_2025` | `UStE` | `USt_2025` | `<E50 …>` | 50 | GZIP |
| Gewerbesteuererklärung | `GewSt_20_2025` | `GewSt` | `GewSt_2025` | `<E20 …/gewst/e20/v2025>` | 20 | GZIP |
| Feststellung (einheitl. u. gesondert) | `FEIN_90_2025` | `FEIN` | `FEIN_90_2025` | `<E90 …/fein/e90/v2025>` | 90 | **NO_BASE64** |
| **Einkommensteuer (ESt 1 A)** | **`ESt_10_2025`** | **`ESt`** | **`ESt_2025`** | **`<E10 …/est/e10/v2025>`** | **10** | GZIP |
| ESt beschränkt (ESt 1 C) | `ESt_12_2025` | `EStbeschraenkt` | — | `<E12 …/estbeschraenkt/e12/v2025>` | 12 | NO_BASE64 |

Die verbindliche Zuordnung DatenArt → `datenartVersion` steht in
`ERiC-<ver>-Dokumentation/…/Dokumentation/Datenartversionmatrix.xml`.

> ⚠️ **Falle: `E12` ist NICHT die normale Einkommensteuererklärung.** `ESt_12_*` / `E12` ist die
> **beschränkte** Steuerpflicht (Vordruck **ESt 1 C**, Gebietsfremde). Die reguläre unbeschränkte
> Erklärung (**ESt 1 A**) ist `ESt_10_*` / **`E10`**. Die Ordnernamen liegen alphabetisch direkt
> nebeneinander — vor dem Bauen eines Builders das `Beispiele/`-XML aufmachen und die `DatenArt`
> prüfen.

## E10-2025 (Einkommensteuer, ESt 1 A)

Referenz-Beispiel: `…/ESt_10_2025/Beispiele/est_e10_2025.xml`.

**Reihenfolge der Top-Level-Kinder von `<E10>`** (XSD `xs:sequence`, alle `minOccurs="0"` — es wird
also nur emittiert, was belegt ist; die *Reihenfolge* ist aber verbindlich):

```
ESt1A · SA · AgB · HA_35a · EM_35c · Sonst · WA_ESt · ESt1A_U · Kind[0..14] · L · Anl_34b ·
Anl_32c · G[0..2] · Zins · S · N_GRE · N[0..2] · N_DHH · N_AUS · KAP · KAP_BET · KAP_I ·
AUS · R · RAV_bAV · R_AUS · SO · V · V_FeWo · V_Sonstige · FW · VOR · AV · Mob · Vorsatz
```

Die Anlagen, die für unseren Fall (Arbeitnehmer:in + ggf. Einzelunternehmen) tragen:

| Block | Anlage | Inhalt |
|---|---|---|
| `ESt1A` | Hauptvordruck | `Art_Erkl`, `Allg/A` (Meldedaten — **ohne** IdNr, s. u.), `Vlg_Art`, `Allg/B` (Ehegatte), `BV` (IBAN `E0102102`) |
| `N` | Anlage N | `ArbL` (Lohnsteuerbescheinigung), `Wk` (EP · Homeoffice · Arbeitsmittel · Weitere_Wk) |
| `VOR` | Vorsorgeaufwand | `AVor` (RV), `Beitr_g_KV_PV_Inl` / `Beitr_p_KV_PV_Inl` (KV/PV), `Weit_Sons_VorAW` |
| `SA` | Sonderausgaben | `KiSt/Gezahlt`, `Zuw/Sp_MB` (Spenden, `Polit_P` §34g) |
| `AgB` | Außergew. Belastungen | `And_Aufw/Krankh` (§33) |
| `HA_35a` | Haushaltsnahe Aufw. | `St_Erm/Minijobs` · `Hhn_BV_DL` · `Handw_L` |
| `Kind` | Anlage Kind (je Kind) | `Ang_Kind` (Identität + Kindergeld-Anspruch) · `K_Verh` · `Schulgeld` · `KBK` — Details unten |
| `G` | Anlage G | `Gew/Einz_U/Betr_1_2` (Einzelunternehmen) vs. `Gew/Ges_Fest` (Anteil aus einer **Feststellung**) |

**Betragsformat — zwei Sorten, pro Kennzahl verschieden.** Es gilt *nicht* „Einzelzeile = Cent,
Summenzeile = ganze Euro": in derselben `LStB_1_5_Sum` ist der Bruttoarbeitslohn `E0200201`
cent-los (`67554`), die Lohnsteuer `E0200301` daneben aber cent-pflichtig (`17653,65`). Immer den
XSD-Typ der einzelnen Kennzahl prüfen:

| Typ | Beispiel | Regel |
|---|---|---|
| `GeldBetragOhneCent` | `67554`, `-1200` | **ganze Euro**; `67554,00` ist **ungültig** |
| `GeldBetragMitCent` | `17653,65` | Cent-Anteil ist **Pflicht**; `775` ist **ungültig** → `775,00` |

Dezimaltrennzeichen ist immer das **Komma**, nie der Punkt. Keine führenden Nullen (`0` allein ist
ok). Minus nur, wo der Typ es erlaubt — Steuerabzugsbeträge (LSt/Soli/KiSt) sind vorzeichenlos.
Datum `TT.MM.JJJJ`, Zeitraum `TT.MM-TT.MM`, Monat `MM.JJ`.

**Als Eingabe deklariert, nicht als Betrag** (das Finanzamt rechnet selbst):
- Entfernungspauschale → `N/Wk/EP/Erste_Taetig`: Tage `E0203503` + einfache Entfernung km `E0203504`.
- Homeoffice-Tagespauschale → `N/Wk/Homeoffice`: **`E0204507`** (ein anderer Arbeitsplatz steht zur
  Verfügung) vs. **`E0206206`** (dauerhaft kein anderer Arbeitsplatz) — rechtlich verschiedene
  Zeilen, nicht austauschbar.

**§35a Handwerker** (`HA_35a/St_Erm/Handw_L/Einz`): `E0170601` = Rechnungsbetrag,
`E0111214` = darin enthaltene Lohn-/Maschinen-/Fahrtkosten; die `Sum` `E0111215` summiert die
**Lohnanteile**, nicht die Rechnungsbeträge.

**Veranlagungsart:** `Vlg_Art/E0101201` = Zusammenveranlagung, `E0102602` = *Einzelveranlagung von
Ehegatten*. Eine unverheiratete Person füllt `Vlg_Art` **gar nicht** aus — `E0102602` ist nicht die
Einzelveranlagung im Alltagssinn.

**Empirisch verifiziert beim Bau von `est-xml.ts` (ERiC 43.4.6.0):**

- **Die IdNr `E0100081` (ESt1A/Allg/A) ist ein „eingefügtes" Systemfeld** (Format-Klasse `I`
  in der Jahresdokumentation) — Nutzer-XML, das sie enthält, wird mit
  `ERIC_IO_READER_UNERWARTETE_ELEMENTE` („Eingefuegt-Kennzeichen J oder P") abgelehnt. Die
  IdNr wird **nur** über den `Vorsatz`-`<ID>` übermittelt.
- **Bankverbindung ist Pflicht** (Regel `Bankverbindungen_1016`, ESt1A Zeile 30): entweder
  IBAN in `BV/E0102102` oder die ausdrückliche Erklärung „keine Bankverbindung vorhanden"
  (`E0102002`) — ein leerer `BV`-Block/gar keiner ist ein Fehler.
- **Freitext-Zeichensatz `Standard_E_V2`** (Pattern der `StringBaseCType`): ASCII 0x20–0x7E
  plus Latin-1/-15-Teilmenge — **kein** Mittelpunkt `·` (0xB7), keine typografischen
  Striche/Anführungszeichen (`–`/`—`/`„"`/`…`). Verstoß = Plausi `ZeichenNichtImZeichensatz`.
  Transaktions-Verwendungszwecke also vor der Ausgabe transliterieren.

**Anlage Kind (`Kind`, 0..14 — je Kind ein Block; verifiziert gegen XSD + amtliches Beispiel,
ERiC 43.4.6.0 validiert):**

- Innere Reihenfolge (XSD `Kind_67907_CType`): `Ang_Kind · K_Verh · … · Schulgeld · … · KBK`.
- `Ang_Kind/Allg`: IdNr `E0500406` (**nutzer-übermittelbar** — anders als die ESt1A-IdNr
  `E0100081`; steht so im amtlichen Beispiel, ERiC akzeptiert), Vorname `E0500107`, ggf.
  abweichender Familienname `E0500108`, Geburtsdatum `E0500701`, **Jahres-Kindergeld-Anspruch**
  `E0500702` (Ganzzahl, max 4 Stellen), Familienkasse `E0500706`. `Ang_Kind/WS/Inl/E0500703` =
  Wohnsitz-Inland-Zeitraum `TT.MM-TT.MM` (bei unterjähriger Geburt ab dem Geburtstag — so auch
  die amtlich eingereichte Vorjahres-Praxis).
- `E0500702`-Konvention (aus der amtlich eingereichten 2024er Erklärung): bei nicht
  zusammenveranlagten Eltern mit **halbem** Kinderfreibetrag der **halbe** Jahresanspruch
  (anteilig je Anspruchsmonat); der **volle** Anspruch nur bei vollem Kinderfreibetrag (z. B.
  `E0501513` = Wohnsitz des anderen Elternteils nicht zu ermitteln).
- `K_Verh`: `K_Verh_A` (`E0500807` Art: 1 leiblich/Adoptiv · 2 Pflegekind · 3 Enkel/Stief;
  `E0500601` Zeitraum) + `K_Verh_and_P` für den anderen Elternteil (`Ang_Pers`: `E0501103`
  Name,Vorname · `E0501104` Geburtsdatum · `E0501903` Dauer · `E0501105` letzte Adresse ·
  `E0501106` Art; `Weit_Ang/E0501513`). Geburtsdatum/Adresse des anderen Elternteils sind
  optional — ERiC validiert auch ohne (grün verifiziert).
- **Schulgeld** (§10 Abs. 1 Nr. 9): `Einz` (`E0505606` Schule/Träger + `E0504405` Betrag) ·
  `Sum/E0505607` · `Elt_k_ZV/E0504505` („das von mir übernommene Schulgeld"). Erklärt wird das
  **GEZAHLTE** Schulgeld (ohne Beherbergung/Betreuung/Verpflegung) — NICHT die abziehbaren
  30 %; die 30 %/5.000-€-Deckelung rechnet das Finanzamt.
- **Kinderbetreuung** (`KBK`, §10 Abs. 1 Nr. 5 — ab VZ 2025 80 %/4.800 €): `Art/Einz`
  (`E0506101` Art+Name+Anschrift des Dienstleisters, `E0506103` Zeitraum, `E0506104` Betrag) ·
  `Art/Sum/E0506105` · `Ersatz_Erstatt` (steuerfreier Ersatz `E0506505`/`E0506504`) ·
  `Ang_HH` · `Elt_k_ZV/Kosten` (Eigenanteil `E0506605`/`E0506604`). Auch hier: GEZAHLTE Beträge.
- **ERiC-Regel `10514160` (empirisch): `KBK` ohne `Ang_HH` wird abgelehnt** („Für den Abzug von
  Kinderbetreuungskosten werden auch Angaben zum Haushalt der Elternteile und zur
  Haushaltszugehörigkeit des Kindes benötigt") — `Gem_HH_Elt` (`E0504807` gemeinsamer Haushalt,
  `E0504808` Kind im Haushalt) oder `K_gem_HH_Elt` (`E0505201`/`E0505202`/`E0508901`) ist
  Pflicht, sobald Betreuungskosten erklärt sind. Mit `Ang_HH` validiert der Block grün.

**Plausi-Fallen** (aus `Plausipruefungen/Erklaerungssteuern/ESt/UFA10/Jahresdokumentation_10_2025.xml`):

- **`VOR/AVor`: `E2000401` (RV-AN-Anteil) und `E2000801` (RV-AG-Anteil) müssen *gemeinsam*
  angegeben werden** (`[950020]`) — eines allein ist ein Fehler.
- **§35a: Einzelaufstellung ist Pflicht.** Summe ohne `Einz` *und* `Einz` ohne Summe sind beides
  Fehler (`[1270]`/`[101170001]`); die Summe muss die Einzelbeträge **±2 €** treffen
  (`[1271]`) — gilt für `E0104109`, `E0107208`, `E0111215`. Art + Betrag immer zusammen (`[12001]`).
- **Anlage N: Steuerklasse `E0200002` ist Pflicht**, sobald Arbeitslohn erklärt ist (`[241]`);
  Einzelbeträge ohne zugehörige Summe sind ein Fehler (`[330101]`/`[330102]`).
- Homeoffice `E0204507` und `E0206206`: die Kalendertage dürfen sich **nicht überschneiden**.

> **Beste Quelle für einen Builder:** die `Jahresdokumentation_10_2025.xml` (neben der `.ods`) —
> sie liefert je Anlage Worksheets `Felder` (Vordruckzeile, Format, Regex, Pflicht-Flag) und
> `Kennzahlen` (vollständiger XML-Pfad, z. B. `ArbL/LStB_1_5_Sum/E0200201`). Daraus lässt sich eine
> Feldtabelle **generieren**, statt sie von Hand zu pflegen.

## Envelope-Abweichung der ESt

Das ESt-Beispiel trägt im **TransferHeader** zusätzlich ein Land-Ziel:

```xml
<Empfaenger id="L"><Ziel>BY</Ziel></Empfaenger>
```

Die übrigen Erklärungen (EUER/UStE/GewSt/FEIN) kommen ohne aus. **Empirisch geklärt (ERiC
43.4.6.0, `est-privat-2025.xml` mit und ohne den Block validiert): ERiC verlangt das Feld für
`ESt` NICHT — beide Varianten validieren grün.** `buildEdsEnvelope` unterstützt es jetzt als
optionales `empfaengerZiel`; der ESt-Builder (`est-xml.ts`) emittiert es analog zum amtlichen
Beispiel (Bundesland aus der est-config, z. B. `NI`), alle anderen Builder lassen es weiter weg.

## Verwandtes

- [tax-sources.md](tax-sources.md) — die steuerrechtlichen Konstanten mit Quelle + Abrufdatum.
- [../prozesse/jahresabschluss.md](../prozesse/jahresabschluss.md) — der Jahresablauf.
- Memory: `eric-local-schemas`, `elster-manual-xml-upload` (XML-Upload in Mein ELSTER geht **nur**
  für die USt-VA — alle übrigen Formulare werden aus dem Prüf-Datenblatt im Web-Formular
  eingetragen).
