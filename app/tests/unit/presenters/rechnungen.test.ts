import { describe, expect, it } from '@gjsify/unit';
import type { Contact } from '@steuererklaerung/store';
import { selectCustomers } from '../../../src/core/presenters/rechnungen.ts';

function contact(over: Partial<Contact>): Contact {
    return {
        id: '1',
        entityId: 'gbr',
        kind: 'company',
        name: 'ACME',
        firstName: null,
        lastName: null,
        email: null,
        vatNumber: null,
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
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
        links: [],
        ...over,
    };
}

export default async () => {
    await describe('presenters/rechnungen — selectCustomers', async () => {
        const contacts = [
            contact({ id: 'c1', name: 'Kunde A', isCustomer: true }),
            contact({ id: 'c2', name: 'Lieferant B', isCustomer: false, isSupplier: true }),
            contact({ id: 'c3', name: 'Beides C', isCustomer: true, isSupplier: true }),
        ];

        await it('keeps only isCustomer contacts (the invoice recipient picker), order preserved', async () => {
            // Exactly the old data-layer derive: listEntityContacts(entity.id).filter(c => c.isCustomer).
            expect(
                selectCustomers(contacts)
                    .map((c) => c.id)
                    .join(','),
            ).toBe('c1,c3');
        });

        await it('no customers → empty list; never mutates the input', async () => {
            const before = contacts.length;
            expect(selectCustomers([contact({ isCustomer: false })]).length).toBe(0);
            expect(contacts.length).toBe(before);
        });
    });
};
