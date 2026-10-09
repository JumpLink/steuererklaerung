/**
 * Aggregate USt-VA data from Paperless: paid outgoing invoices (net by rate, VAT)
 * and incoming invoices (input VAT) for a given date range.
 * Uses sync-config document types and custom fields.
 */

import {
    listDocuments,
    type Document,
    getCustomFieldValue,
    normalizeAmountValue,
    parseMonetaryValue,
} from '@steuererklaerung/paperless';
import { isDateInRangeStrict, normalizeDateValue } from '@steuererklaerung/shared';
import { fetchAllPagesParallel } from '@steuererklaerung/paperless';
import {
    parseTaxRateValue,
    getSelectFieldLabel,
    selectOptionIdToLabel,
    SALE_TYPE_OPTIONS,
} from '../lib/select-field-constants.ts';
import {
    classifyReverseCharge,
    emptyReverseChargeTotals,
    addReverseChargeItem,
    type ReverseChargeTotals,
} from './reverse-charge.ts';
import { loadPaperlessConfig } from '../config/index.ts';
import { PaperlessSetupError, SETUP_HINT } from '../lib/errors.ts';
import type { ElsterConfig } from '../config/index.ts';
import { getPeriodDateRange } from '../config/index.ts';
import { round2 as cents } from '../lib/money.ts';
import { loadBmfRates, convertToEur, monthKey } from '../config/bmf-rates.ts';

/** Aggregated amounts for USt-VA (Ist-Besteuerung). All in EUR, 2 decimals. */
export interface UstvaAggregate {
    /** Steuerpflichtige Umsätze 19 % (Zeile 81) – net. */
    net_19: number;
    /** Steuerpflichtige Umsätze 7 % (Zeile 86) – net. */
    net_7: number;
    /** Output VAT (for reporting; Zahllast is derived in ELSTER from net + VAT). */
    vat_out: number;
    /** Vorsteuer (Zeile 66) – input VAT. */
    vat_in: number;
    /** Number of outgoing invoices included (paid in period). */
    outgoing_count: number;
    /** Number of incoming invoices included. */
    incoming_count: number;
    /**
     * §13b Steuerschuldnerschaft des Leistungsempfängers (reverse charge on foreign input invoices)
     * — Kz 46/47 (EU), Kz 84/85 (third country), Kz 67 (deductible Vorsteuer). Zahllastneutral for a
     * fully-deductible business, but declared. `null`/empty when there is no §13b in the period.
     */
    reverseCharge?: ReverseChargeTotals;
    /** Incoming invoices that look like §13b but couldn't be booked cleanly (for a human check). */
    reverseChargeReview?: Array<{ id: number; title: string | null; reason: string }>;
}

/** One document included in USt-VA with amounts used. */
export interface UstvaDocumentDetail {
    id: number;
    title: string | null;
    total_net: number | null;
    tax_amount: number | null;
    tax_rate: number | null;
    date_used: string | null;
    /** For Qonto vs invoice amount check. */
    total_gross?: number | null;
    qonto_transaction_id?: string | null;
    /** Qonto transaction amount (signed, from document custom field). */
    qonto_transaction_amount?: number | null;
    /** Qonto transaction currency (ISO 4217, from document custom field). */
    qonto_currency?: string | null;
    /** Invoice currency (ISO 4217). If not EUR, amounts are not included in USt-VA sums. */
    invoice_currency?: string | null;
}

/** Result of aggregation plus per-document details for reporting. */
export interface UstvaAggregateWithDetails {
    aggregate: UstvaAggregate;
    dateFrom: string;
    dateTo: string;
    outgoing: UstvaDocumentDetail[];
    incoming: UstvaDocumentDetail[];
    /** Foreign-currency docs excluded because no BMF Umrechnungskurs was on file for their month. */
    missingBmfRates: Array<{ id: number; currency: string; month: string }>;
    /** Corrections of the period (linked refunds, private parts of splits), already in `aggregate.vat_in`. */
    erstattungen?: VorsteuerKorrektur[];
}

interface TagFilter {
    excludeTagIds?: number[];
    includeTagIds?: number[];
}

/**
 * Fetch all documents of the given type and return those whose relevant date
 * (settled_at or invoice_date) falls in [dateFrom, dateTo].
 * Supports exclude_tags (skip docs with any of these) and include_tags (only keep docs with at least one of these).
 */
