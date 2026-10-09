/**
 * Splitbuchung presenter (Idee 13) — the split of one booking as the surfaces show it, saving it and
 * „Aufteilung aufheben". Shared by the desktop booking detail, the CLI `buchungen aufteilen` and the
 * MCP tools.
 *
 * Both writes are guarded: a booking in a period whose return is already filed (filings register) is
 * only changed with an explicit `trotzAbgabe`; without it nothing is written and the result carries
 * the warning. The register keeps the filed values either way.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { entityIdAliases } from '@steuererklaerung/store';
import { listFilings } from '../actions/filings.ts';
import { schreibeAufteilung, type AbgabeBestaetigung } from '../actions/aufteilungen.ts';
import type { EuerTeilZeile } from '../elster/euer-transactions.ts';
import {
    AUFTEILUNG_KATEGORIEN,
    AufteilungFehler,
    berechneTeile,
    betroffeneAbgaben,
    doppelzaehlungHinweis,
    STEUERSAETZE,
    type Abgabe,
    type AbgabeKonflikt,
    type Teil,
    type TeilEingabe,
} from '../elster/splitbuchung.ts';
import { istErstattung, wasGiltDanach } from '../elster/zu-pruefen.ts';
import { loadEnrichedTransactions, type EnrichedTxRow } from './buchungen.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export { aufteilungTitel, BEWIRTUNG_ABZIEHBAR_ANTEIL, bewirtungsTeile, restBetrag } from '../elster/splitbuchung.ts';

/** The split of one booking, ready to show — and what the „Aufteilen" dialog needs. */
export interface AufteilungAnsicht {
    id: string;
    bookingDate: string;
    amount: number;
    /** The parts as booked, or null when the booking is not split. */
    teile: EuerTeilZeile[] | null;
    /** The categories and VAT rates a part may take. */
    kategorien: readonly string[];
    steuersaetze: readonly number[];
    /** The receipt's VAT rate, the default for a new part. */
    belegSatz?: number;
    /** What the booking is booked as without a split (the first part of a new split). */
    kategorieOhne: string;
    /** Filed returns the booking's period belongs to — a change needs confirmation. */
    abgaben: AbgabeKonflikt[];
    /** Why the booking cannot be split right now (a linked Erstattung), else null. */
    gesperrt: string | null;
    /** „Danach gilt wieder: …" for „Aufteilung aufheben". */
    danach: string | null;
    /** Double-count warning against a pauschal Privatanteil, for the stored split. */
    doppelzaehlung: string | null;
    /** The entity's pauschal Privatanteile — the dialog checks a new split against them live. */
    privatanteile: Array<{ bezeichnung: string }>;
}

export type { AbgabeBestaetigung };

export type AufteilungSpeichernErgebnis =
    | { ok: true; id: string; teile: Teil[]; doppelzaehlung: string | null }
    | AbgabeBestaetigung;

export type AufteilungAufhebenErgebnis = { ok: boolean; id: string; danach: string | null } | AbgabeBestaetigung;

async function findRow(session: PresenterSession, entity: EntityModel, year: number, txId: string) {
    const row = (await loadEnrichedTransactions(session, entity, year)).rows.find((r) => r.id === txId);
    if (!row) throw new AufteilungFehler(`Die Buchung ${txId} gehört nicht zu ${entity.name} ${year}.`);
    return row;
}

/** The entity's register entries of the booking's year (alias-tolerant like `erklaerteUstva`). */
function registerFuer(session: PresenterSession, entity: EntityModel, datum: string): Abgabe[] {
    const elsterId = session.elster(entity)?.entity_id;
    const ids = new Set([...entityIdAliases(entity.id), ...(elsterId ? entityIdAliases(elsterId) : [])]);
    try {
        return listFilings({ year: Number(datum.slice(0, 4)) }).filter((f) => ids.has(f.entityId));
    } catch {
        return [];
    }
}

/** The receipt's VAT rate from its net and VAT, snapped to the known rates. */
function belegSatzVon(row: EnrichedTxRow): number | undefined {
    const net = row.receipt?.net;
    const vat = row.receipt?.vat;
    if (net == null || vat == null || Math.abs(net) < 0.005) return undefined;
    const rate = Math.abs(vat / net);
    return STEUERSAETZE.find((s) => Math.abs(s - rate) < 0.005);
}

