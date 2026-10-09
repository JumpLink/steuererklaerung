/**
 * Offene Forderungen (Idee 12) — the action layer: load an entity's outgoing invoices, the credits
 * that quote their numbers and the reminder history, hand them to the pure {@link offenePosten}, and
 * write the one thing the owner decides: „Als versandt markiert".
 *
 * NOTHING is sent here, ever. {@link entwerfeMahnung} returns text; {@link markiereMahnungVersandt}
 * stores that the owner says it went out. Reminder state lives in the ledger (`invoice_reminders`)
 * next to the mail history, keyed by the back-end invoice id — it works for the self AND the Qonto
 * back-end and is not a tax figure, so it stays out of the manifest (which holds the adjustments).
 * Shared by CLI, MCP, the Übersicht/Hinweise and the desktop view.
 */

import {
    type InvoiceReminderRecord,
    type LedgerDatabase,
    type ReminderStage,
    type UnifiedTransaction,
    ledgerDbExists,
    ledgerDbPath,
    listEntityReminders,
    markReminderSent,
    migrate,
    openLedger,
    recordReminderDraft,
    searchAccountKeys,
} from '@steuererklaerung/store';
import {
    altersUebersicht,
    type AltersUebersicht,
    type Forderungen,
    type ForderungMahnung,
    type ForderungRechnung,
    type ForderungZahlung,
    type KundenVerhalten,
    offenePosten,
    type OffenerPosten,
    ueberfaellige,
    verjaehrungDroht,
    zahlungsverhalten,
} from '../invoices/forderungen.ts';
import { invoicingBlock } from '../invoices/backend-gate.ts';
import type { ForderungenHinweisDaten } from '../invoices/forderungen-hinweis.ts';
import { type MahnungEntwurf, mahnungEntwurf } from '../invoices/mahnung-text.ts';
import { normalizeInvoiceStatus } from '../invoices/status.ts';
import { referenceMatches } from '../lib/transactions/reconcile.ts';
import { entityAccountKeys } from './invoice-payments.ts';
import { listOutgoingInvoicesFor } from './outgoing-invoices.ts';

export interface ForderungenUebersicht extends Forderungen {
    alter: AltersUebersicht;
    verhalten: KundenVerhalten[];
}

export interface ForderungenOptions {
    /** Reference date YYYY-MM-DD (default: today). */
    today?: string;
    path?: string;
}

// The owner's calendar day, not UTC's: right after local midnight toISOString() is still yesterday.
const heute = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

/** Reminder history of an entity. READ-ONLY: no ledger yet means no reminder was ever recorded. */
function ladeMahnungen(entityId: string): ForderungMahnung[] {
    if (!ledgerDbExists()) return [];
    const rows: InvoiceReminderRecord[] = withLedger((db) => listEntityReminders(db, entityId));
    return rows.map((r) => ({
        rechnungId: r.invoiceId,
        stufe: r.stage,
        entworfenAm: r.draftedAt,
        versandtAm: r.sentAt,
    }));
}

/**
 * The credits that quote an invoice's number in their purpose — the same signal the Doppelzahlung
 * detector uses. A credit that names SEVERAL invoices is a combined payment and cannot be split, so
 * it counts for none of them (an invoice is then simply chased for the full amount rather than
 * wrongly cleared).
 */
export function zahlungenZuRechnungen(
    rechnungen: readonly ForderungRechnung[],
    credits: readonly Pick<UnifiedTransaction, 'bookingDate' | 'amount' | 'purpose' | 'reference' | 'counterparty'>[],
): ForderungZahlung[] {
    const nummerierte = rechnungen.filter((r) => !!r.number);
    const out: ForderungZahlung[] = [];
    for (const c of credits) {
        if (!(c.amount > 0)) continue;
        const treffer = nummerierte.filter((r) => referenceMatches(r.number ?? undefined, c));
        if (treffer.length !== 1) continue;
        out.push({ rechnungId: treffer[0].id, date: c.bookingDate, amount: c.amount });
    }
    return out;
}

async function ladeEingaben(
    entityId: string,
    opts: ForderungenOptions,
): Promise<{ rechnungen: ForderungRechnung[]; zahlungen: ForderungZahlung[] }> {
    const liste = await listOutgoingInvoicesFor(entityId, { path: opts.path });
    const rechnungen: ForderungRechnung[] = [];
    for (const inv of liste) {
        const status = normalizeInvoiceStatus(inv.status);
        if ((status !== 'open' && status !== 'paid') || inv.total == null || !(inv.total > 0)) continue;
        rechnungen.push({
            id: inv.id,
            number: inv.number,
            customer: inv.customerName,
            gross: inv.total,
            currency: inv.currency ?? 'EUR',
            issueDate: inv.issueDate,
            dueDate: inv.dueDate,
            status: inv.status,
            paidOn: inv.paidOn ?? null,
        });
    }
    const credits = searchAccountKeys(entityAccountKeys(entityId, opts.path), {});
    return { rechnungen, zahlungen: zahlungenZuRechnungen(rechnungen, credits) };
}

/** Open items by age + per-customer payment behaviour for one entity. */
export async function loadForderungen(entityId: string, opts: ForderungenOptions = {}): Promise<ForderungenUebersicht> {
    const today = opts.today ?? heute();
    const { rechnungen, zahlungen } = await ladeEingaben(entityId, opts);
    const forderungen = offenePosten(rechnungen, zahlungen, ladeMahnungen(entityId), today);
    return {
        ...forderungen,
        alter: altersUebersicht(forderungen.posten),
        verhalten: zahlungsverhalten(rechnungen, zahlungen),
    };
}

