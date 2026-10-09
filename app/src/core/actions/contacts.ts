/**
 * Contacts (parties) orchestration shared by the CLI, MCP and web UI.
 *
 * Our SQLite store is the system of record. `importContacts` PULLS the external records the entity
 * is connected to — Qonto clients (if invoicing = qonto) and Paperless correspondents (if dms =
 * paperless) — and matches/links them to local contacts (strong keys → name; see matchContact).
 * Nothing is overwritten blindly: an already-linked record is left alone, a confident match just
 * gains the link, only genuinely new parties are inserted. Push (create-on-demand) lives elsewhere.
 */

import {
    type Contact,
    type ContactInput,
    type ContactKind,
    deleteContact,
    findContactByLink,
    getContact,
    type LedgerDatabase,
    ledgerDbPath,
    listContacts,
    matchContact,
    migrate,
    openLedger,
    setContactLink,
    upsertContact,
} from '@steuererklaerung/store';
import { findOrCreateClient, listClients } from '../clients/qonto/clients.ts';
import type { Client, CreateClientBody } from '../clients/qonto/types.ts';
import { type Correspondent, listCorrespondents, resolvePaperlessConfig } from '@steuererklaerung/paperless';
import { findEntity, hasQontoAccount, loadManifest, resolveInvoicingType } from '../config/index.ts';
import { requireInvoicingBackend } from '../invoices/backend-gate.ts';

/** Today's instant as an ISO timestamp (single place so callers can reason about it). */
function nowIso(): string {
    return new Date().toISOString();
}

/** Open + migrate + close the ledger around a synchronous `fn`. */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

/** Resolve an entity's invoicing + DMS config (with the raw Paperless creds) from the manifest. */
function entityConnections(entityId: string): {
    qonto: boolean;
    paperless: boolean;
    paperlessCreds?: { url?: string; token?: string };
} {
    const e = findEntity(loadManifest(), entityId);
    // Use the entity's own Paperless creds if it has them, else fall back to the global env instance.
    const paperlessCreds = e?.dms?.type === 'paperless' ? e?.dms?.paperless : undefined;
    return {
        qonto: !!e && resolveInvoicingType(e.invoicing?.type, e.accounts) === 'qonto' && hasQontoAccount(e.accounts),
        // Paperless is a shared instance (env PAPERLESS_*), so any entity can import correspondents
        // from it — not only one whose own DMS back-end is Paperless (e.g. JumpLink uses built-in DMS
        // but bills clients filed in the same Paperless as the GbR).
        paperless: !!resolvePaperlessConfig(paperlessCreds).config,
        paperlessCreds,
    };
}

// ── Reads / writes ──────────────────────────────────────────────────────────────────────────

/** All contacts for an entity (with links). */
export function listEntityContacts(entityId: string): Contact[] {
    return withLedger((db) => listContacts(db, entityId));
}

/** Create or update a contact (full or partial input; omitted fields are preserved on update). */
export function saveContact(input: ContactInput): Contact {
    return withLedger((db) => {
        // Guard against updating (and silently re-homing) a contact that belongs to another entity.
        if (input.id) {
            const existing = getContact(db, input.id);
            if (existing && existing.entityId !== input.entityId) {
                throw new Error('Kontakt gehört zu einer anderen Firma.');
            }
        }
        return upsertContact(db, input, nowIso());
    });
}

/** Delete a contact (and its links), scoped to its entity. */
export function removeContact(entityId: string, id: string): void {
    withLedger((db) => {
        const existing = getContact(db, id);
        if (existing && existing.entityId !== entityId) {
            throw new Error('Kontakt gehört zu einer anderen Firma.');
        }
        deleteContact(db, id);
    });
}

/** One contact by id (with links), or null. */
export function getContactById(id: string): Contact | null {
    return withLedger((db) => getContact(db, id));
}

// ── Qonto client resolution (push: create-on-demand) ──────────────────────────────────────────

/** Map a Qonto kind from our richer contact kind ('organization' has no Qonto equivalent). */
function qontoKind(kind: ContactKind): 'company' | 'individual' | 'freelancer' {
    return kind === 'individual' || kind === 'freelancer' ? kind : 'company';
}