async function fetchDocumentsInRange(
    documentTypeId: number,
    dateFrom: string,
    dateTo: string,
    useSettledAt: boolean,
    settledAtFieldId: number,
    invoiceDateFieldId: number,
    tagFilter: TagFilter = {},
    preloaded?: readonly Document[],
): Promise<Document[]> {
    // The date lives in CUSTOM FIELDS (settled_at / invoice_date), which Paperless cannot filter
    // server-side — so the whole document type is pulled and narrowed here. That is one full
    // archive scan per call, and a year view calls this eight times (4 quarters x 2 types) for
    // eight identical scans. `preloaded` lets a caller that already has the list hand it over;
    // {@link aggregateUstvaYear} fetches once per type and shares it across the quarters.
    const allDocs = preloaded ?? (await loadInvoiceDocs(documentTypeId));
    const { excludeTagIds = [], includeTagIds = [] } = tagFilter;
    return allDocs.filter((doc) => {
        // Exclude documents with any of the excluded tags
        if (excludeTagIds.length > 0 && doc.tags?.some((t) => excludeTagIds.includes(t))) {
            return false;
        }
        // If include_tags set, only keep documents with at least one matching tag
        if (includeTagIds.length > 0 && !doc.tags?.some((t) => includeTagIds.includes(t))) {
            return false;
        }
        const settledAt = normalizeDateValue(getCustomFieldValue(doc, settledAtFieldId));
        const invoiceDate = normalizeDateValue(getCustomFieldValue(doc, invoiceDateFieldId));
        const dateToUse = useSettledAt ? settledAt : (settledAt ?? invoiceDate);
        return dateToUse != null && isDateInRangeStrict(dateToUse, dateFrom, dateTo);
    });
}

function toDocumentDetail(
    doc: Document,
    cf: {
        total_net: number;
        tax_amount: number;
        tax_rate: number;
        total_gross: number;
        qonto_settled_at: number;
        invoice_date: number;
        qonto_transaction_id: number;
        qonto_transaction_amount: number;
        qonto_currency: number;
        invoice_currency: number;
    },
    dateUsed: string | null,
    taxRateOptionMap?: Record<string, string>,
): UstvaDocumentDetail {
    // Parse monetary fields (may contain embedded currency, e.g. "USD57.60")
    const netParsed = parseMonetaryValue(getCustomFieldValue(doc, cf.total_net));
    const vatParsed = parseMonetaryValue(getCustomFieldValue(doc, cf.tax_amount));
    const grossParsed = parseMonetaryValue(getCustomFieldValue(doc, cf.total_gross));
    const rate = parseTaxRateValue(taxRateOptionMap, getCustomFieldValue(doc, cf.tax_rate));

    // Derive invoice currency from the monetary fields (prefer total_gross, fallback total_net, then tax_amount)
    const detectedCurrency = grossParsed?.currency ?? netParsed?.currency ?? vatParsed?.currency ?? null;
    // Legacy fallback: read from the separate invoice_currency field if no embedded currency found
    const invoiceCurrencyRaw = cf.invoice_currency > 0 ? getCustomFieldValue(doc, cf.invoice_currency) : undefined;
    const legacyCurrency =
        typeof invoiceCurrencyRaw === 'string' && invoiceCurrencyRaw.trim().length === 3
            ? invoiceCurrencyRaw.trim().toUpperCase()
            : null;
    const invoice_currency = detectedCurrency ?? legacyCurrency;

    const qontoTxIdRaw = getCustomFieldValue(doc, cf.qonto_transaction_id);
    const qonto_transaction_id = typeof qontoTxIdRaw === 'string' && qontoTxIdRaw.trim() ? qontoTxIdRaw.trim() : null;
    const qonto_transaction_amount =
        cf.qonto_transaction_amount > 0
            ? normalizeAmountValue(getCustomFieldValue(doc, cf.qonto_transaction_amount))
            : null;
    const qontoCurrencyRaw = cf.qonto_currency > 0 ? getCustomFieldValue(doc, cf.qonto_currency) : undefined;
    const qonto_currency =
        typeof qontoCurrencyRaw === 'string' && qontoCurrencyRaw.trim() ? qontoCurrencyRaw.trim().toUpperCase() : null;

    return {
        id: doc.id,
        title: doc.title ?? null,
        total_net: netParsed?.amount ?? null,
        tax_amount: vatParsed?.amount ?? null,
        tax_rate: rate ?? null,
        date_used: dateUsed,
        total_gross: grossParsed?.amount ?? null,
        qonto_transaction_id: qonto_transaction_id ?? undefined,
        qonto_transaction_amount: qonto_transaction_amount ?? undefined,
        qonto_currency: qonto_currency ?? undefined,
        invoice_currency: invoice_currency ?? undefined,
    };
}

