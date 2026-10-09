/**
 * @steuererklaerung/store — the local data store: the unified NDJSON transaction store
 * (memoized) + its read/query surface, and the SQLite ledger core (schema, periods,
 * entity mapping, path). The DMS and the future native GNOME app build on this; the CLI
 * keeps the sync/normalize/EÜR-seeding side on top of it. Pure TS, Node + GJS.
 */

// Transaction store + model + query
export * from "./transactions/store.ts";
export * from "./transactions/unified.ts";
export * from "./transactions/search.ts";
export * from "./transactions/statements.ts";

// SQLite ledger core
export * from "./ledger/db.ts";
export * from "./ledger/schema.ts";
export * from "./ledger/periods.ts";
export * from "./ledger/types.ts";
export * from "./ledger/entities.ts";
export * from "./ledger/path.ts";

// Per-transaction bookkeeping decisions (the decision layer)
export * from "./classifications/types.ts";
export * from "./classifications/repo.ts";

// Erstattungen: refund → original debit links and rejected candidates
export * from "./refunds/types.ts";
export * from "./refunds/repo.ts";

// Splitbuchungen: one booking split into parts (overlay over the unchanged transaction)
export * from "./splits/types.ts";
export * from "./splits/repo.ts";

// Projektzuordnung: which project an expense belongs to (a per-booking decision)
export * from "./project-links/types.ts";
export * from "./project-links/repo.ts";
export * from "./invoice-projects/types.ts";
export * from "./invoice-projects/repo.ts";

// Belege aus einem Mail-Ordner: where the last fetch stopped (UID + UIDVALIDITY) and what it said
export * from "./mail-eingang/types.ts";
export * from "./mail-eingang/repo.ts";

// Contacts (parties) master
export * from "./contacts/types.ts";
export * from "./contacts/repo.ts";
export * from "./contacts/match.ts";
export * from "./time/types.ts";
export * from "./time/repo.ts";

// Filing register (Fristen "erledigt")
export * from "./filings/types.ts";
export * from "./filings/repo.ts";

// Immutable filing snapshots (durable submission object + drift detection)
export * from "./filings/snapshots.ts";

// Fingerprint-bound filing sign-offs (the human release a submission gate binds to)
export * from "./filings/signoffs.ts";

// Filing-document links (Bescheide / Finanzamt letters / proofs attached to a register entry)
export * from "./filings/documents.ts";

// Assessed tax key figures per Veranlagungsjahr (zvE read off a Steuerbescheid, with its document)
export * from "./tax/types.ts";
export * from "./tax/repo.ts";

// Outgoing invoices (self provider)
export * from "./invoices/types.ts";
export * from "./invoices/totals.ts";
export * from "./invoices/numbering.ts";
export * from "./invoices/validate.ts";
export * from "./invoices/repo.ts";
export * from "./invoices/mail-log.ts";
export * from "./invoices/reminders.ts";
