/**
 * Runtime-agnostic invoice-PDF model. {@link buildInvoicePdfModel} turns a StoredInvoice (plus
 * the resolved issuer/recipient and an optional prebuilt SEPA GiroCode payload) into a flat,
 * render-ready structure — no cairo/Pango here, so it is fully Node-testable. The GJS renderer
 * (index.gjs.ts) consumes this; the layout math lives in layout.ts.
 */

import { computeInvoiceTotals } from '@steuererklaerung/store';
import type { InvoiceIssuerSnapshot, InvoiceRecipient, StoredInvoice } from '@steuererklaerung/store';

/** One rendered item row (all display strings pre-formatted de-DE where numeric). */
export interface PdfItemRow {
    position: number;
    title: string;
    description: string | null;
    quantity: string;
    unit: string | null;
    unitPrice: string;
    vatRate: string;
    net: string;
}

/** One per-VAT-rate total line. */
export interface PdfVatRow {
    label: string;
    net: string;
    vat: string;
}

/** The address-window recipient block + a small return-address sender line above it (DIN 5008). */
export interface PdfAddressBlock {
    /** One-line sender (issuer), shown small above the recipient window. */
    senderLine: string;
    /** Recipient lines (name, street, "zip city", country if not DE). */
    recipientLines: string[];
}

/** A labelled key/value pair in the info block (right of the address window). */
export interface PdfInfoRow {
    label: string;
    value: string;
}

/** One footer column (issuer contact / bank / tax), a list of lines. */
export interface PdfFooterColumn {
    heading: string;
    lines: string[];
}

/** The complete render model. */
export interface InvoicePdfModel {
    /** Document title, e.g. "Rechnung RE-2026-0001" / "Stornorechnung RE-2026-0002". */
    title: string;
    address: PdfAddressBlock;
    info: PdfInfoRow[];
    /** Intro paragraph above the table (header text), or null. */
    intro: string | null;
    items: PdfItemRow[];
    /** Column headers for the items table. */
    itemColumns: { pos: string; title: string; quantity: string; unitPrice: string; vat: string; net: string };
    vatRows: PdfVatRow[];
    totalNet: string;
    totalGross: string;
    grossLabel: string;
    /** Closing note (§19/§20 hints, footer text), or null. */
    note: string | null;
    footerColumns: PdfFooterColumn[];
    /** SEPA GiroCode payload to encode as a QR, or null (no bank details / draft). */
    qrPayload: string | null;
    /** Absolute/relative path to a PNG logo, or null. */
    logoPath: string | null;
    currency: string;
}