/** Read the supplier country (ISO code) from a doc — option-ID → label, or a raw 2–3 letter code. */
function readSupplierCountry(
    doc: Document,
    fieldId: number,
    optionMap: Record<string, string> | undefined,
): string | null {
    if (fieldId <= 0) return null;
    const raw = getCustomFieldValue(doc, fieldId);
    if (raw == null) return null;
    const s = String(raw).trim();
    if (s === '') return null;
    const viaMap = selectOptionIdToLabel(optionMap, s);
    if (viaMap) return viaMap.toUpperCase();
    return /^[A-Za-z]{2,3}$/.test(s) ? s.toUpperCase() : null;
}

/**
 * A Vorsteuer correction the receipt-driven USt-VA cannot see on its own. Two kinds:
 * - `erstattung` (default): a refund linked to a receipt-backed debit (Idee 9) — § 17 Abs. 1 Satz 2
 *   und 8 UStG, corrected in the period the refund came in (by `date`). Loaded by
 *   `actions/erstattungen.ts` (`loadVorsteuerKorrekturen`); docs/references/tax-sources.md, „Erstattungen".
 * - `aufteilung`: the VAT in the private parts of a split booking (Idee 13) — not deductible
 *   (§ 15 Abs. 1 Satz 1 Nr. 1 UStG). Subtracted where the receipt linked to that booking counts, so it
 *   lands in the receipt's own period; without a receipt the USt-VA never claimed it.
 *   docs/references/tax-sources.md, „Splitbuchung".
 */
export interface VorsteuerKorrektur {
    art?: 'erstattung' | 'aufteilung';
    /** The refund's tx id, or the split booking's. */
    refundTxId: string;
    originalDocumentId?: number;
    /** Booking date of the refund — decides the period of an `erstattung`. */
    date: string;
    /** Positive: the Vorsteuer to take back. */
    vat: number;
}

/**
 * Same as aggregateUstvaFromPaperless but also returns per-document details for the report.
 * `korrekturen` (linked refunds, any dates) reduce the period's Vorsteuer when they fall into it.
 */
