import { describe, expect, it } from '@gjsify/unit';
import {
    type Contact,
    contactDisplayName,
    deleteContact,
    findContactByLink,
    getContact,
    listContacts,
    matchContact,
    migrate,
    openLedger,
    removeContactLink,
    SCHEMA_VERSION,
    schemaVersion,
    setContactLink,
    upsertContact,
} from '@steuererklaerung/store';

const AT = '2026-06-26T10:00:00Z';

export default async () => {
    await describe('contacts repo', async () => {
        await it('migrates to schema v3 (contacts tables present)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
            expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3); // contacts landed in v3
            // Empty tables exist and are queryable.
            expect(listContacts(db, 'jumplink').length).toBe(0);
            db.close();
        });

        await it('inserts, reads, updates and deletes a contact', async () => {
            const db = openLedger(':memory:');
            migrate(db);

            const created = upsertContact(
                db,
                { entityId: 'jumplink', kind: 'company', name: 'Nordwerk Studios GmbH', email: 'buchhaltung@nordwerk-studios.example', isCustomer: true },
                AT,
            );
            expect(created.id.startsWith('c_')).toBe(true);
            expect(created.name).toBe('Nordwerk Studios GmbH');
            expect(created.isCustomer).toBe(true);
            expect(created.isSupplier).toBe(false);
            expect(created.currency).toBe('EUR');
            expect(created.links.length).toBe(0);

            // Read back.
            const got = getContact(db, created.id);
            expect(got?.name).toBe('Nordwerk Studios GmbH');

            // Update (same id) preserves created_at, bumps fields.
            const updated = upsertContact(
                db,
                { id: created.id, entityId: 'jumplink', name: 'Nordwerk Studios GmbH & Co. KG', isCustomer: true, isSupplier: true },
                '2026-06-27T00:00:00Z',
            );
            expect(updated.name).toBe('Nordwerk Studios GmbH & Co. KG');
            expect(updated.isSupplier).toBe(true);
            expect(updated.createdAt).toBe(AT);
            expect(updated.updatedAt).toBe('2026-06-27T00:00:00Z');

            // List scopes by entity.
            expect(listContacts(db, 'jumplink').length).toBe(1);
            expect(listContacts(db, 'gbr').length).toBe(0);

            deleteContact(db, created.id);
            expect(getContact(db, created.id)).toBeNull();
            db.close();
        });

        await it('links to external systems and finds by link', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const c = upsertContact(db, { entityId: 'jumplink', name: 'Acme' }, AT);

            setContactLink(db, c.id, 'qonto', 'qclient-123', AT);
            setContactLink(db, c.id, 'paperless', '42', AT);

            const withLinks = getContact(db, c.id);
            expect(withLinks?.links.length).toBe(2);

            const byQonto = findContactByLink(db, 'jumplink', 'qonto', 'qclient-123');
            expect(byQonto?.id).toBe(c.id);
            expect(findContactByLink(db, 'jumplink', 'qonto', 'nope')).toBeNull();
            // Same external id, different entity → not found (entity-scoped).
            expect(findContactByLink(db, 'gbr', 'qonto', 'qclient-123')).toBeNull();

            // Re-linking the same system updates the external id (idempotent on (contact, system)).
            setContactLink(db, c.id, 'qonto', 'qclient-999', AT);
            expect(getContact(db, c.id)?.links.length).toBe(2);
            expect(findContactByLink(db, 'jumplink', 'qonto', 'qclient-999')?.id).toBe(c.id);

            removeContactLink(db, c.id, 'paperless');
            expect(getContact(db, c.id)?.links.length).toBe(1);

            // Deleting the contact cascades its links.
            deleteContact(db, c.id);
            expect(findContactByLink(db, 'jumplink', 'qonto', 'qclient-999')).toBeNull();
            db.close();
        });

        await it('matchContact prefers VAT, then email, then name', async () => {
            const mk = (over: Partial<Contact>): Contact => ({
                id: over.id ?? 'x',
                entityId: 'jumplink',
                kind: 'company',
                name: over.name ?? null,
                firstName: null,
                lastName: null,
                email: over.email ?? null,
                vatNumber: over.vatNumber ?? null,
                taxId: null,
                iban: null,
                currency: 'EUR',
                locale: 'de',
                address: null,
                zip: null,
                city: null,
                countryCode: null,
                isCustomer: false,
                isSupplier: false,
                notes: null,
                createdAt: AT,
                updatedAt: AT,
                links: [],
                ...over,
            });
            const existing = [
                mk({ id: 'byvat', name: 'Other Name', vatNumber: 'DE 123 456 789' }),
                mk({ id: 'byemail', name: 'Yet Another', email: 'Hello@Acme.DE' }),
                mk({ id: 'byname', name: 'Acme GmbH' }),
            ];
            // VAT wins even when the name differs (spaces/case normalized).
            expect(matchContact({ name: 'Whatever', vatNumber: 'de123456789' }, existing)?.id).toBe('byvat');
            // Email match (case-insensitive) when no VAT.
            expect(matchContact({ email: 'hello@acme.de' }, existing)?.id).toBe('byemail');
            // Name fallback.
            expect(matchContact({ name: 'acme gmbh' }, existing)?.id).toBe('byname');
            // No match.
            expect(matchContact({ name: 'Nobody', email: 'no@one.de' }, existing)).toBeNull();
        });

        await it('contactDisplayName falls back name → first/last → id', async () => {
            expect(contactDisplayName({ id: 'c_1', name: 'X GmbH', firstName: null, lastName: null })).toBe('X GmbH');
            expect(contactDisplayName({ id: 'c_2', name: null, firstName: 'Erika', lastName: 'Muster' })).toBe(
                'Erika Muster',
            );
            expect(contactDisplayName({ id: 'c_3', name: null, firstName: null, lastName: null })).toBe('c_3');
        });
    });
};
