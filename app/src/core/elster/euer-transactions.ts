/**
 * Transaction-driven Anlage-EÜR aggregate (cash basis).
 *
 * The bank account is the ground truth for a cash-basis EÜR: every euro that
 * moved is accounted for. Each transaction gets a category from
 *   (a) its linked invoice document (net/VAT from the document, but the EUR
 *       amount from the *transaction* — which fixes foreign-currency invoices),
 *   (b) failing that, a rule for no-document items (internal transfer, private
 *       draw, tax payment, bank fee),
 *   (c) failing that, it is reported as **unclassified** — the real gap.
 *
 * Pure functions only (no I/O): the action layer fetches transactions + a
 * txId→document map and passes them in, so this is unit-testable.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import { round2 } from '../lib/money.ts';
import { NEUTRAL_MIT_VORSTEUER, SKR03_TO_EUER, type EuerKind, type EuerCategoryTotal } from './euer-aggregate.ts';
import { aufteilungTitel, berechneTeile, hauptTeil, type Teil, type TeilEingabe } from './splitbuchung.ts';
import {
    classifyReverseCharge,
    emptyReverseChargeTotals,
    addReverseChargeItem,
    type ReverseChargeTotals,
} from './reverse-charge.ts';
import {
    classifyNoDocTransaction,
    impliedRate,
    type ClassSource,
    type MatchedRule,
    type TxClassification,
    type TxClassifyRule,
    type TxClassifyRules,
} from './euer-classify.ts';

// Re-exported so existing importers (uste-aggregate, ledger seed, the euer-transactions test)
// keep resolving these from here after the classification rules moved to ./euer-classify.ts.
export { classifyNoDocTransaction, impliedRate };
export type { ClassSource, MatchedRule, TxClassification, TxClassifyRule, TxClassifyRules };

/** What a linked invoice document contributes for a transaction. */
export interface TxDocInfo {
    /** Paperless document id of the linked invoice — surfaced as row provenance (Herleitung). */
    documentId?: number;
    /** SKR03 accounting_category label (resolved). */
    category: string;
    /** Net amount from the document, EUR only (else derived from the tx gross). */
    netEur?: number;
    vatEur?: number;
    /** Tax rate as a fraction (0.19) — used to split a non-EUR tx gross into net/VAT. */
    taxRate?: number;
    currency: string;
    /** §13b signals (from the linked invoice) — drive reverse-charge classification. */
    reverseCharge?: boolean;
    supplierCountry?: string;
    /** Supplier USt-IdNr from the invoice — a foreign prefix marks a foreign supplier (Idee 10). */
    supplierVatId?: string;
    saleType?: 'GOODS' | 'SERVICES';
}

/**
 * Shrink an invoice to what the bookings it is linked to ACTUALLY paid.
 *
 * An EÜR is a cash-basis calculation (§4 Abs. 3 EStG): only what left the account in the year is
 * an expense. A document may legitimately be larger than its links — it covers payments that are
 * booked separately, or a part that was paid in another year — and taking its full amount then
 * counts money that was never spent from these bookings.
 *
 * Found in a live return: the December Qonto invoice over 1,46 € bundles all three account fees
 * (0,03 + 0,41 + 1,02), but `qonto_transaction_id` names only the 0,41 booking. That booking got
 * the whole 1,46 €, while the other two were classified by rule with their own correct amounts —
 * 2,51 € of expense for 1,46 € of fees. Unlike the multi-payment case below, this one slips
 * through the SINGLE-transaction path, which is why the cap runs before it.
 *
 * Only caps DOWNWARD, and only with EUR amounts on both sides and every linked booking present:
 * a document that is smaller than its payments is the normal case (one payment settling several
 * invoices) and must be left alone, and a missing booking would make the payments look too small.
 */
function capDocToPayments(
    info: TxDocInfo,
    txIds: readonly string[],
    amountById: ReadonlyMap<string, number>,
): TxDocInfo {
    if (info.netEur == null || txIds.length === 0) return info;
    if (!txIds.every((id) => amountById.has(id))) return info;
    const paid = round2(txIds.reduce((sum, id) => sum + (amountById.get(id) ?? 0), 0));
    const gross = round2(info.netEur + (info.vatEur ?? 0));
    if (paid <= 0 || gross <= paid + 0.01) return info;

    const factor = paid / gross;
    const net = round2(info.netEur * factor);
    // VAT takes the remainder so net + VAT is exactly what was paid — the same reason the last
    // share carries the rounding in the apportioning below.
    return { ...info, netEur: net, vatEur: info.vatEur == null ? undefined : round2(paid - net) };
}

/**
 * Spread ONE invoice across the transactions that paid it.
 *
 * `qonto_transaction_id` may name several bookings, because a supplier's collective invoice is
 * often settled in more than one card charge. The mapping used to hand EVERY one of them the
 * document's FULL net and VAT, so an invoice paid in two parts was booked twice.
 *
 * Found in a live return: INWX invoice 2025111419 (19,82 net / 23,58 gross, three domain
 * renewals) was paid as 9,30 € + 14,28 €. Both bookings link to it correctly — and the EÜR
 * counted 39,64 € of expense. That understates the profit of a declaration, and the same double
 * count reaches the Vorsteuer.
 *
 * Split by each transaction's share of the total paid, which is the actual allocation: the sum of
 * the payments IS the invoice. Falls back to an even split when an amount is missing or the
 * amounts sum to zero — better a defensible approximation than a knowingly multiplied one.
 * Rounding differences land on the LAST share so the parts still add up to the invoice.
 *
 * The single-transaction case — the overwhelming majority — passes through untouched.
 */
