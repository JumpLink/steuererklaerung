/**
 * Private-household transaction aggregate for the ESt estimate — the counterpart of the EÜR's
 * {@link file://./euer-transactions.ts aggregateEuerByTransactions}, but for a private account.
 *
 * It classifies bank transactions (no Paperless/DMS involved — a private account is store-only) into
 * the Finanzguru-style "Steuer-Themen" buckets and rolls them up into the transaction-derived parts
 * of {@link EstInputs}. Config values (the Lohnsteuerbescheinigung, manual Werbungskosten, per-item
 * §35a Arbeitskosten) are merged on top by the caller — the aggregate only proposes.
 *
 * Two deliberate limits, both surfaced rather than hidden:
 *  - §35a bank amounts are a **gross upper bound** (they include non-qualifying Material). Only an
 *    explicit per-item `arbeitskosten` override counts toward the credit; without one the amount is
 *    reported but claims 0, and the transaction is flagged so the wizard can ask for the Arbeitslohn.
 *  - Salary inflows are a **plausibility signal only** (net transfers carry no Brutto/LSt/SV split);
 *    the calc never derives figures from them.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import { round2 } from '../lib/money.ts';
import type { EstWerbungskostenPosten } from './est-berechnung.ts';

/** The private "Steuer-Themen" a transaction can fall into (`neutral` = not tax-relevant). */
export type EstThemeBucket =
    | 'arbeit'
    | 'handwerker'
    | 'haushaltsnah'
    | 'vorsorge'
    | 'gesundheit'
    | 'spenden'
    | 'kapital'
    | 'gehalt'
    | 'neutral';

/** Buckets whose transactions are outflows (deductions); the rest are inflows (income). */
const EXPENSE_BUCKETS: ReadonlySet<EstThemeBucket> = new Set([
    'arbeit',
    'handwerker',
    'haushaltsnah',
    'vorsorge',
    'gesundheit',
    'spenden',
]);

export interface EstTxClassification {
    bucket: EstThemeBucket;
    source: 'rule' | 'unclassified';
    /** Which keyword group matched — for the review/detail view. */
    rule?: string;
}

/** Keyword groups, matched in order (most specific first). Each entry: [bucket, rule, needles…]. */
const RULES: Array<[EstThemeBucket, string, string[]]> = [
    [
        'gesundheit',
        'Gesundheit/Arzt/Apotheke',
        [
            'zahnarzt',
            'zahnbehandlung',
            'arztpraxis',
            ' arzt',
            'apotheke',
            'klinik',
            'krankenhaus',
            'optiker',
            'brille',
            'physiotherap',
            'heilpraktiker',
            'gesundheit',
        ],
    ],
    [
        'haushaltsnah',
        'haushaltsnahe DL (§35a)',
        [
            'reinigung',
            'gartenpflege',
            'gärtner',
            'gaertner',
            'hausmeister',
            'haushaltshilfe',
            'fensterputz',
            'winterdienst',
            'pflegedienst',
        ],
    ],
    [
        'handwerker',
        'Handwerkerleistung (§35a)',
        [
            'handwerker',
            'malerarbeit',
            'maler',
            'elektroinstall',
            'elektriker',
            'sanitär',
            'sanitaer',
            'installateur',
            'reparatur',
            'renovier',
            'dachdecker',
            'heizung',
            'schornstein',
            'fliesenleg',
        ],
    ],
    [
        'vorsorge',
        'Versicherung/Vorsorge',
        [
            'haftpflicht',
            'unfallversicherung',
            'krankenversicherung',
            'krankenzusatz',
            'rentenversicherung',
            'pflegeversicherung',
            'berufsunfähig',
            'berufsunfaehig',
            'risikoleben',
            'versicherung',
        ],
    ],
    [
        'arbeit',
        'Werbungskosten (Arbeitsmittel/Fortbildung)',
        [
            'fachbuch',
            'fachliteratur',
            'fachzeitschrift',
            'fortbildung',
            'weiterbildung',
            'seminar',
            'konferenz',
            'arbeitsmittel',
            'coworking',
        ],
    ],
    ['spenden', 'Spende (§10b)', ['spende', 'seenotretter', 'förderverein', 'foerderverein']],
    [
        'kapital',
        'Kapitalerträge',
        ['zinsen', 'zinsgutschrift', 'dividende', 'kapitalertrag', 'ausschüttung', 'ausschuettung'],
    ],
    ['gehalt', 'Gehalt/Lohn', ['gehalt', ' lohn', 'entgelt', 'besoldung', 'bezüge', 'einnahmen (privat)']],
    [
        'neutral',
        'Miete/Lebenshaltung (privat)',
        [
            'miete',
            'nebenkosten',
            'lebenshaltung',
            'lebensmittel',
            'supermarkt',
            'rewe',
            'edeka',
            'aldi',
            'lidl',
            'rundfunk',
            'gez',
        ],
    ],
];

