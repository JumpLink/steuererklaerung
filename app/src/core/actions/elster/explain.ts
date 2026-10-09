/**
 * Herleitung / explain-a-figure drill-down (roadmap S1 — the keystone verification primitive).
 *
 * Every tax figure the app renders is addressable by a small, stable, serialisable
 * {@link FigureRef}; {@link explainFigure} resolves a ref into a {@link FigureExplanation} — the
 * figure value, a short human formula, the child figures it composes from, and the list of
 * CONTRIBUTING transactions with their provenance (via Beleg / via Regel / unklassifiziert).
 *
 * This is a thin, pure projection over the EÜR aggregate: it does NOT re-classify anything. The
 * transaction-driven aggregate ({@link euerReportByTransactions}) already assigns every booking a
 * category + source (document|rule) + net/VAT; S1 merely EXPOSES the per-transaction rows behind
 * each category/total. The resolver ({@link resolveEuerFigure}) is pure over an aggregate so it is
 * unit-testable without the store; {@link explainFigure} is the thin I/O wrapper that builds the
 * aggregate first.
 *
 * FigureRef is deliberately domain-tagged (`euer:`) so USt-VA Kennzahlen, BWA cells and
 * Steuerkonto lines can plug in later behind the same interface (see the concept's P1).
 */

import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import { round2, fmtDe as fmt } from '../../lib/money.ts';
import { euerReportByTransactions } from './euer.ts';
import {
    beitragsZeilen,
    type EuerTeilZeile,
    type EuerTxAggregate,
    type EuerTxDetailRow,
    type MatchedRule,
} from '../../elster/euer-transactions.ts';
import type { EuerCategoryTotal } from '../../elster/euer-aggregate.ts';
import { herkunftText } from '../../elster/zu-pruefen.ts';

/** Which family of figures a ref addresses. Only `euer` for now; extensible (ustva/bwa/steuerkonto). */
export type FigureDomain = 'euer';

/** What flavour of EÜR figure a ref points at. */
export type FigureKind = 'income' | 'expense' | 'total';

/**
 * A small, stable, serialisable identifier for one tax figure. Canonical string form:
 * `euer:<year>:<kind>:<id>` (e.g. `euer:2025:expense:4670`, `euer:2025:total:gewinn`). The year may
 * be omitted from the string when a year is supplied out of band (e.g. the CLI `--year`).
 *
 * For `income`/`expense`, `id` is the category's leading SKR03 account token (`4670`), its full
 * label, or its Kennzahl. For `total`, `id` is one of the canonical total ids below.
 */
export interface FigureRef {
    domain: FigureDomain;
    year: number;
    kind: FigureKind;
    id: string;
}

/** Canonical total ids under `euer:<year>:total:<id>`. */
export type EuerTotalId = 'betriebseinnahmen' | 'betriebsausgaben' | 'gewinn' | 'ust-zahllast';

/** Where a contributing row's classification came from (extends `ClassSource` with `manual` for S2). */
export type FigureProvenanceSource = 'document' | 'rule' | 'manual' | 'unclassified';

/** The evidence trail for one contributing booking. */
export interface FigureProvenance {
    source: FigureProvenanceSource;
    /** Short label of the rule/keyword that matched (source='rule'). */
    rule?: string;
    /** Paperless document id (source='document'); null when there is no linked document. */
    documentId?: number | null;
    /** Who decided a MANUAL override (source='manual'). */
    decidedBy?: string;
    /** Owner Begründung for a MANUAL override (source='manual'). */
    note?: string;
    /** The rule that classified the row (stable id, label, Auffangregel flag). */
    matchedRule?: MatchedRule;
    /** For a MANUAL override: what the receipt or the rules would give without it. */
    ohneUmbuchung?: EuerTxDetailRow['ohneUmbuchung'];
    /** For a split booking (Idee 13): which part this row is, and all parts of the booking. */
    aufteilung?: { teilNr: number; teile: EuerTeilZeile[] };
}

/** One transaction contributing to a figure — the leaf of the drill-down. */
export interface FigureRow {
    transactionId: string;
    date: string;
    counterparty: string | null;
    /** Shortened booking purpose. */
    purpose: string | null;
    /** Signed original transaction amount in EUR (debit negative). */
    amount: number;
    /** Signed net contribution to its category (a refund/credit note nets negative). */
    net: number;
    vat: number;
    category: string;
    provenance: FigureProvenance;
    /** Whether the row counts toward the figure (always true for the rows returned here). */
    included: boolean;
}