/** Format a number as de-DE with 2 decimals (no currency symbol), e.g. 1234.5 → "1.234,50". */
export function eur(n: number): string {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a quantity: integers without decimals, else de-DE with up to 3 places. */
function qty(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/** Percent for display: 0.19 → "19 %", 0.07 → "7 %", 0 → "0 %". */
function pct(rate: number): string {
    return `${(rate * 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
}

/** YYYY-MM-DD → DD.MM.YYYY (de). Returns the input unchanged if it doesn't parse. */
function deDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export interface BuildPdfModelOptions {
    /** Resolved issuer (defaults to invoice.issuer). Required for a meaningful document. */
    issuer?: InvoiceIssuerSnapshot | null;
    /** Resolved recipient (defaults to invoice.recipient). */
    recipient?: InvoiceRecipient | null;
    /** Prebuilt EPC069-12 GiroCode payload (the caller builds it from the bank IBAN + gross). */
    epcPayload?: string | null;
    /** PNG logo path (defaults to none). */
    logoPath?: string | null;
}

/** Build the render model from a stored invoice. Pure — no I/O, no rendering. */
export function buildInvoicePdfModel(invoice: StoredInvoice, opts: BuildPdfModelOptions = {}): InvoicePdfModel {
    const issuer = opts.issuer ?? invoice.issuer;
    const recipient = opts.recipient ?? invoice.recipient;
    if (!issuer) throw new Error('PDF: Aussteller fehlt.');
    if (!recipient) throw new Error('PDF: Empfänger fehlt.');

    const totals = computeInvoiceTotals(invoice.items);
    const isStorno = invoice.kind === 'storno';
    const numberOrDraft = invoice.number ?? 'Entwurf';
    const title = `${isStorno ? 'Stornorechnung' : 'Rechnung'} ${numberOrDraft}`;

    const senderParts = [issuer.name, issuer.address, [issuer.zip, issuer.city].filter(Boolean).join(' ')].filter(
        Boolean,
    );
    const recipientLines = [
        recipient.name,
        recipient.address ?? '',
        [recipient.zip, recipient.city].filter(Boolean).join(' '),
        recipient.countryCode && recipient.countryCode !== 'DE' ? recipient.countryCode : '',
    ].filter((l) => l && l.trim());

    const info: PdfInfoRow[] = [];
    if (invoice.number) info.push({ label: 'Rechnungsnummer', value: invoice.number });
    info.push({ label: 'Rechnungsdatum', value: deDate(invoice.issueDate) });
    if (invoice.performanceStart && invoice.performanceEnd && invoice.performanceStart !== invoice.performanceEnd) {
        info.push({ label: 'Leistungszeitraum', value: `${deDate(invoice.performanceStart)} – ${deDate(invoice.performanceEnd)}` });
    } else if (invoice.performanceStart || invoice.performanceEnd) {
        info.push({ label: 'Leistungsdatum', value: deDate(invoice.performanceStart ?? invoice.performanceEnd) });
    }
    if (invoice.dueDate) info.push({ label: 'Fällig bis', value: deDate(invoice.dueDate) });
    if (recipient.vatNumber) info.push({ label: 'USt-IdNr. Empfänger', value: recipient.vatNumber });

    const items: PdfItemRow[] = invoice.items.map((it, i) => ({
        position: i + 1,
        title: it.title,
        description: it.description ?? null,
        quantity: qty(it.quantity),
        unit: it.unit ?? null,
        unitPrice: eur(it.unitPriceNet),
        vatRate: pct(it.vatRate),
        net: eur(it.net),
    }));

    const vatRows: PdfVatRow[] = totals.byRate.map((r) => ({
        label: `zzgl. USt ${pct(r.rate)}`,
        net: eur(r.net),
        vat: eur(r.vat),
    }));

    // Closing note: the invoice's own footer, plus the §19 / §20 hints when applicable.
    const noteParts: string[] = [];
    if (invoice.footer?.trim()) noteParts.push(invoice.footer.trim());
    if (issuer.kleinunternehmer && !noteParts.some((p) => p.includes('§ 19')))
        noteParts.push('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');

    // Footer columns: issuer contact / bank / tax identity.
    const contactLines = [
        issuer.name,
        issuer.address ?? '',
        [issuer.zip, issuer.city].filter(Boolean).join(' '),
        issuer.phone ? `Tel. ${issuer.phone}` : '',
        issuer.email ?? '',
        issuer.website ?? '',
    ].filter((l) => l && l.trim());
    const bankLines = issuer.bank
        ? [
              issuer.bank.bankName ?? '',
              issuer.bank.iban ? `IBAN ${issuer.bank.iban}` : '',
              issuer.bank.bic ? `BIC ${issuer.bank.bic}` : '',
              issuer.bank.accountHolder ?? '',
          ].filter((l) => l && l.trim())
        : [];
    const taxLines = [
        issuer.taxNumber ? `Steuernummer ${issuer.taxNumber}` : '',
        issuer.vatId ? `USt-IdNr. ${issuer.vatId}` : '',
    ].filter((l) => l && l.trim());
    const footerColumns: PdfFooterColumn[] = [
        { heading: 'Kontakt', lines: contactLines },
        ...(bankLines.length ? [{ heading: 'Bankverbindung', lines: bankLines }] : []),
        ...(taxLines.length ? [{ heading: 'Steuer', lines: taxLines }] : []),
    ];

    return {
        title,
        address: { senderLine: senderParts.join(', '), recipientLines },
        info,
        intro: invoice.header?.trim() || null,
        items,
        itemColumns: { pos: 'Pos.', title: 'Bezeichnung', quantity: 'Menge', unitPrice: 'Einzelpreis', vat: 'USt', net: 'Netto' },
        vatRows,
        totalNet: eur(totals.net),
        totalGross: eur(totals.gross),
        grossLabel: isStorno ? 'Gutschriftbetrag' : 'Rechnungsbetrag',
        note: noteParts.length ? noteParts.join('\n') : null,
        footerColumns,
        qrPayload: opts.epcPayload ?? null,
        logoPath: opts.logoPath ?? null,
        currency: invoice.currency || 'EUR',
    };
}
