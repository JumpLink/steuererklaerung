# steuererklaerung — CLI

CLI for a self-service accounting pipeline — Qonto, Paperless-NGX, FinTS and
ELSTER. TypeScript runs on **GJS via the gjsify toolchain** — gjsify ships build · run · tsc ·
format · lint · install, so no Node/ts-node is needed for the project itself.

## Setup

```bash
npm install -g @gjsify/cli   # one-time: bootstrap the gjsify toolchain (the only npm touch)
gjsify install               # from the repo root — installs deps from gjsify-lock.json, no npm
cp app/.env.example app/.env
```

Edit `app/.env` with your credentials (see `.env.example`). Day-to-day everything runs through
`gjsify run <script>` (e.g. `gjsify run check`, `gjsify run build:gjs`, `gjsify run test`) — see the
CI workflow for the full node-free flow.

## Config

All configuration lives in a single **`steuererklaerung.json`** (version 1 manifest, gitignored — it
holds real account keys + tax IDs). It folds the former split files (`sync-config.json`,
`fints-config.json`, `elster-config*.json`, `est-config*.json`, `recurring-invoices.json` and the
old entity registry) into one document: a top-level `version`, `app` (assistant + MCP), `paperless`
(the former sync-config payload) and `fints`, plus an `entities[]` array where each firm carries its
inline `elster` / `est` / `recurring` sections and its `dms` / `invoicing` back-ends. Secrets stay in
`.env` (FinTS PIN via `FINTS_PIN_*`, API keys); the BMF exchange rates stay in the separate
`bmf-umrechnungskurse.json`. The redacted template is **`steuererklaerung.example.json`** — copy it to
`steuererklaerung.json` and fill in your data.

Entity selection is `--entity <id>` everywhere (fail-loud with the known-id list; the first business
entity is used when omitted). `STEUER_WORKSPACE` can point at a manifest outside the current
directory; the former per-file env overrides (`SYNC_CONFIG`, `ELSTER_CONFIG`, `EST_CONFIG`,
`FINTS_CONFIG`, `BUCHHALTUNG_RECURRING`) and the `--config` / `--est-config` flags are gone.

**Where the files live.** Run from a directory that already holds a `steuererklaerung.json` (or a
pre-rename `buchhaltung.json`) and that file is used, exactly as before — the developer case, and
the case for every existing installation. Only when there is nothing to find does the app fall back
to the XDG locations, `~/.config/steuererklaerung/steuererklaerung.json` for the manifest and
`~/.local/share/steuererklaerung/transactions-data/` for the store, ledger and built-in DMS. That
fallback is what makes the installed app usable at all: launched from the GNOME overview its working
directory is `/` or `$HOME`, where the old lookup found nothing and reported "kein Manifest
gefunden". `STEUER_WORKSPACE` and `TRANSACTIONS_DATA_DIR` still override everything.

**Starting from nothing:** `config init --id <id> --name "<Name>"` writes the first manifest
(creating the directory if needed) and refuses to overwrite an existing one. Further entities with
`config add-entity`; `config rename-entity` and `config remove-entity` maintain the registry —
removal is guarded by the GoBD lock and un-lists the entity without deleting any of its data.

**First-time upgrade** from the old split files: run `config migrate` once — it assembles the v1
manifest, writes a timestamped `steuererklaerung.json.bak-<ts>` backup and **never deletes or modifies**
the source files.

**Coming from the old name.** The project was called `buchhaltung` before it was renamed to
`steuererklaerung`. If your workspace still holds a `buchhaltung.json`, it is READ unchanged: the
new name wins when both exist, otherwise the old file is used and the app prints one notice naming
both paths. Nothing is moved, copied or rewritten — writes go back into the same file it read, so
there is never a second, half-filled manifest. Adopt the new name whenever you like with
`mv buchhaltung.json steuererklaerung.json`; the way back is the reverse `mv`. The pre-rename
environment variables `BUCHHALTUNG_WORKSPACE` and `BH_DEMO` are honoured as well (the current names
are `STEUER_WORKSPACE` and `STEUER_DEMO`). Not affected by the rename, and therefore untouched: the
transaction store (`transactions-data/`), the SQLite ledger (`ledger.db`) and `.env` — none of them
ever carried the project name.

| Subcommand | Description |
|------------|-------------|
| `config init --id <id> --name <name> [--kind] [--accounts]` | Write the FIRST manifest with one entity. Refuses to overwrite an existing configuration. |
| `config add-entity --id <id> --name <name> [--kind] [--accounts]` | Add another entity to the manifest. |
| `config rename-entity <id> [--new-id] [--name] [--kind] [--accounts]` | Change an entity's id, display name, kind or account globs. |
| `config remove-entity <id>` | Un-list an entity (GoBD-guarded; transactions, receipts and filings are kept). |
| `config migrate [--dry-run]` | Assemble `steuererklaerung.json` v1 from the legacy config files (backup written, originals kept). `--dry-run` previews the merged manifest without writing anything. |
| `config validate` | Load + schema-validate the manifest, report problems. |
| `config show [--entity <id>]` | Print the resolved config with secrets redacted (one entity, or the whole manifest). |

## Commands

### check-apis

Test connectivity to all three APIs. Exit 0 if all OK, 1 otherwise.

```bash
gjsify run start check-apis
```

### qonto

Qonto API commands. Reads (org, bank-accounts, transactions, statements) plus clients and
outgoing client invoices (read + create). Environment is selected via `QONTO_ENV=production`
or `QONTO_ENV=staging`; set prefixed credentials in `.env` (see Credentials).

| Subcommand          | Description                    |
|---------------------|--------------------------------|
| `qonto org`         | Get organization               |
| `qonto bank-accounts` | List bank accounts          |
| `qonto bank-account <id>` | Get one bank account     |
| `qonto transactions [id]` | List transactions (positional id, or `--iban`, or env default bank account ID) |
| `qonto transaction <id>` | Get one transaction      |
| `qonto statements`   | List statements                |
| `qonto statement <id>` | Get one statement          |
| `qonto clients`     | List clients (customers for outgoing invoices) |
| `qonto invoices`    | List client invoices; optional `--status <draft\|unpaid\|paid\|…>` |
| `qonto invoice create <file>` | Create an outgoing invoice from a JSON spec file via the entity's invoicing back-end (Qonto by default); `--dry-run`, `--status draft\|unpaid`, `--iban <override>`, `--entity <id>` |
| `qonto invoice update <id> <file>` | Update a DRAFT invoice in place from a spec file (items fully replaced); `--dry-run`, `--iban` |
| `qonto invoice send <id>` | Email a finalized invoice: `--to`, `--subject`, `--message`/`--message-file`, `--no-cc`. **Preview by default — pass `--confirm` to actually send** |

Examples: `gjsify run start qonto org` · `gjsify run start qonto transactions` · `gjsify run start qonto invoices --status draft`

**Creating an invoice** (`qonto invoice create`): the spec is a JSON file with a `client` and an
`invoice` object. Creation routes through the entity's **pluggable invoicing back-end**
(`invoicing.type` in `steuererklaerung.json`, same switch as the recurring drafts and the DMS) — pick
it with `--entity <id>` (default: the workspace's Qonto config; `self` is in Vorbereitung). The
client is **found-or-created by name** (existing clients are reused); invoices default to
**`draft`** status (editable in Qonto, not sent) so a human reviews and sends.
With automatic numbering enabled, omit `number` — Qonto assigns the final `RE-YYYY-MM###` on
finalize (drafts carry a `…-PROFORMA` placeholder). VAT rate accepts percent (`19`) or decimal
(`0.19`); `due_date` is computed from `issue_date` + `payment_terms_days` (default 15) if omitted.
Keep spec files with amounts **out of git** (privacy boundary).

```jsonc
{
  "client": {
    "kind": "company",                 // company | individual | freelancer
    "name": "Example GmbH",
    "currency": "EUR", "locale": "de",
    "billing_address": { "street_address": "Musterweg 1", "city": "Musterstadt", "zip_code": "12345", "country_code": "DE" }
  },
  "invoice": {
    "issue_date": "2026-06-12", "payment_terms_days": 15, "currency": "EUR",
    "iban": "DE00…",                   // own IBAN the customer pays to (required)
    "performance_start_date": "2026-06-01", "performance_end_date": "2026-06-12",
    "header": "Sehr geehrte…", "footer": "Vielen Dank!",
    "items": [
      { "title": "Programmierung", "description": "Detail…\n• Punkt", "quantity": 3, "unit": "Stunden", "unit_price": 100, "vat_rate": 19 }
    ]
  }
}
```
Run `qonto invoice create spec.json --dry-run` first to print the resolved client + payload, then
without `--dry-run` to create the draft.

### invoices recurring — wiederkehrende Ausgangsrechnungen

Reminders for recurring outgoing invoices (e.g. the yearly hosting bills) plus one-click draft
creation. **Nothing is sent automatically** — the system reminds you and lets you create the
draft from the app; you review + send it (in Qonto). Qonto's own API cannot schedule recurring
invoices, so the schedule + reminder logic lives here; the *creation* back-end is pluggable per
entity (`invoicing.type` in `steuererklaerung.json`): `qonto` drafts via the client-invoices API,
`self` creates the invoice locally (own numbering + PDF + XRechnung — see `invoices self` below).

The schedules live in each entity's **`recurring`** section of `steuererklaerung.json` (gitignored — real
customers + amounts; see the redacted `steuererklaerung.example.json`). Each entry has a customer, line
items, an interval, the next service period + due date, and the last issued invoice (which advances
the schedule).

