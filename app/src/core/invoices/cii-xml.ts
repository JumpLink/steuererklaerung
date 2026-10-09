/**
 * XRechnung / EN 16931 CII (CrossIndustryInvoice) generator for self-issued invoices.
 *
 * Produces the structured e-invoice XML (CII syntax, XRechnung 3.0 guideline) that a B2B buyer
 * may request. Output is DETERMINISTIC — fixed element order, amounts formatted to 2 decimals, no
 * generation timestamp beyond the invoice's own data — so re-generating from the frozen snapshot
 * yields byte-identical XML (it is archived unchanged and content-addressed). Built with plain
 * string templates + escaping (the codebase convention for XML, e.g. elster/eds-envelope.ts)
 * rather than a serializer, precisely to keep the bytes stable.
 *
 * Validated locally: mandatory-field presence ({@link ciiXmlProblems}) and the EN 16931 BR-CO
 * arithmetic (line sum = net total, net + VAT = gross, per-rate sums). NOT validated locally:
 * the KoSIT XSD/Schematron rules — there is no schematron engine on GJS/Node here; run the KoSIT
 * validator for spot checks.
 */

import { computeInvoiceTotals } from '@steuererklaerung/store';
import type { StoredInvoice } from '@steuererklaerung/store';

const GUIDELINE_ID = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

/** XML-escape element content / attribute values. */
function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Fixed 2-decimal amount with a dot separator (EN 16931 amounts). */
function amt(n: number): string {
    return n.toFixed(2);
}

/** Percentage 0.19 → "19.00" (up to 2 decimals, trailing-zero-padded for stability). */
function pct(rate: number): string {
    return (rate * 100).toFixed(2);
}

/** YYYY-MM-DD → CII udt:DateTimeString format="102" (YYYYMMDD). */
function ymd(date: string): string {
    return date.slice(0, 10).replace(/-/g, '');
}

