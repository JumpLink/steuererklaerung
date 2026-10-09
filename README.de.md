# Steuererklärung

*[English version](README.md)*

Eine native GNOME-Anwendung, die Einnahmenüberschussrechnung, Umsatzsteuer-Voranmeldung
und Einkommensteuer aus den eigenen Bankbuchungen und Belegen rechnet — und die fertige
Erklärung über **ERiC** an ELSTER übermittelt.

Sie existiert, weil es für Linux keine ernstzunehmende Steuersoftware gibt. Das amtliche
**ElsterFormular** war reine Windows-Software und wurde eingestellt — ab dem
Veranlagungszeitraum 2020 nicht mehr zugelassen. Was bleibt, ist das Browser-Portal
*Mein ELSTER*: Zahlen von Hand abtippen, ohne Buchhaltung darunter. Das hier ist der
Versuch, den Weg von der Bankbuchung bis zum Transferticket auf dem eigenen Rechner
zusammenhängend zu machen.

![Übersicht](docs/screenshots/01-uebersicht.png)

| | |
|---|---|
| ![Steuererklärung](docs/screenshots/09-steuererklaerung.png) | ![Anlage EÜR](docs/screenshots/10-euer.png) |
| ![Beleg-Eingang](docs/screenshots/02-beleg-eingang.png) | ![Auswertungen](docs/screenshots/08-auswertungen.png) |

Alle Bilder stammen aus der mitgelieferten Demo-Entität — erfundene Firma, erfundene
Zahlen. Der [Bildschirm-für-Bildschirm-Rundgang](docs/app/README.md) zeigt jede Ansicht.

## Was es kann

**Vier Oberflächen auf demselben Kern.** Die Rechenlogik liegt in gemeinsamen Aktionen;
CLI, App, Web-UI und MCP-Server sind dünne Adapter darüber.

- **Native App** (GTK 4 + libadwaita) — Übersicht, Beleg-Eingang, Buchungen, Rechnungen,
  Zeiten, Kontakte, Auswertungen, Steuer, Konten, Einstellungen.
- **CLI** — 23 Kommandogruppen; die meisten Lese-Kommandos geben JSON aus. Das ist die
  Oberfläche, über die alles zuerst funktioniert — auch die Abgabe.
- **Web-UI** (`steuer web`, lokal auf 127.0.0.1) — dieselben Ansichten im Browser.
- **MCP-Server** (`steuer mcp`) — damit ein KI-Assistent Belege sucht, prüft und
  verschlagwortet. Standardmäßig **nur lesend**; schreibende Werkzeuge sind ein Schalter
  in den Einstellungen.

**Steuer.** Anlage EÜR (§ 4 Abs. 3 EStG, transaktionsgetrieben) · Umsatzsteuer-Voranmeldung
und -Jahreserklärung · Gewerbesteuer (GewSt 1 A) · gesonderte und einheitliche Feststellung
für Personengesellschaften · private Einkommensteuer (§ 19, Werbungskosten, § 35a, § 24b,
Kinderbetreuung, Lohnersatz). Dazu Anlageverzeichnis mit linearer AfA, Privatanteile,
Betriebsaufgabe (§ 16/§ 34), Reverse-Charge (§ 13b) und Querprüfungen zwischen den
Formularen.

**Belege und Dokumente.** Ein eingebautes DMS oder **Paperless-ngx**, pro Entität wählbar.
Belege werden mit Buchungen verknüpft, fehlende Belege für gezogene Vorsteuer werden als
Arbeitsliste ausgewiesen. Rechnungsfelder zieht wahlweise ein LLM aus dem OCR-Text; jede
KI-Entscheidung schreibt ihre Begründung in ein Feld am Dokument zurück.

**Bank und Buchungen.** Qonto-API · FinTS/HBCI · CAMT.052/053-Dateien jeder Bank ·
PayPal- und Amazon-Exporte zur Anreicherung. Alles landet in einem lokalen Store
(NDJSON + SQLite), aus dem die EÜR gerechnet wird.

**Rechnungsstellung.** Ausgangsrechnungen entweder über Qonto oder komplett selbst:
Entwurf → Festschreiben → PDF nach DIN 5008 mit SEPA-GiroCode → XRechnung-XML → Storno.
Dazu wiederkehrende Rechnungen mit Fälligkeits-Erinnerungen.

**Abgabe.** Prüf-PDF und ERiC-XML je Formular, ERiC-Validierung, unveränderliche
Filing-Snapshots, fingerprint-gebundene Freigabe als Abgabe-Gate, Testversand vor
Echtversand, GoBD-Festschreibung des Jahres.

Die vollständige Kommandoreferenz steht in [`app/README.md`](app/README.md).

## Voraussetzungen

Ein aktuelles Linux mit GNOME-Bibliotheken — nichts davon wird mitgeliefert, alles kommt
aus der Distribution:

