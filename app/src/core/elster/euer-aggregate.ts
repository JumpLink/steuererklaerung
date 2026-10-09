/**
 * Anlage-EÜR (Einnahmen-Überschuss-Rechnung) year aggregate.
 *
 * Groups Paperless invoice documents by their accounting_category (SKR03-style)
 * into EÜR buckets, on a **cash basis** (Zufluss-/Abflussprinzip, §11 EStG):
 * only documents whose *payment* date (qonto_settled_at, written by the store
 * reconciliation) falls in the tax year are counted. Documents that fall in the
 * period by invoice/created date but have no confirmed payment are reported as
 * coverage gaps rather than silently included.
 *
 * The pure {@link aggregateEuer} takes already-loaded documents so it is
 * unit-testable; {@link euerReport} is the thin I/O wrapper.
 *
 * NOTE: the ELSTER Kennzahlen (kz) attached to each bucket are best-effort and
 * must be verified against the official Anlage-EÜR record description before the
 * XML in euer-xml.ts is filed — ERiC validation is the backstop.
 */

import { type Document, getCustomFieldValue, parseMonetaryValue } from '@steuererklaerung/paperless';
import type { SyncConfig } from '../config/index.ts';
import { ACCOUNTING_CATEGORY_OPTIONS, getSelectFieldLabel } from '../lib/select-field-constants.ts';
import { round2 } from '../lib/money.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

export type EuerKind = 'income' | 'expense' | 'neutral';

export interface EuerBucket {
    /** EÜR line bucket label (human-readable grouping). */
    bucket: string;
    /** Best-effort Anlage-EÜR Kennzahl — VERIFY before filing. */
    kz: string;
    kind: EuerKind;
}

/**
 * SKR03 accounting_category → Anlage-EÜR bucket. The income/expense `kind`
 * drives the totals; the `bucket` groups the report; `kz` is the (to-verify)
 * ELSTER Kennzahl used by the XML generator.
 */
