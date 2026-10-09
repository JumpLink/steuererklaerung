/**
 * Anlage-EÜR report: orchestrates document loading + the pure aggregate, prints
 * a human-readable summary, and produces a Kennzahlen sheet (EÜR line → amount)
 * for direct transcription into Mein ELSTER.
 */

import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import { loadManifest, defaultAccountScope } from '../../config/index.ts';
import { round2, fmtDe as fmt } from '../../lib/money.ts';
import { fetchInvoiceDocsInPeriod } from '@steuererklaerung/dms';
import { searchTransactions, searchAccountKeys, transactionsSummary } from '../transactions.ts';
import { aggregateEuer, type EuerAggregate, type EuerCategoryTotal } from '../../elster/euer-aggregate.ts';
import { enrichWithPaypal } from '../../lib/transactions/paypal-enrich.ts';
import { computeAfa, type Anlagegut } from '../../elster/afa.ts';
import { computeAufgabegewinn, type AufgabegewinnResult } from '../../elster/betriebsaufgabe.ts';
import {
    aggregateEuerByTransactions,
    apportionDocAcrossTransactions,
    type EuerAdjustments,
    type EuerTxAggregate,
    type EuerTxDetailRow,
    type TxClassifyRules,
    type TxDocInfo,
} from '../../elster/euer-transactions.ts';
import { loadManualOverrides } from '../classifications.ts';
import { loadEuerErstattungen } from '../erstattungen.ts';
import { loadAufteilungen } from '../aufteilungen.ts';
import { getCustomFieldValue, parseMonetaryValue } from '@steuererklaerung/paperless';
import {
    getSelectFieldLabel,
    selectOptionIdToLabel,
    parseTaxRateValue,
    ACCOUNTING_CATEGORY_OPTIONS,
    SALE_TYPE_OPTIONS,
} from '../../lib/select-field-constants.ts';

/** Map the config Anlagegut (snake_case) to the AfA engine's camelCase shape. */
function toAnlagegut(a: NonNullable<ElsterConfig['adjustments']>['anlageverzeichnis'][number]): Anlagegut {
    return {
        id: a.id,
        bezeichnung: a.bezeichnung,
        anschaffung: a.anschaffung,
        ahk: a.ahk,
        nutzungsdauerJahre: a.nutzungsdauer_jahre,
        restbuchwertAnfang: a.restbuchwert_anfang,
        erinnerungswert: a.erinnerungswert,
        art: a.art,
    };
}

/**
 * Derive the EÜR's non-cash year-end adjustments (AfA + Privatanteile) from the ELSTER
 * config for the year. AfA is computed from the Anlageverzeichnis (pro-rata to a
 * Betriebsaufgabe) unless `afa_override` is set; Privatanteile become deemed income +
 * their output VAT. Sonderbetriebsausgaben are NOT here — they belong to the Feststellung.
 */
export function buildEuerAdjustments(elster: ElsterConfig, year: number): EuerAdjustments {
    const a = elster.adjustments;
    if (!a) return {};
    const afa =
        a.afa_override != null
            ? round2(a.afa_override)
            : computeAfa(a.anlageverzeichnis.map(toAnlagegut), year, elster.business_end_date).totalAfa;
    // Privatanteile (deemed private use of business goods/services) only accrue while the business
    // is active. Skip years entirely outside the [start, end] window so a dissolved GbR shows no
    // Privatanteil after its Betriebsaufgabe (e.g. the phone Privatanteil must not reappear in 2026
    // once nachträgliche §24 posten pull that year into a report). The end year keeps the full
    // configured amount — the user sets the year's value; no mid-year proration here.
    const startYear = elster.business_start_date ? Number(elster.business_start_date.slice(0, 4)) : null;
    const endYear = elster.business_end_date ? Number(elster.business_end_date.slice(0, 4)) : null;
    const withinBusiness = (startYear == null || year >= startYear) && (endYear == null || year <= endYear);
    const privatanteile = withinBusiness
        ? a.privatanteile.map((p) => ({
              bezeichnung: p.bezeichnung,
              net: round2(p.netto),
              vat: round2(p.netto * p.ust_satz),
          }))
        : [];
    // Nachträgliche §24 Posten only count in the year the money flowed (by datum).
    const nachtraeglich = a.nachtraegliche_posten
        .filter((p) => p.datum.slice(0, 4) === String(year))
        .map((p) => ({
            bezeichnung: p.bezeichnung,
            net: round2(p.netto),
            vat: round2(p.netto * p.ust_satz),
            art: p.art,
        }));
    return { afa, afaCount: a.anlageverzeichnis.length || (afa > 0 ? 1 : 0), privatanteile, nachtraeglich };
}

