/**
 * Mahnung drafts in three stages — freundlich → bestimmt → förmlich. Pure text: nothing is sent, the
 * owner copies it into their own mail or letter and confirms „versandt" afterwards (Idee 12).
 *
 * The text states facts only: invoice number and date, due date, amounts, the earlier reminders and a
 * payment deadline. No interest, no fees and no legal threat — those need the owner's own decision
 * (Verzug: § 286 BGB, docs/references/tax-sources.md, „Offene Forderungen"). German, neutral „Sie".
 */

import { deDate } from '../lib/format.ts';
import { fmtDe } from '../lib/money.ts';
import { MAHNUNG_FRIST_TAGE, type Mahnstufe, tageZwischen } from './forderungen.ts';

export const MAHNSTUFEN: Record<1 | 2 | 3, { name: string; ton: string }> = {
    1: { name: 'Zahlungserinnerung', ton: 'freundlich' },
    2: { name: 'Mahnung', ton: 'bestimmt' },
    3: { name: 'Letzte Mahnung', ton: 'förmlich' },
};

/** „keine" · „1 · Zahlungserinnerung" … for lists. */
export function mahnstufeLabel(stufe: Mahnstufe): string {
    return stufe === 0 ? 'nicht gemahnt' : `Stufe ${stufe} · ${MAHNSTUFEN[stufe].name}`;
}

export interface MahnungEingabe {
    stufe: 1 | 2 | 3;
    nummer: string | null;
    kunde: string;
    issueDate: string | null;
    dueDate: string | null;
    /** The invoice amount and what has come in on it so far. */
    brutto: number;
    bezahlt: number;
    currency: string;
    /** The draft date YYYY-MM-DD — the deadline is {@link MAHNUNG_FRIST_TAGE} days later. */
    heute: string;
    /** Confirmed-sent dates of the earlier stages, quoted in stage 2 and 3. */
    fruehere: { stufe: 1 | 2; versandtAm: string }[];
}

export interface MahnungEntwurf {
    stufe: 1 | 2 | 3;
    betreff: string;
    text: string;
    /** YYYY-MM-DD the draft asks for payment by. */
    zahlungsfrist: string;
}

function betrag(n: number, currency: string): string {
    return `${fmtDe(n)} ${currency === 'EUR' ? '€' : currency}`;
}

function addDays(iso: string, days: number): string {
    return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The draft for one stage. Throws on an invoice that is not overdue — a reminder before the due date is no reminder. */
export function mahnungEntwurf(e: MahnungEingabe): MahnungEntwurf {
    if (!e.dueDate) throw new Error('Die Rechnung hat kein Fälligkeitsdatum — ohne das lässt sich nicht mahnen.');
    if (tageZwischen(e.dueDate, e.heute) <= 0) throw new Error('Die Rechnung ist noch nicht fällig.');
    const offen = Math.round((e.brutto - e.bezahlt) * 100) / 100;
    const frist = addDays(e.heute, MAHNUNG_FRIST_TAGE);
    const nr = e.nummer ?? 'ohne Nummer';
    const rechnung = e.issueDate ? `Rechnung Nr. ${nr} vom ${deDate(e.issueDate)}` : `Rechnung Nr. ${nr}`;
    const fakten = [
        `${rechnung}`,
        `Fällig am: ${deDate(e.dueDate)}`,
        ...(e.bezahlt > 0
            ? [
                  `Rechnungsbetrag: ${betrag(e.brutto, e.currency)}`,
                  `Bereits eingegangen: ${betrag(e.bezahlt, e.currency)}`,
                  `Offen: ${betrag(offen, e.currency)}`,
              ]
            : [`Offener Betrag: ${betrag(offen, e.currency)}`]),
    ].join('\n');
    const fruehere = (stufe: 1 | 2): string | null => {
        const f = e.fruehere.find((x) => x.stufe === stufe);
        return f ? deDate(f.versandtAm) : null;
    };
    const datum = (s: 1 | 2): string => {
        const d = fruehere(s);
        return d ? ` vom ${d}` : '';
    };

    const gruss = 'Mit freundlichen Grüßen';
    const anrede = 'Sehr geehrte Damen und Herren,';
    let betreff: string;
    let koerper: string;
    if (e.stufe === 1) {
        betreff = `Zahlungserinnerung: Rechnung ${nr}`;
        koerper =
            `bei der Durchsicht unserer Buchhaltung ist uns aufgefallen, dass die folgende Rechnung noch nicht beglichen ist:\n\n${fakten}\n\n` +
            `Möglicherweise hat sich Ihre Zahlung mit diesem Schreiben überschnitten — dann betrachten Sie es bitte als gegenstandslos. ` +
            `Andernfalls bitten wir Sie, den offenen Betrag bis zum ${deDate(frist)} zu überweisen. ` +
            `Bei Rückfragen melden Sie sich gern bei uns.`;
    } else if (e.stufe === 2) {
        betreff = `Mahnung: Rechnung ${nr}`;
        koerper =
            `zu der folgenden Rechnung haben wir trotz unserer Zahlungserinnerung${datum(1)} keinen Zahlungseingang festgestellt:\n\n${fakten}\n\n` +
            `Wir bitten Sie, den offenen Betrag bis spätestens ${deDate(frist)} zu überweisen. ` +
            `Sollte die Zahlung inzwischen erfolgt sein, bitten wir um eine kurze Nachricht.`;
    } else {
        betreff = `Letzte Mahnung: Rechnung ${nr}`;
        koerper =
            `zu der folgenden Rechnung haben wir trotz Zahlungserinnerung${datum(1)} und Mahnung${datum(2)} keinen Zahlungseingang festgestellt:\n\n${fakten}\n\n` +
            `Wir fordern Sie hiermit auf, den offenen Betrag bis spätestens ${deDate(frist)} zu überweisen. ` +
            `Geht die Zahlung bis dahin nicht ein, entscheiden wir über das weitere Vorgehen.`;
    }
    return { stufe: e.stufe, betreff, text: `${anrede}\n\n${koerper}\n\n${gruss}\n`, zahlungsfrist: frist };
}
