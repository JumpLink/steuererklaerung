/**
 * How a submitted form is named in the filing register — in ONE place.
 *
 * The register is keyed by `(entityId, kind, period)`, and two different code
 * paths submit: `recordWebFiling` (a filing made by hand in Mein ELSTER, typed
 * in afterwards) and `submitFiling` (the tool's own ERiC transmission). They
 * must agree on the key or the same filing lands twice under two names — and a
 * second copy of this mapping is exactly how they would drift apart.
 */

/** The forms that can be filed at all. `est` has no XML builder yet, so it is web-only. */
export const FILING_FORMS = ['ustva', 'euer', 'uste', 'gewst', 'feststellung', 'est'] as const;
export type FilingForm = (typeof FILING_FORMS)[number];

/** Map a form to its filing-register `kind` (the Steuertermine vocabulary; `uste` ⇒ annual `ust-jahr`). */
export function filingKindForForm(form: FilingForm): string {
    switch (form) {
        case 'uste':
            return 'ust-jahr';
        case 'ustva':
            return 'ustva';
        case 'euer':
            return 'euer';
        case 'gewst':
            return 'gewst';
        case 'feststellung':
            return 'feststellung';
        case 'est':
            return 'est';
    }
}

/**
 * The register `period` for a submission that already knows its scope.
 *
 * `scope` is the sub-year label a periodic form carries (`2025-Q1`, `2025-03`);
 * annual forms pass nothing and key on the bare year. Recording a USt-VA under
 * the bare year would make Q1..Q4 overwrite each other and silently corrupt the
 * Vorauszahlungssoll (Z119), which sums the year's UStVA rows.
 */
export function filingPeriodForScope(form: FilingForm, year: number, scope?: string | null): string {
    if (form !== 'ustva') return String(year);
    const label = (scope ?? '').trim();
    if (!label) {
        throw new Error('Eine USt-VA braucht ihren Voranmeldungszeitraum (z. B. 2025-Q1) für das Register.');
    }
    if (!new RegExp(`^${year}-(Q[1-4]|(0[1-9]|1[0-2]))$`).test(label)) {
        throw new Error(`Zeitraum '${label}' passt nicht zu ${year} — erwartet ${year}-Q1..Q4 oder ${year}-01..12.`);
    }
    return label;
}

/**
 * The inverse: which form a register `kind` came from.
 *
 * Needed by the deadline layer, which derives its keys from the Steuertermine
 * vocabulary and has to look up the matching submission evidence.
 */
export function formForFilingKind(kind: string): FilingForm | null {
    if (kind === 'ust-jahr') return 'uste';
    return (FILING_FORMS as readonly string[]).includes(kind) ? (kind as FilingForm) : null;
}
