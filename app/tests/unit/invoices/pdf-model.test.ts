import { describe, it, expect } from '@gjsify/unit';
import {
    buildInvoicePdfModel,
    paginateItems,
    itemColumns,
    pdfRenderingAvailable,
    renderInvoicePdf,
    qrMatrix,
    type PdfItemRow,
} from '@steuererklaerung/invoice-pdf';
import type { StoredInvoice } from '@steuererklaerung/store';

function invoice(over: Partial<StoredInvoice> = {}): StoredInvoice {
    return {
        id: 'si_x',
        entityId: 'gbr',
        kind: 'invoice',
        status: 'open',
        number: 'RE-2026-0001',
        contactId: null,
        recipient: {
            name: 'Beispiel GmbH',
            address: 'Kundenstr. 2',
            zip: '54321',
            city: 'Kundenstadt',
            countryCode: 'DE',
        },
        issuer: {
            name: 'JumpLink',
            address: 'Musterweg 1',
            zip: '12345',
            city: 'Musterstadt',
            countryCode: 'DE',
            taxNumber: '12/345/67890',
            kleinunternehmer: false,
            bank: { iban: 'DE02120300000000202051', bankName: 'Beispielbank' },
        },
        issueDate: '2026-03-01',
        dueDate: '2026-03-15',
        performanceStart: '2026-02-01',
        performanceEnd: '2026-02-28',
        currency: 'EUR',
        iban: 'DE02120300000000202051',
        buyerReference: null,
        header: 'Vielen Dank für Ihren Auftrag.',
        footer: null,
        terms: null,
        items: [
            {
                title: 'Beratung',
                description: 'Konzeption',
                quantity: 2,
                unit: 'Std',
                unitPriceNet: 100,
                vatRate: 0.19,
                net: 200,
                vat: 38,
                gross: 238,
            },
        ],
        totals: { net: 200, vat: 38, gross: 238, byRate: [] },
        stornoOfId: null,
        cancelledById: null,
        paidAt: null,
        paidTxId: null,
        archive: { dms: null, pdfDocumentId: null, xmlDocumentId: null },
        finalizedAt: '2026-03-01T10:00:00Z',
        createdAt: '2026-03-01T10:00:00Z',
        updatedAt: '2026-03-01T10:00:00Z',
        createdBy: null,
        ...over,
    };
}

const fakeRow = (i: number): PdfItemRow => ({
    position: i,
    title: `Pos ${i}`,
    description: null,
    quantity: '1',
    unit: null,
    unitPrice: '10,00',
    vatRate: '19 %',
    net: '10,00',
});

export default async () => {
    await describe('invoice pdf model', async () => {
        await it('builds the render model with de-DE formatting + info block', async () => {
            const m = buildInvoicePdfModel(invoice());
            expect(m.title).toBe('Rechnung RE-2026-0001');
            expect(m.address.recipientLines[0]).toBe('Beispiel GmbH');
            expect(m.info.some((r) => r.label === 'Rechnungsnummer' && r.value === 'RE-2026-0001')).toBe(true);
            expect(m.info.some((r) => r.label === 'Leistungszeitraum' && r.value === '01.02.2026 – 28.02.2026')).toBe(
                true,
            );
            expect(m.items[0].unitPrice).toBe('100,00');
            expect(m.vatRows[0].label).toBe('zzgl. USt 19 %');
            expect(m.totalGross).toBe('238,00');
            expect(m.grossLabel).toBe('Rechnungsbetrag');
            expect(m.footerColumns.some((c) => c.heading === 'Bankverbindung')).toBe(true);
        });

        await it('titles a storno and appends the §19 note for a Kleinunternehmer', async () => {
            const m = buildInvoicePdfModel(
                invoice({
                    kind: 'storno',
                    number: 'RE-2026-0002',
                    issuer: { ...invoice().issuer!, kleinunternehmer: true },
                    items: [
                        {
                            title: 'X',
                            description: null,
                            quantity: 1,
                            unit: null,
                            unitPriceNet: 100,
                            vatRate: 0,
                            net: 100,
                            vat: 0,
                            gross: 100,
                        },
                    ],
                }),
            );
            expect(m.title).toBe('Stornorechnung RE-2026-0002');
            expect(m.grossLabel).toBe('Gutschriftbetrag');
            expect(m.note?.includes('§ 19 UStG')).toBe(true);
        });

        await it('passes a prebuilt GiroCode payload through', async () => {
            const m = buildInvoicePdfModel(invoice(), { epcPayload: 'BCD\n002\n1\nSCT\n' });
            expect(m.qrPayload?.startsWith('BCD')).toBe(true);
        });
    });

    await describe('pagination', async () => {
        await it('keeps one page when rows + totals fit', async () => {
            const rows = Array.from({ length: 5 }, (_, i) => fakeRow(i + 1));
            const pages = paginateItems(rows, {
                firstBodyTop: 300,
                contBodyTop: 100,
                totalsHeight: 80,
                measure: () => 16,
            });
            expect(pages.length).toBe(1);
            expect(pages[0].isLast).toBe(true);
            expect(pages[0].rows.length).toBe(5);
        });

        await it('breaks to a new page when rows overflow the body', async () => {
            const rows = Array.from({ length: 80 }, (_, i) => fakeRow(i + 1));
            const pages = paginateItems(rows, {
                firstBodyTop: 300,
                contBodyTop: 100,
                totalsHeight: 80,
                measure: () => 40,
            });
            expect(pages.length).toBeGreaterThan(1);
            expect(pages[pages.length - 1].isLast).toBe(true);
            // Every row is placed exactly once across the pages.
            const total = pages.reduce((n, p) => n + p.rows.length, 0);
            expect(total).toBe(80);
        });

        await it('exposes the six item columns', async () => {
            expect(itemColumns().length).toBe(6);
        });
    });

    await describe('qr matrix', async () => {
        await it('encodes a payload into a square dark/light matrix', async () => {
            const m = await qrMatrix('BCD\n002\n1\nSCT\nDE02120300000000202051');
            expect(m.size).toBeGreaterThan(20);
            expect(typeof m.dark(0, 0)).toBe('boolean');
        });
    });

    await describe('renderInvoicePdf', async () => {
        await it('renders a PDF under GJS, or is unavailable on Node', async () => {
            if (!pdfRenderingAvailable()) {
                await expect(renderInvoicePdf(buildInvoicePdfModel(invoice()))).rejects.toThrow();
                return;
            }
            const bytes = await renderInvoicePdf(buildInvoicePdfModel(invoice(), { epcPayload: 'BCD\n002\n1\nSCT\n' }));
            const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
            expect(magic).toBe('%PDF-');
        });
    });
};
