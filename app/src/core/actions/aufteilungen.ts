/**
 * Splitbuchungen (Idee 13) — the ledger side: read the stored parts, write and remove a split, and turn
 * the splits into what the EÜR aggregate and the USt-VA consume.
 *
 * Like the Erstattungen (actions/erstattungen.ts) the split lives in the ledger (`booking_splits`,
 * audit-logged as `aufteilung.*`), not in the manifest: it is a per-booking decision keyed by the
 * unified tx id that changes EÜR figures, and the bank transaction itself stays untouched.
 */

import {
    getBookingSplits,
    type LedgerDatabase,
    ledgerDbExists,
    ledgerDbPath,
    migrate,
    openLedger,
    removeBookingSplit,
    saveBookingSplit,
    searchAccountKeys,
    type SplitPartRecord,
    transactionsSummary,
} from '@steuererklaerung/store';
import { defaultAccountScope, loadManifest, type ElsterConfig } from '../config/index.ts';
import {
    abgabeWarnung,
    berechneTeile,
    betroffeneAbgaben,
    vorsteuerPrivat,
    type Abgabe,
    type AbgabeKonflikt,
    type Teil,
    type TeilEingabe,
} from '../elster/splitbuchung.ts';
import type { VorsteuerKorrektur } from '../elster/ustva-aggregate.ts';
import { vergissProjektTeile } from './projekt-zuordnung.ts';

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

/** Stored parts touching the given tx ids (or all). READ-ONLY: no ledger yet means no splits. */
export function loadAufteilungTeile(transactionIds?: readonly string[]): SplitPartRecord[] {
    try {
        if (!ledgerDbExists()) return [];
        return withLedger((db) => getBookingSplits(db, transactionIds));
    } catch {
        return [];
    }
}

function toEingabe(p: SplitPartRecord): TeilEingabe {
    return {
        category: p.category,
        betrag: p.amountCents == null ? null : p.amountCents / 100,
        vatRate: p.vatRate,
        rest: p.amountCents == null,
        note: p.note,
    };
}

/** The splits the EÜR aggregate books, keyed by tx id. */
export function loadAufteilungen(transactionIds?: readonly string[]): Map<string, TeilEingabe[]> {
    const out = new Map<string, TeilEingabe[]>();
    for (const p of loadAufteilungTeile(transactionIds)) {
        const list = out.get(p.txId) ?? [];
        list.push(toEingabe(p));
        out.set(p.txId, list);
    }
    return out;
}

/** Store computed parts (validated by `berechneTeile`); the remainder part keeps no amount. */
export function saveAufteilung(txId: string, teile: readonly Teil[], decidedBy?: string | null): SplitPartRecord[] {
    return withLedger((db) =>
        saveBookingSplit(
            db,
            txId,
            teile.map((t) => ({
                category: t.category,
                amountCents: t.rest ? null : Math.round(t.betrag * 100),
                vatRate: t.vatRate,
                note: t.note ?? null,
            })),
            nowIso(),
            decidedBy,
        ),
    );
}

/** „Aufteilung aufheben": true if there was a split. */
export function removeAufteilung(txId: string, decidedBy?: string | null): boolean {
    const removed = withLedger((db) => removeBookingSplit(db, txId, nowIso(), decidedBy));
    // The projects of the parts (Idee 14) refer to parts that no longer exist.
    if (removed) vergissProjektTeile(txId, decidedBy);
    return removed;
}

/** A write that needs the owner's confirmation because the period is filed — nothing was written. */
export interface AbgabeBestaetigung {
    ok: false;
    bestaetigungNoetig: true;
    warnung: string;
    abgaben: AbgabeKonflikt[];
}

/**
 * The filed-period guard around both writes: when a return covering `datum` is filed (register
 * entries with a filing date, see `betroffeneAbgaben`), nothing is written unless `trotzAbgabe` is set,
 * and the result carries the warning. The register itself is never touched.
 */
export function schreibeAufteilung(
    txId: string,
    datum: string,
    teile: readonly Teil[] | null,
    opts: { abgaben: readonly Abgabe[]; trotzAbgabe?: boolean; decidedBy?: string | null },
): { ok: true; gespeichert: boolean } | AbgabeBestaetigung {
    const konflikte = betroffeneAbgaben(datum, opts.abgaben);
    const aufheben = teile == null;
    if (konflikte.length > 0 && !opts.trotzAbgabe) {
        if (!aufheben || loadAufteilungTeile([txId]).length > 0) {
            return {
                ok: false,
                bestaetigungNoetig: true,
                warnung: abgabeWarnung(konflikte, aufheben),
                abgaben: konflikte,
            };
        }
    }
    if (aufheben) return { ok: true, gespeichert: removeAufteilung(txId, opts.decidedBy) };
    saveAufteilung(txId, teile, opts.decidedBy);
    return { ok: true, gespeichert: true };
}

/**
 * The private VAT of every split booking on the entity's accounts (§ 15 Abs. 1 Satz 1 Nr. 1 UStG) — the
 * receipt-driven USt-VA takes it off where the receipt linked to that booking counts. Bookings of any
 * date: the receipt decides the period, not the booking.
 */
export function aufteilungKorrekturen(elster: ElsterConfig): VorsteuerKorrektur[] {
    const splits = loadAufteilungen();
    if (splits.size === 0) return [];
    const accountKeys = defaultAccountScope(
        loadManifest(),
        transactionsSummary().accounts.map((a) => a.accountKey),
        elster,
    );
    if (accountKeys.length === 0) return [];
    const out: VorsteuerKorrektur[] = [];
    for (const t of searchAccountKeys(accountKeys, {})) {
        const eingaben = splits.get(t.id);
        if (!eingaben || t.amount >= 0) continue;
        let vat: number;
        try {
            vat = vorsteuerPrivat(berechneTeile(t.amount, eingaben));
        } catch {
            continue;
        }
        if (vat > 0) out.push({ art: 'aufteilung', refundTxId: t.id, date: t.bookingDate, vat });
    }
    return out;
}
