/**
 * Contacts data access on the SQLite `contacts` + `contact_links` tables (schema v3).
 *
 * Pure data layer: every mutation takes an `at` ISO timestamp from the caller (like periods.ts)
 * so it stays testable; ids are generated with crypto.randomUUID() when not supplied. The store
 * is the system of record — external back-end ids (Qonto client, Paperless correspondent) are
 * held in contact_links and matched/linked by the import logic, never overwritten blindly.
 */

import type { LedgerDatabase } from '../ledger/db.ts';
import type { Contact, ContactInput, ContactLink, ContactSystem } from './types.ts';

interface ContactRow {
    id: string;
    entity_id: string;
    kind: string;
    name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    vat_number: string | null;
    tax_id: string | null;
    iban: string | null;
    currency: string;
    locale: string;
    address: string | null;
    zip: string | null;
    city: string | null;
    country_code: string | null;
    is_customer: number;
    is_supplier: number;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

interface LinkRow {
    contact_id: string;
    system: string;
    external_id: string;
    synced_at: string | null;
}

function rowToContact(row: ContactRow, links: ContactLink[]): Contact {
    return {
        id: row.id,
        entityId: row.entity_id,
        kind: row.kind as Contact['kind'],
        name: row.name,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        vatNumber: row.vat_number,
        taxId: row.tax_id,
        iban: row.iban,
        currency: row.currency,
        locale: row.locale,
        address: row.address,
        zip: row.zip,
        city: row.city,
        countryCode: row.country_code,
        isCustomer: row.is_customer !== 0,
        isSupplier: row.is_supplier !== 0,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        links,
    };
}

function linkRowToLink(row: LinkRow): ContactLink {
    return { system: row.system as ContactSystem, externalId: row.external_id, syncedAt: row.synced_at };
}

/** All external links for one contact. */
export function getContactLinks(db: LedgerDatabase, contactId: string): ContactLink[] {
    const rows = db
        .prepare(`SELECT contact_id, system, external_id, synced_at FROM contact_links WHERE contact_id = ?`)
        .all(contactId) as unknown as LinkRow[];
    return rows.map(linkRowToLink);
}

/** All contacts for an entity (with their links), newest-updated first. */
export function listContacts(db: LedgerDatabase, entityId: string): Contact[] {
    const rows = db
        .prepare(`SELECT * FROM contacts WHERE entity_id = ? ORDER BY updated_at DESC`)
        .all(entityId) as unknown as ContactRow[];
    if (rows.length === 0) return [];
    // Batch the links for all of this entity's contacts, then group in JS (avoids N+1).
    const linkRows = db
        .prepare(
            `SELECT contact_id, system, external_id, synced_at FROM contact_links
             WHERE contact_id IN (SELECT id FROM contacts WHERE entity_id = ?)`,
        )
        .all(entityId) as unknown as LinkRow[];
    const byContact = new Map<string, ContactLink[]>();
    for (const lr of linkRows) {
        const list = byContact.get(lr.contact_id) ?? [];
        list.push(linkRowToLink(lr));
        byContact.set(lr.contact_id, list);
    }
    return rows.map((r) => rowToContact(r, byContact.get(r.id) ?? []));
}

/** One contact by id (with links), or null. */
export function getContact(db: LedgerDatabase, id: string): Contact | null {
    const row = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as unknown as ContactRow | undefined;
    return row ? rowToContact(row, getContactLinks(db, id)) : null;
}

/**
 * The contact in THIS entity linked to a given external record, or null (used by import matching).
 * Scoped by entity: the same external id (e.g. a shared Paperless correspondent) can be linked from
 * a different entity's contact, so a global lookup would wrongly treat it as already imported here.
 */
export function findContactByLink(
    db: LedgerDatabase,
    entityId: string,
    system: ContactSystem,
    externalId: string,
): Contact | null {
    const row = db
        .prepare(
            `SELECT c.* FROM contacts c JOIN contact_links l ON l.contact_id = c.id
             WHERE c.entity_id = ? AND l.system = ? AND l.external_id = ?`,
        )
        .get(entityId, system, externalId) as unknown as ContactRow | undefined;
    return row ? rowToContact(row, getContactLinks(db, row.id)) : null;
}

const b = (v: boolean | undefined, fallback: boolean): number => (v ?? fallback ? 1 : 0);

/**
 * Insert or update a contact. With `input.id` set to an existing row it updates (preserving
 * created_at + links); otherwise it inserts with a generated id. Returns the stored contact.
 */
export function upsertContact(db: LedgerDatabase, input: ContactInput, at: string): Contact {
    const existing = input.id ? getContact(db, input.id) : null;
    const id = input.id ?? `c_${crypto.randomUUID()}`;
    if (existing) {
        // Merge-update: fields the caller omits (undefined/null) are PRESERVED, not cleared — so a
        // partial patch (e.g. "set isCustomer") keeps the rest. Pass "" to actually clear a text field.
        db.prepare(
            `UPDATE contacts SET
               entity_id = ?, kind = ?, name = ?, first_name = ?, last_name = ?, email = ?,
               vat_number = ?, tax_id = ?, iban = ?, currency = ?, locale = ?,
               address = ?, zip = ?, city = ?, country_code = ?,
               is_customer = ?, is_supplier = ?, notes = ?, updated_at = ?
             WHERE id = ?`,
        ).run(
            input.entityId,
            input.kind ?? existing.kind,
            input.name ?? existing.name,
            input.firstName ?? existing.firstName,
            input.lastName ?? existing.lastName,
            input.email ?? existing.email,
            input.vatNumber ?? existing.vatNumber,
            input.taxId ?? existing.taxId,
            input.iban ?? existing.iban,
            input.currency ?? existing.currency,
            input.locale ?? existing.locale,
            input.address ?? existing.address,
            input.zip ?? existing.zip,
            input.city ?? existing.city,
            input.countryCode ?? existing.countryCode,
            b(input.isCustomer, existing.isCustomer),
            b(input.isSupplier, existing.isSupplier),
            input.notes ?? existing.notes,
            at,
            id,
        );
    } else {
        db.prepare(
            `INSERT INTO contacts (
               id, entity_id, kind, name, first_name, last_name, email,
               vat_number, tax_id, iban, currency, locale,
               address, zip, city, country_code,
               is_customer, is_supplier, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id,
            input.entityId,
            input.kind ?? 'company',
            input.name ?? null,
            input.firstName ?? null,
            input.lastName ?? null,
            input.email ?? null,
            input.vatNumber ?? null,
            input.taxId ?? null,
            input.iban ?? null,
            input.currency ?? 'EUR',
            input.locale ?? 'de',
            input.address ?? null,
            input.zip ?? null,
            input.city ?? null,
            input.countryCode ?? null,
            b(input.isCustomer, false),
            b(input.isSupplier, false),
            input.notes ?? null,
            at,
            at,
        );
    }
    return getContact(db, id) as Contact;
}

/** Delete a contact and its links (ON DELETE CASCADE handles contact_links). */
export function deleteContact(db: LedgerDatabase, id: string): void {
    db.prepare(`DELETE FROM contacts WHERE id = ?`).run(id);
}

/** Upsert one external link on a contact (idempotent on (contact_id, system)). */
export function setContactLink(
    db: LedgerDatabase,
    contactId: string,
    system: ContactSystem,
    externalId: string,
    at: string,
): void {
    db.prepare(
        `INSERT INTO contact_links (contact_id, system, external_id, synced_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(contact_id, system) DO UPDATE SET external_id = excluded.external_id, synced_at = excluded.synced_at`,
    ).run(contactId, system, externalId, at);
}

/** Remove a contact's link to one external system. */
export function removeContactLink(db: LedgerDatabase, contactId: string, system: ContactSystem): void {
    db.prepare(`DELETE FROM contact_links WHERE contact_id = ? AND system = ?`).run(contactId, system);
}
