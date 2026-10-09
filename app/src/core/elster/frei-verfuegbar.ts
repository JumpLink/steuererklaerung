/**
 * Frei verfügbar + Steuerrücklage — how much of the bank balance does NOT already belong to the
 * Finanzamt or a supplier, and how much to keep aside for the year's Einkommen- and Gewerbesteuer.
 *
 *   Frei verfügbar   = Kontostand − USt seit der letzten Voranmeldung − fällige Steuerzahlungen
 *                      − offene Eingangsrechnungen − laufende Kosten der nächsten 30 Tage
 *   Steuerrücklage   = geschätzte ESt + GewSt des Jahres − schon geleistete Vorauszahlungen
 *
 * A CALCULATION, never a recommendation: every term carries its derivation lines (label, amount,
 * where the figure comes from), and a term the data cannot support says "nicht berechenbar, weil …"
 * instead of counting as 0 € — a silent zero would overstate what is free. The Steuerrücklage
 * reuses the Steuer-Prognose's own estimate (ESt via `est-berechnung`, GewSt via `gewst`), so the
 * Übersicht never shows two different tax figures for one year; it is labelled a Schätzung.
 *
 * The laufende Kosten (Idee 8) are the second version's term: only series the owner CONFIRMED count,
 * never a mere proposal, and the term's derivation repeats the figure without them (the first version),
 * so the number did not silently change meaning.
 *
 * Pure + deterministic: the presenter (`presenters/frei-verfuegbar.ts`) loads the numbers, this
 * module only combines them. Pass `stichtag` (YYYY-MM-DD) for reproducible output.
 */

import { round2, fmtDe } from '../lib/money.ts';
import { shiftToBusinessDay, type OffeneSteuerzahlung } from './steuerzahlungen.ts';
import { ustvaDeadline } from './steuertermine.ts';
import { ABSTAND_TEXT, erwarteteZahlungen, type LaufendeKosten } from './laufende-kosten.ts';

/**
 * How far ahead a filed-but-unpaid tax payment counts as "fällig" and is deducted. NOT a legal
 * number — an app choice so a payment due next week is already treated as gone, while one due in
 * three months does not shrink today's figure. Overdue payments are always deducted.
 * Documented in docs/references/tax-sources.md, section "Frei verfügbar".
 */
export const FAELLIG_FENSTER_TAGE = 30;

/** ok = computed · teilweise = computed, but some items lack an amount · entfaellt = does not apply
 *  to this entity · nicht-berechenbar = applies, but the data to compute it is missing. */
export type TermStatus = 'ok' | 'teilweise' | 'entfaellt' | 'nicht-berechenbar';

/** One line of a term's derivation. `betrag` null = an explanatory line without an amount. */
export interface HerleitungsZeile {
    label: string;
    betrag: number | null;
    /** Where the figure comes from, or why it is (not) counted. */
    herkunft?: string;
}

export interface FreiTerm {
    key: string;
    label: string;
    /** How the term enters the result. */
    op: '+' | '-';
    status: TermStatus;
    /** The term's amount (counted only for ok/teilweise; 0 otherwise). Signed: a negative USt term is a Vorsteuer-Überhang. */
    betrag: number;
    /** One sentence: the source of the figure, or "nicht berechenbar, weil …" / "entfällt, weil …". */
    erklaerung: string;
    zeilen: HerleitungsZeile[];
}

export interface FreiErgebnis {
    label: string;
    /** The result, or null when a term it cannot do without (the Kontostand) is missing. */
    betrag: number | null;
    /** False when a term is nicht-berechenbar or teilweise — the figure is then an upper bound / partial. */
    vollstaendig: boolean;
    formel: string;
    terme: FreiTerm[];
    hinweis: string;
}

export interface Steuerruecklage extends FreiErgebnis {
    jahr: number;
    /** True when the estimate is a refund (betrag < 0) — shown as such, never clamped to 0. */
    erstattung: boolean;
}

export interface FreiVerfuegbarModel {
    stichtag: string;
    entityId: string;
    entityName: string;
    freiVerfuegbar: FreiErgebnis;
    steuerruecklage: Steuerruecklage;
}

