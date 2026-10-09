/**
 * Classification-decision orchestration (S2 — the core decision layer) shared by the CLI, MCP and
 * the future desktop UI.
 *
 * Persists a per-transaction bookkeeping decision — a manual reclassification (owner books a tx
 * under a different SKR03 category), the owner's Begründung (`note`), and the acceptance/override of
 * an AI rationale — into the store's `classifications` table, and appends every decision to the
 * append-only decision log (`audit_log`). The EÜR aggregate then honours a MANUAL decision (via
 * {@link loadManualOverrides}) so a correction flows through to every derived form.
 *
 * Store-scoped like actions/filings.ts + actions/contacts.ts: the single ledger DB next to the
 * NDJSON store (`<store>/ledger.db`, overridable via `LEDGER_DB_PATH`).
 */

import {
    type ClassificationRecord,
    type ClassificationStatus,
    type ClassificationDecisionSource,
    type DecisionLogEntry,
    type LedgerDatabase,
    getClassification,
    getClassifications,
    getDecisionLog as getDecisionLogRepo,
    getManualOverrides,
    ledgerDbExists,
    ledgerDbPath,
    migrate,
    openLedger,
    removeClassification,
    setClassification,
} from '@steuererklaerung/store';
import type { EuerManualOverride } from '../elster/euer-transactions.ts';

/** Open + migrate + close the ledger around a synchronous `fn` (mirrors actions/filings.ts). */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

/** Input for {@link recordClassificationDecision}. `transactionId` is the unified tx id. */
export interface ClassificationDecisionInput {
    transactionId: string;
    /** SKR03 category label to book the tx under (a MANUAL override wins over document + rule). */
    category?: string | null;
    /** Owner Begründung ("warum habe ich das so gebucht"). */
    note?: string | null;
    /** Who decided (a human id / 'cli' / 'mcp' / a model id). */
    decidedBy?: string | null;
    /** Verification state; defaults to `confirmed` when a category is set / an AI rationale accepted. */
    status?: ClassificationStatus;
    /** `manual` (default) = an explicit owner decision. */
    source?: ClassificationDecisionSource;
    /** Paperless document id backing the decision, if any. */
    documentId?: number | null;
    /** The AI rationale text (kept for accept/override provenance). */
    aiNote?: string | null;
    /** Owner accepted the AI rationale (accept = true; overriding = record a new category instead). */
    aiNoteAccepted?: boolean | null;
}

/**
 * Record (insert or merge) a per-transaction bookkeeping decision + append it to the decision log.
 * A decision must carry at least one of: a `category` (reclassification), a `note` (Begründung) or
 * an `aiNoteAccepted` flag — otherwise there is nothing to record. Defaults `source='manual'` and,
 * when a category is set or an AI rationale is accepted, `status='confirmed'`.
 */
export function recordClassificationDecision(input: ClassificationDecisionInput): ClassificationRecord {
    const transactionId = input.transactionId?.trim();
    if (!transactionId) throw new Error('recordClassificationDecision: transactionId is required.');
    const hasChange =
        input.category != null || input.note != null || input.aiNoteAccepted != null || input.documentId != null;
    if (!hasChange) {
        throw new Error(
            'recordClassificationDecision: nothing to record — provide a category, a note, or aiNoteAccepted.',
        );
    }
    return withLedger((db) => {
        // A note (or AI acceptance) on a booking confirmed in „Zu prüfen" must not turn that
        // confirmation — a `source='rule'` row WITH a category — into a manual override of the same
        // category, which the EÜR would then honour. Without a new category it stays a confirmation.
        const existing = getClassification(db, transactionId);
        const keepsConfirmation = input.category == null && input.source == null && existing?.source === 'rule';
        const status: ClassificationStatus =
            input.status ??
            (keepsConfirmation
                ? existing.status
                : input.category != null || input.aiNoteAccepted === true
                  ? 'confirmed'
                  : 'open');
        return setClassification(
            db,
            transactionId,
            {
                category: input.category,
                note: input.note,
                decidedBy: input.decidedBy,
                status,
                source: input.source ?? (keepsConfirmation ? 'rule' : 'manual'),
                documentId: input.documentId,
                aiNote: input.aiNote,
                aiNoteAccepted: input.aiNoteAccepted,
            },
            nowIso(),
        );
    });
}

/** The persisted decision for one transaction, or null. */
export function getClassificationDecision(transactionId: string): ClassificationRecord | null {
    return withLedger((db) => getClassification(db, transactionId));
}