export function apportionDocAcrossTransactions(
    raw: TxDocInfo,
    txIds: readonly string[],
    txs: readonly UnifiedTransaction[],
): Array<[string, TxDocInfo]> {
    const amountById = new Map(txs.map((t) => [t.id, Math.abs(t.amount)]));
    // Cap FIRST: a document larger than its links is wrong for one booking as much as for five,
    // and the single-transaction shortcut below would otherwise return it unchanged.
    const info = capDocToPayments(raw, txIds, amountById);
    if (txIds.length <= 1) return txIds.map((id) => [id, info]);

    const weights = txIds.map((id) => amountById.get(id) ?? 0);
    const total = weights.reduce((a, b) => a + b, 0);
    const useAmounts = total > 0 && weights.every((w) => w > 0);

    const out: Array<[string, TxDocInfo]> = [];
    let netLeft = info.netEur;
    let vatLeft = info.vatEur;
    txIds.forEach((id, i) => {
        const last = i === txIds.length - 1;
        const share = useAmounts ? weights[i] / total : 1 / txIds.length;
        // The last part takes whatever is left, so the pieces sum to the invoice exactly.
        const net = info.netEur == null ? undefined : last ? round2(netLeft ?? 0) : round2(info.netEur * share);
        const vat = info.vatEur == null ? undefined : last ? round2(vatLeft ?? 0) : round2(info.vatEur * share);
        if (netLeft != null && net != null) netLeft = round2(netLeft - net);
        if (vatLeft != null && vat != null) vatLeft = round2(vatLeft - vat);
        out.push([id, { ...info, netEur: net, vatEur: vat }]);
    });
    return out;
}

/**
 * A persisted MANUAL bookkeeping override for one transaction, loaded from the store's
 * `classifications` (source='manual'). The action layer builds the `overrides` map (keyed by the
 * unified transaction id) and passes it into the pure aggregate; a matching tx is booked under
 * {@link category} with `source='manual'`, carrying the owner {@link note} + {@link decidedBy} into
 * its detail row (so the Herleitung/explain shows "manuell"). Kept minimal + store-decoupled: the
 * pure aggregate never touches the DB.
 */
export interface EuerManualOverride {
    /** SKR03 category label to book the tx under (wins over document + rule). */
    category: string;
    /** Owner Begründung (classifications.note), surfaced in the detail row. */
    note?: string | null;
    /** Who decided (classifications.decided_by), surfaced in the detail row. */
    decidedBy?: string | null;
}

/**
 * A refund the owner linked to the debit it refunds (Idee 9), keyed by the refund's tx id. The refund
 * books under the original's category and VAT rate, frozen at the moment of the link — see
 * docs/references/tax-sources.md, „Erstattungen", for why that is a reduction of the expense in the
 * refund's own year and Voranmeldungszeitraum.
 */
export interface EuerErstattung {
    originalTxId: string;
    category: string;
    /** VAT rate of the original as a fraction (0.19). */
    vatRate: number;
    /** How the original reads in „via Erstattung zu …" (date and counterparty). */
    originalLabel: string;
}

/**
 * One part of a split booking as the aggregate booked it (Idee 13): its category, the signed
 * contribution like a detail row's, and the part as computed (`betrag` positive, `vatRate`, `rest`).
 */
export interface EuerTeilZeile extends Pick<Teil, 'nr' | 'betrag' | 'vatRate' | 'rest' | 'betrieblich' | 'note'> {
    category: string;
    kz: string;
    kind: EuerKind;
    net: number;
    vat: number;
    gross: number;
}

/** What one booking is classified as, and by what — the per-transaction step of the aggregate. */
export interface TxClassified {
    category: string;
    kind: EuerKind;
    source: ClassSource;
    rule?: string;
    matchedRule?: MatchedRule;
    note?: string;
    decidedBy?: string;
    /** Set for a linked refund: the inherited VAT rate that splits its gross. */
    vatRate?: number;
}

/**
 * Classify ONE booking the way the aggregate does: a manual override wins, then a linked Erstattung,
 * then the linked receipt, then the rule chain; a confirmed double payment is neutralised unless an
 * override says otherwise.
 *
 * Exported so the question „what applies if I take my Umbuchung back?" is answered by THIS function
 * run without the override, not by a second copy of the precedence that could drift from it.
 */