function hay(t: UnifiedTransaction): string {
    return `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''} ${t.type ?? ''} ${t.category ?? ''}`.toLowerCase();
}

/**
 * Classify a private transaction into a Steuer-Thema by counterparty/purpose/category keywords.
 * Returns `neutral`/`unclassified` when nothing matches — the caller surfaces those for review.
 */
export function classifyPrivateTransaction(t: UnifiedTransaction): EstTxClassification {
    const h = hay(t);
    for (const [bucket, rule, needles] of RULES) {
        if (needles.some((n) => h.includes(n))) return { bucket, source: 'rule', rule };
    }
    return { bucket: 'neutral', source: 'unclassified' };
}

/** One reviewable row per private transaction: the booking + its bucket and signed contribution. */
export interface EstTxDetailRow {
    id: string;
    accountKey: string;
    bookingDate: string;
    counterparty?: string;
    purpose?: string;
    /** Signed original amount (debit negative). */
    amount: number;
    bucket: EstThemeBucket;
    source: 'rule' | 'unclassified';
    rule?: string;
    /** Positive contribution to the bucket (outflow for expenses, inflow for income). */
    betrag: number;
    /** §35a only: an explicit Arbeitskosten override was applied (gross otherwise doesn't count). */
    arbeitskostenOverride?: number;
}

export interface EstTxBucketTotal {
    bucket: EstThemeBucket;
    count: number;
    summe: number;
}

/** Per-transaction overrides carried in from the ESt config. */
export interface EstTxOverrides {
    /** tx id → begünstigte Arbeitskosten (§35a); replaces the gross for that transaction. */
    arbeitskosten?: Record<string, number>;
    /** tx id → forced bucket (correct a misclassification). */
    reklassifizierung?: Record<string, EstThemeBucket>;
}

/** The transaction-derived parts of the ESt estimate + coverage + the theme roll-up. */
export interface EstTxAggregate {
    year: number;
    /** Werbungskosten line items from `arbeit` transactions (config posten are added by the caller). */
    werbungskostenPosten: EstWerbungskostenPosten[];
    /** §35a Handwerker: begünstigte Arbeitskosten actually claimable (sum of overrides). */
    handwerkerArbeitskosten: number;
    /** §35a Handwerker: gross bank total (upper bound incl. Material) — for the "enter Arbeitslohn" hint. */
    handwerkerBrutto: number;
    /** §35a haushaltsnah: claimable (overrides) + gross upper bound. */
    haushaltsnahArbeitskosten: number;
    haushaltsnahBrutto: number;
    /** Count of §35a transactions still missing an Arbeitskosten override (drives the warn step). */
    par35aOhneArbeitskosten: number;
    spenden: number;
    krankheitskosten: number;
    /** Versicherungs-/Vorsorge-Kandidaten — need a human split into Basis-KV/PV vs. sonstige. */
    vorsorgeKandidat: number;
    /** Kapitalerträge (info only — Sparer-Pauschbetrag, Abgeltungsteuer separat). */
    kapitalertraege: number;
    /** Net salary inflows — plausibility cross-check only, never a calc input. */
    gehaltNettoSumme: number;
    buckets: EstTxBucketTotal[];
    coverage: {
        transactions: number;
        classifiedByRule: number;
        unclassified: Array<{
            id: string;
            bookingDate: string;
            amount: number;
            counterparty?: string;
            purpose?: string;
        }>;
    };
    detail?: EstTxDetailRow[];
}

/**
 * Roll up one year of private transactions into the ESt theme buckets. Pure — pass already-loaded
 * store transactions. `overrides` (from the config) carry §35a Arbeitskosten and reclassifications.
 */