| Subcommand | Description |
|------------|-------------|
| `invoices recurring list` | All schedules with status (overdue · due-soon · upcoming). `--entity`, `--today`, `--json` |
| `invoices recurring due` | Only overdue + soon-due (the reminder view). `--lead <days>` overrides the per-schedule window |
| `invoices recurring create <id>` | Create a **draft** for one schedule via the entity back-end, then advance it. `--dry-run` prints the payload; `--no-advance` keeps the schedule unchanged |
| `invoices recurring ics [--out file]` | A subscribable `.ics` reminder feed (VEVENT + VALARM) — subscribe in GNOME Calendar / phone for active push notifications |
| `invoices recurring email <id>` | Print the mail draft for the schedule's last issued invoice (not sent) |
| `invoices recurring reconcile --entity <e>` | Pull `lastInvoice` of each schedule onto the back-end invoice (final number after finalizing; the replacement after a cancel). `--dry-run` writes nothing; also runs when the desktop app loads the Rechnungen tab |
| `invoices recurring set-project <id> --entity <e> --project <pid\|none>` | Attach a schedule to a project of the same customer (`none` detaches). `--dry-run` validates only |

Examples: `gjsify run start invoices recurring due` · `gjsify run start invoices recurring create musterkunde-example-com --dry-run`

### invoices self — eigene Ausgangsrechnungen (ohne Qonto)

For an entity with `invoicing.type: "self"`, invoices are created, numbered and archived locally
under German law: a **fortlaufende Rechnungsnummer** is assigned only at *finalize* (Festschreiben),
after which the invoice is immutable (GoBD) and corrections happen via a **Storno**. Finalize
renders a DIN-5008 PDF + an EN-16931 **XRechnung** (CII) and archives both content-addressed in the
entity's DMS. The §14 issuer identity (name, address, Steuernummer **or** USt-IdNr., optional
`kleinunternehmer`, bank details) lives in `invoicing.self.issuer` in `steuererklaerung.json` (see
`steuererklaerung.example.json`). All actions are also exposed as MCP tools (group `invoices`) and in the
web + native UIs.

| Subcommand | Description |
|------------|-------------|
| `invoices self caps` | Show the entity back-end + its capabilities. `--entity` |
| `invoices self list` | Issued invoices (newest first). `--entity`, `--status draft\|open\|paid\|cancelled` |
| `invoices self show <id>` | One invoice in detail |
| `invoices self create <spec.json>` | Create a **draft** from a JSON spec (`{ contactId?\|recipient?, issueDate, items[] }`) |
| `invoices self delete <id>` | Delete a **draft** (finalized invoices are corrected via a storno) |
| `invoices self finalize <id>` | Festschreiben: assign the number, freeze, render + archive PDF & XRechnung (**irreversible**) |
| `invoices self pdf <id> [--out file]` | Fetch the invoice PDF |
| `invoices self xml <id> [--out file]` | Fetch the XRechnung XML |
| `invoices self mark-paid <id> [--tx <id>] [--date YYYY-MM-DD]` | Mark an open invoice paid + link the settling transaction |
| `invoices self cancel <id> [--reason …]` | Cancel via a storno counter-invoice |
| `invoices self suggest-paid <id>` | Suggest the bank transaction that settled this invoice |
| `invoices self doppelzahlung` | List credits that look like a double / excess payment + open refunds |
| `invoices self doppelzahlung-entscheiden <tx>` | Decide one: `--ist-doppelzahlung`, `--in-ordnung`, `--andere-rechnung=<id>` `--rueckzahlung=<txId>` or `--rueckzahlung-extern=<YYYY-MM-DD>` |
| `invoices self forderungen` | Open outgoing invoices by age, per-customer payment behaviour (mean / worst / trend), Mahnstufe and presumed Verjährung; `--json` for raw output |
| `invoices self mahnung <id>` | Draft a reminder text (`--stufe 1-3`, default the next) — prints it, sends NOTHING. `--versandt --stufe N [--datum]` records that YOU sent that stage |

Example: `gjsify run start invoices self list --entity soleprop --status open`
· `gjsify run start invoices recurring ics --out reminders.ics`. The reminders + per-entity back-end
are also surfaced in the web UI under **Einstellungen → Rechnungsstellung**.

### invoices e-rechnung — eingehende E-Rechnungen lesen (ohne KI)

Reads an incoming **XRechnung** (CII or UBL XML) or a **ZUGFeRD/Factur-X** PDF (the XML attached to it is
extracted in plain TypeScript; the XML wins over the PDF text) and classifies it per §14 UStG as
*E-Rechnung* or *sonstige Rechnung* with a German reason line. The same reader fills the fields in the
Paperless extraction/import path and on upload to the built-in DMS — no AI call for an e-invoice. The MCP
tool `invoices_e_rechnung_lesen` is the read-only twin. Sources and guideline URNs:
`docs/references/tax-sources.md`, section „§14 UStG — E-Rechnung".

| Subcommand | Description |
|------------|-------------|
| `invoices e-rechnung lesen <file>` | Parse a `.xml` or `.pdf` file: seller/buyer, number, dates, lines, VAT per rate, totals, guideline ID, classification, warnings — as JSON |

Example: `gjsify run start invoices e-rechnung lesen rechnung.pdf | jq .classification`

### paperless

Paperless-NGX: read API, setup resources, enrich documents (invoice extraction), find duplicates. Requires `PAPERLESS_BASE_URL` and `PAPERLESS_API_TOKEN`. The `paperless` section of `steuererklaerung.json` (the former sync-config) is used by setup and by extract/duplicates; see **Paperless config** below.

| Subcommand | Description |
|------------|-------------|
| `paperless documents` | List documents (paginated; `--page-size`, `--page`, `--query`) |
| `paperless document <id>` | Get one document |
| `paperless document-types` | List document types (IDs for the `paperless` section) |
| `paperless document-type <id>` | Get one document type |
| `paperless correspondents` | List correspondents (paginated; `--page-size`, `--page`) |
| `paperless correspondent <id>` | Get one correspondent |
| `paperless tags` | List all tags (paginated; use IDs e.g. for tagging irrelevant documents) |
| `paperless tag <id>` | Get one tag |
| `paperless custom-fields` | List custom fields |
| `paperless custom-field <id>` | Get one custom field |
| `paperless task <taskId>` | Get consumption task status (UUID from upload) |
| `paperless setup-fields` | Create document types, custom fields, tags in Paperless when IDs are 0 in config; writes the IDs into the `paperless` section of `steuererklaerung.json`. Run once after first setup. |
| `paperless review-metadata` | Review metadata (title, correspondent, document type, created date) via LLM; for invoice-type documents also runs invoice field extraction. Options: `--force`, `--auto`, `--dry-run`, `--from`, `--to`, `--document-type-id`, `--document-type` (incoming_invoice \| outgoing_invoice), `--limit`, `--query`. Default: only documents without tag `ki-uberarbeitet`. |
| `paperless extract-invoice-fields-incoming` | Extract invoice fields from OCR via the configured LLM (default: Claude on your subscription; see `LLM_PROVIDER`/`LLM_MODEL`) for incoming invoices. Interactive by default; `--auto` for batch. Skips documents with tag `ki-uberarbeitet`. Optional: `--from`, `--to` (YYYY-MM-DD) to limit to documents whose invoice/booking date is in range; `--period` uses the date range from the entity's `elster` section (select the entity with `--entity`; e.g. only Q1 2026). |
| `paperless extract-invoice-fields-outgoing` | Same for outgoing invoices. |
| `paperless find-duplicates-incoming` | Find duplicate incoming invoices (Rechnungsnummer + Bruttobetrag + Rechnungsdatum), merge custom fields. Interactive by default; `--auto` for batch. `--dry-run`, `--delete-duplicates`. |
| `paperless find-duplicates-outgoing` | Same for outgoing invoices. |

