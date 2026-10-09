/**
 * Assessed tax key figures per Veranlagungsjahr (schema v13) — values READ OFF a Steuerbescheid,
 * never recomputed. The app's own ESt module produces a *Schätzung* (see elster/est-berechnung.ts);
 * this table holds the other kind of number: what the Finanzamt actually assessed, with a pointer to
 * the document it was taken from, so any consumer can tell a binding figure from an estimate.
 *
 * Today exactly one figure is captured, the **zu versteuerndes Einkommen** (zvE, §2 Abs. 5 EStG) —
 * it is what income-dependent subsidy programmes ask for. Further assessed figures (festgesetzte
 * ESt, Solidaritätszuschlag, …) are additive `ALTER TABLE … ADD COLUMN` steps on this same row.
 *
 * Keyed by (entityId, year): entityId is the WORKSPACE entity id (gbr|jumplink|privat), matching
 * `filings` and `periods`. One row per assessed year — an Änderungsbescheid REPLACES the figure
 * (and its documentRef), it does not append: the register answers "what does the current Bescheid
 * for this year say", not "which Bescheide have ever existed" (that history is `filing_documents`).
 */

/**
 * Where a zvE figure came from — the distinction consumers must never lose.
 *
 * This TABLE only ever holds `bescheid` rows; the union is the shared vocabulary of the READ API
 * (app `core/actions/zve.ts`), which can also hand out a labelled estimate. It lives here for the
 * same reason `FilingDocumentRole` does (filings/types.ts): the domain vocabulary belongs with the
 * domain types, even where the schema itself does not constrain it.
 */
export type ZvESource =
    /** Read off a Steuerbescheid; binding, and backed by {@link TaxAssessment.documentRef}. */
    | 'bescheid'
    /** Derived from the app's own ESt calculation — an estimate, never a Bescheid value. */
    | 'schaetzung';

export interface TaxAssessment {
    entityId: string;
    /** Veranlagungsjahr (assessment year), e.g. 2024. */
    year: number;
    /**
     * Zu versteuerndes Einkommen in EUR as stated in the Bescheid (§2 Abs. 5 EStG). Stored as REAL
     * euros like every other money column; a Bescheid states it in full euros, so the fraction is
     * normally 0.
     */
    zve: number;
    /**
     * DMS-agnostic reference to the Steuerbescheid the figure was read from — `paperless:<id>` for
     * a Paperless-ngx document, a plain store `documents.id` for the built-in DMS. FK-free like
     * `filing_documents.document_ref`, so the reference survives an entity switching DMS backend.
     * Null when the figure was entered without naming its document (then it is unverifiable —
     * callers should surface that).
     */
    documentRef: string | null;
    note: string | null;
    /**
     * Erfassungsdatum (ISO): when this figure was captured from the Bescheid. Refreshed on every
     * write, because re-recording IS a new capture (typically from an Änderungsbescheid).
     */
    recordedAt: string;
    /** First capture for this (entity, year) — kept across re-records for the audit trail. */
    createdAt: string;
}

/** Upsert payload. `documentRef`/`note` omitted are PRESERVED on an existing row; null clears them. */
export interface TaxAssessmentInput {
    entityId: string;
    year: number;
    zve: number;
    documentRef?: string | null;
    note?: string | null;
}
