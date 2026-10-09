/**
 * Dokumentregeln (Idee 11) for the built-in DMS: „Beleg von X → Dokumenttyp, Kategorie, Richtung".
 *
 * The same shape as the booking rules (`elster/euer-classify.ts`): a case-insensitive substring
 * `muster`, a stable id derived from it, `ausnahmen` for the documents a person took the rule off,
 * and an origin that says which rule decided — so every surface can print „via Regel …".
 *
 * What differs is WHEN a rule acts. A booking is re-classified on every report; a receipt is
 * classified ONCE, when it arrives, and the values are then stored on it. That has three
 * consequences, all deliberate:
 *   - a rule fills only fields that are still empty — an e-invoice's own data set, an earlier rule or
 *     a hand edit is never overwritten;
 *   - the AI runs afterwards and fills what the rule left open (`DmsRuleOrigin.fields` is the list
 *     of fields it must not touch);
 *   - removing a rule changes no receipt that already carries its values.
 *
 * Pure: documents and rules come in, a patch goes out. Nothing is read or written here.
 */

import type { DmsDocument, DmsRuleField, DmsRuleOrigin } from '@steuererklaerung/dms';

/** One stored rule (`elster.klassifizierung.beleg_regeln`). */
export interface DokumentRegel {
    /** Case-insensitive substring of sender + title + file name + text. */
    muster: string;
    korrespondent?: string;
    dokumenttyp?: string;
    kategorie?: string;
    richtung?: 'incoming' | 'outgoing';
    /** Document ids the rule must not touch. */
    ausnahmen?: string[];
}

/** What a rule can look at on a receipt. */
export interface DokumentProbe {
    id: string;
    correspondent: string | null;
    title: string | null;
    filename?: string | null;
    /** Text of the file: PDF text layer or OCR; may be empty. */
    text?: string | null;
}

/** Shortest pattern accepted — shorter needles match half of every receipt. */
export const MIN_DOKUMENT_MUSTER = 3;

/** Stable id of a rule — its pattern, lowercased, so reordering the list keeps it. */
export function dokumentRegelId(muster: string): string {
    return `beleg:regeln:${muster.trim().toLowerCase()}`;
}

/** What a person reads after „via Regel". */
export function dokumentRegelLabel(regel: Pick<DokumentRegel, 'muster'>): string {
    return `„${regel.muster.trim()}“`;
}

/** German names of the fields, for sentences. */
export const DOKUMENT_FELD_LABEL: Record<DmsRuleField, string> = {
    correspondent: 'Korrespondent',
    documentType: 'Dokumenttyp',
    category: 'Kategorie',
    direction: 'Richtung',
};

const RICHTUNG_LABEL = { incoming: 'Eingang (Ausgabe)', outgoing: 'Ausgang (Einnahme)' } as const;

/** The value a rule writes into one field, or undefined when it writes none. */
export function regelWert(regel: DokumentRegel, feld: DmsRuleField): string | undefined {
    switch (feld) {
        case 'correspondent':
            return regel.korrespondent;
        case 'documentType':
            return regel.dokumenttyp;
        case 'category':
            return regel.kategorie;
        case 'direction':
            return regel.richtung;
    }
}

/** A rule's value as a person reads it (the direction spelled out). */
export function wertText(feld: DmsRuleField, wert: string): string {
    return feld === 'direction' ? (RICHTUNG_LABEL[wert as 'incoming' | 'outgoing'] ?? wert) : wert;
}

const FELDER: readonly DmsRuleField[] = ['correspondent', 'documentType', 'category', 'direction'];

function hay(p: DokumentProbe): string {
    return [p.correspondent, p.title, p.filename, p.text].filter(Boolean).join(' ').toLowerCase();
}

/** The first rule whose pattern the receipt carries and that has not been taken off it. */
export function findeDokumentRegel(probe: DokumentProbe, regeln: readonly DokumentRegel[]): DokumentRegel | null {
    const h = hay(probe);
    for (const r of regeln) {
        const muster = r.muster.trim().toLowerCase();
        if (muster.length < MIN_DOKUMENT_MUSTER || !h.includes(muster)) continue;
        if (r.ausnahmen?.includes(probe.id)) continue;
        return r;
    }
    return null;
}

export interface DokumentRegelAnwendung {
    /** Fields to write; empty when the rule has nothing the receipt still lacks. */
    patch: Partial<Pick<DmsDocument, 'correspondent' | 'documentType' | 'category' | 'direction'>>;
    /** The origin to store, or null when nothing was set. */
    origin: DmsRuleOrigin | null;
}

/**
 * What a rule sets on a receipt: only the fields still empty. The origin lists exactly those, so a
 * field an e-invoice or a person already filled is never claimed by the rule.
 */
