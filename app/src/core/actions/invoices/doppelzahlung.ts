/**
 * Doppelzahlung actions — surface credits that look like a customer paid an invoice twice (or too
 * much), record the owner's decision, and track the refund until the debit is linked. Detection is
 * the pure {@link detectDoppelzahlungen}; this layer loads invoices + credits + earlier decisions,
 * writes the decision to `adjustments` and reuses mark-paid for "this pays another invoice".
 * Shared by CLI, MCP and the UIs.
 */

import { searchAccountKeys, type UnifiedTransaction } from '@steuererklaerung/store';
import {
    resolveEntityElster,
    saveDoppelzahlung,
    saveDoppelzahlungRueckzahlung,
    saveDoppelzahlungRueckzahlungExtern,
    saveZahlungGeprueft,
} from '../../config/index.ts';
import {
    type DoppelzahlungVerdacht,
    detectDoppelzahlungen,
    type DoppelzahlungCredit,
    type DoppelzahlungInvoice,
    istGanzZuViel,
} from '../../invoices/doppelzahlung.ts';
import { fmtDe } from '../../lib/money.ts';
import { buchungZeile, type HinweisDoppelzahlung } from '../../elster/hinweise.ts';
import { rankRueckzahlungKandidaten } from '../../invoices/doppelzahlung-text.ts';
import { referenceMatches } from '../../lib/transactions/reconcile.ts';
import { normalizeInvoiceStatus } from '../../invoices/status.ts';
import { entityAccountKeys } from '../invoice-payments.ts';
import { getOutgoingInvoice, listOutgoingInvoicesFor, markOutgoingInvoicePaid } from '../outgoing-invoices.ts';

/** One suspicion with the facts a person needs to decide (dates + amounts of the suspicious credits). */
export interface DoppelzahlungVerdachtDetail extends DoppelzahlungVerdacht {
    txs: { id: string; bookingDate: string; amount: number; counterparty: string }[];
}

export interface DoppelzahlungOptions {
    path?: string;
    /** Only suspicions with at least one suspicious credit booked in this year. */
    year?: number;
}

/** A recorded double payment whose refund debit is not linked yet. */
export interface OffeneRueckzahlung {
    txId: string;
    rechnungId?: string;
    bezeichnung: string;
    /** The credit's booking date/amount when it is still in the store. */
    bookingDate?: string;
    amount?: number;
}

/**
 * Open (and paid) invoices of an entity as detector input. A paid invoice needs its detail for
 * `paidTxId`, a back-end call — so it is fetched only when some credit could relate to it: the
 * credit quotes its number or equals its gross. Every other paid invoice stays out of the detector's
 * reach anyway.
 */
async function loadInvoices(
    entityId: string,
    credits: DoppelzahlungCredit[],
    path?: string,
): Promise<DoppelzahlungInvoice[]> {
    const list = await listOutgoingInvoicesFor(entityId, { path });
    const out: DoppelzahlungInvoice[] = [];
    for (const inv of list) {
        const status = normalizeInvoiceStatus(inv.status);
        if ((status !== 'open' && status !== 'paid') || inv.total == null) continue;
        const gross = Math.abs(inv.total);
        let paidTxId: string | null = null;
        const relevant =
            status === 'paid' &&
            credits.some(
                (c) =>
                    Math.abs(Math.round(c.amount * 100) - Math.round(gross * 100)) <= 1 ||
                    referenceMatches(inv.number ?? undefined, c),
            );
        if (relevant) {
            try {
                paidTxId = (await getOutgoingInvoice(entityId, inv.id, path))?.paidTxId ?? null;
            } catch {
                paidTxId = null; // a back-end without detail view: treated as paid without a linked tx
            }
        }
        out.push({
            id: inv.id,
            number: inv.number,
            customer: inv.customerName,
            gross,
            issueDate: inv.issueDate,
            paidTxId,
            status: inv.status,
        });
    }
    return out;
}

function decidedTxIds(entityId: string, path?: string): Set<string> {
    const adj = resolveEntityElster(entityId, path)?.adjustments;
    return new Set([
        ...(adj?.doppelzahlungen ?? []).map((d) => d.transaktion_id),
        ...(adj?.zahlungen_geprueft ?? []).map((d) => d.transaktion_id),
    ]);
}