/** A child term in a composite figure's formula (a sum/difference of sub-figures). */
export interface FigureChild {
    /** A drillable FigureRef string when the child is itself explainable. */
    ref?: string;
    label: string;
    value: number;
    op: '+' | '-';
}

/** The structured Herleitung of one figure. */
export interface FigureExplanation {
    ref: FigureRef;
    /** Canonical `euer:<year>:<kind>:<id>` string. */
    refString: string;
    label: string;
    value: number;
    unit: 'EUR';
    /** Short human formula, e.g. "Σ 30 Buchungen, netto" or "Betriebseinnahmen − Betriebsausgaben". */
    formula: string;
    /** Sub-figures this figure composes from (for totals); empty for a leaf category. */
    children: FigureChild[];
    /** The contributing transactions (empty for a pure arithmetic total is possible, but usually filled). */
    contributors: FigureRow[];
    /** Provenance mix over the contributors — the trust summary ("via Beleg: 3 · via Regel: 5"). */
    provenanceMix: { document: number; rule: number; manual: number; unclassified: number };
    meta: {
        year: number;
        entity?: string;
        /** Whether year-end adjustments (AfA/§24/Privatanteil) were folded in (an ELSTER config was given). */
        adjustmentsApplied: boolean;
        contributorCount: number;
    };
}

/** A compact listing entry for `--list` / the MCP `list` mode. */
export interface FigureRefListing {
    ref: string;
    label: string;
    value: number;
    kind: FigureKind;
    /** Number of contributing bookings (undefined for pure-arithmetic totals). */
    count?: number;
}

const TOTAL_ALIASES: Record<string, EuerTotalId> = {
    betriebseinnahmen: 'betriebseinnahmen',
    einnahmen: 'betriebseinnahmen',
    income: 'betriebseinnahmen',
    betriebsausgaben: 'betriebsausgaben',
    ausgaben: 'betriebsausgaben',
    expenses: 'betriebsausgaben',
    gewinn: 'gewinn',
    profit: 'gewinn',
    'ust-zahllast': 'ust-zahllast',
    ustzahllast: 'ust-zahllast',
    zahllast: 'ust-zahllast',
    vatpayable: 'ust-zahllast',
};

/** The leading account token of a category label ("8400 Erlöse 19% USt" → "8400"). */
function catId(category: string): string {
    return category.split(/\s+/)[0] ?? category;
}

/** Normalise a raw ref id: canonicalise the `total` aliases; leave category ids untouched (matched loosely). */
function normalizeId(kind: FigureKind, id: string): string {
    if (kind === 'total') {
        const canon = TOTAL_ALIASES[id.toLowerCase()];
        if (!canon)
            throw new Error(
                `Unbekannte EÜR-Summe '${id}'. Bekannt: betriebseinnahmen, betriebsausgaben, gewinn, ust-zahllast.`,
            );
        return canon;
    }
    return id.trim();
}

/**
 * Parse a compact FigureRef string. Accepts both `euer:<kind>:<id>` (year from `ctx.year`) and the
 * self-contained `euer:<year>:<kind>:<id>`. Throws with a helpful message on a malformed ref.
 */
export function parseFigureRef(input: string, ctx: { year?: number } = {}): FigureRef {
    const parts = input.trim().split(':');
    if (parts.length < 2) {
        throw new Error(`Ungültige FigureRef '${input}'. Beispiele: euer:expense:4670, euer:2025:total:gewinn.`);
    }
    const domain = parts[0].toLowerCase();
    if (domain !== 'euer') throw new Error(`Unbekannte FigureRef-Domain '${domain}' (unterstützt: euer).`);
    let idx = 1;
    let year = ctx.year;
    if (/^\d{4}$/.test(parts[1])) {
        year = Number(parts[1]);
        idx = 2;
    }
    const kind = parts[idx]?.toLowerCase();
    const id = parts
        .slice(idx + 1)
        .join(':')
        .trim();
    if (kind !== 'income' && kind !== 'expense' && kind !== 'total') {
        throw new Error(`Ungültige FigureRef-Art '${kind ?? ''}' in '${input}' (income|expense|total).`);
    }
    if (!id) throw new Error(`FigureRef '${input}' ohne id (z.B. euer:${kind}:4670).`);
    if (year == null) {
        throw new Error(`FigureRef '${input}' ohne Jahr — Jahr in die Ref schreiben (euer:2025:…) oder --year setzen.`);
    }
    return { domain: 'euer', year, kind, id: normalizeId(kind, id) };
}

/** Canonical `euer:<year>:<kind>:<id>` string. */
export function formatFigureRef(ref: FigureRef): string {
    return `${ref.domain}:${ref.year}:${ref.kind}:${ref.id}`;
}