- **gjs ≥ 1.86** (SpiderMonkey 140) — Fedora 43+, Ubuntu 25.10+
- **GTK 4** und **libadwaita** für die native App
- **libsoup3**, **json-glib**, **gnutls**, **libnghttp2** — der HTTP-Stack
- **libgda** + **libgda-sqlite** — der Buchungs-Store
- **pango** + **cairo** — der PDF-Pfad (Rechnungen, Prüf-Datenblätter)
- **blueprint-compiler** — nur zum Bauen der App-Oberfläche
- optional: **libsecret** (ELSTER-PIN im Schlüsselbund), **poppler-glib** (Beleg-Vorschau)

Auf Fedora:

```bash
sudo dnf install gjs gtk4 libadwaita libsoup3 json-glib gnutls libnghttp2 \
                 libgda libgda-sqlite pango cairo blueprint-compiler
```

## Installation

Die Toolchain ist [**gjsify**](https://github.com/gjsify/gjsify) — TypeScript wird
direkt für GJS gebaut und läuft dort. **Niemals `npm install`**: das Projekt ist ein
gjsify-Workspace, und npm entfernt die von gjsify verwalteten Abhängigkeiten wieder.

```bash
npm install -g @gjsify/cli   # einmalig: die Toolchain bootstrappen — der einzige npm-Aufruf
gjsify install               # Abhängigkeiten aus gjsify-lock.json (im Wurzelverzeichnis)
gjsify run build             # CLI, App und Web-UI bauen
```

Danach läuft alles über `gjsify run` — Kommandos mit Argumenten aus dem Verzeichnis `app/`:

```bash
cd app
gjsify run start --help        # die CLI
gjsify run start:app           # die native App
gjsify run start web           # die Web-UI auf http://127.0.0.1:3000
gjsify run start mcp           # der MCP-Server (stdio)
```

Die CLI nennt sich in ihrer eigenen Hilfe `steuer` — so ist sie unten und in
[`app/README.md`](app/README.md) auch geschrieben. Ein installiertes Kommando dieses Namens
gibt es noch nicht; bis dahin ist `gjsify run start` davor der Weg dorthin.

### Erst mal ausprobieren

Das Repo bringt eine vollständige, erfundene Beispielfirma mit — die *Fischer & Weber GbR*
samt zweiter Privat-Entität, Bankbuchungen, Belegen und Rechnungen. `--demo` (oder
`STEUER_DEMO=1`) schaltet jede Oberfläche darauf um, ohne echte Daten anzufassen:

```bash
cd app
gjsify run start --demo demo seed     # Demo-Daten erzeugen (idempotent)
STEUER_DEMO=1 gjsify run start:app    # die App auf den Demo-Daten
```

### Eigene Daten

Die gesamte Konfiguration liegt in **einer** Datei, `steuererklaerung.json` — Entitäten,
Steuernummern, Konten, Belegquellen, Rechnungs-Backend. Sie ist gitignoriert und verlässt
den Rechner nie. Als Vorlage dient
[`app/steuererklaerung.example.json`](app/steuererklaerung.example.json):

```bash
cp app/steuererklaerung.example.json app/steuererklaerung.json
cp app/.env.example app/.env          # Zugangsdaten für Bank, DMS, LLM
cd app && gjsify run start config validate
```

## ERiC — die Bibliothek musst du selbst besorgen

Übermittlung und amtliche Plausibilitätsprüfung laufen über **ERiC** (ELSTER Rich Client),
die native Bibliothek des Bayerischen Landesamts für Steuern.

> **ERiC ist nicht Teil dieses Projekts und darf nicht weitergegeben werden.**
> Der Softwarehersteller-Lizenzvertrag verbietet die Weitergabe an Dritte und die
> Unterlizenzierung (§ 4 Abs. 3). Ausgeliefert wird hier ausschließlich **unser eigener
> Wrapper** ([`packages/eric`](packages/eric/README.md)) — kein ERiC-Quellcode, keine
> Binaries, keine Schemata.

Jede Nutzerin und jeder Nutzer lädt ERiC selbst herunter (Entwickler-Registrierung im
[ELSTER-Entwicklerbereich](https://www.elster.de/eportal/infoseite/entwickler), Lizenz
selbst akzeptieren) und bringt es über `ERIC_HOME` mit:

```bash
export ERIC_HOME=/pfad/zur/eric/runtime          # enthält lib/libericapi.so
gjsify run -w @steuererklaerung/eric build:meson # unsere Bindung einmal kompilieren
export LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins:$LD_LIBRARY_PATH"
```

**Ohne ERiC funktioniert alles außer Validierung und Übermittlung** — rechnen, auswerten,
Belege verwalten, Rechnungen schreiben, XML und Prüf-PDF erzeugen. Der Loader bricht nicht
ab, sondern sagt, was fehlt. Das erzeugte XML lässt sich auch von Hand in *Mein ELSTER*
hochladen.

Zwei Dinge, die aus dem ERiC-Vertrag folgen und beim Verteilen gelten: ERiC-Versionen
laufen ab (veraltete lehnt das Finanzamt ab), und wer ERiC einsetzt, muss den Nutzern die
Datenschutz- und Protokolldatei-Hinweise aus § 5 des Vertrags zeigen. Details in
[`app/docs/eric-license-considerations.md`](app/docs/eric-license-considerations.md).

## Reifegrad — was das hier ist und was nicht

Das ist das Arbeitswerkzeug eines Einzelnen. Es ist entstanden, weil kein Steuerberater
mehr im Spiel ist und die Erklärungen trotzdem korrekt sein müssen. Daraus folgt die
Bauweise: **jede Zahl muss gegenprüfbar sein.** Steuerrechtliche Konstanten stehen
zentral mit Quelle, Abrufdatum und Veranlagungszeitraum in
[`docs/references/tax-sources.md`](docs/references/tax-sources.md), der Code verweist per
Kommentar dorthin. Jede Kennzahl lässt sich bis auf die einzelnen Buchungen aufklappen
(`steuer elster explain`). Die letzte vom Steuerberater erstellte Erklärung war die
Referenz, gegen die die Regeln geprüft wurden.

Daraus folgt aber auch, was es nicht ist: kein Produkt, keine getestete Abdeckung aller
Fälle, keine Garantie, dass dein Sachverhalt abgebildet ist. Gebaut und erprobt wurde es
an einer aufgelösten GbR, einem Einzelunternehmen und privaten Einkommensteuer-Fällen.
Alles andere ist ungetestetes Gebiet. Die native App ist als „Native Vorschau"
gekennzeichnet: lesen und prüfen funktioniert überall, schreiben nur an wenigen Stellen —
die Abgabe selbst läuft über die CLI.

### Transparenz: wie das entsteht

Das Projekt wird zu großen Teilen per Vibe-Coding entwickelt: Der Code entsteht mit
KI-Coding-Agenten, der Maintainer gibt die Richtung vor und prüft die Ergebnisse. Das
heißt nicht, dass jede Zeile von Hand geschrieben wurde.

Was die Zahlen absichert, ist nicht die Herkunft des Codes, sondern die Überprüfbarkeit:
Steuerrechtliche Konstanten stehen mit Quelle in
[`docs/references/tax-sources.md`](docs/references/tax-sources.md), und die erzeugten
Erklärungen werden gegen ELSTERs ERiC validiert. Trotzdem gilt: Das ist keine
Steuerberatung, es gibt keine Gewährleistung (siehe [AGPL](LICENSE)), und du prüfst deine
Erklärung selbst, bevor du sie abgibst.

### Haftungsausschluss

Diese Software ist **keine Steuerberatung** und ersetzt keine. Für die Richtigkeit der
berechneten Werte wird keine Gewähr übernommen. Wer eine Erklärung übermittelt,
verantwortet ihren Inhalt selbst — prüfe die Zahlen, bevor du sie abgibst.
Verbindlich ist allein die Prüfung durch ELSTER und der Bescheid des Finanzamts.

## Weiterlesen

- [`docs/`](docs/README.md) — der steuerliche Ablauf, Fristen, Prozesse und die belegten
  Referenzen, gegen die die Zahlen geprüft werden
- [`docs/app/README.md`](docs/app/README.md) — die App, Ansicht für Ansicht
- [`app/README.md`](app/README.md) — vollständige Kommandoreferenz und Konfiguration
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Mitarbeit (auf Englisch)
- [`AGENTS.md`](AGENTS.md) — die Arbeitsregeln im Repo, für Menschen wie für KI-Agenten

## Lizenz

[AGPL-3.0-or-later](LICENSE) © Pascal Garber.

Die App steht unter der AGPL. Die wiederverwendbaren Pakete unter `packages/*`
stehen unter der [LGPL-3.0-or-later](packages/eric/LICENSE); jedes Paket bringt
seinen eigenen Lizenztext mit.

Frei nutzbar, veränderbar und weitergebbar. Die AGPL fügt der GPL eine Bedingung
hinzu: wer dieses Programm **als Netzdienst anbietet**, muss den Nutzern dieses
Dienstes den Quelltext seiner Fassung zugänglich machen. Wer es lokal für sich
betreibt, hat dadurch keine zusätzliche Pflicht.

Der Wrapper in `packages/eric` ist eigener Code; **ERiC selbst wird nicht ausgeliefert**
(siehe oben). Abhängigkeiten mit abweichender Lizenz, die beim Bauen mit hineingezogen
werden: `lib-fints` (LGPL-2.1-or-later, FinTS-Anbindung), `xlsx` (Apache-2.0), die
Adwaita-Symbole (LGPL-3.0-or-later / CC-BY-SA-3.0) und Adwaita Sans (OFL-1.1) in der
Web-Oberfläche. Wer ein gebündeltes Artefakt weitergibt, muss deren Bedingungen erfüllen.
