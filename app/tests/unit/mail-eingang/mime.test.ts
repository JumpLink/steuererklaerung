/**
 * Belege aus Mail (Idee 15): reading a message and choosing its receipts. Only PDF and e-invoice XML
 * qualify; an inline image, a signature, a calendar entry and an XML that is not an invoice do not.
 * All mail is invented.
 */
import { describe, it, expect } from '@gjsify/unit';
import { parseMail, readDate, readFrom, decodeEncodedWords } from '../../../src/core/mail-eingang/mime.ts';
import { safeFilename, selectAttachments } from '../../../src/core/mail-eingang/anhaenge.ts';
import { herkunftSatz, neueBelegeSatz, senderLabel } from '../../../src/core/mail-eingang/herkunft.ts';
import { fixturePdf, rawMail } from '../../helpers/mail-fixtures.ts';

const UBL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>UBL-100</cbc:ID>
  <cbc:IssueDate>2026-04-01</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>Lieferant GmbH</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Musterweg 1</cbc:StreetName><cbc:CityName>Musterstadt</cbc:CityName><cbc:PostalZone>12345</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE000000000</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Lieferant GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyLegalEntity><cbc:RegistrationName>Kunde AG</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="HUR">2</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Beratung</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">50.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;

export default async () => {
    await describe('Mail lesen — Kopfzeilen', async () => {
        await it('decodes an encoded-word sender and keeps the address', async () => {
            expect(readFrom('=?UTF-8?Q?Jos=C3=A9_M=C3=BCller?= <jose@lieferant.example>')).toBe(
                'José Müller <jose@lieferant.example>',
            );
            expect(readFrom('=?ISO-8859-1?B?QsO8cm8=?= <b@x.example>')).not.toBe(null);
            expect(readFrom('rechnung@lieferant.example')).toBe('rechnung@lieferant.example');
            expect(readFrom(undefined)).toBe(null);
        });

        await it('joins adjacent encoded words without the space between them', async () => {
            expect(decodeEncodedWords('=?UTF-8?Q?Gr=C3=BC?= =?UTF-8?Q?=C3=9Fe?=')).toBe('Grüße');
        });

        await it('takes the date as written, without a timezone shift', async () => {
            expect(readDate('Tue, 12 May 2026 09:30:00 +0200')).toBe('2026-05-12');
            expect(readDate('1 Jan 2026 23:59:00 -0800')).toBe('2026-01-01');
            expect(readDate('kein Datum')).toBe(null);
            expect(readDate(undefined)).toBe(null);
        });
    });

    await describe('Mail lesen — Anhänge auswählen', async () => {
        await it('keeps a PDF and drops an inline image and a signature', async () => {
            const mail = parseMail(
                rawMail({
                    parts: [
                        { type: 'text/plain', body: 'Anbei die Rechnung.' },
                        {
                            type: 'image/png',
                            disposition: 'inline',
                            filename: 'logo.png',
                            body: new Uint8Array([1, 2, 3]),
                        },
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            filename: 'Rechnung 4711.pdf',
                            body: fixturePdf('a'),
                        },
                        {
                            type: 'application/pkcs7-signature',
                            disposition: 'attachment',
                            filename: 'smime.p7s',
                            body: new Uint8Array([9, 9]),
                        },
                    ],
                }),
            );
            const found = selectAttachments(mail.parts, 'mail-1');
            expect(found.length).toBe(1);
            expect(found[0].filename).toBe('Rechnung 4711.pdf');
            expect(found[0].mimeType).toBe('application/pdf');
            expect(new TextDecoder().decode(found[0].bytes.subarray(0, 5))).toBe('%PDF-');
        });

        await it('accepts a PDF sent as application/octet-stream by its extension', async () => {
            const mail = parseMail(
                rawMail({
                    parts: [
                        {
                            type: 'application/octet-stream',
                            disposition: 'attachment',
                            filename: 'scan.PDF',
                            body: fixturePdf('b'),
                        },
                    ],
                }),
            );
            expect(selectAttachments(mail.parts, 'mail-2').map((a) => a.filename)).toStrictEqual(['scan.pdf']);
        });

        await it('keeps an e-invoice XML and drops an XML that is not an invoice', async () => {
            const mail = parseMail(
                rawMail({
                    parts: [
                        {
                            type: 'application/xml',
                            disposition: 'attachment',
                            filename: 'xrechnung.xml',
                            body: UBL_INVOICE,
                        },
                        {
                            type: 'text/xml',
                            disposition: 'attachment',
                            filename: 'sitemap.xml',
                            body: '<urlset><url><loc>x</loc></url></urlset>',
                        },
                        {
                            type: 'text/calendar',
                            disposition: 'attachment',
                            filename: 'termin.ics',
                            body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
                        },
                    ],
                }),
            );
            const found = selectAttachments(mail.parts, 'mail-3');
            expect(found.map((a) => a.filename)).toStrictEqual(['xrechnung.xml']);
            expect(found[0].mimeType).toBe('application/xml');
        });

        await it('reads a percent-encoded (RFC 2231) file name', async () => {
            const mail = parseMail(
                rawMail({
                    parts: [
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            filenameParam: "filename*=utf-8''Rechnung%20M%C3%A4rz.pdf",
                            body: fixturePdf('c'),
                        },
                    ],
                }),
            );
            expect(selectAttachments(mail.parts, 'mail-4')[0].filename).toBe('Rechnung März.pdf');
        });

        await it('names a file without a usable name after the message, and numbers further ones', async () => {
            const mail = parseMail(
                rawMail({
                    parts: [
                        { type: 'application/pdf', disposition: 'attachment', filename: '.pdf', body: fixturePdf('d') },
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            filename: '../../etc/passwd.pdf',
                            body: fixturePdf('e'),
                        },
                    ],
                }),
            );
            expect(selectAttachments(mail.parts, 'mail-5').map((a) => a.filename)).toStrictEqual([
                'mail-5.pdf',
                'passwd.pdf',
            ]);
        });

        await it('ignores an attached message instead of reading into it', async () => {
            const inner = new TextDecoder().decode(
                rawMail({
                    boundary: 'innere-grenze',
                    parts: [
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            filename: 'innen.pdf',
                            body: fixturePdf('f'),
                        },
                    ],
                }),
            );
            const mail = parseMail(
                rawMail({
                    parts: [
                        {
                            type: 'message/rfc822',
                            disposition: 'attachment',
                            filename: 'weitergeleitet.eml',
                            body: inner,
                            encoding: '7bit',
                        },
                    ],
                }),
            );
            expect(selectAttachments(mail.parts, 'mail-6').length).toBe(0);
        });

        await it('finds nothing in a mail with only text, and does not throw on garbage', async () => {
            expect(
                selectAttachments(parseMail(rawMail({ parts: [{ type: 'text/plain', body: 'Hallo' }] })).parts, 'm')
                    .length,
            ).toBe(0);
            expect(parseMail(new Uint8Array([0, 1, 2, 255])).parts.length).toBe(1);
            expect(parseMail(new TextEncoder().encode('kein Header')).from).toBe(null);
        });

        await it('keeps the sender (quoted display name) and the date of the message', async () => {
            const mail = parseMail(
                rawMail({
                    from: '"Beispiel, Anna" <anna@lieferant.example>',
                    date: 'Wed, 3 Jun 2026 08:00:00 +0000',
                    parts: [
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            filename: 'x.pdf',
                            body: fixturePdf('g'),
                        },
                    ],
                }),
            );
            expect(mail.from).toBe('Beispiel, Anna <anna@lieferant.example>');
            expect(mail.date).toBe('2026-06-03');
        });
    });

    await describe('Mail lesen — Dateiname und Herkunft', async () => {
        await it('strips path parts and control characters and forces the extension of the content', async () => {
            expect(safeFilename('C:\\x\\Beleg.exe', 'mail-1', 'pdf')).toBe('Beleg.pdf');
            expect(safeFilename('a\u0000b\nc.pdf', 'mail-1', 'pdf')).toBe('abc.pdf');
            expect(safeFilename(null, 'mail-1', 'xml')).toBe('mail-1.xml');
        });

        await it('says where a receipt came from — sender and date, nothing else', async () => {
            expect(
                herkunftSatz({ kind: 'mail', from: 'Anna Beispiel <anna@lieferant.example>', date: '2026-05-12' }),
            ).toBe('aus Mail von Anna Beispiel, 12.05.2026');
            expect(senderLabel('rechnung@lieferant.example')).toBe('rechnung@lieferant.example');
            expect(neueBelegeSatz(1)).toBe('1 neuer Beleg aus Mail');
            expect(neueBelegeSatz(3)).toBe('3 neue Belege aus Mail');
        });
    });
};
