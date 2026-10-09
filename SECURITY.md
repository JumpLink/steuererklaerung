# Sicherheit

*Security policy — to report a vulnerability, please use GitHub's private
"Report a vulnerability" button on the Security tab instead of opening a public issue.*

## Eine Schwachstelle melden

**Bitte kein öffentliches Issue.** Nutze auf GitHub den Reiter **Security → Report a
vulnerability** (private Meldung, nur für die Maintainer sichtbar). Falls der Kanal nicht
verfügbar ist, melde dich über das GitHub-Profil des Maintainers.

Hilfreich in der Meldung: betroffene Datei/Kommando, wie sich das Problem reproduzieren
lässt, und was ein Angreifer damit erreichen könnte. Eine Rückmeldung kommt, sobald es
geht — das hier ist ein Ein-Personen-Projekt ohne Bereitschaftsdienst, es gibt keine
zugesicherte Reaktionszeit und kein Bug-Bounty.

Als Schwachstelle gilt insbesondere: ein Weg, auf dem Zugangsdaten, Steuerdaten oder
Belege den Rechner verlassen, ohne dass es beabsichtigt ist; ein Datenleck über die
Web-Oberfläche oder den MCP-Server; oder ein Rechenfehler in der Steuerlogik, der
systematisch falsche Werte an ELSTER schickt.

## Wo deine Daten liegen — und wohin sie gehen

Das ist bei einem Steuerwerkzeug die wichtigere Hälfte dieser Datei. Die Aussagen unten
lassen sich am Code nachlesen; die Pfade stehen jeweils dabei.

### Alles bleibt lokal

Es gibt keinen Server dieses Projekts. Sämtliche Daten liegen als Dateien neben der
Anwendung und werden nirgendwo hin repliziert:

| Was | Wo |
|---|---|
| Stammdaten, Steuernummern, Konten, Entitäten | `app/steuererklaerung.json` (gitignoriert) |
| Bankbuchungen | `app/transactions-data/*.ndjson` + `app/ledger.db` (SQLite) |
| Belege des eingebauten DMS | `app/transactions-data/documents/` |
| Erzeugtes ELSTER-XML, Prüf-PDF, ERiC-Runtime | `app/elster/` (gitignoriert) |
| Zugangsdaten | `app/.env` (gitignoriert) |
| ELSTER-Zertifikats-PIN, falls gespeichert | GNOME-Schlüsselbund über libsecret, nie im Klartext in einer Datei — `app/src/frontends/desktop/data/elster-secret.ts` |

Die `.gitignore` im Wurzelverzeichnis und in `app/` sperren diese Pfade ausdrücklich,
inklusive der Datei-Namen aus der Zeit vor der Umbenennung.

### Ausgehende Verbindungen — nur zu dem, was du selbst einrichtest

Im gesamten Quellcode stehen genau drei fest verdrahtete Hosts:

- `thirdparty.qonto.com` — die Qonto-Bank-API (nur wenn du Qonto-Zugangsdaten hinterlegst;
  über `QONTO_BASE_URL` änderbar)
- `www.bundesfinanzministerium.de` — die amtlichen USt-Umrechnungskurse, ausschließlich
  beim expliziten Kommando `bmf-kurse import`
- `api.scaleway.ai` — der alternative LLM-Anbieter, nur bei `LLM_PROVIDER=scaleway`

Alles Weitere ist deine eigene Konfiguration: die Paperless-ngx-Instanz
(`PAPERLESS_BASE_URL`), deine Bank über FinTS/HBCI, INWX für Domain-Rechnungen — und
ELSTER, wenn du validierst oder übermittelst. Die restlichen `http(s)://`-Vorkommen im
Code sind XML-Namensraum-Bezeichner (FinTS, ELSTER), über die nie eine Verbindung
aufgebaut wird.

### Keine Telemetrie

Es gibt keine Analytics-, Crash- oder Nutzungsdaten-Erfassung. Kein Sentry, kein
Analytics-SDK, kein Phone-Home, kein Update-Check. Was `LLMTelemetry` heißt
(`app/src/core/clients/llm/types.ts`), zählt Tokens und Kosten der eigenen KI-Aufrufe
lokal mit und wird nirgendwohin gesendet.

### KI-Funktionen sind optional und eng geschnitten

Ein LLM wird nur aufgerufen, wenn du eine KI-Funktion benutzt — Rechnungsfelder aus dem
OCR-Text ziehen, Dokumente klassifizieren, Metadaten prüfen, oder den Assistenten fragen.
Der Assistent bekommt **nur aggregierte Kennzahlen**, keine IBANs, keine Steuernummern,
keine Dokumentinhalte; der Kontext wird in `app/src/core/actions/assistant/chat.ts`
zusammengebaut und ist dort vollständig nachlesbar. Anbieter und Modell wählst du über
`LLM_PROVIDER` / `LLM_MODEL`.

### MCP-Server: standardmäßig nur lesend

Der MCP-Server ist der Weg, auf dem ein externer KI-Assistent an die Daten kommt. Er ist
in den Einstellungen abschaltbar, pro Werkzeuggruppe freigebbar, und **schreibende
Werkzeuge sind hinter `mcp.allowWrite` gesperrt**, das standardmäßig aus ist. Er lauscht
auf stdio; im HTTP-Modus auf einer lokalen Adresse. Die Web-Oberfläche bindet sich
ebenfalls per Voreinstellung an `127.0.0.1` — sie hat keine Authentifizierung und gehört
nicht ins offene Netz.

### ELSTER und ERiC

Die Übermittlung geht an die Finanzverwaltung — das ist der Zweck. ERiC überträgt dabei
laut Lizenzvertrag zusätzlich Angaben über das Betriebssystem und legt lokale
Protokolldateien an; wer die Anwendung weitergibt, muss die Hinweise aus § 5 des
ERiC-Vertrags zeigen (siehe
[`app/docs/eric-license-considerations.md`](app/docs/eric-license-considerations.md)).
Vor dem Echtversand steht ein Testversand, eine Freigabe und ein unveränderlicher
Snapshot.

## Für Mitwirkende: was nie ins Repository darf

Zugangsdaten, echte Steuernummern, IBANs, Kundennamen, Beträge aus echten Buchungen,
Screenshots vom eigenen Datenbestand — und die ERiC-Bibliothek selbst, die nicht
weitergegeben werden darf. Alle Screenshots in diesem Repo stammen aus der erfundenen
Demo-Entität unter `app/demo/`. Committete Historie ist für immer; im Zweifel nicht
committen. Details in [`AGENTS.md`](AGENTS.md).