/**
 * The open items for the Hinweise (Verjährung) and „Als Nächstes". Fail-soft: an invoice back-end or
 * store that cannot be read yields `posten: null` — a hint must never break a report.
 */
export async function forderungenHinweisDaten(
    entityId: string,
    opts: ForderungenOptions = {},
): Promise<ForderungenHinweisDaten> {
    try {
        // An entity that does not invoice has no claims — nothing to check, so no „nicht prüfbar" noise.
        if (invoicingBlock(entityId, opts.path)) return { posten: [] };
        const { posten } = await loadForderungen(entityId, opts);
        return { posten };
    } catch (err) {
        return { posten: null, weil: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * How many overdue claims „Als Nächstes" counts: the ones the Verjährung hint does not already carry,
 * so no invoice makes two tasks. Fail-soft like {@link forderungenHinweisDaten}.
 */
export function zaehleUeberfaellige(daten: ForderungenHinweisDaten): number {
    return ueberfaellige(daten.posten ?? []).filter((p) => !verjaehrungDroht(p)).length;
}

function findePosten(u: Forderungen, rechnungId: string): OffenerPosten {
    const p = u.posten.find((x) => x.rechnungId === rechnungId || x.nummer === rechnungId);
    if (!p) {
        throw new Error(
            `Keine offene Forderung „${rechnungId}". Offen sind: ${u.posten.map((x) => x.nummer ?? x.rechnungId).join(', ') || '—'}`,
        );
    }
    return p;
}

function pruefeStufe(stufe: number): ReminderStage {
    if (stufe !== 1 && stufe !== 2 && stufe !== 3) throw new Error(`Mahnstufe ${stufe} gibt es nicht (1–3).`);
    return stufe;
}

export interface MahnungEntwurfErgebnis extends MahnungEntwurf {
    rechnungId: string;
    nummer: string | null;
    kunde: string;
    /** Always false: the app drafts, the owner sends. */
    versandt: false;
    /** Whether the owner already confirmed this stage as sent. */
    schonVersandt: boolean;
}

/**
 * Draft the reminder text of one stage for an open, overdue invoice. `stufe` defaults to the next one.
 * Writes at most the note „Entwurf erstellt" (`record`, default on) — never anything that says sent.
 * Pass `record: false` for a pure read (the MCP tool).
 */
export async function entwerfeMahnung(
    entityId: string,
    rechnungId: string,
    stufe: number | undefined,
    opts: ForderungenOptions & { record?: boolean } = {},
): Promise<MahnungEntwurfErgebnis> {
    const today = opts.today ?? heute();
    const { rechnungen, zahlungen } = await ladeEingaben(entityId, opts);
    const mahnungen = ladeMahnungen(entityId);
    const posten = findePosten(offenePosten(rechnungen, zahlungen, mahnungen, today), rechnungId);
    const gewaehlt = pruefeStufe(stufe ?? posten.naechsteStufe ?? 3);
    const entwurf = mahnungEntwurf({
        stufe: gewaehlt,
        nummer: posten.nummer,
        kunde: posten.kunde,
        issueDate: posten.issueDate,
        dueDate: posten.dueDate,
        brutto: posten.brutto,
        bezahlt: posten.bezahlt,
        currency: posten.currency,
        heute: today,
        fruehere: mahnungen
            .filter((m) => m.rechnungId === posten.rechnungId && m.versandtAm && m.stufe < gewaehlt)
            .map((m) => ({ stufe: m.stufe as 1 | 2, versandtAm: m.versandtAm as string })),
    });
    if (opts.record !== false && ledgerDbExists()) {
        withLedger((db) =>
            recordReminderDraft(
                db,
                { entityId, invoiceId: posten.rechnungId, invoiceNumber: posten.nummer, stage: gewaehlt },
                new Date().toISOString(),
            ),
        );
    }
    return {
        ...entwurf,
        rechnungId: posten.rechnungId,
        nummer: posten.nummer,
        kunde: posten.kunde,
        versandt: false,
        schonVersandt: mahnungen.some(
            (m) => m.rechnungId === posten.rechnungId && m.stufe === gewaehlt && m.versandtAm,
        ),
    };
}

/**
 * The owner confirms: this stage went out (on `datum`, default today). The only write that marks a
 * reminder as sent — and it never sends one. Refused for an invoice that is not an open claim.
 */
export async function markiereMahnungVersandt(
    entityId: string,
    rechnungId: string,
    stufe: number,
    opts: ForderungenOptions & { datum?: string } = {},
): Promise<{ rechnungId: string; nummer: string | null; stufe: ReminderStage; versandtAm: string }> {
    const today = opts.today ?? heute();
    const gewaehlt = pruefeStufe(stufe);
    const datum = opts.datum ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error(`Datum „${datum}" ist kein YYYY-MM-DD.`);
    const { rechnungen, zahlungen } = await ladeEingaben(entityId, opts);
    const posten = findePosten(offenePosten(rechnungen, zahlungen, ladeMahnungen(entityId), today), rechnungId);
    withLedger((db) =>
        markReminderSent(
            db,
            { entityId, invoiceId: posten.rechnungId, invoiceNumber: posten.nummer, stage: gewaehlt },
            datum,
            new Date().toISOString(),
        ),
    );
    return { rechnungId: posten.rechnungId, nummer: posten.nummer, stufe: gewaehlt, versandtAm: datum };
}
