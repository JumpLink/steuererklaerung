/**
 * Reader for the two EN 16931 syntaxes of an XRechnung / ZUGFeRD data set: UN/CEFACT CII (the
 * counterpart of our writer `core/invoices/cii-xml.ts`) and OASIS UBL (Invoice and CreditNote).
 *
 * Pure: bytes/text in, one normalised {@link EInvoice} out. Every refusal is an
 * {@link EInvoiceError} with a German sentence — a malformed file must never surface as a stack trace.
 * NOT validated here: the KoSIT XSD/Schematron rules (see docs/ideen-nutzerfuehrung.md, Idee 2).
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { EInvoiceError, type EInvoice, type EInvoiceLine, type EInvoiceParty, type EInvoiceVat } from './types.ts';

// parseTagValue off: ids like "00123" and amounts like "10.50" must reach us as written.
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
});

// ── tree helpers (fast-xml-parser yields a string, an object, or an array of either) ──────────

const asArray = (n: unknown): unknown[] => (n == null ? [] : Array.isArray(n) ? n : [n]);

/** Descend through `path`, taking the first element wherever the parser produced an array. */
function at(n: unknown, ...path: string[]): unknown {
    let cur: unknown = n;
    for (const key of path) {
        if (Array.isArray(cur)) cur = cur[0];
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[key];
    }
    return Array.isArray(cur) ? cur[0] : cur;
}

function text(n: unknown): string | null {
    const raw = Array.isArray(n) ? n[0] : n;
    if (raw == null) return null;
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw).trim() || null;
    if (typeof raw === 'object') {
        const t = (raw as Record<string, unknown>)['#text'];
        return t == null ? null : String(t).trim() || null;
    }
    return null;
}

function attr(n: unknown, name: string): string | null {
    const raw = Array.isArray(n) ? n[0] : n;
    if (raw == null || typeof raw !== 'object') return null;
    const v = (raw as Record<string, unknown>)[`@_${name}`];
    return v == null ? null : String(v);
}

function num(n: unknown): number | null {
    const t = text(n);
    if (t == null) return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
}

/** CII format 102 (YYYYMMDD) or ISO (YYYY-MM-DD) → YYYY-MM-DD. */
function isoDate(n: unknown): string | null {
    const t = text(n);
    if (!t) return null;
    if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    return null;
}

/** UNTDID 1001 codes that mean "credit note" (EN 16931 §6.1.4 lists 381 for the credit note). */
const CREDIT_NOTE_CODES = new Set(['381', '396', '261', '81']);

const emptyParty = (): EInvoiceParty => ({
    name: null,
    vatId: null,
    taxNumber: null,
    street: null,
    zip: null,
    city: null,
    country: null,
    email: null,
    iban: null,
});

// ── entry point ───────────────────────────────────────────────────────────────────────────────

/** Decode XML bytes: UTF-8 unless the declaration names a Latin-1 family encoding. */
export function decodeXml(bytes: Uint8Array): string {
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 200));
    const declared = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase();
    if (declared && /^(iso-8859-1|iso-8859-15|latin1|windows-1252)$/.test(declared)) {
        try {
            return new TextDecoder('windows-1252').decode(bytes);
        } catch {
            // fall through to UTF-8
        }
    }
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

/**
 * Parse an XRechnung / ZUGFeRD ≥ 2 XML document. Throws {@link EInvoiceError}:
 *   `xml`       — not well-formed XML,
 *   `format`    — well-formed, but not an invoice in either syntax,
 *   `zugferd-1` — ZUGFeRD 1.x (`CrossIndustryDocument`), a different schema we do not read.
 */