export const SKR03_TO_EUER: Record<string, EuerBucket> = {
    // Betriebseinnahmen
    '8400 Erlöse 19% USt': { bucket: 'Umsatzsteuerpflichtige Betriebseinnahmen', kz: '112', kind: 'income' },
    '8300 Erlöse 7% USt': { bucket: 'Umsatzsteuerpflichtige Betriebseinnahmen', kz: '112', kind: 'income' },
    '8336 Erlöse Reverse Charge': { bucket: 'Nicht steuerbare/§13b Umsätze', kz: '103', kind: 'income' },
    '8125 Steuerfreie Auslandsumsätze': {
        bucket: 'Umsatzsteuerfreie/nicht steuerbare Umsätze',
        kz: '103',
        kind: 'income',
    },
    '8500 Sonstige Erträge/Zinsen': { bucket: 'Sonstige Betriebseinnahmen', kz: '112', kind: 'income' },
    // Unentgeltliche Wertabgabe (Privatanteil, e.g. private telephone use) — a deemed
    // umsatzsteuerpflichtige Betriebseinnahme; injected as a year-end adjustment.
    '8924 Unentgeltliche Wertabgaben (Privatanteil)': {
        bucket: 'Umsatzsteuerpflichtige Betriebseinnahmen',
        kz: '112',
        kind: 'income',
    },
    // Nachträgliche Betriebseinnahme nach Betriebsaufgabe (§24 Nr. 2 EStG).
    '8410 Nachträgliche Betriebseinnahme (§24)': {
        bucket: 'Umsatzsteuerpflichtige Betriebseinnahmen',
        kz: '112',
        kind: 'income',
    },
    // Betriebsausgaben
    '4946 Fremdleistungen': { bucket: 'Bezogene Fremdleistungen', kz: '110', kind: 'expense' },
    '4950 Rechts-/Beratungskosten': { bucket: 'Rechts-/Steuerberatung, Buchführung', kz: '183', kind: 'expense' },
    '4100 Personalkosten (Löhne/Gehälter)': { bucket: 'Löhne, Gehälter, soziale Abgaben', kz: '120', kind: 'expense' },
    '4138 Soziale Abgaben': { bucket: 'Löhne, Gehälter, soziale Abgaben', kz: '120', kind: 'expense' },
    '4210 Miete/Raumkosten': { bucket: 'Raumkosten (Miete/Pacht Geschäftsräume)', kz: '171', kind: 'expense' },
    '4240 Gas/Strom/Wasser': { bucket: 'Raumkosten (Nebenkosten)', kz: '172', kind: 'expense' },
    '4360 Versicherungen': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4380 Beiträge/Künstlersozialkasse': {
        bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben',
        kz: '183',
        kind: 'expense',
    },
    '4500 Kfz-Kosten': { bucket: 'Kraftfahrzeugkosten', kz: '142', kind: 'expense' },
    '4600 Werbe-/Marketingkosten': { bucket: 'Werbekosten', kz: '183', kind: 'expense' },
    '4670 Reisekosten': { bucket: 'Reisekosten', kz: '176', kind: 'expense' },
    // Anlage EÜR Zeile 63: Kz 175 = abziehbar, Kz 165 = nicht abziehbar (tax-sources.md, „Bewirtung").
    '4654 Bewirtungskosten': { bucket: 'Bewirtungskosten (abziehbar)', kz: '175', kind: 'expense' },
    '4806 Hosting/Cloud': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4921 Telefon/Internet': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4930 Bürobedarf': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4940 Fortbildung/Fachliteratur': {
        bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben',
        kz: '183',
        kind: 'expense',
    },
    '4955 Domains': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4964 Software/Lizenzen': { bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kz: '183', kind: 'expense' },
    '4970 Nebenkosten Geldverkehr': {
        bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben',
        kz: '183',
        kind: 'expense',
    },
    '4650 Sonstige Betriebsausgaben': {
        bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben',
        kz: '183',
        kind: 'expense',
    },
    // Nachträgliche Betriebsausgabe nach Betriebsaufgabe (§24 Nr. 2 EStG).
    '4655 Nachträgliche Betriebsausgabe (§24)': {
        bucket: 'Übrige unbeschränkt abziehbare Betriebsausgaben',
        kz: '183',
        kind: 'expense',
    },
    '0420 Büroeinrichtung/GWG': { bucket: 'Geringwertige Wirtschaftsgüter (GWG)', kz: '132', kind: 'expense' },
    '4830 Abschreibungen (AfA)': { bucket: 'Absetzung für Abnutzung (AfA)', kz: '130', kind: 'expense' },
    // Nicht GuV-wirksam
    '1800 Privatentnahme': { bucket: 'Privatentnahme (nicht GuV-wirksam)', kz: '', kind: 'neutral' },
    '1810 Privateinlage': { bucket: 'Privateinlage (nicht GuV-wirksam)', kz: '', kind: 'neutral' },
    '1360 Interne Überweisung': { bucket: 'Interne Überweisung (neutral)', kz: '', kind: 'neutral' },
    '1789 Umsatzsteuer-Zahllast (Finanzamt)': {
        bucket: 'USt-Zahllast/Erstattung (durchlaufend)',
        kz: '',
        kind: 'neutral',
    },
    '2150 Gewerbesteuer': { bucket: 'Gewerbesteuer (nicht abziehbar)', kz: '', kind: 'neutral' },
    // The 30 % of a Bewirtung that may not reduce the profit (§4 Abs. 5 Satz 1 Nr. 2 EStG) — its
    // Vorsteuer still counts (§15 Abs. 1a Satz 2 UStG), see NEUTRAL_MIT_VORSTEUER and
    // docs/references/tax-sources.md, „Splitbuchung".
    '4654 Nicht abziehbare Bewirtungskosten': {
        bucket: 'Nicht abziehbare Bewirtungskosten (nicht GuV-wirksam)',
        kz: '165',
        kind: 'neutral',
    },
};

/**
 * Neutral categories whose VAT is still deductible Vorsteuer: the expense may not reduce the profit,
 * the tax on it may. The aggregate keeps their net/VAT and adds the VAT to the year's Vorsteuer.
 */
export const NEUTRAL_MIT_VORSTEUER: ReadonlySet<string> = new Set(['4654 Nicht abziehbare Bewirtungskosten']);

export interface EuerCategoryTotal {
    category: string;
    bucket: string;
    kz: string;
    kind: EuerKind;
    count: number;
    net: number;
    /** Vorsteuer (expense) or vereinnahmte USt (income). */
    vat: number;
    gross: number;
}

export interface EuerAggregate {
    year: number;
    basis: 'cash';
    income: EuerCategoryTotal[];
    expenses: EuerCategoryTotal[];
    neutral: EuerCategoryTotal[];
    totals: {
        incomeNet: number;
        outputVat: number;
        expenseNet: number;
        inputVat: number;
        profit: number;
        vatPayable: number;
    };
    coverage: {
        docsInPeriod: number;
        counted: number;
        withoutPaymentDate: number[];
        uncategorized: number[];
        nonEurCurrency: number[];
        directionMismatch: number[];
    };
    crossCheck?: {
        storeIncomeGross: number;
        storeExpenseGross: number;
        incomeGrossDelta: number;
        expenseGrossDelta: number;
    };
}

function settledInPeriod(doc: Document, cf: SyncConfig['custom_field_ids'], from: string, to: string): boolean {
    const settled = getCustomFieldValue(doc, cf.qonto_settled_at) as string | undefined;
    const d = settled?.slice(0, 10);
    return d != null && d >= from && d <= to;
}