/** Decisions for the given tx ids (or all), keyed by transaction id. */
export function listClassificationDecisions(transactionIds?: string[]): Map<string, ClassificationRecord> {
    return withLedger((db) => getClassifications(db, transactionIds));
}

/** The append-only decision log for one transaction (oldest → newest). */
export function getDecisionLog(transactionId: string): DecisionLogEntry[] {
    return withLedger((db) => getDecisionLogRepo(db, transactionId));
}

/** Remove the decision for one transaction; true if one was removed (append `classification.remove`). */
export function removeClassificationDecision(transactionId: string): boolean {
    return withLedger((db) => removeClassification(db, transactionId, nowIso()));
}

/**
 * Restore a transaction's decision to a captured prior state — the Undo write. With a prior record,
 * every mutable field is written back explicitly (the merge-upsert overwrites them all, so the row
 * ends up exactly as captured); without one, the decision is removed entirely. Both paths append to
 * the decision log like every other write.
 */
export function restoreClassificationDecision(transactionId: string, prior: ClassificationRecord | null): void {
    if (prior == null) {
        removeClassificationDecision(transactionId);
        return;
    }
    withLedger((db) =>
        setClassification(
            db,
            transactionId,
            {
                category: prior.category,
                net: prior.net,
                vat: prior.vat,
                status: prior.status,
                source: prior.source,
                documentId: prior.documentId,
                note: prior.note,
                aiNote: prior.aiNote,
                aiNoteAccepted: prior.aiNoteAccepted,
                decidedBy: prior.decidedBy,
            },
            nowIso(),
        ),
    );
}

/**
 * Load the MANUAL overrides the EÜR aggregate must honour, as the map the pure aggregate consumes
 * (keyed by unified tx id). Optionally scoped to a set of tx ids (the year's bookings) so the query
 * is cheap. READ-ONLY + side-effect-free: when no ledger DB exists yet (a fresh store), returns an
 * empty map WITHOUT creating the DB — so a plain EÜR report on a store that never recorded a
 * decision behaves exactly as before. Any error degrades to "no overrides" rather than breaking the
 * report.
 */
export function loadManualOverrides(transactionIds?: string[]): Map<string, EuerManualOverride> {
    try {
        if (!ledgerDbExists()) return new Map();
        const records = withLedger((db) => getManualOverrides(db, transactionIds));
        const out = new Map<string, EuerManualOverride>();
        for (const [id, r] of records) {
            if (r.category == null) continue;
            out.set(id, { category: r.category, note: r.note, decidedBy: r.decidedBy });
        }
        return out;
    } catch {
        return new Map();
    }
}

/**
 * Confirm a booking's CURRENT category from „Zu prüfen" without changing what the EÜR books.
 *
 * Stored as a `source='rule'`, `status='confirmed'` row with the category the person saw. The
 * aggregate honours only `source='manual'` rows ({@link loadManualOverrides}), so the confirmation
 * is inert for every figure: no net/VAT re-derivation, no freezing the category against a later rule
 * fix, no lost Doppelzahlung neutralisation — all of which a manual decision with the same category
 * would have caused. A manual decision is never overwritten by a confirmation.
 */
export function confirmClassification(input: {
    transactionId: string;
    category: string;
    decidedBy?: string | null;
}): ClassificationRecord {
    const transactionId = input.transactionId?.trim();
    if (!transactionId) throw new Error('confirmClassification: transactionId is required.');
    if (!input.category?.trim()) throw new Error('confirmClassification: category is required.');
    return withLedger((db) => {
        const existing = getClassification(db, transactionId);
        if (existing?.source === 'manual' && existing.category != null) {
            throw new Error('Die Buchung ist manuell umgebucht — eine Bestätigung ändert daran nichts.');
        }
        return setClassification(
            db,
            transactionId,
            { category: input.category, source: 'rule', status: 'confirmed', decidedBy: input.decidedBy },
            nowIso(),
        );
    });
}

/**
 * The „Zu prüfen" confirmations as tx id → confirmed category. READ-ONLY like
 * {@link loadManualOverrides}: no ledger DB yet means no confirmations, and nothing is created.
 */
export function loadConfirmedClassifications(transactionIds?: string[]): Map<string, string> {
    const out = new Map<string, string>();
    try {
        if (!ledgerDbExists()) return out;
        for (const [id, r] of withLedger((db) => getClassifications(db, transactionIds))) {
            if (r.source === 'rule' && r.status === 'confirmed' && r.category != null) out.set(id, r.category);
        }
    } catch {
        return new Map();
    }
    return out;
}