export function classifyTransaction(
    t: UnifiedTransaction,
    doc: TxDocInfo | undefined,
    options: {
        klassifizierung?: TxClassifyRules;
        doppelzahlungIds?: ReadonlySet<string>;
        override?: EuerManualOverride;
        erstattung?: EuerErstattung;
    } = {},
): TxClassified {
    const override = options.override;
    const erstattung = options.erstattung;
    let out: TxClassified;
    if (override) {
        out = {
            category: override.category,
            kind: SKR03_TO_EUER[override.category]?.kind ?? (t.amount > 0 ? 'income' : 'expense'),
            source: 'manual',
            rule: undefined, // an owner decision, not a rule
            matchedRule: { id: 'manuell', label: 'manuell', art: 'manuell' },
            note: override.note ?? undefined,
            decidedBy: override.decidedBy ?? undefined,
        };
    } else if (erstattung) {
        // The owner's „Ja" outranks the receipt: a credit with a receipt is never offered as a refund,
        // so a receipt that turns up later must not silently undo the link.
        out = {
            category: erstattung.category,
            kind: SKR03_TO_EUER[erstattung.category]?.kind ?? 'expense',
            source: 'rule',
            rule: 'Erstattung',
            matchedRule: {
                id: `erstattung:${erstattung.originalTxId}`,
                label: `Erstattung zu ${erstattung.originalLabel}`,
                art: 'erstattung',
            },
            vatRate: erstattung.vatRate,
        };
    } else if (doc) {
        out = {
            category: doc.category,
            kind: SKR03_TO_EUER[doc.category]?.kind ?? (t.amount > 0 ? 'income' : 'expense'),
            source: 'document',
            rule: 'Beleg',
            matchedRule: {
                id: doc.documentId != null ? `beleg:${doc.documentId}` : 'beleg',
                label: doc.documentId != null ? `Beleg #${doc.documentId}` : 'Beleg',
                art: 'beleg',
            },
        };
    } else {
        const cls = classifyNoDocTransaction(t, options.klassifizierung);
        out = {
            category: cls.category,
            kind: cls.kind,
            source: cls.source,
            rule: cls.rule,
            matchedRule: cls.matchedRule,
        };
    }
    // A confirmed double payment (same invoice paid twice) is a refund liability, not
    // revenue → neutralise it (out of income + USt). The refund itself may run through a
    // private account, so only the duplicate receipt is removed here. A MANUAL override takes
    // precedence over this config neutralisation (the owner's explicit decision wins).
    if (!override && !erstattung && options.doppelzahlungIds?.has(t.id)) {
        out = {
            category: DOPPELZAHLUNG_CATEGORY,
            kind: 'neutral',
            source: 'rule',
            rule: 'Doppelzahlung',
            matchedRule: { id: 'doppelzahlung', label: 'Doppelzahlung', art: 'doppelzahlung' },
        };
    }
    return out;
}

/** Net/VAT for a transaction, preferring the document, falling back to a rate split. */
function netVat(grossEur: number, doc: TxDocInfo | undefined): { net: number; vat: number } {
    if (doc) {
        if (doc.currency.toUpperCase() === 'EUR' && doc.netEur != null) {
            return { net: round2(doc.netEur), vat: round2(doc.vatEur ?? 0) };
        }
        if (doc.taxRate && doc.taxRate > 0) {
            const net = round2(grossEur / (1 + doc.taxRate));
            return { net, vat: round2(grossEur - net) };
        }
    }
    return { net: round2(grossEur), vat: 0 };
}

export interface EuerTxCoverage {
    transactions: number;
    classifiedByDocument: number;
    classifiedByRule: number;
    /** Bookings whose category came from a persisted MANUAL owner override (source='manual'). */
    classifiedByManual: number;
    unclassified: Array<{ id: string; bookingDate: string; amount: number; counterparty?: string; purpose?: string }>;
    /** The business-active window the EÜR was scoped to (= the year unless narrowed). */
    activeFrom: string;
    activeTo: string;
    /** Year transactions OUTSIDE the active window (after a Betriebsaufgabe / before start) —
     *  excluded from the laufende EÜR, surfaced as §24-nachträglich candidates for review.
     *  Full detail rows (like `detail`) + `included`, so the review UI can render + link them
     *  identically to the laufende list. `included`: true = kept as GbR §24, false = excluded. */
    outsidePeriod: Array<EuerTxDetailRow & { included: boolean }>;
}

/**
 * One reviewable row per transaction: the booking plus how it was classified
 * (category, kz, source, the rule that matched) and its signed net/VAT/gross
 * contribution. Read-only — nothing here is persisted. The same shape backs the
 * CLI `--detail` table, the `--json` output, and a future review UI/MCP tool.
 */
export interface EuerTxDetailRow {
    id: string;
    accountKey: string;
    bookingDate: string;
    counterparty?: string;
    purpose?: string;
    /** Signed original transaction amount in EUR (debit negative). */
    amount: number;
    kind: EuerKind;
    source: ClassSource;
    category: string;
    kz: string;
    /** Which rule/keyword matched (undefined when classified from a linked document). */
    rule?: string;
    /** The rule that classified the row — stable id, label, origin and the Auffangregel flag. */
    matchedRule?: MatchedRule;
    /**
     * For a MANUAL override, a linked Erstattung or a split: what the receipt or the rule chain would
     * give without that decision — the „dann wieder: …" of „Umbuchung zurücknehmen" / „Verknüpfung
     * lösen" / „Aufteilung aufheben".
     */
    ohneUmbuchung?: Pick<TxClassified, 'category' | 'source' | 'rule' | 'matchedRule'>;
    /** Paperless document id when the row was classified from a linked invoice (source='document'). */
    documentId?: number;
    /** Owner Begründung for a MANUAL override (source='manual') — surfaced in the Herleitung. */
    note?: string;
    /** Who decided a MANUAL override (source='manual'). */
    decidedBy?: string;
    /** The counterparty's IBAN, when the bank delivers one (SEPA; card payments have none). */
    counterpartyIban?: string;
    /** §13b for a receipt-classified expense: booked into the Kennziffern, or held back for review. */
    reverseCharge?: 'gebucht' | 'pruefen';
    /** Supplier country and USt-IdNr from the linked receipt, when it names them. */
    lieferantLand?: string;
    lieferantUstId?: string;
    /**
     * A split booking (Idee 13): the parts, each booked under its own category. The row itself then
     * names the main part's category ({@link hauptTeil}) and carries the parts' sum as net/VAT/gross —
     * anything that sums BY CATEGORY must read {@link beitragsZeilen} instead of the row.
     */
    aufteilung?: EuerTeilZeile[];
    /** Set by {@link beitragsZeilen}: the part of {@link aufteilung} this row stands for. */
    teilNr?: number;
    /** Signed contribution to the category (a refund nets negative). */
    net: number;
    vat: number;
    gross: number;
}