/** A loaded input: the figures, or why there are none. */
export type Teil<T> =
    | { status: 'ok'; daten: T }
    | { status: 'entfaellt'; grund: string }
    | { status: 'nicht-berechenbar'; grund: string };

export interface KontoSaldo {
    name: string;
    accountKey: string;
    /** Σ of the account's imported transactions (the same balance the Übersicht shows). */
    saldo: number;
    letzteBuchung: string | null;
}

/** One cash booking of the EÜR aggregate (detail row), enough to sum its USt. */
export interface UstBuchung {
    bookingDate: string;
    kind: 'income' | 'expense' | 'neutral';
    /** Signed VAT contribution (a refund nets negative). */
    vat: number;
}

/** What the USt term needs to know about the entity's Voranmeldungen. */
export interface UstVaStand {
    cadence: 'quarter' | 'month' | null;
    dauerfrist: boolean;
    /** Filed USt-VA periods from the filing register ('2026-Q2' / '2026-05'). */
    eingereicht: { period: string; filedAt: string }[];
    businessStart?: string;
    businessEnd?: string;
    /** 'ist' (cash) matches the cash-based bookings exactly; 'soll' makes the figure an approximation. */
    basis?: 'ist' | 'soll';
}

export interface UstSeitVaInput extends UstVaStand {
    /** The bookings of every year the window touches, or why they could not be loaded. */
    buchungen: Teil<UstBuchung[]>;
}

export interface OffeneEingangsrechnung {
    id: string;
    label: string;
    /** Gross amount still to pay, or null when none is recorded. */
    betrag: number | null;
    dueDate: string | null;
}

export interface EingangsrechnungenInput {
    /** How "offen" was decided — shown in the derivation. */
    regel: string;
    posten: OffeneEingangsrechnung[];
}

export interface EstSchaetzung {
    /** ESt + Soli + KiSt as assessed by the estimate. */
    soll: number;
    /** Lohnsteuer, Soli and KiSt already withheld (Lohnsteuerbescheinigung). */
    einbehalten: number;
    /** ESt-Vorauszahlungen already paid (config). */
    vorauszahlungen: number;
}

export interface GewstSchaetzung {
    gewerbesteuer: number;
    messbetrag: number;
    hebesatz: number;
    /** GewSt flows booked in the year on the entity's own accounts (outflow negative, refund positive). */
    zahlungen: { datum: string; betrag: number; text: string }[];
}

export interface LaufendeKostenInput {
    /** The confirmed series (decisions applied). */
    bestaetigt: LaufendeKosten[];
    /** Proposals not decided yet — named in the derivation, never deducted. */
    offen: number;
    /** Newest booking of the entity; expected payments after it are not in the balance yet. */
    datenstand?: string | null;
}

export interface FreiVerfuegbarInput {
    stichtag: string;
    entityId: string;
    entityName: string;
    konten: KontoSaldo[];
    ust: Teil<UstSeitVaInput>;
    /** The entity's open tax payments (already filtered to it). */
    steuerzahlungen: Teil<OffeneSteuerzahlung[]>;
    eingangsrechnungen: Teil<EingangsrechnungenInput>;
    /** Absent = the caller does not know about laufende Kosten (counted as none confirmed). */
    laufendeKosten?: Teil<LaufendeKostenInput>;
    ruecklage: { jahr: number; est: Teil<EstSchaetzung>; gewst: Teil<GewstSchaetzung> };
}

const eur = (n: number): string => `${fmtDe(n)} €`;

