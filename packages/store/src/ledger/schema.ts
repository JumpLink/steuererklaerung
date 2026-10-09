/**
 * Ledger schema and migration — versioned via SCHEMA_VERSION + the UPGRADES array.
 *
 * Design: RAW imported transactions are immutable facts; master data (entities,
 * accounts, chart_of_accounts) is reference data. The decision layer lives in
 * `classifications` (per-transaction bookkeeping decisions) + `periods`
 * (Festschreibung) + `audit_log` (append-only decision log).
 *
 * `classifications` (schema v6) is keyed by the UNIFIED transaction id (the same
 * `id` the EÜR/explain path uses, NOT `source:id`) and is FK-free on purpose: the
 * transaction source of truth is the NDJSON store, not the (optional) SQLite
 * `transactions` mirror, and a manual reclassification must be bookable to any
 * SKR03 category without the `chart_of_accounts` seed being present. A row stays
 * `status='open'` until the owner decides; a manual override carries
 * `source='manual'` + the owner `note` (Begründung) + `decided_by`, and every
 * write appends an `audit_log` row (`classification.*`) so the decision log is
 * durable + append-only.
 */

import { type LedgerDatabase, withTransaction } from "./db.ts";

export const SCHEMA_VERSION = 25;

/**
 * The `classifications` DDL (schema v6). Defined once so the fresh-database baseline
 * (STATEMENTS) and the v5→v6 rebuild (UPGRADES) cannot drift. FK-free by design (see
 * the module comment). Keyed by the unified transaction id (`transaction_id`).
 */
const CLASSIFICATIONS_TABLE = `CREATE TABLE IF NOT EXISTS classifications (
     transaction_id TEXT PRIMARY KEY,
     category TEXT, net REAL, vat REAL,
     status TEXT NOT NULL DEFAULT 'open', source TEXT, document_id INTEGER, note TEXT,
     ai_note TEXT, ai_note_accepted INTEGER,
     decided_at TEXT, decided_by TEXT)`;