/** Does a category label match a ref id (exact / leading-token / kz)? Case-insensitive. */
function categoryMatchesId(cat: EuerCategoryTotal, id: string): boolean {
    const low = id.toLowerCase();
    const c = cat.category.toLowerCase();
    return c === low || c.startsWith(`${low} `) || catId(cat.category).toLowerCase() === low || cat.kz === id;
}

/** Every reviewable row backing the aggregate: the in-period detail + the §24 rows folded into totals. */
function allRows(agg: EuerTxAggregate): EuerTxDetailRow[] {
    // A split booking contributes once per part, each under its own category (Idee 13).
    const detail = beitragsZeilen(agg.detail ?? []);
    const outsideIncluded = (agg.coverage.outsidePeriod ?? []).filter((o) => o.included);
    return [...detail, ...outsideIncluded];
}

/** Map an aggregate detail row to a figure contributor row (short purpose + provenance). */
function toFigureRow(r: EuerTxDetailRow): FigureRow {
    const source: FigureProvenanceSource = r.source; // 'document' | 'rule' | 'unclassified' | 'manual'
    return {
        transactionId: r.id,
        date: r.bookingDate,
        counterparty: r.counterparty ?? null,
        purpose: r.purpose ? r.purpose.slice(0, 80) : null,
        amount: r.amount,
        net: r.net,
        vat: r.vat,
        category: r.category,
        provenance: {
            source,
            rule: r.rule,
            documentId: source === 'document' ? (r.documentId ?? null) : undefined,
            decidedBy: source === 'manual' ? r.decidedBy : undefined,
            note: source === 'manual' ? r.note : undefined,
            matchedRule: r.matchedRule,
            ohneUmbuchung: source === 'manual' || r.matchedRule?.art === 'erstattung' ? r.ohneUmbuchung : undefined,
            ...(r.aufteilung && r.teilNr != null ? { aufteilung: { teilNr: r.teilNr, teile: r.aufteilung } } : {}),
        },
        included: true,
    };
}

function provenanceMix(rows: FigureRow[]): FigureExplanation['provenanceMix'] {
    const mix = { document: 0, rule: 0, manual: 0, unclassified: 0 };
    for (const row of rows) mix[row.provenance.source] += 1;
    return mix;
}

/** German label for a total id. */
function totalLabel(id: EuerTotalId): string {
    switch (id) {
        case 'betriebseinnahmen':
            return 'Betriebseinnahmen (netto)';
        case 'betriebsausgaben':
            return 'Betriebsausgaben (netto)';
        case 'gewinn':
            return 'Gewinn (Einnahmen − Ausgaben)';
        case 'ust-zahllast':
            return 'USt-Zahllast (USt − Vorsteuer)';
    }
}

/**
 * Resolve a FigureRef against an already-computed EÜR aggregate — PURE, no I/O. Requires an
 * aggregate built with `{ detail: true }` so the constituent rows are present.
 */