Examples: `gjsify run start paperless documents --page-size=5` · `gjsify run start paperless correspondents` · `gjsify run start paperless setup-fields` · `gjsify run start paperless review-metadata --limit=10 --dry-run` · `gjsify run start paperless extract-invoice-fields-incoming --auto` · `gjsify run start paperless extract-invoice-fields-incoming --auto --period` (only documents in the entity's ELSTER period, e.g. Q1 2026)

Output for all read commands is JSON to stdout (exit 0 on success, 1 on error). Pipe to `jq` for filtering.

### sync

Synchronize data **between** services (e.g. Qonto ↔ Paperless).

| Subcommand | Description |
|------------|--------------|
| `sync match-qonto-paperless [bank-account-id]` | Match Qonto transactions with Paperless, import unmatched attachments, update matched. Interactive by default; `--auto` for batch. Options: `--iban`, `--settled-at-from`, `--settled-at-to`. |

#### Recommended flow (Belege zu Paperless → KI-Felder → Duplikate)

1. **Paperless vorbereiten** (einmalig):  
   `gjsify run start paperless setup-fields` – erstellt Document Types, Custom Fields und Tags in Paperless und schreibt die IDs in den `paperless`-Abschnitt von `steuererklaerung.json`.

2. **Belege von Qonto nach Paperless übertragen** (interaktiv oder automatisch):  
   `gjsify run start sync match-qonto-paperless --auto` – lädt nicht zugeordnete Anhänge in Paperless, setzt Dokumenttyp und verknüpft Qonto-Transaktionen.  
   **Doppelte Belege:** Wenn eine Qonto-Transaktion mehrere Anhänge mit gleichem Inhalt (unterschiedliche Dateinamen) hat, kann dasselbe Paperless-Dokument mehreren Transaktionen zugeordnet werden. Beim Verknüpfen prüft die CLI daher: Nur wenn der Transaktionsbetrag zum Rechnungsbetrag des Dokuments passt, wird die Qonto-Transaktion eingetragen – sonst wird übersprungen (Auto-Modus) bzw. gewarnt (interaktiv). So bleibt die richtige Zuordnung auch bei doppelten Belegen erhalten.

3. **Rechnungsfelder per KI ergänzen** (nur Dokumente ohne Tag „ki-uberarbeitet“):  
   `gjsify run start paperless extract-invoice-fields-incoming --auto` (optional: `extract-invoice-fields-outgoing --auto`).  
   Alternativ: `paperless review-metadata` – prüft Metadaten (Titel, Korrespondent, Dokumenttyp, Datum) für alle Dokumente und wendet bei Rechnungstypen automatisch die Rechnungs-Felder-Extraktion an. Mit `--from`, `--to`, `--limit` etc. einschränkbar.

4. **Duplikate finden und zusammenführen:**  
   `gjsify run start paperless find-duplicates-incoming` (interaktiv) bzw. `paperless find-duplicates-incoming --auto`; optional `--dry-run`, `--delete-duplicates`.

**Paperless config:** Paperless resources are configured in the **`paperless`** section of `steuererklaerung.json` (the former `sync-config.json`; redacted template in `steuererklaerung.example.json`). IDs may be 0; run `paperless setup-fields` to create the resources in Paperless and fill the IDs. Keys: `document_type_ids` (incoming_invoice, outgoing_invoice), `custom_field_ids` (qonto_*, invoice_*, invoice_currency for Rechnungswährung in ISO 4217), `tag_ids` (qonto_import, ai_reviewed, irrelevant, school, finance, server_infrastructure). Tag `irrelevant` = documents to review/remove; `school` = school-related; `finance` = finance-related; `server_infrastructure` = server-infrastructure-related. Optional: `own_correspondent_ids` (array of correspondent IDs that represent your own company; the AI uses this to avoid setting you as correspondent on invoices – for incoming invoices the correspondent is the sender, for outgoing the customer), `exclude_tag_ids` (tag IDs whose documents are out of business scope, e.g. the per-person "* Privat" tags — hidden from the DMS view), `preferred_language` (`"de"` or `"en"`, default `"de"`, for AI prompts in `review-metadata`).

### elster

ELSTER-Tools (z. B. USt-VA-XML für den Upload in Mein ELSTER). Konfiguration: der `elster`-Abschnitt der jeweiligen Entität in `steuererklaerung.json` (Vorlage: `steuererklaerung.example.json`); die Entität per `--entity <id>` wählen. Optional `ELSTER_TAX_NUMBER` in `.env`.

| Subcommand | Description |
|------------|-------------|
| `elster ustva report` | Listet die Paperless-Dokumente auf, die in die USt-VA für den konfigurierten Zeitraum eingeflossen sind (Ausgangsrechnungen mit qonto_settled_at, Eingangsrechnungen mit Datum im Zeitraum), inkl. Netto, USt, Vorsteuer pro Beleg. Nur Belege in EUR fließen in die Summen; Rechnungen in anderer Währung (z. B. USD) werden gelistet, aber nicht summiert. Prüft erforderliche Custom Fields und Qonto vs. Rechnungsbetrag (bei gleicher Währung); bei unterschiedlicher Währung (Rechnung vs. Qonto) wird die Betragsprüfung übersprungen und ausgewiesen. **Ein Beleg, mehrere Qonto-Transaktionen:** Wenn dieselbe Rechnung in Qonto an mehrere Transaktionen (z. B. Gebührenaufteilung) angehängt ist, speichert Paperless nur eine Transaktion pro Dokument – die Betragsprüfung kann dann „Mismatch“ anzeigen (Teilbetrag vs. Rechnungssumme); der Rechnungsbetrag für die USt-VA bleibt korrekt. Optionen: `--year`, `--quarter`, `--month`, `--json`, `--pdf [datei]` (Prüf-Datenblatt als PDF vor der Übermittlung). **Hinweis:** Qonto stellt pro Transaktion eigene Buchhaltungsdaten bereit; diese können künftig optional zum Abgleich genutzt werden. |
| `elster ustva generate-xml` | Aggregiert USt-VA-Daten aus Paperless, prüft erforderliche Felder und Qonto vs. Rechnungsbetrag: bei fehlenden Pflichtfeldern Abbruch; bei Abweichung nur Warnung, XML wird trotzdem erzeugt. Schreibt ELSTER-konforme XML, validiert sie (Namespace/Struktur). Optionen: `--entity`, `--year`, `--quarter`, `--month`, `--output`. |
| `elster ustva …` mit integriertem DMS | Hat die Entität `"dms": { "type": "builtin" }`, rechnen `report`, `generate-xml`, `validate-eric`, der Snapshot und die App-Ansicht die USt-VA aus den **Buchungen** (EÜR-Zeilen des Zeitraums nach Zahlungsdatum, mit verknüpften Erstattungen und Splitteilen) — dieselbe Grundlage wie die USt-Jahreserklärung. Ohne § 13b und steuerfreie Umsätze. ERiC-Prüfung aller Erklärungen aus den Demodaten: `app/dev/eric-demo-check.sh` (siehe `app/elster/README.md`). |
| `elster euer report` | **Anlage-EÜR-Jahresaggregat** auf **Cash-Basis** (Zufluss-/Abflussprinzip, §11 EStG): Einnahmen/Ausgaben netto je `accounting_category` (SKR03), Gewinn, USt-Zahllast, plus ein **Kennzahlen-Blatt** (Anlage-EÜR Zeile/Kz → Betrag) zum Eintragen in Mein ELSTER. **Zwei Modi** über `--by`: `documents` (Default) summiert die Paperless-Rechnungen (zählt nur Belege mit Zahldatum); **`transactions`** summiert **jede Bankbuchung** des Stores und kategorisiert sie aus dem verknüpften Beleg oder per Regel (intern/privat/Steuer/Bankgebühr) — der EUR-Betrag kommt aus der Buchung (löst Fremdwährung), und **unklassifizierte Buchungen werden als echte Lücken ausgewiesen** (= Vollständigkeits-Check). ⚠ Die Kz-Zuordnung ist Best-Effort — vor Abgabe prüfen. Optionen: `--year` (Pflicht), `--by documents\|transactions`, `--account-key` (mehrfach; Default für `transactions`: alle `camt:`-Konten), `--json`, `--pdf [datei]` (Prüf-Datenblatt als PDF; nur `--by transactions`). |

#### Absenden-Workflow (Snapshot → Freigabe → Übermittlung)

**Voraussetzungen für den Versand** (nicht für die lokale Validierung): eine **ELSTER-Zertifikatsdatei** (`.pfx`/`.p12` — dieselbe, mit der man sich bei Mein ELSTER anmeldet; Pfad in `keystore_path`, PIN separat) UND eine **eigene 5-stellige Hersteller-ID** (`hersteller_id`) + `datenlieferant`. Die Hersteller-ID ist im **Entwicklerbereich von elster.de** kostenlos zu beantragen — ohne sie (Platzhalter `00000`) lehnt der ELSTER-Server die Übermittlung ab (`610101297`, „DatenTeil konnte nicht gelesen werden"). Zertifikat und PIN werden nie im Klartext gespeichert; die native ERiC-Lib ist nutzerseitig (`ERIC_HOME`) und wird nie mitgeliefert.

Die eigentliche **Übermittlung an ELSTER** läuft über eine bewusst abgesicherte Kette (jeder Schritt hat ein eigenes Subcommand; Formulartyp `--form ustva\|euer\|uste\|gewst\|feststellung`):

1. **`elster crosscheck`** — Querprüfungen (ΣUSt-VA↔USt-Jahr, Steuerkonto↔USt, EÜR↔Feststellung, Vollständigkeit, USt-Verprobung). Muss sauber sein.
2. **`elster snapshot`** — friert eine **unveränderliche** Kopie der erzeugten ELSTER-XML + Kennzahlen + Querprüfungs-Befund + einen **Input-Fingerprint** ein. Ändern sich danach die zugrunde liegenden Daten, gilt der Snapshot als *veraltet* (`stale`) und muss neu erfasst werden.
3. **`elster signoff sign`** — die **ausdrückliche Freigabe**, an den Snapshot-Fingerprint gebunden; sie wird automatisch ungültig, sobald die Daten driften. `elster signoff status` zeigt das **Abgabe-Gate** (`unlocked` + Blocker).
4. **`elster submit`** — übermittelt den freigegebenen Snapshot **byte-identisch** via ERiC. **Standard: Test** (`<Testmerker>` → am Clearing-House verworfen). `--check` zeigt nur die Bereitschaftsleiter, ohne zu senden. Ein **Echt-Versand** (`--live --allow-live --keystore <pfx> --pin <PIN>`) verlangt zusätzlich: volles Freigabe-Gate, einen zuvor validierten (test-first) Snapshot, keinen bereits gesendeten Snapshot (kein Doppel-Versand) und eine verfügbare ERiC-Bibliothek. Die PIN wird nur für den Aufruf genutzt und **nie gespeichert**; die native ERiC-Lib ist nutzerseitig (`ERIC_HOME`) und wird nie mitgeliefert.

### fristen & filing

**`fristen`** — die „Was ist als Nächstes zu tun?"-Übersicht in drei Schichten: **Offene Posten**
(Paperless-Dokumente mit `payment_status=offen`), **Offene Steuerzahlungen** (eingereichte, aber
noch nicht überwiesene Beträge aus dem Einreichungs-Register, mit geschätzter Fälligkeit: USt-VA
= Regelfrist der Voranmeldung §18 Abs. 1 UStG; USt-Jahr = 1 Monat nach Eingang §18 Abs. 4 UStG;
GewSt/ESt = laut Bescheid; Wochenenden → Montag §108 Abs. 3 AO, Feiertage nicht modelliert) und
**Kommende Steuertermine** (Regelfristen aus den `elster`-/`est`-Configs, inkl. privater ESt).
Optionen: `--json`, `--ics <datei>` (Kalender-Export inkl. Zahlungs-Fristen).

**`filing`** — das Einreichungs-Register („erledigt"-Seite): welche Erklärung/Zahlung ist wann
eingereicht/bezahlt. Einmal erfasst, zeigen die Steuertermine ✓ statt zu mahnen.

| Subcommand | Description |
|------------|-------------|
| `filing record` | Einreichung/Zahlung erfassen oder merge-aktualisieren: `--entity --kind (ustva\|ust-jahr\|euer\|feststellung\|gewst\|est\|dauerfrist\|sonstige) --period` plus `--filed`, `--paid`, `--declared` (Anmeldungssoll, treibt Z119), `--amount` (tatsächlich gezahlt), `--surcharge` (Säumniszuschlag), `--note`. |
| `filing list` | Register auflisten (`--entity`, `--year`, `--json`); zugeordnete Dokumente werden mit angezeigt. |
| `filing attach-doc` | Ein DMS-Dokument einer Einreichung zuordnen — Bescheid/Antwortschreiben des Finanzamts oder Nachweis: `--doc paperless:<id>` + `--role bescheid\|mahnung\|uebertragungsprotokoll\|zahlungsbeleg\|schreiben\|sonstiges`. Verlangt einen vorhandenen Register-Eintrag. |
| `filing docs` / `filing detach-doc` | Zuordnungen auflisten / entfernen. |
| `filing remove` | Register-Eintrag löschen. |
| `elster filing record-web` | Eine in **Mein ELSTER** (Web-Formular) abgegebene Erklärung erfassen: frischer Snapshot, als `submitted` (`source=web-form`) markiert, mit **Transferticket** vom Übertragungsprotokoll + Register-Eintrag in einem Schritt. |

**`frei-verfuegbar`** — was vom Kontostand einer Entität nicht schon dem Finanzamt oder Lieferanten
gehört: Kontostand − USt seit der letzten Voranmeldung (ab dem Tag nach der letzten im Register
eingereichten USt-VA) − fällige Steuerzahlungen (aus dem Register: überfällig, ohne Datum oder in den
nächsten **30 Tagen** fällig — ein App-Fenster, keine gesetzliche Frist) − offene Eingangsrechnungen −
bestätigte **laufende Kosten**, deren nächste Zahlung in denselben 30 Tagen erwartet wird (die Herleitung nennt
die Zahl ohne sie, die erste Fassung). Daneben die **Steuerrücklage** des Jahres (dieselbe Schätzung wie die Steuer-Prognose: ESt + GewSt −
geleistete Vorauszahlungen; negativ = Erstattung). Jeder Posten druckt seine Herleitung; fehlende Daten
heißen „nicht berechenbar, weil …". Optionen: `--entity`, `--year`, `--today YYYY-MM-DD`, `--json`. MCP:
`frei_verfuegbar` (read-only); in der App die beiden Karten auf der Übersicht.

**`hinweise`** — die Hinweise eines Jahres: je Prüfung der Befund mit den betroffenen Buchungen/Rechnungen und
den Handlungen der App, „Geprüft, ohne Befund: …" oder „Nicht prüfbar, weil …". Dazu je Konto **Kontoauszug
lückenlos?** (Anfangssaldo + Umsätze = Endsaldo, fortlaufende Auszugsnummern, Monate ohne Umsätze).
`hinweise ok <key>` markiert den aktuellen Befund als in Ordnung (gespeichert mit Fingerabdruck — ein neuer
Befund erscheint wieder). Optionen: `--entity`, `--year`, `--today YYYY-MM-DD`, `--alle`, `--json`,
`--vor-abgabe` (nur, was vor USt-VA und Jahreserklärung zu klären ist: **USt-Abweichung**, **Buchungen ohne
USt-Angabe**, **§ 13b nicht erkannt?**, **Anlagegut?** und die Warnungen der Geld-Prüfungen). MCP:
`hinweise_list` (read-only, Parameter `vorAbgabe`), `hinweise_ok` (schreibend). Oberflächen-Tests:
`app/dev/hinweise-e2e.sh [shots-dir]`, `app/dev/vor-abgabe-e2e.sh [shots-dir]`.

**`buchungen zu-pruefen`** — die Buchungen „Zu prüfen": unklassifiziert oder nur von einer **Auffangregel**
erfasst (einer allgemeinen Regel, die nach dem Kategorie-Wort der Bank einordnet, nicht nach der
Gegenseite). Je Buchung Kategorie und die Regel, die gegriffen hat (`--json`: `matchedRule` mit stabiler
`id`). `buchungen bestaetigen <id>` merkt die aktuelle Kategorie als geprüft — die EÜR ändert sich nicht;
ändert sich die Kategorie später, ist die Buchung wieder zu prüfen. Optionen: `--entity`, `--year`, `--json`.
MCP: `buchungen_zu_pruefen` (read-only), `buchung_bestaetigen` (schreibend). In der App: Tab „Zu prüfen" im
Buchungen-Hub mit „Regel aus Auswahl". Oberflächen-Test: `app/dev/zu-pruefen-e2e.sh [shots-dir]`.

**`buchungen erstattungen`** — Zahlungseingänge, die eine frühere Abbuchung erstatten könnten (Rückgabe,
Teilerstattung, Rückbuchung): je Eingang die Kandidaten — frühere Ausgaben an dieselbe Gegenseite binnen 365
Tagen, deren noch nicht erstatteter Betrag reicht; gleicher Betrag zuerst, dann gemeinsame Rechnungs- oder
Bestellnummer. `buchungen erstattung <id> --ja <kandidat>` verknüpft: die Erstattung erbt Kategorie und
USt-Satz und mindert Ausgabe und Vorsteuer im Jahr und Voranmeldungszeitraum des Eingangs (Quellen:
`docs/references/tax-sources.md`, „Erstattungen"). `--nein <kandidat>` blendet den Kandidaten dauerhaft aus,
`--loesen` nimmt die Verknüpfung zurück. Optionen: `--entity`, `--year`, `--json`. MCP: `erstattungen_list`
(read-only), `erstattung_entscheiden` (schreibend). In der App: „Gehört das zu dieser Zahlung?" im
Buchungsdetail und in „Zu prüfen". Oberflächen-Test: `app/dev/erstattungen-e2e.sh [shots-dir]`.

**`buchungen aufteilen <id>`** — eine Buchung in Teile mit eigener Kategorie und eigenem USt-Satz aufteilen
(Splitbuchung): `--teil "4930=119,00@19" --teil "1800 Privatentnahme"` — ein Teil ohne Betrag nimmt den Rest, die
Summe ist auf den Cent die Buchung; `--bewirtung` nimmt die Vorlage 70 % Bewirtungskosten / 30 % nicht abziehbar
(Vorsteuer voll), `--aufheben` hebt die Aufteilung auf und sagt, was danach gilt. Ohne Option zeigt es die Aufteilung.
Liegt die Buchung in einem schon eingereichten Zeitraum, ändert sich nichts ohne `--trotz-abgabe` (dann ist eine
berichtigte Erklärung nötig). `buchungen aufteilungen` listet die aufgeteilten Buchungen. Optionen: `--entity`,
`--year`, `--json`. MCP: `aufteilungen_list` (read-only), `buchung_aufteilen` (schreibend). In der App: „Aufteilen"
im Buchungsdetail. Quellen: `docs/references/tax-sources.md`, „Splitbuchung". Oberflächen-Test:
`app/dev/splitbuchung-e2e.sh [shots-dir]`.

**`laufende-kosten`** — Abbuchungen im festen Abstand (Miete, Software, Versicherung), erkannt über alle
Buchungen einer Entität: derselbe Empfänger (Name normalisiert), monatlich, viertel-, halbjährlich oder jährlich
± 5 Tage, der Betrag darf sich je Zahlung um bis zu 25 % ändern (Preisänderung mit Datum). Monatlich und
vierteljährlich ab drei Zahlungen, halb- und jährlich ab zwei; „beendet?" nach mehr als 1,5 Abständen ohne
Zahlung vor der neuesten Buchung. Nicht die wiederkehrenden Rechnungen (eigene Ausgangsrechnungen).
`laufende-kosten entscheiden <key> --als bestaetigt|abgelehnt|beendet|vorschlag [--abstand …] [--betrag …]`
speichert die Entscheidung an der Entität (`laufende_kosten`); nur bestätigte zählen in `frei-verfuegbar` und
fallen aus den Geld-Prüfungen. Optionen: `--entity`, `--json`. MCP: `laufende_kosten_list` (read-only),
`laufende_kosten_entscheiden` (schreibend). In der App: Tab „Laufende Kosten" im Buchungen-Hub.
Oberflächen-Test: `app/dev/laufende-kosten-e2e.sh [shots-dir]`.

### zve — zu versteuerndes Einkommen je Veranlagungsjahr

Das **zvE** (§2 Abs. 5 EStG) eines Jahres als abfragbarer Wert **mit Herkunft**. Einkommensabhängige
Programme (Baufinanzierung, Förderungen mit Einkommensgrenze) verlangen genau diese Zahl; sie steht
sonst nur im Bescheid-PDF und wird von Hand abgelesen — genau so wurde in einem realen Vorgang
monatelang gegen die falsche Schwelle geprüft.

Jede Antwort nennt ihre `herkunft`:

- **`bescheid`** — aus dem Einkommensteuerbescheid übernommen und mit Belegverweis (`paperless:<id>`)
  + Erfassungsdatum hinterlegt. Verbindlich.
- **`schaetzung`** — aus der eigenen ESt-Berechnung abgeleitet (`elster est`). **Kein Bescheidwert**
  und wird nur geliefert, wenn ausdrücklich `--schaetzung` gesetzt ist — so kann niemand versehentlich
  eine Schätzung als Bescheidwert weiterreichen.

**Bewusst schmal:** geliefert wird nur der Wert *eines* Jahres mit seiner Herkunft. Mittelung über
mehrere Jahre, Familien-Zuschläge und Förder-Stufenlogik sind Förderrecht und gehören ins
konsumierende Projekt, nicht hierher. Die Logik liegt komplett in `core/actions/zve.ts`, damit CLI,
MCP (`elster_zve`, read-only) und später ein D-Bus-Dienst denselben Wert liefern.

| Subcommand | Description |
|------------|-------------|
| `zve` | Alle erfassten Jahre auflisten (`--entity`, `--json`). |
| `zve --jahr <j>` | Den Wert eines Jahres (`--json` für maschinenlesbar, `--schaetzung` für den ausdrücklichen Rückfall auf die eigene Schätzung). `--year` ist gleichwertig. |
| `zve record` | Wert aus dem Bescheid erfassen/ersetzen: `--jahr --betrag` plus `--beleg paperless:<id>` (dringend empfohlen — ohne Beleg ist der Wert nicht nachprüfbar und wird als solcher markiert) und `--notiz`. Ein Änderungsbescheid ersetzt den Jahreswert. |
| `zve suggest` | Betrag + Veranlagungsjahr aus dem OCR-Text eines Paperless-Bescheids **vorschlagen** (`--beleg paperless:<id>`); zeigt die Fundstellen im Klartext zum Gegenlesen und übernimmt sie erst mit `--apply`. Bei mehrdeutigem oder unlesbarem Text wird nichts geschrieben. |
| `zve remove` | Erfassten Wert eines Jahres löschen (`--jahr`). |

### contacts

Einzelner Zugriff auf den Kontakte-/Parteienstamm — für den Fall, dass EIN Kontakt von Hand
angelegt/geprüft/entfernt werden soll (z. B. ein neuer Ansprechpartner bei einem Kunden). Der
Massenpfad (Qonto-Clients + Paperless-Korrespondenten automatisch abgleichen) läuft weiter über
den Kontakte-Tab der Web-UI (`importContacts`), nicht über diesen Befehl.

`contacts add` legt ohne `--id` immer einen NEUEN Eintrag an (kein namensbasiertes Dedup — das
gibt es nur beim Import); vorher `contacts list` prüfen, um Dubletten zu vermeiden.

| Subcommand | Description |
|------------|-------------|
| `contacts add` | Kontakt anlegen (`--entity` Pflicht, `--name` oder `--first-name`/`--last-name`) oder mit `--id` aktualisieren (merge). Felder: `--kind (company\|individual\|freelancer\|organization)`, `--email`, `--vat-number`, `--tax-id`, `--iban`, `--currency`, `--locale`, `--address`, `--zip`, `--city`, `--country-code`, `--is-customer`, `--is-supplier`, `--notes`. |
| `contacts list` | Kontakte einer Entität auflisten (`--entity`, sonst Standard-Entität; `--json`). |
| `contacts remove` | Kontakt löschen (`--entity --id`). |

### projects

Kundenprojekte je Entität (inline `projects` in `steuererklaerung.json`): Kunde (Kontakt), Domains und
optional die Kontaktperson fürs Anschreiben (`--greeting`, `--first-name`, `--formality du|sie|inherit`). Ein
Projekt kann mehrere wiederkehrende Posten haben (`invoices recurring set-project`), ein Posten gehört
zu höchstens einem Projekt desselben Kunden. Die Anrede im Anschreiben: Kontaktperson des Projekts →
`customer.greeting`/`customer.formality` des Postens → leer mit Hinweis. Projekte sind freiwillig.

| Subcommand | Description |
|------------|-------------|
| `projects list` | Projekte mit Kunde und zugehörigen Posten (`--entity`, sonst Standard-Entität; `--json`). |
| `projects show <id>` | Ein Projekt zeigen. |
| `projects add` | Anlegen (`--entity --name --contact` Pflicht; `--id`, `--domain` mehrfach, `--greeting`, `--first-name`, `--formality`, `--notes`, `--dry-run`). |
| `projects edit <id>` | Ändern; nicht angegebene Felder bleiben, `""` leert ein Textfeld, `--formality inherit` setzt die Anredeform auf „wie im Vertrag“ zurück. `--dry-run` möglich. |
| `projects remove <id>` | Löschen — verweigert, solange ein Posten am Projekt hängt. `--dry-run` möglich. |
| `projects suggest` | Schlägt Projekte aus Kunde + Domains der Posten vor und druckt die Befehle zum Übernehmen; schreibt nichts. |
| `projects result [id]` | Projektergebnis (Umsatz − Kosten) je Projekt mit Rechnungen, zugeordneten Ausgaben und Herkunft („manuell", „via Regel …"), Stunden und Ergebnis je Stunde; `--year`, `--entity`, `--json` (liefert `rechnungen` und `ausgaben` je Projekt, dazu `regeln` und `buchungen`). |
| `projects assign <project> <tx-id…>` | Ausgaben einem Projekt zuordnen; `--part <n>` nur ein Teil einer aufgeteilten Buchung; `--rule ["<muster>"]` merkt das Muster zusätzlich als Projektregel (ohne Wert das gemeinsame der Buchungen). |
| `projects exclude <tx-id…>` | „Kein Projekt": die Ausgaben bleiben auch dann ohne Projekt, wenn eine Regel sie träfe. |
| `projects unassign <tx-id…>` | Die Zuordnung (oder „kein Projekt") zurücknehmen; sagt je Buchung „Danach gilt: …". |
| `projects rules` / `projects rule add <muster> --project <id>` / `projects rule remove <muster> [--project <id>]` | Die Projektregeln (mit der Zahl der Buchungen, die sie gerade zuordnen) lesen, anlegen, entfernen. Eine Regel ändert nichts an Zuordnungen von Hand. |

**Projekte auch für Ausgaben (Idee 14).** Eine Ausgabe gehört zu einem Projekt durch eine Entscheidung an der
Buchung (Ledger, `booking_projects`, im Entscheidungs-Log als `projekt.*`) oder durch eine Projektregel
(`elster.klassifizierung.projekt_regeln`: Muster → Projekt, `ausnahmen`, gleiche Form und gleiches Matching wie
die Buchungsregeln); die Entscheidung gewinnt. Das **Projektergebnis** ist eine interne Auswertung, keine
Steuerzahl: Umsatz = Netto der ausgestellten Rechnungen, auf denen die Stunden des Projekts abgerechnet sind
(mehrere Projekte auf einer Rechnung: nach Stunden geteilt), Kosten = Netto der zugeordneten Ausgaben, wie die EÜR
sie bucht (private und neutrale Teile einer aufgeteilten Buchung, Einnahmen und Erstattungen zählen nicht),
Ergebnis = Umsatz − Kosten, dazu Stunden und Ergebnis je Stunde. Eine aufgeteilte Buchung lässt sich je Teil
zuordnen (`--part`); ein Teil ohne eigene Zuordnung folgt der Buchung. MCP: `projekt_ergebnis` (read-only,
mit Regel-Vorschau), `projekt_zuordnen` (schreibend). In der App: „Auswählen" → „Projekt zuordnen" in Buchungen,
„Projekt" im Buchungsdetail, Ergebnis, Kosten und Regeln im Projekt (Ansicht Projekte). Oberflächen-Test:
`app/dev/projekte-e2e.sh [shots-dir]`.

`time start|add --project` nimmt eine Projekt-Id oder einen Namen; bei eindeutigem Treffer trägt der
Eintrag die Projekt-Id und den Kunden des Projekts, sonst bleibt der freie Name wie bisher.

### web

**Review-UI** (Hono auf GJS + Adwaita-Web-Components, an `127.0.0.1` gebunden):
Transaktionen + Belege, Steuer-Übersicht (EÜR · USt · GewSt · Feststellung), **Auswertungen
(monatliche BWA)** und geleistete Steuerzahlungen — gespiegelt aus denselben Actions wie
CLI/MCP. Multi-Entity über `steuererklaerung.json`: `gjsify run start web` und dann `http://127.0.0.1:3000`.
Überwiegend read-only; der **Konten**-Tab ist der erste Schreibpfad (Import + Anbindungen).

**Native GNOME-App (parallel zur Web-UI):** dieselbe Informationsarchitektur, aber mit nativen
GTK-4/libadwaita-Widgets statt Adwaita-Web-Components — der erste Schritt zur vollständig nativen
GJS/Adwaita-Portierung. `gjsify run build:app && gjsify run start:app` (braucht eine Desktop-Session;
gjsify bringt die Toolchain mit, kein Node nötig). Beide Front-Ends teilen sich ein Backend; Details
+ Roadmap in [`src/frontends/desktop/README.md`](src/frontends/desktop/README.md).

Der Tab **Konten** (`src/core/actions/accounts.ts` + `account-routes.ts`) verwaltet die
Kontoanbindungen: er listet jedes Konto im Store (Qonto · FinTS · CAMT-Datei · PayPal) mit
Entität, Buchungszahl, Zeitraum, Saldo; **importiert Exporte** (CAMT-XML, PayPal/Amazon-CSV,
Qonto-XLS → Store + Ledger); **trennt** Konten (alles löschen = NDJSON + Cursor + Ledger-Zeilen,
oder nur den Sync-Cursor stoppen); und legt **Live-Anbindungen** an (Qonto-Key bzw.
FinTS-Zugang → `.env` + den `fints`-Abschnitt von `steuererklaerung.json`) samt **„Jetzt synchronisieren"**. List/Import/Trennen
sind reines Dateisystem/SQLite → sicher im Handler; der Live-Sync (Netz) und der
Cache-Neuaufbau danach laufen im `setTimeout(0)`-Job (außerhalb des Handlers → deadlock-sicher),
den der Client pollt. Schreib-Tools/Credentials bleiben localhost-only; `.env` wird nie
committet. (FinTS-Erstanmeldung inkl. TAN weiterhin per CLI `fints sync`.)

Die **BWA** (`/api/bwa`, `src/core/elster/bwa.ts`) ist eine monatliche betriebswirtschaftliche
Auswertung aus den klassifizierten Buchungen (Umsatz → Wareneinsatz → Rohertrag →
Betriebskosten → Betriebsergebnis je Monat + Σ Jahr). Neutrale Posten zählen nicht ins
Ergebnis; das Jahres-Betriebsergebnis entspricht exakt dem EÜR-Gewinn. Für Privat-Entitäten
ausgeblendet.

**Verständlichkeit:** ein **🎓 Lernmodus** im Header (umschaltbar, in localStorage) blendet je
Ansicht eine Erklärzeile ein; unabhängig davon öffnen kleine **„?"-Symbole** (`<bh-help>`,
Glossar in `src/frontends/web/client/lib/glossary.ts`) Klartext-Popovers zu Fachbegriffen (EÜR,
USt-Zahllast, §24, Rohertrag, Messbetrag, Kleinunternehmer …) — clean by default, Hilfe auf Abruf.

Der Tab **Einstellungen** (`/api/settings`) steuert zwei unabhängige Dinge
([docs/app/ki-und-mcp.md](../docs/app/ki-und-mcp.md)): (1) den **eingebauten KI-Assistenten** an/aus,
eine persönliche Einstellung in der `settings.json` des Benutzers (aus ⇒ Tab ausgeblendet,
`/api/chat` gesperrt), und (2), in `steuererklaerung.json`, welche **MCP-Tool-Gruppen nach außen offen** sind — der
MCP-Server (`steuer mcp`, stdio oder HTTP) exponiert nur die aktivierten Gruppen
(Paperless · Qonto · Transactions · Reconciliation · Dokument-Workflow · Cross-System
· ELSTER · Rechnungen · Kontakte), und die **mutierenden** Tools nur, wenn `mcp.allowWrite` gesetzt ist
(Default: read-only). So kann ein externer Assistent (ChatGPT, Claude Code …) gezielt
angebunden werden. Die Qonto-Gruppe enthält z. B. das schreibende Tool
`create_outgoing_invoice_draft` (provider-agnostischer Rechnungs**entwurf** über das Entitäts-
Back-end, niemals Versand) — nur sichtbar, wenn `allowWrite` gesetzt ist. MCP-Änderungen wirken
beim nächsten Start des MCP-Servers.

Der **Assistent** (`/api/chat`, `src/core/actions/assistant/chat.ts` + `chat-agent.ts`) beantwortet Fragen zu
den Zahlen der aktiven Firma. Mit dem Claude Agent SDK arbeitet er **agentisch**: er bekommt
einen kleinen Satz **read-only Werkzeuge** über den In-Memory-Jahres-Cache (`overview`,
`list_transactions`, `get_transaction`, `bwa_by_month`, `list_hinweise`) und sucht sich die
nötigen Daten selbst zusammen — z. B. „Was sind meine größten Ausgaben?" ruft
`list_transactions` auf und nennt konkrete Buchungen. Dazu kommen **Live-Tools**, die — wenn
Paperless eingerichtet ist, nie in der Demo, unabhängig vom MCP-Schalter — direkt die echten Systeme abfragen:
`paperless_search`/`paperless_get` (Belege live in Paperless, nur Metadaten, kein OCR-Body).
Diese Live-Reads laufen **in-process** im selben `setTimeout(…,0)`-Job (also außerhalb des
Request-Handlers → der libsoup-Fetch ist deadlock-sicher; verifiziert auf GJS); Schreib-Tools
bekommt der Auto-Assistent nie. Weitere Gruppen (Qonto, Cross-System, …) lassen sich nach demselben
Muster ergänzen. Die Werkzeuge sind eine Allow-Liste
(kein Bash/Read/Write, kein Schreibzugriff) und lesen nur den Cache (kein Live-Fetch → kein
libsoup-Deadlock); sie laufen im selben `setTimeout(…,0)`-Job wie der einfache Pfad. Mit
einem anderen Provider (oder bei einem Fehler im agentischen Pfad) fällt er auf die
einfache, aggregierte Single-Shot-Antwort zurück. An die KI gehen nur die Zahlen hinter den
Ansichten (inkl. einzelner Buchungen: Gegenpartei + Beträge), **keine** IBANs, Steuernummern,
Zugangsdaten oder Belegtexte. Der LLM-Aufruf (Standard: Claude Agent SDK, `LLM_PROVIDER`) läuft als
**asynchroner Job auf einem frischen Main-Loop-Tick** (`setTimeout(…,0)`, nie im
Request-Handler verschachtelt) → er umgeht den libsoup-in-Handler-Deadlock; der Client
pollt das Ergebnis. Als Kontext werden nur die **aggregierten Kennzahlen** (EÜR/USt/BWA/
Fristen/Hinweise) gesendet — keine IBANs/Steuernummern. Keine Steuerberatung.

Der Tab **Einblicke** (`/api/hinweise`, `src/core/elster/hinweise.ts`) sammelt kontextuelle,
aus den Daten berechnete Hinweise — z. B. den **§19-Kleinunternehmer-Check** (Umsatz vs.
25.000 € / 100.000 €), „USt-Vorauszahlungen noch nicht erfasst", Vorsteuer ohne Beleg,
unklassifizierte Buchungen, Betriebsaufgabe/§24, neutralisierte Doppelzahlungen — nach
Dringlichkeit sortiert (Warnung › Tipp › Info). Keine Steuerberatung; für Geschäfts­entitäten.

Der **Steuer-Tab** trägt oben ein **Dashboard** (`/api/dashboard`, `src/core/elster/fristen.ts`):
die Abgabefristen der Jahreserklärungen (Regelfrist 31.07. des Folgejahres ohne Berater, plus
`deadline_extension_months` aus der Config) mit „in N Tagen", die geschätzte eigene Steuerlast
(USt-Abschlusszahlung + Gewerbesteuer) und der Status je Erklärung. Die ESt ist Sache der
Gesellschafter (abhängig von deren übrigen Einkünften) und wird bewusst **nicht** geschätzt —
nur die festgestellten Einkünfte werden ausgewiesen.

**Mehrere Entitäten (Firmen).** Das gitignorierte **`steuererklaerung.json`** (v1-Manifest, Vorlage:
`steuererklaerung.example.json`) listet unter `entities[]` alle Firmen und ordnet ihnen die Store-Konten
zu — z. B. eine GbR (`camt:*`), ein Einzelunternehmen (`qonto:…*`) und Privat (`fints:…:*`). Die
Web-UI bekommt im Header einen **Firmen-Umschalter**; alle Ansichten filtern auf die Konten der
aktiven Firma. Eine Entität **ohne** `elster`-Abschnitt (z. B. „Privat") zeigt nur Transaktionen +
Zahlungen, keinen Steuer-Tab. Ist keine Firma gewählt, nutzt die UI die erste Geschäfts-Entität.

| Subcommand | Description |
|------------|-------------|
| `web` | Startet die Review-UI. Optionen: `--port` (Default 3000), `--host` (Default 127.0.0.1), `--years` (kommasepariert, Default: Config-Jahr). Multi-Entity über `steuererklaerung.json`. Daten werden **beim Start** je (Entität × Jahr) vorgeladen (der GJS-Server darf zur Laufzeit nicht selbst nach außen fetchen). |

### reconcile

Verknüpft Paperless-Rechnungen mit Buchungen aus dem **lokalen** Transaktions-Store
(`camt:`/`fints:`/`qonto:`) — für **geschlossene Konten**, die nicht mehr über die Qonto-API
erreichbar sind (z. B. ein aufgelöstes Unternehmen). Schreibt dieselben `qonto_*`-Felder
(`qonto_settled_at`, `qonto_transaction_amount`, …) wie der Live-Qonto-Abgleich, sodass die
USt-VA-/EÜR-Aggregation unverändert funktioniert. Auto-Match über Betrag (±Toleranz), Richtung
(Soll/Haben) und Datumsnähe (Rechnungs-/Fälligkeitsdatum), nur **eindeutige** Treffer werden
geschrieben.

| Subcommand | Description |
|------------|-------------|
| `reconcile store` | Batch: verknüpft alle noch unverknüpften Rechnungen eines Zeitraums mit ihrer Store-Buchung (nur eindeutige Treffer). Optionen: `--year` (Pflicht), `--month`, `--account-key`, `--max-day-gap` (def. 60), `--amount-tolerance` (def. 0.01), `--limit`, `--force`, `--dry-run`. |
| `reconcile document <id>` | Ein Dokument abgleichen (Auto-Match oder explizit `--store-transaction-id`). Optionen wie oben plus `--store-transaction-id`. |
| `reconcile status` | **Lückenreport** für einen Zeitraum: verknüpfte/unverknüpfte Store-Buchungen und Rechnungen, plus Buchungen, die belegfrei sein dürfen (Übertrag, Gebühren, Privatentnahme). Optionen: `--year` (Pflicht), `--month`, `--account-key`. |

**MCP:** `match_document_to_store_transaction`, `get_store_reconciliation_status` (gleiche Logik für den Agenten).

#### Steuer-Workflow für ein geschlossenes Konto (z. B. EÜR 2025)

1. **CAMT importieren** (einmalig): `transactions import <pfad>` → Verlauf landet als `camt:<iban>` im Store.
2. **KI-Felder + Kategorie** über alle Jahres-Belege (überschreibend): `paperless extract-invoice-fields-incoming --auto --force --from 2025-01-01 --to 2025-12-31` (und `…-outgoing`). Füllt Beträge, Datum **und** `accounting_category`.
3. **Beleg ↔ Zahlung verknüpfen**: `reconcile store --year 2025 --dry-run` prüfen, dann ohne `--dry-run`. Setzt das Zahldatum (`qonto_settled_at`) aus dem Store.
4. **Lücken schließen**: `reconcile status --year 2025` → fehlende Belege/Zahlungen klären.
5. **EÜR-Zahlen**: `elster euer report --year 2025` → Summen, Gewinn, USt-Zahllast und Kennzahlen-Blatt zum Eintragen in Mein ELSTER (Anlage EÜR + USt-Jahreserklärung). Die **Feststellungserklärung** (GbR) bleibt manuell/StB.

### ledger

**SQLite-Hauptbuch** als Fundament der künftigen Buchhaltungssoftware (System-of-Record). Hält
**RAW-Buchungen** (unveränderliche Fakten, idempotenter Upsert) plus Stammdaten (Entitäts-Slots:
CAMT-Import/Geschäftskonto/privat, Konten, **Kontenrahmen** aus `SKR03_TO_EUER`). Die **Entscheidungs-Schicht**
(`classifications`/`periods`/`audit_log`) ist als Gerüst angelegt, bleibt aber **leer/offen** — pro
Buchung wird (noch) nichts persistiert/festgeschrieben, bis die Buchhaltung geprüft ist.

DB-Datei: `transactions-data/ledger.db` (gitignored; überschreibbar via `LEDGER_DB_PATH`).
Speicher ist das eingebaute **`node:sqlite`** (`DatabaseSync`) — unter GJS liefert gjsify
(`@gjsify/sqlite`, libgda-backed) dasselbe Modul, derselbe Code läuft also auf **GJS und Node**
ohne Abstraktion. (Hinweis: Schema-DDL wird statementweise ausgeführt, nicht als ein
Multi-Statement-String — gjsifys `exec()`-Splitter verträgt eingebettete SQL-Kommentare nicht.)

| Subcommand | Description |
|------------|-------------|
| `ledger init` | Schema anlegen + Stammdaten seeden (3 Entitäten + Kontenrahmen). Idempotent. |
| `ledger import` | Jede RAW-Buchung aus dem NDJSON-Store ins Hauptbuch übernehmen (idempotenter Upsert). Schreibt **keine** Klassifizierungen. |
| `ledger status` | Inhalt anzeigen: Schema-Version, Stammdaten- + Buchungszahlen je Konto/Entität. |

### transactions

Unified transaction store across **Qonto + FinTS (Volksbank et al.)**. `sync` pulls new
transactions incrementally into a local NDJSON store; `search`/`list`/`summary` then query
**all accounts at once** (same filters as `qonto-export`/`camt-export`, but live and combined).
The store keeps history beyond a bank's live window (FinTS serves only ~90 days), so regular
syncs never re-fetch everything. Store dir: `transactions-data/` (gitignored; override with
`TRANSACTIONS_DATA_DIR`). Account keys: `qonto:<bankAccountId>`, `fints:<configName>:<accountNumber>`.

| Subcommand | Description |
|------------|-------------|
| `transactions sync` | Fetch new transactions from all sources (incremental). Options: `--account <qonto\|fints-config-name>`, `--from YYYY-MM-DD`, `--full`. **Qonto runs unattended; FinTS triggers a SecureGo/TAN approval** (run it interactively). |
| `transactions search` | Search across all accounts (newest first): `-q/--query`, `--from`, `--to`, `--min-amount`, `--max-amount`, `--type income\|expense`, `--source qonto\|fints\|camt`, `--account-key`, `--limit`. |
| `transactions list` | Alias for `search` (no text query needed). |
| `transactions summary` | Per-account counts, date ranges, totals (in/out/net). |
| `transactions import <path>` | Import CAMT.052/053 XML exports (file, account folder, or a parent folder with per-account subfolders) into the store. **Matched IBAN** → backfills an existing account's history beyond the FinTS ~90-day window (by default only transactions older than the account already has; `--full` imports everything). **Unmatched IBAN** → imports a standalone/closed account (e.g. a dissolved company's Qonto, no longer API-reachable) under its own `camt:<iban>` key with full history (idempotent). Several distinct accounts in one flat folder: import each file individually. |

Amounts are **signed EUR** (expense negative). Prerequisites: Qonto creds (see Credentials) for the
Qonto source; a synced FinTS account (`fints sync`) for the FinTS source.

**Regelmäßig syncen (Cron):** Qonto unbeaufsichtigt z. B. stündlich; FinTS braucht die TAN-Freigabe,
also nur dort, wo du sie bestätigen kannst (oder seltener, manuell):

```cron
# Qonto: stündlich, unbeaufsichtigt
0 * * * * cd /pfad/zu/steuererklaerung/app && gjsify run start transactions sync --account qonto >> transactions-sync.log 2>&1
```

FinTS: `gjsify run start transactions sync --account musterbank-privat` interaktiv ausführen
(SecureGo-Push in der App bestätigen). Der Store wächst inkrementell; ältere Daten bleiben erhalten.

**MCP:** Die Tools `transactions_search` und `transactions_summary` durchsuchen denselben Store
read-only (keine Bank-Calls, keine TAN) — so kann der Agent alle Konten in *einem* Aufruf prüfen.

**Logging:** The CLI can append log lines to files for debugging. Use `getLogger(name?)` from `src/core/lib/logger.ts`: with a name (e.g. `getLogger('sync-import')`) it writes to `<name>.log` in the current directory; without a name, to `app.log`. Override path: `LOG_FILE` for the default logger, or `LOG_FILE_<NAME>` for a named one (e.g. `LOG_FILE_SYNC_IMPORT` for sync-import.log).

### Mail, contacts and calendar → postbote

GNOME Online Accounts, contacts, calendar and mail (IMAP) are no longer part of this project.
They moved to **[postbote](https://github.com/JumpLink/postbote)**, which does the same job
properly: structured search, folders, real attachment downloads and a local full-text index.
It registers as its own MCP server alongside this one, so an assistant can search mail there
and file the result here — `mail_save_attachment` then `paperless_upload_document`.

## Credentials

- **Qonto:** Set `QONTO_ENV=production` or `QONTO_ENV=staging`. You can keep both credential sets in `.env`: use `QONTO_PRODUCTION_SIGN_IN` / `QONTO_PRODUCTION_SECRET_KEY` for production and `QONTO_STAGING_SIGN_IN` / `QONTO_STAGING_SECRET_KEY` / `QONTO_STAGING_TOKEN` for staging. Unprefixed `QONTO_SIGN_IN` / `QONTO_SECRET_KEY` act as fallback. Optional per-env default bank account: `QONTO_PRODUCTION_DEFAULT_BANK_ACCOUNT_ID`, `QONTO_STAGING_DEFAULT_BANK_ACCOUNT_ID` (or `QONTO_DEFAULT_BANK_ACCOUNT_ID`). Optional: `QONTO_BASE_URL` to override the env-specific API URL.
- **Paperless-NGX:** Base URL + API token from "My Profile" in the UI.
- **LLM engine (Paperless review/classify/extract):** selected via `LLM_PROVIDER` (`claude` default, `scaleway` fallback) and `LLM_MODEL`. The `claude` provider uses the Claude Agent SDK on your logged-in subscription — **no API key needed** (set `ANTHROPIC_API_KEY` only to bill per token, e.g. in CI). Pick the model with `LLM_MODEL` (e.g. `claude-opus-4-8` for Opus, `claude-sonnet-4-6` for cheaper/faster). The `scaleway` provider still works for batch/cheap runs (`SCALEWAY_API_KEY`, `SCALEWAY_PROJECT_ID`/`SCALEWAY_BASE_URL`, optional `SCALEWAY_CHAT_MODEL`).

## Qonto client (programmatic)

The Qonto client (`src/core/clients/qonto/`) exposes:

- **Organization:** `getOrganization()`, `check()`
- **Bank accounts:** `listBankAccounts()`, `getBankAccount()`
- **Transactions:** `listTransactions()`, `getTransaction()`
- **Attachments:** `getAttachment()`, `uploadAttachment()`, `listTransactionAttachments()`, `uploadAttachmentToTransaction()`, `removeAttachmentFromTransaction()`
- **Statements:** `listStatements()`, `getStatement()`

Auth and env: controlled by `QONTO_ENV`; credentials from `QONTO_PRODUCTION_*` / `QONTO_STAGING_*` (or fallback `QONTO_SIGN_IN`, `QONTO_SECRET_KEY`). Optional: `QONTO_BASE_URL`. Exports: `getQontoEnv()`, `getDefaultBankAccountId()`.

## API docs

- [Qonto](https://docs.qonto.com/introduction/welcome) · [Paperless-NGX](https://docs.paperless-ngx.com/api/)
