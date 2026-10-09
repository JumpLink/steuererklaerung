/**
 * Umsatzaufstellung — a formal revenue listing for one (entity, year), used as a tax proof (e.g. the
 * Anlage to a Tourismusbeitrag-Erklärung: the maßgeblicher Umsatz i.S.d. §1 UStG of the Vorvorjahr).
 *
 * Single source of truth: the figures come from the SAME transaction-driven aggregation that feeds
 * the EÜR and USt-VA (`euerReportByTransactions`), so the listing can never disagree with the tax
 * returns. The per-rate split and the row list are both derived from that aggregate's income detail
 * rows, and cross-checked against the independent USt aggregate (`aggregateUsteFromEuerTx`).
 *
 * Data-completeness is surfaced, never hidden: if the store's transactions don't span the full
 * calendar year (e.g. the GbR's camt import starts mid-2023, the earlier Penta period is missing),
 * `coverage.warning` states the covered range and the missing period — the document goes to a tax
 * office, so an under-covered figure must be visible, not silently short.
 */

import type { SyncConfig } from '../config/index.ts';
import { resolveWorkspaceEntities, type ElsterConfig } from '../config/index.ts';
import { euerReportByTransactions } from './elster/euer.ts';
import { searchAccountKeys, transactionsSummary } from './transactions.ts';
import { aggregateUsteFromEuerTx, type UsteAggregate } from '../elster/uste-aggregate.ts';
import type { EuerTxAggregate } from '../elster/euer-transactions.ts';
import type { UmsatzPdfModel, UmsatzPdfRow } from '@steuererklaerung/invoice-pdf';
import { round2 } from '../lib/money.ts';

/** One revenue line. */
export interface UmsatzRow {
    date: string;
    /** Invoice/reference number if one could be identified, else null. */
    ref: string | null;
    party: string | null;
    net: number;
    vat: number;
    gross: number;
    /** Implied VAT rate as a fraction (0.19 / 0.07 / 0). */
    vatRate: number;
    category: string;
}

/** Data-coverage of the store for the year, with a human warning when the year isn't fully spanned. */
export interface UmsatzCoverage {
    firstDate: string | null;
    lastDate: string | null;
    /** True when the store's transactions plausibly span the whole calendar year. */
    fullYear: boolean;
    warning: string | null;
}

export interface UmsatzReport {
    entityId: string;
    entityName: string;
    taxNumber: string | null;
    year: number;
    basis: 'ist' | 'soll';
    rows: UmsatzRow[];
    /** Net revenue split by VAT rate (the Bemessungsgrundlage components). */
    netByRate: { rate19: number; rate7: number; rate0: number };
    totalNet: number;
    totalVat: number;
    totalGross: number;
    coverage: UmsatzCoverage;
    /** Set when the row-derived net differs from the independent USt aggregate by > 0.01 €. */
    reconciliationNote: string | null;
}