/** Suspected double / excess payments for one entity that no decision covers yet. */
export async function listDoppelzahlungVerdacht(
    entityId: string,
    opts: DoppelzahlungOptions = {},
): Promise<DoppelzahlungVerdachtDetail[]> {
    const txs = searchAccountKeys(entityAccountKeys(entityId, opts.path), {});
    const credits = txs
        .filter((t) => t.amount > 0)
        .map((t) => ({
            id: t.id,
            bookingDate: t.bookingDate,
            amount: t.amount,
            counterparty: t.counterparty,
            purpose: t.purpose,
            reference: t.reference,
        }));
    const invoices = await loadInvoices(entityId, credits, opts.path);
    const verdicts = detectDoppelzahlungen(invoices, credits, { ignoreTxIds: decidedTxIds(entityId, opts.path) });
    const byId = new Map(txs.map((t) => [t.id, t]));
    const detailed = verdicts.map((v) => ({
        ...v,
        txs: v.txIds.flatMap((id) => {
            const t = byId.get(id);
            return t ? [{ id, bookingDate: t.bookingDate, amount: t.amount, counterparty: t.counterparty ?? '' }] : [];
        }),
    }));
    if (opts.year == null) return detailed;
    const prefix = `${opts.year}-`;
    return detailed.filter((v) => v.txs.some((t) => t.bookingDate.startsWith(prefix)));
}

/**
 * The owner confirms: this credit is a double payment (a refund liability, neutralised in the EÜR).
 * The whole credit is neutralised, so pass `suspicion` (the current finding) to refuse a credit that
 * is only partly surplus — there is no split booking.
 */
export function markAlsDoppelzahlung(
    entityId: string,
    txId: string,
    opts: {
        rechnungId?: string;
        bezeichnung?: string;
        path?: string;
        suspicion?: { zuViel: number; txs: { id: string; amount: number }[] };
    } = {},
): void {
    const tx = opts.suspicion?.txs.find((t) => t.id === txId);
    if (opts.suspicion && tx && !istGanzZuViel(tx.amount, opts.suspicion.zuViel)) {
        throw new Error(
            `Nur ein Teil ist zu viel (${fmtDe(opts.suspicion.zuViel)} € von ${fmtDe(tx.amount)} €). ` +
                'Ohne Aufteilen der Buchung lässt sich das nicht automatisch neutralisieren. ' +
                'Rückzahlung an den Kunden trotzdem leisten und den Mehrbetrag von Hand berücksichtigen, oder „in Ordnung" wählen.',
        );
    }
    saveDoppelzahlung(
        entityId,
        {
            transaktion_id: txId,
            ...(opts.bezeichnung ? { bezeichnung: opts.bezeichnung } : {}),
            ...(opts.rechnungId ? { rechnung_id: opts.rechnungId } : {}),
        },
        opts.path,
    );
}

/**
 * The owner decides a credit is no double payment: `in_ordnung`, or it pays another invoice — then
 * that invoice is marked paid with this tx (existing mark-paid) before the decision is stored.
 */
export async function markZahlungGeprueft(
    entityId: string,
    txId: string,
    entscheidung: 'in_ordnung' | { andereRechnung: string },
    opts: { path?: string } = {},
): Promise<void> {
    if (entscheidung === 'in_ordnung') {
        saveZahlungGeprueft(entityId, { transaktion_id: txId, entscheidung: 'in_ordnung' }, opts.path);
        return;
    }
    const id = entscheidung.andereRechnung;
    await markOutgoingInvoicePaid(entityId, id, { txId, path: opts.path });
    saveZahlungGeprueft(
        entityId,
        { transaktion_id: txId, entscheidung: 'andere_rechnung', rechnung_id: id },
        opts.path,
    );
}

/**
 * Link the debit that refunded the customer to a recorded double payment (also neutralised in the
 * EÜR). The debit must exist in the entity's accounts, be a debit and not already belong to
 * another double payment.
 */
