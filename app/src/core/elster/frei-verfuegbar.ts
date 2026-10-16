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
import { _, _n, fmt } from '../lib/i18n.ts';
import { shiftToBusinessDay, type OffeneSteuerzahlung } from './steuerzahlungen.ts';
import { ustvaDeadline } from './steuertermine.ts';
import { abstandText, erwarteteZahlungen, type LaufendeKosten } from './laufende-kosten.ts';

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
        grund = fmt(_('Newest advance return in the register: {period}, filed on {date}.'), {
            period: last.p.label,
            date: deDate(last.filedAt),
        });
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
        grund = fmt(
            _(
                'No filed advance return in the register — counted from the first period whose filing deadline is still running ({period}). Record filed advance returns under Deadlines, then the app counts from the newest one.',
            ),
            { period: ustvaPeriode(period)!.label },
        );
    } else {
        von = `${stichtag.slice(0, 4)}-01-01`;
        grund = _('No advance returns required (annual return only) — counted from the start of the year.');
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
    const erklaerung =
        t.status === 'entfaellt'
            ? fmt(_('Does not apply because {reason}'), { reason: t.grund })
            : fmt(_('Not computable because {reason}'), { reason: t.grund });
    return { key, label, op, status: t.status, betrag: 0, erklaerung, zeilen: [] };
}

function kontostandTerm(konten: KontoSaldo[]): FreiTerm {
    if (!konten.length) {
        return notComputable('kontostand', _('Account balance'), '+', {
            status: 'nicht-berechenbar',
            grund: _('no own accounts with imported transactions exist.'),
        });
    }
    const betrag = round2(konten.reduce((s, k) => s + k.saldo, 0));
    return {
        key: 'kontostand',
        label: _('Account balance'),
        op: '+',
        status: 'ok',
        betrag,
        erklaerung: fmt(
            _n(
                'Sum of the imported transactions on the one own account — as in the liquidity.',
                'Sum of the imported transactions on the {n} own accounts — as in the liquidity.',
                konten.length,
            ),
            { n: konten.length },
        ),
        zeilen: [
            ...konten.map((k) => ({
                label: k.name,
                betrag: round2(k.saldo),
                herkunft: k.letzteBuchung
                    ? fmt(_('newest transaction {date}'), { date: deDate(k.letzteBuchung) })
                    : _('no transactions'),
            })),
            {
                label: _(
                    'The balance is the sum of the imported transactions; it is only correct when they are imported without a gap since the account was opened.',
                ),
                betrag: null,
            },
        ],
    };
}

function ustTerm(ust: Teil<UstSeitVaInput>, stichtag: string): FreiTerm {
    const key = 'ust-seit-va';
    const label = _('VAT since the last advance return');
    if (ust.status !== 'ok') return notComputable(key, label, '-', ust);
    const { von, grund } = ustZeitraum(ust.daten, stichtag);
    const bis = ust.daten.businessEnd && ust.daten.businessEnd < stichtag ? ust.daten.businessEnd : stichtag;
    const zeitraum: HerleitungsZeile = {
        label: fmt(_('Period {from} to {to}'), { from: deDate(von), to: deDate(bis) }),
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
            erklaerung: _('There was no business activity after the last advance return.'),
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
            label: fmt(_n('VAT from {n} income', 'VAT from {n} incomes', nEin), { n: nEin }),
            betrag: round2(ustEin),
            herkunft: _('transactions of the EÜR in the period'),
        },
        {
            label: fmt(_n('− input VAT from {n} expense', '− input VAT from {n} expenses', nAus), { n: nAus }),
            betrag: round2(vorsteuer),
            herkunft: _('transactions of the EÜR in the period'),
        },
    ];
    if (betrag < 0)
        zeilen.push({
            label: _('Input VAT surplus: the Finanzamt will probably refund — this raises the free amount.'),
            betrag: null,
        });
    if (ust.daten.basis === 'soll') {
        zeilen.push({
            label: _(
                'Accrual taxation: the VAT arises with the invoice, not with the payment — computed from the payments here, so only an approximation.',
            ),
            betrag: null,
        });
    }
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag,
        erklaerung: _(
            'VAT collected minus input VAT paid since the last advance return — it belongs to the Finanzamt.',
        ),
        zeilen,
    };
}

