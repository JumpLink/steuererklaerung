/**
 * Pure contact-matching for imports. When pulling Qonto clients / Paperless correspondents we must
 * decide whether an incoming record is a NEW contact or one we already have. Identity is matched on
 * strong keys first (VAT id, then email), falling back to a normalized display name — name alone is
 * unreliable, so it is the last resort. No I/O here so it stays unit-testable.
 */

import { contactDisplayName, type Contact } from './types.ts';

/** The subset of fields an incoming external record can offer for matching. */
export interface ContactMatchCandidate {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    vatNumber?: string | null;
}

/** Lowercase, trim, collapse internal whitespace. */
function normName(s: string | null | undefined): string {
    return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Uppercase, strip all whitespace (VAT ids are written with stray spaces). */
function normVat(s: string | null | undefined): string {
    return (s ?? '').toUpperCase().replace(/\s+/g, '');
}
function normEmail(s: string | null | undefined): string {
    return (s ?? '').toLowerCase().trim();
}

function candidateName(c: ContactMatchCandidate): string {
    if (c.name?.trim()) return c.name.trim();
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Find the existing contact that best identifies `candidate`, or null if none.
 * Priority: VAT id → email → normalized display name.
 */
export function matchContact(candidate: ContactMatchCandidate, existing: Contact[]): Contact | null {
    const vat = normVat(candidate.vatNumber);
    if (vat) {
        const byVat = existing.find((c) => normVat(c.vatNumber) === vat);
        if (byVat) return byVat;
    }
    const email = normEmail(candidate.email);
    if (email) {
        const byEmail = existing.find((c) => normEmail(c.email) === email);
        if (byEmail) return byEmail;
    }
    const name = normName(candidateName(candidate));
    if (name) {
        const byName = existing.find((c) => normName(contactDisplayName(c)) === name);
        if (byName) return byName;
    }
    return null;
}
