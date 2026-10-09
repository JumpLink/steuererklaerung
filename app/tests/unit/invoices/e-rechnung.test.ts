/**
 * E-Rechnung lesen (Idee 2): the CII + UBL parser, the hybrid-PDF extraction, the §14 UStG
 * classification, and the proof that an e-invoice never reaches the AI. Every invoice here is
 * invented (Lieferant GmbH, DE000000000, round amounts, no real IBAN).
 */
import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openLedger, SCHEMA_VERSION, schemaVersion, type StoredInvoice } from '@steuererklaerung/store';
import { BuiltinDmsProvider, extractPdfText } from '@steuererklaerung/dms';
import type { Document } from '@steuererklaerung/paperless';
import { buildCiiInvoiceXml } from '../../../src/core/invoices/cii-xml.ts';
import {
    EInvoiceError,
    classifyGuideline,
    comparePdfText,
    eInvoiceToFields,
    eInvoiceToReceiptMetadata,
    extractEmbeddedXml,
    parseEInvoiceXml,
    prefillFromLastInvoice,
    readEInvoice,
    type PrefillRecord,
} from '../../../src/core/invoices/e-rechnung/index.ts';
import { buildHybridPdf } from '../../../src/core/lib/demo/hybrid-pdf.ts';
import { storeReceipt } from '../../../src/core/actions/documents.ts';
import { runInvoiceExtractionForDocument } from '../../../src/core/actions/paperless/extract-invoice.ts';
import { setLLMProviderOverride, type LLMProvider } from '../../../src/core/clients/llm/index.ts';
import type { SyncConfig } from '../../../src/core/config/index.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