/** Build the Qonto CreateClientBody from a contact (currency/locale/address required for invoicing). */
function contactToCreateClientBody(c: Contact): CreateClientBody {
    const hasAddress = c.address || c.zip || c.city || c.countryCode;
    return {
        kind: qontoKind(c.kind),
        ...(c.name ? { name: c.name } : {}),
        ...(c.firstName ? { first_name: c.firstName } : {}),
        ...(c.lastName ? { last_name: c.lastName } : {}),
        ...(c.email ? { email: c.email } : {}),
        ...(c.vatNumber ? { vat_number: c.vatNumber } : {}),
        ...(c.taxId ? { tax_identification_number: c.taxId } : {}),
        currency: c.currency,
        locale: c.locale,
        ...(hasAddress
            ? {
                  billing_address: {
                      ...(c.address ? { street_address: c.address } : {}),
                      ...(c.zip ? { zip_code: c.zip } : {}),
                      ...(c.city ? { city: c.city } : {}),
                      ...(c.countryCode ? { country_code: c.countryCode } : {}),
                  },
              }
            : {}),
    };
}

/** The Qonto client id a contact is already linked to, or undefined (no network). */
export function getContactQontoClientId(contactId: string): string | undefined {
    return withLedger((db) => getContact(db, contactId)?.links.find((l) => l.system === 'qonto')?.externalId);
}

/**
 * Ensure the contact has a Qonto client and return its id, creating + linking one on demand. If the
 * contact is already linked, returns that id without any API call. This is the create-on-demand push
 * that closes the recurring "qontoClientId fehlt" gap.
 */
export async function ensureQontoClientForContact(contactId: string): Promise<{ clientId: string; created: boolean }> {
    const contact = getContactById(contactId);
    if (!contact) throw new Error(`Kontakt ${contactId} nicht gefunden.`);
    const linked = contact.links.find((l) => l.system === 'qonto');
    if (linked) return { clientId: linked.externalId, created: false };
    requireInvoicingBackend(contact.entityId);
    const { client, created } = await findOrCreateClient(contactToCreateClientBody(contact));
    withLedger((db) => setContactLink(db, contact.id, 'qonto', client.id, nowIso()));
    return { clientId: client.id, created };
}

/**
 * Resolve the contact for a recurring schedule's customer: by explicit contactId, else by name/email
 * match, else create a fresh customer contact from the schedule data. Pure store I/O (no network).
 */
export function resolveOrCreateContactForCustomer(
    entityId: string,
    customer: { name: string; contactId?: string; email?: string },
): Contact {
    return withLedger((db) => {
        if (customer.contactId) {
            const byId = getContact(db, customer.contactId);
            if (byId) return byId;
        }
        const hit = matchContact({ name: customer.name, email: customer.email }, listContacts(db, entityId));
        if (hit) return hit;
        return upsertContact(
            db,
            { entityId, name: customer.name, email: customer.email ?? null, isCustomer: true },
            nowIso(),
        );
    });
}

// ── Import / sync-in ────────────────────────────────────────────────────────────────────────

export interface ImportSourceResult {
    source: 'qonto' | 'paperless';
    /** Records fetched from the back-end. */
    fetched: number;
    /** New contacts inserted. */
    imported: number;
    /** Existing contacts that gained the link via a confident match. */
    linked: number;
    /** Records already linked (no-op). */
    matched: number;
    error?: string;
}

export interface ImportContactsResult {
    entityId: string;
    sources: ImportSourceResult[];
}

function clientToInput(entityId: string, c: Client): ContactInput {
    const addr = c.billing_address;
    return {
        entityId,
        kind: (c.kind as ContactKind) ?? 'company',
        name: c.name ?? null,
        firstName: c.first_name ?? null,
        lastName: c.last_name ?? null,
        email: c.email ?? null,
        vatNumber: c.vat_number ?? null,
        taxId: c.tax_identification_number ?? null,
        currency: c.currency ?? 'EUR',
        locale: c.locale ?? 'de',
        address: addr?.street_address ?? null,
        zip: addr?.zip_code ?? null,
        city: addr?.city ?? null,
        countryCode: addr?.country_code ?? null,
        isCustomer: true,
    };
}