/** One indented element with text content (omitted entirely when the value is empty). */
function tag(indent: string, name: string, value: string | null | undefined): string {
    if (value == null || value === '') return '';
    return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

/** VAT category: S (standard) for a rated line, E (exempt) for a 0 % line. */
function vatCategory(rate: number, kleinunternehmer: boolean): 'S' | 'E' {
    return kleinunternehmer || rate === 0 ? 'E' : 'S';
}

/**
 * Exemption reason (BT-121) for a category-E tax group. ONLY a §19 Kleinunternehmer may claim §19 —
 * emitting that text for any 0 % line of a regular business would put a false tax assertion into
 * the archived, immutable XRechnung. A non-§19 0 % line gets a neutral "steuerfrei" reason (a
 * precise per-line legal basis — §4 exemption, reverse charge, … — is not modelled yet).
 */
function exemptionReason(rate: number, kleinunternehmer: boolean): string | null {
    if (kleinunternehmer) return 'Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG';
    if (rate === 0) return 'steuerfrei';
    return null;
}

/** Options for storno / credit-note handling. */
export interface CiiXmlOptions {
    /** The cancelled invoice's number (BT-25), required for a storno credit note. */
    originalNumber?: string | null;
}

/**
 * Build the CII XML for one invoice. A storno is emitted as a credit note (TypeCode 381) with
 * POSITIVE amounts and an InvoiceReferencedDocument (BT-25) pointing at the cancelled invoice —
 * the conventional EN 16931 representation — so the stored negative totals are absolute-valued.
 */
export function buildCiiInvoiceXml(invoice: StoredInvoice, opts: CiiXmlOptions = {}): string {
    const issuer = invoice.issuer;
    const recipient = invoice.recipient;
    if (!issuer) throw new Error('CII: Aussteller-Snapshot fehlt (Rechnung nicht festgeschrieben?).');
    if (!recipient) throw new Error('CII: Empfänger-Snapshot fehlt (Rechnung nicht festgeschrieben?).');
    if (!invoice.number) throw new Error('CII: Rechnungsnummer fehlt (Rechnung nicht festgeschrieben?).');
    if (!invoice.issueDate) throw new Error('CII: Ausstellungsdatum fehlt.');

    const isStorno = invoice.kind === 'storno';
    const sign = isStorno ? -1 : 1; // stored storno totals are negative → flip to positive amounts
    const abs = (n: number): number => n * sign;
    const typeCode = isStorno ? '381' : '380';
    const kleinunternehmer = issuer.kleinunternehmer ?? false;

    // Per-rate totals from the (sign-normalised) items — the authoritative tax breakdown.
    const totals = computeInvoiceTotals(
        invoice.items.map((it) => ({
            quantity: it.quantity * sign,
            unitPriceNet: it.unitPriceNet,
            vatRate: it.vatRate,
        })),
    );

    let x = '';
    x += '<?xml version="1.0" encoding="UTF-8"?>\n';
    x +=
        '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
        ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
        ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">\n';

    // --- Context: the XRechnung guideline id ---
    x += '  <rsm:ExchangedDocumentContext>\n';
    x += '    <ram:GuidelineSpecifiedDocumentContextParameter>\n';
    x += `      <ram:ID>${GUIDELINE_ID}</ram:ID>\n`;
    x += '    </ram:GuidelineSpecifiedDocumentContextParameter>\n';
    x += '  </rsm:ExchangedDocumentContext>\n';

    // --- Document head ---
    x += '  <rsm:ExchangedDocument>\n';
    x += tag('    ', 'ram:ID', invoice.number);
    x += `    <ram:TypeCode>${typeCode}</ram:TypeCode>\n`;
    x += '    <ram:IssueDateTime>\n';
    x += `      <udt:DateTimeString format="102">${ymd(invoice.issueDate)}</udt:DateTimeString>\n`;
    x += '    </ram:IssueDateTime>\n';
    x += '  </rsm:ExchangedDocument>\n';

    x += '  <rsm:SupplyChainTradeTransaction>\n';

    // --- Line items ---
    invoice.items.forEach((it, i) => {
        const lineNet = abs(it.net);
        x += '    <ram:IncludedSupplyChainTradeLineItem>\n';
        x += '      <ram:AssociatedDocumentLineDocument>\n';
        x += `        <ram:LineID>${i + 1}</ram:LineID>\n`;
        x += '      </ram:AssociatedDocumentLineDocument>\n';
        x += '      <ram:SpecifiedTradeProduct>\n';
        x += tag('        ', 'ram:Name', it.title);
        if (it.description) x += tag('        ', 'ram:Description', it.description);
        x += '      </ram:SpecifiedTradeProduct>\n';
        x += '      <ram:SpecifiedLineTradeAgreement>\n';
        x += '        <ram:NetPriceProductTradePrice>\n';
        x += `          <ram:ChargeAmount>${amt(it.unitPriceNet)}</ram:ChargeAmount>\n`;
        x += '        </ram:NetPriceProductTradePrice>\n';
        x += '      </ram:SpecifiedLineTradeAgreement>\n';
        // unitCode: EN 16931 requires a UN/ECE Rec 20 code; C62 (one/piece) is the neutral
        // fallback — we don't map free-text German units (Std, Stück, …) onto specific codes.
        x += '      <ram:SpecifiedLineTradeDelivery>\n';
        x += `        <ram:BilledQuantity unitCode="C62">${amt(it.quantity * sign)}</ram:BilledQuantity>\n`;
        x += '      </ram:SpecifiedLineTradeDelivery>\n';
        x += '      <ram:SpecifiedLineTradeSettlement>\n';
        x += '        <ram:ApplicableTradeTax>\n';
        x += '          <ram:TypeCode>VAT</ram:TypeCode>\n';
        x += `          <ram:CategoryCode>${vatCategory(it.vatRate, kleinunternehmer)}</ram:CategoryCode>\n`;
        x += `          <ram:RateApplicablePercent>${pct(it.vatRate)}</ram:RateApplicablePercent>\n`;
        x += '        </ram:ApplicableTradeTax>\n';
        x += '        <ram:SpecifiedTradeSettlementLineMonetarySummation>\n';
        x += `          <ram:LineTotalAmount>${amt(lineNet)}</ram:LineTotalAmount>\n`;
        x += '        </ram:SpecifiedTradeSettlementLineMonetarySummation>\n';
        x += '      </ram:SpecifiedLineTradeSettlement>\n';
        x += '    </ram:IncludedSupplyChainTradeLineItem>\n';
    });

    // --- Agreement: buyer reference + seller + buyer parties ---
    x += '    <ram:ApplicableHeaderTradeAgreement>\n';
    if (invoice.buyerReference) x += tag('      ', 'ram:BuyerReference', invoice.buyerReference);
    x += '      <ram:SellerTradeParty>\n';
    x += tag('        ', 'ram:Name', issuer.name);
    x += '        <ram:DefinedTradeContact>\n';
    x += tag('          ', 'ram:PersonName', issuer.name);
    if (issuer.phone) {
        x += '          <ram:TelephoneUniversalCommunication>\n';
        x += tag('            ', 'ram:CompleteNumber', issuer.phone);
        x += '          </ram:TelephoneUniversalCommunication>\n';
    }
    if (issuer.email) {
        x += '          <ram:EmailURIUniversalCommunication>\n';
        x += tag('            ', 'ram:URIID', issuer.email);
        x += '          </ram:EmailURIUniversalCommunication>\n';
    }
    x += '        </ram:DefinedTradeContact>\n';
    x += '        <ram:PostalTradeAddress>\n';
    x += tag('          ', 'ram:PostcodeCode', issuer.zip);
    x += tag('          ', 'ram:LineOne', issuer.address);
    x += tag('          ', 'ram:CityName', issuer.city);
    x += tag('          ', 'ram:CountryID', issuer.countryCode || 'DE');
    x += '        </ram:PostalTradeAddress>\n';
    if (issuer.email) {
        x += '        <ram:URIUniversalCommunication>\n';
        x += `          <ram:URIID schemeID="EM">${esc(issuer.email)}</ram:URIID>\n`;
        x += '        </ram:URIUniversalCommunication>\n';
    }
    if (issuer.vatId) {
        x += '        <ram:SpecifiedTaxRegistration>\n';
        x += `          <ram:ID schemeID="VA">${esc(issuer.vatId)}</ram:ID>\n`;
        x += '        </ram:SpecifiedTaxRegistration>\n';
    }
    if (issuer.taxNumber) {
        x += '        <ram:SpecifiedTaxRegistration>\n';
        x += `          <ram:ID schemeID="FC">${esc(issuer.taxNumber)}</ram:ID>\n`;
        x += '        </ram:SpecifiedTaxRegistration>\n';
    }
    x += '      </ram:SellerTradeParty>\n';
    x += '      <ram:BuyerTradeParty>\n';
    x += tag('        ', 'ram:Name', recipient.name);
    x += '        <ram:PostalTradeAddress>\n';
    x += tag('          ', 'ram:PostcodeCode', recipient.zip);
    x += tag('          ', 'ram:LineOne', recipient.address);
    x += tag('          ', 'ram:CityName', recipient.city);
    x += tag('          ', 'ram:CountryID', recipient.countryCode || 'DE');
    x += '        </ram:PostalTradeAddress>\n';
    if (recipient.email) {
        x += '        <ram:URIUniversalCommunication>\n';
        x += `          <ram:URIID schemeID="EM">${esc(recipient.email)}</ram:URIID>\n`;
        x += '        </ram:URIUniversalCommunication>\n';
    }
    if (recipient.vatNumber) {
        x += '        <ram:SpecifiedTaxRegistration>\n';
        x += `          <ram:ID schemeID="VA">${esc(recipient.vatNumber)}</ram:ID>\n`;
        x += '        </ram:SpecifiedTaxRegistration>\n';
    }
    x += '      </ram:BuyerTradeParty>\n';
    x += '    </ram:ApplicableHeaderTradeAgreement>\n';

    // --- Delivery: performance date or billing period ---
    x += '    <ram:ApplicableHeaderTradeDelivery>\n';
    const perfEnd = invoice.performanceEnd ?? invoice.performanceStart;
    if (perfEnd) {
        x += '      <ram:ActualDeliverySupplyChainEvent>\n';
        x += '        <ram:OccurrenceDateTime>\n';
        x += `          <udt:DateTimeString format="102">${ymd(perfEnd)}</udt:DateTimeString>\n`;
        x += '        </ram:OccurrenceDateTime>\n';
        x += '      </ram:ActualDeliverySupplyChainEvent>\n';
    }
    x += '    </ram:ApplicableHeaderTradeDelivery>\n';

    // --- Settlement: payment means, per-rate tax, totals ---
    x += '    <ram:ApplicableHeaderTradeSettlement>\n';
    x += `      <ram:InvoiceCurrencyCode>${esc(invoice.currency || 'EUR')}</ram:InvoiceCurrencyCode>\n`;
    const iban = invoice.iban ?? issuer.bank?.iban ?? null;
    if (iban) {
        x += '      <ram:SpecifiedTradeSettlementPaymentMeans>\n';
        x += '        <ram:TypeCode>58</ram:TypeCode>\n';
        x += '        <ram:PayeePartyCreditorFinancialAccount>\n';
        x += `          <ram:IBANID>${esc(iban)}</ram:IBANID>\n`;
        if (issuer.bank?.accountHolder) x += tag('          ', 'ram:AccountName', issuer.bank.accountHolder);
        x += '        </ram:PayeePartyCreditorFinancialAccount>\n';
        x += '      </ram:SpecifiedTradeSettlementPaymentMeans>\n';
    }
    for (const r of totals.byRate) {
        x += '      <ram:ApplicableTradeTax>\n';
        x += `        <ram:CalculatedAmount>${amt(r.vat)}</ram:CalculatedAmount>\n`;
        x += '        <ram:TypeCode>VAT</ram:TypeCode>\n';
        const reason = exemptionReason(r.rate, kleinunternehmer);
        if (reason) x += `        <ram:ExemptionReason>${esc(reason)}</ram:ExemptionReason>\n`;
        x += `        <ram:BasisAmount>${amt(r.net)}</ram:BasisAmount>\n`;
        x += `        <ram:CategoryCode>${vatCategory(r.rate, kleinunternehmer)}</ram:CategoryCode>\n`;
        x += `        <ram:RateApplicablePercent>${pct(r.rate)}</ram:RateApplicablePercent>\n`;
        x += '      </ram:ApplicableTradeTax>\n';
    }
    if (invoice.performanceStart && invoice.performanceEnd) {
        x += '      <ram:BillingSpecifiedPeriod>\n';
        x += `        <ram:StartDateTime><udt:DateTimeString format="102">${ymd(invoice.performanceStart)}</udt:DateTimeString></ram:StartDateTime>\n`;
        x += `        <ram:EndDateTime><udt:DateTimeString format="102">${ymd(invoice.performanceEnd)}</udt:DateTimeString></ram:EndDateTime>\n`;
        x += '      </ram:BillingSpecifiedPeriod>\n';
    }
    if (invoice.dueDate) {
        x += '      <ram:SpecifiedTradePaymentTerms>\n';
        x += `        <ram:DueDateDateTime><udt:DateTimeString format="102">${ymd(invoice.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>\n`;
        x += '      </ram:SpecifiedTradePaymentTerms>\n';
    }
    x += '      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n';
    x += `        <ram:LineTotalAmount>${amt(totals.net)}</ram:LineTotalAmount>\n`;
    x += `        <ram:TaxBasisTotalAmount>${amt(totals.net)}</ram:TaxBasisTotalAmount>\n`;
    x += `        <ram:TaxTotalAmount currencyID="${esc(invoice.currency || 'EUR')}">${amt(totals.vat)}</ram:TaxTotalAmount>\n`;
    x += `        <ram:GrandTotalAmount>${amt(totals.gross)}</ram:GrandTotalAmount>\n`;
    x += `        <ram:DuePayableAmount>${amt(totals.gross)}</ram:DuePayableAmount>\n`;
    x += '      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n';
    // Storno → reference the cancelled invoice (BT-25). In CII D16B this belongs under
    // ApplicableHeaderTradeSettlement (after the MonetarySummation), NOT under the Agreement —
    // HeaderTradeAgreementType has no InvoiceReferencedDocument child, so the old placement was
    // XSD-invalid and the storno XRechnung was rejected by schema-validating inboxes / KoSIT.
    if (isStorno && opts.originalNumber) {
        x += '      <ram:InvoiceReferencedDocument>\n';
        x += tag('        ', 'ram:IssuerAssignedID', opts.originalNumber);
        x += '      </ram:InvoiceReferencedDocument>\n';
    }
    x += '    </ram:ApplicableHeaderTradeSettlement>\n';

    x += '  </rsm:SupplyChainTradeTransaction>\n';
    x += '</rsm:CrossIndustryInvoice>\n';
    return x;
}

/**
 * Pre-flight checks before emitting CII XML: EUR-only, the frozen §14 snapshots present, and the
 * EN 16931 BR-CO arithmetic (line net sum = total net; net + VAT = gross). Returns German
 * problems (empty = ok).
 */
export function ciiXmlProblems(invoice: StoredInvoice): string[] {
    const problems: string[] = [];
    if ((invoice.currency || 'EUR') !== 'EUR') problems.push('CII: nur EUR wird derzeit unterstützt.');
    if (!invoice.number) problems.push('CII: Rechnungsnummer fehlt (nicht festgeschrieben).');
    if (!invoice.issuer) problems.push('CII: Aussteller-Snapshot fehlt.');
    if (!invoice.recipient?.name) problems.push('CII: Empfänger fehlt.');
    if (!invoice.items?.length) problems.push('CII: keine Positionen.');

    const totals = computeInvoiceTotals(invoice.items ?? []);
    const cents = (n: number): number => Math.round(n * 100);
    const lineSum = (invoice.items ?? []).reduce((s, it) => s + cents(it.net), 0);
    if (lineSum !== cents(totals.net)) problems.push('CII: Summe der Positionen ≠ Nettobetrag (BR-CO-10).');
    if (cents(totals.net) + cents(totals.vat) !== cents(totals.gross))
        problems.push('CII: Netto + USt ≠ Brutto (BR-CO-15).');
    return problems;
}