function faelligText(z: OffeneSteuerzahlung): string {
    if (z.dueDate == null || z.daysUntil == null)
        return _('due date as per Bescheid, still unknown — deducted as a precaution');
    if (z.daysUntil < 0)
        return fmt(_n('overdue for {n} day ({date})', 'overdue for {n} days ({date})', -z.daysUntil), {
            n: -z.daysUntil,
            date: deDate(z.dueDate),
        });
    if (z.daysUntil === 0) return fmt(_('due today ({date})'), { date: deDate(z.dueDate) });
    return fmt(_n('due in {n} day ({date})', 'due in {n} days ({date})', z.daysUntil), {
        n: z.daysUntil,
        date: deDate(z.dueDate),
    });
}

function vorauszahlungenTerm(t: Teil<OffeneSteuerzahlung[]>): FreiTerm {
    const key = 'steuerzahlungen-faellig';
    const label = fmt(_('Tax payments due ({days} days)'), { days: FAELLIG_FENSTER_TAGE });
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
                : fmt(_('{amount} not deducted: not due before {date}'), {
                      amount: eur(z.amount),
                      date: deDate(z.dueDate!),
                  }),
        });
    }
    if (!zeilen.length) zeilen.push({ label: _('No filed, unpaid tax in the register.'), betrag: null });
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag: round2(betrag),
        erklaerung: fmt(
            _('Filed but not paid (deadline register): overdue, without a known date or due in the next {days} days.'),
            { days: FAELLIG_FENSTER_TAGE },
        ),
        zeilen,
    };
}

function eingangsrechnungenTerm(t: Teil<EingangsrechnungenInput>): FreiTerm {
    const key = 'offene-eingangsrechnungen';
    const label = _('Open incoming invoices');
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
                    ? _('not computable because no amount is recorded — not deducted')
                    : p.dueDate
                      ? fmt(_('due {date}'), { date: deDate(p.dueDate) })
                      : undefined,
        });
    }
    if (!zeilen.length) zeilen.push({ label: _('No open incoming invoice.'), betrag: null });
    zeilen.push({ label: t.daten.regel, betrag: null });
    return {
        key,
        label,
        op: '-',
        status: ohneBetrag ? 'teilweise' : 'ok',
        betrag: round2(betrag),
        erklaerung: ohneBetrag
            ? fmt(_('Gross amounts of open supplier invoices; {n} without an amount — not computable, not deducted.'), {
                  n: ohneBetrag,
              })
            : _('Gross amounts of open supplier invoices.'),
        zeilen,
    };
}

function laufendeKostenTerm(t: Teil<LaufendeKostenInput>, stichtag: string, ohne: number | null): FreiTerm {
    const key = 'laufende-kosten';
    const label = fmt(_('Recurring costs (next {days} days)'), { days: FAELLIG_FENSTER_TAGE });
    const v1: HerleitungsZeile = {
        label: _('Free to spend without recurring costs (first version)'),
        betrag: ohne,
        herkunft: _('account balance − VAT − tax payments due − open incoming invoices'),
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
                herkunft: fmt(_('ended? newest payment {date} — not deducted'), { date: deDate(lk.zuletzt) }),
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
                    ? fmt(_('expected since {date}, not debited up to the import date · {interval}'), {
                          date: deDate(z.datum),
                          interval: abstandText(z.abstand),
                      })
                    : z.nachDatenstand
                      ? fmt(_('expected {date}, after the last import · {interval}'), {
                            date: deDate(z.datum),
                            interval: abstandText(z.abstand),
                        })
                      : fmt(_('expected {date} · {interval}'), {
                            date: deDate(z.datum),
                            interval: abstandText(z.abstand),
                        }),
            });
        }
    }
    if (nachImport > 0 && datenstand) {
        zeilen.push({
            label: fmt(
                _n(
                    'Transactions imported only up to {date}: {n} expected payment after it is not in the balance and is deducted. The next import makes it more exact.',
                    'Transactions imported only up to {date}: {n} expected payments after it are not in the balance and are deducted. The next import makes it more exact.',
                    nachImport,
                ),
                { date: deDate(datenstand), n: nachImport },
            ),
            betrag: null,
        });
    }
    if (!t.daten.bestaetigt.length) {
        zeilen.push({ label: _('No confirmed recurring costs.'), betrag: null });
    }
    if (t.daten.offen > 0) {
        zeilen.push({
            label: fmt(
                _n(
                    '{n} detected series not confirmed yet — not deducted (Transactions → Recurring costs).',
                    '{n} detected series not confirmed yet — not deducted (Transactions → Recurring costs).',
                    t.daten.offen,
                ),
                { n: t.daten.offen },
            ),
            betrag: null,
        });
    }
    return {
        key,
        label,
        op: '-',
        status: 'ok',
        betrag: round2(betrag),
        erklaerung: fmt(
            _(
                'Confirmed recurring costs whose next payment is expected up to {days} days after the reference date, or was already due and is not debited yet.',
            ),
            { days: FAELLIG_FENSTER_TAGE },
        ),
        zeilen,
    };
}