function netAndVat(
    doc: Document,
    cf: SyncConfig['custom_field_ids'],
): { net: number; vat: number; gross: number; currency: string } | null {
    const netVal = parseMonetaryValue(getCustomFieldValue(doc, cf.total_net));
    const taxVal = parseMonetaryValue(getCustomFieldValue(doc, cf.tax_amount));
    const grossVal = parseMonetaryValue(getCustomFieldValue(doc, cf.total_gross));
    if (!netVal && !grossVal) return null;
    const vat = Math.abs(taxVal?.amount ?? 0);
    const net = netVal ? Math.abs(netVal.amount) : Math.abs((grossVal as { amount: number }).amount) - vat;
    const gross = grossVal ? Math.abs(grossVal.amount) : net + vat;
    const currency = (netVal ?? grossVal ?? taxVal)?.currency ?? 'EUR';
    return { net: round2(net), vat: round2(vat), gross: round2(gross), currency };
}

/**
 * Pure aggregation over already-loaded invoice documents for one tax year.
 * `storeTxs` (optional) is used only for an informational cash-flow cross-check.
 */
export function aggregateEuer(
    docs: Document[],
    config: SyncConfig,
    year: number,
    storeTxs?: UnifiedTransaction[],
): EuerAggregate {
    const cf = config.custom_field_ids;
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const incomingType = config.document_type_ids.incoming_invoice;

    const byCategory = new Map<string, EuerCategoryTotal>();
    const coverage: EuerAggregate['coverage'] = {
        docsInPeriod: docs.length,
        counted: 0,
        withoutPaymentDate: [],
        uncategorized: [],
        nonEurCurrency: [],
        directionMismatch: [],
    };

    for (const doc of docs) {
        if (!settledInPeriod(doc, cf, from, to)) {
            coverage.withoutPaymentDate.push(doc.id);
            continue;
        }
        const category = getSelectFieldLabel(
            ACCOUNTING_CATEGORY_OPTIONS,
            config.select_field_options?.accounting_category,
            getCustomFieldValue(doc, cf.accounting_category),
        );
        if (!category) {
            coverage.uncategorized.push(doc.id);
            continue;
        }
        const amounts = netAndVat(doc, cf);
        if (!amounts) {
            coverage.uncategorized.push(doc.id);
            continue;
        }
        if (amounts.currency.toUpperCase() !== 'EUR') coverage.nonEurCurrency.push(doc.id);

        const bucket = SKR03_TO_EUER[category] ?? {
            bucket: `Unzugeordnet: ${category}`,
            kz: '',
            kind: (doc.document_type === incomingType ? 'expense' : 'income') as EuerKind,
        };

        // Flag a doc whose document type contradicts its category kind.
        const isIncomingDoc = doc.document_type === incomingType;
        if ((bucket.kind === 'income' && isIncomingDoc) || (bucket.kind === 'expense' && !isIncomingDoc)) {
            coverage.directionMismatch.push(doc.id);
        }

        const acc = byCategory.get(category) ?? {
            category,
            bucket: bucket.bucket,
            kz: bucket.kz,
            kind: bucket.kind,
            count: 0,
            net: 0,
            vat: 0,
            gross: 0,
        };
        acc.count += 1;
        acc.net = round2(acc.net + amounts.net);
        acc.vat = round2(acc.vat + amounts.vat);
        acc.gross = round2(acc.gross + amounts.gross);
        byCategory.set(category, acc);
        coverage.counted += 1;
    }

    const all = [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category));
    const income = all.filter((c) => c.kind === 'income');
    const expenses = all.filter((c) => c.kind === 'expense');
    const neutral = all.filter((c) => c.kind === 'neutral');

    const incomeNet = round2(income.reduce((s, c) => s + c.net, 0));
    const outputVat = round2(income.reduce((s, c) => s + c.vat, 0));
    const expenseNet = round2(expenses.reduce((s, c) => s + c.net, 0));
    const inputVat = round2(expenses.reduce((s, c) => s + c.vat, 0));

    const aggregate: EuerAggregate = {
        year,
        basis: 'cash',
        income,
        expenses,
        neutral,
        totals: {
            incomeNet,
            outputVat,
            expenseNet,
            inputVat,
            profit: round2(incomeNet - expenseNet),
            vatPayable: round2(outputVat - inputVat),
        },
        coverage,
    };

    if (storeTxs && storeTxs.length > 0) {
        const inYear = storeTxs.filter((t) => t.bookingDate >= from && t.bookingDate <= to);
        const storeIncomeGross = round2(inYear.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
        const storeExpenseGross = round2(
            Math.abs(inYear.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)),
        );
        const incomeGross = round2(income.reduce((s, c) => s + c.gross, 0));
        const expenseGross = round2(expenses.reduce((s, c) => s + c.gross, 0));
        aggregate.crossCheck = {
            storeIncomeGross,
            storeExpenseGross,
            incomeGrossDelta: round2(storeIncomeGross - incomeGross),
            expenseGrossDelta: round2(storeExpenseGross - expenseGross),
        };
    }

    return aggregate;
}