/**
 * Map the config's `elster.klassifizierung` (snake_case, user-facing) to the pure rule chain's
 * shape. Same split as {@link buildEuerAdjustments}: the config module owns the wire format, the
 * `elster/` core owns the computation shape and never imports config.
 */
export function buildTxClassifyRules(elster: ElsterConfig | undefined): TxClassifyRules | undefined {
    const k = elster?.klassifizierung;
    if (!k) return undefined;
    return {
        eigeneKonten: k.eigene_konten,
        privatGegenseiten: k.privat_gegenseiten,
        gesellschafterGegenseiten: k.gesellschafter_gegenseiten,
        kskKennungen: k.ksk_kennungen,
        erloesGegenseiten: k.erloes_gegenseiten,
        aufwandRegeln: k.aufwand_regeln,
    };
}

/** Per-Gesellschafter Sonderbetriebsausgaben (id → Σ betrag) from the config adjustments. */
export function sonderbetriebsausgabenMap(elster: ElsterConfig): Record<string, number> {
    const map: Record<string, number> = {};
    for (const s of elster.adjustments?.sonderbetriebsausgaben ?? []) {
        map[s.gesellschafter_id] = round2((map[s.gesellschafter_id] ?? 0) + s.betrag);
    }
    return map;
}

/** Σ of all partners' Sonderbetriebsausgaben (reduces the Feststellung + the Gewerbeertrag). */
export function totalSonderbetriebsausgaben(elster: ElsterConfig): number {
    return round2((elster.adjustments?.sonderbetriebsausgaben ?? []).reduce((s, x) => s + x.betrag, 0));
}

/**
 * The Betriebsaufgabe Aufgabegewinn/-verlust from the config: the Anlageverzeichnis is
 * depreciated to the Aufgabe date (same AfA computation as the EÜR), then each asset's
 * Restbuchwert is compared to its configured gemeiner Wert. Returns null if no
 * Betriebsaufgabe is configured.
 */
export function buildAufgabegewinn(elster: ElsterConfig, year: number): AufgabegewinnResult | null {
    const ba = elster.adjustments?.betriebsaufgabe;
    if (!ba) return null;
    const afa = computeAfa(
        (elster.adjustments?.anlageverzeichnis ?? []).map(toAnlagegut),
        year,
        elster.business_end_date,
    );
    const gemeineWerte: Record<string, number> = {};
    for (const g of ba.gemeine_werte) gemeineWerte[g.anlagegut_id] = g.gemeiner_wert;
    return computeAufgabegewinn(
        afa.assets.map((a) => ({ id: a.id, bezeichnung: a.bezeichnung, restbuchwertEnde: a.restbuchwertEnde })),
        gemeineWerte,
        ba.aufgabekosten,
        ba.datum ?? elster.business_end_date ?? '',
    );
}

/**
 * Transaction-driven EÜR: sum the entity's accounts' transactions (default: the
 * account scope its manifest entry claims), categorising each from its linked
 * invoice document or by rule. The EUR amount comes from the transaction (so
 * foreign-currency invoices are handled), net/VAT from the document. When an ELSTER
 * config is passed, its non-cash year-end adjustments (AfA, Privatanteile) are folded in.
 */