function privatanteile(session: PresenterSession, entity: EntityModel) {
    return session.elster(entity)?.adjustments?.privatanteile ?? [];
}

/** The split of one booking (or the empty state for a new one). */
export async function aufteilungAnsicht(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
): Promise<AufteilungAnsicht> {
    const row = await findRow(session, entity, year, txId);
    const teile = row.aufteilung ?? null;
    return {
        id: row.id,
        bookingDate: row.bookingDate,
        amount: row.amount,
        teile,
        kategorien: AUFTEILUNG_KATEGORIEN,
        steuersaetze: STEUERSAETZE,
        belegSatz: belegSatzVon(row),
        kategorieOhne: teile ? (row.ohneUmbuchung?.category ?? row.category) : row.category,
        abgaben: betroffeneAbgaben(row.bookingDate, registerFuer(session, entity, row.bookingDate)),
        gesperrt: istErstattung(row)
            ? 'Die Buchung ist als Erstattung verknüpft. Zum Aufteilen erst die Verknüpfung lösen.'
            : null,
        danach: teile ? wasGiltDanach(row) : null,
        doppelzaehlung: teile ? doppelzaehlungHinweis(teile, privatanteile(session, entity)) : null,
        privatanteile: privatanteile(session, entity).map((p) => ({ bezeichnung: p.bezeichnung })),
    };
}

/**
 * Save the split of one booking (replacing an earlier one). Validates the parts against the booking
 * (`berechneTeile` throws {@link AufteilungFehler}); in a filed period nothing is written unless
 * `trotzAbgabe` is set.
 */
export async function speichereAufteilung(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
    eingaben: readonly TeilEingabe[],
    opts: { trotzAbgabe?: boolean; decidedBy?: string } = {},
): Promise<AufteilungSpeichernErgebnis> {
    const row = await findRow(session, entity, year, txId);
    if (istErstattung(row)) {
        throw new AufteilungFehler(
            'Die Buchung ist als Erstattung verknüpft. Zum Aufteilen erst die Verknüpfung lösen.',
        );
    }
    const teile = berechneTeile(row.amount, eingaben, { belegSatz: belegSatzVon(row) });
    const r = schreibeAufteilung(txId, row.bookingDate, teile, {
        abgaben: registerFuer(session, entity, row.bookingDate),
        trotzAbgabe: opts.trotzAbgabe,
        decidedBy: opts.decidedBy ?? 'app',
    });
    if (!r.ok) return r;
    session.invalidate(entity.id);
    return { ok: true, id: txId, teile, doppelzaehlung: doppelzaehlungHinweis(teile, privatanteile(session, entity)) };
}

/** „Aufteilung aufheben": the booking books as before the split; same filed-period guard as saving. */
export async function hebeAufteilungAuf(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txId: string,
    opts: { trotzAbgabe?: boolean; decidedBy?: string } = {},
): Promise<AufteilungAufhebenErgebnis> {
    const row = await findRow(session, entity, year, txId);
    const r = schreibeAufteilung(txId, row.bookingDate, null, {
        abgaben: registerFuer(session, entity, row.bookingDate),
        trotzAbgabe: opts.trotzAbgabe,
        decidedBy: opts.decidedBy ?? 'app',
    });
    if (!r.ok) return r;
    session.invalidate(entity.id);
    return { ok: r.gespeichert, id: txId, danach: row.aufteilung ? wasGiltDanach(row) : null };
}

/** The year's split bookings with their parts — the CLI list and MCP read. */
export async function listeAufteilungen(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<
    Array<
        Pick<EnrichedTxRow, 'id' | 'bookingDate' | 'amount' | 'counterparty' | 'purpose'> & { teile: EuerTeilZeile[] }
    >
> {
    if (!session.elster(entity)) return [];
    return (await loadEnrichedTransactions(session, entity, year)).rows
        .filter((r) => r.aufteilung)
        .map((r) => ({
            id: r.id,
            bookingDate: r.bookingDate,
            amount: r.amount,
            counterparty: r.counterparty,
            purpose: r.purpose,
            teile: r.aufteilung!,
        }));
}
