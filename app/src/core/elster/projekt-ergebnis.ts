/**
 * Projekte auch für Ausgaben (Idee 14 in docs/ideen-nutzerfuehrung.md): which project an expense belongs
 * to, and what a project earned — Umsatz − Kosten = Projektergebnis.
 *
 * The assignment has three sources, strongest first: a decision of the person on the booking (or on one
 * part of a split booking), a project rule (`elster.klassifizierung.projekt_regeln`, the same shape and
 * matching as the booking rules: a case-insensitive substring of counterparty + purpose + reference +
 * type, `ausnahmen` the bookings it must leave alone), and nothing. A decision „kein Projekt" wins over a
 * rule too, so a booking can be taken out of a rule's reach without editing the rule.
 *
 * The Projektergebnis is an INTERNAL evaluation, not a tax figure: Kosten are the net amounts the EÜR
 * books as Betriebsausgabe, so a private or otherwise neutral part of a booking is not a cost, and the
 * result moves with the EÜR's own decisions (receipt, Umbuchung, Aufteilung). Umsatz is the net of the
 * issued invoices assigned to the project directly (full net — flat fees, hosting, licences) plus the
 * share of those that carry its tracked hours; a direct assignment wins over the hours.
 *
 * Pure: bookings, decisions, rules and invoices come in, nothing is read or written.
 */

import { round2 } from '../lib/money.ts';
import type { EuerKind } from './euer-aggregate.ts';

/** A project rule as `elster.klassifizierung.projekt_regeln` stores it. */
export interface ProjektRegel {
    /** Case-insensitive substring of counterparty + purpose + reference + type. */
    muster: string;
    /** Id of the project the matching expenses belong to. */
    projekt: string;
    /** Transaction ids the rule must leave alone. */
    ausnahmen?: string[];
}

/** What a rule needs to see of a booking. */
export interface ProjektBuchung {
    id: string;
    amount: number;
    counterparty?: string | null;
    purpose?: string | null;
    reference?: string | null;
    type?: string | null;
}

/** The part number of a decision about the whole booking; a split part n is n ≥ 1. */
export const GANZE_BUCHUNG = 0;

/** A decision of the person: a project, or `null` for „kein Projekt". */
export interface ProjektEntscheidung {
    teilNr: number;
    projectId: string | null;
}

/** Where a booking's project comes from. */
export type ProjektHerkunftArt = 'manuell' | 'regel' | 'keine';

export interface ProjektHerkunft {
    art: ProjektHerkunftArt;
    /** What a person reads: „manuell", „via Regel „Küstenlicht“", „manuell: kein Projekt". */
    label: string;
    regel?: ProjektRegel;
}

export interface ProjektZuordnung {
    /** The project, or null when the booking belongs to none. */
    projectId: string | null;
    /** Null when nothing assigned or excluded the booking. */
    herkunft: ProjektHerkunft | null;
}

/** Stable id of a project rule — its pattern, lowercased, so reordering the list keeps it. */
export function projektRegelId(muster: string): string {
    return `projekt:${muster.trim().toLowerCase()}`;
}

const NIE: ProjektZuordnung = { projectId: null, herkunft: null };

function heuhaufen(b: ProjektBuchung): string {
    return `${b.counterparty ?? ''} ${b.purpose ?? ''} ${b.reference ?? ''} ${b.type ?? ''}`.toLowerCase();
}

/**
 * The first rule that claims the booking: an expense whose text contains the pattern, not listed in the
 * rule's `ausnahmen`, pointing at a project that exists. First match wins, like the booking rules.
 */
export function passendeProjektRegel(
    buchung: ProjektBuchung,
    regeln: readonly ProjektRegel[],
    bekannt: ReadonlySet<string>,
): ProjektRegel | null {
    if (buchung.amount >= 0) return null;
    const text = heuhaufen(buchung);
    for (const r of regeln) {
        const muster = r.muster.trim().toLowerCase();
        if (muster.length === 0 || !bekannt.has(r.projekt)) continue;
        if (text.includes(muster) && !r.ausnahmen?.includes(buchung.id)) return r;
    }
    return null;
}

function aus(entscheidung: ProjektEntscheidung | undefined, bekannt: ReadonlySet<string>): ProjektZuordnung | null {
    if (!entscheidung) return null;
    if (entscheidung.projectId == null) {
        return { projectId: null, herkunft: { art: 'keine', label: 'manuell: kein Projekt' } };
    }
    // A project that was deleted since: the decision no longer assigns anything, and it does not fall
    // back to a rule either — the person decided, and what they decided no longer exists.
    if (!bekannt.has(entscheidung.projectId)) return NIE;
    return { projectId: entscheidung.projectId, herkunft: { art: 'manuell', label: 'manuell' } };
}

/**
 * The project of one booking, or of one part of a split booking (`teilNr` ≥ 1: the part's own decision
 * first, then the decision about the whole booking, then the rules). A person's decision wins over every
 * rule.
 */