function deDate(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

function addDays(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** First/last day + display label of a USt-VA period ('2026-Q2' / '2026-05'), or null when malformed. */
export function ustvaPeriode(
    period: string,
): { start: string; end: string; endMonth: number; year: number; label: string } | null {
    const q = period.match(/^(\d{4})-Q([1-4])$/);
    const m = period.match(/^(\d{4})-(\d{2})$/);
    let year: number;
    let startMonth: number;
    let endMonth: number;
    let label: string;
    if (q) {
        year = Number(q[1]);
        endMonth = Number(q[2]) * 3;
        startMonth = endMonth - 2;
        label = `Q${q[2]}/${q[1]}`;
    } else if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
        year = Number(m[1]);
        startMonth = endMonth = Number(m[2]);
        label = `${m[2]}/${m[1]}`;
    } else {
        return null;
    }
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    const mm = (n: number) => String(n).padStart(2, '0');
    return {
        start: `${year}-${mm(startMonth)}-01`,
        end: `${year}-${mm(endMonth)}-${mm(lastDay)}`,
        endMonth,
        year,
        label,
    };
}

/** The period label containing `iso` for a cadence. */
function periodOf(iso: string, cadence: 'quarter' | 'month'): string {
    const y = iso.slice(0, 4);
    const month = Number(iso.slice(5, 7));
    return cadence === 'quarter' ? `${y}-Q${Math.ceil(month / 3)}` : `${y}-${iso.slice(5, 7)}`;
}

/** The period right before `period`. */
function previousPeriod(period: string, cadence: 'quarter' | 'month'): string {
    const p = ustvaPeriode(period)!;
    return periodOf(addDays(p.start, -1), cadence);
}

/**
 * Where "USt seit der letzten Voranmeldung" starts, and why. Exported so the presenter loads only
 * the years the window touches.
 *   1. The register knows a filed USt-VA → the day after the newest filed period.
 *   2. Otherwise, with a known cadence → the first period whose filing deadline has not passed
 *      yet: those are the ones that are still unfinished, so their USt is still owed.
 *   3. Without a cadence (no Voranmeldungen at all) → the start of the year.
 * Never before the business started.
 */
export function ustZeitraum(stand: UstVaStand, stichtag: string): { von: string; grund: string } {
    let von: string;
    let grund: string;
    const filed = stand.eingereicht
        .map((f) => ({ ...f, p: ustvaPeriode(f.period) }))
        .filter((f): f is typeof f & { p: NonNullable<typeof f.p> } => f.p != null)
        .sort((a, b) => (a.p.end < b.p.end ? 1 : -1));
    if (filed.length) {
        const last = filed[0];
        von = addDays(last.p.end, 1);
        grund = `Letzte Voranmeldung im Register: ${last.p.label}, eingereicht am ${deDate(last.filedAt)}.`;
    } else if (stand.cadence) {
        let period = periodOf(stichtag, stand.cadence);
        for (let i = 0; i < 24; i++) {
            const prev = previousPeriod(period, stand.cadence);
            const p = ustvaPeriode(prev)!;
            const frist = shiftToBusinessDay(ustvaDeadline(p.year, p.endMonth, stand.dauerfrist));
            if (frist < stichtag) break;
            period = prev;
        }
        von = ustvaPeriode(period)!.start;
        grund =
            'Keine eingereichte Voranmeldung im Register — gerechnet ab dem ersten Zeitraum, dessen Abgabefrist noch läuft ' +
            `(${ustvaPeriode(period)!.label}). Eingereichte Voranmeldungen unter Fristen eintragen, dann rechnet die App ab der letzten.`;
    } else {
        von = `${stichtag.slice(0, 4)}-01-01`;
        grund = 'Keine Voranmeldungen vorgesehen (nur Jahreserklärung) — gerechnet ab Jahresbeginn.';
    }
    if (stand.businessStart && von < stand.businessStart) von = stand.businessStart;
    return { von, grund };
}

function notComputable(
    key: string,
    label: string,
    op: '+' | '-',
    t: { status: 'entfaellt' | 'nicht-berechenbar'; grund: string },
): FreiTerm {
    const erklaerung = t.status === 'entfaellt' ? `Entfällt, weil ${t.grund}` : `Nicht berechenbar, weil ${t.grund}`;
    return { key, label, op, status: t.status, betrag: 0, erklaerung, zeilen: [] };
}

function kontostandTerm(konten: KontoSaldo[]): FreiTerm {
    if (!konten.length) {
        return notComputable('kontostand', 'Kontostand', '+', {
            status: 'nicht-berechenbar',
            grund: 'keine eigenen Konten mit importierten Umsätzen vorliegen.',
        });
    }
    const betrag = round2(konten.reduce((s, k) => s + k.saldo, 0));
    return {
        key: 'kontostand',
        label: 'Kontostand',
        op: '+',
        status: 'ok',
        betrag,
        erklaerung: `Summe der importierten Umsätze auf ${konten.length === 1 ? 'dem eigenen Konto' : `den ${konten.length} eigenen Konten`} — wie in der Liquidität.`,
        zeilen: [
            ...konten.map((k) => ({
                label: k.name,
                betrag: round2(k.saldo),
                herkunft: k.letzteBuchung ? `letzte Buchung ${deDate(k.letzteBuchung)}` : 'keine Buchung',
            })),
            {
                label: 'Der Saldo ist die Summe der importierten Umsätze; er stimmt nur, wenn die Umsätze ab Kontoeröffnung lückenlos importiert sind.',
                betrag: null,
            },
        ],
    };
}

function ustTerm(ust: Teil<UstSeitVaInput>, stichtag: string): FreiTerm {
    const key = 'ust-seit-va';
    const label = 'USt seit der letzten Voranmeldung';
    if (ust.status !== 'ok') return notComputable(key, label, '-', ust);
    const { von, grund } = ustZeitraum(ust.daten, stichtag);
    const bis = ust.daten.businessEnd && ust.daten.businessEnd < stichtag ? ust.daten.businessEnd : stichtag;
    const zeitraum: HerleitungsZeile = {
        label: `Zeitraum ${deDate(von)} bis ${deDate(bis)}`,
        betrag: null,
        herkunft: grund,
    };
    if (ust.daten.buchungen.status !== 'ok') {
        const t = notComputable(key, label, '-', ust.daten.buchungen);
        t.zeilen.unshift(zeitraum);
        return t;
    }
    if (von > bis) {
        return {
            key,
            label,
            op: '-',
            status: 'ok',
            betrag: 0,
            erklaerung: 'Nach der letzten Voranmeldung lag keine Geschäftstätigkeit mehr.',
            zeilen: [zeitraum],
        };
    }
    let ustEin = 0;
    let vorsteuer = 0;
    let nEin = 0;
    let nAus = 0;
    for (const b of ust.daten.buchungen.daten) {
        if (b.bookingDate < von || b.bookingDate > bis) continue;
        if (b.kind === 'income' && b.vat !== 0) {
            ustEin += b.vat;
            nEin++;
        } else if (b.kind === 'expense' && b.vat !== 0) {
            vorsteuer += b.vat;
            nAus++;
        }
    }
    const betrag = round2(ustEin - vorsteuer);
    const zeilen: HerleitungsZeile[] = [
        zeitraum,
        {
            label: `Umsatzsteuer aus ${nEin} Einnahme${nEin === 1 ? '' : 'n'}`,
            betrag: round2(ustEin),
            herkunft: 'Buchungen der EÜR im Zeitraum',
        },
        {
            label: `− Vorsteuer aus ${nAus} Ausgabe${nAus === 1 ? '' : 'n'}`,
            betrag: round2(vorsteuer),
            herkunft: 'Buchungen der EÜR im Zeitraum',
        },
    ];
    if (betrag < 0)
        zeilen.push({
            label: 'Vorsteuer-Überhang: das Finanzamt erstattet voraussichtlich — erhöht den freien Betrag.',
            betrag: null,
        });
    if (ust.daten.basis === 'soll') {
        zeilen.push({
            label: 'Soll-Versteuerung: die USt entsteht mit der Rechnung, nicht mit der Zahlung — hier aus den Zahlungen gerechnet, also nur eine Näherung.',
            betrag: null,
        });
    }
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag,
        erklaerung:
            'Vereinnahmte Umsatzsteuer minus gezahlte Vorsteuer seit der letzten Voranmeldung — gehört dem Finanzamt.',
        zeilen,
    };
}