export function verknuepfeRueckzahlung(entityId: string, txId: string, refundTxId: string, path?: string): void {
    const refund = searchAccountKeys(entityAccountKeys(entityId, path), {}).find((t) => t.id === refundTxId);
    if (!refund) {
        throw new Error(
            `Rückzahlungsbuchung „${refundTxId}" nicht in den Konten gefunden. ` +
                'Lief die Rückzahlung außerhalb der Konten, stattdessen rueckzahlung-extern mit Datum angeben.',
        );
    }
    if (refund.amount >= 0)
        throw new Error(`„${refundTxId}" ist kein Abgang — eine Rückzahlung muss eine Belastung sein.`);
    const taken = (resolveEntityElster(entityId, path)?.adjustments?.doppelzahlungen ?? []).find(
        (d) => d.rueckzahlung_transaktion_id === refundTxId && d.transaktion_id !== txId,
    );
    if (taken) throw new Error(`„${refundTxId}" ist bereits einer anderen Doppelzahlung als Rückzahlung zugeordnet.`);
    saveDoppelzahlungRueckzahlung(entityId, txId, refundTxId, path);
}

/** Record that the customer was refunded outside the entity's accounts (e.g. privately) on `datum`. */
export function verknuepfeRueckzahlungExtern(entityId: string, txId: string, datum: string, path?: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error('Datum der Rückzahlung im Format YYYY-MM-DD angeben.');
    saveDoppelzahlungRueckzahlungExtern(entityId, txId, datum, path);
}

/** One debit that may be the refund of a double payment. */
export interface RueckzahlungKandidat {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty: string;
    accountKey: string;
}

/**
 * Debits of the entity's accounts to pick the refund from: amount equal to `amount` first, then
 * newest. Debits already linked to a double payment are left out ({@link verknuepfeRueckzahlung}
 * would refuse them).
 */
export function listRueckzahlungKandidaten(
    entityId: string,
    amount: number,
    opts: { path?: string; limit?: number } = {},
): RueckzahlungKandidat[] {
    const taken = new Set(
        (resolveEntityElster(entityId, opts.path)?.adjustments?.doppelzahlungen ?? []).flatMap((d) =>
            d.rueckzahlung_transaktion_id ? [d.rueckzahlung_transaktion_id] : [],
        ),
    );
    const debits = searchAccountKeys(entityAccountKeys(entityId, opts.path), {})
        .filter((t) => t.amount < 0 && !taken.has(t.id))
        .map((t) => ({
            id: t.id,
            bookingDate: t.bookingDate,
            amount: t.amount,
            counterparty: t.counterparty ?? '',
            accountKey: t.accountKey,
        }));
    return rankRueckzahlungKandidaten(debits, amount, opts.limit);
}

/** Recorded double payments still waiting for their refund (a linked tx or an external date settles one). */
export function listOffeneRueckzahlungen(entityId: string, opts: { path?: string } = {}): OffeneRueckzahlung[] {
    const open = (resolveEntityElster(entityId, opts.path)?.adjustments?.doppelzahlungen ?? []).filter(
        (d) => !d.rueckzahlung_transaktion_id && !d.rueckzahlung_am,
    );
    if (open.length === 0) return [];
    const byId = new Map<string, UnifiedTransaction>(
        searchAccountKeys(entityAccountKeys(entityId, opts.path), {}).map((t) => [t.id, t]),
    );
    return open.map((d) => {
        const t = byId.get(d.transaktion_id);
        return {
            txId: d.transaktion_id,
            ...(d.rechnung_id ? { rechnungId: d.rechnung_id } : {}),
            bezeichnung: d.bezeichnung,
            ...(t ? { bookingDate: t.bookingDate, amount: t.amount } : {}),
        };
    });
}

/** What the Hinweise show for one year: the counts, plus the suspicions and open refunds themselves. */
export interface DoppelzahlungHinweisDaten {
    verdacht: number;
    rueckzahlungOffen: number;
    verdachtListe?: HinweisDoppelzahlung[];
    rueckzahlungOffenListe?: { txId: string; rechnungId?: string; zeile: string }[];
}

/**
 * The two counts the Hinweise show for one year — unresolved suspicions and open refunds — with the
 * items behind them, so the hint can link the invoice. Fail-soft: a back-end or store that cannot be
 * read yields zeros — a hint must never break a report.
 */