/**
 * The rows as contributions per category: a split booking becomes one row per part (same id, the
 * part's category, kind and amounts); every other row stays as it is. For BWA, Herleitung and checks
 * that look at categories.
 */
export function beitragsZeilen<T extends EuerTxDetailRow>(rows: readonly T[]): T[] {
    return rows.flatMap((r) =>
        r.aufteilung
            ? r.aufteilung.map((p) => ({
                  ...r,
                  category: p.category,
                  kz: p.kz,
                  kind: p.kind,
                  net: p.net,
                  vat: p.vat,
                  gross: p.gross,
                  teilNr: p.nr,
              }))
            : [r],
    );
}

/** The VAT rate a receipt states, for a part entered without one. */
function belegSatz(doc: TxDocInfo | undefined): number | undefined {
    if (!doc) return undefined;
    if (doc.taxRate != null) return doc.taxRate;
    if (doc.netEur == null || doc.vatEur == null || Math.abs(doc.netEur) < 0.005) return undefined;
    const rate = Math.abs(doc.vatEur / doc.netEur);
    return [0, 0.07, 0.19].find((r) => Math.abs(r - rate) < 0.005);
}

export interface EuerTxAggregate {
    year: number;
    basis: 'cash-transactions';
    /**
     * Whether the non-cash year-end adjustments (AfA, Privatanteile, §24-nachträglich) were folded
     * in — i.e. an ELSTER config was supplied. When false the aggregate is a RAW cash view whose
     * profit is NOT the final EÜR profit (missing AfA etc.); surfaces label it "vorläufig".
     */
    adjustmentsApplied: boolean;
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
        /** Net §24-nachträglich result (income − expense); part of profit but GewSt-free. */
        nachtraeglichNet: number;
    };
    coverage: EuerTxCoverage;
    /** Per-transaction review rows — only when requested via `{ detail: true }`. */
    detail?: EuerTxDetailRow[];
    /**
     * §13b reverse charge summed from the period's foreign expense invoices (Kz 46/47/84/85/67).
     * Zahllastneutral, but declared in the USt-Jahreserklärung. Empty when there is no §13b.
     */
    reverseCharge?: ReverseChargeTotals;
    /** Foreign expenses that look like §13b but couldn't be booked cleanly (for a human check). */
    reverseChargeReview?: Array<{ id: string; label: string | null; reason: string }>;
}

/** Bucket label + kz for a category (from the SKR03 map, else a passthrough). */
function bucketFor(category: string, kind: EuerKind): { bucket: string; kz: string; kind: EuerKind } {
    const b = SKR03_TO_EUER[category];
    if (b) return { bucket: b.bucket, kz: b.kz, kind: b.kind };
    return { bucket: category, kz: '', kind };
}

/** SKR03 categories used by the year-end adjustment injection. */
const AFA_CATEGORY = '4830 Abschreibungen (AfA)';
/** Exported: the UStE puts this on its own Vordruckzeile (§3 Abs. 9a), apart from plain revenue. */
export const PRIVATANTEIL_CATEGORY = '8924 Unentgeltliche Wertabgaben (Privatanteil)';
const NACHTRAEGLICH_EINNAHME_CATEGORY = '8410 Nachträgliche Betriebseinnahme (§24)';
const NACHTRAEGLICH_AUSGABE_CATEGORY = '4655 Nachträgliche Betriebsausgabe (§24)';
/** A customer's mistaken double payment: a refund liability, not revenue → neutral. */
const DOPPELZAHLUNG_CATEGORY = '1590 Doppelzahlung (durchlaufend)';

/**
 * Direction sign for a category contribution: +1 for a normal income credit / expense
 * debit; −1 for a refund / credit-note (a negative income or a positive expense) so it
 * REDUCES its category instead of inflating it; +1 for neutral.
 */
function computeTransactionSign(kind: EuerKind, amount: number): 1 | -1 {
    if (kind === 'income') return amount >= 0 ? 1 : -1;
    if (kind === 'expense') return amount < 0 ? 1 : -1;
    return 1;
}