export async function euerReportByTransactions(
    config: SyncConfig,
    year: number,
    options: { accountKeys?: string[]; detail?: boolean; elster?: ElsterConfig } = {},
): Promise<EuerTxAggregate> {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const cf = config.custom_field_ids;

    const scopeKeys = options.accountKeys?.length
        ? options.accountKeys
        : defaultAccountScope(
              loadManifest(),
              transactionsSummary().accounts.map((a) => a.accountKey),
              options.elster,
          );
    const rawTxs = scopeKeys.length ? searchAccountKeys(scopeKeys, { from, to }) : [];
    // Resolve PayPal-routed charges to their real merchant (e.g. "…/PP.1555.PP" →
    // DeepSeek / YouTube Music) so the rules can classify by merchant, not the
    // opaque bank purpose. Report-time overlay only — the store is untouched.
    const txs = enrichWithPaypal(rawTxs, searchTransactions({ source: 'paypal' }).transactions);

    const docs = await fetchInvoiceDocsInPeriod(config, { from, to });
    const docByTxId = new Map<string, TxDocInfo>();
    for (const doc of docs) {
        const raw = getCustomFieldValue(doc, cf.qonto_transaction_id);
        if (raw == null || String(raw).trim() === '') continue;
        const category = getSelectFieldLabel(
            ACCOUNTING_CATEGORY_OPTIONS,
            config.select_field_options?.accounting_category,
            getCustomFieldValue(doc, cf.accounting_category),
        );
        if (!category) continue; // doc reconciled but not categorised → handled as no-doc
        const net = parseMonetaryValue(getCustomFieldValue(doc, cf.total_net));
        const vat = parseMonetaryValue(getCustomFieldValue(doc, cf.tax_amount));
        const rate = parseTaxRateValue(config.select_field_options?.tax_rate, getCustomFieldValue(doc, cf.tax_rate));
        // §13b signals from the invoice: reverse_charge flag, supplier country (option-id → ISO
        // code, or a raw 2–3 letter code), and sale type. Drive reverse-charge classification.
        const countryRaw = cf.supplier_country > 0 ? getCustomFieldValue(doc, cf.supplier_country) : null;
        const countryStr = countryRaw != null ? String(countryRaw).trim() : '';
        const supplierCountry =
            (selectOptionIdToLabel(config.select_field_options?.supplier_country, countryStr) ??
                (/^[A-Za-z]{2,3}$/.test(countryStr) ? countryStr : '')) ||
            undefined;
        const saleType =
            (getSelectFieldLabel(
                SALE_TYPE_OPTIONS,
                config.select_field_options?.sale_type,
                getCustomFieldValue(doc, cf.sale_type),
            ) as 'GOODS' | 'SERVICES' | null) ?? undefined;
        const info: TxDocInfo = {
            documentId: doc.id,
            category,
            netEur: net?.amount,
            vatEur: vat?.amount,
            taxRate: rate != null ? (rate > 1 ? rate / 100 : rate) : undefined,
            currency: net?.currency ?? (getCustomFieldValue(doc, cf.invoice_currency) as string) ?? 'EUR',
            reverseCharge: getCustomFieldValue(doc, cf.reverse_charge) === true,
            supplierCountry: supplierCountry ? supplierCountry.toUpperCase() : undefined,
            supplierVatId:
                cf.supplier_vat_id > 0
                    ? String(getCustomFieldValue(doc, cf.supplier_vat_id) ?? '').trim() || undefined
                    : undefined,
            saleType,
        };
        const txIds = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        for (const [id, share] of apportionDocAcrossTransactions(info, txIds, txs)) {
            docByTxId.set(id, share);
        }
    }

    const adjustments = options.elster ? buildEuerAdjustments(options.elster, year) : undefined;
    // Persisted MANUAL owner overrides (S2): loaded ONCE per build (not per-tx), scoped to the
    // year's tx ids. Empty on a fresh store / when nothing was reclassified → the aggregate is
    // byte-identical to the pre-override behaviour. A matching tx is booked under its override's
    // category with source='manual', winning over the linked document AND the rule chain.
    const overrides = loadManualOverrides(txs.map((t) => t.id));
    // Linked refunds (Idee 9): the original may be booked in an earlier year, so the label lookup
    // reads the whole scope — lazily, only when a link exists.
    let allById: Map<string, (typeof rawTxs)[number]> | undefined;
    const erstattungen = loadEuerErstattungen(
        txs.map((t) => t.id),
        (id) => (allById ??= new Map(searchAccountKeys(scopeKeys, {}).map((t) => [t.id, t]))).get(id),
    );
    // Scope the laufende EÜR to the business-active window (Betriebsaufgabe → mid-year end;
    // default = the full year). Post-Aufgabe / pre-start bookings land in coverage.outsidePeriod.
    return aggregateEuerByTransactions(txs, docByTxId, year, {
        detail: options.detail,
        adjustments,
        activeFrom: options.elster?.business_start_date,
        activeTo: options.elster?.business_end_date,
        nachtraeglichGbrAusgaben: options.elster?.adjustments?.nachtraeglich_gbr_ausgaben_gegenseiten,
        klassifizierung: buildTxClassifyRules(options.elster),
        doppelzahlungIds: doppelzahlungIds(options.elster),
        overrides,
        erstattungen,
        aufteilungen: loadAufteilungen(txs.map((t) => t.id)),
    });
}