export async function aggregateUstvaFromPaperlessWithDetails(
    config: ElsterConfig,
    preloaded?: PreloadedDocs,
    korrekturen: readonly VorsteuerKorrektur[] = [],
): Promise<UstvaAggregateWithDetails> {
    const syncConfig = loadPaperlessConfig();
    const dt = syncConfig.document_type_ids;
    const cf = syncConfig.custom_field_ids;

    if (dt.outgoing_invoice <= 0 || dt.incoming_invoice <= 0) {
        throw new PaperlessSetupError(
            `sync-config document_type_ids for outgoing_invoice and incoming_invoice must be set. ${SETUP_HINT}`,
            ['document_type_ids.outgoing_invoice', 'document_type_ids.incoming_invoice'],
        );
    }
    if (cf.total_net <= 0 || cf.tax_amount <= 0 || cf.qonto_settled_at <= 0 || cf.invoice_date <= 0) {
        throw new PaperlessSetupError(
            `sync-config custom_field_ids for total_net, tax_amount, qonto_settled_at, invoice_date must be set. ${SETUP_HINT}`,
            ['total_net', 'tax_amount', 'qonto_settled_at', 'invoice_date'].map((f) => `custom_field_ids.${f}`),
        );
    }

    // The aggregator scopes documents by payment date (qonto_settled_at) → Ist-Versteuerung.
    // Soll-Versteuerung (invoice-date basis) would need a different date field and is not yet built.
    if (config.taxation_basis === 'soll') {
        throw new Error(
            'Soll-Versteuerung is not yet supported by the USt-VA pipeline (it aggregates by payment date / Ist). Set taxation_basis to "ist" or extend the aggregator to use the invoice date.',
        );
    }

    const { dateFrom: periodStart, dateTo } = getPeriodDateRange(config.period);
    const dateFrom =
        config.business_start_date && config.business_start_date > periodStart
            ? config.business_start_date
            : periodStart;
    const tagFilter: TagFilter = {
        excludeTagIds: config.exclude_tags ?? [],
        includeTagIds: config.include_tags ?? [],
    };

    const [outgoingRaw, incomingRaw] = await Promise.all([
        fetchDocumentsInRange(
            dt.outgoing_invoice,
            dateFrom,
            dateTo,
            true,
            cf.qonto_settled_at,
            cf.invoice_date,
            tagFilter,
            preloaded?.outgoing,
        ),
        fetchDocumentsInRange(
            dt.incoming_invoice,
            dateFrom,
            dateTo,
            false,
            cf.qonto_settled_at,
            cf.invoice_date,
            tagFilter,
            preloaded?.incoming,
        ),
    ]);

    // Deduplicate by document id (pagination/API can occasionally return same doc twice)
    const dedupeById = (docs: Document[]): Document[] => {
        const seen = new Set<number>();
        return docs.filter((d) => {
            if (seen.has(d.id)) return false;
            seen.add(d.id);
            return true;
        });
    };
    const outgoingDocs = dedupeById(outgoingRaw);
    const incomingDocs = dedupeById(incomingRaw);

    const bmfRates = loadBmfRates();
    const missingBmfRates: Array<{ id: number; currency: string; month: string }> = [];

    const outgoingDetails: UstvaDocumentDetail[] = [];
    let net_19 = 0;
    let net_7 = 0;
    let vat_out = 0;

    const isEur = (c: string | null | undefined): boolean => c == null || c === '' || c.toUpperCase() === 'EUR';

    for (const doc of outgoingDocs) {
        if (doc.document_type !== dt.outgoing_invoice) continue; // use actual type from API (avoid duplicates from wrong filter)
        const settledAt = normalizeDateValue(getCustomFieldValue(doc, cf.qonto_settled_at));
        const detail = toDocumentDetail(doc, cf, settledAt, syncConfig.select_field_options?.tax_rate);
        outgoingDetails.push(detail);
        const outCur = detail.invoice_currency;
        let net = detail.total_net;
        let vat = detail.tax_amount;
        const rate = detail.tax_rate;
        if (!isEur(outCur)) {
            const month = monthKey(settledAt ?? '');
            const netEur = net != null ? convertToEur(bmfRates, net, outCur ?? '', month) : null;
            const vatEur = vat != null ? convertToEur(bmfRates, vat, outCur ?? '', month) : null;
            if ((net != null && netEur == null) || (vat != null && vatEur == null)) {
                missingBmfRates.push({ id: doc.id, currency: (outCur ?? '').toUpperCase(), month });
                continue;
            }
            net = netEur;
            vat = vatEur;
        }
        if (net != null && net >= 0) {
            if (rate != null && Math.abs(rate - 7) < 0.01) {
                net_7 += cents(net);
            } else {
                net_19 += cents(net);
            }
        }
        if (vat != null && vat >= 0) vat_out += cents(vat);
    }

    const incomingDetails: UstvaDocumentDetail[] = [];
    let vat_in = 0;
    const reverseCharge = emptyReverseChargeTotals();
    const reverseChargeReview: Array<{ id: number; title: string | null; reason: string }> = [];
    const scOpts = syncConfig.select_field_options;
    /** Tx ids the counted incoming receipts are linked to — where a split's private Vorsteuer comes off. */
    const belegTxIds = new Set<string>();
    for (const doc of incomingDocs) {
        if (doc.document_type !== dt.incoming_invoice) continue;
        const settledAt = normalizeDateValue(getCustomFieldValue(doc, cf.qonto_settled_at));
        const invoiceDate = normalizeDateValue(getCustomFieldValue(doc, cf.invoice_date));
        const dateUsed = settledAt ?? invoiceDate;
        const detail = toDocumentDetail(doc, cf, dateUsed, scOpts?.tax_rate);
        incomingDetails.push(detail);
        const inCur = detail.invoice_currency;
        let vat = detail.tax_amount;
        if (!isEur(inCur)) {
            const month = monthKey(dateUsed ?? '');
            const vatEur = vat != null ? convertToEur(bmfRates, vat, inCur ?? '', month) : null;
            if (vat != null && vatEur == null) {
                missingBmfRates.push({ id: doc.id, currency: (inCur ?? '').toUpperCase(), month });
                continue;
            }
            vat = vatEur;
        }
        if (vat != null && vat >= 0) {
            vat_in += cents(vat);
            for (const id of (detail.qonto_transaction_id ?? '').split(',')) if (id.trim()) belegTxIds.add(id.trim());
        }

        // §13b: foreign reverse-charge input invoice? Classify (base in EUR) + accumulate; the owed
        // tax is also Vorsteuer (Kz 67) so the Zahllast nets, but it must be declared.
        const rcFlag = getCustomFieldValue(doc, cf.reverse_charge) === true;
        const country = readSupplierCountry(doc, cf.supplier_country, scOpts?.supplier_country);
        if (rcFlag || (country != null && country !== 'DE')) {
            let netEur = detail.total_net;
            if (netEur != null && !isEur(inCur)) {
                netEur = convertToEur(bmfRates, netEur, inCur ?? '', monthKey(dateUsed ?? ''));
            }
            const saleType = getSelectFieldLabel(
                SALE_TYPE_OPTIONS,
                scOpts?.sale_type,
                getCustomFieldValue(doc, cf.sale_type),
            ) as 'GOODS' | 'SERVICES' | null;
            const r = classifyReverseCharge({ reverseCharge: rcFlag, supplierCountry: country, saleType, net: netEur });
            if (r.item) addReverseChargeItem(reverseCharge, r.item);
            else if (r.review) reverseChargeReview.push({ id: doc.id, title: detail.title, reason: r.review });
        }
    }

    const erstattungen = korrekturen.filter((k) =>
        k.art === 'aufteilung' ? belegTxIds.has(k.refundTxId) : k.date >= dateFrom && k.date <= dateTo,
    );
    for (const k of erstattungen) vat_in -= cents(k.vat);

    const aggregate: UstvaAggregate = {
        net_19: cents(net_19),
        net_7: cents(net_7),
        vat_out: cents(vat_out),
        vat_in: cents(vat_in),
        outgoing_count: outgoingDetails.length,
        incoming_count: incomingDetails.length,
        reverseCharge,
        reverseChargeReview,
    };

    return {
        aggregate,
        dateFrom,
        dateTo,
        outgoing: outgoingDetails,
        incoming: incomingDetails,
        missingBmfRates,
        erstattungen,
    };
}