export function parseEInvoiceXml(xml: string): EInvoice {
    const valid = XMLValidator.validate(xml);
    if (valid !== true) {
        const e = valid.err;
        throw new EInvoiceError(`Die XML-Datei ist fehlerhaft (Zeile ${e.line}): ${e.msg}`, 'xml');
    }
    let tree: Record<string, unknown>;
    try {
        tree = parser.parse(xml) as Record<string, unknown>;
    } catch (err) {
        throw new EInvoiceError(`Die XML-Datei lässt sich nicht lesen: ${(err as Error).message}`, 'xml');
    }
    // `in`, not truthiness: an empty root element parses to '' and must still be recognised.
    if ('CrossIndustryInvoice' in tree) return parseCii(tree.CrossIndustryInvoice);
    if ('Invoice' in tree) return parseUbl(tree.Invoice, 'invoice');
    if ('CreditNote' in tree) return parseUbl(tree.CreditNote, 'credit-note');
    if ('CrossIndustryDocument' in tree) {
        throw new EInvoiceError(
            'ZUGFeRD 1.x (CrossIndustryDocument) wird nicht gelesen — es ist keine E-Rechnung im Sinne des UStG.',
            'zugferd-1',
        );
    }
    const root = Object.keys(tree).find((k) => !k.startsWith('?')) ?? '(leer)';
    throw new EInvoiceError(
        `Keine Rechnung: Wurzelelement „${root}“ ist weder CrossIndustryInvoice (CII) noch Invoice/CreditNote (UBL).`,
        'format',
    );
}

// ── CII ───────────────────────────────────────────────────────────────────────────────────────

function ciiParty(n: unknown): EInvoiceParty {
    const p = emptyParty();
    if (n == null || typeof n !== 'object') return p;
    p.name = text(at(n, 'Name'));
    const addr = at(n, 'PostalTradeAddress');
    p.street = text(at(addr, 'LineOne'));
    p.zip = text(at(addr, 'PostcodeCode'));
    p.city = text(at(addr, 'CityName'));
    p.country = text(at(addr, 'CountryID'));
    p.email = text(at(n, 'URIUniversalCommunication', 'URIID'));
    for (const reg of asArray((n as Record<string, unknown>).SpecifiedTaxRegistration)) {
        const id = text(at(reg, 'ID'));
        const scheme = attr(at(reg, 'ID'), 'schemeID');
        if (!id) continue;
        if (scheme === 'VA') p.vatId ??= id;
        else if (scheme === 'FC') p.taxNumber ??= id;
    }
    return p;
}

function ciiVat(n: unknown): EInvoiceVat {
    return {
        category: text(at(n, 'CategoryCode')),
        rate: num(at(n, 'RateApplicablePercent')),
        basis: num(at(n, 'BasisAmount')),
        amount: num(at(n, 'CalculatedAmount')),
    };
}