function faelligText(z: OffeneSteuerzahlung): string {
    if (z.dueDate == null || z.daysUntil == null)
        return 'Fälligkeit laut Bescheid, noch unbekannt — vorsichtshalber abgezogen';
    if (z.daysUntil < 0)
        return `überfällig seit ${-z.daysUntil} Tag${z.daysUntil === -1 ? '' : 'en'} (${deDate(z.dueDate)})`;
    if (z.daysUntil === 0) return `heute fällig (${deDate(z.dueDate)})`;
    return `fällig in ${z.daysUntil} Tag${z.daysUntil === 1 ? '' : 'en'} (${deDate(z.dueDate)})`;
}

function vorauszahlungenTerm(t: Teil<OffeneSteuerzahlung[]>): FreiTerm {
    const key = 'steuerzahlungen-faellig';
    const label = `Fällige Steuerzahlungen (${FAELLIG_FENSTER_TAGE} Tage)`;
    if (t.status !== 'ok') return notComputable(key, label, '-', t);
    const zeilen: HerleitungsZeile[] = [];
    let betrag = 0;
    for (const z of t.daten) {
        const zaehlt = z.daysUntil == null || z.daysUntil <= FAELLIG_FENSTER_TAGE;
        if (zaehlt) betrag += z.amount;
        zeilen.push({
            label: z.label,
            betrag: zaehlt ? round2(z.amount) : null,
            herkunft: zaehlt
                ? faelligText(z)
                : `${eur(z.amount)} nicht abgezogen: fällig erst am ${deDate(z.dueDate!)}`,
        });
    }
    if (!zeilen.length) zeilen.push({ label: 'Keine eingereichte, unbezahlte Steuer im Register.', betrag: null });
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag: round2(betrag),
        erklaerung: `Eingereicht, aber nicht bezahlt (Fristen-Register): überfällig, ohne bekanntes Datum oder in den nächsten ${FAELLIG_FENSTER_TAGE} Tagen fällig.`,
        zeilen,
    };
}