/** de-DE money (no symbol), e.g. 33558.02 → "33.558,02". */
function money(n: number): string {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** YYYY-MM-DD → DD.MM.YYYY (unchanged if it doesn't parse). */
function deDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Bucket an implied rate to the nearest standard German VAT rate (fraction). */
function bucketRate(net: number, vat: number): number {
    if (Math.abs(net) < 0.005) return 0;
    const r = vat / net;
    if (Math.abs(r - 0.19) < 0.02) return 0.19;
    if (Math.abs(r - 0.07) < 0.02) return 0.07;
    return 0;
}

/** Best-effort invoice/reference number from a transaction purpose (RE-…, RG…, Rechnung …). */
function extractRef(purpose: string | undefined): string | null {
    if (!purpose) return null;
    const clean = (s: string) => s.replace(/[.,;]$/, '').trim();
    // Prefer an explicit RE/RG/RN token; fall back to the number after "Rechnung".
    const tok = /\b((?:RE|RG|RN)[-\s]?\d[\w/-]*)/i.exec(purpose);
    if (tok) return clean(tok[1].replace(/\s+/g, ''));
    const rech = /\bRechnung(?:\s*Nr\.?)?\s*[:.]?\s*([\w/-]+)/i.exec(purpose);
    return rech ? clean(rech[1]) : null;
}

/**
 * Assemble the report from the two aggregates + the coverage — PURE (no I/O), so it is unit-tested
 * against a fixture. Rows are the income detail lines; the per-rate split and totals are derived
 * from those same rows and cross-checked against the USt aggregate.
 */
export function assembleUmsatzReport(
    agg: EuerTxAggregate,
    uste: UsteAggregate,
    coverage: UmsatzCoverage,
    meta: { entityId: string; entityName: string; taxNumber: string | null; year: number; basis: 'ist' | 'soll' },
): UmsatzReport {
    const income = (agg.detail ?? []).filter((d) => d.kind === 'income');
    const rows: UmsatzRow[] = income.map((d) => ({
        date: d.bookingDate,
        ref: extractRef(d.purpose),
        party: d.counterparty ?? null,
        net: round2(d.net),
        vat: round2(d.vat),
        gross: round2(d.gross),
        vatRate: bucketRate(d.net, d.vat),
        category: d.category,
    }));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const netByRate = { rate19: 0, rate7: 0, rate0: 0 };
    for (const r of rows) {
        if (r.vatRate === 0.19) netByRate.rate19 = round2(netByRate.rate19 + r.net);
        else if (r.vatRate === 0.07) netByRate.rate7 = round2(netByRate.rate7 + r.net);
        else netByRate.rate0 = round2(netByRate.rate0 + r.net);
    }
    const totalNet = round2(rows.reduce((s, r) => s + r.net, 0));
    const totalVat = round2(rows.reduce((s, r) => s + r.vat, 0));
    const totalGross = round2(rows.reduce((s, r) => s + r.gross, 0));

    // Cross-check against the independent USt aggregate (same source, different code path).
    const usteNet = round2(uste.net_19 + uste.net_7 + uste.net_0);
    const reconciliationNote =
        Math.abs(usteNet - totalNet) > 0.01
            ? `Hinweis: Zeilensumme (${money(totalNet)} €) weicht von der USt-Aggregation ` +
              `(${money(usteNet)} €) ab — bitte prüfen.`
            : null;

    return {
        entityId: meta.entityId,
        entityName: meta.entityName,
        taxNumber: meta.taxNumber,
        year: meta.year,
        basis: meta.basis,
        rows,
        netByRate,
        totalNet,
        totalVat,
        totalGross,
        coverage,
        reconciliationNote,
    };
}

/** CSV (semicolon-separated, de-DE numbers) — the machine-checkable counterpart to the PDF. */
export function umsatzToCsv(report: UmsatzReport): string {
    const esc = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines: string[] = [];
    lines.push(['Datum', 'Beleg', 'Gegenpartei', 'Netto', 'USt', 'Brutto', 'Satz'].join(';'));
    for (const r of report.rows) {
        lines.push(
            [
                deDate(r.date),
                esc(r.ref ?? ''),
                esc(r.party ?? ''),
                money(r.net),
                money(r.vat),
                money(r.gross),
                `${Math.round(r.vatRate * 100)}%`,
            ].join(';'),
        );
    }
    lines.push('');
    lines.push(['Summe netto 19 %', '', '', money(report.netByRate.rate19)].join(';'));
    lines.push(['Summe netto 7 %', '', '', money(report.netByRate.rate7)].join(';'));
    lines.push(['Summe netto 0 %', '', '', money(report.netByRate.rate0)].join(';'));
    lines.push(
        ['Summe netto gesamt', '', '', money(report.totalNet), money(report.totalVat), money(report.totalGross)].join(
            ';',
        ),
    );
    return `${lines.join('\n')}\n`;
}

/** Build the render-ready PDF model (pre-formatted strings) from the report. PURE. */
export function toUmsatzPdfModel(report: UmsatzReport): UmsatzPdfModel {
    const rows: UmsatzPdfRow[] = report.rows.map((r) => ({
        date: deDate(r.date),
        ref: r.ref ?? '',
        party: r.party ?? '',
        net: money(r.net),
        vat: money(r.vat),
        gross: money(r.gross),
    }));
    const meta: { label: string; value: string }[] = [
        { label: 'Entität', value: report.entityName },
        { label: 'Jahr', value: String(report.year) },
        {
            label: 'Erfasster Zeitraum',
            value: report.coverage.firstDate
                ? `${deDate(report.coverage.firstDate)} – ${deDate(report.coverage.lastDate)}`
                : '— (keine Transaktionen)',
        },
        { label: 'Bemessungsgrundlage (Netto)', value: `${money(report.totalNet)} €` },
    ];
    if (report.taxNumber) meta.splice(1, 0, { label: 'Steuernummer', value: report.taxNumber });

    const summary = [
        {
            label: 'Netto 19 %',
            net: money(report.netByRate.rate19),
            vat: money(round2(report.netByRate.rate19 * 0.19)),
        },
        { label: 'Netto 7 %', net: money(report.netByRate.rate7), vat: money(round2(report.netByRate.rate7 * 0.07)) },
        { label: 'Netto 0 % / steuerfrei', net: money(report.netByRate.rate0), vat: money(0) },
    ];

    const noteParts = [
        `Erstellt aus dem transaktionsbasierten Ledger (${report.basis === 'ist' ? 'Ist-Versteuerung' : 'Soll-Versteuerung'}), ` +
            'dieselbe Aggregation, die die USt-Voranmeldung und die EÜR speist.',
    ];
    if (report.reconciliationNote) noteParts.push(report.reconciliationNote);

    return {
        title: `Umsatzaufstellung ${report.year}`,
        subtitle: `Umsatz i.S.d. § 1 UStG (Netto-Entgelt) · ${report.basis === 'ist' ? 'Ist-Versteuerung' : 'Soll-Versteuerung'}`,
        meta,
        warning: report.coverage.warning,
        rows,
        summary,
        totalNet: money(report.totalNet),
        totalVat: money(report.totalVat),
        totalGross: money(report.totalGross),
        note: noteParts.join(' '),
    };
}

/** Resolve an entity id to its store account keys + ELSTER config (via the workspace manifest). */
function resolveEntity(entityId: string): { name: string; accountKeys: string[]; elster: ElsterConfig | undefined } {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const entities = resolveWorkspaceEntities(storeKeys);
    const entity = entities.find((e) => e.id === entityId);
    if (!entity) {
        const known = entities.map((e) => e.id).join(', ');
        throw new Error(`Unbekannte Entität '${entityId}'. Bekannt: ${known || '(keine)'}.`);
    }
    return { name: entity.name, accountKeys: entity.accountKeys, elster: entity.elster };
}

/** Compute the store's data coverage for the year + a warning when it doesn't span the full year. */
function computeCoverage(accountKeys: string[], year: number): UmsatzCoverage {
    const txs = searchAccountKeys(accountKeys, { from: `${year}-01-01`, to: `${year}-12-31` });
    if (txs.length === 0) {
        return {
            firstDate: null,
            lastDate: null,
            fullYear: false,
            warning: `Achtung: Für ${year} sind keine Transaktionen im Datenbestand — die Aufstellung ist leer.`,
        };
    }
    const dates = txs.map((t) => t.bookingDate).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const startsLate = firstDate > `${year}-01-31`;
    const endsEarly = lastDate < `${year}-12-01`;
    const fullYear = !startsLate && !endsEarly;
    let warning: string | null = null;
    if (!fullYear) {
        const missing: string[] = [];
        if (startsLate) missing.push(`01.01.${year} – ${deDate(firstDate)}`);
        if (endsEarly) missing.push(`${deDate(lastDate)} – 31.12.${year}`);
        warning =
            `Achtung: Der Datenbestand deckt das Kalenderjahr ${year} nicht vollständig ab. ` +
            `Erfasster Zeitraum: ${deDate(firstDate)} – ${deDate(lastDate)}. ` +
            `Nicht erfasst: ${missing.join(' und ')}. ` +
            'Die Aufstellung enthält nur die im Ledger erfassten Umsätze dieses Zeitraums; ' +
            'außerhalb liegende Umsätze sind ggf. aus anderen Quellen (z. B. USt-Jahreserklärung) zu ergänzen.';
    }
    return { firstDate, lastDate, fullYear, warning };
}

/** Orchestrate: resolve the entity, run the shared aggregation, and assemble the report. */
export async function buildUmsatzAufstellung(
    config: SyncConfig,
    opts: { entityId: string; year: number },
): Promise<UmsatzReport> {
    const { name, accountKeys, elster } = resolveEntity(opts.entityId);
    const agg = await euerReportByTransactions(config, opts.year, { detail: true, elster, accountKeys });
    const uste = aggregateUsteFromEuerTx(agg);
    const coverage = computeCoverage(accountKeys, opts.year);
    return assembleUmsatzReport(agg, uste, coverage, {
        entityId: opts.entityId,
        entityName: name,
        taxNumber: elster?.tax_number || null,
        year: opts.year,
        basis: elster?.taxation_basis ?? 'ist',
    });
}