/**
 * Tx ids neutralised as durchlaufend: each confirmed double payment (the credit) AND its linked refund
 * (the debit that paid the customer back) — otherwise the refund would count as an expense.
 */
export function doppelzahlungIds(elster: ElsterConfig | undefined): Set<string> {
    const ids = new Set<string>();
    for (const d of elster?.adjustments?.doppelzahlungen ?? []) {
        ids.add(d.transaktion_id);
        if (d.rueckzahlung_transaktion_id) ids.add(d.rueckzahlung_transaktion_id);
    }
    return ids;
}

export interface EuerReportOptions {
    /** Restrict the store cross-check to one accountKey. */
    accountKey?: string;
}

/** Fetch documents + store transactions for the year and run the aggregate. */
export async function euerReport(
    config: SyncConfig,
    year: number,
    options: EuerReportOptions = {},
): Promise<EuerAggregate> {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const docs = await fetchInvoiceDocsInPeriod(config, { from, to });
    const storeTxs = searchTransactions({ accountKey: options.accountKey, from, to }).transactions;
    return aggregateEuer(docs, config, year, storeTxs);
}

export interface EuerKennzahl {
    kz: string;
    label: string;
    kind: 'income' | 'expense';
    amount: number;
}

/**
 * Collapse the per-category totals into the Anlage-EÜR Kennzahlen (one line per
 * Kennzahl). Net amounts for the P&L lines, plus the two VAT Kennzahlen.
 *
 * The kz values come from {@link SKR03_TO_EUER} and are BEST-EFFORT — verify
 * against the official Anlage-EÜR record description before filing.
 */
export function buildEuerKennzahlen(agg: {
    income: EuerCategoryTotal[];
    expenses: EuerCategoryTotal[];
    totals: { outputVat: number; inputVat: number };
}): EuerKennzahl[] {
    const byKz = new Map<string, EuerKennzahl>();
    const add = (rows: EuerCategoryTotal[]) => {
        for (const c of rows) {
            if (!c.kz) continue;
            const existing = byKz.get(c.kz);
            if (existing) existing.amount = Math.round((existing.amount + c.net) * 100) / 100;
            else byKz.set(c.kz, { kz: c.kz, label: c.bucket, kind: c.kind as 'income' | 'expense', amount: c.net });
        }
    };
    add(agg.income);
    add(agg.expenses);

    const rows = [...byKz.values()].sort((a, b) => a.kz.localeCompare(b.kz));
    // VAT Kennzahlen (Anlage EÜR Zeilen 16/55 — vereinnahmte USt / gezahlte Vorsteuer).
    if (agg.totals.outputVat > 0)
        rows.push({ kz: '140', label: 'Vereinnahmte Umsatzsteuer', kind: 'income', amount: agg.totals.outputVat });
    if (agg.totals.inputVat > 0)
        rows.push({ kz: '185', label: 'Gezahlte Vorsteuerbeträge', kind: 'expense', amount: agg.totals.inputVat });
    return rows;
}