// One statement per entry, executed individually. We deliberately do NOT put SQL
// comments inside these strings or rely on multi-statement exec(): gjsify's
// `@gjsify/sqlite` splits a multi-statement string on its own and its splitter
// mishandles embedded `--` comments / quotes (node:sqlite uses sqlite3's native
// multi-statement exec instead). Keeping each statement clean + separate is
// portable across both. Documentation lives in these JS comments.
const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  // --- Master data ---
  // entity id: 'artcode' | 'jumplink' | 'private'
  `CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT)`,
  // account_key: 'camt:DE15…' | 'qonto:…' | 'fints:…'; source: qonto|fints|camt
  `CREATE TABLE IF NOT EXISTS accounts (
     account_key TEXT PRIMARY KEY, source TEXT NOT NULL, iban TEXT,
     entity_id TEXT REFERENCES entities(id), label TEXT)`,
  // code = full SKR03-style label; kind = income|expense|neutral; vat_rate = implied fraction
  `CREATE TABLE IF NOT EXISTS chart_of_accounts (
     code TEXT PRIMARY KEY, kind TEXT NOT NULL, bucket TEXT NOT NULL, euer_kz TEXT,
     vat_rate REAL NOT NULL DEFAULT 0, requires_receipt INTEGER NOT NULL DEFAULT 1)`,

  // --- RAW facts (immutable); dedupe_key = 'source:id'; amount signed (neg = debit) ---
  `CREATE TABLE IF NOT EXISTS transactions (
     dedupe_key TEXT PRIMARY KEY, id TEXT NOT NULL, source TEXT NOT NULL,
     account_key TEXT NOT NULL REFERENCES accounts(account_key),
     booking_date TEXT NOT NULL, value_date TEXT, amount REAL NOT NULL, currency TEXT NOT NULL,
     counterparty TEXT, counterparty_iban TEXT, purpose TEXT, reference TEXT, type TEXT,
     category TEXT, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_key)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(booking_date)`,

  // --- Decision layer ---
  // Per-transaction bookkeeping decision (schema v6). Keyed by the unified transaction id.
  // status: open|suggested|confirmed; source: rule|document|manual; document_id = Paperless id;
  // note = owner Begründung; ai_note = AI rationale; ai_note_accepted = owner accepted it (1/0).
  CLASSIFICATIONS_TABLE,
  // status: open|locked (Festschreibung)
  `CREATE TABLE IF NOT EXISTS periods (
     entity_id TEXT NOT NULL REFERENCES entities(id), year INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open', locked_at TEXT, PRIMARY KEY (entity_id, year))`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`,

  // --- Built-in DMS (schema v2) ---
  // The dependency-free document store: file bytes live on disk under
  // <store>/documents/<entityId>/…, the metadata here. entity_id is the WORKSPACE
  // entity id (gbr|jumplink|privat) — a free scoping tag, NOT the ledger entities
  // space (artcode|jumplink|private), so no FK to entities(id). created = doc date.
  `CREATE TABLE IF NOT EXISTS documents (
     id TEXT PRIMARY KEY, entity_id TEXT NOT NULL,
     title TEXT, correspondent TEXT, document_type TEXT, direction TEXT,
     created TEXT, added TEXT, filename TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0,
     file_path TEXT NOT NULL, invoice_number TEXT, net REAL, gross REAL, vat REAL,
     tags TEXT, ai_extracted_at TEXT, note TEXT, created_by TEXT,
     invoice_kind TEXT, invoice_kind_reason TEXT, category TEXT, rule_origin TEXT, origin TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_entity ON documents(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_created ON documents(created)`,
  // doc → store transaction link; tx_id = unified transaction id (Sammelrechnung ⇒ many rows)
  `CREATE TABLE IF NOT EXISTS document_links (
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     tx_id TEXT NOT NULL, PRIMARY KEY (document_id, tx_id))`,
  `CREATE INDEX IF NOT EXISTS idx_doclink_tx ON document_links(tx_id)`,
  // DMS-agnostic OCR/full-text store (dms = builtin|paperless; source = ai|paperless|…)
  `CREATE TABLE IF NOT EXISTS document_ocr (
     dms TEXT NOT NULL, doc_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL,
     PRIMARY KEY (dms, doc_id))`,

  // --- Contacts / parties (schema v3) ---
  // The unified party master: customers (we invoice) and suppliers/correspondents (we receive
  // from). Our store is the system of record; Qonto clients and Paperless correspondents are
  // projections linked via contact_links. entity_id is the WORKSPACE entity id (gbr|jumplink|
  // privat) — a free scoping tag like documents.entity_id, NOT the ledger entities space.
  `CREATE TABLE IF NOT EXISTS contacts (
     id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'company',
     name TEXT, first_name TEXT, last_name TEXT, email TEXT,
     vat_number TEXT, tax_id TEXT, iban TEXT,
     currency TEXT NOT NULL DEFAULT 'EUR', locale TEXT NOT NULL DEFAULT 'de',
     address TEXT, zip TEXT, city TEXT, country_code TEXT,
     is_customer INTEGER NOT NULL DEFAULT 0, is_supplier INTEGER NOT NULL DEFAULT 0,
     notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_contact_entity ON contacts(entity_id)`,
  // contact ↔ external record link; system = qonto|paperless, external_id = the back-end id.
  // Dedupe across systems is enforced in the import/matching logic, so the lookup index is plain.
  `CREATE TABLE IF NOT EXISTS contact_links (
     contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     system TEXT NOT NULL, external_id TEXT NOT NULL, synced_at TEXT,
     PRIMARY KEY (contact_id, system))`,
  `CREATE INDEX IF NOT EXISTS idx_contact_links_lookup ON contact_links(system, external_id)`,

  // --- Outgoing invoices (self provider, schema v4) ---
  // Locally created customer invoices — the alternative to drafting via Qonto. entity_id is the
  // WORKSPACE entity id (gbr|jumplink|privat), a free scoping tag like documents/contacts (no FK
  // to entities(id)). GoBD immutability is enforced in the repo (status guards), not in SQL:
  // finalized rows freeze number + recipient/issuer snapshots + totals; corrections happen via a
  // storno counter-invoice (storno_of_id), never by editing. number is NULL until finalize, so a
  // deleted draft leaves no gap. Money as REAL euros (round2), vat_rate as a fraction (0.19) like
  // chart_of_accounts. paid_tx_id is a soft ref to transactions.dedupe_key (no FK: the paying tx
  // may live in a different store/account scope).
  `CREATE TABLE IF NOT EXISTS invoices (
     id TEXT PRIMARY KEY, entity_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'invoice', status TEXT NOT NULL DEFAULT 'draft', number TEXT,
     contact_id TEXT REFERENCES contacts(id), recipient_json TEXT, issuer_json TEXT,
     issue_date TEXT, due_date TEXT, performance_start TEXT, performance_end TEXT,
     currency TEXT NOT NULL DEFAULT 'EUR', iban TEXT, buyer_reference TEXT,
     header TEXT, footer TEXT, terms TEXT,
     total_net REAL, total_vat REAL, total_gross REAL,
     storno_of_id TEXT REFERENCES invoices(id), paid_at TEXT, paid_tx_id TEXT,
     dms TEXT, pdf_document_id TEXT, xml_document_id TEXT,
     finalized_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  // One number per entity is unique, but only once assigned (drafts share NULL → partial index).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_number ON invoices(entity_id, number) WHERE number IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_entity_status ON invoices(entity_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_storno_of ON invoices(storno_of_id)`,
  // Positions; per-line net/vat/gross frozen at finalize alongside the header totals.
  `CREATE TABLE IF NOT EXISTS invoice_items (
     invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, position INTEGER NOT NULL,
     title TEXT NOT NULL, description TEXT, quantity REAL NOT NULL, unit TEXT,
     unit_price_net REAL NOT NULL, vat_rate REAL NOT NULL,
     net REAL NOT NULL, vat REAL NOT NULL, gross REAL NOT NULL,
     PRIMARY KEY (invoice_id, position))`,
  // Fortlaufende Rechnungsnummer per (entity, prefix, year); bumped atomically at finalize.
  `CREATE TABLE IF NOT EXISTS invoice_sequences (
     entity_id TEXT NOT NULL, prefix TEXT NOT NULL, year INTEGER NOT NULL,
     last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (entity_id, prefix, year))`,
  // Append-only per-invoice audit trail (created|updated|finalized|archived|paid|cancelled).
  `CREATE TABLE IF NOT EXISTS invoice_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL REFERENCES invoices(id),
     at TEXT NOT NULL, action TEXT NOT NULL, actor TEXT, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id)`,

  // --- Filing register (schema v5; declared_amount + surcharge v10) ---
  // Tracks which statutory declarations/payments have been submitted/paid — the "erledigt"
  // side of the Fristen system. One row per obligation, keyed by (entity_id, kind, period):
  // entity_id is the WORKSPACE entity id (gbr|jumplink|privat), matching the Steuertermine
  // (see elster/steuertermine.ts); kind mirrors SteuerTerminKind (ustva|ust-jahr|euer|
  // feststellung|gewst|est|sonstige); period is '2026-Q2' | '2026-03' | '2025'. filed_at /
  // paid_at are YYYY-MM-DD (null = not yet). It lets the proactive Steuertermine layer mark a
  // period done and feeds the annual USt Vorauszahlungssoll (Z119).
  //
  // Three DISTINCT money columns, because a USt-VA Zahllast is not one number (schema v10):
  //   - declared_amount = Anmeldungssoll: the Zahllast as DECLARED in the Voranmeldung (Kz 83).
  //     This is the authoritative Soll and the ONLY thing the annual USt-Jahreserklärung's
  //     Vorauszahlungssoll (Z119) sums — see actions/filings.ts sumFiledUstvaVat.
  //   - amount = the amount actually PAID / the legacy column. Kept as-is for pre-v10 rows
  //     (treated as the paid/legacy value); declared_amount is the authoritative Soll and falls
  //     back to amount when null (legacy rows). A payment (incl. a Säumniszuschlag) must NEVER be
  //     written into declared_amount or it corrupts Z119.
  //   - surcharge = steuerliche Nebenleistung (Säumniszuschlag §240 AO, §3 Abs. 4 AO) — NOT
  //     Umsatzsteuer, so it never enters the USt sums; recorded only to reconcile the payment
  //     (paid = declared_amount + surcharge). All EUR, signed; all nullable.
  //   - assessed_amount = what the FINANZAMT actually assessed for this obligation (schema v15),
  //     read off its Abrechnung/Bescheid: positive = still owed, negative = Erstattung. It is a
  //     THIRD number because it routinely differs from what we declared — the Finanzamt settles
  //     against ITS OWN Vorauszahlungssoll, which knows payments our register never saw. A real
  //     case: a declared Abschlusszahlung of 1.091,16 € came back as a 354,98 € refund, because
  //     the Finanzamt counted 1.886,71 € as already paid where the declaration named 440,57 €.
  //     Overwriting declared_amount with that would erase the very comparison that proves a
  //     Bescheid right or wrong, so the assessed figure gets its own column and declared_amount
  //     stays what we sent. assessed_at is the Bescheid date; attach the document itself via
  //     filing_documents (role 'bescheid').
  `CREATE TABLE IF NOT EXISTS filings (
     entity_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
     filed_at TEXT, paid_at TEXT, amount REAL, declared_amount REAL, surcharge REAL,
     assessed_amount REAL, assessed_at TEXT, note TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (entity_id, kind, period))`,
  `CREATE INDEX IF NOT EXISTS idx_filings_entity ON filings(entity_id)`,

  // --- Immutable filing snapshots (schema v7) ---
  // The durable object a submission + sign-off binds to. One row per captured tax return: the
  // generated ELSTER xml + the headline figures (JSON) + the input fingerprint + a timestamp +
  // the form type. APPEND-ONLY: xml/figures/fingerprint are written once at insert and never
  // mutated (see filings/snapshots.ts — there is no repo function that rewrites them); only the
  // status (draft|validated|submitted|superseded) and, on submit, transfer_ticket/server_protocol
  // change. entity_id is the WORKSPACE entity id (gbr|jumplink|privat). Comparing a snapshot's
  // frozen fingerprint against the recomputed live one detects post-filing data drift.
  // submission_source (schema v9) = how it was submitted: 'eric' (transmitted through ERiC) vs
  // 'web-form' (hand-entered in Mein ELSTER; the annual forms can't go via ERiC without a
  // Hersteller-ID) — set alongside transfer_ticket on submit. submitted_at (schema v9) = the actual
  // submission date (YYYY-MM-DD), distinct from created_at (capture time) for a recorded web filing.
  // `period` is the sub-year scope: NULL for the annual forms, `YYYY-Qn` / `YYYY-MM` for a USt-VA.
  // Without it, capturing Q1 and then Q2 of one year produced two rows that "latest snapshot for
  // ustva" could not tell apart — and the newest would be handed to a submission the user started
  // for the older quarter. In a filing app, sending the wrong period's XML is not a display bug.
  `CREATE TABLE IF NOT EXISTS filing_snapshots (
     id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, year INTEGER NOT NULL, form_type TEXT NOT NULL,
     created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, xml TEXT NOT NULL, figures TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft', transfer_ticket TEXT, server_protocol TEXT, note TEXT,
     submission_source TEXT, submitted_at TEXT, period TEXT)`,
  // The index deliberately STOPS at form_type and does not name `period`. STATEMENTS runs BEFORE
  // the UPGRADES ALTERs (see migrate), so an index over a column the ALTER has not added yet fails
  // on exactly the pre-v14 databases the migration exists for — measured, not theorised. SQLite
  // uses a prefix of these columns for the period-scoped query and filters the rest, which is what
  // this index was worth anyway.
  `CREATE INDEX IF NOT EXISTS idx_filing_snapshots_scope ON filing_snapshots(entity_id, year, form_type)`,

  // --- Fingerprint-bound filing sign-offs (schema v8) ---
  // The explicit human RELEASE a submission gate binds to. One row per sign-off of a filing
  // snapshot: it copies the snapshot's input fingerprint + the machine cross-check verdict at
  // release time, so the release is bound to an exact data state. APPEND-ONLY: snapshot_id,
  // fingerprint, signed_by, signed_at, note, cross_checks_clean are written once at insert and
  // never rewritten (see filings/signoffs.ts — there is no repo function that edits them); the ONLY
  // mutation is flipping `revoked` (a soft withdrawal). entity_id is the WORKSPACE entity id
  // (gbr|jumplink|privat). snapshot_id is a free ref to filing_snapshots.id (FK-free, like the
  // snapshot itself). A sign-off goes stale automatically: the moment the live recomputed
  // fingerprint differs from this frozen one, the release no longer binds the current data.
  `CREATE TABLE IF NOT EXISTS filing_signoffs (
     id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, entity_id TEXT NOT NULL, year INTEGER NOT NULL,
     form_type TEXT NOT NULL, period TEXT, fingerprint TEXT NOT NULL, signed_by TEXT, signed_at TEXT NOT NULL,
     note TEXT, cross_checks_clean INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_filing_signoffs_scope ON filing_signoffs(entity_id, year, form_type)`,

  // --- Filing documents (schema v11) ---
  // Which DMS documents belong to which filing-register entry: the Finanzamt response (Bescheid,
  // Mahnung, Schreiben) or supporting proof (Übertragungsprotokoll, Zahlungsbeleg) for a submitted
  // declaration. Keyed by (entity_id, kind, period, document_ref) — the first three match the
  // `filings` register key, so one filing can carry many documents; re-attaching the same document
  // merge-updates role/note (see filings/documents.ts). document_ref is a DMS-agnostic string
  // (`paperless:<id>` for Paperless-ngx, a store documents.id for the built-in DMS) and FK-free by
  // design, like the snapshots: the link must survive an entity switching its DMS backend, and the
  // referenced filing's existence is enforced in the action layer, not the schema. role is free
  // text (known values: bescheid|mahnung|uebertragungsprotokoll|zahlungsbeleg|schreiben|sonstiges).
  `CREATE TABLE IF NOT EXISTS filing_documents (
     entity_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
     document_ref TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'sonstiges',
     note TEXT, created_at TEXT NOT NULL,
     PRIMARY KEY (entity_id, kind, period, document_ref))`,
  `CREATE INDEX IF NOT EXISTS idx_filing_documents_doc ON filing_documents(document_ref)`,

  // --- Time tracking (schema v12) ---
  // entity_id is the WORKSPACE entity id (jumplink|gbr|privat), a free scoping tag like
  // documents/contacts (no FK to entities(id)). contact_id is a soft ref to contacts(id): a timer
  // may run before a customer is assigned, and deleting a contact must not delete worked time.
  // ended_at NULL = the timer is still running; at most one such row per entity is enforced in the
  // repo, not in SQL (a partial UNIQUE index would also have to allow the many finished rows).
  // invoice_id is what "billed" means — a soft ref to invoices(id), see time/types.ts.
  `CREATE TABLE IF NOT EXISTS time_entries (
     id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, contact_id TEXT, project TEXT NOT NULL,
     project_id TEXT, description TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER,
     billable INTEGER NOT NULL DEFAULT 1, invoice_id TEXT,
     source TEXT NOT NULL DEFAULT 'manual', external_id TEXT, note TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_time_entries_entity_start ON time_entries(entity_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_time_entries_contact ON time_entries(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_time_entries_invoice ON time_entries(invoice_id)`,
  // Re-importing the same CSV must not duplicate rows; the lookup is per entity + external id.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_external ON time_entries(entity_id, external_id)`,

  // --- Assessed tax key figures per Veranlagungsjahr (schema v13) ---
  // Figures READ OFF a Steuerbescheid — the counterpart of the app's own ESt *Schätzung*
  // (elster/est-berechnung.ts). Today one figure: zve = zu versteuerndes Einkommen (§2 Abs. 5 EStG)
  // in REAL euros, the number income-dependent subsidy programmes ask for. It exists because that
  // value otherwise lives only inside a PDF and gets read by hand — which is how a real application
  // checked its income limit against the wrong threshold for months and missed a bonus.
  // entity_id is the WORKSPACE entity id (gbr|jumplink|privat), a free scoping tag like
  // filings/time_entries (no FK to entities(id)); year is the Veranlagungsjahr as INTEGER, same key
  // shape as `periods`. document_ref points at the Bescheid the figure was read from, DMS-agnostic
  // and FK-free exactly like filing_documents.document_ref (`paperless:<id>` or a store
  // documents.id); NULL means the figure is unverifiable and callers should say so. recorded_at is
  // the Erfassungsdatum, refreshed on every write because a re-record IS a new capture (an
  // Änderungsbescheid REPLACES the year's figure — the history of Bescheid documents is
  // filing_documents, not this table). No extra index: the primary key already indexes
  // (entity_id, year) and therefore entity_id alone.
  `CREATE TABLE IF NOT EXISTS tax_assessments (
     entity_id TEXT NOT NULL, year INTEGER NOT NULL, zve REAL NOT NULL,
     document_ref TEXT, note TEXT,
     recorded_at TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (entity_id, year))`,
  // Mail history per outgoing invoice (schema v17): one row per send attempt, failures included.
  // invoice_id is a SOFT ref to the back-end id (Qonto client invoice or local invoices.id), so it
  // carries no FK: Qonto invoices have no row in `invoices`. Metadata only — never the body, the
  // attachment or a credential. recipients is a JSON array; result is 'sent' | 'failed'.
  `CREATE TABLE IF NOT EXISTS invoice_mails (
     id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
     invoice_number TEXT, at TEXT NOT NULL, from_address TEXT NOT NULL, recipients TEXT NOT NULL,
     subject TEXT NOT NULL, message_id TEXT, result TEXT NOT NULL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_mails_invoice ON invoice_mails(entity_id, invoice_id)`,
  // Erstattungen (schema v19): an incoming refund linked to the debit it refunds, or a candidate the
  // owner said no to. Both ids are UNIFIED transaction ids, FK-free like `classifications`. status:
  // linked|rejected — one row per (refund, candidate), at most one `linked` per refund (enforced in
  // the repo). A linked row freezes what the refund inherits at the moment of „Ja": the original's
  // category, its VAT rate as a fraction (0.19) and the receipt that carried its Vorsteuer — so a
  // refund in a later year books without re-deriving a year that may already be filed.
  `CREATE TABLE IF NOT EXISTS refund_links (
     refund_tx_id TEXT NOT NULL, original_tx_id TEXT NOT NULL, status TEXT NOT NULL,
     category TEXT, vat_rate REAL, original_document_id INTEGER,
     decided_at TEXT NOT NULL, decided_by TEXT,
     PRIMARY KEY (refund_tx_id, original_tx_id))`,
  `CREATE INDEX IF NOT EXISTS idx_refund_links_original ON refund_links(original_tx_id)`,
  // Mahnungen (schema v21): which reminder stage (1 freundlich · 2 bestimmt · 3 förmlich) was drafted
  // and which the owner CONFIRMED as sent, per outgoing invoice. invoice_id is a SOFT ref to the
  // back-end id like `invoice_mails` (a Qonto invoice has no row in `invoices`), so no FK. sent_at is
  // the date (YYYY-MM-DD) the owner says it went out — the app never sends; NULL = only drafted.
  `CREATE TABLE IF NOT EXISTS invoice_reminders (
     entity_id TEXT NOT NULL, invoice_id TEXT NOT NULL, stage INTEGER NOT NULL,
     invoice_number TEXT, drafted_at TEXT, sent_at TEXT,
     PRIMARY KEY (entity_id, invoice_id, stage))`,
  // Splitbuchungen (schema v22): one booking split into parts with their own category and VAT rate —
  // an overlay over the UNCHANGED bank transaction, keyed by the unified tx id and FK-free like
  // `classifications`. amount_cents is the part's gross in cents (positive); NULL marks the one part
  // that takes the remainder, recomputed from the booking on every read. vat_rate is a fraction (0.19).
  `CREATE TABLE IF NOT EXISTS booking_splits (
     tx_id TEXT NOT NULL, part_no INTEGER NOT NULL, category TEXT NOT NULL,
     amount_cents INTEGER, vat_rate REAL NOT NULL, note TEXT,
     decided_at TEXT NOT NULL, decided_by TEXT,
     PRIMARY KEY (tx_id, part_no))`,
  // Projektzuordnung (schema v23): which project an expense belongs to — a per-booking decision like
  // `booking_splits`, FK-free and keyed by the unified tx id. part_no 0 = the whole booking, n ≥ 1 = part
  // n of a split booking. project_id is the manifest project's id (a soft ref, like time_entries.project_id);
  // NULL is the decision „kein Projekt", which wins over a project rule.
  `CREATE TABLE IF NOT EXISTS booking_projects (
     tx_id TEXT NOT NULL, part_no INTEGER NOT NULL DEFAULT 0, project_id TEXT,
     decided_at TEXT NOT NULL, decided_by TEXT,
     PRIMARY KEY (tx_id, part_no))`,

  // --- Belege aus einem Mail-Ordner (schema v24) ---
  // Where the fetch of an entity's mail folder stopped: the UIDVALIDITY the UIDs belong to and the
  // highest UID processed. A new UIDVALIDITY makes every stored UID meaningless, so the pair travels
  // together. Only the position and the one-line result of the last run live here — no mail content.
  `CREATE TABLE IF NOT EXISTS mail_eingang_state (
     entity_id TEXT PRIMARY KEY, folder TEXT NOT NULL,
     uid_validity INTEGER, last_uid INTEGER NOT NULL DEFAULT 0,
     last_run_at TEXT, last_result TEXT)`,

  // --- Rechnung ↔ Projekt (schema v25) ---
  // Which project an outgoing invoice belongs to: a direct decision that wins over the link derived from
  // billed hours. invoice_id is a SOFT ref to the back-end id like `invoice_reminders` (self and Qonto),
  // project_id the manifest project's id. A row exists only while the invoice is assigned.
  `CREATE TABLE IF NOT EXISTS invoice_projects (
     entity_id TEXT NOT NULL, invoice_id TEXT NOT NULL, project_id TEXT NOT NULL,
     decided_at TEXT NOT NULL, decided_by TEXT,
     PRIMARY KEY (entity_id, invoice_id))`,
  // The time entries a DRAFT invoice reserves. They stay open (unbilled) until the invoice is finalized;
  // deleting the draft drops the reservation and leaves the entries open.
  `CREATE TABLE IF NOT EXISTS invoice_time_links (
     entity_id TEXT NOT NULL, invoice_id TEXT NOT NULL, entry_id TEXT NOT NULL,
     PRIMARY KEY (entity_id, invoice_id, entry_id))`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_time_links_entry ON invoice_time_links(entry_id)`,
];

// Versioned upgrade steps on top of the idempotent baseline. STATEMENTS always describe
// the CURRENT schema (a fresh database gets it in one pass and skips this list); an
// UPGRADES entry carries only what CREATE IF NOT EXISTS cannot express for an EXISTING
// database (ALTER TABLE, data backfills). Each entry runs once — when the persisted
// version is below `to` — inside a transaction. Same statement rules as STATEMENTS:
// one clean statement per string, no SQL comments.
const UPGRADES: ReadonlyArray<{ to: number; statements: readonly string[] }> = [
  // v5 → v6: activate the decision layer. The pre-v6 `classifications` table was an
  // unused scaffold keyed by `dedupe_key` with FKs to transactions/chart_of_accounts;
  // it is guaranteed empty (nothing ever wrote it), so we DROP + recreate it in the new
  // FK-free, `transaction_id`-keyed shape (with the ai_note columns). CREATE IF NOT EXISTS
  // in STATEMENTS is a no-op for the existing table, so the rebuild must happen here.
  { to: 6, statements: [`DROP TABLE IF EXISTS classifications`, CLASSIFICATIONS_TABLE] },
  // v6 → v7: add the immutable `filing_snapshots` table. Purely additive — a new table is fully
  // expressed by `CREATE TABLE IF NOT EXISTS` in STATEMENTS (which migrate() runs on every open,
  // for fresh AND existing databases), so per this file's doctrine it needs no UPGRADES entry; the
  // SCHEMA_VERSION bump to 7 records the addition. Existing rows are untouched.
  // v7 → v8: add the append-only `filing_signoffs` table. Purely additive, same as v6→v7 — the
  // `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so no UPGRADES
  // entry is needed; the SCHEMA_VERSION bump to 8 records the addition. Existing rows are untouched.
  // v8 → v9: add `submission_source` + `submitted_at` to `filing_snapshots`. CREATE IF NOT EXISTS
  // cannot add a column to an EXISTING table, so an ALTER runs here for pre-v9 databases (a fresh
  // database already has the columns from STATEMENTS and skips this list). Existing rows get NULL.
  {
    to: 9,
    statements: [
      `ALTER TABLE filing_snapshots ADD COLUMN submission_source TEXT`,
      `ALTER TABLE filing_snapshots ADD COLUMN submitted_at TEXT`,
    ],
  },
  // v9 → v10: split the single `filings.amount` into the DECLARED Anmeldungssoll and the
  // Säumniszuschlag (Nebenleistung). Purely additive — both columns nullable, existing rows keep
  // their `amount` (treated as the paid/legacy value) and get NULL for the new columns, so the USt
  // sums fall back to `amount` for legacy rows (see actions/filings.ts). CREATE IF NOT EXISTS cannot
  // add a column to an EXISTING table, so an ALTER runs here for pre-v10 databases; a fresh database
  // already has the columns from STATEMENTS and skips this list.
  {
    to: 10,
    statements: [
      `ALTER TABLE filings ADD COLUMN declared_amount REAL`,
      `ALTER TABLE filings ADD COLUMN surcharge REAL`,
    ],
  },
  // v10 → v11: add the `filing_documents` link table. Purely additive, same as v6→v7 — the
  // `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so no UPGRADES
  // entry is needed; the SCHEMA_VERSION bump to 11 records the addition. Existing rows are untouched.
  // v11 → v12: add the `time_entries` table (Zeiterfassung). Purely additive, same as v6→v7 — the
  // `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so no UPGRADES
  // entry is needed; the SCHEMA_VERSION bump to 12 records the addition. Existing rows are untouched.
  // v12 → v13: add the `tax_assessments` table (Bescheid-Kennzahlen je Veranlagungsjahr). Purely
  // additive, same as v6→v7 — the `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND
  // existing databases, so no UPGRADES entry is needed; the SCHEMA_VERSION bump to 13 records the
  // addition. Existing rows are untouched.
  // v13 → v14: add `period` to `filing_snapshots` and `filing_signoffs` — the sub-year scope, NULL
  // for the annual forms. CREATE IF NOT EXISTS cannot add a column to an EXISTING table, so ALTERs
  // run here for pre-v14 databases; a fresh database already has them from STATEMENTS and skips
  // this list. Existing rows get NULL, which is exactly right: every snapshot captured so far was
  // for an annual form (USt-VA had no snapshot path at all), and NULL is what annual means.
  {
    to: 14,
    statements: [
      `ALTER TABLE filing_snapshots ADD COLUMN period TEXT`,
      `ALTER TABLE filing_signoffs ADD COLUMN period TEXT`,
    ],
  },
  // v14 → v15: add `assessed_amount` + `assessed_at` to `filings` — what the Finanzamt assessed,
  // as opposed to what we declared (see the filings DDL comment for why that is a third number and
  // not a correction of declared_amount). CREATE IF NOT EXISTS cannot add a column to an EXISTING
  // table, so ALTERs run here for pre-v15 databases; a fresh database already has them from
  // STATEMENTS and skips this list. Existing rows get NULL, which reads as "no Bescheid recorded
  // yet" — the derivations then fall back to the declared figure exactly as before.
  {
    to: 15,
    statements: [
      `ALTER TABLE filings ADD COLUMN assessed_amount REAL`,
      `ALTER TABLE filings ADD COLUMN assessed_at TEXT`,
    ],
  },
  // v15 → v16: add `project_id` to `time_entries` — the soft ref to a project of the manifest (the
  // projects live in steuererklaerung.json, not here). CREATE IF NOT EXISTS cannot add a column to
  // an EXISTING table, so an ALTER runs here for pre-v16 databases; a fresh database already has it
  // from STATEMENTS and skips this list. Existing rows get NULL, which is exactly right: the free-text
  // `project` label stays the record of what they were worked on.
  {
    to: 16,
    statements: [`ALTER TABLE time_entries ADD COLUMN project_id TEXT`],
  },
  // v16 → v17: add the `invoice_mails` table (mail history per invoice). Purely additive, same as
  // v6→v7 — the `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so
  // no UPGRADES entry is needed; the SCHEMA_VERSION bump to 17 records the addition.
  // v17 → v18: add `invoice_kind` + `invoice_kind_reason` to `documents` — the §14 UStG
  // classification (E-Rechnung / sonstige Rechnung) read from the file itself. CREATE IF NOT EXISTS
  // cannot add a column to an EXISTING table, so ALTERs run here for pre-v18 databases; a fresh
  // database already has them from STATEMENTS and skips this list. Existing rows get NULL = not yet
  // classified, which the UI shows as no badge.
  {
    to: 18,
    statements: [
      `ALTER TABLE documents ADD COLUMN invoice_kind TEXT`,
      `ALTER TABLE documents ADD COLUMN invoice_kind_reason TEXT`,
    ],
  },
  // v18 → v19: add the `refund_links` table (Erstattungen). Purely additive, same as v6→v7 — the
  // `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so no UPGRADES
  // entry is needed; the SCHEMA_VERSION bump to 19 records the addition.
  // v19 → v20: add `category` + `rule_origin` to `documents` — the receipt's booking category and
  // WHICH Dokumentregel (id, label, fields as JSON) filled which field, so the document can say
  // „via Regel …" and a manual edit can take a field back out. Existing rows get NULL = no rule.
  {
    to: 20,
    statements: [`ALTER TABLE documents ADD COLUMN category TEXT`, `ALTER TABLE documents ADD COLUMN rule_origin TEXT`],
  },
  // v20 → v21: add the `invoice_reminders` table (Mahnungen). Purely additive, same as v6→v7 — the
  // `CREATE TABLE IF NOT EXISTS` in STATEMENTS covers fresh AND existing databases, so no UPGRADES
  // entry is needed; the SCHEMA_VERSION bump to 21 records the addition.
  // v21 → v22: add the `booking_splits` table (Splitbuchungen). Purely additive like v20 → v21.
  // v22 → v23: add the `booking_projects` table (Projektzuordnung). Purely additive like v21 → v22.
  // v23 → v24: add `documents.origin` (JSON: where a receipt came from — a mail sender and date, never the
  // message) and the `mail_eingang_state` table (purely additive). Existing rows get NULL = no recorded origin.
  {
    to: 24,
    statements: [`ALTER TABLE documents ADD COLUMN origin TEXT`],
  },
  // v24 → v25: add the `invoice_projects` and `invoice_time_links` tables (Rechnung ↔ Projekt, Zeiten →
  // Rechnung). Purely additive like v22 → v23 — no UPGRADES entry; the SCHEMA_VERSION bump records it.
];

/** True when the database carries no schema yet (fresh file or :memory:). */
function isFreshDatabase(db: LedgerDatabase): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`)
    .get();
  return row == null;
}

/**
 * Whether `table` already has a column named `column`. Reads the stored CREATE-TABLE SQL from
 * sqlite_master (which SQLite rewrites in place on every `ALTER TABLE … ADD COLUMN`, so it reflects
 * ALTER-added columns too), matching the column name as a standalone identifier token. Used to make
 * additive `ADD COLUMN` upgrades idempotent (see {@link execUpgradeStatement}).
 */
function tableHasColumn(db: LedgerDatabase, table: string, column: string): boolean {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string | null }
    | undefined;
  const sql = row?.sql;
  if (!sql) return false;
  return new RegExp(`\\b${column}\\b`).test(sql);
}

/**
 * Execute one upgrade statement idempotently. An `ALTER TABLE <t> ADD COLUMN <c> …` is SKIPPED when
 * the column already exists — SQLite has no `ADD COLUMN IF NOT EXISTS`, and an additive migration
 * must tolerate a database whose prior run half-applied (the ALTER committed but the schema_version
 * bump did not persist, e.g. an interrupted process): re-running must not die on a duplicate column.
 * All other statements run unchanged.
 */
function execUpgradeStatement(db: LedgerDatabase, stmt: string): void {
  const addColumn = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b/i.exec(stmt);
  if (addColumn && tableHasColumn(db, addColumn[1], addColumn[2])) return;
  db.exec(stmt);
}

/**
 * Create/upgrade the schema and record the schema version (idempotent). A fresh database
 * gets the current schema straight from the baseline; an existing one additionally runs
 * the versioned UPGRADES between its persisted version and {@link SCHEMA_VERSION}.
 */
export function migrate(db: LedgerDatabase): void {
  const from = isFreshDatabase(db) ? SCHEMA_VERSION : schemaVersion(db);
  for (const stmt of STATEMENTS) db.exec(stmt);
  for (const upgrade of UPGRADES) {
    if (upgrade.to <= from) continue;
    withTransaction(db, () => {
      for (const stmt of upgrade.statements) execUpgradeStatement(db, stmt);
    });
  }
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

/** Read the persisted schema version (0 if uninitialised). */
export function schemaVersion(db: LedgerDatabase): number {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