/** Apply fetched Qonto clients to the store: link the matched, insert the new. */
function applyQontoClients(db: LedgerDatabase, entityId: string, clients: Client[], at: string): ImportSourceResult {
    let imported = 0;
    let linked = 0;
    let matched = 0;
    const existing = listContacts(db, entityId);
    for (const c of clients) {
        if (findContactByLink(db, entityId, 'qonto', c.id)) {
            matched++;
            continue;
        }
        const hit = matchContact(
            {
                name: c.name,
                firstName: c.first_name,
                lastName: c.last_name,
                email: c.email,
                vatNumber: c.vat_number,
            },
            existing,
        );
        if (hit) {
            setContactLink(db, hit.id, 'qonto', c.id, at);
            if (!hit.isCustomer) upsertContact(db, { id: hit.id, entityId, isCustomer: true }, at);
            linked++;
        } else {
            const created = upsertContact(db, clientToInput(entityId, c), at);
            setContactLink(db, created.id, 'qonto', c.id, at);
            existing.push(created);
            imported++;
        }
    }
    return { source: 'qonto', fetched: clients.length, imported, linked, matched };
}

/** Apply fetched Paperless correspondents: name-only, so no role is forced (edit it in the UI). */
function applyCorrespondents(
    db: LedgerDatabase,
    entityId: string,
    correspondents: Correspondent[],
    at: string,
): ImportSourceResult {
    let imported = 0;
    let linked = 0;
    let matched = 0;
    const existing = listContacts(db, entityId);
    for (const corr of correspondents) {
        const externalId = String(corr.id);
        if (findContactByLink(db, entityId, 'paperless', externalId)) {
            matched++;
            continue;
        }
        const hit = matchContact({ name: corr.name }, existing);
        if (hit) {
            setContactLink(db, hit.id, 'paperless', externalId, at);
            linked++;
        } else {
            const created = upsertContact(db, { entityId, kind: 'company', name: corr.name }, at);
            setContactLink(db, created.id, 'paperless', externalId, at);
            existing.push(created);
            imported++;
        }
    }
    return { source: 'paperless', fetched: correspondents.length, imported, linked, matched };
}

/** Fetch every Paperless correspondent (paginated) for the given creds (or env default). */
async function fetchAllCorrespondents(creds?: { url?: string; token?: string }): Promise<Correspondent[]> {
    const resolved = resolvePaperlessConfig(creds);
    if (resolved.error || !resolved.config) throw new Error(`Paperless: ${resolved.error ?? 'keine Konfiguration'}`);
    const out: Correspondent[] = [];
    for (let page = 1; page <= 100; page++) {
        const resp = await listCorrespondents({ page, page_size: 100 }, resolved.config);
        out.push(...resp.results);
        if (!resp.next || resp.results.length === 0) break;
    }
    return out;
}

/**
 * Import contacts from every back-end the entity is connected to, matching/linking into the store.
 * Each source is fetched and applied independently so one failing connection doesn't block the other.
 */
export async function importContacts(opts: { entityId: string }): Promise<ImportContactsResult> {
    const { entityId } = opts;
    const at = nowIso();
    const conn = entityConnections(entityId);

    // Fetch first (network), then apply in one DB session.
    let clients: Client[] | null = null;
    let qontoError: string | undefined;
    if (conn.qonto) {
        try {
            clients = await listClients();
        } catch (e) {
            qontoError = e instanceof Error ? e.message : String(e);
        }
    }

    let correspondents: Correspondent[] | null = null;
    let paperlessError: string | undefined;
    if (conn.paperless) {
        try {
            correspondents = await fetchAllCorrespondents(conn.paperlessCreds);
        } catch (e) {
            paperlessError = e instanceof Error ? e.message : String(e);
        }
    }

    const sources: ImportSourceResult[] = [];
    withLedger((db) => {
        if (conn.qonto) {
            if (qontoError) {
                sources.push({ source: 'qonto', fetched: 0, imported: 0, linked: 0, matched: 0, error: qontoError });
            } else {
                sources.push(applyQontoClients(db, entityId, clients ?? [], at));
            }
        }
        if (conn.paperless) {
            if (paperlessError) {
                sources.push({
                    source: 'paperless',
                    fetched: 0,
                    imported: 0,
                    linked: 0,
                    matched: 0,
                    error: paperlessError,
                });
            } else {
                sources.push(applyCorrespondents(db, entityId, correspondents ?? [], at));
            }
        }
    });

    return { entityId, sources };
}
