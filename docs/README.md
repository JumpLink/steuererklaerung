# Dokumentation

Das Handbuch zur App: der steuerliche Ablauf, den sie unterstützt, die Prozesse rundherum und
die belegten Referenzen, gegen die ihre Zahlen geprüft werden.

**Kommandoreferenz** (alle CLI-Befehle, Konfiguration, Architektur): [`../app/README.md`](../app/README.md).
**Für Agenten**: [`../AGENTS.md`](../AGENTS.md).

> **Was hier NICHT steht.** Diese Doku ist bewusst frei von konkreten Zahlen, Steuernummern,
> Kontoverbindungen und Kundennamen. Alles Betriebsspezifische lebt in der gitignorierten
> `steuererklaerung.json` (Stammdaten, Steuernummern, Konten, wiederkehrende Rechnungen), im lokalen
> Ledger-Store und im DMS (Paperless-ngx bzw. das eingebaute DMS) — nie im Repo. Wenn du beim
> Schreiben eines Dokuments eine echte Zahl brauchst, gehört das Dokument nicht hierher.

## Ablauf & Fristen

| Dokument | Beschreibung |
|----------|-------------|
| [steuer-workflow.md](steuer-workflow.md) | Der Quartals- und Jahreszyklus: welche Kommandos in welcher Reihenfolge |
| [fristen.md](fristen.md) | USt-VA-Termine, Dauerfristverlängerung, Jahreserklärungen |

## Prozesse

| Dokument | Beschreibung |
|----------|-------------|
| [prozesse/jahresabschluss.md](prozesse/jahresabschluss.md) | Jahresabschluss & EÜR — Datengrundlage, Ablauf, Formular-Status je Erklärung |
| [prozesse/elster-web-formular.md](prozesse/elster-web-formular.md) | Ein Jahresformular in Mein ELSTER eintragen: Ablauf, Fallen, offene Tooling-Lücken |
| [prozesse/rechnungsstellung.md](prozesse/rechnungsstellung.md) | § 14 UStG — Pflichtangaben und Workflow für Ausgangsrechnungen |

## Referenzen

| Dokument | Beschreibung |
|----------|-------------|
| [references/tax-sources.md](references/tax-sources.md) | **Steuerrechtliche Konstanten je Veranlagungszeitraum — jede mit Quelle und Abrufdatum.** Die zentrale Registry, auf die der Code per Kommentar verweist |
| [references/elster-schemas.md](references/elster-schemas.md) | Formular → DatenArt / Nutzdaten-Root / Kennzahlen, verifiziert aus der lokalen ERiC-Distribution |
| [research/austria.md](research/austria.md) | Machbarkeit Österreich (Einzelunternehmer): E/A, UVA, E1/E1a, FinanzOnline-Webservices, Aufwandsschätzung |

## Architektur

| Dokument | Beschreibung |
|----------|-------------|
| [adr/README.md](adr/README.md) | Architekturentscheidungen (ADR): Format, Nummerierung, Status, Liste |
| [adr/0001-country-modules-and-per-entity-tax-switch.md](adr/0001-country-modules-and-per-entity-tax-switch.md) | Ländermodule und ein Schalter je Entität für die deutschen Steuerfunktionen |
| [architecture/country-inventory.md](architecture/country-inventory.md) | Jede Stelle im Code, die deutsches Steuerrecht annimmt — Grundlage von ADR 0001 |

## Oberflächen

| Dokument | Beschreibung |
|----------|-------------|
| [paperless-konfiguration.md](paperless-konfiguration.md) | Vorgeschlagenes Schema für Tags, Korrespondenten und Dokumenttypen in Paperless-NGX |
| [app/README.md](app/README.md) | Native GNOME-App — Bildschirm für Bildschirm, wofür jede Ansicht da ist (Screenshots aus der Demo-Entität, in [screenshots/](screenshots/)) |
| [app/backup.md](app/backup.md) | Sicherung (App, `steuer backup`, automatisch vor Migrationen): was hineinkommt, wo sie liegt, wie man von Hand wiederherstellt |
| [app/ki-und-mcp.md](app/ki-und-mcp.md) | Eingebauter KI-Assistent (pro Benutzer) und MCP-Server für externe Agenten (Manifest): zwei unabhängige Schalter und warum sie dort liegen |
| [app/i18n-status.md](app/i18n-status.md) | Übersetzung der Oberfläche (Englisch/Deutsch): übersetzte und offene Ansichten, Terminologie, was Deutsch bleibt |
| [ideen-nutzerfuehrung.md](ideen-nutzerfuehrung.md) | Ideenliste nach Priorität: einfacher bedienen, früher warnen, ohne KI nutzbar (Konzepte, keine Aufträge) |

## Warum die Quellenpflicht

Diese App ersetzt keinen Steuerberater, sie bereitet die Erklärung selbst auf. Damit ist jede
Zahl, die sie berechnet, nur so viel wert wie ihre Herleitung. Deshalb gilt: **keine
steuerrechtliche Konstante ohne Quelle, Abrufdatum und Veranlagungszeitraum** in
[references/tax-sources.md](references/tax-sources.md) — und viele davon ändern sich jährlich.
Verbindlich ist am Ende der Steuerbescheid; die Übermittlung validiert ERiC.
