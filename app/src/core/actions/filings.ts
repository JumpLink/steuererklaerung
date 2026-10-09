/**
 * Filing register orchestration shared by the CLI, MCP and the Fristen views.
 *
 * The register records which statutory declarations/payments are done (see store `filings`), so the
 * proactive Steuertermine layer can mark a period as eingereicht/bezahlt instead of nagging forever,
 * and the annual USt reconciliation can read the year's already-filed Vorauszahlungen.
 */

import {
    addFilingDocument,
    entityIdAliases,
    type Filing,
    type FilingDocument,
    type FilingDocumentInput,
    type FilingInput,
    getFiling,
    type LedgerDatabase,
    ledgerDbPath,
    listFilingDocuments as listFilingDocumentsRepo,
    listFilings as listFilingsRepo,
    migrate,
    openLedger,
    removeFiling as removeFilingRepo,
    removeFilingDocument as removeFilingDocumentRepo,
    upsertFiling,
} from '@steuererklaerung/store';

/** Open + migrate + close the ledger around a synchronous `fn` (mirrors actions/contacts.ts). */
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

/** Record (insert or merge) a filing for one obligation. */
export function recordFiling(input: FilingInput): Filing {
    return withLedger((db) => upsertFiling(db, input, nowIso()));
}

/** List filings, optionally scoped to an entity and/or year (newest period first). */
export function listFilings(opts: { entityId?: string; year?: number } = {}): Filing[] {
    return withLedger((db) => listFilingsRepo(db, opts));
}

/** Delete a filing; returns true if one was removed. */
export function removeFiling(entityId: string, kind: string, period: string): boolean {
    return withLedger((db) => removeFilingRepo(db, entityId, kind, period));
}

/**
 * Attach a DMS document (Bescheid, Mahnung, Übertragungsprotokoll, Zahlungsbeleg, …) to a filing.
 * Fail-loud when the register has no such entry — a document must never dangle on a filing that
 * was not recorded (record the filing first, then attach). Re-attaching the same documentRef
 * merge-updates role/note.
 */
export function attachFilingDocument(input: FilingDocumentInput): FilingDocument {
    return withLedger((db) => {
        if (!getFiling(db, input.entityId, input.kind, input.period)) {
            throw new Error(
                `Kein Register-Eintrag für ${input.entityId} · ${input.kind} · ${input.period} — ` +
                    `erst die Einreichung erfassen (filing record / record_filing), dann das Dokument zuordnen.`,
            );
        }
        return addFilingDocument(db, input, nowIso());
    });
}

/** List filing-document links, optionally scoped by entity / kind / period / documentRef. */
export function listFilingDocuments(
    opts: { entityId?: string; kind?: string; period?: string; documentRef?: string } = {},
): FilingDocument[] {
    return withLedger((db) => listFilingDocumentsRepo(db, opts));
}

/** Detach one document from a filing; returns true if a link was removed. */
export function detachFilingDocument(entityId: string, kind: string, period: string, documentRef: string): boolean {
    return withLedger((db) => removeFilingDocumentRepo(db, entityId, kind, period, documentRef));
}

/**
 * The Anmeldungssoll of one filing: the DECLARED Zahllast (`declaredAmount`), falling back to the
 * legacy `amount` for pre-v10 rows that predate the declared/paid/surcharge split. This is the ONLY
 * value that feeds the USt sums — never the payment (`amount` may include a Säumniszuschlag) and
 * never the `surcharge` (a steuerliche Nebenleistung, not Umsatzsteuer). Null when neither is set.
 */
function declaredSoll(f: Filing): number | null {
    return f.declaredAmount ?? f.amount ?? null;
}

/**
 * Σ of the year's filed USt-VA Anmeldungssoll (declared Zahllast) for one entity, from a pre-fetched
 * filings list — the value the annual USt-Jahreserklärung's Vorauszahlungssoll (Z119) uses. Sums the
 * DECLARED amount (see {@link declaredSoll}), NOT the payment: a Säumniszuschlag (§240 AO) is a
 * steuerliche Nebenleistung, not USt, so it must never land in Z119. Alias-tolerant: matches the
 * entity under EITHER namespace (ledger `artcode` ⇔ workspace `gbr`), since the register may hold
 * whichever id the user typed while the caller often only has the ELSTER config's ledger `entity_id`.
 * Returns null when there is no such USt-VA filing, so callers can fall back to `uste.prepaid_vat`
 * rather than trust a 0.
 */
export function sumFiledUstvaVat(filings: Filing[], entityId: string): number | null {
    const aliases = new Set(entityIdAliases(entityId));
    const ustva = filings.filter(
        (f) => aliases.has(f.entityId) && f.kind === 'ustva' && f.filedAt != null && declaredSoll(f) != null,
    );
    if (ustva.length === 0) return null;
    return Math.round(ustva.reduce((s, f) => s + (declaredSoll(f) ?? 0), 0) * 100) / 100;
}

/**
 * The entity's filed USt-VA of the given years with their declared Zahllast ({@link declaredSoll}) —
 * what the „USt-Abweichung" check compares against. Alias-tolerant like {@link sumFiledUstvaVat}.
 */
export function erklaerteUstva(entityId: string, years: readonly number[]): { period: string; zahllast: number }[] {
    const aliases = new Set(entityIdAliases(entityId));
    return withLedger((db) =>
        years.flatMap((year) =>
            listFilingsRepo(db, { year })
                .filter((f) => aliases.has(f.entityId) && f.kind === 'ustva' && f.filedAt != null)
                .flatMap((f) => {
                    const soll = declaredSoll(f);
                    return soll == null ? [] : [{ period: f.period, zahllast: soll }];
                }),
        ),
    );
}

/**
 * The register-backed value for the annual USt Vorauszahlungssoll — an alternative to the manual
 * `uste.prepaid_vat` config. Reads the whole year's register once and sums the entity's filed
 * USt-VA Zahllasten (see {@link sumFiledUstvaVat}). Returns null when none are recorded.
 */
export function prepaidVatFromFilings(entityId: string, year: number): number | null {
    return withLedger((db) => sumFiledUstvaVat(listFilingsRepo(db, { year }), entityId));
}