export function wendeDokumentRegelAn(
    ist: Pick<DmsDocument, 'correspondent' | 'documentType' | 'category' | 'direction'>,
    regel: DokumentRegel,
): DokumentRegelAnwendung {
    const patch: Record<string, string> = {};
    const fields: DmsRuleField[] = [];
    for (const feld of FELDER) {
        const wert = regelWert(regel, feld);
        if (wert == null || (ist[feld] != null && ist[feld] !== '')) continue;
        patch[feld] = wert;
        fields.push(feld);
    }
    if (fields.length === 0) return { patch: {}, origin: null };
    return {
        patch: patch as DokumentRegelAnwendung['patch'],
        origin: { id: dokumentRegelId(regel.muster), label: dokumentRegelLabel(regel), fields },
    };
}

function aufzaehlung(namen: readonly string[]): string {
    if (namen.length <= 1) return namen[0] ?? '';
    return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/** „via Regel „X“ gesetzt: Dokumenttyp und Kategorie" — the origin line of a document. */
export function herkunftSatz(origin: DmsRuleOrigin): string {
    return `via Regel ${origin.label} gesetzt: ${aufzaehlung(origin.fields.map((f) => DOKUMENT_FELD_LABEL[f]))}`;
}

/**
 * „Danach gilt: …" — what a document looks like once the rule's values are taken back. The values
 * were only ever written into EMPTY fields, so what applies afterwards is „nicht gesetzt"; the
 * sentence says so and names who fills them next.
 */
export function danachGilt(origin: DmsRuleOrigin): string {
    const namen = aufzaehlung(origin.fields.map((f) => DOKUMENT_FELD_LABEL[f]));
    const mehrere = origin.fields.length > 1;
    return `Danach gilt: ${namen} ${mehrere ? 'sind' : 'ist'} nicht gesetzt — von Hand oder durch die KI zu füllen; die Regel greift bei diesem Beleg nicht mehr.`;
}

/**
 * Which fields keep their rule origin after a hand edit: those the edit did not change. `änderung`
 * maps a field to the value now in the form (undefined = not part of the edit).
 */
export function behalteRegelFelder(
    origin: DmsRuleOrigin,
    vorher: Pick<DmsDocument, 'correspondent' | 'documentType' | 'category' | 'direction'>,
    aenderung: Partial<Record<DmsRuleField, string | null | undefined>>,
): DmsRuleOrigin | null {
    const fields = origin.fields.filter((f) => aenderung[f] === undefined || aenderung[f] === vorher[f]);
    return fields.length > 0 ? { ...origin, fields } : null;
}

/**
 * The pattern a receipt suggests for „Als Regel merken": its sender. The title is no good (it is
 * the file name until someone edits it) and a rule with no sender cannot recognise the next one.
 */
export function suggestDokumentMuster(doc: Pick<DmsDocument, 'correspondent'>): string {
    return (doc.correspondent ?? '').trim();
}

/** The rule a receipt's current fields describe — what „Als Regel merken" stores. */
export function regelAusDokument(
    doc: Pick<DmsDocument, 'correspondent' | 'documentType' | 'category' | 'direction'>,
    muster = suggestDokumentMuster(doc),
): DokumentRegel {
    const regel: DokumentRegel = { muster: muster.trim() };
    if (doc.correspondent?.trim()) regel.korrespondent = doc.correspondent.trim();
    if (doc.documentType?.trim()) regel.dokumenttyp = doc.documentType.trim();
    if (doc.category?.trim()) regel.kategorie = doc.category.trim();
    if (doc.direction) regel.richtung = doc.direction;
    return regel;
}

/** Whether a rule would set anything at all. */
export function regelHatWirkung(regel: DokumentRegel): boolean {
    return FELDER.some((f) => regelWert(regel, f) != null);
}

/** One line per rule for lists: `„Muster" → Dokumenttyp X · Kategorie Y · Eingang`. */
export function regelZeile(regel: DokumentRegel): string {
    const teile: string[] = [];
    if (regel.korrespondent) teile.push(`Korrespondent ${regel.korrespondent}`);
    if (regel.dokumenttyp) teile.push(`Dokumenttyp ${regel.dokumenttyp}`);
    if (regel.kategorie) teile.push(`Kategorie ${regel.kategorie}`);
    if (regel.richtung) teile.push(wertText('direction', regel.richtung));
    const aus = regel.ausnahmen?.length
        ? ` (${regel.ausnahmen.length} Ausnahme${regel.ausnahmen.length === 1 ? '' : 'n'})`
        : '';
    return `${dokumentRegelLabel(regel)} → ${teile.join(' · ') || '(setzt nichts)'}${aus}`;
}