/** Print a human-readable EÜR summary + the Kennzahlen sheet. */
export function printEuerReport(agg: EuerAggregate): void {
    console.log(`\nAnlage EÜR ${agg.year} — Einnahmen-Überschuss-Rechnung (Basis: Zufluss/Abfluss)`);
    console.log('='.repeat(72));

    console.log('\nBetriebseinnahmen (netto):');
    for (const c of agg.income) {
        console.log(
            `  ${c.category.padEnd(34)} ${fmt(c.net).padStart(12)} €   (USt ${fmt(c.vat)} €, ${c.count} Belege)`,
        );
    }
    console.log(`  ${'Summe Einnahmen netto'.padEnd(34)} ${fmt(agg.totals.incomeNet).padStart(12)} €`);

    console.log('\nBetriebsausgaben (netto):');
    for (const c of agg.expenses) {
        console.log(
            `  ${c.category.padEnd(34)} ${fmt(c.net).padStart(12)} €   (Vorsteuer ${fmt(c.vat)} €, ${c.count} Belege)`,
        );
    }
    console.log(`  ${'Summe Ausgaben netto'.padEnd(34)} ${fmt(agg.totals.expenseNet).padStart(12)} €`);

    console.log('\nErgebnis:');
    console.log(`  ${'Gewinn (Einnahmen − Ausgaben)'.padEnd(34)} ${fmt(agg.totals.profit).padStart(12)} €`);
    console.log(`  ${'USt-Zahllast (USt − Vorsteuer)'.padEnd(34)} ${fmt(agg.totals.vatPayable).padStart(12)} €`);

    if (agg.neutral.length > 0) {
        console.log('\nNeutral (nicht GuV-wirksam):');
        for (const c of agg.neutral)
            console.log(`  ${c.category.padEnd(34)} ${fmt(c.gross).padStart(12)} €   (${c.count})`);
    }

    console.log('\nAnlage-EÜR Kennzahlen (zum Eintragen in Mein ELSTER — Kz BITTE prüfen):');
    for (const k of buildEuerKennzahlen(agg)) {
        console.log(`  Kz ${k.kz.padEnd(5)} ${k.label.padEnd(46)} ${fmt(k.amount).padStart(12)} €`);
    }

    const c = agg.coverage;
    console.log('\nAbdeckung / Lücken:');
    console.log(`  Belege im Zeitraum: ${c.docsInPeriod} · gezählt (bezahlt ${agg.year}): ${c.counted}`);
    if (c.withoutPaymentDate.length)
        console.log(`  ⚠ ohne Zahldatum (nicht gezählt — erst reconcilen): #${c.withoutPaymentDate.join(', #')}`);
    if (c.uncategorized.length) console.log(`  ⚠ ohne Kategorie/Betrag: #${c.uncategorized.join(', #')}`);
    if (c.nonEurCurrency.length) console.log(`  ⚠ Fremdwährung (manuell prüfen): #${c.nonEurCurrency.join(', #')}`);
    if (c.directionMismatch.length)
        console.log(`  ⚠ Richtung ↔ Kategorie widersprüchlich: #${c.directionMismatch.join(', #')}`);

    if (agg.crossCheck) {
        console.log('\nGegenkontrolle Kontobewegungen (brutto, informativ):');
        console.log(
            `  Store Einnahmen: ${fmt(agg.crossCheck.storeIncomeGross)} €  (Δ Belege: ${fmt(agg.crossCheck.incomeGrossDelta)} €)`,
        );
        console.log(
            `  Store Ausgaben:  ${fmt(agg.crossCheck.storeExpenseGross)} €  (Δ Belege: ${fmt(agg.crossCheck.expenseGrossDelta)} €)`,
        );
        console.log('  (Δ ≠ 0 ist normal: Privatentnahmen, interne Übertragungen, belegt-aber-unkategorisiert.)');
    }
    console.log('');
}