export function aggregateEstByTransactions(
    txs: UnifiedTransaction[],
    year: number,
    options: { detail?: boolean; overrides?: EstTxOverrides } = {},
): EstTxAggregate {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const arbeitskostenOv = options.overrides?.arbeitskosten ?? {};
    const reklass = options.overrides?.reklassifizierung ?? {};
    const detail: EstTxDetailRow[] | undefined = options.detail ? [] : undefined;

    const bucketSums = new Map<EstThemeBucket, { count: number; summe: number }>();
    const werbungskostenPosten: EstWerbungskostenPosten[] = [];
    let handwerkerArbeitskosten = 0;
    let handwerkerBrutto = 0;
    let haushaltsnahArbeitskosten = 0;
    let haushaltsnahBrutto = 0;
    let par35aOhneArbeitskosten = 0;
    let spenden = 0;
    let krankheitskosten = 0;
    let vorsorgeKandidat = 0;
    let kapitalertraege = 0;
    let gehaltNettoSumme = 0;
    const coverage: EstTxAggregate['coverage'] = { transactions: 0, classifiedByRule: 0, unclassified: [] };

    for (const t of txs) {
        if (t.bookingDate < from || t.bookingDate > to) continue;
        coverage.transactions += 1;

        const forced = reklass[t.id];
        const cls = forced
            ? { bucket: forced, source: 'rule' as const, rule: 'Reklassifizierung (Config)' }
            : classifyPrivateTransaction(t);
        if (cls.source === 'rule') coverage.classifiedByRule += 1;

        // Signed contribution: outflow-positive for expense buckets, inflow for income buckets.
        const betrag = EXPENSE_BUCKETS.has(cls.bucket) ? round2(-t.amount) : round2(t.amount);
        const agg = bucketSums.get(cls.bucket) ?? { count: 0, summe: 0 };
        agg.count += 1;
        agg.summe = round2(agg.summe + betrag);
        bucketSums.set(cls.bucket, agg);

        let arbeitskostenOverride: number | undefined;
        switch (cls.bucket) {
            case 'arbeit':
                werbungskostenPosten.push({
                    bezeichnung: `${t.counterparty ?? 'Ausgabe'}${t.purpose ? ` · ${t.purpose}` : ''}`,
                    betrag,
                    quelle: 'transaktion',
                });
                break;
            case 'handwerker': {
                handwerkerBrutto = round2(handwerkerBrutto + betrag);
                const ov = arbeitskostenOv[t.id];
                if (ov != null) {
                    arbeitskostenOverride = round2(Math.min(ov, betrag));
                    handwerkerArbeitskosten = round2(handwerkerArbeitskosten + arbeitskostenOverride);
                } else if (betrag > 0) {
                    par35aOhneArbeitskosten += 1;
                }
                break;
            }
            case 'haushaltsnah': {
                haushaltsnahBrutto = round2(haushaltsnahBrutto + betrag);
                const ov = arbeitskostenOv[t.id];
                if (ov != null) {
                    arbeitskostenOverride = round2(Math.min(ov, betrag));
                    haushaltsnahArbeitskosten = round2(haushaltsnahArbeitskosten + arbeitskostenOverride);
                } else if (betrag > 0) {
                    par35aOhneArbeitskosten += 1;
                }
                break;
            }
            case 'gesundheit':
                krankheitskosten = round2(krankheitskosten + betrag);
                break;
            case 'spenden':
                spenden = round2(spenden + betrag);
                break;
            case 'vorsorge':
                vorsorgeKandidat = round2(vorsorgeKandidat + betrag);
                break;
            case 'kapital':
                kapitalertraege = round2(kapitalertraege + betrag);
                break;
            case 'gehalt':
                gehaltNettoSumme = round2(gehaltNettoSumme + betrag);
                break;
            case 'neutral':
                if (cls.source === 'unclassified') {
                    coverage.unclassified.push({
                        id: t.id,
                        bookingDate: t.bookingDate,
                        amount: t.amount,
                        counterparty: t.counterparty,
                        purpose: t.purpose,
                    });
                }
                break;
        }

        detail?.push({
            id: t.id,
            accountKey: t.accountKey,
            bookingDate: t.bookingDate,
            counterparty: t.counterparty,
            purpose: t.purpose,
            amount: t.amount,
            bucket: cls.bucket,
            source: cls.source,
            rule: cls.rule,
            betrag,
            arbeitskostenOverride,
        });
    }

    const buckets: EstTxBucketTotal[] = [...bucketSums.entries()]
        .map(([bucket, v]) => ({ bucket, count: v.count, summe: v.summe }))
        .sort((a, b) => b.summe - a.summe);

    return {
        year,
        werbungskostenPosten,
        handwerkerArbeitskosten,
        handwerkerBrutto,
        haushaltsnahArbeitskosten,
        haushaltsnahBrutto,
        par35aOhneArbeitskosten,
        spenden,
        krankheitskosten,
        vorsorgeKandidat,
        kapitalertraege,
        gehaltNettoSumme,
        buckets,
        coverage,
        detail,
    };
}