function eingangsrechnungenTerm(t: Teil<EingangsrechnungenInput>): FreiTerm {
    const key = 'offene-eingangsrechnungen';
    const label = 'Offene Eingangsrechnungen';
    if (t.status !== 'ok') return notComputable(key, label, '-', t);
    let betrag = 0;
    let ohneBetrag = 0;
    const zeilen: HerleitungsZeile[] = [];
    for (const p of t.daten.posten) {
        if (p.betrag == null) ohneBetrag++;
        else betrag += p.betrag;
        zeilen.push({
            label: p.label,
            betrag: p.betrag,
            herkunft:
                p.betrag == null
                    ? 'nicht berechenbar, weil kein Betrag erfasst ist — nicht abgezogen'
                    : p.dueDate
                      ? `fällig ${deDate(p.dueDate)}`
                      : undefined,
        });
    }
    if (!zeilen.length) zeilen.push({ label: 'Keine offene Eingangsrechnung.', betrag: null });
    zeilen.push({ label: t.daten.regel, betrag: null });
    return {
        key,
        label,
        op: '-',
        status: ohneBetrag ? 'teilweise' : 'ok',
        betrag: round2(betrag),
        erklaerung: ohneBetrag
            ? `Bruttobeträge offener Rechnungen von Lieferanten; ${ohneBetrag} ohne Betrag — nicht berechenbar, nicht abgezogen.`
            : 'Bruttobeträge offener Rechnungen von Lieferanten.',
        zeilen,
    };
}