/** Print a human-readable transaction-driven EÜR summary + Kennzahlen + coverage. */
export function printEuerTxReport(agg: EuerTxAggregate): void {
    console.log(`\nAnlage EÜR ${agg.year} — transaktions-getrieben (jede Buchung kategorisiert)`);
    console.log('='.repeat(72));

    console.log('\nBetriebseinnahmen (netto):');
    for (const c of agg.income)
        console.log(`  ${c.category.padEnd(34)} ${fmt(c.net).padStart(12)} €   (USt ${fmt(c.vat)} €, ${c.count})`);
    console.log(`  ${'Summe Einnahmen netto'.padEnd(34)} ${fmt(agg.totals.incomeNet).padStart(12)} €`);

    console.log('\nBetriebsausgaben (netto):');
    for (const c of agg.expenses)
        console.log(
            `  ${c.category.padEnd(34)} ${fmt(c.net).padStart(12)} €   (Vorsteuer ${fmt(c.vat)} €, ${c.count})`,
        );
    console.log(`  ${'Summe Ausgaben netto'.padEnd(34)} ${fmt(agg.totals.expenseNet).padStart(12)} €`);

    console.log('\nErgebnis:');
    console.log(`  ${'Gewinn (Einnahmen − Ausgaben)'.padEnd(34)} ${fmt(agg.totals.profit).padStart(12)} €`);
    console.log(`  ${'USt-Zahllast (USt − Vorsteuer)'.padEnd(34)} ${fmt(agg.totals.vatPayable).padStart(12)} €`);
    if (!agg.adjustmentsApplied) {
        console.log(
            '  ⚠ vorläufig: ohne Jahresabschluss-Anpassungen (AfA/§24/Privatanteil) — für die endgültige EÜR mit ELSTER-Config (--config) ausführen.',
        );
    }

    if (agg.neutral.length > 0) {
        console.log('\nNeutral (nicht GuV-wirksam — intern/privat/Steuer):');
        for (const c of agg.neutral)
            console.log(`  ${c.category.padEnd(34)} ${fmt(c.gross).padStart(12)} €   (${c.count})`);
    }

    console.log('\nAnlage-EÜR Kennzahlen (zum Eintragen in Mein ELSTER — Kz BITTE prüfen):');
    for (const k of buildEuerKennzahlen(agg)) {
        console.log(`  Kz ${k.kz.padEnd(5)} ${k.label.padEnd(46)} ${fmt(k.amount).padStart(12)} €`);
    }

    const c = agg.coverage;
    console.log('\nVollständigkeit (jede Buchung erklärt?):');
    console.log(
        `  Buchungen im aktiven Zeitraum (${c.activeFrom}–${c.activeTo}): ${c.transactions} · via Beleg: ${c.classifiedByDocument} · via Regel: ${c.classifiedByRule}${c.classifiedByManual ? ` · manuell: ${c.classifiedByManual}` : ''} · UNKLAR: ${c.unclassified.length}`,
    );
    if (c.outsidePeriod.length > 0) {
        const kept = c.outsidePeriod.filter((o) => o.included);
        const excluded = c.outsidePeriod.filter((o) => !o.included && o.kind !== 'neutral');
        const neutralCount = c.outsidePeriod.length - kept.length - excluded.length;
        const inc = round2(kept.filter((o) => o.kind === 'income').reduce((s, o) => s + o.net, 0));
        const exp = round2(kept.filter((o) => o.kind === 'expense').reduce((s, o) => s + o.net, 0));
        console.log(`\n  Nach der Aufgabe (${c.activeTo}) — nicht im laufenden Teil:`);
        console.log(
            `    ${kept.length} GbR-§24-Buchung(en) (im Ergebnis enthalten, gewerbesteuerfrei): Einnahmen ${fmt(inc)} € − Ausgaben ${fmt(exp)} € = ${fmt(round2(inc - exp))} €`,
        );
        const exclSum = round2(excluded.reduce((s, o) => s + o.net, 0));
        if (excluded.length > 0)
            console.log(
                `    ${excluded.length} Buchung(en) als Nachfolger/JumpLink AUSGESCHLOSSEN (${fmt(exclSum)} €).`,
            );
        if (neutralCount > 0) console.log(`    ${neutralCount} neutrale/private Buchung(en) ausgeschlossen.`);
    }
    if (c.unclassified.length > 0) {
        console.log('  ⚠ Unklassifizierte Buchungen (brauchen Beleg/Regel):');
        for (const u of c.unclassified.slice(0, 25)) {
            console.log(
                `     ${u.bookingDate} ${fmt(u.amount).padStart(10)} €  ${(u.counterparty ?? '').slice(0, 24).padEnd(24)} ${(u.purpose ?? '').slice(0, 36)}`,
            );
        }
        if (c.unclassified.length > 25) console.log(`     … +${c.unclassified.length - 25} weitere`);
    }
    console.log('');
}