export function projektFuerBuchung(
    buchung: ProjektBuchung,
    entscheidungen: readonly ProjektEntscheidung[],
    regeln: readonly ProjektRegel[],
    bekannt: ReadonlySet<string>,
    teilNr: number = GANZE_BUCHUNG,
): ProjektZuordnung {
    if (buchung.amount >= 0) return NIE;
    const find = (nr: number) => entscheidungen.find((e) => e.teilNr === nr);
    const manuell = (teilNr > GANZE_BUCHUNG ? aus(find(teilNr), bekannt) : null) ?? aus(find(GANZE_BUCHUNG), bekannt);
    if (manuell) return manuell;
    const regel = passendeProjektRegel(buchung, regeln, bekannt);
    if (!regel) return NIE;
    return {
        projectId: regel.projekt,
        herkunft: { art: 'regel', label: `via Regel „${regel.muster.trim()}“`, regel },
    };
}

/** „Danach gilt: …" — what applies to the booking once the person's decision is taken back. */
export function danachGilt(
    buchung: ProjektBuchung,
    entscheidungen: readonly ProjektEntscheidung[],
    regeln: readonly ProjektRegel[],
    projekte: ReadonlyMap<string, string>,
    teilNr: number = GANZE_BUCHUNG,
): string {
    const rest = entscheidungen.filter((e) => e.teilNr !== teilNr);
    const z = projektFuerBuchung(buchung, rest, regeln, new Set(projekte.keys()), teilNr);
    if (z.projectId == null) {
        return z.herkunft?.art === 'keine' ? 'Danach gilt: manuell kein Projekt.' : 'Danach gilt: kein Projekt.';
    }
    const name = projekte.get(z.projectId) ?? z.projectId;
    return `Danach gilt: ${z.herkunft?.label ?? 'manuell'} → Projekt „${name}“.`;
}

// --- Kosten ---------------------------------------------------------------------------------

/** One part of a split booking as the EÜR books it. */
export interface KostenTeil {
    nr: number;
    category: string;
    kind: EuerKind;
    /** Signed contribution to the category, like the EÜR detail row. */
    net: number;
}

/** The subset of an EÜR detail row the cost list needs. */
export interface KostenQuelle extends ProjektBuchung {
    bookingDate: string;
    kind: EuerKind;
    category: string;
    net: number;
    aufteilung?: readonly KostenTeil[];
}

export interface KostenZeile {
    txId: string;
    bookingDate: string;
    counterparty?: string | null;
    purpose?: string | null;
    category: string;
    /** Set for the part of a split booking. */
    teilNr?: number;
    /** Positive net cost in EUR. */
    net: number;
    projectId: string;
    herkunft: ProjektHerkunft;
}

/**
 * The expenses of every project, in the order of the rows. A booking contributes its EÜR net when the EÜR
 * books it as an expense; a split booking contributes per part, each part going to the project of its
 * own decision, else the booking's. Private and other neutral parts, income and refunds are no cost.
 * Only bookings inside `von`…`bis` (inclusive ISO dates) count.
 */
export function projektKosten(
    zeilen: readonly KostenQuelle[],
    entscheidungen: ReadonlyMap<string, readonly ProjektEntscheidung[]>,
    regeln: readonly ProjektRegel[],
    projekte: ReadonlyMap<string, string>,
    zeitraum: { von: string; bis: string },
): Map<string, KostenZeile[]> {
    const bekannt = new Set(projekte.keys());
    const out = new Map<string, KostenZeile[]>();
    for (const z of zeilen) {
        if (z.amount >= 0 || z.bookingDate < zeitraum.von || z.bookingDate > zeitraum.bis) continue;
        const gewollt = entscheidungen.get(z.id) ?? [];
        const teile: Array<{ teilNr?: number; category: string; kind: EuerKind; net: number }> = z.aufteilung
            ? z.aufteilung.map((t) => ({ teilNr: t.nr, category: t.category, kind: t.kind, net: t.net }))
            : [{ category: z.category, kind: z.kind, net: z.net }];
        for (const t of teile) {
            if (t.kind !== 'expense' || t.net <= 0) continue;
            const zuordnung = projektFuerBuchung(z, gewollt, regeln, bekannt, t.teilNr ?? GANZE_BUCHUNG);
            if (zuordnung.projectId == null || zuordnung.herkunft == null) continue;
            const liste = out.get(zuordnung.projectId) ?? [];
            liste.push({
                txId: z.id,
                bookingDate: z.bookingDate,
                counterparty: z.counterparty,
                purpose: z.purpose,
                category: t.category,
                ...(t.teilNr != null ? { teilNr: t.teilNr } : {}),
                net: round2(t.net),
                projectId: zuordnung.projectId,
                herkunft: zuordnung.herkunft,
            });
            out.set(zuordnung.projectId, liste);
        }
    }
    return out;
}