function storedInvoice(over: Partial<StoredInvoice> = {}): StoredInvoice {
    return {
        id: 'si_x',
        entityId: 'gbr',
        kind: 'invoice',
        status: 'open',
        number: 'RE-2026-0001',
        contactId: null,
        recipient: { name: 'Kunde AG', address: 'Kundenstr. 2', zip: '54321', city: 'Kundenstadt', countryCode: 'DE' },
        issuer: {
            name: 'Lieferant GmbH',
            address: 'Musterweg 1',
            zip: '12345',
            city: 'Musterstadt',
            countryCode: 'DE',
            taxNumber: '00/000/00000',
            vatId: 'DE000000000',
            kleinunternehmer: false,
            bank: { iban: 'DE00000000000000000000', accountHolder: 'Lieferant GmbH' },
        },
        issueDate: '2026-03-01',
        dueDate: '2026-03-15',
        performanceStart: null,
        performanceEnd: null,
        currency: 'EUR',
        iban: 'DE00000000000000000000',
        buyerReference: null,
        header: null,
        footer: null,
        terms: null,
        items: [
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
        ],
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

const UBL_NS =
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';

const UBL_PARTIES = `
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>Lieferant GmbH</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Musterweg 1</cbc:StreetName><cbc:CityName>Musterstadt</cbc:CityName><cbc:PostalZone>12345</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE000000000</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Lieferant GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyLegalEntity><cbc:RegistrationName>Kunde AG</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>DE00 0000 0000 0000 0000 00</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>`;

const UBL_TOTALS = `
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount></cac:LegalMonetaryTotal>`;

const UBL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ${UBL_NS}>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>UBL-100</cbc:ID>
  <cbc:IssueDate>2026-04-01</cbc:IssueDate>
  <cbc:DueDate>2026-04-15</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>04011000-12345-34</cbc:BuyerReference>${UBL_PARTIES}
  <cac:PaymentTerms><cbc:Note>Zahlbar innerhalb von 14 Tagen netto.</cbc:Note></cac:PaymentTerms>${UBL_TOTALS}
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="HUR">2</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Beratung</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">50.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;

const UBL_CREDIT_NOTE = `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" ${UBL_NS}>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>GS-7</cbc:ID>
  <cbc:IssueDate>2026-04-20</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>UBL-100</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>${UBL_PARTIES}${UBL_TOTALS}
  <cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Gutschrift Beratung</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price></cac:CreditNoteLine>
</CreditNote>`;

/** A CII data set; `guideline` decides the profile, `full` adds lines and the VAT breakdown. */
function cii(guideline: string, full = true): string {
    const lines = full
        ? `<ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
        <ram:SpecifiedTradeProduct><ram:Name>Beratung</ram:Name></ram:SpecifiedTradeProduct>
        <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
        <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1.00</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
        <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
          <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
      </ram:IncludedSupplyChainTradeLineItem>`
        : '';
    const breakdown = full
        ? `<ram:ApplicableTradeTax><ram:CalculatedAmount>19.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>100.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${guideline}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>ZF-2026-5</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20260510</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lines}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>Lieferant GmbH</ram:Name><ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE000000000</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Kunde AG</ram:Name></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>${breakdown}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount><ram:GrandTotalAmount>119.00</ram:GrandTotalAmount><ram:DuePayableAmount>119.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

const EN16931 = 'urn:cen.eu:en16931:2017';
const MINIMUM = 'urn:factur-x.eu:1p0:minimum';

const config = {
    custom_field_ids: {
        invoice_number: 11,
        invoice_date: 12,
        due_date: 13,
        total_net: 14,
        total_gross: 15,
        tax_amount: 16,
        invoice_currency: 17,
        tax_rate: 18,
        customer_number: 0,
        service_period_start: 0,
        service_period_end: 0,
        supplier_country: 0,
        supplier_vat_id: 19,
        reverse_charge: 0,
        sale_type: 0,
        accounting_category: 0,
        invoice_kind: 20,
        qonto_transaction_amount: 0,
        qonto_currency: 0,
        qonto_settled_at: 0,
        qonto_label: 0,
        qonto_reference: 0,
        qonto_category: 0,
    },
    tag_ids: { ai_reviewed: 99 },
    select_field_options: {},
} as unknown as SyncConfig;

const paperlessDoc = (over: Partial<Document> = {}): Document =>
    ({
        id: 7,
        title: 'Rechnung',
        content: 'Rechnung Nr. 1 Summe 119,00 EUR',
        tags: [],
        custom_fields: [],
        mime_type: 'application/pdf',
        ...over,
    }) as Document;

const kindValue = (fields: Array<{ field: number; value: unknown }> | undefined): string =>
    String(fields?.find((f) => f.field === 20)?.value ?? '');

export default async () => {
    await describe('E-Rechnung lesen — Parser', async () => {
        await it('CII round trip: our own XRechnung writer is read back field by field', async () => {
            const inv = parseEInvoiceXml(buildCiiInvoiceXml(storedInvoice()));
            expect(inv.syntax).toBe('cii');
            expect(inv.documentKind).toBe('invoice');
            expect(inv.typeCode).toBe('380');
            expect(inv.guidelineId).toContain('xrechnung_3.0');
            expect(inv.number).toBe('RE-2026-0001');
            expect(inv.issueDate).toBe('2026-03-01');
            expect(inv.dueDate).toBe('2026-03-15');
            expect(inv.currency).toBe('EUR');
            expect(inv.seller.name).toBe('Lieferant GmbH');
            expect(inv.seller.vatId).toBe('DE000000000');
            expect(inv.seller.taxNumber).toBe('00/000/00000');
            expect(inv.seller.iban).toBe('DE00000000000000000000');
            expect(inv.seller.zip).toBe('12345');
            expect(inv.buyer.name).toBe('Kunde AG');
            expect(inv.lines.length).toBe(2);
            expect(inv.lines[0].description).toBe('Beratung');
            expect(inv.lines[0].quantity).toBe(2);
            expect(inv.lines[0].unitPriceNet).toBe(100);
            expect(inv.lines[0].net).toBe(200);
            expect(inv.lines[0].vatRate).toBe(19);
            expect(inv.vat.length).toBe(2);
            expect(inv.vat.find((v) => v.rate === 7)?.basis).toBe(50);
            expect(inv.totals.net).toBe(250);
            expect(inv.totals.vat).toBe(41.5);
            expect(inv.totals.gross).toBe(291.5);
            expect(inv.totals.due).toBe(291.5);
        });

        await it('CII storno from our writer is a credit note that points at the cancelled invoice', async () => {
            const storno = storedInvoice({
                kind: 'storno',
                number: 'RE-2026-0002',
                totals: { net: -250, vat: -41.5, gross: -291.5, byRate: [] },
            });
            storno.items = storno.items.map((i) => ({
                ...i,
                quantity: -i.quantity,
                net: -i.net,
                vat: -i.vat,
                gross: -i.gross,
            }));
            const inv = parseEInvoiceXml(buildCiiInvoiceXml(storno, { originalNumber: 'RE-2026-0001' }));
            expect(inv.typeCode).toBe('381');
            expect(inv.documentKind).toBe('credit-note');
            expect(inv.precedingNumber).toBe('RE-2026-0001');
            expect(inv.totals.gross).toBe(291.5);
        });

        await it('UBL invoice', async () => {
            const inv = parseEInvoiceXml(UBL_INVOICE);
            expect(inv.syntax).toBe('ubl');
            expect(inv.documentKind).toBe('invoice');
            expect(inv.number).toBe('UBL-100');
            expect(inv.issueDate).toBe('2026-04-01');
            expect(inv.dueDate).toBe('2026-04-15');
            expect(inv.paymentTerms).toBe('Zahlbar innerhalb von 14 Tagen netto.');
            expect(inv.buyerReference).toBe('04011000-12345-34');
            expect(inv.seller.name).toBe('Lieferant GmbH');
            expect(inv.seller.vatId).toBe('DE000000000');
            expect(inv.seller.country).toBe('DE');
            expect(inv.seller.iban).toBe('DE00000000000000000000');
            expect(inv.buyer.name).toBe('Kunde AG');
            expect(inv.lines.length).toBe(1);
            expect(inv.lines[0].quantity).toBe(2);
            expect(inv.lines[0].unit).toBe('HUR');
            expect(inv.lines[0].unitPriceNet).toBe(50);
            expect(inv.vat[0].rate).toBe(19);
            expect(inv.vat[0].basis).toBe(100);
            expect(inv.totals.gross).toBe(119);
            expect(inv.totals.vat).toBe(19);
            expect(classifyGuideline(inv.guidelineId, false).kind).toBe('e-rechnung');
        });

        await it('UBL credit note (381) is recognised and refers to its invoice', async () => {
            const inv = parseEInvoiceXml(UBL_CREDIT_NOTE);
            expect(inv.documentKind).toBe('credit-note');
            expect(inv.typeCode).toBe('381');
            expect(inv.precedingNumber).toBe('UBL-100');
            expect(inv.lines[0].description).toBe('Gutschrift Beratung');
            expect(inv.lines[0].quantity).toBe(1);
            // amounts stay positive in the data model, negative once they become document fields
            expect(inv.totals.gross).toBe(119);
            const fields = eInvoiceToFields(inv);
            expect(fields.total_gross).toBe(-119);
            expect(fields.tax_amount).toBe(-19);
        });

        await it('ZUGFeRD MINIMUM: totals are read even without lines or a VAT breakdown', async () => {
            const inv = parseEInvoiceXml(cii(MINIMUM, false));
            expect(inv.number).toBe('ZF-2026-5');
            expect(inv.lines.length).toBe(0);
            expect(inv.vat.length).toBe(0);
            expect(inv.totals.gross).toBe(119);
            expect(inv.seller.vatId).toBe('DE000000000');
        });

        await it('maps an invoice to document fields and receipt metadata', async () => {
            const inv = parseEInvoiceXml(UBL_INVOICE);
            const f = eInvoiceToFields(inv);
            expect(f.invoice_number).toBe('UBL-100');
            expect(f.invoice_date).toBe('2026-04-01');
            expect(f.due_date).toBe('2026-04-15');
            expect(f.total_net).toBe(100);
            expect(f.total_gross).toBe(119);
            expect(f.tax_amount).toBe(19);
            expect(f.tax_rate).toBe('19%');
            expect(f.supplier_vat_id).toBe('DE000000000');
            expect(f.supplier_country).toBe('DE');
            expect(f.reverse_charge).toBe(false);
            const m = eInvoiceToReceiptMetadata(inv);
            expect(m.correspondent).toBe('Lieferant GmbH');
            expect(m.title).toBe('Lieferant GmbH UBL-100');
            expect(m.gross).toBe(119);
        });

        await it('malformed XML gives a clear German error, never a crash', async () => {
            let message = '';
            try {
                parseEInvoiceXml('<Invoice><ID>1</Invoice>');
            } catch (e) {
                expect(e instanceof EInvoiceError).toBe(true);
                message = (e as Error).message;
            }
            expect(message).toContain('fehlerhaft');
            const truncated = buildCiiInvoiceXml(storedInvoice()).slice(0, 900);
            const reading = readEInvoice(utf8(truncated));
            expect(reading.invoice).toBe(null);
            expect(reading.error).toContain('fehlerhaft');
            expect(reading.classification.kind).toBe('sonstige-rechnung');
            expect(reading.classification.format).toBe('fehler');
        });

        await it('well-formed XML that is no invoice, and ZUGFeRD 1.x, are named as such', async () => {
            const other = readEInvoice(utf8('<?xml version="1.0"?><Bestellung><ID>1</ID></Bestellung>'));
            expect(other.error).toContain('Keine Rechnung');
            expect(other.classification.kind).toBe('sonstige-rechnung');
            const v1 = readEInvoice(
                utf8(
                    '<?xml version="1.0"?><rsm:CrossIndustryDocument xmlns:rsm="urn:ferd:CrossIndustryDocument:invoice:1p0"/>',
                ),
            );
            expect(v1.invoice).toBe(null);
            expect(v1.error).toBe(null);
            expect(v1.classification.format).toBe('zugferd-1');
            expect(v1.classification.kind).toBe('sonstige-rechnung');
        });

        await it('reads a Latin-1 encoded XML file', async () => {
            const xml = cii(EN16931)
                .replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')
                .replace('Lieferant GmbH', 'Müller GmbH');
            const inv = parseEInvoiceXml(
                new TextDecoder('windows-1252').decode(new Uint8Array(Buffer.from(xml, 'latin1'))),
            );
            expect(inv.seller.name).toBe('Müller GmbH');
            const reading = readEInvoice(new Uint8Array(Buffer.from(xml, 'latin1')));
            expect(reading.invoice?.seller.name).toBe('Müller GmbH');
        });
    });

    await describe('E-Rechnung lesen — Klassifizierung (§14 UStG)', async () => {
        const cases: Array<[string, string | null, 'e-rechnung' | 'sonstige-rechnung', string | null]> = [
            [
                'XRechnung 3.0',
                'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
                'e-rechnung',
                'XRECHNUNG',
            ],
            [
                'XRechnung 2.3',
                'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3',
                'e-rechnung',
                'XRECHNUNG',
            ],
            ['EN 16931 / COMFORT', 'urn:cen.eu:en16931:2017', 'e-rechnung', 'EN 16931'],
            ['Factur-X BASIC', 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic', 'e-rechnung', 'BASIC'],
            [
                'Factur-X EXTENDED',
                'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended',
                'e-rechnung',
                'EXTENDED',
            ],
            ['ZUGFeRD 2.0 BASIC', 'urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic', 'e-rechnung', 'BASIC'],
            ['Factur-X MINIMUM', 'urn:factur-x.eu:1p0:minimum', 'sonstige-rechnung', 'MINIMUM'],
            ['Factur-X BASIC WL', 'urn:factur-x.eu:1p0:basicwl', 'sonstige-rechnung', 'BASIC-WL'],
            ['ZUGFeRD 2.0 MINIMUM', 'urn:zugferd.de:2p0:minimum', 'sonstige-rechnung', 'MINIMUM'],
            ['ZUGFeRD 2.0 BASIC WL', 'urn:zugferd.de:2p0:basicwl', 'sonstige-rechnung', 'BASIC-WL'],
            ['ZUGFeRD 1.x', 'urn:ferd:CrossIndustryDocument:invoice:1p0:comfort', 'sonstige-rechnung', null],
            ['unbekannt', 'urn:example:meine-rechnung', 'sonstige-rechnung', null],
            ['ohne Leitfaden-ID', null, 'sonstige-rechnung', null],
        ];
        for (const [label, urn, kind, profile] of cases) {
            await it(`${label} → ${kind}`, async () => {
                const c = classifyGuideline(urn, true);
                expect(c.kind).toBe(kind);
                expect(c.profile).toBe(profile);
                expect(c.reason.length).toBeGreaterThan(20);
            });
        }

        await it('a ZUGFeRD 2.0 URN cannot tell 2.0.0 from 2.0.1 and says so in the reason', async () => {
            const c = classifyGuideline('urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic', true);
            expect(c.reason).toContain('2.0.1');
        });
    });

    await describe('E-Rechnung lesen — hybrides PDF', async () => {
        await it('extracts a FlateDecode-compressed factur-x.xml; the XML wins', async () => {
            const pdf = buildHybridPdf({ xml: cii(EN16931) });
            const embedded = extractEmbeddedXml(pdf);
            expect(embedded?.name).toBe('factur-x.xml');
            expect(new TextDecoder().decode(embedded!.bytes)).toContain('ZF-2026-5');
            const reading = readEInvoice(pdf);
            expect(reading.source).toBe('pdf');
            expect(reading.embeddedName).toBe('factur-x.xml');
            expect(reading.invoice?.number).toBe('ZF-2026-5');
            expect(reading.classification.kind).toBe('e-rechnung');
            expect(reading.classification.format).toBe('zugferd');
            expect(reading.classification.profile).toBe('EN 16931');
        });

        await it('an uncompressed attachment under another known name works too', async () => {
            const reading = readEInvoice(buildHybridPdf({ xml: UBL_INVOICE, name: 'xrechnung.xml', compress: false }));
            expect(reading.embeddedName).toBe('xrechnung.xml');
            expect(reading.invoice?.number).toBe('UBL-100');
            expect(reading.classification.format).toBe('xrechnung');
        });

        await it('finds a file specification inside a compressed object stream', async () => {
            const reading = readEInvoice(buildHybridPdf({ xml: cii(EN16931), objectStream: true }));
            expect(reading.invoice?.number).toBe('ZF-2026-5');
        });

        await it('a hybrid PDF with the MINIMUM profile is a sonstige Rechnung', async () => {
            const reading = readEInvoice(buildHybridPdf({ xml: cii(MINIMUM, false) }));
            expect(reading.invoice?.totals.gross).toBe(119);
            expect(reading.classification.kind).toBe('sonstige-rechnung');
            expect(reading.classification.profile).toBe('MINIMUM');
        });

        await it('a PDF without a data set is a sonstige Rechnung; so is a scan', async () => {
            const plain = readEInvoice(buildHybridPdf());
            expect(plain.invoice).toBe(null);
            expect(plain.classification.kind).toBe('sonstige-rechnung');
            expect(plain.classification.format).toBe('ohne-datensatz');
            expect(plain.classification.reason).toContain('PDF ohne');
            const scan = readEInvoice(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]));
            expect(scan.source).toBe('sonstiges');
            expect(scan.classification.format).toBe('ohne-datensatz');
        });

        await it('a broken attachment and an encrypted PDF are reported in German, not thrown', async () => {
            const broken = readEInvoice(
                buildHybridPdf({ xml: '<CrossIndustryInvoice><ExchangedDocument></CrossIndustryInvoice>' }),
            );
            expect(broken.error).toContain('fehlerhaft');
            expect(broken.classification.kind).toBe('sonstige-rechnung');
            const enc = new Uint8Array(
                Buffer.from(
                    '%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF',
                    'latin1',
                ),
            );
            const reading = readEInvoice(enc);
            expect(reading.error).toContain('verschlüsselt');
            expect(reading.classification.kind).toBe('sonstige-rechnung');
        });

        await it('compares the PDF text with the XML and warns when the gross differs', async () => {
            const inv = parseEInvoiceXml(cii(EN16931));
            expect(comparePdfText(inv, 'Summe brutto 119,00 EUR, darin USt 19,00 EUR').length).toBe(0);
            const warnings = comparePdfText(inv, 'Summe brutto 130,00 EUR, darin USt 19,00 EUR');
            expect(warnings.length).toBe(1);
            expect(warnings[0]).toContain('Bruttobetrag');
            expect(comparePdfText(inv, 'ohne Zahlen').length).toBe(0);
        });

        await it('with a real text layer (Poppler): matching text is silent, a differing total warns', async () => {
            const same = buildHybridPdf({ xml: cii(EN16931), text: 'Gesamt 119,00 EUR USt 19,00 EUR' });
            const text = extractPdfText(same);
            if (text == null) return; // no Poppler on this machine — the pure comparison is covered above
            expect(readEInvoice(same, { pdfText: extractPdfText }).warnings.length).toBe(0);
            const differs = buildHybridPdf({ xml: cii(EN16931), text: 'Gesamt 130,00 EUR USt 19,00 EUR' });
            const reading = readEInvoice(differs, { pdfText: extractPdfText });
            expect(reading.warnings.some((w) => w.includes('Bruttobetrag'))).toBe(true);
            expect(reading.invoice?.totals.gross).toBe(119); // the XML still wins
        });
    });

    await describe('E-Rechnung lesen — ohne KI importieren', async () => {
        let calls = 0;
        const counting: LLMProvider = {
            name: 'zaehler',
            model: 'keins',
            complete: async () => {
                calls++;
                return { text: '{"invoice_number":"KI-1","total_gross":42}' } as never;
            },
        };
        const withCounting = async (fn: () => Promise<void>): Promise<void> => {
            calls = 0;
            setLLMProviderOverride(counting);
            try {
                await fn();
            } finally {
                setLLMProviderOverride(null);
            }
        };

        await it('Paperless extraction: an e-invoice PDF fills the fields with no AI call and no KI tag', async () => {
            await withCounting(async () => {
                const pdf = buildHybridPdf({ xml: cii(EN16931) });
                const res = await runInvoiceExtractionForDocument(paperlessDoc(), config, 'incoming_invoice', {
                    fetchOriginal: async () => pdf,
                });
                expect(calls).toBe(0);
                expect(res?.source).toBe('e-rechnung');
                const fields = res!.payload.custom_fields!;
                expect(String(fields.find((f) => f.field === 11)?.value)).toBe('ZF-2026-5');
                expect(String(fields.find((f) => f.field === 15)?.value)).toContain('119');
                expect(kindValue(fields).startsWith('e-rechnung|')).toBe(true);
                expect(res!.payload.tags).toBe(undefined);
            });
        });

        await it('Paperless extraction: an e-invoice needs no OCR text at all', async () => {
            await withCounting(async () => {
                const pdf = buildHybridPdf({ xml: cii(EN16931) });
                const res = await runInvoiceExtractionForDocument(
                    paperlessDoc({ content: '' }),
                    config,
                    'incoming_invoice',
                    {
                        original: pdf,
                    },
                );
                expect(calls).toBe(0);
                expect(res?.source).toBe('e-rechnung');
            });
        });

        await it('Paperless extraction: a plain PDF still goes to the AI, is classified sonstige, gets the KI tag', async () => {
            await withCounting(async () => {
                const res = await runInvoiceExtractionForDocument(paperlessDoc(), config, 'incoming_invoice', {
                    original: buildHybridPdf(),
                });
                expect(calls).toBe(1);
                expect(res?.source).toBe('ai');
                expect(kindValue(res!.payload.custom_fields).startsWith('sonstige-rechnung|')).toBe(true);
                expect(res!.payload.tags?.includes(99)).toBe(true);
            });
        });

        await it('Paperless extraction: aiAllowed=false records only the classification and never calls the AI', async () => {
            await withCounting(async () => {
                const res = await runInvoiceExtractionForDocument(paperlessDoc(), config, 'incoming_invoice', {
                    original: buildHybridPdf(),
                    aiAllowed: false,
                });
                expect(calls).toBe(0);
                expect(res?.source).toBe('nur-einstufung');
                expect(res!.payload.custom_fields!.length).toBe(1);
            });
        });

        await it('Paperless extraction: an unreachable original falls back to the AI as before', async () => {
            await withCounting(async () => {
                const res = await runInvoiceExtractionForDocument(paperlessDoc(), config, 'incoming_invoice', {
                    fetchOriginal: async () => {
                        throw new Error('Paperless nicht erreichbar');
                    },
                });
                expect(calls).toBe(1);
                expect(res?.source).toBe('ai');
            });
        });

        const inTempStore = async (fn: () => Promise<void>): Promise<void> => {
            const prev = [process.env.TRANSACTIONS_DATA_DIR, process.env.LEDGER_DB_PATH];
            const dir = mkdtempSync(join(tmpdir(), 'bh-erechnung-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            try {
                await fn();
            } finally {
                for (const [i, k] of ['TRANSACTIONS_DATA_DIR', 'LEDGER_DB_PATH'].entries()) {
                    if (prev[i] === undefined) delete process.env[k];
                    else process.env[k] = prev[i];
                }
                rmSync(dir, { recursive: true, force: true });
            }
        };

        await it('built-in DMS upload: a hybrid PDF is filled from its XML with no AI call', async () => {
            await withCounting(async () =>
                inTempStore(async () => {
                    const dms = new BuiltinDmsProvider('gbr');
                    const doc = await storeReceipt(dms, {
                        bytes: buildHybridPdf({ xml: cii(EN16931) }),
                        filename: 'lieferant.pdf',
                        today: '2026-06-01',
                    });
                    expect(calls).toBe(0);
                    expect(doc.invoiceKind).toBe('e-rechnung');
                    expect(doc.invoiceKindReason).toContain('E-Rechnung');
                    expect(doc.correspondent).toBe('Lieferant GmbH');
                    expect(doc.invoiceNumber).toBe('ZF-2026-5');
                    expect(doc.created).toBe('2026-05-10');
                    expect(doc.gross).toBe(119);
                    expect(doc.net).toBe(100);
                    expect(doc.vat).toBe(19);
                    const again = await dms.get(doc.id);
                    expect(again?.invoiceKind).toBe('e-rechnung');
                }),
            );
        });

        await it('built-in DMS upload: a plain PDF is classified sonstige and keeps its upload date', async () => {
            await inTempStore(async () => {
                const dms = new BuiltinDmsProvider('gbr');
                const doc = await storeReceipt(dms, {
                    bytes: buildHybridPdf(),
                    filename: 'scan.pdf',
                    today: '2026-06-01',
                });
                expect(doc.invoiceKind).toBe('sonstige-rechnung');
                expect(doc.invoiceNumber).toBe(null);
                expect(doc.created).toBe('2026-06-01');
            });
        });

        await it('schema v18 adds the classification columns to an existing v17 database', async () => {
            const db = openLedger(':memory:');
            db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            db.exec(`INSERT INTO schema_meta(key, value) VALUES('schema_version', '17')`);
            db.exec(
                `CREATE TABLE documents (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT, created TEXT, filename TEXT NOT NULL, file_path TEXT NOT NULL)`,
            );
            migrate(db);
            expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
            const cols = (db.prepare(`PRAGMA table_info(documents)`).all() as unknown as Array<{ name: string }>).map(
                (c) => c.name,
            );
            expect(cols.includes('invoice_kind')).toBe(true);
            expect(cols.includes('invoice_kind_reason')).toBe(true);
            db.close();
        });
    });

    await describe('E-Rechnung lesen — Vorbelegung aus der letzten Rechnung', async () => {
        const rec = (id: string, date: string, over: Partial<PrefillRecord> = {}): PrefillRecord => ({
            id,
            correspondent: 'Lieferant GmbH',
            date,
            direction: 'incoming',
            net: 100,
            vat: 19,
            gross: 119,
            ...over,
        });

        await it("takes VAT rate, direction, category and payment term from the sender's newest invoice", async () => {
            const history = [
                rec('a', '2026-01-10', { net: 100, vat: 7, gross: 107, category: '4930 Bürobedarf' }),
                rec('b', '2026-03-10', { category: '4964 Software/Lizenzen', dueDate: '2026-03-24' }),
                rec('c', '2026-04-01', { correspondent: 'Andere GmbH' }),
            ];
            const p = prefillFromLastInvoice(history, ' lieferant  GmbH ');
            expect(p?.sourceId).toBe('b');
            expect(p?.vatRate).toBe(0.19);
            expect(p?.category).toBe('4964 Software/Lizenzen');
            expect(p?.paymentTermDays).toBe(14);
            expect(p?.direction).toBe('incoming');
        });

        await it('is null for an unknown sender and never suggests the document itself', async () => {
            expect(prefillFromLastInvoice([rec('a', '2026-01-10')], 'Niemand AG')).toBe(null);
            expect(prefillFromLastInvoice([rec('a', '2026-01-10')], 'Lieferant GmbH', 'a')).toBe(null);
            expect(prefillFromLastInvoice([], 'Lieferant GmbH')).toBe(null);
            expect(prefillFromLastInvoice([rec('a', '2026-01-10')], null)).toBe(null);
        });

        await it('skips a newer invoice that says nothing useful and falls back to an older one', async () => {
            const history = [rec('old', '2026-01-10'), rec('new', '2026-05-01', { net: null, vat: null, gross: 50 })];
            expect(prefillFromLastInvoice(history, 'Lieferant GmbH')?.sourceId).toBe('old');
        });
    });
};