/** One quarter's USt-VA within a year-overview (aggregate + derived Zahllast + documents). */
export interface UstvaYearQuarter {
    quarter: number;
    aggregate: UstvaAggregate;
    /** Zahllast = Umsatzsteuer − Vorsteuer (negative = Erstattung). */
    zahllast: number;
    outgoing: UstvaDocumentDetail[];
    incoming: UstvaDocumentDetail[];
    missingBmfRates: Array<{ id: number; currency: string; month: string }>;
}

/**
 * Every document of one invoice type. `fetchAllPagesParallel` reads page 1 for the count and then
 * fans the rest out — for a full archive over a remote Paperless that is the dominant win, and it
 * is what the DMS reconcile preload already uses for the same two-type load.
 */
function loadInvoiceDocs(documentTypeId: number): Promise<Document[]> {
    return fetchAllPagesParallel((page, pageSize) =>
        listDocuments({ document_type_id: documentTypeId, page_size: pageSize, page, ordering: 'id' }),
    );
}

/** The full document list per invoice type, fetched once and shared across the quarters. */
export interface PreloadedDocs {
    outgoing: readonly Document[];
    incoming: readonly Document[];
}

/**
 * Aggregate all four quarters of a reporting year from one base ELSTER config (async; fetches
 * Paperless per quarter, concurrently). Shared by the native app (app/data/ustva.ts) and the web
 * (web/data.ts) so both front-ends show the identical USt-VA. `business_start_date` on the config
 * clamps quarters before the business existed to empty.
 */
export async function aggregateUstvaYear(
    base: ElsterConfig,
    year: number,
    korrekturen: readonly VorsteuerKorrektur[] = [],
): Promise<UstvaYearQuarter[]> {
    // ONE fetch per invoice type for the whole year instead of one per quarter. The per-quarter
    // narrowing happens on custom-field dates, which Paperless cannot filter server-side, so each
    // call used to pull the entire document type again — eight identical archive scans for a view
    // that needs two. Measured on the aggregate itself (3 runs each, ~1750 documents per type):
    // 41-44 s before, 10-11 s after, identical figures.
    const syncConfig = loadPaperlessConfig();
    const dt = syncConfig.document_type_ids;
    const [outgoing, incoming] = await Promise.all([
        loadInvoiceDocs(dt.outgoing_invoice),
        loadInvoiceDocs(dt.incoming_invoice),
    ]);
    const preloaded: PreloadedDocs = { outgoing, incoming };

    return Promise.all(
        ([1, 2, 3, 4] as const).map(async (quarter) => {
            const r = await aggregateUstvaFromPaperlessWithDetails(
                { ...base, period: { year, quarter } },
                preloaded,
                korrekturen,
            );
            return {
                quarter,
                aggregate: r.aggregate,
                zahllast: cents(r.aggregate.vat_out - r.aggregate.vat_in),
                outgoing: r.outgoing,
                incoming: r.incoming,
                missingBmfRates: r.missingBmfRates,
            };
        }),
    );
}