function laufendeKostenTerm(t: Teil<LaufendeKostenInput>, stichtag: string, ohne: number | null): FreiTerm {
    const key = 'laufende-kosten';
    const label = `Laufende Kosten (nächste ${FAELLIG_FENSTER_TAGE} Tage)`;
    const v1: HerleitungsZeile = {
        label: 'Frei verfügbar ohne laufende Kosten (erste Fassung)',
        betrag: ohne,
        herkunft: 'Kontostand − USt − fällige Steuerzahlungen − offene Eingangsrechnungen',
    };
    if (t.status !== 'ok') {
        const n = notComputable(key, label, '-', t);
        n.zeilen.push(v1);
        return n;
    }
    const zeilen: HerleitungsZeile[] = [v1];
    const datenstand = t.daten.datenstand ?? null;
    let betrag = 0;
    let nachImport = 0;
    for (const lk of t.daten.bestaetigt) {
        if (!lk.aktiv) {
            zeilen.push({
                label: lk.empfaenger,
                betrag: null,
                herkunft: `beendet? letzte Zahlung ${deDate(lk.zuletzt)} — nicht abgezogen`,
            });
            continue;
        }
        for (const z of erwarteteZahlungen(lk, stichtag, FAELLIG_FENSTER_TAGE, datenstand)) {
            betrag += z.betrag;
            if (z.nachDatenstand) nachImport++;
            zeilen.push({
                label: z.empfaenger,
                betrag: z.betrag,
                herkunft: z.ueberfaellig
                    ? `erwartet seit ${deDate(z.datum)}, bis zum Datenstand nicht abgebucht · ${ABSTAND_TEXT[z.abstand]}`
                    : z.nachDatenstand
                      ? `erwartet ${deDate(z.datum)}, nach dem letzten Import · ${ABSTAND_TEXT[z.abstand]}`
                      : `erwartet ${deDate(z.datum)} · ${ABSTAND_TEXT[z.abstand]}`,
            });
        }
    }
    if (nachImport > 0 && datenstand) {
        zeilen.push({
            label: `Umsätze nur bis ${deDate(datenstand)} importiert: ${nachImport} erwartete Zahlung${nachImport === 1 ? '' : 'en'} danach ${nachImport === 1 ? 'ist' : 'sind'} im Kontostand nicht enthalten und abgezogen. Nach dem nächsten Import stimmt es genauer.`,
            betrag: null,
        });
    }
    if (!t.daten.bestaetigt.length) {
        zeilen.push({ label: 'Keine bestätigten laufenden Kosten.', betrag: null });
    }
    if (t.daten.offen > 0) {
        zeilen.push({
            label: `${t.daten.offen} erkannte Serie${t.daten.offen === 1 ? '' : 'n'} noch nicht bestätigt — nicht abgezogen (Buchungen → Laufende Kosten).`,
            betrag: null,
        });
    }
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag: round2(betrag),
        erklaerung: `Bestätigte laufende Kosten, deren nächste Zahlung bis ${FAELLIG_FENSTER_TAGE} Tage nach dem Stichtag erwartet wird oder schon fällig war und noch nicht abgebucht ist.`,
        zeilen,
    };
}

function estTerm(t: Teil<EstSchaetzung>, jahr: number): FreiTerm {
    const key = 'est';
    const label = `Einkommensteuer ${jahr} (Schätzung)`;
    if (t.status !== 'ok') return notComputable(key, label, '+', t);
    const { soll, einbehalten, vorauszahlungen } = t.daten;
    const betrag = round2(soll - einbehalten - vorauszahlungen);
    return {
        key,
        label,
        op: '+',
        status: 'ok',
        betrag,
        erklaerung:
            'Dieselbe Schätzung wie die Steuer-Prognose: ESt, Soli und Kirchensteuer minus Einbehaltenes und Vorauszahlungen.',
        zeilen: [
            {
                label: 'ESt + Soli + Kirchensteuer laut Schätzung',
                betrag: round2(soll),
                herkunft: 'ESt-Berechnung (Einstellungen → Privat)',
            },
            {
                label: '− Lohnsteuer, Soli, Kirchensteuer einbehalten',
                betrag: round2(einbehalten),
                herkunft: 'Lohnsteuerbescheinigung',
            },
            {
                label: '− ESt-Vorauszahlungen geleistet',
                betrag: round2(vorauszahlungen),
                herkunft: 'Einstellungen → Privat',
            },
            ...(betrag < 0 ? [{ label: 'Ergebnis negativ: voraussichtlich eine Erstattung.', betrag: null }] : []),
        ],
    };
}

