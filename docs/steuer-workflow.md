# Steuerlicher Workflow

Ablauf der steuerlichen Pflichten und Werkzeuge.

## Rollen im Setup

| Rolle | Womit |
|-------|------|
| **Bankkonto** | Qonto (API) · FinTS/HBCI · CAMT-Export für geschlossene Konten |
| **Belege / Dokumente** | Das eingebaute DMS oder Paperless-NGX, je Entität konfigurierbar |
| **Buchhaltung / EÜR / USt-VA** | Diese App (`elster euer report`, `elster ustva report`) |
| **ELSTER-XML + Plausi-Prüfung** | Diese App (`elster … generate-xml`, `validate-eric`) |
| **Abgabe** | Mein ELSTER — XML-Upload für die USt-VA, sonst das Web-Formular (siehe [prozesse/elster-web-formular.md](prozesse/elster-web-formular.md)) |

## Quartalsablauf (USt-VA)

1. **Belege von Qonto nach Paperless synchronisieren:**
   `gjsify run start sync match-qonto-paperless --auto`

2. **Rechnungsfelder per KI ergänzen:**
   `gjsify run start paperless extract-invoice-fields-incoming --auto`
   `gjsify run start paperless extract-invoice-fields-outgoing --auto`

3. **Duplikate bereinigen:**
   `gjsify run start paperless find-duplicates-incoming --auto`

4. **USt-VA-Report prüfen:**
   `gjsify run start elster ustva report --quarter=Q1 --year=2026`

5. **ELSTER-XML erzeugen:**
   `gjsify run start elster ustva generate-xml`

6. **XML in Mein ELSTER hochladen und abgeben.**

Fristen: siehe [fristen.md](fristen.md).

## EÜR / Belege ans Finanzamt

> **Tooling-gestützter EÜR-Ablauf** (inkl. geschlossener Konten via CAMT-Import, `reconcile` und
> `elster euer report`): siehe [prozesse/jahresabschluss.md](prozesse/jahresabschluss.md#tooling-gestützter-ablauf-steuererklaerung-cli).

### Was das Finanzamt erwartet

- **EÜR (Anlage EÜR)** elektronisch über ELSTER (Pflicht).
- **Belege** nicht zwingend mit Abgabe - bei Bedarf nachreichen.
- **Freiwillig:** ELSTER „Meine Belege" (elster.de) - Belege hochladen und mit Steuererklärung verknüpfen. Keine öffentliche API, Upload manuell. Ca. 100 MB Speicher.

### Optionen

| Ziel | Vorgehen |
|------|----------|
| Minimaler Aufwand | EÜR abgeben, Belege nur auf Anforderung nachreichen |
| Belege mit übermitteln | ELSTER „Meine Belege" nutzen (manueller Upload) |
| Belege aus Qonto gebündelt | CLI exportiert Belege, dann „Meine Belege" oder Nachreichung |

## Jahresabschluss

Siehe [prozesse/jahresabschluss.md](prozesse/jahresabschluss.md).
