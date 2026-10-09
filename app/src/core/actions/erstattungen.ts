/**
 * Erstattungen (Idee 9) — the ledger side: read the stored links and rejections, write „Ja", „Nein"
 * and „Verknüpfung lösen", and turn the links into what the EÜR aggregate and the USt-VA consume.
 *
 * The decisions live in the ledger next to the Umbuchungen (`refund_links`, audit-logged), not in the
 * manifest: they are per-booking bookkeeping decisions keyed by the unified tx id, exactly like a
 * manual classification, and they change EÜR figures. Store-scoped like actions/classifications.ts.
 */

import {
    type LedgerDatabase,
    type RefundLinkRecord,
    type UnifiedTransaction,
    getRefundLinks,
    ledgerDbExists,
    ledgerDbPath,
    linkRefund,
    migrate,
    openLedger,
    rejectRefundCandidate,
    removeRefundLink,
    searchAccountKeys,
    transactionsSummary,
} from '@steuererklaerung/store';
import { round2 } from '../lib/money.ts';
import { defaultAccountScope, getPeriodDateRange, loadManifest, type ElsterConfig } from '../config/index.ts';
import type { EuerErstattung } from '../elster/euer-transactions.ts';
import type { VorsteuerKorrektur } from '../elster/ustva-aggregate.ts';
import { ursprungLabel } from '../elster/erstattung.ts';
import { aufteilungKorrekturen } from './aufteilungen.ts';

function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

const nowIso = () => new Date().toISOString();

/**
 * Stored links and rejections touching the given tx ids (or all). READ-ONLY like
 * `loadManualOverrides`: no ledger yet means no decisions, and nothing is created.
 */
export function loadErstattungLinks(transactionIds?: readonly string[]): RefundLinkRecord[] {
    try {
        if (!ledgerDbExists()) return [];
        return withLedger((db) => getRefundLinks(db, transactionIds));
    } catch {
        return [];
    }
}

/**
 * The links the EÜR aggregate books, keyed by refund tx id. `lookup` resolves an original (it may lie
 * in an earlier year than the refund) for the „via Erstattung zu …" label.
 */
export function loadEuerErstattungen(
    refundTxIds: readonly string[],
    lookup: (id: string) => Pick<UnifiedTransaction, 'bookingDate' | 'counterparty'> | undefined,
): Map<string, EuerErstattung> {
    const wanted = new Set(refundTxIds);
    const out = new Map<string, EuerErstattung>();
    for (const l of loadErstattungLinks(refundTxIds)) {
        if (l.status !== 'linked' || !wanted.has(l.refundTxId) || l.category == null) continue;
        const o = lookup(l.originalTxId);
        out.set(l.refundTxId, {
            originalTxId: l.originalTxId,
            category: l.category,
            vatRate: l.vatRate ?? 0,
            originalLabel: o ? ursprungLabel(o) : `Buchung ${l.originalTxId}`,
        });
    }
    return out;
}

export function saveErstattungLink(input: {
    refundTxId: string;
    originalTxId: string;
    category: string;
    vatRate: number;
    originalDocumentId?: number | null;
    decidedBy?: string | null;
}): RefundLinkRecord {
    return withLedger((db) => linkRefund(db, input, nowIso()));
}

export function saveErstattungAbgelehnt(refundTxId: string, originalTxId: string, decidedBy?: string | null): void {
    withLedger((db) => rejectRefundCandidate(db, refundTxId, originalTxId, nowIso(), decidedBy));
}

/** „Verknüpfung lösen": true if a link was removed. */
export function removeErstattungLink(refundTxId: string): boolean {
    return withLedger((db) => removeRefundLink(db, refundTxId, nowIso()));
}

/**
 * The Vorsteuer corrections (§ 17 Abs. 1 Satz 2 UStG) the receipt-driven USt-VA must subtract in the
 * refund's period: linked refunds on the entity's accounts whose original had its Vorsteuer from a
 * receipt. A refund of a debit WITHOUT receipt takes nothing back there, because that USt-VA never
 * claimed Vorsteuer for it in the first place (the EÜR, which does, books the refund itself).
 */
export function loadVorsteuerKorrekturen(elster: ElsterConfig, from: string, to: string): VorsteuerKorrektur[] {
    const links = loadErstattungLinks().filter((l) => l.status === 'linked' && l.originalDocumentId != null);
    if (links.length === 0) return [];
    const accountKeys = defaultAccountScope(
        loadManifest(),
        transactionsSummary().accounts.map((a) => a.accountKey),
        elster,
    );
    if (accountKeys.length === 0) return [];
    const byId = new Map(searchAccountKeys(accountKeys, { from, to }).map((t) => [t.id, t]));
    const out: VorsteuerKorrektur[] = [];
    for (const l of links) {
        const t = byId.get(l.refundTxId);
        const rate = l.vatRate ?? 0;
        if (!t || t.amount <= 0 || rate <= 0) continue;
        const gross = round2(t.amount);
        out.push({
            refundTxId: t.id,
            originalDocumentId: l.originalDocumentId ?? undefined,
            date: t.bookingDate,
            vat: round2(gross - round2(gross / (1 + rate))),
        });
    }
    return out;
}

/**
 * {@link loadVorsteuerKorrekturen} for the config's own USt-VA period, plus the private Vorsteuer of
 * split bookings (Idee 13), which the USt-VA matches to its receipts itself.
 */
export function vorsteuerKorrekturenDerPeriode(elster: ElsterConfig): VorsteuerKorrektur[] {
    const { dateFrom, dateTo } = getPeriodDateRange(elster.period);
    return [...loadVorsteuerKorrekturen(elster, dateFrom, dateTo), ...aufteilungKorrekturen(elster)];
}

/** {@link vorsteuerKorrekturenDerPeriode} for a whole year (the four quarters of `aggregateUstvaYear`). */
export function vorsteuerKorrekturenDesJahres(elster: ElsterConfig, year: number): VorsteuerKorrektur[] {
    return [...loadVorsteuerKorrekturen(elster, `${year}-01-01`, `${year}-12-31`), ...aufteilungKorrekturen(elster)];
}
