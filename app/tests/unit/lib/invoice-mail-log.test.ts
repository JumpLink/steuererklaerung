import { describe, it, expect } from '@gjsify/unit';
import {
    listEntityInvoiceMails,
    listInvoiceMails,
    migrate,
    openLedger,
    recordInvoiceMail,
    type InvoiceMailInput,
} from '@steuererklaerung/store';

const base: InvoiceMailInput = {
    entityId: 'demo',
    invoiceId: 'inv-1',
    invoiceNumber: 'RE-0001',
    at: '2026-03-01T10:00:00.000Z',
    from: 'studio@example.invalid',
    to: ['kunde@example.invalid'],
    subject: 'Rechnung RE-0001',
    messageId: '<m1@example.invalid>',
    result: 'sent',
    error: null,
};

export default async () => {
    await describe('invoice mail log', async () => {
        await it('stores attempts per invoice, newest first, failures with their cause', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            recordInvoiceMail(db, base);
            recordInvoiceMail(db, {
                ...base,
                at: '2026-03-02T10:00:00.000Z',
                messageId: null,
                result: 'failed',
                error: 'Verbindung abgelehnt',
            });
            recordInvoiceMail(db, { ...base, invoiceId: 'inv-2' });

            const list = listInvoiceMails(db, 'demo', 'inv-1');
            expect(list.length).toBe(2);
            expect(list[0].result).toBe('failed');
            expect(list[0].error).toBe('Verbindung abgelehnt');
            expect(list[1].to[0]).toBe('kunde@example.invalid');
            expect(listEntityInvoiceMails(db, 'demo').length).toBe(3);
            expect(listInvoiceMails(db, 'other', 'inv-1').length).toBe(0);
            db.close();
        });
    });
};