/** A synthetic year-end adjustment detail row (AfA / Privatanteil / §24) — uniform shape. */
function syntheticDetailRow(
    year: number,
    o: {
        id: string;
        purpose: string;
        amount: number;
        kind: EuerKind;
        category: string;
        rule: string;
        net: number;
        vat: number;
    },
): EuerTxDetailRow {
    return {
        id: o.id,
        accountKey: 'adjustment',
        bookingDate: `${year}-12-31`,
        counterparty: 'Jahresabschluss',
        purpose: o.purpose,
        amount: o.amount,
        kind: o.kind,
        source: 'rule',
        category: o.category,
        kz: bucketFor(o.category, o.kind).kz,
        rule: o.rule,
        net: round2(o.net),
        vat: round2(o.vat),
        gross: round2(o.net + o.vat),
    };
}

/**
 * Non-cash year-end adjustments folded into the EÜR after the transaction loop —
 * neither has a bank transaction, so the tx-driven aggregate cannot derive them:
 *  - `afa`: total depreciation (a Betriebsausgabe), from the Anlageverzeichnis.
 *  - `privatanteile`: deemed income (unentgeltliche Wertabgabe), net + its output VAT.
 */
export interface EuerAdjustments {
    afa?: number;
    /** Number of depreciated assets, for the report's category count (cosmetic). */
    afaCount?: number;
    privatanteile?: Array<{ bezeichnung: string; net: number; vat: number }>;
    /** Nachträgliche §24 Betriebseinnahmen/-ausgaben (cash flows after the Aufgabe). */
    nachtraeglich?: Array<{ bezeichnung: string; net: number; vat: number; art: 'einnahme' | 'ausgabe' }>;
}

/** Upsert a synthetic (non-transaction) category total into the aggregation map. */
/**
 * The key a category total is collected under. A category name alone is not enough: an unclassified
 * debit and an unclassified credit are both '(unklassifiziert)', and under the name alone the debit
 * landed in the income total — its Vorsteuer counted as vereinnahmte USt, its net as revenue.
 */
function kategorieSchluessel(kind: EuerKind, category: string): string {
    return `${kind}\u0000${category}`;
}

function addSyntheticCategory(
    byCategory: Map<string, EuerCategoryTotal>,
    category: string,
    kind: EuerKind,
    net: number,
    vat: number,
    count: number,
): void {
    const meta = bucketFor(category, kind);
    const acc = byCategory.get(kategorieSchluessel(kind, category)) ?? {
        category,
        bucket: meta.bucket,
        kz: meta.kz,
        kind,
        count: 0,
        net: 0,
        vat: 0,
        gross: 0,
    };
    acc.count += count;
    acc.net = round2(acc.net + net);
    acc.vat = round2(acc.vat + vat);
    acc.gross = round2(acc.gross + net + vat);
    byCategory.set(kategorieSchluessel(kind, category), acc);
}

/**
 * Aggregate an EÜR from transactions. `docByTxId` maps a store transaction id to
 * the info from its linked invoice document (built by the action layer).
 */
