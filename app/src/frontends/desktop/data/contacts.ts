/**
 * Kontakte data — the unified contact/party master (customers + suppliers + correspondents),
 * read straight from the store via the same `listEntityContacts` the web uses. The list read is
 * pure store + synchronous; the writes (save/delete) are store-only too, while `importContacts`
 * reaches out to the connected back-ends (Qonto/Paperless). Single import surface for the view.
 */

import {
    importContacts as coreImportContacts,
    removeContact as coreRemoveContact,
    saveContact as coreSaveContact,
    type ImportContactsResult,
    listEntityContacts,
} from '../../../core/actions/contacts.ts';
import { listOutgoingInvoices } from '../../../core/actions/recurring-invoices.ts';
import { openReceivablesByContact } from '../../../core/invoices/open-receivables.ts';
import { contactDisplayName } from '@steuererklaerung/store';
import type { Contact, ContactInput } from '@steuererklaerung/store';
import type { AppEntity } from '../entities.ts';

export type { Contact, ContactInput } from '@steuererklaerung/store';
export type { ImportContactsResult } from '../../../core/actions/contacts.ts';

/** All contacts scoped to one entity (synchronous, store-only). */
export function loadContacts(entityId: string): Contact[] {
    return listEntityContacts(entityId);
}

/**
 * The customers of one entity, for contact pickers, plus `alsoId` (a contact already in use that may
 * have lost its customer flag — dropping it from the list would re-point whatever uses it).
 */
export function loadCustomerContacts(entityId: string, alsoId?: string): Contact[] {
    return listEntityContacts(entityId)
        .filter((c) => c.isCustomer || c.id === alsoId)
        .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b), 'de'));
}

/**
 * Σ open (unpaid/overdue) invoice total per contact id — the "N € offen" badge source. Loads the
 * entity's outgoing invoices (async, outbound to the invoicing back-end) and joins them to the
 * already-loaded contacts via the shared pure {@link openReceivablesByContact}. Returns an empty
 * map (never throws) when the entity has no invoicing back-end or the fetch fails, so the badge
 * simply doesn't show. The view calls this AFTER rendering the (fast, synchronous) list.
 */
export async function loadOpenReceivables(entity: AppEntity, contacts: Contact[]): Promise<Map<string, number>> {
    try {
        const invoices = await listOutgoingInvoices({ entityId: entity.id });
        const refs = contacts.map((c) => ({
            id: c.id,
            displayName: contactDisplayName(c),
            qontoClientId: c.links?.find((l) => l.system === 'qonto')?.externalId ?? null,
        }));
        return openReceivablesByContact(refs, invoices);
    } catch {
        return new Map();
    }
}

/** Create or update a contact (store write; fields omitted from `input` are preserved on update). */
export function saveContact(input: ContactInput): Contact {
    return coreSaveContact(input);
}

/** Delete a contact and its links, scoped to its owning entity. */
export function removeContact(entityId: string, id: string): void {
    coreRemoveContact(entityId, id);
}

/** Pull + link contacts from the entity's connected back-ends (Qonto clients / Paperless correspondents). */
export function importContacts(entityId: string): Promise<ImportContactsResult> {
    return coreImportContacts({ entityId });
}