export function resolveEuerFigure(
    agg: EuerTxAggregate,
    ref: FigureRef,
    opts: { entity?: string } = {},
): FigureExplanation {
    if (ref.year !== agg.year) {
        throw new Error(`FigureRef-Jahr ${ref.year} ≠ Aggregat-Jahr ${agg.year}.`);
    }
    const rows = allRows(agg);
    const base = {
        ref,
        refString: formatFigureRef(ref),
        unit: 'EUR' as const,
        meta: {
            year: agg.year,
            entity: opts.entity,
            adjustmentsApplied: agg.adjustmentsApplied,
        },
    };

    if (ref.kind === 'income' || ref.kind === 'expense') {
        const cats = (ref.kind === 'income' ? agg.income : agg.expenses).filter((c) => categoryMatchesId(c, ref.id));
        if (cats.length === 0) {
            throw new Error(
                `Keine ${ref.kind === 'income' ? 'Einnahmen' : 'Ausgaben'}-Kategorie für '${ref.id}' in ${agg.year} gefunden. ` +
                    `Verfügbare Refs: elster explain --year ${agg.year} --list.`,
            );
        }
        const catKeys = new Set(cats.map((c) => c.category));
        const contributors = rows.filter((r) => r.kind === ref.kind && catKeys.has(r.category)).map(toFigureRow);
        const value = round2(cats.reduce((s, c) => s + c.net, 0));
        const label = cats.length === 1 ? cats[0].category : `${cats.length} Kategorien (${ref.id})`;
        return {
            ...base,
            label,
            value,
            formula: `Σ ${contributors.length} Buchung${contributors.length === 1 ? '' : 'en'}, netto`,
            children: [],
            contributors,
            provenanceMix: provenanceMix(contributors),
            meta: { ...base.meta, contributorCount: contributors.length },
        };
    }

    // Totals.
    const totalId = ref.id as EuerTotalId;
    const t = agg.totals;
    const incomeRows = rows.filter((r) => r.kind === 'income').map(toFigureRow);
    const expenseRows = rows.filter((r) => r.kind === 'expense').map(toFigureRow);

    if (totalId === 'betriebseinnahmen' || totalId === 'betriebsausgaben') {
        const isIncome = totalId === 'betriebseinnahmen';
        const cats = isIncome ? agg.income : agg.expenses;
        const contributors = isIncome ? incomeRows : expenseRows;
        const value = isIncome ? t.incomeNet : t.expenseNet;
        const children: FigureChild[] = cats.map((c) => ({
            ref: formatFigureRef({
                domain: 'euer',
                year: agg.year,
                kind: isIncome ? 'income' : 'expense',
                id: catId(c.category),
            }),
            label: c.category,
            value: c.net,
            op: '+',
        }));
        return {
            ...base,
            label: totalLabel(totalId),
            value,
            formula: `Σ ${contributors.length} Buchungen über ${cats.length} Kategorie${cats.length === 1 ? '' : 'n'}, netto`,
            children,
            contributors,
            provenanceMix: provenanceMix(contributors),
            meta: { ...base.meta, contributorCount: contributors.length },
        };
    }

    if (totalId === 'gewinn') {
        // Composite: value derives from the two child totals (not from Σ contributors.net). The
        // contributors are the full income + expense trail for a complete audit.
        const contributors = [...incomeRows, ...expenseRows];
        return {
            ...base,
            label: totalLabel(totalId),
            value: t.profit,
            formula: `Betriebseinnahmen (${fmt(t.incomeNet)}) − Betriebsausgaben (${fmt(t.expenseNet)})`,
            children: [
                {
                    ref: formatFigureRef({ domain: 'euer', year: agg.year, kind: 'total', id: 'betriebseinnahmen' }),
                    label: 'Betriebseinnahmen',
                    value: t.incomeNet,
                    op: '+',
                },
                {
                    ref: formatFigureRef({ domain: 'euer', year: agg.year, kind: 'total', id: 'betriebsausgaben' }),
                    label: 'Betriebsausgaben',
                    value: t.expenseNet,
                    op: '-',
                },
            ],
            contributors,
            provenanceMix: provenanceMix(contributors),
            meta: { ...base.meta, contributorCount: contributors.length },
        };
    }

    // ust-zahllast
    const contributors = [...incomeRows, ...expenseRows];
    return {
        ...base,
        label: totalLabel('ust-zahllast'),
        value: t.vatPayable,
        formula: `vereinnahmte USt (${fmt(t.outputVat)}) − Vorsteuer (${fmt(t.inputVat)})`,
        children: [
            { label: 'Vereinnahmte USt', value: t.outputVat, op: '+' },
            { label: 'Gezahlte Vorsteuer', value: t.inputVat, op: '-' },
        ],
        contributors,
        provenanceMix: provenanceMix(contributors),
        meta: { ...base.meta, contributorCount: contributors.length },
    };
}

/** Enumerate every drillable FigureRef for a year's aggregate — categories + the four totals. */
export function listEuerFigureRefs(agg: EuerTxAggregate): FigureRefListing[] {
    const out: FigureRefListing[] = [];
    const push = (kind: FigureKind, cats: EuerCategoryTotal[]) => {
        for (const c of cats) {
            out.push({
                ref: formatFigureRef({ domain: 'euer', year: agg.year, kind, id: catId(c.category) }),
                label: c.category,
                value: c.net,
                kind,
                count: c.count,
            });
        }
    };
    push('income', agg.income);
    push('expense', agg.expenses);
    const total = (id: EuerTotalId, value: number): FigureRefListing => ({
        ref: formatFigureRef({ domain: 'euer', year: agg.year, kind: 'total', id }),
        label: totalLabel(id),
        value,
        kind: 'total',
    });
    out.push(total('betriebseinnahmen', agg.totals.incomeNet));
    out.push(total('betriebsausgaben', agg.totals.expenseNet));
    out.push(total('gewinn', agg.totals.profit));
    out.push(total('ust-zahllast', agg.totals.vatPayable));
    return out;
}

