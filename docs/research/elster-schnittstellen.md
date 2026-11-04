# ELSTER-Entwicklerschnittstellen für Steuererklärung (Open Source)

Stand: 2026-10-15. Status: **Entwurf, nicht committen**. Aussagen, die nur aus dem eingeloggten
Entwicklerbereich von elster.de stammen, tragen den Vermerk „(Entwicklerbereich)". Zuerst prüfen,
dann veröffentlichen.

Quellenkürzel:

- **LIZ** = `app/elster/ERiC-43.4.6.0-Dokumentation/ERiC-43.4.6.0/Dokumentation/lizenz.pdf` (Softwarehersteller-Lizenzvertrag, Paragrafen)
- **HB** = `…/ERiC-Entwicklerhandbuch.pdf` (Seitenzahl „Seite x von 508")
- **RN** = `…/ERiC-Releasenotes.pdf`
- **LM** = `…/Liesmich.txt`
- **EB-ERiC** = https://www.elster.de/elsterweb/entwickler/infoseite/eric (Entwicklerbereich)
- **EB-SB** = https://www.elster.de/elsterweb/entwickler/infoseite/schnittstellenbeschreibungen (Entwicklerbereich)

## Kurzfassung

1. **Die Repo-Annahme „ERiC ist nicht weiterverteilbar" ist falsch.** LIZ § 4 (1) erlaubt dem
   registrierten Hersteller ausdrücklich, ERiC „zusammen mit der eigenen Software als
   einheitliches Produkt direkt oder indirekt zu verbreiten, zu vermieten und öffentlich
   zugänglich zu machen". Verboten sind nur die Übertragung des Nutzungsrechts und die
   Unterlizenzierung (§ 4 (3)). Das heißt: ERiC darf als Teil unseres Produkts mitwandern,
   aber nicht als eigenständiges Paket oder mit Rechten für Dritte.
2. Eine Pflicht zu Closed Source oder ein Open-Source-Verbot steht nicht im Vertrag. Die
   AGPL-Lizenz unserer eigenen Teile bleibt möglich. ERiC selbst bleibt proprietär und
   darf nicht unter AGPL gestellt werden (§ 4 (3)).
3. Es gibt **keine öffentliche Download-URL** für ERiC. Der Download setzt Hersteller-Login
   und Klick auf „Akzeptieren" voraus (LIZ § 2 (1), § 3 (2); EB-ERiC (Entwicklerbereich)).
4. Die Hersteller-ID ist **produktbezogen** (HB S. 177). Eine ID für „Steuererklärung" kann
   für alle Nutzer dieses Produkts gelten. Nutzer brauchen keine eigene.

## A. Schnittstellen

Alle Schnittstellen laufen über ERiC (Verfahren und Datenarten im HB Kap. 2.x, Tabellen 2-14/2-15, S. 31–32)
oder über die offene XML-Schnittstelle „ElsterBasis-XML" (EB-SB (Entwicklerbereich)). Die
Schnittstellenbeschreibungen sind für alle Hersteller ohne zusätzliche Freigabe herunterladbar
(Entwicklerbereich).

| Schnittstelle | Zweck | Wer darf | Authentifizierung | ERiC? | Nutzen für uns |
|---|---|---|---|---|---|
| **VaSt** (Vorausgefüllte Steuererklärung) | Abruf von Belegen: Lohnsteuerbescheinigung, Rentenbezugsmitteilung, Basis-KV/PV, Riester, Rürup, Lohnersatzleistungen, Vermögensbildung, Stammdaten, Freistellungsauftrag, Zuschüsse § 10 (4b) EStG; die letzten 4 VZ (HB Kap. 9.9, S. 317) | Steuerpflichtiger für sich (DA = DI, Berechtigung wird automatisch aktiviert, HB 9.9.3.2, S. 327); Dritte (Steuerberater, Ehepartner) per Freischaltcode (HB 9.9.3.1) | Mein-ELSTER-Konto mit Zertifikat, das mit der IdNr registriert ist (HB 9.9.2, S. 326). Abrufcode ist seit ERiC 40 abgeschafft (HB 9.9.1.4, S. 319). ERiC kann das „vollelektronische" Freischalten nicht, nur das Ersatzverfahren (HB 9.9.1.6, S. 321) | ja, Datenarten SpezRecht*, ElsterVaStDaten (HB 9.9.1.2, 9.2.3) | **Hoch.** Deckt die Lohnsteuerbescheinigung ab (siehe nächste Zeile) und befüllt die Anlage N, Vorsorge usw. |
| **Lohnsteuerbescheinigung abrufen** | Es gibt keine eigene Abruf-Schnittstelle. Die Schnittstelle „Lohnsteuerbescheinigungen" (ElsterLohn, EB-SB (Entwicklerbereich)) dient dem **Arbeitgeber** zum Übermitteln; sie gilt bis VZ 2025, ab VZ 2026 gilt ElsterKMV/LSTMitteilung (HB 9.5, S. 308; HB 9.8; EB-SB (Entwicklerbereich)). Wir holen die Bescheinigung als VaSt-Beleg | Arbeitgeber (Übermitteln), Steuerpflichtiger (Abruf über VaSt) | siehe VaSt | ja | über VaSt, nicht über ElsterLohn |
| **ElsterDatenabholung** | Rücklieferdaten abholen: Bescheide, Verarbeitungsprotokolle, Änderungslisten. Ablauf: `PostfachAnfrage`, Download vom OTTER-Server, `PostfachBestaetigung` (HB 9.2, S. 284–288) | Teilnehmer mit Zertifikat; Bescheide zu den eigenen Erklärungen | send-Auth; für VaStDaten Organisationszertifikat mit Stick/Karte oder mit IdNr registriertes Zertifikat (HB Tab. 9-4, S. 287) | ja; die offene Variante gilt nur für Nutzer ohne ERiC (EB-SB (Entwicklerbereich)) | **Hoch** für alte Bescheide und Prüfung des Bescheids gegen die Erklärung. Version 32.0.1 gültig (EB-SB (Entwicklerbereich)) |
| **ElsterObjektspeicher** | Austausch großer Objekte, derzeit vor allem für den Download bei der Datenabholung (EB-SB (Entwicklerbereich)) | wie Datenabholung | OpenAPI-Beschreibung, Version 1.4.6 (EB-SB (Entwicklerbereich)) | indirekt | mittel, nur wenn die Abholung ihn braucht |
| **ElsterKontoabfrage** | Einsicht ins Steuerkonto (Salden). Konto muss freigeschaltet sein, vorab ist ein Antrag auf Einsichtnahme zu stellen, den der Kontoinhaber bestätigt (HB 9.4.1, S. 306) | Dritte mit Einwilligung des Kontoinhabers | `send-Auth` **nur mit Signaturkarte** (HB Tab. 9-11, S. 306–307) | ja | **Niedrig.** Signaturkarte schließt fast alle Privatnutzer aus |
| **RABE** (Belegreferenzen) | ELSTER ruft Belege aus einer vom Hersteller betriebenen externen Datenhaltung ab (HB 9.18; LIZ § 6) | Softwarehersteller mit eigenem Belegserver | Verwaltung in Mein ELSTER (EB-SB (Entwicklerbereich)) | ja (`RabeExtDatenhaltung*`) | **Nicht für eine reine Desktop-App.** Pflicht: Verfügbarkeit 24/7, Wartung nur werktags 18–06 Uhr, max. 4 h (LIZ § 6 (1)). Nur mit eigenem Server denkbar |
| **ELStAM / LAVENDEL** | Elektronische Lohnsteuerabzugsmerkmale | Arbeitgeber | Hersteller-Mock-System (EB-SB (Entwicklerbereich)) | teils | keiner |
| **ElsterBasis-XML** | Offene XML-Schnittstelle ohne ERiC, Schemata der Header (EB-SB (Entwicklerbereich)) | Hersteller | Hersteller-ID, Zertifikat | nein | siehe Fragen am Ende |
| **Test-Zertifikate** | Zertifikate der ELSTER-TestCA für Authentifizierung und Bescheidabholung; nur Fälle mit Testmerker (EB-SB (Entwicklerbereich)) | Hersteller | – | – | Entwicklung und CI |
| **VaSt-Informationen (Hersteller)** | Paket „Allgemeine Informationen zur VaSt", Stand 11.03.2013 (EB-SB (Entwicklerbereich)) | Hersteller | – | – | nur Hintergrund, älter als das Handbuch |

## B. Plattformen, Zyklus, Mindestversion

- **Pakete:** `Linux-x86_64`, `Windows-x86`, `Windows-x86_64`, `Darwin-universal` (macOS), außerdem AIX und Linux Power (HB Tab. 2-x, S. 36–37).
- **Linux:** nur Intel 64/AMD64, glibc ≥ 2.17 (HB 2.4.1, S. 21; 2.4.4.5). **Kein aarch64.** Gestützte Releases: Debian 11–13, Ubuntu 22.04/24.04, SLES 15/16, RHEL 8–10, jeweils bis Ende Standard-Support (HB Tab. 2-9, S. 26). Debian 13 neu in 43.4 (RN 8.2.5).
- **Windows:** x86 und x86_64, **kein ARM**. Windows 10 bis mindestens 13.10.2026; Windows 11 24H2/25H2 bis 2027 bzw. 2028 (HB Tab. 2-4 bis 2-6, S. 23–24; RN 8.2.5).
- **macOS:** Universal Binary (Intel 64 + ARM64); `lipo` kann eine Architektur herausschneiden. Unterstützt: 14, 15, 26 (HB 2.4.3 und Tab. 2-8, S. 22, 25). macOS 13 entfiel mit 43.4 (RN 5.2.2). Maximal drei macOS-Versionen je Release (HB 2.4.4.4).
- **Zyklus:** November-Release (Hauptrelease, Jahresfortschreibung), Mai-Release (technisch), Mindestversionserhöhung im April. Updates gibt es nur für die jeweils neueste Release-Version. Am 27.04.2026 ist die Mindestversion auf ERiC 43 gestiegen; ERiC 41/42 übermitteln seitdem nicht mehr (EB-ERiC (Entwicklerbereich); HB 5.4.2, S. 143; RN 3.1.4). Aktuell stehen ERiC 43 und 44 zum Download (EB-ERiC (Entwicklerbereich)).
- **Prüfung:** Die Annahmeserver prüfen die Version im Datensatz; zu alte Bibliotheken führen zur Zurückweisung (HB 5.4.2; HB Hinweis zur Softwareauslieferung, S. 70 ff.). Ankündigung der Erhöhung im Hersteller-Newsletter (HB 5.4.2).

**Folge:** Jedes Release unserer App braucht höchstens ein Jahr nach Erscheinen ein ERiC-Update. Ältere Pakete (Flatpak, deb, AppImage) übermitteln nach dem April-Termin nicht mehr.

## C. Bedingungen und Lizenz

Quelle ist LIZ (Vertragstext, in der lokalen Dokumentation mitgeliefert).

| Frage | Befund |
|---|---|
| Weitergabe mit der eigenen Software | **Erlaubt.** § 4 (1): ERiC integrieren und „zusammen mit der eigenen Software als einheitliches Produkt direkt oder indirekt … verbreiten, vermieten und öffentlich zugänglich machen", inklusive der dafür nötigen Vervielfältigung |
| Was verboten ist | § 4 (3): Übertragung des Nutzungsrechts an Dritte und Unterlizenzierung. Heißt: ERiC nicht getrennt weitergeben, nicht anderen Herstellern überlassen |
| Zweck | § 3 (2): ausschließlich für elektronische Abgabe von Steuererklärungen und Übermittlung von Steuerdaten |
| Hersteller-ID | produktbezogen; für jedes Steuersoftware-Produkt eine eigene (HB 6.5.3, S. 177). Gilt für Test- und Echtfälle; die frühere Test-ID 74931 ist nur noch Illustration (HB S. 178). Beantragung über „Anträge und Formulare" im Entwicklerbereich (HB 6.5.3) |
| Registrierung | Als Hersteller registrieren, Prüfung durch das BayLfSt, Zugang zum Entwicklerbereich (öffentliche Seite https://www.elster.de/elsterweb/infoseite/entwickler) |
| Updatepflicht | Hersteller prüft regelmäßig auf neue Versionen (§ 5 (4)); Pflicht zur Verwendung der „Mindestversion" (§ 5 (6)); neuere Versionen empfohlen, Risiko beim Hersteller |
| Tests/Freigabe | Keine Zertifizierung. Tests nicht freigegebener Updates nur einvernehmlich, Feldtest nur mit Einwilligung des LfSt; eigenmächtige Bereitstellung nicht freigegebener Updates unzulässig (§ 5 (7)) |
| Pflicht gegenüber Nutzern | Datenschutzschreiben (Anhang 2) anzeigen und Kenntnisnahme bestätigen lassen, vor der Übermittlung (§ 5 (1); EB-ERiC (Entwicklerbereich)); Datenschutzhinweis zur Betriebssystem-Telemetrie (§ 5 (2)); Hinweis auf lokale Protokolldateien (§ 15); Hinweis zur Datensicherung (§ 5 (8)) |
| Support | liegt beim Hersteller (§ 7 (1)); Kontakt des LfSt nicht weitergeben (§ 7 (3)) |
| Marke | Produktname darf „ELSTER" nicht enthalten (§ 12); ELSTER-Logo nur in der Dokumentation, weitere Nutzung nur per Sondervereinbarung (§ 4 (2)) |
| Sanktion | Sperrung der Hersteller-ID (§ 9) |
| Export | Hersteller trägt Verantwortung; ERiC nutzt Kryptografie (§ 13) |
| Open Source | Kein Verbot im Vertrag. Enthaltene Fremdkomponenten (zlib, OpenSSL u. a.) haben eigene Lizenzen (§ 4 (4), Anhang 1) |

**Bewertung der Repo-Annahme.** `packages/eric/README.md` stützt sich auf § 4 (3) („may not be passed to
third parties") und leitet ein Weitergabeverbot ab. Das trifft für **Nutzungsrechte und
Sublizenzen** zu, nicht für die Verbreitung als Teil des eigenen Produkts. § 4 (1) erlaubt sie
ausdrücklich. Die Regel „ERiC nie in git" (Rule 1) bleibt trotzdem sinnvoll: Das Quell-Repo ist
kein „einheitliches Produkt", und die Library würde dort getrennt von der App lagern. Die Regel
„Flatpak darf ERiC nicht enthalten" (Rule 3) ist vertraglich **nicht** nötig.

**Offen (Rechtsauslegung):** Ob ein Flathub-Build, der das ERiC-Binary in Flathubs Build-Infrastruktur
hochlädt, noch „eigene Software als einheitliches Produkt" ist, oder ob Flathub als Dritter gilt
(„indirekt verbreiten" spricht dafür, dass es zulässig ist). Das sollte das LfSt bestätigen.

## D. Auslieferung

1. **Im Paket mitliefern.** Rechtlich nach § 4 (1) gedeckt. Pro Plattform eine eigene ERiC-Bibliothek
   (Linux x86_64, Windows x86_64, macOS universal). Das Quell-Repo enthält weiterhin kein ERiC;
   die Release-Pipeline lädt es aus einem **privaten** Secret-Speicher. Nachteil: Der Release-Job
   braucht ein Login-Artefakt; nach jedem ERiC-Mindestversions-Sprung ist ein neues App-Release nötig.
   Flathub baut aus Quellen, deshalb passt eher ein eigenes Flatpak-Repo oder `extra-data`.
2. **Flatpak `extra-data` / Download beim ersten Start.** Eine öffentliche URL ohne Login ist
   nicht bekannt; der Download setzt Login und Lizenzklick voraus (EB-ERiC (Entwicklerbereich)).
   `extra-data` bräuchte eine stabile URL plus Prüfsumme. Dafür wäre ein **eigener Spiegel** der
   Binaries nötig, und dort greift § 4 (1) („öffentlich zugänglich machen") nur als Teil
   des Produkts. Mit der Lizenz ist das bestenfalls grenzwertig; vorab beim LfSt klären.
3. **Nutzer lädt selbst.** Bleibt immer erlaubt und ist die sicherste Variante, die bisherige
   Lösung der App. Nachteil: Der Nutzer muss sich als **Hersteller** registrieren, ein Zugang, der
   für Privatnutzer nicht vorgesehen ist (LM: „Software-Entwickler, die in der Steuersoftwarebranche
   tätig sind"). Die Nutzer sollten außerdem **keine eigene** Hersteller-ID brauchen; dafür gilt
   unsere (siehe unten).
4. **Eigener Server-Relay.** Technisch möglich, § 15 sieht den Betrieb von ERiC „auf einem Server des
   Softwareherstellers" ausdrücklich vor (Protokolle liegen dann dort; Hersteller trägt die DSGVO-Pflichten).
   Aber: Das Zertifikat samt PIN müsste zum Server, oder der Server signiert nicht selbst. Das
   widerspricht dem Ansatz „Daten bleiben lokal" und macht uns zum Verarbeiter von Steuerdaten
   (Art. 9 DSGVO), mit Verfügbarkeits-, Haftungs- und Betriebspflichten. Für ein Open-Source-Desktop-Projekt
   nicht empfehlenswert. Für RABE wäre ein Server ohnehin Pflicht (LIZ § 6).

**Hersteller-ID pro Nutzer?** Nein. Die ID gehört dem Produkt (HB 6.5.3); sie steht im XML-Element
`<HerstellerID>` (HB S. 177) und wird für Test und Echtfälle benutzt. Sie ist kein Geheimnis
im Sinne eines Passworts, aber der Missbrauch einer ID kann zu ihrer Sperrung führen (LIZ § 9).
Bei Open Source ist sie im Quelltext sichtbar; das Risiko ist bei jedem Fork-Betreiber, der
sie weiterbenutzt. Fork-Betreiber sollten eine **eigene** ID beantragen.

**Empfehlung.**

1. Die Dokumentation korrigieren: Mitlieferung ist erlaubt; `packages/eric/README.md`
   § 4 (3) richtig lesen.
2. Kurzfristig: Variante 3 beibehalten (Nutzer lädt selbst) **und** parallel Variante 1 für
   die Release-Builds (AppImage, deb/rpm, MSI, macOS-zip) vorbereiten.
3. Vor jedem Weitergabe-Release beim LfSt schriftlich (E-Mail) bestätigen lassen: Verbreitung in
   Flatpak/Flathub und Open-Source-Repo-Struktur, Verwendung einer Hersteller-ID in einem öffentlichen Quelltext.
4. Server-Relay nicht bauen.
5. Die Datenschutzhinweise aus LIZ § 5 und § 15 vor der ersten Übermittlung in der App anzeigen.

## Öffentliche Gegenprüfung

- **Erica/Steuerlotse (DigitalService):** MIT-lizenzierter Wrapper. ERiC wird **nicht** mitgeliefert; externe
  Nutzer laden die JAR selbst aus dem Entwicklerportal und kopieren die Bibliotheken ins Verzeichnis
  (https://github.com/digitalservicebund/erica, README). Das Projekt ist eingestellt.
- **eric-sdk (Rust):** liefert nur Bindings; die Bibliothek muss vorhanden sein (https://docs.rs/crate/eric-sdk/latest).
  `VENDOR_ID` ist eine Umgebungsvariable des Nutzers.
- Beide Projekte haben vermutlich nur deshalb nicht mitgeliefert, weil sie reine Wrapper ohne Endprodukt
  sind. Das ist kein Beleg gegen § 4 (1). Ein Open-Source-Desktop-Produkt mit mitgeliefertem
  ERiC habe ich nicht gefunden (nicht systematisch gesucht).

## Offene Fragen

1. Gilt § 4 (1) auch für Flathub/Flatpak-Spiegel und GitHub-Release-Assets? LfSt fragen.
2. Gibt es einen offiziellen Weg, ERiC-Binaries öffentlich zu hosten (für `extra-data`)? Aus der
   Dokumentation nicht erkennbar.
3. Darf eine Hersteller-ID im öffentlichen Quelltext stehen, oder gehört sie in die Release-Pipeline? Im Lizenztext
   (Release 43) nicht geregelt; § 14 verpflichtet nur allgemein zur Vertraulichkeit von Geschäftsgeheimnissen, § 9 erlaubt
   die Sperrung der ID. Vorsichtshalber nicht ins Repo, sondern in die Release-Pipeline. Verbindlich nur per Anfrage beim LfSt.
4. Kontoabfrage: Funktioniert sie auch mit Softwarezertifikat? Das HB sagt nur Signaturkarte; Schnittstellenbeschreibung nicht gelesen.
5. ElsterBasis-XML ohne ERiC: Wäre das eine Alternative für Linux aarch64 und Windows ARM? Schnittstellenpaket
   nicht heruntergeladen (nur lesen); Bedingungen unbekannt.
6. Entwicklerbereich gelesen (Stand 2026-10-15, Entwicklerbereich): Es gibt keine eigene Seite „Nutzungsbedingungen" oder
   „Hersteller-ID-Bedingungen". Maßgeblich ist allein der Lizenzvertrag. „Anträge und Formulare" enthält nur Formulare:
   Hersteller-ID, Newsletter, Aufnahme in die Softwareliste, ELStAM-Testsystem, RSS-Feed der Serververfügbarkeit. Zum
   App-Store-Vertrieb und zur Geheimhaltung der Hersteller-ID steht dort nichts; beides bleibt eine Anfrage ans LfSt.
   Das Formular (Entwicklerbereich) sagt: Die Hersteller-ID ist **produktbezogen**, pro Produkt eine eigene ID; Pflichtangaben
   sind Produktname, Herstellername und -adresse, Ansprechpartner, Schnittstelle (ERiC/Sonstige). Registrierung im
   Entwicklerbereich (Entwicklerbereich): kostenlos, kein Anspruch auf einen Account, Löschung erteilter Zugänge vorbehalten.
8. Lizenztext Release 44 (Entwicklerbereich, Webfassung) gegen Release 43 (lokales `lizenz.pdf`) Paragraph für Paragraph
   verglichen: § 1–18 inhaltlich gleich, ebenso das `lizenz.pdf` im Dokupaket 44.3.6.0 (Unterschied nur eine Jahreszahl im
   Anhang). Einziger Unterschied: In der Webfassung 44 verweist § 7 (2) auf „§ 14 Abs. 2", in 43 auf „§ 15 Abs. 2"
   (ein Verweisfehler; gemeint ist § 15). Keine Kosten, kein Weitergabeverbot, kein Open-Source-Verbot, keine
   erweiterte Herstellerhaftung. Wesentliche Punkte: § 2 unentgeltlich; § 4 (1) Verbreitung „direkt oder indirekt" als
   einheitliches Produkt; § 4 (3) keine Übertragung/Unterlizenzierung; § 5 DSGVO-Schreiben mit bestätigter Kenntnisnahme
   vor Nutzung, Datenschutzhinweis, Mindestversion, Updates prüfen, Feldtests nur mit Einwilligung; § 7 Support nur durch
   Hersteller, LfSt-Kontaktdaten nicht weitergeben; § 9 Sperrung der Hersteller-ID; § 12 Produktname ohne „ELSTER";
   § 13 Exportkontrolle; § 14 Vertraulichkeit; § 15 Protokolldateien; § 18 Haftungsausschluss Postfach (§ 18 steht in
   beiden Fassungen). Die Webfassung 44 listet im Anhang 1 mehr Open-Source-Komponenten als eingeplant (u. a. curl); Anhang
   nicht Zeile für Zeile verglichen.
   Zugestimmt: Release 44, am 2026-10-15 durch Pascals eingeloggte Sitzung (Entwicklerbereich).
9. Heruntergeladen (Entwicklerbereich), nach `app/elster/downloads/` (gitignored): `ERiC-44.3.6.0-Windows-x86_64.jar`
   (523 MB), `-Darwin-universal.jar` (844 MB), `-Linux-x86_64.jar` (521 MB), `ERiC-44.3.6.0-Dokumentation.zip` (123 MB).
   Jede JAR ist signiert (META-INF/MANIFEST.MF, CERT.SF, CERT.RSA). Windows: `dll/ericapi.dll`, `dll/otto.dll`; macOS:
   `lib/libericapi.dylib`, `lib/libotto.dylib`; Linux: `lib/libericapi.so`, `lib/libotto.so`. Plattformordner
   `ERiC-44.3.6.0/<Plattform>/` mit `include`, `lib`, `Beispiel`. Die JARs sind riesig (zig Plugin-Bibliotheken je
   Steuerart und Jahr); für ein Produkt sind nur die benötigten Plugins mitzuliefern (Handbuch prüfen).
10. beifahrer: `page_download` lehnt Links auf `download.elster.de` ab (andere Origin als das Tab). Funktioniert hat nur
   `page_navigate` auf die Download-URL, der Firefox-Download landet dann in `~/Downloads`. Anklicken der Links löste
   verzögert Downloads aus, teils mehrfach (bitgleiche Duplikate `(1)`, `(2)`). Kein Fortschritt/Ergebnis im Tool.
7. VaSt-Teilnahme über ein Zertifikat, das nur als Datei vorliegt: Voraussetzung ist die Registrierung mit IdNr
   (HB 9.9.2); die Frage, wie Nutzer das für ihr eigenes Zertifikat erreichen, ist nicht untersucht.

## E. Datenabholung (Bescheide aus dem Postfach)

Quelle: ERiC-43-Handbuch Kap. 9.2/9.3 und Schnittstellenbeschreibung ElsterDatenabholung v32 (lokal); Gegenprobe
2026-10-15 mit dem Mein-ELSTER-Postfach (Bescheiddaten-Mitteilung als ZIP mit PDF).

- **Automatisch möglich: ja.** Ablauf: `PostfachAnfrage` (Metadaten und Objekt-IDs) → Download vom OTTER-Server mit der
  `otto`-Bibliothek → `PostfachBestaetigung`. Ein einzelnes Zertifikat-Handle gilt für alle Schritte.
- **Zertifikat:** Mein-ELSTER-Portalzertifikat (.pfx + PIN) oder vom ERiC clientseitig erzeugtes Zertifikat (dann zusätzlich
  signierter Fingerabdruck, `EricHoleZertifikatFingerabdruck`). Optional `Abholzertifikat` zum Umschlüsseln.
- **Datenarten:** Bescheide `DivaBescheidUSt|ESt|GewSt|KSt|FEIN|ErbSt|SchenkSt`, `DivaSonstigerVA`, `DivaSonstigeMitteilung`,
  Stundung/Erlass/AdV, außerdem `ESB`, `EPBescheid|EPMitteilung` und weitere (Handbuch Tab. 9-5). Anhänge sind möglich
  (`application/pdf`, Metadaten Bescheiddatum, Steuernummer, Veranlagungsjahr). Es gibt also PDF **und** Metadaten, nicht nur XML.
  Bescheiddaten zu Erklärungen müssen beim Einreichen angefordert werden (`Rueckuebermittlung bescheid="ja"`, Kap. 7.4).
- **Nebenwirkungen:** Bestätigung **zwingend innerhalb 24 h**, sonst droht Sperrung des Herstellers (Handbuch 9.2.4.1).
  Bestätigte Daten werden bei ELSTER als abgeholt gekennzeichnet (mit Zeitstempel); eine sofortige neue Anfrage kann sie
  einige Minuten lang nochmals liefern. Löschung auf dem OTTER-Server nach 180 Tagen, DIVA-/Bescheidarten nach 4 Jahren.
- **Ungeklärt:** Ob die Nachricht im Mein-ELSTER-Postfach danach gelesen/entfernt wird. Die Dokumentation sagt es nicht;
  nur ein Test mit Hersteller-ID zeigt es. Der manuelle Download im Portal ändert den Status nicht sichtbar.
- **Voraussetzung:** Hersteller-ID (produktbezogen), ERiC mit `otto`, ein Zertifikat des Nutzers.
- **Beobachtung aus dem Portal:** Die Umsatzsteuer-Mitteilung ist ein Service-Hinweis ohne Beträge („keine detaillierten
  Bescheiddaten"); ein Bescheid ergeht nur bei Abweichung. Die Abholung liefert also nicht in jedem Fall Zahlen.