function parseCii(root: unknown): EInvoice {
    const doc = at(root, 'ExchangedDocument');
    const tx = at(root, 'SupplyChainTradeTransaction');
    if (tx == null || doc == null) {
        throw new EInvoiceError(
            'Die CII-Datei ist unvollständig: ExchangedDocument oder SupplyChainTradeTransaction fehlt.',
            'format',
        );
    }
    const agreement = at(tx, 'ApplicableHeaderTradeAgreement');
    const settlement = at(tx, 'ApplicableHeaderTradeSettlement');
    const sum = at(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');

    const seller = ciiParty(at(agreement, 'SellerTradeParty'));
    seller.iban = null;
    for (const means of asArray(
        (settlement as Record<string, unknown> | undefined)?.SpecifiedTradeSettlementPaymentMeans,
    )) {
        const iban = text(at(means, 'PayeePartyCreditorFinancialAccount', 'IBANID'));
        if (iban) {
            seller.iban = iban.replace(/\s+/g, '');
            break;
        }
    }

    const terms = asArray((settlement as Record<string, unknown> | undefined)?.SpecifiedTradePaymentTerms);
    const termTexts = terms.map((t) => text(at(t, 'Description'))).filter((t): t is string => t != null);
    const dueDate =
        terms.map((t) => isoDate(at(t, 'DueDateDateTime', 'DateTimeString'))).find((d) => d != null) ?? null;

    const lines: EInvoiceLine[] = asArray((tx as Record<string, unknown>).IncludedSupplyChainTradeLineItem).map(
        (li) => {
            const qty = at(li, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
            const tax = at(li, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax');
            return {
                id: text(at(li, 'AssociatedDocumentLineDocument', 'LineID')),
                description:
                    text(at(li, 'SpecifiedTradeProduct', 'Name')) ??
                    text(at(li, 'SpecifiedTradeProduct', 'Description')),
                quantity: num(qty),
                unit: attr(qty, 'unitCode'),
                unitPriceNet: num(at(li, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount')),
                net: num(
                    at(
                        li,
                        'SpecifiedLineTradeSettlement',
                        'SpecifiedTradeSettlementLineMonetarySummation',
                        'LineTotalAmount',
                    ),
                ),
                vatRate: num(at(tax, 'RateApplicablePercent')),
                vatCategory: text(at(tax, 'CategoryCode')),
            };
        },
    );

    const currency = text(at(settlement, 'InvoiceCurrencyCode'));
    const gross = num(at(sum, 'GrandTotalAmount'));
    const net = num(at(sum, 'TaxBasisTotalAmount')) ?? num(at(sum, 'LineTotalAmount'));
    // TaxTotalAmount may repeat per currency; take the one in the document currency, else the first.
    const taxTotals = asArray((sum as Record<string, unknown> | undefined)?.TaxTotalAmount);
    const taxNode = taxTotals.find((t) => attr(t, 'currencyID') === currency) ?? taxTotals[0];
    const vat = num(taxNode) ?? (gross != null && net != null ? Math.round((gross - net) * 100) / 100 : null);

    const typeCode = text(at(doc, 'TypeCode'));
    return {
        syntax: 'cii',
        documentKind: typeCode != null && CREDIT_NOTE_CODES.has(typeCode) ? 'credit-note' : 'invoice',
        typeCode,
        guidelineId: text(at(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')),
        profileId: text(at(root, 'ExchangedDocumentContext', 'BusinessProcessSpecifiedDocumentContextParameter', 'ID')),
        number: text(at(doc, 'ID')),
        issueDate: isoDate(at(doc, 'IssueDateTime', 'DateTimeString')),
        dueDate,
        paymentTerms: termTexts.length ? termTexts.join(' ') : null,
        currency,
        buyerReference: text(at(agreement, 'BuyerReference')),
        precedingNumber: text(at(settlement, 'InvoiceReferencedDocument', 'IssuerAssignedID')),
        servicePeriodStart: isoDate(at(settlement, 'BillingSpecifiedPeriod', 'StartDateTime', 'DateTimeString')),
        servicePeriodEnd: isoDate(at(settlement, 'BillingSpecifiedPeriod', 'EndDateTime', 'DateTimeString')),
        seller,
        buyer: ciiParty(at(agreement, 'BuyerTradeParty')),
        lines,
        vat: asArray((settlement as Record<string, unknown> | undefined)?.ApplicableTradeTax).map(ciiVat),
        totals: {
            net,
            vat,
            gross,
            prepaid: num(at(sum, 'TotalPrepaidAmount')),
            due: num(at(sum, 'DuePayableAmount')),
        },
    };
}

// ── UBL ───────────────────────────────────────────────────────────────────────────────────────

function ublParty(n: unknown): EInvoiceParty {
    const p = emptyParty();
    const party = at(n, 'Party');
    if (party == null) return p;
    p.name = text(at(party, 'PartyLegalEntity', 'RegistrationName')) ?? text(at(party, 'PartyName', 'Name'));
    const addr = at(party, 'PostalAddress');
    p.street = text(at(addr, 'StreetName'));
    p.zip = text(at(addr, 'PostalZone'));
    p.city = text(at(addr, 'CityName'));
    p.country = text(at(addr, 'Country', 'IdentificationCode'));
    p.email = text(at(party, 'Contact', 'ElectronicMail')) ?? text(at(party, 'EndpointID'));
    for (const scheme of asArray((party as Record<string, unknown>).PartyTaxScheme)) {
        const id = text(at(scheme, 'CompanyID'));
        if (!id) continue;
        if (text(at(scheme, 'TaxScheme', 'ID')) === 'VAT') p.vatId ??= id;
        else p.taxNumber ??= id;
    }
    return p;
}

function ublVat(n: unknown): EInvoiceVat {
    return {
        category: text(at(n, 'TaxCategory', 'ID')),
        rate: num(at(n, 'TaxCategory', 'Percent')),
        basis: num(at(n, 'TaxableAmount')),
        amount: num(at(n, 'TaxAmount')),
    };
}

function parseUbl(root: unknown, rootKind: 'invoice' | 'credit-note'): EInvoice {
    const r = root as Record<string, unknown>;
    const typeCode = text(at(root, rootKind === 'credit-note' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'));
    const currency = text(at(root, 'DocumentCurrencyCode'));

    const seller = ublParty(at(root, 'AccountingSupplierParty'));
    for (const means of asArray(r.PaymentMeans)) {
        const iban = text(at(means, 'PayeeFinancialAccount', 'ID'));
        if (iban) {
            seller.iban = iban.replace(/\s+/g, '');
            break;
        }
    }

    const vat: EInvoiceVat[] = [];
    const taxTotals = asArray(r.TaxTotal);
    const taxTotal = taxTotals.find((t) => attr(at(t, 'TaxAmount'), 'currencyID') === currency) ?? taxTotals[0];
    for (const sub of asArray((taxTotal as Record<string, unknown> | undefined)?.TaxSubtotal)) vat.push(ublVat(sub));

    const sum = at(root, 'LegalMonetaryTotal');
    const gross = num(at(sum, 'TaxInclusiveAmount'));
    const net = num(at(sum, 'TaxExclusiveAmount')) ?? num(at(sum, 'LineExtensionAmount'));
    const vatTotal =
        num(at(taxTotal, 'TaxAmount')) ?? (gross != null && net != null ? Math.round((gross - net) * 100) / 100 : null);

    const lines: EInvoiceLine[] = asArray(rootKind === 'credit-note' ? r.CreditNoteLine : r.InvoiceLine).map((li) => {
        const qty = at(li, rootKind === 'credit-note' ? 'CreditedQuantity' : 'InvoicedQuantity');
        const item = at(li, 'Item');
        return {
            id: text(at(li, 'ID')),
            description: text(at(item, 'Name')) ?? text(at(item, 'Description')),
            quantity: num(qty),
            unit: attr(qty, 'unitCode'),
            unitPriceNet: num(at(li, 'Price', 'PriceAmount')),
            net: num(at(li, 'LineExtensionAmount')),
            vatRate: num(at(item, 'ClassifiedTaxCategory', 'Percent')),
            vatCategory: text(at(item, 'ClassifiedTaxCategory', 'ID')),
        };
    });

    const terms = asArray(r.PaymentTerms)
        .map((t) => text(at(t, 'Note')))
        .filter((t): t is string => t != null);
    return {
        syntax: 'ubl',
        documentKind:
            rootKind === 'credit-note' || (typeCode != null && CREDIT_NOTE_CODES.has(typeCode))
                ? 'credit-note'
                : 'invoice',
        typeCode,
        guidelineId: text(at(root, 'CustomizationID')),
        profileId: text(at(root, 'ProfileID')),
        number: text(at(root, 'ID')),
        issueDate: isoDate(at(root, 'IssueDate')),
        dueDate: isoDate(at(root, 'DueDate')),
        paymentTerms: terms.length ? terms.join(' ') : null,
        currency,
        buyerReference: text(at(root, 'BuyerReference')),
        precedingNumber: text(at(root, 'BillingReference', 'InvoiceDocumentReference', 'ID')),
        servicePeriodStart: isoDate(at(root, 'InvoicePeriod', 'StartDate')),
        servicePeriodEnd: isoDate(at(root, 'InvoicePeriod', 'EndDate')),
        seller,
        buyer: ublParty(at(root, 'AccountingCustomerParty')),
        lines,
        vat,
        totals: {
            net,
            vat: vatTotal,
            gross,
            prepaid: num(at(sum, 'PrepaidAmount')),
            due: num(at(sum, 'PayableAmount')),
        },
    };
}

/**
 * Plausibility notes for a parsed invoice (German, never fatal): missing mandatory fields and the
 * EN 16931 arithmetic BR-CO-15 (net + VAT = gross). The KoSIT validator remains the authority.
 */
export function eInvoiceWarnings(inv: EInvoice): string[] {
    const w: string[] = [];
    if (!inv.number) w.push('Rechnungsnummer fehlt in der Datei.');
    if (!inv.issueDate) w.push('Rechnungsdatum fehlt oder ist nicht lesbar.');
    if (!inv.seller.name) w.push('Name des Verkäufers fehlt.');
    if (inv.totals.gross == null) w.push('Bruttobetrag (GrandTotalAmount) fehlt.');
    const { net, vat, gross } = inv.totals;
    if (net != null && vat != null && gross != null && Math.abs(net + vat - gross) > 0.02) {
        w.push(`Netto + USt (${(net + vat).toFixed(2)}) passt nicht zum Brutto (${gross.toFixed(2)}).`);
    }
    return w;
}
