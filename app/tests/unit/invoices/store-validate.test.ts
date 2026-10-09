import { describe, it, expect } from '@gjsify/unit';
import { validateInvoiceForFinalize, type InvoiceIssuerSnapshot, type InvoiceRecipient } from '@steuererklaerung/store';

const issuer = (over: Partial<InvoiceIssuerSnapshot> = {}): InvoiceIssuerSnapshot => ({
    name: 'Beispiel Aussteller',
    address: 'Musterweg 1',
    zip: '12345',
    city: 'Musterstadt',
    taxNumber: '12/345/67890',
    ...over,
});

const recipient = (over: Partial<InvoiceRecipient> = {}): InvoiceRecipient => ({
    name: 'Beispiel GmbH',
    address: 'Kundenstr. 2',
    zip: '54321',
    city: 'Kundenstadt',
    ...over,
});

const invoice = (over: Record<string, unknown> = {}) => ({
    issueDate: '2026-03-01',
    performanceStart: '2026-02-01',
    performanceEnd: '2026-02-28',
    footer: null,
    items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unitPriceNet: 100, vatRate: 0.19 }],
    ...over,
});

export default async () => {
    await describe('invoice §14 finalize validation', async () => {
        await it('accepts a complete invoice', async () => {
            expect(validateInvoiceForFinalize(invoice() as never, issuer(), recipient())).toStrictEqual([]);
        });

        await it('requires a Steuernummer or USt-IdNr.', async () => {
            const p = validateInvoiceForFinalize(
                invoice() as never,
                issuer({ taxNumber: null, vatId: null }),
                recipient(),
            );
            expect(p.some((m) => m.includes('Steuernummer oder USt-IdNr'))).toBe(true);
        });

        await it('accepts a vatId instead of a taxNumber', async () => {
            const p = validateInvoiceForFinalize(
                invoice() as never,
                issuer({ taxNumber: null, vatId: 'DE123456789' }),
                recipient(),
            );
            expect(p).toStrictEqual([]);
        });

        await it('requires the recipient address above 250 € but relaxes it for a Kleinbetragsrechnung', async () => {
            // 3 × 100 net = 300 net → 357 gross, clearly above the 250 € Kleinbetrag limit.
            const bigInvoice = invoice({
                items: [{ title: 'Beratung', quantity: 3, unitPriceNet: 100, vatRate: 0.19 }],
            });
            const big = validateInvoiceForFinalize(
                bigInvoice as never,
                issuer(),
                recipient({ address: null, city: null }),
            );
            expect(big.some((m) => m.includes('Empfänger: Anschrift'))).toBe(true);

            const small = validateInvoiceForFinalize(
                invoice({ items: [{ title: 'Kleinkram', quantity: 1, unitPriceNet: 20, vatRate: 0.19 }] }) as never,
                issuer(),
                recipient({ address: null, city: null }),
            );
            expect(small).toStrictEqual([]);
        });

        await it('enforces §19 Kleinunternehmer: no VAT may be shown', async () => {
            const p = validateInvoiceForFinalize(invoice() as never, issuer({ kleinunternehmer: true }), recipient());
            expect(p.some((m) => m.includes('§19 UStG'))).toBe(true);
            const ok = validateInvoiceForFinalize(
                invoice({ items: [{ title: 'Beratung', quantity: 1, unitPriceNet: 100, vatRate: 0 }] }) as never,
                issuer({ kleinunternehmer: true }),
                recipient(),
            );
            expect(ok).toStrictEqual([]);
        });

        await it('flags a missing issue date and empty positions', async () => {
            const p = validateInvoiceForFinalize(invoice({ issueDate: '', items: [] }) as never, issuer(), recipient());
            expect(p.some((m) => m.includes('Ausstellungsdatum'))).toBe(true);
            expect(p.some((m) => m.includes('Rechnungsposition'))).toBe(true);
        });
    });
};