function gewstTerm(t: Teil<GewstSchaetzung>, jahr: number): FreiTerm {
    const key = 'gewst';
    const label = `Gewerbesteuer ${jahr} (Schätzung)`;
    if (t.status !== 'ok') return notComputable(key, label, '+', t);
    const { gewerbesteuer, messbetrag, hebesatz, zahlungen } = t.daten;
    // Outflows are negative; a refund (positive) reduces what counts as paid.
    const gezahlt = round2(-zahlungen.reduce((s, z) => s + z.betrag, 0));
    const betrag = round2(gewerbesteuer - gezahlt);
    return {
        key,
        label,
        op: '+',
        status: 'ok',
        betrag,
        erklaerung: 'Dieselbe Schätzung wie die Steuer-Prognose, minus die im Jahr gebuchten Gewerbesteuer-Zahlungen.',
        zeilen: [
            {
                label: 'Gewerbesteuer laut Schätzung',
                betrag: round2(gewerbesteuer),
                herkunft: `Messbetrag ${eur(messbetrag)} × Hebesatz ${hebesatz} %${messbetrag === 0 ? ' (unter dem Freibetrag)' : ''}`,
            },
            ...zahlungen.map((z) => ({
                label: `− ${z.text}`,
                betrag: round2(-z.betrag),
                herkunft: `gebucht ${deDate(z.datum)}`,
            })),
            ...(zahlungen.length
                ? []
                : [
                      {
                          label: `Keine Gewerbesteuer-Zahlung ${jahr} auf den Konten dieser Firma gefunden.`,
                          betrag: null,
                      },
                  ]),
            ...(betrag < 0 ? [{ label: 'Ergebnis negativ: voraussichtlich eine Erstattung.', betrag: null }] : []),
        ],
    };
}

const counts = (t: FreiTerm) => t.status === 'ok' || t.status === 'teilweise';

function combine(terme: FreiTerm[]): number {
    return round2(terme.filter(counts).reduce((s, t) => s + (t.op === '+' ? t.betrag : -t.betrag), 0));
}

export function computeFreiVerfuegbar(input: FreiVerfuegbarInput): FreiVerfuegbarModel {
    const v1 = [
        kontostandTerm(input.konten),
        ustTerm(input.ust, input.stichtag),
        vorauszahlungenTerm(input.steuerzahlungen),
        eingangsrechnungenTerm(input.eingangsrechnungen),
    ];
    const frei = [
        ...v1,
        laufendeKostenTerm(
            input.laufendeKosten ?? { status: 'ok', daten: { bestaetigt: [], offen: 0 } },
            input.stichtag,
            v1[0].status === 'ok' ? combine(v1) : null,
        ),
    ];
    const { jahr } = input.ruecklage;
    const ruecklage = [estTerm(input.ruecklage.est, jahr), gewstTerm(input.ruecklage.gewst, jahr)];
    const vollstaendig = (terme: FreiTerm[]) => terme.every((t) => t.status === 'ok' || t.status === 'entfaellt');

    const ruecklageAnwendbar = ruecklage.some((t) => t.status !== 'entfaellt');
    const ruecklageBerechnet = ruecklage.some(counts);
    const ruecklageBetrag = ruecklageBerechnet ? combine(ruecklage) : ruecklageAnwendbar ? null : 0;

    return {
        stichtag: input.stichtag,
        entityId: input.entityId,
        entityName: input.entityName,
        freiVerfuegbar: {
            label: 'Frei verfügbar',
            betrag: frei[0].status === 'ok' ? combine(frei) : null,
            vollstaendig: vollstaendig(frei),
            formel: `Kontostand − USt seit der letzten Voranmeldung − fällige Steuerzahlungen − offene Eingangsrechnungen − laufende Kosten (${FAELLIG_FENSTER_TAGE} Tage)`,
            terme: frei,
            hinweis: `Eine Rechnung, keine Empfehlung. Stand ${deDate(input.stichtag)}; die Steuerrücklage ist nicht abgezogen.`,
        },
        steuerruecklage: {
            label: `Steuerrücklage ${jahr} (Schätzung)`,
            jahr,
            betrag: ruecklageBetrag,
            erstattung: ruecklageBetrag != null && ruecklageBetrag < 0,
            vollstaendig: vollstaendig(ruecklage),
            formel: 'geschätzte Einkommensteuer + Gewerbesteuer − geleistete Vorauszahlungen',
            terme: ruecklage,
            hinweis:
                'Nur eine Rechnung, keine Buchung: dieselbe Schätzung wie die Steuer-Prognose. Verbindlich ist allein der Steuerbescheid.',
        },
    };
}
