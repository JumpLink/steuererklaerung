/**
 * „Zu prüfen" (Idee 6 in docs/ideen-nutzerfuehrung.md): which bookings deserve a look, and how a
 * booking's classification is explained to a person.
 *
 * A booking is in the queue when nothing classified it, or when only an Auffangregel did — a generic
 * catch-all that guessed from the bank's own category tag (see `MatchedRule.auffang` in
 * euer-classify.ts). Confirming one records the category the person saw (`geprueft`); the booking
 * stays out of the queue only while it is still classified that way, so a later rule change that
 * moves it brings it back.
 *
 * Pure: the aggregate's detail rows and the confirmations come in, nothing is read or written here.
 */

import type { ClassSource, MatchedRule } from './euer-classify.ts';

/** Why a booking is in the queue. `erstattung`: an incoming payment that may refund an earlier debit (Idee 9). */
export type ZuPruefenGrund = 'unklassifiziert' | 'auffangregel' | 'erstattung';

/** The subset of an EÜR detail row the queue needs. */
export interface ZuPruefenZeile {
    id: string;
    source: ClassSource;
    category: string;
    matchedRule?: MatchedRule;
}

/** Why `row` is in the queue, or null when it is not. */
export function zuPruefenGrund(row: ZuPruefenZeile): ZuPruefenGrund | null {
    if (row.source === 'unclassified') return 'unklassifiziert';
    if (row.source === 'rule' && row.matchedRule?.auffang) return 'auffangregel';
    return null;
}

/**
 * The queue: rows that need a look, minus those confirmed under the category they still have.
 * `geprueft` maps a transaction id to the category it was confirmed with. `erstattungen` are the
 * incoming payments with an open refund candidate (`elster/erstattung.ts`) — they are in the queue
 * for that question, whatever classified them. Order is kept.
 */
export function zuPruefenQueue<T extends ZuPruefenZeile>(
    rows: readonly T[],
    geprueft: ReadonlyMap<string, string>,
    erstattungen: ReadonlySet<string> = new Set(),
): Array<T & { grund: ZuPruefenGrund }> {
    const out: Array<T & { grund: ZuPruefenGrund }> = [];
    for (const r of rows) {
        if (erstattungen.has(r.id)) {
            out.push({ ...r, grund: 'erstattung' });
            continue;
        }
        const grund = zuPruefenGrund(r);
        if (!grund) continue;
        if (grund === 'auffangregel' && geprueft.get(r.id) === r.category) continue;
        out.push({ ...r, grund });
    }
    return out;
}

/** The two short phrases a queue row shows next to its category. */
export const GRUND_TEXT: Record<ZuPruefenGrund, string> = {
    unklassifiziert: 'unklassifiziert',
    auffangregel: 'nur Auffangregel',
    erstattung: 'Erstattung? Zahlung zuordnen',
};

/** „N Buchungen zu prüfen" — singular-aware, for the Übersicht task and the tab. */
export function zuPruefenTitel(n: number): string {
    return n === 1 ? '1 Buchung zu prüfen' : `${n} Buchungen zu prüfen`;
}

/** A classification as {@link herkunftText} needs it. */
export interface Herkunft {
    source: ClassSource;
    matchedRule?: MatchedRule;
}

/**
 * Where a classification came from, in one phrase: „via Regel „Hosting"", „via Beleg #12",
 * „manuell", „unklassifiziert". An Auffangregel says so, because that is the difference between
 * „the program knows" and „the program guessed".
 */
export function herkunftText(h: Herkunft): string {
    const m = h.matchedRule;
    if (h.source === 'unclassified') return 'unklassifiziert';
    if (m?.art === 'aufteilung') return m.label;
    if (h.source === 'manual') return 'manuell';
    if (h.source === 'document') return `via ${m?.label ?? 'Beleg'}`;
    if (!m) return 'via Regel';
    if (m.art === 'doppelzahlung') return 'via Doppelzahlung';
    if (m.art === 'erstattung') return `via ${m.label}`;
    const label = m.art === 'eigene' ? m.label : `„${m.label}“`;
    return `via Regel ${label}${m.auffang ? ' (Auffangregel)' : ''}`;
}

/**
 * The sentence „Umbuchung zurücknehmen" (or „Verknüpfung lösen" for an Erstattung) shows: what
 * applies once the owner's decision is gone. `ohne` is the classification of the same booking WITHOUT
 * it (the aggregate computes it with the same function, see `classifyTransaction`). Null for a booking
 * that has neither an Umbuchung nor a linked Erstattung.
 */
export function wasGiltDanach(row: {
    source: ClassSource;
    matchedRule?: MatchedRule;
    ohneUmbuchung?: Herkunft & { category: string };
}): string | null {
    if (!row.ohneUmbuchung || (row.source !== 'manual' && !istErstattung(row))) return null;
    const ohne = row.ohneUmbuchung;
    if (ohne.source === 'unclassified') return 'Danach ist die Buchung unklassifiziert.';
    return `Danach gilt wieder: ${herkunftText(ohne)} → ${ohne.category}.`;
}

/** Whether a booking is split into parts (Idee 13) — its undo is „Aufteilung aufheben", not „Umbuchung zurücknehmen". */
export function istAufteilung(row: { matchedRule?: MatchedRule }): boolean {
    return row.matchedRule?.art === 'aufteilung';
}

/** Whether a booking is classified as a linked Erstattung (its undo is „Verknüpfung lösen"). */
export function istErstattung(row: { source: ClassSource; matchedRule?: MatchedRule }): boolean {
    return row.source !== 'manual' && row.matchedRule?.art === 'erstattung';
}