export async function doppelzahlungHinweisCounts(
    entityId: string,
    year: number,
    path?: string,
): Promise<DoppelzahlungHinweisDaten> {
    try {
        const verdachte = await listDoppelzahlungVerdacht(entityId, { year, path });
        const prefix = `${year}-`;
        const offen = listOffeneRueckzahlungen(entityId, { path }).filter(
            (r) => !r.bookingDate || r.bookingDate.startsWith(prefix),
        );
        return {
            verdacht: verdachte.length,
            rueckzahlungOffen: offen.length,
            verdachtListe: verdachte.map((v) => ({
                rechnungId: v.rechnungId,
                rechnungNummer: v.rechnungNummer,
                zuViel: v.zuViel,
                txs: v.txs,
            })),
            rueckzahlungOffenListe: offen.map((r) => ({
                txId: r.txId,
                ...(r.rechnungId ? { rechnungId: r.rechnungId } : {}),
                zeile:
                    r.bookingDate != null && r.amount != null
                        ? buchungZeile({ bookingDate: r.bookingDate, amount: r.amount, counterparty: r.bezeichnung })
                        : r.bezeichnung || r.txId,
            })),
        };
    } catch {
        return { verdacht: 0, rueckzahlungOffen: 0 };
    }
}

/** The five ways to settle a suspicion; exactly one per call (CLI + MCP share this). */
export type DoppelzahlungEntscheidung =
    | { art: 'ist_doppelzahlung'; bezeichnung?: string }
    | { art: 'in_ordnung' }
    | { art: 'andere_rechnung'; rechnungId: string }
    | { art: 'rueckzahlung'; refundTxId: string }
    | { art: 'rueckzahlung_extern'; datum: string };

/** Apply one decision for a credit. `ist_doppelzahlung` takes the invoice from the current suspicion. */
export async function entscheideDoppelzahlung(
    entityId: string,
    txId: string,
    entscheidung: DoppelzahlungEntscheidung,
    opts: { path?: string } = {},
): Promise<{ ok: true; art: DoppelzahlungEntscheidung['art'] }> {
    switch (entscheidung.art) {
        case 'ist_doppelzahlung': {
            const hit = (await listDoppelzahlungVerdacht(entityId, opts)).find((v) => v.txIds.includes(txId));
            markAlsDoppelzahlung(entityId, txId, {
                rechnungId: hit?.rechnungId,
                bezeichnung: entscheidung.bezeichnung,
                path: opts.path,
                suspicion: hit,
            });
            break;
        }
        case 'in_ordnung':
            await markZahlungGeprueft(entityId, txId, 'in_ordnung', opts);
            break;
        case 'andere_rechnung':
            await markZahlungGeprueft(entityId, txId, { andereRechnung: entscheidung.rechnungId }, opts);
            break;
        case 'rueckzahlung':
            verknuepfeRueckzahlung(entityId, txId, entscheidung.refundTxId, opts.path);
            break;
        case 'rueckzahlung_extern':
            verknuepfeRueckzahlungExtern(entityId, txId, entscheidung.datum, opts.path);
            break;
    }
    return { ok: true, art: entscheidung.art };
}

/**
 * Pick the one decision out of the four mutually exclusive inputs (CLI flags / MCP fields). Throws
 * unless exactly one is given.
 */
export function parseEntscheidung(input: {
    istDoppelzahlung?: boolean;
    inOrdnung?: boolean;
    andereRechnung?: string;
    rueckzahlung?: string;
    rueckzahlungExtern?: string;
    bezeichnung?: string;
}): DoppelzahlungEntscheidung {
    const picked: DoppelzahlungEntscheidung[] = [];
    if (input.istDoppelzahlung) picked.push({ art: 'ist_doppelzahlung', bezeichnung: input.bezeichnung });
    if (input.inOrdnung) picked.push({ art: 'in_ordnung' });
    if (input.andereRechnung) picked.push({ art: 'andere_rechnung', rechnungId: input.andereRechnung });
    if (input.rueckzahlung) picked.push({ art: 'rueckzahlung', refundTxId: input.rueckzahlung });
    if (input.rueckzahlungExtern) picked.push({ art: 'rueckzahlung_extern', datum: input.rueckzahlungExtern });
    if (picked.length !== 1) {
        throw new Error(
            'Genau eine Entscheidung angeben: ist-doppelzahlung, in-ordnung, andere-rechnung, rueckzahlung oder rueckzahlung-extern.',
        );
    }
    return picked[0];
}
