/**
 * Filing register types (schema v5; declared_amount + surcharge v10, assessed_amount v15). A `Filing` records that a statutory declaration/payment for
 * one obligation has been submitted and/or paid — the "erledigt" side of the Fristen system.
 * Keyed by (entityId, kind, period): entityId is the WORKSPACE entity id (gbr|jumplink|privat),
 * kind mirrors the Steuertermine kinds, period is '2026-Q2' | '2026-03' | '2025'.
 */

/** Obligation kind — same vocabulary as SteuerTerminKind (plus est/dauerfrist/sonstige for manual entries). */
export type FilingKind = 'ustva' | 'ust-jahr' | 'euer' | 'feststellung' | 'gewst' | 'est' | 'dauerfrist' | 'sonstige';

export interface Filing {
    entityId: string;
    /** Obligation kind (see FilingKind); stored as free text so a future kind needs no migration. */
    kind: string;
    /** Period label, e.g. '2026-Q2' (USt-VA) or '2025' (annual). */
    period: string;
    /** Submission date (YYYY-MM-DD), or null if not yet filed. */
    filedAt: string | null;
    /** Payment date (YYYY-MM-DD), or null if not yet paid / not payment-relevant. */
    paidAt: string | null;
    /**
     * Amount actually PAID in EUR (signed) / the legacy column, or null. For a USt-VA this is the
     * transfer that hit the bank (which may include a Säumniszuschlag); it is NOT the authoritative
     * Soll — use {@link declaredAmount} for anything that feeds the USt sums (Z119).
     */
    amount: number | null;
    /**
     * Anmeldungssoll — the Zahllast as DECLARED in the Voranmeldung (USt-VA Kz 83), in EUR (signed),
     * or null. This is the authoritative Soll: the annual USt-Jahreserklärung's Vorauszahlungssoll
     * (Z119) sums ONLY declared quarterly USt-VA amounts (falling back to {@link amount} for legacy
     * rows). A payment or a Säumniszuschlag must never be written here.
     */
    declaredAmount: number | null;
    /**
     * Säumniszuschlag / steuerliche Nebenleistung (§240 AO, §3 Abs. 4 AO) in EUR (signed), or null.
     * This is NOT Umsatzsteuer, so it never enters the USt sums — recorded only to reconcile the
     * payment (paid = declaredAmount + surcharge).
     */
    surcharge: number | null;
    /**
     * What the FINANZAMT assessed for this obligation, in EUR (signed), or null when no Bescheid
     * has been recorded yet. Positive = still owed, negative = Erstattung.
     *
     * Deliberately a THIRD number beside {@link declaredAmount} and {@link amount}: the Finanzamt
     * settles against ITS own Vorauszahlungssoll, which knows payments this register never saw, so
     * the assessed figure routinely differs from the declared one. Writing it over
     * {@link declaredAmount} would destroy the one comparison that shows whether a Bescheid is
     * right — and would corrupt the Z119 sums, which must keep summing what we DECLARED.
     */
    assessedAmount: number | null;
    /** Date of the Bescheid/Abrechnung the assessed figure was read from (YYYY-MM-DD), or null. */
    assessedAt: string | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Upsert payload. Omitted fields are PRESERVED on an existing row (merge); pass null to clear. */
export interface FilingInput {
    entityId: string;
    kind: string;
    period: string;
    filedAt?: string | null;
    paidAt?: string | null;
    /** Amount actually paid / legacy value in EUR (see {@link Filing.amount}). */
    amount?: number | null;
    /** Anmeldungssoll (declared Zahllast) in EUR — the authoritative Soll (see {@link Filing.declaredAmount}). */
    declaredAmount?: number | null;
    /** Säumniszuschlag / Nebenleistung in EUR (see {@link Filing.surcharge}). */
    surcharge?: number | null;
    /** Amount the Finanzamt assessed in EUR — negative = Erstattung (see {@link Filing.assessedAmount}). */
    assessedAmount?: number | null;
    /** Date of the Bescheid the assessed figure came from (see {@link Filing.assessedAt}). */
    assessedAt?: string | null;
    note?: string | null;
}

/**
 * Role of a document attached to a filing (schema v11). Stored as free text so a future role
 * needs no migration; these are the known values the CLI/MCP offer.
 */
export type FilingDocumentRole =
    | 'bescheid'
    | 'mahnung'
    | 'uebertragungsprotokoll'
    | 'zahlungsbeleg'
    | 'schreiben'
    | 'sonstiges';

/**
 * A document attached to one filing-register entry (schema v11) — the Finanzamt response
 * (Bescheid, Mahnung, Schreiben) or supporting proof (Übertragungsprotokoll, Zahlungsbeleg)
 * for a submitted declaration. Keyed by (entityId, kind, period, documentRef); the filing
 * itself is keyed by the first three, so one filing can carry many documents.
 */
export interface FilingDocument {
    entityId: string;
    kind: string;
    period: string;
    /**
     * DMS-agnostic document reference — `paperless:<id>` for a Paperless-ngx document, a plain
     * store `documents.id` for the built-in DMS. Free text (FK-free like the snapshots) so the
     * register never breaks when an entity switches its DMS backend.
     */
    documentRef: string;
    /** Role (see {@link FilingDocumentRole}); stored as free text. */
    role: string;
    note: string | null;
    createdAt: string;
}

/** Attach payload. Re-attaching the same documentRef merge-updates role/note. */
export interface FilingDocumentInput {
    entityId: string;
    kind: string;
    period: string;
    documentRef: string;
    /** Defaults to 'sonstiges'. */
    role?: string;
    note?: string | null;
}