function estTerm(t: Teil<EstSchaetzung>, jahr: number): FreiTerm {
    const key = 'est';
    const label = fmt(_('Income tax {year} (estimate)'), { year: jahr });
    if (t.status !== 'ok') return notComputable(key, label, '+', t);
    const { soll, einbehalten, vorauszahlungen } = t.daten;
    const betrag = round2(soll - einbehalten - vorauszahlungen);
    return {
        key,
        label,
        op: '+',
        status: 'ok',
        betrag,
        erklaerung: _(
            'The same estimate as the tax forecast: income tax, Soli and church tax minus what was withheld and prepaid.',
        ),
        zeilen: [
            {
                label: _('ESt + Soli + church tax as estimated'),
                betrag: round2(soll),
                herkunft: _('ESt calculation (Settings → Private)'),
            },
            {
                label: _('− wage tax, Soli, church tax withheld'),
                betrag: round2(einbehalten),
                herkunft: _('Lohnsteuerbescheinigung'),
            },
            {
                label: _('− ESt prepayments made'),
                betrag: round2(vorauszahlungen),
                herkunft: _('Settings → Private'),
            },
            ...(betrag < 0 ? [{ label: _('Result negative: probably a refund.'), betrag: null }] : []),
        ],
    };
}

function gewstTerm(t: Teil<GewstSchaetzung>, jahr: number): FreiTerm {
    const key = 'gewst';
    const label = fmt(_('Gewerbesteuer {year} (estimate)'), { year: jahr });
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
        erklaerung: _('The same estimate as the tax forecast, minus the Gewerbesteuer payments booked in the year.'),
        zeilen: [
            {
                label: _('Gewerbesteuer as estimated'),
                betrag: round2(gewerbesteuer),
                herkunft:
                    messbetrag === 0
                        ? fmt(_('base amount {base} × Hebesatz {rate} % (below the allowance)'), {
                              base: eur(messbetrag),
                              rate: hebesatz,
                          })
                        : fmt(_('base amount {base} × Hebesatz {rate} %'), { base: eur(messbetrag), rate: hebesatz }),
            },
            ...zahlungen.map((z) => ({
                label: `− ${z.text}`,
                betrag: round2(-z.betrag),
                herkunft: fmt(_('booked {date}'), { date: deDate(z.datum) }),
            })),
            ...(zahlungen.length
                ? []
                : [
                      {
                          label: fmt(_('No Gewerbesteuer payment {year} found on this company’s accounts.'), {
                              year: jahr,
                          }),
                          betrag: null,
                      },
                  ]),
            ...(betrag < 0 ? [{ label: _('Result negative: probably a refund.'), betrag: null }] : []),
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
            label: _('Free to spend'),
            betrag: frei[0].status === 'ok' ? combine(frei) : null,
            vollstaendig: vollstaendig(frei),
            formel: fmt(
                _(
                    'account balance − VAT since the last advance return − tax payments due − open incoming invoices − recurring costs ({days} days)',
                ),
                { days: FAELLIG_FENSTER_TAGE },
            ),
            terme: frei,
            hinweis: fmt(_('A calculation, not a recommendation. As of {date}; the tax reserve is not deducted.'), {
                date: deDate(input.stichtag),
            }),
        },
        steuerruecklage: {
            label: fmt(_('Tax reserve {year} (estimate)'), { year: jahr }),
            jahr,
            betrag: ruecklageBetrag,
            erstattung: ruecklageBetrag != null && ruecklageBetrag < 0,
            vollstaendig: vollstaendig(ruecklage),
            formel: _('estimated income tax + Gewerbesteuer − prepayments made'),
            terme: ruecklage,
            hinweis: _(
                'Only a calculation, not a booking: the same estimate as the tax forecast. Only the Steuerbescheid is binding.',
            ),
        },
    };
}
