import { describe, it, expect } from '@gjsify/unit';
import { buildCiiInvoiceXml, ciiXmlProblems } from '../../../src/core/invoices/cii-xml.ts';
import type { StoredInvoice } from '@steuererklaerung/store';

function invoice(over: Partial<StoredInvoice> = {}): StoredInvoice {
    const items = over.items ?? [
        {
            title: 'Beratung',
            description: null,
            quantity: 2,
            unit: 'Std',
            unitPriceNet: 100,
            vatRate: 0.19,
            net: 200,
            vat: 38,
            gross: 238,
        },
        {
            title: 'Material',
            description: null,
            quantity: 1,
            unit: null,
            unitPriceNet: 50,
            vatRate: 0.07,
            net: 50,
            vat: 3.5,
            gross: 53.5,
        },
    ];
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
            vatId: 'DE123456789',
            kleinunternehmer: false,
            bank: { iban: 'DE02120300000000202051', accountHolder: 'JumpLink' },
        },
        issueDate: '2026-03-01',
        dueDate: '2026-03-15',
        performanceStart: '2026-02-01',
        performanceEnd: '2026-02-28',
        currency: 'EUR',
        iban: 'DE02120300000000202051',
        buyerReference: null,
        header: null,
        footer: null,
        terms: null,
        items,
        totals: { net: 250, vat: 41.5, gross: 291.5, byRate: [] },
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

export default async () => {
    await describe('CII XRechnung XML', async () => {
        await it('emits a well-formed invoice with the XRechnung guideline + TypeCode 380', async () => {
            const xml = buildCiiInvoiceXml(invoice());
            expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
            expect(xml.includes('xrechnung_3.0')).toBe(true);
            expect(xml.includes('<ram:TypeCode>380</ram:TypeCode>')).toBe(true);
            expect(xml.includes('<ram:ID>RE-2026-0001</ram:ID>')).toBe(true);
            expect(xml.includes('<udt:DateTimeString format="102">20260301</udt:DateTimeString>')).toBe(true);
        });

        await it('maps issuer tax identity (VA + FC) and the buyer party', async () => {
            const xml = buildCiiInvoiceXml(invoice());
            expect(xml.includes('<ram:ID schemeID="VA">DE123456789</ram:ID>')).toBe(true);
            expect(xml.includes('<ram:ID schemeID="FC">12/345/67890</ram:ID>')).toBe(true);
            expect(xml.includes('Beispiel GmbH')).toBe(true);
            expect(xml.includes('<ram:IBANID>DE02120300000000202051</ram:IBANID>')).toBe(true);
        });

        await it('reconciles the monetary summation (BR-CO arithmetic)', async () => {
            const xml = buildCiiInvoiceXml(invoice());
            expect(xml.includes('<ram:LineTotalAmount>250.00</ram:LineTotalAmount>')).toBe(true);
            expect(xml.includes('<ram:TaxTotalAmount currencyID="EUR">41.50</ram:TaxTotalAmount>')).toBe(true);
            expect(xml.includes('<ram:GrandTotalAmount>291.50</ram:GrandTotalAmount>')).toBe(true);
            // Two rate blocks (19 % and 7 %), highest first.
            expect(xml.includes('<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>')).toBe(true);
            expect(xml.includes('<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>')).toBe(true);
        });

        await it('emits §19 Kleinunternehmer as exempt (category E, no VAT)', async () => {
            const xml = buildCiiInvoiceXml(
                invoice({
                    items: [
                        {
                            title: 'Leistung',
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
                    issuer: { ...invoice().issuer!, kleinunternehmer: true, vatId: null },
                }),
            );
            expect(xml.includes('<ram:CategoryCode>E</ram:CategoryCode>')).toBe(true);
            expect(xml.includes('§ 19 UStG')).toBe(true);
        });

        await it('does NOT claim §19 for a 0 % line of a regular (non-Kleinunternehmer) issuer', async () => {
            const xml = buildCiiInvoiceXml(
                invoice({
                    items: [
                        {
                            title: 'Reverse-Charge',
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
                    issuer: { ...invoice().issuer!, kleinunternehmer: false },
                }),
            );
            expect(xml.includes('<ram:CategoryCode>E</ram:CategoryCode>')).toBe(true); // still exempt
            expect(xml.includes('§ 19')).toBe(false); // but NOT the false Kleinunternehmer claim
            expect(xml.includes('<ram:ExemptionReason>steuerfrei</ram:ExemptionReason>')).toBe(true);
        });

        await it('emits a storno as credit note 381 with positive amounts + BT-25 reference', async () => {
            const storno = invoice({
                kind: 'storno',
                number: 'RE-2026-0002',
                stornoOfId: 'si_x',
                items: [
                    {
                        title: 'Beratung',
                        description: null,
                        quantity: -2,
                        unit: 'Std',
                        unitPriceNet: 100,
                        vatRate: 0.19,
                        net: -200,
                        vat: -38,
                        gross: -238,
                    },
                ],
                totals: { net: -200, vat: -38, gross: -238, byRate: [] },
            });
            const xml = buildCiiInvoiceXml(storno, { originalNumber: 'RE-2026-0001' });
            expect(xml.includes('<ram:TypeCode>381</ram:TypeCode>')).toBe(true);
            expect(xml.includes('<ram:IssuerAssignedID>RE-2026-0001</ram:IssuerAssignedID>')).toBe(true);
            // BT-25 must sit in the Settlement block (XSD D16B), not the Agreement block.
            const refAt = xml.indexOf('<ram:InvoiceReferencedDocument>');
            const settleAt = xml.indexOf('<ram:ApplicableHeaderTradeSettlement>');
            const agreementEnd = xml.indexOf('</ram:ApplicableHeaderTradeAgreement>');
            expect(refAt).toBeGreaterThan(settleAt);
            expect(refAt).toBeGreaterThan(agreementEnd);
            // Amounts are absolute (positive) on the credit note — never negative.
            expect(xml.includes('<ram:GrandTotalAmount>238.00</ram:GrandTotalAmount>')).toBe(true);
            expect(/<ram:(LineTotalAmount|GrandTotalAmount|BasisAmount)>-/.test(xml)).toBe(false);
        });

        await it('is deterministic (two builds are byte-identical)', async () => {
            expect(buildCiiInvoiceXml(invoice())).toBe(buildCiiInvoiceXml(invoice()));
        });

        await it('ciiXmlProblems flags a broken summation and non-EUR', async () => {
            expect(ciiXmlProblems(invoice())).toStrictEqual([]);
            const bad = invoice({ currency: 'USD' });
            expect(ciiXmlProblems(bad).some((m) => m.includes('nur EUR'))).toBe(true);
        });
    });
};