/**
 * Print every transaction with its assigned category and the rule that matched,
 * grouped by category — the spot-check view before filing. READ-ONLY: nothing is
 * persisted; the user reviews and reports what to reclassify.
 */
export function printEuerTxDetail(agg: EuerTxAggregate): void {
    const rows = agg.detail ?? [];
    console.log(
        `\nAnlage EÜR ${agg.year} — Buchungs-Review (jede Buchung + Kategorie + Regel; nichts wird gespeichert)`,
    );
    console.log('='.repeat(92));

    const byCat = new Map<string, EuerTxDetailRow[]>();
    for (const r of rows) {
        const list = byCat.get(r.category);
        if (list) list.push(r);
        else byCat.set(r.category, [r]);
    }
    const kindOrder = { income: 0, expense: 1, neutral: 2 } as const;
    const ordered = [...byCat.entries()].sort(
        ([, a], [, b]) => kindOrder[a[0].kind] - kindOrder[b[0].kind] || a[0].category.localeCompare(b[0].category),
    );

    for (const [cat, inCat] of ordered) {
        inCat.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
        const net = inCat.reduce((s, r) => s + r.net, 0);
        const kindLabel = inCat[0].kind === 'income' ? 'Einnahme' : inCat[0].kind === 'expense' ? 'Ausgabe' : 'neutral';
        console.log(`\n▸ ${cat}  [${kindLabel}] — ${inCat.length} Buchungen · netto ${fmt(net)} €`);
        for (const r of inCat) {
            const cp = (r.counterparty ?? '').slice(0, 26).padEnd(26);
            const why =
                r.source === 'document'
                    ? 'Beleg'
                    : r.source === 'manual'
                      ? `manuell${r.decidedBy ? ` (${r.decidedBy})` : ''}${r.note ? ` — ${r.note}` : ''}`
                      : `Regel: ${r.rule ?? '—'}`;
            console.log(`   ${r.bookingDate}  ${fmt(r.amount).padStart(11)} €  ${cp}  ${why}`);
        }
    }

    const c = agg.coverage;
    console.log(
        `\n${rows.length} Buchungen · via Beleg ${c.classifiedByDocument} · via Regel ${c.classifiedByRule} · UNKLAR ${c.unclassified.length}`,
    );
    console.log('→ Prüfen und melden, was umklassifiziert werden soll. Es wird nichts persistiert.\n');
}