// --- Ergebnis -------------------------------------------------------------------------------

/** An issued invoice and the tracked seconds of each project on it. */
export interface ProjektRechnung {
    id: string;
    nummer: string | null;
    /** YYYY-MM-DD. */
    datum: string;
    /** Net total of the invoice in EUR. */
    netto: number;
    /** Seconds of tracked time per project id on this invoice (billed entries). */
    sekunden: Readonly<Record<string, number>>;
    /**
     * The project the person assigned the invoice to directly. It wins over the hours: the invoice then
     * counts its full net for this project and for no other, so nothing is counted twice.
     */
    direktProjekt?: string | null;
}

/** A tracked time entry. */
export interface ProjektZeit {
    projectId: string;
    /** ISO timestamp or date. */
    startedAt: string;
    seconds: number;
}

export interface UmsatzZeile {
    rechnungId: string;
    nummer: string | null;
    datum: string;
    /** The project's net share of the invoice: all of it, or its share of the hours when several projects are on it. */
    netto: number;
    /** 1 when the invoice carries only this project. */
    anteil: number;
    /** „direkt" = assigned on the invoice; „zeiten" = derived from the billed hours. */
    herkunft: 'direkt' | 'zeiten';
}

/**
 * The project's share of an invoice: all of it when assigned directly (and none for any other project),
 * otherwise by tracked seconds; 0 when it has none on it.
 */
export function rechnungsAnteil(r: ProjektRechnung, projectId: string): number {
    if (r.direktProjekt) return r.direktProjekt === projectId ? 1 : 0;
    const eigene = r.sekunden[projectId] ?? 0;
    if (eigene <= 0) return 0;
    const alle = Object.values(r.sekunden).reduce((s, x) => s + Math.max(0, x), 0);
    return alle > 0 ? eigene / alle : 0;
}

export interface Projektergebnis {
    projectId: string;
    name: string;
    von: string;
    bis: string;
    /** Net Umsatz of the project's invoices in the period. */
    umsatz: number;
    /** Net Kosten of the assigned expenses in the period. */
    kosten: number;
    /** Umsatz − Kosten. */
    ergebnis: number;
    /** Tracked hours in the period; null when none were tracked. */
    stunden: number | null;
    /** Ergebnis per tracked hour; null without hours. */
    ergebnisProStunde: number | null;
    rechnungen: UmsatzZeile[];
    ausgaben: KostenZeile[];
}

/**
 * Umsatz − Kosten for one project and period. Invoices count by issue date, expenses by booking date,
 * hours by the day they were started. Not a tax figure: an internal evaluation.
 */
export function projektergebnis(
    projekt: { id: string; name: string },
    eingabe: { kosten: readonly KostenZeile[]; rechnungen: readonly ProjektRechnung[]; zeiten: readonly ProjektZeit[] },
    zeitraum: { von: string; bis: string },
): Projektergebnis {
    const rechnungen: UmsatzZeile[] = [];
    for (const r of eingabe.rechnungen) {
        if (r.datum < zeitraum.von || r.datum > zeitraum.bis) continue;
        const anteil = rechnungsAnteil(r, projekt.id);
        if (anteil <= 0) continue;
        rechnungen.push({
            rechnungId: r.id,
            nummer: r.nummer,
            datum: r.datum,
            netto: round2(r.netto * anteil),
            anteil,
            herkunft: r.direktProjekt ? 'direkt' : 'zeiten',
        });
    }
    const ausgaben = eingabe.kosten.filter(
        (k) => k.projectId === projekt.id && k.bookingDate >= zeitraum.von && k.bookingDate <= zeitraum.bis,
    );
    const sekunden = eingabe.zeiten
        .filter((z) => z.projectId === projekt.id)
        .filter((z) => z.startedAt.slice(0, 10) >= zeitraum.von && z.startedAt.slice(0, 10) <= zeitraum.bis)
        .reduce((s, z) => s + Math.max(0, z.seconds), 0);
    const umsatz = round2(rechnungen.reduce((s, r) => s + r.netto, 0));
    const kosten = round2(ausgaben.reduce((s, k) => s + k.net, 0));
    const ergebnis = round2(umsatz - kosten);
    const stunden = sekunden > 0 ? round2(sekunden / 3600) : null;
    return {
        projectId: projekt.id,
        name: projekt.name,
        von: zeitraum.von,
        bis: zeitraum.bis,
        umsatz,
        kosten,
        ergebnis,
        stunden,
        ergebnisProStunde: stunden != null ? round2(ergebnis / (sekunden / 3600)) : null,
        rechnungen,
        ausgaben,
    };
}

/** The year as a period. */
export function jahrZeitraum(year: number): { von: string; bis: string } {
    return { von: `${year}-01-01`, bis: `${year}-12-31` };
}
