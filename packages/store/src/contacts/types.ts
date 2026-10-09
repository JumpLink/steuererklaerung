/**
 * Contact (party) model for the unified contact master. A contact is one real-world party that
 * may be a customer (we invoice them — Qonto client + outgoing documents) and/or a supplier /
 * correspondent (we receive documents from them — Paperless correspondent). The store is the
 * system of record; external back-end ids live in `links` (see contact_links).
 */

export type ContactKind = 'company' | 'individual' | 'freelancer' | 'organization';

/** External back-ends a contact can be linked to. */
export type ContactSystem = 'qonto' | 'paperless';

/** A link from a contact to one external back-end record. */
export interface ContactLink {
    system: ContactSystem;
    externalId: string;
    /** ISO timestamp of the last successful sync to/from the back-end, or null if never. */
    syncedAt: string | null;
}

/** A contact as stored (camelCase view of the `contacts` row + its links). */
export interface Contact {
    id: string;
    /** Workspace entity id (gbr|jumplink|privat) — a free scoping tag. */
    entityId: string;
    kind: ContactKind;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    vatNumber: string | null;
    taxId: string | null;
    iban: string | null;
    currency: string;
    locale: string;
    address: string | null;
    zip: string | null;
    city: string | null;
    countryCode: string | null;
    isCustomer: boolean;
    isSupplier: boolean;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    links: ContactLink[];
}

/** Writable fields for creating/updating a contact (id optional → generated on insert). */
export interface ContactInput {
    id?: string;
    entityId: string;
    kind?: ContactKind;
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    vatNumber?: string | null;
    taxId?: string | null;
    iban?: string | null;
    currency?: string;
    locale?: string;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    countryCode?: string | null;
    isCustomer?: boolean;
    isSupplier?: boolean;
    notes?: string | null;
}

/** Display name regardless of kind: company/display name, else "First Last", else the id. */
export function contactDisplayName(c: Pick<Contact, 'name' | 'firstName' | 'lastName' | 'id'>): string {
    if (c.name?.trim()) return c.name.trim();
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return full || c.id;
}