/** Options mirroring how the EÜR report is scoped (entity accounts + ELSTER config adjustments). */
export interface ExplainOptions {
    /** Year fallback when the ref string omits it (the CLI `--year`). */
    year?: number;
    accountKeys?: string[];
    /** ELSTER config → folds in AfA/§24/Privatanteil so the figures match the authoritative EÜR. */
    elster?: ElsterConfig;
    /** Human entity id, echoed into the explanation meta. */
    entity?: string;
}

/**
 * I/O wrapper: build the transaction-driven EÜR aggregate for the ref's year, then resolve the ref.
 * Entity/year scoped exactly like `euerReportByTransactions` (account keys + ELSTER config).
 */
export async function explainFigure(
    config: SyncConfig,
    ref: string | FigureRef,
    opts: ExplainOptions = {},
): Promise<FigureExplanation> {
    const parsed = typeof ref === 'string' ? parseFigureRef(ref, { year: opts.year }) : ref;
    const agg = await euerReportByTransactions(config, parsed.year, {
        accountKeys: opts.accountKeys,
        elster: opts.elster,
        detail: true,
    });
    return resolveEuerFigure(agg, parsed, { entity: opts.entity });
}

/** I/O wrapper: list every drillable FigureRef for a year. */
export async function listFigures(
    config: SyncConfig,
    year: number,
    opts: { accountKeys?: string[]; elster?: ElsterConfig } = {},
): Promise<FigureRefListing[]> {
    const agg = await euerReportByTransactions(config, year, {
        accountKeys: opts.accountKeys,
        elster: opts.elster,
        detail: true,
    });
    return listEuerFigureRefs(agg);
}

/** Print a human-readable Herleitung: the figure, its formula, children, and the contributing rows. */
export function printFigureExplanation(ex: FigureExplanation): void {
    console.log(`\nHerleitung — ${ex.label}`);
    console.log('='.repeat(72));
    console.log(`  Ref:     ${ex.refString}`);
    console.log(`  Wert:    ${fmt(ex.value)} €`);
    console.log(`  Formel:  ${ex.formula}`);
    if (!ex.meta.adjustmentsApplied) {
        console.log(
            '  ⚠ vorläufig: ohne Jahresabschluss-Anpassungen (AfA/§24/Privatanteil) — mit --config/ELSTER_CONFIG ausführen.',
        );
    }

    if (ex.children.length > 0) {
        console.log('\nZusammensetzung:');
        for (const c of ex.children) {
            console.log(`  ${c.op} ${fmt(c.value).padStart(12)} €   ${c.label}${c.ref ? `   [${c.ref}]` : ''}`);
        }
    }

    const m = ex.provenanceMix;
    console.log(
        `\nBuchungen (${ex.contributors.length}) — via Beleg: ${m.document} · via Regel: ${m.rule} · unklassifiziert: ${m.unclassified}${m.manual ? ` · manuell: ${m.manual}` : ''}`,
    );
    for (const r of ex.contributors) {
        const cp = (r.counterparty ?? '').slice(0, 24).padEnd(24);
        const prov =
            r.provenance.source === 'document'
                ? `Beleg${r.provenance.documentId != null ? ` #${r.provenance.documentId}` : ''}`
                : r.provenance.source === 'rule'
                  ? r.provenance.matchedRule
                      ? herkunftText(r.provenance)
                      : `Regel: ${r.provenance.rule ?? '—'}`
                  : r.provenance.source === 'manual'
                    ? `manuell${r.provenance.decidedBy ? ` (${r.provenance.decidedBy})` : ''}${r.provenance.note ? ` — ${r.provenance.note}` : ''}`
                    : 'UNKLAR';
        console.log(`  ${r.date}  ${fmt(r.net).padStart(11)} €  ${cp}  ${prov}`);
    }
    console.log('');
}

/** Print the available FigureRefs for a year (for `--list`). */
export function printFigureList(refs: FigureRefListing[], year: number): void {
    console.log(`\nVerfügbare Kennzahlen (FigureRefs) — EÜR ${year}`);
    console.log('='.repeat(72));
    const section = (title: string, kind: FigureKind) => {
        const rows = refs.filter((r) => r.kind === kind);
        if (rows.length === 0) return;
        console.log(`\n${title}:`);
        for (const r of rows) {
            const cnt = r.count != null ? ` (${r.count})` : '';
            console.log(`  ${r.ref.padEnd(34)} ${fmt(r.value).padStart(12)} €   ${r.label}${cnt}`);
        }
    };
    section('Betriebseinnahmen', 'income');
    section('Betriebsausgaben', 'expense');
    section('Summen', 'total');
    console.log('');
}
