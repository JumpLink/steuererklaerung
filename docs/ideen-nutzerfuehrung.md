# Ideenliste — einfacher bedienen, früher warnen, ohne KI nutzbar

Konzepte, keine Aufträge, **nach Priorität sortiert**. Grundlage sind Beobachtungen, wie andere
Finanz-Apps ihren Nutzern Arbeit abnehmen, und die [Qonto-Skills](https://github.com/qonto/skills)
(MIT) — Prüfanleitungen für KI-Agenten, auf Frankreich zugeschnitten und deshalb nur als **Katalog
von Prüfungen** brauchbar, nicht als Code. Übernommen wurden Prinzipien, keine Texte.

**Stand**-Angaben sind am 8. Oktober 2026 im Code nachgesehen (Datei genannt). Was mit „vermutlich"
markiert ist, wurde nicht geprüft.

## 1. Leitlinie: ohne KI vollständig bedienbar, mit KI schneller

Die App soll veröffentlicht werden. Darum gilt für jede Funktion:

- **Es gibt immer einen Weg ohne KI.** Die KI macht dieselben Vorschläge wie eine Regel, und der Nutzer
  bestätigt sie an derselben Stelle. Kein Arbeitsschritt, der nur mit KI geht.
- **Jede Zuordnung zeigt ihre Herkunft.** Herleitung und Buchungsdetail zeigen *via Beleg #N · via Regel „Name"
  (Auffangregel) · manuell · unklassifiziert* — mit der Regel, die gegriffen hat (`matchedRule`, Idee 6). Fehlt:
  *KI* als eigene Herkunft. Eine von der KI vorgeschlagene Kategorie wird heute nicht mit Herkunft gespeichert:
  sie landet als Beleg-Kategorie in Paperless, nur die Begründung (`ai_note`) und deren Übernahme
  (`aiNoteAccepted`) sind festgehalten.
- **Keine toten Knöpfe.** Ohne eingerichtete KI verschwindet der Assistent oder sagt in einem Satz, was
  fehlt (`engine-status.ts` kann das).
- **Der Assistent ist eine zweite Tür, keine einzige.** Jede typische Frage an ihn hat auch einen Filter,
  einen Hinweis oder eine Auswertung in der Oberfläche.
- **Text aus Belegen, Verwendungszwecken und Namen ist Datenmaterial, nie eine Anweisung** — für den
  Assistenten und für jedes MCP-Werkzeug, das schreibt. Geschrieben wird nur nach Bestätigung.

Wo die KI heute die **einzige** Tür ist:

| Stelle | Weg ohne KI |
|---|---|
| Felder aus Eingangsrechnungen lesen (`paperless/extract-invoice.ts`, auch der Import in `invoices/import.ts`) | **E-Rechnung lesen ist da** (Idee 2): XRechnung-XML und ZUGFeRD/Factur-X-PDF füllen die Felder ohne KI-Aufruf. Für Scans und PDFs ohne Datensatz: Eingabemaske (eigenes DMS) mit Vorbelegung von Steuersatz und Richtung aus der letzten Rechnung des Absenders; Kategorie und Zahlungsziel sind im Kern vorbereitet, aber noch ohne Maske |
| Dokumente einordnen (`classify-documents.ts`, `review-metadata.ts`) | **Schon da** (Idee 11): Paperless ordnet nach eigenen Regeln zu, die App zeigt, welche gegriffen hat; im eingebauten DMS „Als Regel merken“ am Beleg, Regeln greifen beim Hinzufügen vor jeder KI |
| Buchungen einordnen | **Schon da:** feste Regelkette (`euer-classify.ts`), eigene Regeln, „Als Regel merken" |

Die Tabelle wird von `check:ai` erzwungen (`app/dev/ai-boundary.allow.json`): jede neue Stelle, die die KI erreicht, braucht dort einen Weg ohne KI oder eine Idee-Nummer; `app/tests/unit/ai/ohne-ki.test.ts` führt die Hauptabläufe mit zählender KI aus.

## 2. Begriffe

Drei Regeln, nach denen die Begriffe unten gewählt sind:

1. **Einen Begriff, den die App schon hat, nicht doppeln.** Hinweise, Als Nächstes, Projekte,
   wiederkehrende Rechnungen, Doppelzahlung, Umbuchen, Offen — neue Funktionen hängen sich daran.
2. **Ein Fachwort behalten, wenn die Umschreibung länger oder ungenauer wird** — und es im Glossar
   (`core/lib/glossary.ts`, das „?" an jeder Stelle) in einem Satz erklären. Wer Steuern selbst macht,
   begegnet diesen Wörtern ohnehin auf dem Bescheid.
3. **Ein Alltagswort meiden, wenn es im Steuerrecht etwas anderes heißt.**

| Begriff | Statt | Warum | Glossar |
|---|---|---|---|
| **Hinweise** | „Prüfungen an einem Ort" | gibt es schon (`elster/hinweise.ts`); die Idee erweitert sie | vorhanden |
| **Zu prüfen** | — | kurz, eindeutig, ein Tab-Name | vorhanden |
| **Auffangregel** | „allgemeine Regel" | sagt, was sie tut: fängt auf, was sonst nichts erkennt — geraten nach dem Kategorie-Wort der Bank | vorhanden |
| **IBAN-Wechsel** | „Neue Kontoverbindung" | IBAN kennt jeder, der Überweisungen macht; kürzer | vorhanden |
| **Doppelzahlung** | — | gibt es schon und heißt: ein Kunde hat zweimal gezahlt. Die Gegenrichtung heißt beschreibend „Lieferant doppelt bezahlt", bis geklärt ist, ob sie steuerlich dasselbe ist; dann ggf. ein Wort für beide | vorhanden |
| **Erstattung** | „Gutschrift" | *Gutschrift* ist im UStG die Abrechnung durch den Leistungsempfänger (§ 14 Abs. 2 UStG), nicht „Geld zurück" | vorhanden |
| **Splitbuchung** (Knopf: „Aufteilen") | „Buchung auf mehrere Kategorien aufteilen" | gängiges Wort in Buchhaltungs-Apps; die Umschreibung taugt nur als Knopf | vorhanden |
| **Laufende Kosten** | „Regelmäßige Zahlungen" | grenzt sich von „wiederkehrenden Rechnungen" (eigene Ausgangsrechnungen) ab | vorhanden |
| **Frei verfügbar** | — | sagt, was es ist; die Formel steht in der Herleitung | neu |
| **Steuerrücklage** | „Monatsrücklage" | sagt, *wofür*; Glossar stellt klar: nur eine Rechnung, keine Buchung | neu |
| **E-Rechnung** / **sonstige Rechnung** | XRechnung/ZUGFeRD, „PDF-Rechnung" | die beiden Begriffe des UStG (§ 14 Abs. 1); die Formate nennt das Glossar | neu |
| **GWG, Anlagegut, Reverse Charge (§ 13b)** | Umschreibungen | Fachwörter, die auf jedem Formular stehen | vorhanden (`anlagegut`, `gwg`, `reverse-charge`, `anlagegut-kandidat`) |
| **Projekt** | „Mappe" | gibt es schon (`projects.ts`, Projekte-Ansicht) | — |
| **Umbuchen** | — | bleibt: Kategorie = SKR03-Konto, also ist es im Wortsinn eine Umbuchung | — |

Jeder neue Glossar-Eintrag läuft durch `check:glossary`.

## 3. Rangliste

Gewichtet nach: beantwortet eine Frage, die man **jede Woche** stellt · nötig, um ohne KI veröffentlichen
zu können · nutzt vorhandene Daten (wenig Risiko) · macht spätere Ideen billiger. Aufwand grob:
**S** Tage · **M** ein bis zwei Wochen · **L** berührt das Datenmodell der EÜR.

| Stufe | # | Idee | Aufwand | Warum hier |
|---|---|---|---|---|
| **A** | 1 | Ohne-KI-Grenze absichern | S | Macht das Versprechen prüfbar, bevor weitere KI-Stellen dazukommen |
| | 2 | E-Rechnungen lesen | M | Die einzige echte KI-Pflicht; E-Rechnungen kommen ohnehin, wir schreiben das Format schon |
| | 3 | Frei verfügbar (erste Fassung) | M | „Was darf ich entnehmen?" ist die häufigste Frage; fast alle Daten sind da |
| | 4 | Hinweise mit Belegen und Handlung, erster neuer Hinweis: Kontoauszug lückenlos? | S–M | Form für alle Prüfungen in Stufe B; die Lücke im Kontoauszug verfälscht sonst still die EÜR |
| | 5 | Doppelt erhaltene Zahlungen fallen sofort auf | S | Das Geld gehört dem Kunden; heute fällt es nur auf, wenn man es selbst bemerkt und von Hand einträgt |
| | 6 | „Zu prüfen" für Buchungen + Regel aus Beispielen | M | Hier entstehen Regeln; macht die Automatik nachvollziehbar |
| **B** | 7 | Geld-Prüfungen: IBAN-Wechsel, Lieferant doppelt bezahlt, doppelte Rechnung | M | Hoher Nutzen je Treffer, braucht Form aus 4 |
| | 8 | Laufende Kosten erkennen | M | Liefert Frei verfügbar v2 und senkt Fehlalarme in 7 |
| | 9 | Erstattungen verknüpfen | M | Erstattung erbt Kategorie und USt der Ursprungsbuchung — heute Handarbeit |
| | 10 | Prüfungen vor der Abgabe | M | Fängt Fehler, die ERiC nicht sieht |
| | 11 | Dokumentregeln ohne KI | S–M | Schließt die zweite KI-Lücke fürs eingebaute DMS |
| | 12 | Offene Forderungen: Zahlungsverhalten, Mahnstufen, Verjährung | M | Für Nutzer mit vielen Kunden wichtiger als für uns |
| **C** | 13 | Splitbuchung | L | Großer Nutzen, größter Umbau |
| | 14 | Projekte auch für Ausgaben | M | Projektkosten neben Projektumsatz; kein Muss |
| | 15 | Belege aus einem Mail-Ordner holen | M | Paperless kann es schon; nur fürs eingebaute DMS |

Was gegenüber der ersten Fassung verworfen oder eingefaltet wurde, steht mit Grund in Abschnitt 5.

## 4. Die Ideen im Einzelnen

### Stufe A

**1. Ohne-KI-Grenze absichern.** Kein Oberflächen-Test („jede Ansicht lädt" lässt sich nicht billig
automatisieren), sondern zwei Prüfungen:
- **Statisch** im Stil von `check:fields`: jede Stelle, die `getLLMProvider` erreicht, steht in einer
  Erlaubt-Liste mit dem Satz, welcher Weg ohne KI an ihre Stelle tritt. Neue KI-Stelle ohne Eintrag =
  rot. Die Liste ist zugleich die Übersicht oben.
- **Im Testlauf:** Provider abgeschaltet (wirft beim Aufruf), die vorhandenen Tests der Hauptwege laufen
  grün — Beleg zuordnen, Buchung einordnen, Rechnung schreiben, EÜR erzeugen.

**2. E-Rechnungen lesen.**
*Problem:* Ohne KI wird jede Eingangsrechnung abgetippt. Und seit 1.1.2025 muss **jedes** inländische
Unternehmen E-Rechnungen empfangen können, auch Kleinunternehmer, ohne Übergangsfrist. Ab den Umsätzen
2027 wird die PDF-Rechnung im Inland zur Ausnahme (Vorjahresumsatz ≤ 800.000 €), ab 2028 entfällt sie
ganz. Quellen: `references/tax-sources.md`, Abschnitt „§14 UStG — E-Rechnung".
*Lösung:*
1. **E-Rechnung lesen** — reine XML-Datei (XRechnung) oder PDF mit eingebetteter XML (ZUGFeRD/Factur-X).
   Die Felder stehen dann exakt in der Datei, ohne Raten. **Stand:** umgesetzt in `core/invoices/e-rechnung/`
   — CII (Gegenrichtung zu `core/invoices/cii-xml.ts`) und UBL (Invoice, CreditNote), der Anhang eines PDFs
   wird in reinem TypeScript herausgelöst. CLI: `invoices e-rechnung lesen <datei>`.
2. **Bei hybriden Rechnungen gilt das XML**, nicht das PDF. Weichen die beiden ab (Betrag, USt), wird das
   ein Hinweis.
3. **Kein gültiges E-Rechnungsformat → sagen.** Die ZUGFeRD-Profile MINIMUM und BASIC-WL sind keine
   E-Rechnung im Sinne des UStG, ebenso wenig ein PDF ohne Datensatz. Solange die Übergangszeit läuft,
   ist das zulässig; danach kann der Vorsteuerabzug daran hängen. Der Beleg bekommt eine klare Markierung
   „E-Rechnung" oder „sonstige Rechnung".
4. **Eingabemaske mit Vorbelegung** für alles andere: Absender erkannt → Kategorie, USt-Satz, Zahlungsziel
   aus dessen letzter Rechnung.
*Mit KI:* weiter für Papier, Scans und reine PDFs.
*Nicht in dieser Idee:* eine vollständige technische Prüfung gegen die Regeln der Norm (der amtliche
Validator der KoSIT ist eine Java-Anwendung). Optional als externer Aufruf, nicht als Voraussetzung.

**3. Frei verfügbar (erste Fassung).**
*Problem:* Der Kontostand sagt nicht, was davon schon dem Finanzamt oder Lieferanten gehört.
*Lösung:* Kontostand − USt seit der letzten Voranmeldung − fällige Steuer-Vorauszahlungen − offene
Eingangsrechnungen = **frei verfügbar**. Daneben die **Steuerrücklage**: geschätzte Einkommen- und
Gewerbesteuer des Jahres minus geleistete Vorauszahlungen. Jede Zahl öffnet die Herleitung.
Ausdrücklich eine Rechnung, keine Empfehlung.
**Stand:** Liquidität je Konto (`core/elster/home.ts`), offene Steuerzahlungen (`steuerzahlungen.ts`),
Steuertermine, ESt-Berechnung und offene Posten sind da; es fehlt das Zusammenrechnen.
**Umgesetzt:** `core/elster/frei-verfuegbar.ts` (Rechnung) + `core/presenters/frei-verfuegbar.ts` (Laden je
Entität); Karten mit Herleitung auf der Übersicht, CLI `frei-verfuegbar`, MCP `frei_verfuegbar`. Fällig =
überfällig oder binnen 30 Tagen (App-Fenster, `FAELLIG_FENSTER_TAGE`).
*Später (mit Idee 8):* laufende Kosten der nächsten 30/90 Tage abziehen, Kurve, Warnung vor Unterdeckung.
**Umgesetzt (laufende Kosten):** eigener Posten „Laufende Kosten (nächste 30 Tage)" in `frei-verfuegbar.ts`, abgezogen; nur
bestätigte Serien, je erwartete Zahlung eine Zeile, unbestätigte Vorschläge nur gezählt. Die erste Zeile der Herleitung nennt
„Frei verfügbar ohne laufende Kosten (erste Fassung)". Offen: 90 Tage, Kurve, Warnung vor Unterdeckung.
*Mit KI:* Gedankenspiele („wenn Kunde X einen Monat später zahlt").

**4. Hinweise mit Belegen und Handlung.**
*Problem:* Hinweise sind heute Titel + Text (`elster/hinweise.ts`: Beleg-Lücke, Doppelzahlung, Fristen,
Unklassifiziert u. a.). Man liest sie und sucht dann selbst. *Lösung:* Ein Hinweis bekommt
- die **betroffenen Buchungen und Belege** (anklickbar),
- **eine Handlung** („Zuordnen", „Als in Ordnung markieren", „Regel anlegen"),
- **„Geprüft, ohne Befund"** mit dem, was ausgeschlossen wurde („Abos, Ratenzahlungen nicht gemeldet"),
- **„Nicht prüfbar, weil …"** statt Schweigen.
Hinweise mit Handlung erscheinen in **Als Nächstes** auf der Übersicht; erledigt = weg.
*Wortwahl:* „vermutlich", „zu klären" — nie „Fehler" oder „Betrug". Ein Hinweis ändert nichts; die
Handlung ist ein eigener Klick.
*Erster neuer Hinweis — Kontoauszug lückenlos?:* je Konto Anfangssaldo + Umsätze = Endsaldo, und keine
Zeiträume ohne Auszug im Jahr. Eine fehlende CAMT-Datei verfälscht sonst die EÜR, ohne dass es auffällt.
*Mit KI:* erklärt einen Hinweis, entwirft eine Rückfrage.
**Umgesetzt:** `Hinweis` trägt optional `status` (`befund` · `ohne_befund` + `geprueft` · `nicht_pruefbar` +
`weil`), `betroffen`, `handlungen` (Ziel: Ansicht, Dialog oder Kern-Aktion) und `fingerprint`
(`core/elster/hinweise.ts`); „Als in Ordnung markieren" speichert je Entität Schlüssel + Jahr + Fingerabdruck
(`hinweise_geprueft`), ein neuer Befund kommt wieder. Unklassifiziert, Beleg-Lücke und Doppelzahlung tragen
ihre Buchungen bzw. die Rechnung. Kontoauszug lückenlos? in `core/elster/kontoauszug.ts`: Saldenkette,
Auszugsnummern und Summe je CAMT-/FinTS-Auszug (Metadaten neu in `statements.json` des Stores), sonst Monate
ohne Umsätze; ohne Salden „nicht prüfbar". Befunde mit Handlung stehen in Als Nächstes; Karten in den
Einblicken, CLI `hinweise` / `hinweise ok <key>`, MCP `hinweise_list` / `hinweise_ok`, E2E `app/dev/hinweise-e2e.sh`.

**5. Doppelt erhaltene Zahlungen fallen sofort auf.**
*Problem:* Zahlt ein Kunde eine Rechnung zweimal, gehört ihm das Geld. Steuerlich ist die zweite Zahlung
kein Umsatz, sondern eine Rückzahlungspflicht. Heute weiß die App das nur, wenn man es bemerkt und die
Buchung von Hand in `adjustments.doppelzahlungen` einträgt (`euer-transactions.ts` rechnet sie dann als
durchlaufenden Posten heraus). Bemerkt man es nicht, steht zu viel Umsatz und zu viel USt in der
Erklärung, und der Kunde wartet auf sein Geld.
*Lösung:* Die Zuordnung Zahlungseingang ⇄ Ausgangsrechnung gibt es schon (`invoice-payments.ts`, Abgleich
über die Rechnungsnummer im Verwendungszweck). Darauf aufsetzen:
- **Erkennen:** ein zweiter Eingang zu einer Rechnung, die schon bezahlt ist · ein Eingang über dem
  offenen Betrag · zwei Eingänge mit gleichem Betrag vom selben Kunden, ohne offene Rechnung in dieser Höhe.
  Vorher ausschließen: Teilzahlungen (Summe = Rechnung), Anzahlung + Restzahlung.
- **An drei Stellen zeigen,** damit es nicht übersehen wird:
  1. in **Als Nächstes**, sobald die Zahlung eingeht, bis es geklärt ist;
  2. **an der Rechnung** selbst („2 Zahlungen eingegangen — 1 zu viel");
  3. **vor der Abgabe** von USt-VA und EÜR als offener Hinweis, solange ungeklärt.
- **Handlungen:** „Ist eine Doppelzahlung" (trägt sie ein, der bestehende Hinweis „neutralisiert" greift) ·
  „Gehört zu einer anderen Rechnung" (zuordnen) · „Ist in Ordnung".
- **Rückzahlung verfolgen:** Die eingetragene Doppelzahlung bleibt offen, bis die Rückzahlung an den Kunden
  als Buchung verknüpft ist. Optional: Entwurf einer Nachricht an den Kunden.
Diese Idee steht vor Stufe B, weil der Fehler die Erklärung falsch macht und fremdes Geld betrifft.

**6. „Zu prüfen" für Buchungen + Regel aus Beispielen.**
*Problem:* Buchungen ohne Kategorie stecken in der Gesamtliste; Regeln schreibt niemand gern.
*Lösung:*
- Ein Tab **Zu prüfen** im Buchungen-Hub: unklassifizierte Buchungen und solche, die nur eine allgemeine
  Auffangregel getroffen haben. Bestätigen oder umbuchen, ← → zum Weiterblättern, Fortschritt, am Ende
  „Alles geprüft". Der Zähler steht in Als Nächstes.
- **Regel aus Beispielen:** mehrere Buchungen markieren → die App schlägt das gemeinsame Muster vor und
  zeigt vor dem Speichern, **welche vorhandenen Buchungen es trifft** (falsche abwählen).
- **Welche Regel gegriffen hat**, in der Herleitung und im Buchungsdetail.
- **Umbuchung zurücknehmen** an der Buchung, mit dem Satz, was dann gilt („dann wieder: via Regel X").
**Stand:** `suggestPattern`, `rememberRule`, Vorschau gegen echte Buchungen (`toClassifyRules`),
„Als Regel merken" im Umbuchen-Dialog, Herkunft in der Herleitung; eigene Umbuchung gewinnt immer, und
`removeClassificationDecision` nimmt sie zurück. **Neu:** der Klassifizierer muss die getroffene Regel
mitliefern (heute nur die Kategorie), die Mehrfachauswahl, der Tab.
*Mit KI:* schlägt Kategorie und Muster vor — als Vorschlag mit Herkunft *KI*.
**Umgesetzt:** Der Klassifizierer liefert `matchedRule` (stabile `id`, Name, Art; `auffang` als ausdrückliche
Markierung an den Regeln, die nach dem Kategorie-Wort der Bank raten — `euer-classify.ts`); `classifyTransaction`
ohne Umbuchung ergibt „Danach gilt wieder: …" (`core/elster/zu-pruefen.ts`). Tab **Zu prüfen** im Buchungen-Hub:
Bestätigen speichert die Kategorie als `source='rule'`-Bestätigung im Ledger — keine Übersteuerung, die EÜR bleibt
gleich, eine spätere Änderung der Kategorie holt die Buchung zurück. **Regel aus Auswahl** (`core/elster/regel-aus-beispielen.ts`)
zeigt jeden Treffer der echten Regelkette; abgewählte werden `ausnahmen` der Regel. Als Nächstes: eine Aufgabe
„N Buchungen zu prüfen" ersetzt die des Hinweises Unklassifiziert. CLI `buchungen zu-pruefen` / `buchungen bestaetigen`,
MCP `buchungen_zu_pruefen` / `buchung_bestaetigen`, E2E `app/dev/zu-pruefen-e2e.sh`.

### Stufe B

**7. Geld-Prüfungen** (als Hinweise in der Form aus Idee 4):

| Hinweis | Was er findet | Stand |
|---|---|---|
| **IBAN-Wechsel** | bekannter Lieferant, Zahlung an eine andere IBAN als bisher → immer oben, unabhängig vom Betrag. Text: unter der *bekannten* Nummer nachfragen. | Gegenkonto-IBAN steht im Store (`packages/store`); die Prüfung fehlt |
| **Lieferant doppelt bezahlt** | zwei Abbuchungen zur selben Eingangsrechnung — die Gegenrichtung zu Idee 5. Vorher ausschließen: Teilzahlung (Summe = Rechnung), Anzahlung + Rest, spätere Erstattung. | fehlt; vorher klären, wie die zweite Zahlung zu verbuchen ist (Forderung an den Lieferanten statt Ausgabe) |
| **Doppelte Rechnung** | gleicher Absender und Betrag kurz hintereinander, oder gleiche Rechnungsnummer. Abos ausschließen (mindestens drei Treffer im festen Abstand = Serie). | `paperless/find-duplicates.ts` findet doppelte *Dokumente*; hier geht es um zwei verschiedene Dokumente derselben Forderung |

**Umgesetzt:** je eine reine Prüfung in `core/elster/` — `iban-wechsel.ts` (Gegenkonto-IBAN aus camt/FinTS und neu
aus der Qonto-API `transfer`/`income`/`direct_debit`; PayPal hat keine; IBANs überall maskiert `DE…1234`, Vorrang vor
allen Hinweisen und Aufgaben), `doppelte-rechnung.ts` (eigenes DMS und Paperless über `DmsDocument`; 30 Tage als
App-Schwelle) und `lieferant-doppelt-bezahlt.ts` (verknüpfte Zahlungen + Rechnungsnummer im Verwendungszweck);
Serien erkennt `serie.ts`, das Idee 8 weiterverwendet. Jede Prüfung meldet Befund, „ohne Befund" mit den Ausschlüssen
oder „nicht prüfbar". Handlungen: Buchung bzw. Beleg öffnen, „Als in Ordnung markieren" (Fingerabdruck mit neuer
IBAN bzw. allen Belegen/Zahlungen). Keine Neutralisierung der zweiten Lieferantenzahlung (siehe Abschnitt 6). Einblicke,
Als Nächstes, CLI `hinweise`, MCP `hinweise_list`; Demo-Fälle Hetzner (neue IBAN), Druckerei Hafenblick, Werbetechnik
Nordwind; E2E `app/dev/geld-pruefungen-e2e.sh`. Die Warnung vor der Abgabe bleibt Idee 10.

**8. Laufende Kosten erkennen.** Abbuchungen im festen Abstand (Miete, Software, Versicherung) werden
erkannt und zur Bestätigung vorgelegt: Abstand, Betrag, Empfänger, zuletzt gezahlt, Hinweis bei
Preisänderung. Korrigieren oder „keine laufenden Kosten". *Nutzen:* Frei verfügbar v2, und Abos fallen
aus den Doppel-Prüfungen. **Stand:** fehlt — `recurring-schedules.ts` sind wiederkehrende
*Ausgangs*rechnungen, eine andere Sache.
**Umgesetzt:** `core/elster/laufende-kosten.ts` über `serie.ts` (`findeSerienMitDrift`, neu halbjährlich): je Entität über
alle Jahre, nach normalisiertem Empfänger, ± 5 Tage; monatlich/vierteljährlich ab 3, halb-/jährlich ab 2 Zahlungen; Betrag
darf je Zahlung um 25 % wandern (Preisänderung mit Datum); „beendet?" nach mehr als 1,5 Abständen ohne Zahlung vor der
neuesten Buchung. Entscheidungen (bestätigt, optional mit Abstand/Betrag korrigiert · keine laufenden Kosten · beendet)
an der Entität (`laufende_kosten`, wie `hinweise_geprueft` — kein EÜR-Wert, auch für `privat`). Bestätigte zählen in Frei
verfügbar und fallen aus Doppelte Rechnung (Rechnungen einen Abstand auseinander) und Lieferant doppelt bezahlt; eine
Preisänderung nach der Bestätigung wird Hinweis „Preisänderung bei …". Tab **Laufende Kosten** im Buchungen-Hub, Als
Nächstes „N laufende Kosten zu bestätigen", CLI `laufende-kosten` / `laufende-kosten entscheiden`, MCP
`laufende_kosten_list` / `laufende_kosten_entscheiden`, Glossar `laufende-kosten`; Demo: Pixelkraft (Preisänderung), Hanse
Versicherung (jährlich); E2E `app/dev/laufende-kosten-e2e.sh`.

**9. Erstattungen verknüpfen.** Zu einer Rückzahlung die Ursprungsbuchung vorschlagen („Gehört das zu
dieser Zahlung?" — Ja/Nein, Kandidat daneben). Der eigentliche Gewinn: Die Erstattung **erbt Kategorie
und USt-Satz** der Ursprungsbuchung und mindert damit die richtige Ausgabe samt Vorsteuer, statt als
Einnahme oder unklassifiziert zu landen. **Stand:** `link-candidates.ts` verknüpft Beleg ⇄ Buchung,
nicht Buchung ⇄ Buchung; der Storno-Pfad für eigene Rechnungen existiert.
**Umgesetzt:** `core/elster/erstattung.ts` (rein): Kandidaten sind frühere Ausgaben derselben Entität an dieselbe
Gegenseite (`gleichePartei` aus Idee 7) binnen 365 Tagen (`ERSTATTUNG_FENSTER_TAGE`, App-Schwelle), deren noch offener
Betrag reicht; gleicher Betrag zuerst, dann gemeinsame Rechnungs-/Bestellnummer, dann die jüngste. Nicht angeboten:
Eingänge mit Beleg oder Umbuchung, bestätigte Doppelzahlungen, Geldtransit/Privat/Steuer und Einnahmen, die eine Regel
am Zahler erkannt hat. Mehrere Erstattungen zu einer Zahlung, zusammen höchstens deren Betrag. „Ja", „Nein" und
„Verknüpfung lösen" liegen im Ledger (`refund_links`, Schema v19, im Entscheidungs-Log) — wie die Umbuchungen, weil es
Entscheidungen je Buchung sind, die EÜR-Zahlen ändern; nicht im Manifest wie `rueckzahlung` (Idee 5), das an einer
Konfigurations-Anpassung hängt. Steuerlich: Minderung der Kategorie und der Vorsteuer im Jahr und Zeitraum des Eingangs
(§ 11 EStG, § 17 Abs. 1 Satz 2 und 8 UStG), Vorjahr bleibt unverändert; Kategorie und Satz werden beim „Ja"
eingefroren (`references/tax-sources.md`, „Erstattungen"). Herkunft „via Erstattung zu Buchung vom …", Rücknahme mit
„Danach gilt wieder: …". Buchungsdetail und Zu prüfen fragen „Gehört das zu dieser Zahlung?"; Als Nächstes zeigt
„N Erstattungen zuordnen", und die Zu-prüfen-Aufgabe zählt diese Eingänge nicht mit. CLI `buchungen erstattungen` /
`buchungen erstattung`, MCP `erstattungen_list` / `erstattung_entscheiden`, Glossar `erstattung`; Demo Büromöbel
Kranich (volle Erstattung), Messebau Ostsee (Teilerstattung); E2E `app/dev/erstattungen-e2e.sh`.

**10. Prüfungen vor der Abgabe** (Hinweise beim Erstellen von USt-VA und Jahreserklärung):
- USt dieser Periode gegen die früheren Voranmeldungen — große Abweichung markieren, nicht bewerten.
- Buchungen ohne USt-Angabe zählen und sagen, dass die Vorsteuer dann eine Untergrenze ist.
- **§ 13b-Kandidat nicht erkannt:** ausländischer Lieferant, Rechnung ohne USt, aber nicht als Reverse
  Charge eingeordnet. **Stand:** die Einordnung selbst gibt es (`elster/reverse-charge.ts`); der Hinweis
  fängt nur, was durch sie fällt.
- **Anlagegut-Kandidat:** Ausgabe über der GWG-Grenze bei einem Ausrüstungs-Lieferanten → Vorschlag
  fürs Anlageverzeichnis; Raten an denselben Händler = ein Gut. **Stand:** Anlageverzeichnis und AfA
  gibt es, die Erkennung nicht.
Grenzen und Fristen nur aus `references/tax-sources.md`.
**Umgesetzt:** je eine reine Prüfung in `core/elster/`, alle in der Form aus Idee 4. `ust-abweichung.ts`: Zahllast je
Voranmeldungszeitraum (erklärter Wert aus dem Register vor dem aus den Buchungen berechneten) gegen den Median der bis zu
vier Zeiträume davor, auch über den Jahreswechsel; markiert ab 50 % und 250 € Abweichung (App-Schwellen), laufender
Zeitraum und Kleinunternehmer „nicht prüfbar". `ust-ohne-angabe.ts`: Ausgaben, deren Beleg weder USt noch Netto + Brutto
nennt — die Vorsteuer aus Belegen ist dann eine Untergrenze; ohne Beleg bleibt es die Beleg-Lücke, unklassifiziert der
Hinweis Unklassifiziert. `reverse-charge-kandidat.ts`: Ausgabe ohne ausgewiesene USt, nicht von `reverse-charge.ts`
eingeordnet, Lieferant vermutlich im Ausland (IBAN-Land, USt-IdNr. am Beleg, Kontakt, andere § 13b-Buchung derselben
Gegenseite); geprüft auch beim Kleinunternehmer, der die Steuer ohne Vorsteuerabzug schuldet (§ 13b Abs. 5, § 18 Abs. 4a
UStG). `anlagegut-kandidat.ts`: über 800 € netto (brutto ohne Vorsteuerabzug, § 9b EStG; genau 800 € ist noch GWG) in
Büroeinrichtung, Bürobedarf, Sonstiges oder unklassifiziert, nicht im Anlageverzeichnis; Raten an denselben Händler
(`serie.ts`) sind ein Gut, bestätigte laufende Kosten keins; bis 1.000 € nennt der Hinweis den Sammelposten (§ 6 Abs. 2a
EStG). „Ins Anlageverzeichnis" öffnet „Wirtschaftsgut erfassen" vorbelegt und speichert die Buchungen am Gut
(`buchung_ids`), dann ist der Hinweis weg. „Vor der Abgabe klären" (`vor-abgabe.ts`) im Abgabe-Schritt und in der
USt-VA-Ansicht zeigt diese Befunde und die Warnungen der Geld-Prüfungen (Idee 7) mit Buchungen und Handlungen — keine
Sperre; Einblicke, Als Nächstes, CLI `hinweise --vor-abgabe`, MCP `hinweise_list` (`vorAbgabe`). Grenzen, Kleinunternehmer-
Entscheidung und Schwellen in `references/tax-sources.md`, „Prüfungen vor der Abgabe"; Glossar `gwg`, `anlagegut-kandidat`,
`reverse-charge`. Demo: Nordlys Analytics (dänische IBAN), Technikhaus Nord (Workstation), Copyshop Möwe und Fotostudio Kranz
(Belege ohne USt); E2E `app/dev/vor-abgabe-e2e.sh`.

**11. Dokumentregeln ohne KI.** Mit Paperless: dessen eigene Zuordnung (Korrespondent, Dokumenttyp,
Tags) nutzen und in der App bloß anzeigen, welche gegriffen hat. Mit eingebautem DMS: „Als Regel
merken" auch für Belege — Absender → Dokumenttyp, Kategorie —, dieselbe Regelmaschine wie bei Buchungen.
**Umgesetzt:** Eingebautes DMS: `core/dokumentregeln/regeln.ts` (rein: Muster als Teilstring aus Absender, Titel, Dateiname und PDF-Text, stabile `id`, `ausnahmen`, Herkunft) und `core/actions/dokumentregeln.ts`; Regeln stehen in `elster.klassifizierung.beleg_regeln` neben den Buchungsregeln (gleiche Manifest-Mechanik, gleiche Sicherung), das Ergebnis samt Herkunft am Beleg im Ledger (`documents.category`, `rule_origin`, Schema v20). Eine Regel füllt nur leere Felder (Korrespondent, Dokumenttyp, Kategorie, Richtung) und greift einmal beim Hinzufügen (`storeReceipt`), nach dem Lesen einer E-Rechnung und vor jeder KI; die KI (`analyzeReceipt`) lässt Regelfelder aus. Von Hand geändert gewinnt: das Feld verlässt die Herkunft. „Zurücknehmen“ leert die Regelwerte, sagt „Danach gilt: …“ und trägt den Beleg in `ausnahmen` ein. Paperless: `paperless/zuordnung.ts` rechnet die Regeln des Korrespondenten, Dokumenttyps und der Tags (Verfahren any/all/literal/regex) gegen den Text nach — Paperless speichert nicht, welche Regel gegriffen hat, darum „vermutlich“; unscharf und automatisch sind nicht nachrechenbar und werden so benannt. Oberflächen: „Als Regel merken“ im Beleg-Dialog, Herkunftszeile im Beleg-Eingang und in der Belegliste, Regeleditor in den Einstellungen, CLI `belege …` und `paperless zuordnung`, MCP `dokumentregeln_list` / `dokument_herkunft` / `dokumentregel_merken` / `dokumentregel_entfernen`, Glossar `dokumentregel`, E2E `app/dev/dokumentregel-e2e.sh`.

**12. Offene Forderungen.** Je Kunde: Zahlungsdatum minus Fälligkeit (Mittel, schlimmster Fall, Trend);
offene Posten nach Alter; **Mahnung in Stufen** (freundlich → bestimmt → förmlich) als Entwurf, nie
ohne Bestätigung versandt; **Verjährung** je Forderung mit „Handeln bis …" (§§ 195, 199 BGB, Quelle in die
Registry). Nur aus eigenen Daten. Für einen Betrieb mit wenigen Kunden selten nötig, für Nutzer mit
vielen Kunden ein Grund, die App zu nehmen.
**Umgesetzt:** Reine Rechnung in `core/invoices/forderungen.ts` (Eingabe: Ausgangsrechnungen + die Eingänge, die ihre
Nummer im Verwendungszweck nennen — dieselbe Zuordnung wie Idee 5). *Zahlungsverhalten:* Tage = Zahlungsdatum − Fälligkeit je
bezahlter Rechnung; Mittel, schlimmster Fall und Trend (letzte 2 gegen alle früheren, ab 4 bezahlten Rechnungen, Schwelle
3 Tage); als bezahlt zählt das „bezahlt“-Datum, sonst die Zahlung, mit der die Summe der Eingänge den Betrag erreicht — eine
Teilzahlung allein schließt nichts ab. *Offene Posten nach Alter:* nicht fällig · 1–30 · 31–60 · 61–90 · über 90 Tage, Summen je
Stufe und je Kunde, gerechnet auf den offenen Rest nach Teilzahlungen; deckt der Eingang den ganzen Betrag, steht die Rechnung
unter „Vermutlich schon bezahlt“ und wird nicht gemahnt. *Mahnung in Stufen:* Zahlungserinnerung (freundlich) → Mahnung
(bestimmt) → letzte Mahnung (förmlich); `mahnung-text.ts` entwirft nur Fakten (Nummer, Datum, Betrag, Fälligkeit, Frist von 7
Tagen, frühere Stufen), keine Zinsen, Gebühren oder Drohungen. Gespeichert wird je (Entität, Rechnung, Stufe) im Ledger
(`invoice_reminders`, Schema v21, wie die Mailhistorie mit weicher Rechnungs-ID — gilt für Self und Qonto, ist keine
Steuergröße und gehört darum nicht ins Manifest): `Entwurf erstellt` und `versandt am`. Die App versendet nie; eine Stufe
zählt erst nach „Als versandt markieren“ (Desktop fragt nach) bzw. `--versandt`/MCP-Schreibwerkzeug; die nächste Stufe ist 14
Tage danach fällig. *Verjährung:* drei Jahre ab Ende des Entstehungsjahres (§§ 195, 199 BGB, früheres von Rechnungs- und
Fälligkeitsdatum) → „Handeln bis 31.12.JJJJ“; als Hinweis (Idee-4-Form, „vermutlich“, Hemmung/Neubeginn §§ 203 ff., 212 BGB
nicht verfolgt) 180 Tage vorher und danach als „vermutlich verjährt“. Schwellen als App-Wahl, Quellen und Abrufdatum in
`references/tax-sources.md`, „Offene Forderungen“. Oberflächen: Rechnungen ist jetzt ein Tab-Hub mit **Offene Forderungen**
(Alter, Rechnungen mit Mahnstufe und Verjährung, „Mahnung entwerfen“ mit Stufenwahl, Kopieren, Textdatei, Mailentwurf,
„Als versandt markieren“, Zahlungsverhalten); Als Nächstes „N Forderungen überfällig“ (ohne die Rechnungen, die schon der
Verjährungs-Hinweis trägt) und der Hinweis in Einblicke und Als Nächstes; CLI `invoices self forderungen [--json]` und
`invoices self mahnung <id> [--stufe] [--versandt]`; MCP `forderungen_list` (lesend, auch mit Entwurfstext) und
`forderungen_mahnung_versandt` (schreibend); Glossar `mahnstufe`, `verjaehrung`; Demo-Fälle Gasthof Strandperle (zahlt
zunehmend später), Leuchtfeuer Medien (Forderung von 2023), Hafenkontor Wartung Q1 (über 90 Tage), Seeblick Speisekarte
(400 € angezahlt) und vier Rechnungen relativ zum Seed-Tag für alle Altersstufen; E2E `app/dev/forderungen-e2e.sh`.

### Stufe C

**13. Splitbuchung.** Eine Buchung in Teile mit Betrag und Kategorie zerlegen; ein Teil nimmt immer den
Rest. Für gemischte Bestellungen (betrieblich + privat), Bewirtung, Telefon. Auflösen mit klarer
Warnung. **Stand:** Privatanteile laufen pauschal über `adjustments` (Bruttomethode). Offen: Teile als
eigene Zeilen im Ledger oder als Aufteilung über der unveränderten Buchung — und was mit schon
eingereichten Jahren passiert.
**Umgesetzt:** Entschieden: eine **Aufteilung über der unveränderten Buchung** im Ledger (`booking_splits`, Schema v22,
im Entscheidungs-Log als `aufteilung.*`) wie `refund_links` — die Bankbuchung bleibt, wie sie ist; keine eigenen
Buchungszeilen. Rein in `core/elster/splitbuchung.ts`: Teile in Cent, ein Teil nimmt den Rest (ohne Betrag gespeichert,
bei jedem Lesen neu gerechnet), Prüfung von Betrag (positiv, über 0, höchstens zwei Nachkommastellen, Summe ≤ Buchung),
Kategorie (passend zur Richtung) und Satz (0/7/19 %). Die EÜR (`aufteilungen` in `euer-transactions.ts`) bucht jeden Teil
in seine Kategorie; ein privater Teil (`1800 Privatentnahme`) ist neutral — keine Betriebsausgabe, keine Vorsteuer; die
belegbasierte USt-VA zieht dessen USt im Zeitraum des Belegs ab. Vorlage **Bewirtung 70/30**: 70 % `4654 Bewirtungskosten`,
der Rest in der neuen neutralen Kategorie `4654 Nicht abziehbare Bewirtungskosten`, deren Vorsteuer voll zählt (§ 4 Abs. 5
Satz 1 Nr. 2 EStG, § 15 Abs. 1a Satz 2 UStG). Eine Aufteilung gewinnt über Beleg, Regel und Umbuchung; ihre Zeile nennt den
größten betrieblichen Teil, Herkunft „aufgeteilt in N Teile", Herleitung „Teil 1 von 2" mit allen Teilen; BWA, Herleitung
und Anlagegut-Kandidat lesen die Teile. **Entschieden: eingereichte Zeiträume** — liegt die Buchung in einem Monat/Quartal
mit eingereichter Voranmeldung oder einem Jahr mit eingereichter EÜR, USt-Jahres-, Feststellungs- oder GewSt-Erklärung
(Register mit Abgabedatum), schreibt weder Aufteilen noch Aufheben ohne ausdrückliche Bestätigung; die Warnung nennt die
Erklärung und die nötige Berichtigung (§ 153 AO, § 168 AO), das Register bleibt unverändert. Erstattung zu einer
aufgeteilten Zahlung: erbt Kategorie und Satz des größten betrieblichen Teils, höchstens dessen Betrag; eine verknüpfte
Erstattung wird erst nach „Verknüpfung lösen" aufgeteilt. Neben dem pauschalen Privatanteil (`adjustments.privatanteile`)
ist die Aufteilung der Weg je Buchung; mit privatem Teil warnt die App vor doppelter Erfassung, wenn beides eingetragen
ist. „Aufteilung aufheben" sagt „Danach gilt wieder: …". Oberflächen: „Aufteilen" im Buchungsdetail (Rest live,
Prüfsatz, Vorlage Bewirtung), Teile in Buchungsdetail und Herleitung, CLI `buchungen aufteilen` / `buchungen aufteilungen`,
MCP `aufteilungen_list` / `buchung_aufteilen`, Glossar `splitbuchung`; Quellen in `references/tax-sources.md`,
„Splitbuchung". Demo: Versandhaus Möwenpost (Büro + privat), Gasthaus Leuchtturm (Bewirtung); E2E
`app/dev/splitbuchung-e2e.sh`.

**14. Projekte auch für Ausgaben.** Projekte verbinden heute Kunde, Zeiten und Rechnungen
(`projects.ts`). Ausgaben und Belege dazu → Projektergebnis (Umsatz − Kosten). Zuordnen per Regel oder
Mehrfachauswahl. *Mit KI:* „alle Ausgaben für Projekt X" als Vorschlag.
**Umgesetzt:** Entschieden: die Zuordnung ist eine **Entscheidung an der Buchung** im Ledger (`booking_projects`, Schema
v23, im Entscheidungs-Log als `projekt.assign` / `projekt.exclude` / `projekt.clear`) wie `refund_links` und
`booking_splits` — die Projekte selbst bleiben im Manifest (`projects`), die Entscheidung verweist per Id darauf; im Manifest
würde jede Mehrfachauswahl `steuererklaerung.json` umschreiben. `part_no` 0 ist die ganze Buchung, n ≥ 1 der Teil n einer
Splitbuchung (Idee 13): ein Teil ohne eigene Entscheidung folgt der Buchung, mit Aufheben der Aufteilung verschwinden die
Teil-Entscheidungen. Ein Beleg mit verknüpfter Buchung folgt der Buchung (die Kosten kommen aus der EÜR-Zeile, die den Beleg
schon einrechnet); ein Beleg ohne Buchung wird **nicht** unmittelbar zugeordnet — Paperless hat dafür kein Feld, und eine
zweite Ablage nur fürs eingebaute DMS würde eine zweite Wahrheit. **Projektregel** (`elster.klassifizierung.projekt_regeln`:
`muster`, `projekt`, `ausnahmen`) in `core/elster/projekt-ergebnis.ts` — gleiche Form und gleiches Matching wie die
Buchungsregeln (Teilstring aus Gegenseite, Zweck, Referenz und Typ, erste Regel gewinnt, nur Ausgaben), Herkunft „via Regel
„…"". Eine Entscheidung gewinnt immer; „kein Projekt" (`projekt.exclude`) nimmt eine Ausgabe aus einer Regel heraus, ohne die
Regel anzufassen. **Projektergebnis** (rein, ausdrücklich eine interne Auswertung, keine Steuerzahl; Glossar
`projektergebnis`): *Umsatz* = Netto der ausgestellten Rechnungen (offen oder bezahlt, keine Entwürfe, Stornos und
stornierten), auf denen die Stunden des Projekts abgerechnet sind (`time_entries.invoice_id`; stehen mehrere Projekte auf einer
Rechnung, zählt der Stundenanteil), nach Ausstellungsdatum; *Kosten* = Netto der zugeordneten Ausgaben so, wie die EÜR sie
bucht, nach Buchungsdatum — private und andere neutrale Teile, Einnahmen und Erstattungen zählen nicht; *Ergebnis* = Umsatz −
Kosten; dazu die Stunden des Zeitraums und das Ergebnis je Stunde. Die Ansichten rechnen je Jahr, die reine Rechnung nimmt jeden
Zeitraum. Zuordnen: Mehrfachauswahl („Auswählen" → „Projekt zuordnen" in Buchungen) mit optionalem „Als Regel
merken" samt Vorschau der Treffer und Ausnahmen für abgewählte, am Buchungsdetail, per CLI; die Rückgängig-Schaltfläche der
Meldung und „Zuordnung zurücknehmen" sagen „Danach gilt: …". *Mit KI:* **nicht gebaut** — die Regel-Vorschau und die
MCP-Werkzeuge (`projekt_ergebnis` mit Vorschau, `projekt_zuordnen`) lassen einen externen Agenten dieselben Vorschläge machen,
die der Nutzer an derselben Stelle bestätigt; im Assistenten der App gibt es dafür keinen eigenen KI-Pfad, darum keine neue
Stelle in `check:ai`. Oberflächen: Projekt-Detail in der Ansicht Projekte (Ergebnis, Kosten mit Herkunft und „Zurücknehmen",
Rechnungen, Regeln), „Auswählen" + „Projekt zuordnen" und das Projekt je Zeile in Buchungen, Gruppe „Projekt" im
Buchungsdetail, CLI `projects result|assign|exclude|unassign|rules|rule`, MCP `projekt_ergebnis` / `projekt_zuordnen`, Glossar
`projektergebnis`. Demo: Projekt „Website-Relaunch Wattküste" (zwei Rechnungen, 16,5 Stunden, drei Ausgaben, eine per Regel);
E2E `app/dev/projekte-e2e.sh`, Bilder `docs/screenshots/projekt-auswahl.png` und `projekt-ergebnis.png`.

**15. Belege aus einem Mail-Ordner holen.** Für das eingebaute DMS: einen IMAP-Ordner beobachten,
Anhänge landen im Beleg-Eingang. Paperless kann das selbst (Mail-Regeln); dort nichts bauen.
**Umgesetzt:** Eingebautes DMS: `core/actions/mail-eingang.ts` holt über einen eigenen, schreibgeschützten IMAP-Client (`core/clients/imap/`, ~250 Zeilen über Gio-TLS-Sockets; `@curlew/imap` ist nicht veröffentlicht, imapflow & Co. brauchen Node-Streams) die neuen Nachrichten eines Ordners. Der Ordner wird mit `EXAMINE` geöffnet und Texte mit `BODY.PEEK` gelesen — nichts wird markiert, verschoben oder gelöscht, und es gibt keine Option dafür. Nur PDF und E-Rechnungs-XML gelten als Beleg (`mail-eingang/anhaenge.ts`; Inline-Bilder, Signaturen, Kalender und XML ohne Rechnung nicht). Der Import geht durch `storeReceipt`, also greifen E-Rechnung lesen (Idee 2) und Dokumentregeln (Idee 11) vor jeder KI; doppelte Dateien erkennt der Inhalts-Hash des DMS (SHA-256 = Beleg-ID), auch nach neuer Nummerierung. Herkunft am Beleg („aus Mail von Name, 12.05.2026“, `documents.origin`, Schema v24): nur Absender und Datum, nie Betreff oder Text. Fortsetzung je Entität in `mail_eingang_state` (UIDVALIDITY + höchste verarbeitete UID + einzeilige Zählung des letzten Laufs): ändert sich die UIDVALIDITY, gelten die gemerkten UIDs nicht mehr und der Ordner wird neu geprüft; ein Fehler beim Speichern lässt den Zeiger vor der Nachricht stehen. Postfach (`dms.mailEingang`: Server, Port, TLS, Benutzer, Ordner, Absenderfilter, „beim Start“) im Manifest, Passwort nur im Schlüsselbund (`secret-tool`, wie die ELSTER-PIN; ohne Schlüsselbund `STEUER_MAIL_EINGANG_PASSWORD`); ohne TLS nur zu `localhost`. Abruf auf Knopfdruck und optional einmal beim App-Start, kein Hintergrunddienst; höchstens 100 Nachrichten je Lauf. Mit Paperless wird nichts geholt, stattdessen der Hinweis auf Paperless’ Mail-Regeln. Oberflächen: Einstellungen „Belege aus Mail“ (Felder, Passwort, „Jetzt abrufen“, Ergebniszeile), Beleg-Eingang („N neue Belege aus Mail“, Zeile „Herkunft“), CLI `belege mail-konfig|mail-passwort|mail-abruf [--dry-run] [--json]`, MCP `belege_mail_status` (lesend) / `belege_mail_abrufen` (schreibend), Glossar `belege-aus-mail`, E2E `app/dev/belege-mail-e2e.sh` mit echtem IMAP-Stub, Bild `docs/screenshots/belege-mail-eingang.png`. Die Dateiauswahl der App nimmt jetzt auch `.xml` (E-Rechnung).

## 5. Verworfen oder eingefaltet — mit Grund

| Aus der ersten Fassung | Entscheidung | Grund |
|---|---|---|
| Eigene Korrekturen als neue Schicht (alte Idee 13, Stufe C) | eingefaltet in 6 | Gibt es schon: Bankdaten bleiben im Store unverändert, eine Umbuchung gewinnt, `removeClassificationDecision` nimmt sie zurück. Fehlt nur der Knopf und der Satz, was danach gilt. |
| Neue Ansicht „Prüfungen" | ersetzt durch 4 | Hinweise haben schon Schlüssel, Stufe, Titel, Text, Norm. Eine zweite Struktur wäre eine zweite Wahrheit. |
| Eigene „Aufgaben-Übersicht" | eingefaltet in 4 | „Als Nächstes" auf der Übersicht ist genau dieser Ort. |
| „Belege ohne Zuordnung" als eigene Liste | gestrichen | Das ist der Beleg-Eingang. |
| Eigene E-Mail-Adresse je Firma | ersetzt durch 14 | Braucht einen Mailserver; für eine Desktop-App unverhältnismäßig. |
| Fundstellen je Absender lernen („Rechnungsnummer steht hinter …") | gestrichen | Bricht bei jeder Layout-Änderung; E-Rechnung und Vorbelegung decken den Großteil ab, Scans macht die KI. |
| Reverse Charge „nur markieren, nie still rechnen" | korrigiert in 10 | Widersprach dem Code: § 13b wird bewusst eingeordnet und gerechnet. Der Hinweis fängt nur übersehene Fälle. |
| Privates im Betrieb über Wochenend-Muster | gestrichen | Für Selbstständige, die am Wochenende arbeiten, fast nur Fehlalarme. |
| Bewirtung und Geschenke gegen Betragsgrenzen | zurückgestellt | Ohne Angaben zu Anlass und Empfänger nicht prüfbar; wenn, dann als Pflichtangaben-Hinweis am Bewirtungsbeleg. |
| Pflichtangaben eigener Rechnungen prüfen | gestrichen | Die App erzeugt die Rechnungen selbst; die Angaben sind durch Bauart da. |
| Platzhalter für erwartete Erstattungen | gestrichen | Selten, und Idee 9 löst den häufigen Fall. |
| Steuerhinweise als Regelpakete je Rechtsform | nur merken | Passt zur Quellenpflicht, braucht aber erst eine Entscheidung über `references/`. |
| Vorjahresvergleich | nur merken | Billig, nicht dringend. |
| Abfragen bei Registern (Handelsregister, Insolvenzen, VIES) | nur merken | Nur ausdrücklich ausgelöst und mit Hinweis, welche Daten den Rechner verlassen. |
| CO₂, Fördermittel, Teamverwaltung | nicht übernehmen | Andere Zielgruppe. |

## 6. Offen

- **Splitbuchung (13)** — **geklärt 9.10.2026:** Aufteilung über der unveränderten Buchung; in eingereichten Zeiträumen
  nur nach Bestätigung, mit Hinweis auf die Berichtigung. **Geklärt 9.10.2026:** die Bewirtung steht in Zeile 63 der
  Anlage EÜR, 70 % in Kz 175 (abziehbar, E6004102), 30 % in Kz 165 (nicht abziehbar, E6004101, nicht in der Summe);
  ERiC prüft es mit den Demodaten (`app/dev/eric-demo-check.sh`). Quellen in `references/tax-sources.md`, „Bewirtung".
- **Lieferant doppelt bezahlt (7):** Wie wird die zweite Abbuchung verbucht (Forderung statt Ausgabe)? Die Kundenseite
  (Idee 5) ist geklärt und im Code vorhanden. **Stand 9.10.2026:** keine Primärquelle gefunden. § 4 Abs. 3/4 und § 11
  Abs. 2 EStG tragen beide Lesarten — Betriebsausgabe im Abflussjahr (Erstattung später Einnahme) oder neutraler
  Rückforderungsanspruch; sicher ist nur, dass die Vorsteuer je Rechnung einmal zusteht (§ 15 Abs. 1 Satz 1 Nr. 1 UStG).
  Quellen und Abrufdatum in `references/tax-sources.md`, „Geld-Prüfungen". Darum meldet der Hinweis nur und rechnet nichts
  heraus; eine Handlung „Ist eine Doppelzahlung an den Lieferanten" erst mit BFH-Urteil, EStH-Hinweis oder BMF-Schreiben.
  **Stand mit Idee 9:** Erstattet der Lieferant die zweite Zahlung, lässt sie sich jetzt verknüpfen — sie mindert dann
  dieselbe Kategorie samt Vorsteuer, sodass sich beide Lesarten im Jahr der Erstattung ausgleichen. Fällt die Erstattung
  in ein späteres Jahr, bleibt die Frage für das Jahr der Zahlung offen.
- **Erstattungen (9) in der Anlage EÜR:** **Entschieden 9.10.2026:** Minderung der Ausgabe bleibt. ERiC nimmt eine
  negative Zeile, wo das Schema ein Vorzeichen zulässt (übrige, Bewirtung abziehbar, Vorsteuer, …); die GWG-Zeile darf
  nicht negativ sein, ihr negativer Rest rückt nach „übrige", eine negative nicht abziehbare Bewirtung zählt 0 — der
  Gewinn bleibt gleich. Quellen und ERiC-Lauf in `references/tax-sources.md`, „Erstattungen".
- **USt-VA mit integriertem DMS:** gebaut 9.10.2026 aus den Buchungen (wie die USt-Jahreserklärung). § 13b und
  steuerfreie Umsätze rechnet dieser Weg noch nicht; dafür braucht es das Lieferland vom Beleg.
- **ERiC-Prüfung 2026 und 2024:** ERiC 43.4.6.0 kennt EÜR, GewSt, Feststellung und ESt für 2026 noch nicht; das
  bringt erst ein späteres ERiC-Release. Die Feststellung vor 2025 (Anlage FE 1) erzeugt die App nicht.
- **Eigene Ausgangsrechnungen als E-Rechnung:** Für Umsätze ab 2027 brauchen wir sie bei mehr als
  800.000 € Vorjahresumsatz, ab 2028 immer (inländisches B2B). Nachsehen, ob die App die XRechnung bei
  inländischen Geschäftskunden schon standardmäßig mitschickt oder ins PDF einbettet (ZUGFeRD).
- **Frei verfügbar (3):** Wie genau muss die Steuerrücklage sein? Vorschlag: dieselbe Schätzung wie die
  Steuer-Prognose, klar als Schätzung beschriftet. **Umgesetzt:** so gebaut (`core/elster/frei-verfuegbar.ts`).
- **Projekte für Ausgaben (14):** **Umgesetzt (Rechnung ↔ Projekt):** eine Rechnung trägt jetzt selbst ein Projekt
  (`invoice_projects`, Schema 25; Zeile „Projekt" im Formular und im Detail, CLI `--projekt`/`projekt`, MCP
  `invoices_project_get/_set`). Eine direkte Zuordnung zählt den ganzen Nettobetrag für genau dieses Projekt und hat
  Vorrang vor der Stunden-Verknüpfung — nichts wird doppelt gezählt. Hat der Kunde genau ein Projekt, wird es
  vorgeschlagen, nie stillschweigend gesetzt. „Zeiten übernehmen" macht aus offenen Stunden Positionen (Stundensatz
  wird abgefragt, keiner erfunden); die Stunden bleiben im Entwurf nur reserviert und gelten erst beim Festschreiben als
  abgerechnet. Offen: Zeiten→Entwurf nur beim eigenen Rechnungs-Backend (Qonto meldet einen Fehler), noch keine
  Web-Oberfläche. Offen bleibt außerdem: Erstattungen (Idee 9) mindern
  die Projektkosten noch nicht; ein Beleg ohne Buchung lässt sich nicht unmittelbar zuordnen (siehe oben); der nicht
  abziehbare Teil einer Bewirtung (neutral) zählt nicht als Projektkosten, obwohl das Geld ausgegeben ist. Eine Zuordnung je
  Teil einer Splitbuchung gibt es in CLI und MCP (`--part`, `teil`), in der App nur für die ganze Buchung.
- **Belege aus Mail (15):** Nur implizites TLS (Port 993); STARTTLS fehlt. Passwort-Anmeldung per `LOGIN` — OAuth-Postfächer (Gmail, Microsoft 365) gehen so nicht, dort bleibt Paperless oder ein App-Passwort. Der Abruf läuft auf Knopfdruck und beim Start, nicht im Hintergrund; die App liest nichts, was ihr nicht als Ordner genannt wurde. Mails ohne Anhang werden übersprungen, ein Link zur Rechnung im Mailtext nicht verfolgt. Der Schlüsselbund-Weg (`secret-tool`) ist nur von Hand geprüft; die E2E nutzt die Umgebungsvariable, weil eine private `dbus-run-session` keinen Schlüsselbund hat.
- **Rechtsangaben** (GWG-Grenze, Verjährung, Mahnzinsen): nur über
  `references/tax-sources.md`; keine Zahl im Code oder in der Oberfläche, die dort nicht mit Abrufdatum steht.
  **Stand 9.10.2026:** GWG-Grenze und Sammelposten stehen dort (Idee 10, ab Wirtschaftsjahr 2018); Verjährung und
  Verzug (§§ 195, 199, 203, 212, 286, 288 BGB) stehen dort seit Idee 12. **Mahnzinsen bleiben offen:** der Basiszinssatz
  (§ 247 BGB) ist nicht hinterlegt, darum nennt kein Entwurf einen Zinsbetrag.