export function aggregateEuerByTransactions(
    txs: UnifiedTransaction[],
    docByTxId: Map<string, TxDocInfo>,
    year: number,
    options: {
        detail?: boolean;
        adjustments?: EuerAdjustments;
        activeFrom?: string;
        activeTo?: string;
        /** Substrings: post-Aufgabe EXPENSES whose counterparty/purpose match stay GbR §24;
         *  all other post-Aufgabe expenses belong to the successor and are excluded. */
        nachtraeglichGbrAusgaben?: string[];
        /**
         * The user's own counterparty needles (`elster.klassifizierung`) for the no-document rule
         * chain: own accounts, private merchants, owner names, customers, supplier rules. OPTIONAL —
         * without them the chain runs on its generic signals only.
         */
        klassifizierung?: TxClassifyRules;
        /** Transaction ids of confirmed double payments → neutralised (out of income + USt). */
        doppelzahlungIds?: Set<string>;
        /**
         * Persisted MANUAL owner overrides, keyed by the unified transaction id. A matching tx is
         * booked under the override's category with `source='manual'` — winning over the linked
         * document AND the rule chain. OPTIONAL and INERT: when omitted/empty, or when no tx id
         * matches, the aggregate is byte-identical to the pre-override behaviour.
         */
        overrides?: Map<string, EuerManualOverride>;
        /**
         * Linked refunds (Idee 9), keyed by the refund's tx id: booked under the original's category
         * and VAT rate. Inert when omitted, like `overrides`.
         */
        erstattungen?: ReadonlyMap<string, EuerErstattung>;
        /**
         * Split bookings (Idee 13), keyed by tx id: the stored parts, the remainder part without an
         * amount. Each part is booked under its own category; a split wins over every other decision.
         * Inert when omitted. A stored split that no longer fits the booking is ignored (the booking
         * books as if unsplit) rather than breaking the report.
         */
        aufteilungen?: ReadonlyMap<string, readonly TeilEingabe[]>;
    } = {},
): EuerTxAggregate {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    // The business-active window inside the year — defaults to the whole year, but a
    // Betriebsaufgabe (or a mid-year start) narrows it. Transactions in the year but
    // OUTSIDE this window are not part of the laufende EÜR; they are surfaced under
    // coverage.outsidePeriod (e.g. as §24-nachträglich candidates) for review.
    const activeFrom = options.activeFrom && options.activeFrom > from ? options.activeFrom : from;
    const activeTo = options.activeTo && options.activeTo < to ? options.activeTo : to;
    const byCategory = new Map<string, EuerCategoryTotal>();
    const reverseCharge = emptyReverseChargeTotals();
    const reverseChargeReview: Array<{ id: string; label: string | null; reason: string }> = [];
    const detail: EuerTxDetailRow[] | undefined = options.detail ? [] : undefined;
    const coverage: EuerTxCoverage = {
        transactions: 0,
        classifiedByDocument: 0,
        classifiedByRule: 0,
        classifiedByManual: 0,
        unclassified: [],
        activeFrom,
        activeTo,
        outsidePeriod: [],
    };

    /**
     * Book a split booking: each part into its own category (a private part as neutral money without
     * Vorsteuer), one detail row naming the main part. `cls` is what applies without the split.
     */
    const bookSplit = (t: UnifiedTransaction, teile: Teil[], cls: TxClassified, doc: TxDocInfo | undefined) => {
        const zeilen: EuerTeilZeile[] = teile.map((p) => {
            const meta = bucketFor(p.category, p.kind);
            const sign = computeTransactionSign(p.kind, t.amount);
            const zaehlt = p.kind !== 'neutral' || NEUTRAL_MIT_VORSTEUER.has(p.category);
            const net = zaehlt ? p.net : 0;
            const vat = zaehlt ? p.vat : 0;
            const acc = byCategory.get(kategorieSchluessel(p.kind, p.category)) ?? {
                category: p.category,
                bucket: meta.bucket,
                kz: meta.kz,
                kind: p.kind,
                count: 0,
                net: 0,
                vat: 0,
                gross: 0,
            };
            acc.count += 1;
            acc.net = round2(acc.net + sign * net);
            acc.vat = round2(acc.vat + sign * vat);
            acc.gross = round2(acc.gross + sign * p.betrag);
            byCategory.set(kategorieSchluessel(p.kind, p.category), acc);
            return {
                nr: p.nr,
                betrag: p.betrag,
                vatRate: p.vatRate,
                rest: p.rest,
                betrieblich: p.betrieblich,
                ...(p.note ? { note: p.note } : {}),
                category: p.category,
                kz: meta.kz,
                kind: p.kind,
                net: round2(sign * net),
                vat: round2(sign * vat),
                gross: round2(sign * p.betrag),
            };
        });
        coverage.transactions += 1;
        coverage.classifiedByManual += 1;
        const haupt = zeilen[teile.indexOf(hauptTeil(teile))];
        detail?.push({
            id: t.id,
            accountKey: t.accountKey,
            bookingDate: t.bookingDate,
            counterparty: t.counterparty,
            purpose: t.purpose,
            amount: t.amount,
            kind: haupt.kind,
            source: 'manual',
            category: haupt.category,
            kz: haupt.kz,
            rule: 'Aufteilung',
            matchedRule: { id: 'aufteilung', label: aufteilungTitel(teile.length), art: 'aufteilung' },
            ohneUmbuchung: { category: cls.category, source: cls.source, rule: cls.rule, matchedRule: cls.matchedRule },
            documentId: doc?.documentId,
            ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
            ...(doc?.supplierCountry ? { lieferantLand: doc.supplierCountry } : {}),
            ...(doc?.supplierVatId ? { lieferantUstId: doc.supplierVatId } : {}),
            aufteilung: zeilen,
            net: round2(zeilen.reduce((s, z) => s + z.net, 0)),
            vat: round2(zeilen.reduce((s, z) => s + z.vat, 0)),
            gross: round2(zeilen.reduce((s, z) => s + z.gross, 0)),
        });
    };

    for (const t of txs) {
        if (t.bookingDate < from || t.bookingDate > to) continue;
        const gross = round2(Math.abs(t.amount));

        const doc = docByTxId.get(t.id);
        // A persisted MANUAL owner override (S2) is consulted FIRST and wins over both the linked
        // document and the rule chain. It is OPTIONAL + INERT: when absent (no map, or no match for
        // this tx id), the classification falls through to the exact pre-override document/rule
        // logic — so an aggregate built without overrides is byte-identical to before.
        const override = options.overrides?.get(t.id);
        const erstattung = options.erstattungen?.get(t.id);
        const classifyOptions = {
            klassifizierung: options.klassifizierung,
            doppelzahlungIds: options.doppelzahlungIds,
        };
        const cls = classifyTransaction(t, doc, { ...classifyOptions, override, erstattung });
        const { category, kind, source, rule, matchedRule } = cls;
        const overrideNote = cls.note;
        const overrideDecidedBy = cls.decidedBy;
        let ohneUmbuchung: EuerTxDetailRow['ohneUmbuchung'];
        if (override || erstattung) {
            // Taking back an Umbuchung falls back to the Erstattung, if any; undoing the Erstattung to
            // the receipt or the rule chain.
            const without = classifyTransaction(t, doc, {
                ...classifyOptions,
                erstattung: override ? erstattung : undefined,
            });
            ohneUmbuchung = {
                category: without.category,
                source: without.source,
                rule: without.rule,
                matchedRule: without.matchedRule,
            };
        }

        const inWindow = t.bookingDate >= activeFrom && t.bookingDate <= activeTo;
        const aufteilung = inWindow ? options.aufteilungen?.get(t.id) : undefined;
        if (aufteilung) {
            let teile: Teil[] | undefined;
            try {
                teile = berechneTeile(t.amount, aufteilung, { belegSatz: belegSatz(doc) });
            } catch {
                teile = undefined;
            }
            if (teile) {
                bookSplit(t, teile, cls, doc);
                continue;
            }
        }

        let net: number;
        let vat: number;
        if (kind === 'neutral' && !NEUTRAL_MIT_VORSTEUER.has(category)) {
            net = 0;
            vat = 0;
        } else if (doc && source === 'document') {
            // Net/VAT come from the document only when the tx was actually classified FROM it — a
            // manual reclassification detaches the doc's net/VAT and re-derives from the category.
            ({ net, vat } = netVat(gross, doc));
        } else if (cls.vatRate != null) {
            // A linked refund splits by the original's rate, so it takes back exactly that Vorsteuer.
            net = cls.vatRate > 0 ? round2(gross / (1 + cls.vatRate)) : gross;
            vat = round2(gross - net);
        } else {
            // No document (or a manual override): split the gross by the category's implied VAT rate.
            const rate = impliedRate(category, kind);
            net = rate > 0 ? round2(gross / (1 + rate)) : gross;
            vat = round2(gross - net);
        }
        // Direction sign: a normal expense is a debit, normal income a credit. A
        // refund/credit-note flips the sign (expense credit / income debit) so it
        // REDUCES its category instead of inflating it (e.g. a returned GWG nets 0).
        const sign = computeTransactionSign(kind, t.amount);

        // Outside the business-active window (after a Betriebsaufgabe): post-cutoff INCOME is
        // the GbR's §24 (a late payment on a GbR invoice — still a current-year receipt under
        // cash basis, gewerbesteuerfrei). Post-cutoff EXPENSES belong to the successor
        // (Einzelunternehmen) and are EXCLUDED, unless their counterparty matches a configured
        // GbR wind-down (then §24 too). Neutral post-cutoff flows are dropped. §24 items are
        // folded into the §24 totals but kept OFF the laufende list (shown via outsidePeriod).
        if (t.bookingDate < activeFrom || t.bookingDate > activeTo) {
            const hay = `${t.counterparty ?? ''} ${t.purpose ?? ''}`.toLowerCase();
            const isGbrExpense =
                kind === 'expense' &&
                (options.nachtraeglichGbrAusgaben ?? []).some((k) => hay.includes(k.toLowerCase()));
            const eff24 =
                kind === 'income'
                    ? NACHTRAEGLICH_EINNAHME_CATEGORY
                    : isGbrExpense
                      ? NACHTRAEGLICH_AUSGABE_CATEGORY
                      : null;
            if (eff24) addSyntheticCategory(byCategory, eff24, kind, round2(sign * net), round2(sign * vat), 1);
            const cat24 = eff24 ?? category;
            const meta24 = bucketFor(cat24, kind);
            coverage.outsidePeriod.push({
                id: t.id,
                accountKey: t.accountKey,
                bookingDate: t.bookingDate,
                counterparty: t.counterparty,
                purpose: t.purpose,
                amount: t.amount,
                kind,
                source,
                category: cat24,
                kz: meta24.kz,
                rule,
                matchedRule,
                ohneUmbuchung,
                documentId: doc?.documentId,
                note: overrideNote,
                decidedBy: overrideDecidedBy,
                net: round2(sign * net),
                vat: round2(sign * vat),
                gross: round2(sign * gross),
                included: eff24 != null,
            });
            continue;
        }
        // In the active period → count it and fold it into the EÜR.
        coverage.transactions += 1;
        if (source === 'document') coverage.classifiedByDocument += 1;
        else if (source === 'manual') coverage.classifiedByManual += 1;
        else if (source === 'rule') coverage.classifiedByRule += 1;
        else
            coverage.unclassified.push({
                id: t.id,
                bookingDate: t.bookingDate,
                amount: t.amount,
                counterparty: t.counterparty,
                purpose: t.purpose,
            });
        const meta = bucketFor(category, kind);
        const acc = byCategory.get(kategorieSchluessel(kind, category)) ?? {
            category,
            bucket: meta.bucket,
            kz: meta.kz,
            kind,
            count: 0,
            net: 0,
            vat: 0,
            gross: 0,
        };
        acc.count += 1;
        acc.net = round2(acc.net + sign * net);
        acc.vat = round2(acc.vat + sign * vat);
        acc.gross = round2(acc.gross + sign * gross);
        byCategory.set(kategorieSchluessel(kind, category), acc);

        // §13b: a foreign reverse-charge input invoice owes German VAT (also deductible). Classify
        // from the linked doc + accumulate, sign-scaled so a credit note reduces the base.
        let rcStatus: EuerTxDetailRow['reverseCharge'];
        if (kind === 'expense' && source === 'document' && doc) {
            const r = classifyReverseCharge({
                reverseCharge: doc.reverseCharge,
                supplierCountry: doc.supplierCountry,
                saleType: doc.saleType,
                net,
            });
            if (r.item) {
                addReverseChargeItem(reverseCharge, {
                    kind: r.item.kind,
                    base: round2(sign * r.item.base),
                    tax: round2(sign * r.item.tax),
                });
                rcStatus = 'gebucht';
            } else if (r.review) {
                reverseChargeReview.push({ id: t.id, label: t.counterparty ?? t.purpose ?? null, reason: r.review });
                rcStatus = 'pruefen';
            }
        }

        detail?.push({
            id: t.id,
            accountKey: t.accountKey,
            bookingDate: t.bookingDate,
            counterparty: t.counterparty,
            purpose: t.purpose,
            amount: t.amount,
            kind,
            source,
            category,
            kz: meta.kz,
            rule,
            matchedRule,
            ohneUmbuchung,
            documentId: doc?.documentId,
            note: overrideNote,
            decidedBy: overrideDecidedBy,
            ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
            ...(rcStatus ? { reverseCharge: rcStatus } : {}),
            ...(doc?.supplierCountry ? { lieferantLand: doc.supplierCountry } : {}),
            ...(doc?.supplierVatId ? { lieferantUstId: doc.supplierVatId } : {}),
            net: round2(sign * net),
            vat: round2(sign * vat),
            gross: round2(sign * gross),
        });
    }

    // Fold in the non-cash year-end adjustments (AfA expense + Privatanteil deemed
    // income). They carry no bank transaction, so they are added directly to the
    // category totals here; coverage (the "every booking explained" count) is untouched.
    const adj = options.adjustments;
    if (adj?.afa && adj.afa > 0.005) {
        addSyntheticCategory(byCategory, AFA_CATEGORY, 'expense', adj.afa, 0, adj.afaCount ?? 1);
        detail?.push(
            syntheticDetailRow(year, {
                id: `adjustment:afa:${year}`,
                purpose: 'AfA (Anlageverzeichnis)',
                amount: -adj.afa,
                kind: 'expense',
                category: AFA_CATEGORY,
                rule: 'AfA (Anlageverzeichnis)',
                net: adj.afa,
                vat: 0,
            }),
        );
    }
    for (const p of adj?.privatanteile ?? []) {
        if (Math.abs(p.net) < 0.005 && Math.abs(p.vat) < 0.005) continue;
        addSyntheticCategory(byCategory, PRIVATANTEIL_CATEGORY, 'income', p.net, p.vat, 1);
        detail?.push(
            syntheticDetailRow(year, {
                id: `adjustment:privatanteil:${year}:${p.bezeichnung}`,
                purpose: `Unentgeltliche Wertabgabe: ${p.bezeichnung}`,
                amount: round2(p.net + p.vat),
                kind: 'income',
                category: PRIVATANTEIL_CATEGORY,
                rule: `Privatanteil ${p.bezeichnung} (unentgeltl. Wertabgabe)`,
                net: p.net,
                vat: p.vat,
            }),
        );
    }
    for (const n of adj?.nachtraeglich ?? []) {
        if (Math.abs(n.net) < 0.005 && Math.abs(n.vat) < 0.005) continue;
        const isIncome = n.art === 'einnahme';
        const category = isIncome ? NACHTRAEGLICH_EINNAHME_CATEGORY : NACHTRAEGLICH_AUSGABE_CATEGORY;
        const kind: EuerKind = isIncome ? 'income' : 'expense';
        addSyntheticCategory(byCategory, category, kind, n.net, n.vat, 1);
        detail?.push(
            syntheticDetailRow(year, {
                id: `adjustment:nachtraeglich:${year}:${n.bezeichnung}`,
                purpose: `Nachträglich (§24): ${n.bezeichnung}`,
                amount: round2((isIncome ? 1 : -1) * (n.net + n.vat)),
                kind,
                category,
                rule: `Nachträgliche ${isIncome ? 'Betriebseinnahme' : 'Betriebsausgabe'} §24 (${n.bezeichnung})`,
                net: n.net,
                vat: n.vat,
            }),
        );
    }

    const all = [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category));
    const income = all.filter((c) => c.kind === 'income');
    const expenses = all.filter((c) => c.kind === 'expense');
    const neutral = all.filter((c) => c.kind === 'neutral');
    const incomeNet = round2(income.reduce((s, c) => s + c.net, 0));
    const outputVat = round2(income.reduce((s, c) => s + c.vat, 0));
    const expenseNet = round2(expenses.reduce((s, c) => s + c.net, 0));
    // Vorsteuer: the expenses' plus that of a non-deductible Bewirtung (neutral, VAT still deductible).
    const inputVat = round2(
        expenses.reduce((s, c) => s + c.vat, 0) +
            neutral.filter((c) => NEUTRAL_MIT_VORSTEUER.has(c.category)).reduce((s, c) => s + c.vat, 0),
    );
    // Net §24-nachträglich result (income − expense) — part of the EÜR profit but
    // gewerbesteuerfrei, so the GewSt base subtracts it. Covers both the auto-classified
    // post-Aufgabe bookings and the config nachtraegliche_posten (same §24 categories).
    const nachtraeglichNet = round2(
        income.filter((c) => c.category === NACHTRAEGLICH_EINNAHME_CATEGORY).reduce((s, c) => s + c.net, 0) -
            expenses.filter((c) => c.category === NACHTRAEGLICH_AUSGABE_CATEGORY).reduce((s, c) => s + c.net, 0),
    );

    return {
        year,
        basis: 'cash-transactions',
        adjustmentsApplied: options.adjustments != null,
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
            nachtraeglichNet,
        },
        coverage,
        detail,
        reverseCharge,
        reverseChargeReview,
    };
}
